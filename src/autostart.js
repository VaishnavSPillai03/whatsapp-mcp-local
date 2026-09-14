/**
 * Starting with the machine.
 *
 * Without this the product quietly dies at the first reboot and the user
 * concludes it stopped working. They will not think to restart anything,
 * because nothing told them there was something to restart.
 *
 * Windows uses the per-user Run key rather than a service or a scheduled task:
 * no administrator rights needed, it is what the user would find if they went
 * looking in Task Manager's Startup tab, and they can turn it off there without
 * needing us.
 */
import { execFileSync } from 'node:child_process'
import { BRAND } from './brand.js'

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'

/** The name our entry appears under, in Task Manager and the registry. */
const entryName = () => BRAND.name

function reg (args) {
  return execFileSync('reg', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** What the Run key currently holds for us, or null. */
export function current () {
  if (process.platform !== 'win32') return null
  try {
    const out = reg(['query', RUN_KEY, '/v', entryName()])
    const m = out.match(/REG_SZ\s+(.+)/)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

/**
 * Register to start at login.
 *
 * The command runs the bridge alone, not the setup window - the user does not
 * want a window appearing every time they log in, they want their messages to
 * already be there.
 */
export function enable (execPath) {
  if (process.platform !== 'win32') {
    return { ok: false, reason: 'Automatic startup is only set up on Windows so far.' }
  }

  // Quoted because Program Files has a space in it, and an unquoted path there
  // silently runs the wrong thing.
  const command = `"${execPath}" --bridge`
  if (current() === command) return { ok: true, unchanged: true }

  try {
    reg(['add', RUN_KEY, '/v', entryName(), '/t', 'REG_SZ', '/d', command, '/f'])
    return { ok: true, command }
  } catch (err) {
    return { ok: false, reason: err.message }
  }
}

export function disable () {
  if (process.platform !== 'win32') return { ok: true, unchanged: true }
  if (!current()) return { ok: true, unchanged: true }
  try {
    reg(['delete', RUN_KEY, '/v', entryName(), '/f'])
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err.message }
  }
}

export function isEnabled () {
  return current() !== null
}
