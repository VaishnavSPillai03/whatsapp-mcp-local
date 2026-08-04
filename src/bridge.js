/**
 * WhatsApp -> local SQLite bridge.
 *
 * Long-running. Links to your account as a device (same mechanism as WhatsApp Web)
 * and mirrors incoming + historical messages into data/store.db.
 *
 * READ ONLY BY DESIGN: this process never sends a message, never marks anything
 * read, and never presents itself as online. It only listens.
 */
import './preflight.js' // first: turns an unsupported Node into a sentence, not a trace
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  isJidGroup,
  jidNormalizedUser,
  delay
} from 'baileys'
import qrcode from 'qrcode-terminal'
import QR from 'qrcode'
import pino from 'pino'
import { rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

import { openDb, AUTH_DIR } from './db.js'
import { extractContent } from './extract.js'
import { importLidMappings } from './lid-import.js'
import { startControlServer } from './control-server.js'

const args = process.argv.slice(2)
const argValue = name => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

// Pairing-code mode. Currently unreliable — WhatsApp aborts the companion_hello
// handshake on Baileys 7.x (WhiskeySockets/Baileys#2512, #2702). QR is the working
// path; this stays available in case upstream fixes it.
const phoneNumber = (argValue('--phone') || '').replace(/\D/g, '')
const noOpen = args.includes('--no-open')

if (args.includes('--reset')) {
  rmSync(AUTH_DIR, { recursive: true, force: true })
  console.error('[bridge] cleared saved session - starting a fresh link')
}

const logger = pino({ level: process.env.LOG_LEVEL || 'silent' })
const db = openDb()
const DATA_DIR = join(AUTH_DIR, '..')
const QR_PNG = join(DATA_DIR, 'qr.png')
const LOCK = join(DATA_DIR, 'bridge.lock')

/*
 * Only one bridge at a time. Two instances share one WhatsApp session and one
 * database: they fight over the socket, and a session conflict can log the
 * device out entirely. Easy mistake to make - the bridge is meant to be left
 * running, so it is not obvious one is already up.
 */
function claimLock () {
  if (existsSync(LOCK)) {
    const pid = Number(readFileSync(LOCK, 'utf8').trim())
    let alive = false
    try {
      process.kill(pid, 0) // signal 0 tests existence without touching the process
      alive = true
    } catch {
      alive = false // stale lock from a crash or hard kill
    }
    if (alive && pid !== process.pid) {
      console.error(`[bridge] already running as PID ${pid}.`)
      console.error('[bridge] stop it first, or delete data/bridge.lock if that process is gone.')
      process.exit(1)
    }
    console.error('[bridge] clearing a stale lock from a previous run')
  }
  writeFileSync(LOCK, String(process.pid))
}

function releaseLock () {
  try {
    if (existsSync(LOCK) && Number(readFileSync(LOCK, 'utf8').trim()) === process.pid) {
      rmSync(LOCK, { force: true })
    }
  } catch {
    // Losing the lock file on exit is harmless - the PID check handles staleness.
  }
}

claimLock()

const upsertChat = db.prepare(`
  INSERT INTO chats (jid, name, is_group, last_message_time)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(jid) DO UPDATE SET
    name              = COALESCE(excluded.name, chats.name),
    last_message_time = MAX(COALESCE(excluded.last_message_time, 0),
                            COALESCE(chats.last_message_time, 0))
`)

const upsertContact = db.prepare(`
  INSERT INTO contacts (jid, name, notify)
  VALUES (?, ?, ?)
  ON CONFLICT(jid) DO UPDATE SET
    name   = COALESCE(excluded.name, contacts.name),
    notify = COALESCE(excluded.notify, contacts.notify)
`)

const upsertMessage = db.prepare(`
  INSERT INTO messages (id, chat_jid, sender_jid, sender_name, timestamp, text, media_type, is_from_me)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id, chat_jid) DO UPDATE SET
    text        = COALESCE(excluded.text, messages.text),
    media_type  = COALESCE(excluded.media_type, messages.media_type),
    sender_name = COALESCE(excluded.sender_name, messages.sender_name)
`)

let stored = 0
let lidTimer = null
let lidCount = 0
let control = null
// Replaced on every reconnect. The control server reads this through a getter so
// it always sends on the live socket rather than one captured at startup.
let currentSock = null

/** Open a file in the OS default viewer. Best-effort — never fatal. */
function openFile (path) {
  const [cmd, cmdArgs] =
    process.platform === 'darwin' ? ['open', [path]]
      : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', path]]
        : ['xdg-open', [path]]
  try {
    const child = spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' })
    child.on('error', () => {}) // no viewer configured (common on headless Linux)
    child.unref()
  } catch {
    // The path is printed above either way, so failing to open is cosmetic.
  }
}

function syncLidMappings () {
  try {
    const { imported } = importLidMappings(db)
    if (imported !== lidCount) {
      console.error(`[bridge] LID mappings: ${imported} pairs known`)
      lidCount = imported
    }
  } catch (err) {
    console.error('[bridge] LID mapping import failed:', err?.message || err)
  }
}

function saveMessage (msg) {
  const chatJid = msg.key?.remoteJid
  const id = msg.key?.id
  if (!chatJid || !id || !msg.message) return
  if (chatJid === 'status@broadcast') return // status/story spam

  const { text, mediaType, skip } = extractContent(msg.message)
  if (skip && !text && !mediaType) return

  const isFromMe = msg.key.fromMe ? 1 : 0
  const senderJid = isFromMe
    ? null
    : (msg.key.participant ? jidNormalizedUser(msg.key.participant) : jidNormalizedUser(chatJid))

  const ts = Number(msg.messageTimestamp || 0)
  if (!ts) return

  upsertMessage.run(
    id,
    chatJid,
    senderJid,
    msg.pushName || null,
    ts,
    text,
    mediaType,
    isFromMe
  )
  upsertChat.run(chatJid, null, isJidGroup(chatJid) ? 1 : 0, ts)
  stored++
}

function saveChat (chat) {
  if (!chat?.id || chat.id === 'status@broadcast') return
  const ts = chat.conversationTimestamp ? Number(chat.conversationTimestamp) : null
  upsertChat.run(chat.id, chat.name || chat.subject || null, isJidGroup(chat.id) ? 1 : 0, ts)
}

function saveContact (contact) {
  if (!contact?.id) return
  upsertContact.run(
    jidNormalizedUser(contact.id),
    contact.name || contact.verifiedName || null,
    contact.notify || null
  )
}

async function connect () {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()

  console.error(`[bridge] using WhatsApp Web version ${version.join('.')}`)

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    browser: ['WhatsApp MCP', 'Chrome', '120.0.0'],
    // Don't announce presence. Keeps phone notifications working and keeps this
    // device from looking like an active client.
    markOnlineOnConnect: false,
    syncFullHistory: true,
    generateHighQualityLinkPreview: false
  })

  currentSock = sock
  sock.ev.on('creds.update', saveCreds)

  // Pairing code replaces QR entirely: WhatsApp shows a field to type it into.
  if (phoneNumber && !sock.authState.creds.registered) {
    console.error('[bridge] WARNING: pairing-code linking is broken upstream in Baileys 7.x')
    console.error('[bridge] (WhiskeySockets/Baileys#2512, #2702). If it fails, drop --phone and use the QR.')
    await delay(4000)
    try {
      const code = await sock.requestPairingCode(phoneNumber)
      const pretty = code.match(/.{1,4}/g).join('-')
      console.error('\n' + '='.repeat(52))
      console.error(`  PAIRING CODE:   ${pretty}`)
      console.error('='.repeat(52))
      console.error('  On your phone:')
      console.error('  WhatsApp -> Settings -> Linked devices -> Link a device')
      console.error('  -> "Link with phone number instead" -> enter the code')
      console.error('  Valid for about 60 seconds.\n')
    } catch (err) {
      console.error('[bridge] could not request a pairing code:', err?.message || err)
      console.error('[bridge] check the number format: country code + number, digits only (e.g. 919812345678)')
      process.exit(1)
    }
  }

  let qrCount = 0
  sock.ev.on('connection.update', update => {
    const { connection, lastDisconnect, qr } = update

    if (qr && !phoneNumber) {
      qrCount++
      // WhatsApp rotates the code every ~20s. Old ones in the scrollback are dead —
      // scanning a stale code is what produces "check your connection and try again".
      console.error('\n' + '='.repeat(60))
      // ASCII only: the Windows console codepage mangles em dashes.
      console.error(`  QR #${qrCount} - SCAN THIS ONE. Any code above is already expired.`)
      console.error('='.repeat(60) + '\n')
      qrcode.generate(qr, { small: true })

      // The PNG is overwritten in place on every rotation, so an open image viewer
      // always shows the live code — no stale scrollback to scan by mistake.
      QR.toFile(QR_PNG, qr, { width: 512, margin: 2 })
        .then(() => {
          if (qrCount === 1 && !noOpen) {
            console.error(`\n  Opening ${QR_PNG} - it refreshes in place every ~20s.`)
            openFile(QR_PNG)
          }
        })
        .catch(() => {})
    }

    if (connection === 'open') {
      console.error('[bridge] connected. syncing history (this can take a few minutes)...')
      // Baileys writes LID<->phone pairs to the auth folder as it learns them, so
      // re-scan periodically to keep chat names resolving as new ones appear.
      syncLidMappings()
      if (!lidTimer) lidTimer = setInterval(syncLidMappings, 5 * 60 * 1000).unref()

      // One listener for the process lifetime; it resolves the live socket per
      // request, so reconnects don't strand it on a dead one.
      if (!control) control = startControlServer(() => currentSock, { dataDir: DATA_DIR })
    }

    if (connection === 'close') {
      currentSock = null // sends get a clear 503 rather than failing on a dead socket
      // Baileys surfaces Boom errors, so the status code hangs off .output.
      const status = lastDisconnect?.error?.output?.statusCode
      if (status === DisconnectReason.loggedOut) {
        console.error('[bridge] logged out on the phone. Delete data/auth and re-link to continue.')
        process.exit(1)
      }
      console.error(`[bridge] connection closed (${status}), reconnecting in 3s...`)
      setTimeout(connect, 3000)
    }
  })

  // Bulk history dump that arrives after linking.
  sock.ev.on('messaging-history.set', ({ chats, contacts, messages, progress, isLatest }) => {
    for (const c of chats || []) saveChat(c)
    for (const c of contacts || []) saveContact(c)
    for (const m of messages || []) saveMessage(m)
    const pct = progress != null ? ` ${progress}%` : ''
    console.error(`[bridge] history sync${pct}: ${stored} messages stored${isLatest ? ' (complete)' : ''}`)
  })

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return
    for (const m of messages) saveMessage(m)
  })

  sock.ev.on('chats.upsert', chats => chats.forEach(saveChat))
  sock.ev.on('chats.update', chats => chats.forEach(saveChat))
  sock.ev.on('contacts.upsert', cs => cs.forEach(saveContact))
  sock.ev.on('contacts.update', cs => cs.forEach(saveContact))
}

function shutdown (code = 0) {
  console.error(`\n[bridge] stopping. ${stored} messages stored this session.`)
  control?.close() // removes control.json so nothing tries to send through a dead bridge
  releaseLock()
  try { db.close() } catch {}
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
process.on('exit', releaseLock)

connect().catch(err => {
  console.error('[bridge] fatal:', err)
  releaseLock()
  process.exit(1)
})
