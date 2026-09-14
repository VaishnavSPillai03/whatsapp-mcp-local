/**
 * Finding Claude, and writing ourselves into its config.
 *
 * The user should never do this by hand. Getting it wrong produces a connector
 * that silently does not appear, with no error anywhere - which reads to them
 * as "the product is broken".
 *
 * Two rules throughout:
 *   - never write over a config we cannot parse. A malformed file usually means
 *     the user hand-edited it, and destroying that is unforgivable.
 *   - always back up before writing.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { BRAND, connectorName } from './brand.js'

/** Where Claude Desktop keeps its config on this platform. */
export function desktopConfigPath () {
  const home = homedir()
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
  }
  return join(home, '.config', 'Claude', 'claude_desktop_config.json')
}

/** Claude Code's global config. */
export function claudeCodeConfigPath () {
  return join(homedir(), '.claude.json')
}

/**
 * Has Claude ever run on this machine?
 *
 * Checked before asking for a QR scan. A missing Claude found afterwards means
 * the user scanned a code for nothing, which is a bad first five minutes.
 *
 * The config file only appears once Claude has been opened at least once, so
 * the parent directory is the better signal: it exists from installation.
 */
export function findClaude () {
  const desktop = desktopConfigPath()
  const desktopDir = dirname(desktop)
  const code = claudeCodeConfigPath()

  return {
    desktop: {
      installed: existsSync(desktopDir),
      configured: existsSync(desktop),
      path: desktop
    },
    code: {
      configured: existsSync(code),
      path: code
    },
    get any () {
      return this.desktop.installed || this.code.configured
    }
  }
}

/**
 * The config entry pointing at this executable.
 *
 * Packaged, that is the executable itself with --mcp. From source it is this
 * exact node binary and the script path - "node" alone is wrong, because the
 * node on PATH may not be the one that satisfies our version floor.
 */
export function mcpEntry ({ packaged, execPath, scriptPath }) {
  return packaged
    ? { command: execPath, args: ['--mcp'] }
    : { command: execPath, args: [scriptPath] }
}

/**
 * Merge our entry into a config file.
 *
 * Returns what happened rather than throwing, so the caller can show the user
 * something useful about each location it tried.
 */
export function writeConfig (file, entry, name = connectorName()) {
  let config = {}

  if (existsSync(file)) {
    const raw = readFileSync(file, 'utf8').trim()
    if (raw) {
      try {
        config = JSON.parse(raw)
      } catch (err) {
        return { ok: false, reason: `not valid JSON (${err.message}) - left untouched` }
      }
    }
    try {
      copyFileSync(file, `${file}.backup`)
    } catch (err) {
      return { ok: false, reason: `could not back it up first (${err.message})` }
    }
  } else {
    try {
      mkdirSync(dirname(file), { recursive: true })
    } catch (err) {
      return { ok: false, reason: `could not create ${dirname(file)} (${err.message})` }
    }
  }

  config.mcpServers ??= {}
  const existed = Boolean(config.mcpServers[name])
  const unchanged = existed && JSON.stringify(config.mcpServers[name]) === JSON.stringify(entry)
  if (unchanged) return { ok: true, unchanged: true }

  config.mcpServers[name] = entry

  try {
    writeFileSync(file, JSON.stringify(config, null, 2) + '\n')
  } catch (err) {
    return { ok: false, reason: `could not write it (${err.message})` }
  }
  return { ok: true, existed }
}

/** Is our connector already registered and pointing where we expect? */
export function isRegistered (file, entry, name = connectorName()) {
  if (!existsSync(file)) return false
  try {
    const config = JSON.parse(readFileSync(file, 'utf8') || '{}')
    return JSON.stringify(config?.mcpServers?.[name]) === JSON.stringify(entry)
  } catch {
    return false
  }
}

/** The block to show someone who would rather paste it themselves. */
export function configBlock (entry, name = connectorName()) {
  return JSON.stringify({ mcpServers: { [name]: entry } }, null, 2)
}

export { BRAND }
