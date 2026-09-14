/**
 * Where things live, whether running from source or as a packaged executable.
 *
 * Running from source, data sits in the repo's data/ folder, which is what you
 * want while developing. Packaged, it must not: an executable can be installed
 * under Program Files, which is read-only for a normal user, and a product that
 * writes beside itself breaks the moment someone installs it properly. So the
 * packaged build keeps everything under %APPDATA%\<brand>, the Windows
 * convention, and the equivalent per-user directory elsewhere.
 *
 * import.meta.url cannot be used here. The packaged build is CommonJS, where it
 * is empty, and silently resolving to the wrong directory is worse than any
 * error - it looks like the user has no messages.
 */
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { BRAND } from './brand.js'

/** True when running inside a single-file executable rather than from source. */
export function isPackaged () {
  try {
    // node:sea exists from Node 22 and reports whether this is a SEA build.
    const require = createRequire(typeof __filename !== 'undefined' ? __filename : process.execPath)
    return !!require('node:sea').isSea()
  } catch {
    return false
  }
}

/** Per-user application data directory for this platform. */
function appDataRoot () {
  if (process.platform === 'win32') return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support')
  return process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
}

/**
 * Where this installation keeps its database, credentials and logs.
 *
 * Environment overrides win, so the tests can point at a throwaway directory
 * and never touch a real installation.
 */
export function dataDir () {
  if (process.env.WHATSAPP_MCP_DATA) return process.env.WHATSAPP_MCP_DATA

  if (isPackaged()) return join(appDataRoot(), BRAND.id)

  // From source: the repo's data/ folder, found relative to this file.
  // __dirname exists in the CJS bundle; from source it is derived from argv.
  const here = typeof __dirname !== 'undefined'
    ? __dirname
    : dirname(process.argv[1] || process.execPath)
  return join(here, '..', 'data')
}

/** Creates the directory if needed and returns it. */
export function ensureDataDir () {
  const d = dataDir()
  mkdirSync(d, { recursive: true })
  return d
}
