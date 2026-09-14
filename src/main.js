/**
 * Single entry point for the packaged product.
 *
 * The shipped executable is one file that behaves as three things depending on
 * how it is started:
 *
 *   app.exe            setup and the background bridge - what the user runs
 *   app.exe --mcp      the MCP server - what Claude starts, never the user
 *   app.exe --bridge   the bridge alone, no setup window
 *
 * One binary rather than three because the user must only ever double-click one
 * thing, and because Claude's config needs a path that already exists on disk
 * before the user has done anything.
 *
 * Mode is decided before anything heavy is imported: the MCP server must not
 * pull in Baileys, and the bridge must not pull in the MCP SDK. Both would
 * work, but each would drag megabytes and seconds into a process that has no
 * use for them.
 *
 * Wrapped in a function rather than using top-level await, because the single
 * executable format is CommonJS and CommonJS has no top-level await.
 */
import './preflight.js' // first: turns an unsupported Node into a sentence, not a trace

async function main () {
  const argv = process.argv.slice(2)
  const has = flag => argv.includes(flag)

  if (has('--mcp')) {
    // Claude launched us. stdout is the protocol channel from here on - anything
    // written to it that is not JSON-RPC corrupts the stream and Claude reports
    // the server as broken.
    return import('./mcp-server.js')
  }

  if (has('--bridge')) return import('./bridge.js')

  const { BRAND } = await import('./brand.js')

  if (has('--version')) {
    console.log(`${BRAND.name} ${BRAND.version}`)
    return
  }

  if (has('--help')) {
    console.log(`
${BRAND.name} ${BRAND.version} - ${BRAND.tagline}

  (no arguments)   set up, then run in the background
  --bridge         run the WhatsApp connection only
  --mcp            run as an MCP server (Claude starts this, you should not)
  --version
  --help
`)
    return
  }

  return import('./setup-app.js')
}

main().catch(err => {
  console.error(err?.stack || String(err))
  process.exit(1)
})
