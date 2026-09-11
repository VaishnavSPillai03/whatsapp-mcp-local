/**
 * Local control channel: lets the MCP server send messages through the bridge.
 *
 * The bridge owns the only WhatsApp socket. The MCP server is a separate,
 * short-lived process, so it cannot send directly — and must not open a second
 * connection, since two sockets on one session is what corrupts credentials.
 *
 * So the bridge listens on 127.0.0.1 with an ephemeral port and a random bearer
 * token, both written to data/control.json (gitignored). Loopback-only binding
 * keeps it off the network; the token stops other local processes from sending
 * WhatsApp messages as you just because they can reach the port.
 *
 * Four routes:
 *   POST /send   { to, text }       send one message
 *   POST /check  { numbers: [...] } ask WhatsApp which numbers have accounts
 *   POST /groups {}                 list the groups this account belongs to
 *   POST /delete { action, to, ... } revoke a message, or clear/delete a chat
 *
 * /check delivers nothing and is not written to the audit log, because nothing
 * leaves the account. It exists so bulk outreach can drop dead numbers first:
 * messaging numbers with no WhatsApp account is one of the clearer spam signals
 * you can hand the platform.
 */
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// Runaway protection. A loop that somehow reaches this endpoint should hit a wall
// long before WhatsApp's spam detection does. Overridable so tests can fire
// requests back to back.
const DEFAULT_MAX_PER_MINUTE = 20
const DEFAULT_MIN_GAP_MS = 1000

// Lookups are far cheaper than messages — nothing is delivered — but they are
// still queries against WhatsApp's servers, so they get their own ceiling
// rather than quietly spending the send budget.
const DEFAULT_MAX_CHECKS_PER_MINUTE = 40
const MAX_NUMBERS_PER_CHECK = 50

/**
 * @param getSocket - returns the CURRENT socket. Must be a getter, not a socket:
 *   Baileys replaces the socket object on every reconnect, and reconnects are
 *   routine. Holding a reference captured at startup means every send after the
 *   first disconnect fails with "Connection Closed" until the process restarts.
 */
export function startControlServer (getSocket, {
  dataDir,
  logger = console,
  maxPerMinute = DEFAULT_MAX_PER_MINUTE,
  minGapMs = DEFAULT_MIN_GAP_MS,
  maxChecksPerMinute = DEFAULT_MAX_CHECKS_PER_MINUTE
}) {
  const controlPath = join(dataDir, 'control.json')
  const auditPath = join(dataDir, 'sent.log')
  const token = randomBytes(32).toString('hex')

  const recent = []
  const recentChecks = []
  let lastSend = 0

  function rateLimit () {
    const now = Date.now()
    while (recent.length && now - recent[0] > 60_000) recent.shift()
    if (recent.length >= maxPerMinute) {
      return `rate limit: ${maxPerMinute} messages/minute reached`
    }
    if (now - lastSend < minGapMs) return 'rate limit: sending too fast, retry in a moment'
    return null
  }

  function checkRateLimit () {
    const now = Date.now()
    while (recentChecks.length && now - recentChecks[0] > 60_000) recentChecks.shift()
    if (recentChecks.length >= maxChecksPerMinute) {
      return `rate limit: ${maxChecksPerMinute} lookups/minute reached`
    }
    return null
  }

  async function readBody (req, reply) {
    let raw = ''
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > 64_000) { reply(413, { error: 'request too large' }); return null }
    }
    try {
      return JSON.parse(raw)
    } catch {
      reply(400, { error: 'invalid JSON' })
      return null
    }
  }

  async function handleSend (body, reply) {
    const { to, text } = body
    if (typeof to !== 'string' || !to.includes('@')) return reply(400, { error: 'invalid "to" (expected a chat jid)' })
    if (typeof text !== 'string' || !text.trim()) return reply(400, { error: 'empty "text"' })

    const limited = rateLimit()
    if (limited) return reply(429, { error: limited })

    const sock = getSocket()
    if (!sock) return reply(503, { error: 'bridge is not connected to WhatsApp right now - retry shortly' })

    try {
      const sent = await sock.sendMessage(to, { text })
      recent.push(Date.now())
      lastSend = Date.now()

      // Every outgoing message is recorded. If something ever sends what you did
      // not intend, this is the record of what went out and when.
      appendFileSync(auditPath, JSON.stringify({
        at: new Date().toISOString(), to, text, id: sent?.key?.id ?? null
      }) + '\n')

      logger.error(`[bridge] sent to ${to}: ${text.slice(0, 60).replace(/\s+/g, ' ')}${text.length > 60 ? '...' : ''}`)
      return reply(200, { ok: true, id: sent?.key?.id ?? null, to })
    } catch (err) {
      logger.error('[bridge] send failed:', err?.message || err)
      return reply(500, { error: String(err?.message || err) })
    }
  }

  async function handleCheck (body, reply) {
    const { numbers } = body
    if (!Array.isArray(numbers) || !numbers.length) {
      return reply(400, { error: 'expected "numbers": a non-empty array' })
    }
    if (numbers.length > MAX_NUMBERS_PER_CHECK) {
      return reply(400, { error: `too many numbers in one call (max ${MAX_NUMBERS_PER_CHECK})` })
    }

    const limited = checkRateLimit()
    if (limited) return reply(429, { error: limited })

    const sock = getSocket()
    if (!sock) return reply(503, { error: 'bridge is not connected to WhatsApp right now - retry shortly' })

    // Digits only, and drop anything too short or too long to be a real number,
    // so a stray cell in the caller's CSV cannot become a malformed query.
    const cleaned = [...new Set(numbers
      .map(n => String(n).replace(/\D/g, ''))
      .filter(n => n.length >= 8 && n.length <= 15))]
    if (!cleaned.length) return reply(400, { error: 'no usable numbers after cleaning' })

    try {
      const found = await sock.onWhatsApp(...cleaned.map(n => `${n}@s.whatsapp.net`))
      recentChecks.push(Date.now())

      // Baileys returns only what it resolved, so absence is the answer for the
      // rest. Key by the digits WhatsApp echoes back rather than what was asked:
      // it normalises some country prefixes, and the echoed form is the one that
      // will actually route a message.
      const byNumber = new Map()
      for (const r of found ?? []) {
        if (!r?.jid) continue
        byNumber.set(r.jid.split('@')[0], { exists: r.exists !== false, jid: r.jid })
      }

      const results = cleaned.map(n => {
        const hit = byNumber.get(n)
        return { number: n, exists: hit ? hit.exists : false, jid: hit?.jid ?? null }
      })
      return reply(200, { ok: true, checked: results.length, results })
    } catch (err) {
      logger.error('[bridge] lookup failed:', err?.message || err)
      return reply(500, { error: String(err?.message || err) })
    }
  }

  /**
   * The group list is not in the message store — the bridge records messages,
   * and a group you never speak in leaves no trace. Reading it from the socket
   * is the only way to answer "which groups am I actually in, and how big".
   * Read-only: nothing is sent and nothing is written.
   */
  async function handleGroups (reply, body) {
    const sock = getSocket()
    if (!sock) return reply(503, { error: 'bridge is not connected to WhatsApp right now - retry shortly' })
    try {
      const all = await sock.groupFetchAllParticipating()

      // Asked about one group: return its member list. Kept opt-in, because a
      // roster is personal data and most callers only want sizes.
      if (body?.jid) {
        const g = Object.values(all ?? {}).find(x => x.id === body.jid)
        if (!g) return reply(404, { error: 'not a group this account belongs to' })
        return reply(200, {
          ok: true,
          subject: g.subject ?? '',
          size: g.participants?.length ?? 0,
          participants: (g.participants ?? []).map(p => ({ id: p.id, admin: p.admin ?? null }))
        })
      }

      const groups = Object.values(all ?? {}).map(g => ({
        jid: g.id,
        subject: g.subject ?? '',
        size: g.participants?.length ?? 0,
        // Whether we can post matters as much as whether we are a member
        announce: !!g.announce,
        isAdmin: !!g.participants?.find(p => p.id === sock.user?.id?.split(':')[0] + '@s.whatsapp.net')?.admin
      })).sort((a, b) => b.size - a.size)
      return reply(200, { ok: true, count: groups.length, groups })
    } catch (err) {
      logger.error('[bridge] group fetch failed:', err?.message || err)
      return reply(500, { error: String(err?.message || err) })
    }
  }

  /**
   * Deletions that change WhatsApp itself, rather than the local copy.
   *
   *   revoke       - "delete for everyone". Your own messages only, and WhatsApp
   *                  stops accepting it after about two days.
   *   for_me       - removes one message from your devices; the recipient keeps it.
   *   clear_chat   - empties a chat on your account, keeping the chat.
   *   delete_chat  - removes the chat from your account entirely.
   *
   * None of these can be undone, so each is logged to data/deleted.log the same
   * way sends are logged to sent.log.
   */
  async function handleDelete (body, reply) {
    const { action, to, message_id, from_me, timestamp, last_messages } = body ?? {}
    const ACTIONS = ['revoke', 'for_me', 'clear_chat', 'delete_chat']
    if (!ACTIONS.includes(action)) {
      return reply(400, { error: `"action" must be one of: ${ACTIONS.join(', ')}` })
    }
    if (typeof to !== 'string' || !to.includes('@')) {
      return reply(400, { error: 'invalid "to" (expected a chat jid)' })
    }
    if ((action === 'revoke' || action === 'for_me') && !message_id) {
      return reply(400, { error: `"message_id" is required for ${action}` })
    }

    const sock = getSocket()
    if (!sock) return reply(503, { error: 'bridge is not connected to WhatsApp right now - retry shortly' })

    try {
      let result
      if (action === 'revoke') {
        result = await sock.sendMessage(to, {
          delete: { remoteJid: to, id: message_id, fromMe: from_me !== false }
        })
      } else if (action === 'for_me') {
        await sock.chatModify({
          deleteForMe: {
            deleteMedia: false,
            key: { remoteJid: to, id: message_id, fromMe: from_me !== false },
            timestamp: timestamp || Math.floor(Date.now() / 1000)
          }
        }, to)
      } else {
        // clear and delete both need a reference point WhatsApp can anchor to
        if (!Array.isArray(last_messages) || !last_messages.length) {
          return reply(400, { error: `"last_messages" is required for ${action} - the bridge cannot guess the chat's most recent message` })
        }
        await sock.chatModify(
          action === 'clear_chat'
            ? { clear: true, lastMessages: last_messages }
            : { delete: true, lastMessages: last_messages },
          to
        )
      }

      appendFileSync(join(dataDir, 'deleted.log'), JSON.stringify({
        at: new Date().toISOString(), action, to, message_id: message_id ?? null, scope: 'whatsapp'
      }) + '\n')

      logger.error(`[bridge] ${action} on ${to}${message_id ? ' (' + message_id + ')' : ''}`)
      return reply(200, { ok: true, action, to, id: result?.key?.id ?? message_id ?? null })
    } catch (err) {
      logger.error('[bridge] delete failed:', err?.message || err)
      return reply(500, { error: String(err?.message || err) })
    }
  }

  const server = createServer(async (req, res) => {
    const reply = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: 'unauthorized' })
    if (req.method !== 'POST') return reply(404, { error: 'not found' })
    if (!['/send', '/check', '/groups', '/delete'].includes(req.url)) return reply(404, { error: 'not found' })

    const body = await readBody(req, reply)
    if (body === null) return

    if (req.url === '/groups') return handleGroups(reply, body)

    if (req.url === '/send') return handleSend(body, reply)
    if (req.url === '/check') return handleCheck(body, reply)
    return handleDelete(body, reply)
  })

  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    writeFileSync(controlPath, JSON.stringify({ port, token, pid: process.pid }, null, 2))
    logger.error(`[bridge] send channel ready on 127.0.0.1:${port}`)
  })

  return {
    close () {
      try { rmSync(controlPath, { force: true }) } catch {}
      server.close()
    }
  }
}
