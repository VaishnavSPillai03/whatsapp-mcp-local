/**
 * What the user sees when they double-click the executable.
 *
 * Skeleton for now - the flow is real, the steps are being filled in one at a
 * time. Order matters and is deliberate:
 *
 *   1. licence     fail here and nothing else should have happened yet
 *   2. Claude      check it exists before asking for a QR scan, so a missing
 *                  Claude is caught before the user has done any work
 *   3. link        QR, scanned once, ever
 *   4. register    write ourselves into Claude's config, start with Windows
 *   5. done        tell them exactly what to type first
 */
import { BRAND } from './brand.js'

const step = (n, text) => console.log(`  [${n}/5] ${text}`)

console.log(`\n  ${BRAND.name} ${BRAND.version}`)
console.log(`  ${BRAND.tagline}\n`)

step(1, 'licence          — not built yet')
step(2, 'find Claude      — not built yet')
step(3, 'link WhatsApp    — not built yet')
step(4, 'register         — not built yet')
step(5, 'done             — not built yet')

console.log('\n  Setup UI is under construction. For now use:')
console.log('    --bridge   run the WhatsApp connection')
console.log('    --mcp      run as an MCP server\n')
