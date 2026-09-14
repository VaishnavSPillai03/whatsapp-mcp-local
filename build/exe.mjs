/**
 * Turn the bundle into a single double-clickable executable.
 *
 *   node build/bundle.mjs && node build/exe.mjs
 *
 * Node's single-executable support works by copying the node binary and
 * injecting the bundled script into it as a resource. The result needs no Node
 * installed, no node_modules and no source files - one file the customer runs.
 *
 * On Windows the copied binary carries Microsoft's Authenticode signature,
 * which injection invalidates. Left in place, Windows reports a corrupted
 * signature, which is worse than no signature at all: SmartScreen treats it as
 * tampering. So it is stripped before injecting, and our own certificate goes
 * on afterwards.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const BUNDLE = join(DIST, 'app.cjs')

// Read the brand without importing the app, which would pull in everything.
// pathToFileURL matters on Windows: a bare C:\... is not a URL the ESM loader
// will accept.
const brandUrl = pathToFileURL(join(ROOT, 'src', 'brand.js')).href
const brand = JSON.parse(
  execFileSync(process.execPath, ['-e',
    `import(${JSON.stringify(brandUrl)}).then(m => console.log(JSON.stringify(m.BRAND)))`
  ], { encoding: 'utf8' })
)

const EXE_NAME = process.platform === 'win32' ? `${brand.id}.exe` : brand.id
const EXE = join(DIST, EXE_NAME)
const BLOB = join(DIST, 'sea.blob')
const CONFIG = join(DIST, 'sea-config.json')

if (!existsSync(BUNDLE)) {
  console.error('dist/app.cjs is missing. Run: node build/bundle.mjs')
  process.exit(1)
}

const mb = p => (statSync(p).size / 1024 / 1024).toFixed(1) + ' MB'
const step = s => console.log(`  ${s}`)

console.log(`\nbuilding ${brand.name} ${brand.version} -> dist/${EXE_NAME}\n`)

/* 1. describe what to embed ------------------------------------------------ */

writeFileSync(CONFIG, JSON.stringify({
  main: BUNDLE,
  output: BLOB,
  disableExperimentalSEAWarning: true,
  // Snapshots would start faster but cannot run code that touches the
  // filesystem at load time, which ours does.
  useSnapshot: false,
  // Caches compiled bytecode in the binary: noticeably faster startup, and
  // startup happens every time Claude launches the MCP server.
  useCodeCache: true
}, null, 2))
step('wrote sea-config.json')

/* 2. build the blob -------------------------------------------------------- */

execFileSync(process.execPath, ['--experimental-sea-config', CONFIG], { stdio: 'inherit' })
step(`built sea.blob  ${mb(BLOB)}`)

/* 3. copy the node binary -------------------------------------------------- */

rmSync(EXE, { force: true })
copyFileSync(process.execPath, EXE)
step(`copied node runtime  ${mb(EXE)}`)

/* 4. strip the Microsoft signature ---------------------------------------- */

if (process.platform === 'win32') {
  try {
    execFileSync('signtool', ['remove', '/s', EXE], { stdio: 'pipe' })
    step('removed the Microsoft signature')
  } catch {
    // signtool ships with the Windows SDK, which many machines do not have.
    // Injection still works; the stale signature is what causes trouble, and
    // signing our own over the top replaces it anyway.
    step('signtool not found - skipping signature strip (sign the output to fix)')
  }
}

/* 5. inject ---------------------------------------------------------------- */

// Its own script rather than the .bin shim: modern Node refuses to spawn a
// .cmd without shell: true, and running the script directly avoids the shell.
const postject = join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js')
execFileSync(process.execPath, [
  postject,
  EXE, 'NODE_SEA_BLOB', BLOB,
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : [])
], { stdio: 'pipe' })
step(`injected the app  ${mb(EXE)}`)

/* 6. tidy ------------------------------------------------------------------ */

rmSync(BLOB, { force: true })
rmSync(CONFIG, { force: true })

console.log(`\ndone: dist/${EXE_NAME}  ${mb(EXE)}`)
console.log(`
Next:
  dist/${EXE_NAME} --version     check it runs
  dist/${EXE_NAME}               the setup window

Before shipping, sign it. An unsigned download shows Windows SmartScreen's
"Windows protected your PC", and a customer who just paid will not click past
it - they will ask for a refund.
`)
