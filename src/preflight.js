/**
 * Environment checks. Import this FIRST in any entry point.
 *
 * The checks run at module-evaluation time rather than from an exported function
 * on purpose: ES modules evaluate every static import before the importing file's
 * body, so a check called from main() would run *after* db.js had already tried
 * to load node:sqlite and crashed with an unhelpful trace.
 *
 * node:sqlite is what keeps this project free of native build steps, and it only
 * exists on Node 22.5+.
 */
// node:sqlite landed in 22.5.0 but sat behind --experimental-sqlite until 22.13.0
// (and 23.4.0 on that line). 22.13 is the first version that runs it unflagged,
// so that is the real floor — not 22.5.
const MIN_MAJOR = 22
const MIN_MINOR = 13

export function checkNodeVersion () {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major > MIN_MAJOR || (major === MIN_MAJOR && minor >= MIN_MINOR)) return

  console.error(`
whatsapp-mcp-local needs Node ${MIN_MAJOR}.${MIN_MINOR} or newer.
You are running Node ${process.versions.node}.

It uses Node's built-in SQLite (node:sqlite), which is what keeps this project
free of native build steps. Upgrading Node is the only requirement.

  https://nodejs.org/en/download
`)
  process.exit(1)
}

checkNodeVersion()

// Some distribution builds of Node omit node:sqlite even at a new enough version.
// Checked synchronously via getBuiltinModule rather than with a top-level await:
// the packaged build is CommonJS, which has no top-level await, and this file
// must behave identically either way. Being synchronous also means importers
// cannot reach db.js before the check has run.
try {
  if (!process.getBuiltinModule?.('node:sqlite')) throw new Error('node:sqlite unavailable')
} catch {
  console.error(`
Node ${process.versions.node} does not expose node:sqlite.

This is usually a distribution build compiled without it. Install an official
build from nodejs.org, or if your version supports the flag:

  node --experimental-sqlite src/bridge.js
`)
  process.exit(1)
}
