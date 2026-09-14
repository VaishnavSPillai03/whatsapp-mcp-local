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
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { verifySignature, interpret, deliverKey } from './razorpay-webhook.js'

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

const server = createServer(async (req, res) => {
  if (req.url === '/health') return json(res, 200, { ok: true })

  if (req.url === '/webhook/razorpay' && req.method === 'POST') {
    return handleWebhook(req, res)
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

server.listen(PORT, () => {
  console.log(`licence server on http://127.0.0.1:${PORT}`)
  console.log(`store: ${DB}`)
})
