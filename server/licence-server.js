/**
 * Licence server.
 *
 *   node server/licence-server.js            listen on 8787
 *   node server/licence-server.js --issue 5  print 5 new keys and exit
 *
 * Deliberately small. It answers one question - is this key valid on this
 * machine - and records enough to answer it again tomorrow. Keys live in a JSON
 * file; that is genuinely adequate to a few thousand customers, and swapping it
 * for a database later is a change in one place.
 *
 * What it must get right:
 *   - seats are counted per machine, not per activation, or one customer's
 *     reinstall looks like a second user
 *   - an expired subscription stops working
 *   - a revoked key stops working
 *   - it never returns 500 for a bad key, because the client treats server
 *     errors as "network trouble" and keeps working during the grace window
 */
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { verifySignature, interpret, deliverKey, verifyReturn } from './razorpay-webhook.js'

const DB = process.env.LICENCE_DB || join(process.cwd(), 'server', 'licences.json')
const PORT = Number(process.env.PORT || 8787)

const PLANS = {
  solo: { seats: 1, label: 'Solo' },
  team: { seats: 5, label: 'Team' }
}

function load () {
  if (!existsSync(DB)) return { keys: {} }
  try {
    return JSON.parse(readFileSync(DB, 'utf8'))
  } catch {
    // Never start with an empty store on a parse failure - that silently
    // invalidates every customer. Refuse to run instead.
    console.error(`${DB} is not valid JSON. Fix or move it; refusing to start.`)
    process.exit(1)
  }
}

function save (data) {
  mkdirSync(dirname(DB), { recursive: true })
  writeFileSync(DB, JSON.stringify(data, null, 2) + '\n')
}

/** Keys are typed by humans, so no characters that look like each other. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function newKey () {
  const group = () => Array.from(randomBytes(4))
    .map(b => ALPHABET[b % ALPHABET.length]).join('')
  return [group(), group(), group(), group()].join('-')
}

export function issue ({ plan = 'solo', months = 1, email = null } = {}) {
  const data = load()
  const key = newKey()
  data.keys[key] = {
    plan,
    email,
    seats: PLANS[plan]?.seats ?? 1,
    created: new Date().toISOString(),
    expires: new Date(Date.now() + months * 30 * 86400000).toISOString(),
    revoked: false,
    machines: {}
  }
  save(data)
  return key
}

/** --issue N, so you can hand out keys before any payment system exists. */
if (process.argv.includes('--issue')) {
  const n = Number(process.argv[process.argv.indexOf('--issue') + 1]) || 1
  const plan = process.argv.includes('--team') ? 'team' : 'solo'
  const months = Number(process.argv[process.argv.indexOf('--months') + 1]) || 1
  for (let i = 0; i < n; i++) console.log(issue({ plan, months }))
  process.exit(0)
}

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const readBody = req => new Promise(resolve => {
  let raw = ''
  req.on('data', c => { raw += c; if (raw.length > 4096) req.destroy() })
  req.on('end', () => { try { resolve(JSON.parse(raw)) } catch { resolve({}) } })
})

/** Raw body, needed as-is: Razorpay signs the exact bytes it sent. */
const readRaw = req => new Promise(resolve => {
  let raw = ''
  req.on('data', c => { raw += c; if (raw.length > 200_000) req.destroy() })
  req.on('end', () => resolve(raw))
})

/**
 * Find the key already issued for a subscription.
 *
 * Razorpay retries deliveries it thinks failed, so without this a customer with
 * a flaky first delivery ends up with three keys and three seats.
 */
function keyForSubscription (data, subscriptionId) {
  return Object.entries(data.keys).find(([, r]) => r.subscriptionId === subscriptionId)?.[0] || null
}

async function handleWebhook (req, res) {
  const raw = await readRaw(req)
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET

  if (!secret) {
    console.error('[webhook] RAZORPAY_WEBHOOK_SECRET is not set - refusing to process')
    return json(res, 500, { error: 'not configured' })
  }
  if (!verifySignature(raw, req.headers['x-razorpay-signature'], secret)) {
    console.error('[webhook] rejected: bad signature')
    return json(res, 401, { error: 'bad signature' })
  }

  let event
  try {
    event = JSON.parse(raw)
  } catch {
    return json(res, 400, { error: 'invalid JSON' })
  }

  const planMapping = {}
  for (const [rzpPlan, ours] of Object.entries(process.env.RAZORPAY_PLAN_MAP
    ? JSON.parse(process.env.RAZORPAY_PLAN_MAP) : {})) planMapping[rzpPlan] = ours

  const decision = interpret(event, { planMapping })
  console.log(`[webhook] ${event.event} -> ${decision.action}${decision.reason ? ` (${decision.reason})` : ''}`)

  if (decision.action === 'ignore') return json(res, 200, { ok: true, ignored: decision.reason })

  const data = load()
  const existing = decision.subscriptionId ? keyForSubscription(data, decision.subscriptionId) : null

  if (decision.action === 'issue') {
    // Already issued: a retry, or a renewal arriving as a first charge. Either
    // way the customer has their key and must not get another.
    if (existing) {
      console.log(`[webhook] already issued ${existing} for ${decision.subscriptionId}`)
      return json(res, 200, { ok: true, key: existing, duplicate: true })
    }

    const key = issue({ plan: decision.plan, months: decision.months, email: decision.email })
    const fresh = load()
    fresh.keys[key].subscriptionId = decision.subscriptionId
    save(fresh)

    const delivery = await deliverKey({
      email: decision.email,
      key,
      plan: decision.plan,
      downloadUrl: process.env.DOWNLOAD_URL || ''
    })
    console.log(`[webhook] issued ${key} for ${decision.email || 'unknown'} (emailed: ${delivery.sent})`)
    return json(res, 200, { ok: true, key, emailed: delivery.sent })
  }

  if (decision.action === 'extend') {
    if (!existing) {
      // A renewal for a subscription we have no key for. Issue one rather than
      // leaving a paying customer with nothing.
      console.warn(`[webhook] renewal for unknown subscription ${decision.subscriptionId} - issuing`)
      const key = issue({ plan: decision.plan, months: decision.months, email: decision.email })
      const fresh = load()
      fresh.keys[key].subscriptionId = decision.subscriptionId
      save(fresh)
      await deliverKey({ email: decision.email, key, plan: decision.plan, downloadUrl: process.env.DOWNLOAD_URL || '' })
      return json(res, 200, { ok: true, key, recovered: true })
    }
    const record = data.keys[existing]
    // Extend from whichever is later, so an early renewal does not shorten it.
    const from = new Date(Math.max(Date.now(), new Date(record.expires).getTime()))
    record.expires = new Date(from.getTime() + decision.months * 30 * 86400000).toISOString()
    record.revoked = false
    save(data)
    console.log(`[webhook] extended ${existing} to ${record.expires}`)
    return json(res, 200, { ok: true, key: existing, expires: record.expires })
  }

  if (decision.action === 'revoke') {
    if (!existing) return json(res, 200, { ok: true, note: 'no key for that subscription' })
    data.keys[existing].revoked = true
    data.keys[existing].revokedReason = decision.reason
    save(data)
    console.log(`[webhook] revoked ${existing} (${decision.reason})`)
    return json(res, 200, { ok: true, revoked: existing })
  }

  json(res, 200, { ok: true })
}

/**
 * The page the customer lands on straight after paying.
 *
 * Email is not a dependable delivery channel for a licence key - a cheap TLD,
 * a strict spam filter or a typo in the address and someone who has just paid
 * ₹1,999 gets nothing and asks for a refund. So the key is shown on screen
 * here, and the email becomes a backup rather than the only route.
 *
 * The signature in the URL is what makes this safe to serve. Without it the
 * URL would be a guessable way to read other people's keys.
 */
function successPage (req, res) {
  const url = new URL(req.url, 'http://localhost')
  const params = Object.fromEntries(url.searchParams)

  const page = (title, bodyHtml, status = 200, refresh = 0) => {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'x-robots-tag': 'noindex, nofollow',
      'cache-control': 'no-store'
    })
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}
<title>${title}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700;900&display=swap" rel="stylesheet">
<style>
 html,body{height:100%}
 body{margin:0;background:#0a0a0a;color:#fff;display:grid;place-items:center;padding:1.5rem;
   font-family:"Inter",system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.6}
 .box{max-width:34rem;text-align:center}
 h1{font-size:clamp(1.8rem,5vw,2.8rem);font-weight:900;letter-spacing:-.035em;margin:0 0 1rem;line-height:1.1}
 p{color:#9a9a9a;margin:0 0 1.4rem}
 .key{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:clamp(1.1rem,3.6vw,1.7rem);
   font-weight:700;letter-spacing:.06em;background:#151515;border:1px solid #2a2a2a;
   padding:1.1rem 1.2rem;border-radius:10px;word-break:break-all;margin:0 0 1rem;color:#fff}
 button,a.btn{display:inline-block;background:#fff;color:#0a0a0a;border:0;font-weight:700;font-size:1rem;
   padding:.85rem 1.9rem;border-radius:999px;cursor:pointer;text-decoration:none;font-family:inherit}
 ol{text-align:left;color:#9a9a9a;margin:2rem 0 0;padding-left:1.2rem}
 ol li{margin:.5rem 0}
 .small{font-size:.85rem;color:#6e6e6e;margin-top:2rem}
</style></head><body><div class="box">${bodyHtml}</div></body></html>`)
  }

  if (!verifyReturn(params)) {
    // Either someone is poking at the URL, or RAZORPAY_KEY_SECRET is not set
    // on this server. Both look the same from out here on purpose.
    console.warn('[success] rejected a return with a bad or unverifiable signature')
    return page('Could not verify payment', `
      <h1>We could not verify that payment</h1>
      <p>If you have just paid, your key is on its way by email. Nothing has gone
         wrong with your payment - this page just could not confirm it.</p>
      <p class="small">Still stuck? Reply to your payment receipt and a human will sort it out.</p>`, 403)
  }

  const subId = params.razorpay_subscription_id || null
  const key = subId ? keyForSubscription(load(), subId) : null

  if (!key) {
    // The webhook and the browser redirect race each other. The customer
    // usually wins by a second or two, so wait rather than claim failure.
    return page('Preparing your key', `
      <h1>One moment</h1>
      <p>Your payment went through. We are generating your licence key now -
         this page will refresh by itself.</p>
      <p class="small">If this is still here after a minute, check your email;
         the key is sent there too.</p>`, 200, 4)
  }

  const dl = process.env.DOWNLOAD_URL || ''
  page('Your licence key', `
    <h1>You're in.</h1>
    <p>This is your licence key. Copy it now - it is also in your email.</p>
    <div class="key" id="k">${String(key).replace(/[<>&"]/g, '')}</div>
    <button onclick="navigator.clipboard.writeText(document.getElementById('k').textContent.trim());this.textContent='Copied'">Copy key</button>
    ${dl ? `<p style="margin-top:1.6rem"><a class="btn" href="${dl}">Download Verge</a></p>` : ''}
    <ol>
      <li>${dl ? 'Download and run Verge' : 'Download Verge from the link in your email and run it'}</li>
      <li>Paste the key above</li>
      <li>Scan the QR code with WhatsApp on your phone</li>
      <li>Restart Claude, then ask it something about your messages</li>
    </ol>
    <p class="small">One key, one computer. Reply to your receipt if anything goes wrong.</p>`)
}

const server = createServer(async (req, res) => {
  if (req.url === '/health') return json(res, 200, { ok: true })

  // Something human at the root. People will open this in a browser - the
  // operator checking it is alive, and anyone who notices the domain - and a
  // bare "not found" reads as broken rather than as "nothing lives here".
  if (req.url === '/' || req.url === '') {
    return json(res, 200, {
      service: 'licence server',
      status: 'running',
      keys: Object.keys(load().keys).length,
      endpoints: {
        'GET /health': 'liveness check',
        'POST /v1/activate': 'the app checks a key here',
        'POST /webhook/razorpay': 'payments arrive here'
      }
    })
  }

  if (req.url === '/webhook/razorpay' && req.method === 'POST') {
    return handleWebhook(req, res)
  }

  if (req.url.startsWith('/success') && req.method === 'GET') {
    return successPage(req, res)
  }

  if (req.url !== '/v1/activate' || req.method !== 'POST') {
    return json(res, 404, { error: 'not found' })
  }

  const { key, machine, version } = await readBody(req)
  if (typeof key !== 'string' || typeof machine !== 'string') {
    return json(res, 400, { error: 'key and machine are required' })
  }

  const data = load()
  const record = data.keys[key.trim().toUpperCase()]

  // 404 rather than 500: the client must be able to tell "wrong key" from
  // "server trouble", because it keeps working through the latter.
  if (!record) return json(res, 404, { error: 'This key is not valid.' })
  if (record.revoked) return json(res, 403, { error: 'This key has been cancelled.' })

  if (record.expires && new Date(record.expires) < new Date()) {
    return json(res, 403, { error: 'This subscription has expired. Renew to continue.' })
  }

  // Seats count machines, so reinstalling on the same laptop is free.
  const known = Object.keys(record.machines)
  if (!known.includes(machine) && known.length >= record.seats) {
    return json(res, 409, { error: 'in use on the maximum number of machines' })
  }

  record.machines[machine] = {
    firstSeen: record.machines[machine]?.firstSeen || new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    version: version || null
  }
  save(data)

  json(res, 200, {
    plan: record.plan,
    seats: record.seats,
    used: Object.keys(record.machines).length,
    expires: record.expires
  })
})

/**
 * Refuse to run somewhere the key store would not survive a restart.
 *
 * Most hosts give containers an ephemeral filesystem. Losing licences.json
 * locks out every paying customer at once, and because the file IS the record
 * of who they are, there is no way to work out who to apologise to. Far better
 * to fail at boot, loudly, than to run for three weeks and then lose everything.
 *
 * Set LICENCE_ALLOW_EPHEMERAL=1 only for local testing.
 */
function checkStorage () {
  if (process.env.LICENCE_ALLOW_EPHEMERAL === '1') return

  // Only meaningful in a container; a normal machine's disk persists.
  const containerish = existsSync('/.dockerenv') || process.env.RAILWAY_ENVIRONMENT || process.env.RENDER

  /**
   * Is the directory an actual mount point, or just a folder with a
   * persistent-looking name?
   *
   * Checking the path alone was not enough, and the first deploy proved it:
   * LICENCE_DB was /data/licences.json with no volume attached, the path
   * matched, and the server started happily on to a disk that would be wiped.
   * That is worse than no check at all - it gives confidence where there is
   * none.
   *
   * A mount point has a different device id from its parent, which is what
   * actually distinguishes "volume mounted here" from "empty folder".
   */
  const isMountPoint = dir => {
    try {
      return statSync(dir).dev !== statSync(join(dir, '..')).dev
    } catch {
      return false
    }
  }

  const looksPersistent = /^\/(data|mnt|var\/data|persist)/.test(DB)

  if (containerish && looksPersistent && !isMountPoint(dirname(DB))) {
    console.error(`
REFUSING TO START

  LICENCE_DB is ${DB}

  The path looks right, but nothing is actually mounted at ${dirname(DB)} -
  it is an ordinary folder inside the container, which is wiped on every
  restart and every deploy.

  Attach a persistent volume mounted at ${dirname(DB)}.

    Railway:  railway volume add --mount-path ${dirname(DB)}
    Render:   add a Disk with that mount path

  If you are certain this is fine, set LICENCE_ALLOW_EPHEMERAL=1
`)
    process.exit(1)
  }

  if (containerish && !looksPersistent) {
    console.error(`
REFUSING TO START

  LICENCE_DB is ${DB}

  That looks like a container filesystem, which is wiped on every restart and
  every deploy. Losing this file locks out every paying customer at once, and
  the file is the only record of who they are.

  Mount a persistent volume and point LICENCE_DB at it, for example:

    LICENCE_DB=/data/licences.json

  If you are certain this is fine, set LICENCE_ALLOW_EPHEMERAL=1
`)
    process.exit(1)
  }

  // Prove we can actually write before accepting money.
  try {
    mkdirSync(dirname(DB), { recursive: true })
    const probe = join(dirname(DB), '.write-probe')
    writeFileSync(probe, 'ok')
    rmSync(probe, { force: true })
  } catch (err) {
    console.error(`REFUSING TO START: cannot write to ${dirname(DB)} (${err.message})`)
    process.exit(1)
  }
}

checkStorage()

server.listen(PORT, () => {
  console.log(`licence server on port ${PORT}`)
  console.log(`store: ${DB}`)
  const count = Object.keys(load().keys).length
  console.log(`${count} key${count === 1 ? '' : 's'} on file`)
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
    console.warn('warning: RAZORPAY_WEBHOOK_SECRET is not set - webhooks will be refused')
  }
  if (!process.env.RESEND_API_KEY) {
    console.warn('warning: no email provider configured - keys will be logged, not sent')
  }
})
