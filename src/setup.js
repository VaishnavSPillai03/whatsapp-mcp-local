#!/usr/bin/env node
/**
 * Registers this server with an MCP client.
 *
 * The awkward part of self-hosted MCP servers is that config needs an absolute
 * path, which differs per machine and can't be committed. This works it out at
 * run time and writes it for you.
 *
 *   node src/setup.js            # show what would change
 *   node src/setup.js --write    # apply it
 *   node src/setup.js --print    # just print the JSON block to paste yourself
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

import { checkNodeVersion } from './preflight.js'

checkNodeVersion()

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'))
const SERVER = join(ROOT, 'src', 'mcp-server.js')
const SERVER_NAME = 'whatsapp'

const args = process.argv.slice(2)
const write = args.includes('--write')
const printOnly = args.includes('--print')

const entry = {
  command: process.execPath, // this exact node binary, not whatever is on PATH
  args: [SERVER]
}

/** Config file locations per client, by platform. */
function targets () {
  const home = homedir()
  const out = [
    {
      name: 'Claude Code (this project)',
      path: join(process.cwd(), '.mcp.json'),
      note: 'project-scoped; applies when Claude Code runs in this directory'
    },
    {
      name: 'Claude Code (global)',
      path: join(home, '.claude.json'),
      note: 'applies everywhere'
    }
  ]

  if (process.platform === 'darwin') {
    out.push({
      name: 'Claude Desktop',
      path: join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
      note: 'restart Claude Desktop after writing'
    })
  } else if (process.platform === 'win32') {
    out.push({
      name: 'Claude Desktop',
      path: join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json'),
      note: 'restart Claude Desktop after writing'
    })
  } else {
    out.push({
      name: 'Claude Desktop',
      path: join(home, '.config', 'Claude', 'claude_desktop_config.json'),
      note: 'restart Claude Desktop after writing'
    })
  }
  return out
}

function applyTo (file) {
  let config = {}
  if (existsSync(file)) {
    const raw = readFileSync(file, 'utf8').trim()
    if (raw) {
      try {
        config = JSON.parse(raw)
      } catch (err) {
        return { ok: false, reason: `existing file is not valid JSON (${err.message}) - not touching it` }
      }
    }
    // Never clobber a user's config without a way back.
    copyFileSync(file, `${file}.backup`)
  } else {
    mkdirSync(dirname(file), { recursive: true })
  }

  config.mcpServers ??= {}
  const existed = Boolean(config.mcpServers[SERVER_NAME])
  config.mcpServers[SERVER_NAME] = entry
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n')
  return { ok: true, existed }
}

const block = { mcpServers: { [SERVER_NAME]: entry } }

if (printOnly) {
  console.log(JSON.stringify(block, null, 2))
  process.exit(0)
}

console.log(`\nwhatsapp-mcp-local setup`)
console.log(`  server: ${SERVER}`)
console.log(`  node:   ${process.execPath}\n`)

if (!write) {
  console.log('Config block for this machine:\n')
  console.log(JSON.stringify(block, null, 2))
  console.log('\nCandidate config files:\n')
  for (const t of targets()) {
    console.log(`  ${existsSync(t.path) ? '[exists]' : '[new]   '} ${t.name}`)
    console.log(`           ${t.path}`)
    console.log(`           ${t.note}\n`)
  }
  console.log('Nothing has been changed. To write the project-scoped config:\n')
  console.log('  node src/setup.js --write\n')
  console.log('Any existing file is backed up to <file>.backup first.\n')
  process.exit(0)
}

// --write targets the project-scoped config; the others are printed for the
// user to apply deliberately, since editing a global config is a bigger deal.
const target = targets()[0]
const result = applyTo(target.path)

if (!result.ok) {
  console.error(`Could not write ${target.path}: ${result.reason}`)
  process.exit(1)
}

console.log(`${result.existed ? 'Updated' : 'Added'} "${SERVER_NAME}" in ${target.path}`)
if (existsSync(`${target.path}.backup`)) console.log(`Previous version saved as ${target.path}.backup`)
console.log(`
Next:
  1. node src/bridge.js      link your WhatsApp and start syncing
  2. restart your MCP client so it picks up the new server
`)
