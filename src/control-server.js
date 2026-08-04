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
  minGapMs = DEFAULT_MIN_GAP_MS
}) {
  const controlPath = join(dataDir, 'control.json')
  const auditPath = join(dataDir, 'sent.log')
  const token = randomBytes(32).toString('hex')

  const recent = []
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

  const server = createServer(async (req, res) => {
    const reply = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: 'unauthorized' })
    if (req.method !== 'POST' || req.url !== '/send') return reply(404, { error: 'not found' })

    let raw = ''
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > 64_000) return reply(413, { error: 'message too large' })
    }

    let body
    try {
      body = JSON.parse(raw)
    } catch {
      return reply(400, { error: 'invalid JSON' })
    }

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
