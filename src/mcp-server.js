/**
 * Read-only MCP server over the local WhatsApp store.
 *
 * Opens the SQLite file in read-only mode, so nothing here can mutate your data
 * and nothing here can send a WhatsApp message. The worst a malicious message in
 * your chats can do is lie to the model — it cannot make this server act.
 */
import './preflight.js' // first: turns an unsupported Node into a sentence, not a trace
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import { openDb } from './db.js'

const db = openDb({ readOnly: true })

const server = new McpServer({ name: 'whatsapp-local', version: '1.0.0' })

const ok = data => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] })

/**
 * Chat display name. name_for_jid does the heavy lifting — it resolves LID-keyed
 * chats back to the phone contact that names them, which is most of them.
 */
const CHAT_NAME_SQL = `COALESCE(NULLIF(chats.name, ''), chat_name.name, chats.jid)`
const CHAT_NAME_JOIN = `LEFT JOIN name_for_jid chat_name ON chat_name.jid = chats.jid`

/** Sender display name for a message row aliased `m`. */
const SENDER_SQL = `COALESCE(sender_name_v.name, m.sender_name, m.sender_jid)`
const SENDER_JOIN = `LEFT JOIN name_for_jid sender_name_v ON sender_name_v.jid = m.sender_jid`

function fmtTime (ts) {
  return ts ? new Date(ts * 1000).toISOString() : null
}

server.registerTool(
  'list_chats',
  {
    title: 'List chats',
    description:
      'List WhatsApp chats ordered by most recent activity. Use this first to find the chat_jid you need for other tools.',
    inputSchema: {
      search: z.string().optional().describe('Filter by chat or contact name (case-insensitive substring)'),
      only_groups: z.boolean().optional().describe('Only return group chats'),
      limit: z.number().int().min(1).max(200).default(30)
    }
  },
  async ({ search, only_groups, limit = 30 }) => {
    const where = []
    const params = []
    if (search) {
      where.push(`LOWER(${CHAT_NAME_SQL}) LIKE ?`)
      params.push(`%${search.toLowerCase()}%`)
    }
    if (only_groups) where.push('chats.is_group = 1')

    const rows = db.prepare(`
      SELECT chats.jid,
             ${CHAT_NAME_SQL} AS name,
             chats.is_group,
             chats.last_message_time,
             (SELECT COUNT(*) FROM messages WHERE messages.chat_jid = chats.jid) AS message_count
      FROM chats
      ${CHAT_NAME_JOIN}
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY chats.last_message_time DESC NULLS LAST
      LIMIT ?
    `).all(...params, limit)

    return ok(rows.map(r => ({
      chat_jid: r.jid,
      name: r.name,
      is_group: !!r.is_group,
      message_count: r.message_count,
      last_activity: fmtTime(r.last_message_time)
    })))
  }
)

server.registerTool(
  'get_messages',
  {
    title: 'Get messages from a chat',
    description:
      'Read messages from one chat in chronological order. Returns the most recent messages unless before_time is given.',
    inputSchema: {
      chat_jid: z.string().describe('Chat JID from list_chats'),
      limit: z.number().int().min(1).max(500).default(50),
      before_time: z.string().optional().describe('ISO timestamp — only return messages older than this (for paging back)')
    }
  },
  async ({ chat_jid, limit = 50, before_time }) => {
    const params = [chat_jid]
    let clause = ''
    if (before_time) {
      const cutoff = Math.floor(new Date(before_time).getTime() / 1000)
      if (Number.isNaN(cutoff)) throw new Error(`Invalid before_time: ${before_time}`)
      clause = 'AND m.timestamp < ?'
      params.push(cutoff)
    }

    const rows = db.prepare(`
      SELECT m.timestamp, m.text, m.media_type, m.is_from_me,
             ${SENDER_SQL} AS sender
      FROM messages m
      ${SENDER_JOIN}
      WHERE m.chat_jid = ? ${clause}
      ORDER BY m.timestamp DESC
      LIMIT ?
    `).all(...params, limit)

    return ok(rows.reverse().map(r => ({
      time: fmtTime(r.timestamp),
      from: r.is_from_me ? 'me' : (r.sender || 'unknown'),
      text: r.text,
      media: r.media_type
    })))
  }
)

server.registerTool(
  'search_messages',
  {
    title: 'Search messages',
    description:
      'Full-text substring search across all stored messages. Optionally scope to one chat or a date range.',
    inputSchema: {
      query: z.string().min(1).describe('Text to search for'),
      chat_jid: z.string().optional().describe('Restrict to a single chat'),
      after: z.string().optional().describe('ISO date — only messages after this'),
      before: z.string().optional().describe('ISO date — only messages before this'),
      limit: z.number().int().min(1).max(200).default(50)
    }
  },
  async ({ query, chat_jid, after, before, limit = 50 }) => {
    const where = ['m.text IS NOT NULL', 'LOWER(m.text) LIKE ?']
    const params = [`%${query.toLowerCase()}%`]

    if (chat_jid) { where.push('m.chat_jid = ?'); params.push(chat_jid) }
    for (const [val, op] of [[after, '>'], [before, '<']]) {
      if (!val) continue
      const t = Math.floor(new Date(val).getTime() / 1000)
      if (Number.isNaN(t)) throw new Error(`Invalid date: ${val}`)
      where.push(`m.timestamp ${op} ?`)
      params.push(t)
    }

    const rows = db.prepare(`
      SELECT m.timestamp, m.text, m.chat_jid, m.is_from_me,
             ${CHAT_NAME_SQL} AS chat_name,
             ${SENDER_SQL} AS sender
      FROM messages m
      LEFT JOIN chats ON chats.jid = m.chat_jid
      ${CHAT_NAME_JOIN}
      ${SENDER_JOIN}
      WHERE ${where.join(' AND ')}
      ORDER BY m.timestamp DESC
      LIMIT ?
    `).all(...params, limit)

    return ok(rows.map(r => ({
      time: fmtTime(r.timestamp),
      chat: r.chat_name,
      chat_jid: r.chat_jid,
      from: r.is_from_me ? 'me' : (r.sender || 'unknown'),
      text: r.text
    })))
  }
)

server.registerTool(
  'get_message_context',
  {
    title: 'Get surrounding messages',
    description:
      'Given a chat and a timestamp (from search_messages), return the messages immediately before and after it.',
    inputSchema: {
      chat_jid: z.string(),
      time: z.string().describe('ISO timestamp of the anchor message'),
      before: z.number().int().min(0).max(50).default(5),
      after: z.number().int().min(0).max(50).default(5)
    }
  },
  async ({ chat_jid, time, before = 5, after = 5 }) => {
    const anchor = Math.floor(new Date(time).getTime() / 1000)
    if (Number.isNaN(anchor)) throw new Error(`Invalid time: ${time}`)

    const sql = dir => `
      SELECT m.timestamp, m.text, m.media_type, m.is_from_me,
             ${SENDER_SQL} AS sender
      FROM messages m
      ${SENDER_JOIN}
      WHERE m.chat_jid = ? AND m.timestamp ${dir === 'before' ? '<=' : '>'} ?
      ORDER BY m.timestamp ${dir === 'before' ? 'DESC' : 'ASC'}
      LIMIT ?
    `
    const prior = db.prepare(sql('before')).all(chat_jid, anchor, before + 1).reverse()
    const next = db.prepare(sql('after')).all(chat_jid, anchor, after)

    return ok([...prior, ...next].map(r => ({
      time: fmtTime(r.timestamp),
      from: r.is_from_me ? 'me' : (r.sender || 'unknown'),
      text: r.text,
      media: r.media_type
    })))
  }
)

server.registerTool(
  'list_contacts',
  {
    title: 'List contacts',
    description: 'Search your WhatsApp contact list by name.',
    inputSchema: {
      search: z.string().optional(),
      limit: z.number().int().min(1).max(200).default(50)
    }
  },
  async ({ search, limit = 50 }) => {
    // Reads the resolved view, so a LID-keyed contact still surfaces under the
    // name you saved against their phone number.
    const where = search ? 'WHERE LOWER(name) LIKE ?' : ''
    const params = search ? [`%${search.toLowerCase()}%`] : []
    const rows = db.prepare(`
      SELECT jid, name FROM name_for_jid
      ${where} ORDER BY name LIMIT ?
    `).all(...params, limit)
    return ok(rows)
  }
)

server.registerTool(
  'get_stats',
  {
    title: 'Store stats',
    description: 'How much history the local store currently holds. Use this to check the bridge is syncing.',
    inputSchema: {}
  },
  async () => {
    const s = db.prepare(`
      SELECT (SELECT COUNT(*) FROM messages) AS messages,
             (SELECT COUNT(*) FROM chats)    AS chats,
             (SELECT COUNT(*) FROM contacts) AS contacts,
             (SELECT MIN(timestamp) FROM messages) AS oldest,
             (SELECT MAX(timestamp) FROM messages) AS newest
    `).get()
    const out = {
      messages: s.messages,
      chats: s.chats,
      contacts: s.contacts,
      oldest_message: fmtTime(s.oldest),
      newest_message: fmtTime(s.newest)
    }
    // Without this an unsynced store looks identical to "you have no chats",
    // and the model reports that back as fact.
    if (s.messages === 0) {
      out.status = 'The local store is empty. The bridge (src/bridge.js) has either not been run and linked to WhatsApp yet, or is still performing its first history sync. This does not mean the user has no messages.'
    }
    return ok(out)
  }
)

await server.connect(new StdioServerTransport())
