/**
 * Licence checking.
 *
 * Deliberately not fortress-grade. A determined person will get past any check
 * in software that runs on their own machine, and time spent making that harder
 * is time not spent making the product better. The goal is that paying is
 * easier than not paying, and that a subscription which ends actually stops.
 *
 * Three things it does have to get right, because each one breaks a paying
 * customer:
 *
 *   - a machine that is briefly offline must keep working. Hotel wifi should
 *     not brick software someone paid for, so a successful check is trusted for
 *     GRACE_DAYS afterwards.
 *   - the key is bound to a machine, so one key is not fifty installs.
 *   - a revoked key stops within a day, not instantly. Instant revocation means
 *     trusting every network blip, and that fails the first rule.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { hostname, userInfo } from 'node:os'
import { ensureDataDir } from './paths.js'
import { BRAND } from './brand.js'

/** How long a successful check is trusted for once the machine goes offline. */
const GRACE_DAYS = 7

/** How often to re-check while online. */
const RECHECK_HOURS = 24

const API = process.env.LICENCE_API || 'https://api.example.invalid/v1'

const statePath = () => join(ensureDataDir(), 'licence.json')

/**
 * A stable identifier for this machine.
 *
 * Windows has a MachineGuid in the registry that survives reinstalls of our
 * software. Elsewhere, hostname plus username is weaker but adequate - this is
 * a seat count, not an authentication boundary. Hashed either way, so we never
 * transmit anything identifying.
 */
export function machineId () {
  let raw = `${hostname()}:${userInfo().username}`
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('reg', [
        'query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-f-]+)/i)
      if (m) raw = m[1]
    } catch { /* fall back to the hostname form */ }
  }
  return createHash('sha256').update(raw).digest('hex').slice(0, 32)
}

function readState () {
  try {
    return JSON.parse(readFileSync(statePath(), 'utf8'))
  } catch {
    return null
  }
}

function writeState (state) {
  writeFileSync(statePath(), JSON.stringify(state, null, 2) + '\n')
}

/** Format check only - catches typos before we bother the server. */
export function looksLikeKey (key) {
  return typeof key === 'string' && /^[A-Z0-9]{4}(-[A-Z0-9]{4}){3,5}$/i.test(key.trim())
}

/**
 * Ask the server whether this key is valid on this machine.
 *
 * Network failure is NOT the same as an invalid key, and the two must never be
 * conflated - treating a dropped connection as "unlicensed" locks out the
 * exact customer who paid.
 */
async function verifyRemote (key) {
  const res = await fetch(`${API}/activate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: key.trim().toUpperCase(), machine: machineId(), version: BRAND.version }),
    signal: AbortSignal.timeout(15000)
  })

  if (res.status === 404 || res.status === 403) {
    const body = await res.json().catch(() => ({}))
    return { valid: false, reason: body.error || 'This key is not valid.' }
  }
  if (res.status === 409) {
    return { valid: false, reason: 'This key is already in use on the maximum number of machines.' }
  }
  if (!res.ok) throw new Error(`licence server returned ${res.status}`)

  const body = await res.json()
  return { valid: true, plan: body.plan ?? 'unknown', expires: body.expires ?? null, seats: body.seats ?? null }
}

/**
 * Store a key after checking it.
 *
 * Called when the user pastes a key during setup. Unlike the periodic check,
 * this one does require the server: we will not accept a key we have never
 * been able to confirm even once.
 */
export async function activate (key) {
  if (!looksLikeKey(key)) {
    return { ok: false, reason: 'That does not look like a licence key. It should look like ABCD-EFGH-IJKL-MNOP.' }
  }

  let result
  try {
    result = await verifyRemote(key)
  } catch (err) {
    return { ok: false, reason: `Could not reach the licence server (${err.message}). Check your internet connection and try again.` }
  }

  if (!result.valid) return { ok: false, reason: result.reason }

  writeState({
    key: key.trim().toUpperCase(),
    machine: machineId(),
    plan: result.plan,
    expires: result.expires,
    lastVerified: Date.now()
  })
  return { ok: true, plan: result.plan, expires: result.expires }
}

/**
 * Is this installation licensed right now?
 *
 * Offline, an installation that verified recently stays valid. Past the grace
 * window it stops - that is the whole mechanism, and it is why the window is
 * days rather than hours.
 */
export async function check ({ force = false } = {}) {
  const state = readState()
  if (!state?.key) return { licensed: false, reason: 'no key' }

  if (state.machine !== machineId()) {
    return { licensed: false, reason: 'This key was activated on a different machine.' }
  }

  const ageHours = (Date.now() - (state.lastVerified || 0)) / 3600000
  if (!force && ageHours < RECHECK_HOURS) {
    return { licensed: true, plan: state.plan, source: 'cached' }
  }

  try {
    const result = await verifyRemote(state.key)
    if (!result.valid) return { licensed: false, reason: result.reason }
    writeState({ ...state, plan: result.plan, expires: result.expires, lastVerified: Date.now() })
    return { licensed: true, plan: result.plan, source: 'verified' }
  } catch {
    // Offline. Trust the last good check until the grace window runs out.
    const daysSince = (Date.now() - (state.lastVerified || 0)) / 86400000
    if (daysSince <= GRACE_DAYS) {
      return {
        licensed: true,
        plan: state.plan,
        source: 'grace',
        graceDaysLeft: Math.ceil(GRACE_DAYS - daysSince)
      }
    }
    return {
      licensed: false,
      reason: `Could not reach the licence server for ${Math.floor(daysSince)} days. Connect to the internet to continue using ${BRAND.name}.`
    }
  }
}

/** Remove the stored key - used when moving to another machine. */
export function deactivate () {
  try {
    if (existsSync(statePath())) writeFileSync(statePath(), JSON.stringify({}, null, 2) + '\n')
    return true
  } catch {
    return false
  }
}

export { GRACE_DAYS, RECHECK_HOURS }
