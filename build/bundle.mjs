/**
 * Bundle the whole app into one file, ready to become a single executable.
 *
 *   node build/bundle.mjs
 *
 * The optional peers below are deliberately left out. Baileys loads each with
 * `import('x').catch(() => {})`, so a missing one is a no-op rather than a
 * crash, and every one of them exists only for media features this product
 * never touches. sharp matters most: it is the only native binary in the tree,
 * and native binaries are what stop a single-file build working at all.
 * Dropping it takes roughly 20MB with it.
 */
import { build } from 'esbuild'
import { rmSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'dist')

const OPTIONAL_PEERS = ['sharp', 'jimp', 'audio-decode', 'link-preview-js']

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const started = Date.now()

const result = await build({
  entryPoints: [join(ROOT, 'src', 'main.js')],
  outfile: join(OUT, 'app.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  // Single executables run CommonJS; ESM inside a SEA blob is not supported.
  format: 'cjs',
  external: OPTIONAL_PEERS,
  minify: false,        // keep readable while we are still debugging the build
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
  metafile: true,
  banner: {
    // Some dependencies reach for these; in a CJS bundle they are absent.
    js: `globalThis.__filename ??= process.execPath; globalThis.__dirname ??= require('node:path').dirname(process.execPath);`
  }
})

const bytes = statSync(join(OUT, 'app.cjs')).size
console.log(`\nbundled in ${Date.now() - started}ms`)
console.log(`output: dist/app.cjs  ${(bytes / 1024 / 1024).toFixed(1)} MB`)

// Biggest contributors, so a sudden jump in size has an obvious cause
const inputs = Object.entries(result.metafile.outputs)[0][1].inputs
const top = Object.entries(inputs)
  .sort((a, b) => b[1].bytesInOutput - a[1].bytesInOutput)
  .slice(0, 8)
console.log('\nlargest inputs:')
for (const [file, info] of top) {
  console.log(`  ${(info.bytesInOutput / 1024).toFixed(0).padStart(6)} KB  ${file}`)
}
