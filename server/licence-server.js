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

const server = createServer(async (req, res) => {
  if (req.url === '/health') return json(res, 200, { ok: true })

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
