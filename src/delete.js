/**
 * Deletion, local and remote.
 *
 * Two different things wear the word "delete" here, and confusing them loses
 * data you cannot get back:
 *
 *   LOCAL  - removes rows from data/store.db only. WhatsApp still has the
 *            messages; a fresh history sync can bring them back. This is what
 *            you want for pruning your own copy.
 *   REMOTE - changes WhatsApp itself, on every device on the account and, for a
 *            revoke, on the recipient's phone too. Nothing undoes it.
 *
 * Every function here previews by default. Nothing is removed unless the caller
 * passes confirm: true, and every confirmed removal is appended to
 * data/deleted.log so there is a record of what went and when.
 */
import { appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { DB_PATH } from './db.js'

const AUDIT = join(dirname(DB_PATH), 'deleted.log')

function audit (action, detail) {
  try {
    appendFileSync(AUDIT, JSON.stringify({ at: new Date().toISOString(), action, ...detail }) + '\n')
  } catch { /* an unwritable log must not block the delete the user asked for */ }
}

/**
 * Build the WHERE clause shared by preview and delete, so the count you are
 * shown and the rows that go are guaranteed to be the same set.
 */
function messageFilter ({ chat_jid, before, after, contains, from_me }) {
  const where = []
  const args = []
  if (chat_jid) { where.push('chat_jid = ?'); args.push(chat_jid) }
  if (before) { where.push('timestamp < ?'); args.push(Math.floor(new Date(before).getTime() / 1000)) }
  if (after) { where.push('timestamp > ?'); args.push(Math.floor(new Date(after).getTime() / 1000)) }
  if (contains) { where.push('text LIKE ?'); args.push(`%${contains}%`) }
  if (typeof from_me === 'boolean') { where.push('is_from_me = ?'); args.push(from_me ? 1 : 0) }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args }
}

/**
 * Remove messages from the local store.
 *
 * Refuses an unfiltered call: "delete every message I have" should be a
 * deliberate purge, not something a forgotten argument can cause.
 */
export function deleteLocalMessages (db, opts = {}) {
  const { confirm = false, ...filter } = opts
  const { sql, args } = messageFilter(filter)
  if (!sql) {
    throw new Error('refusing to delete every message: pass a filter, or use purgeLocalDatabase for a full wipe')
  }

  const count = db.prepare(`SELECT COUNT(*) AS n FROM messages ${sql}`).get(...args).n
  const chats = db.prepare(`SELECT COUNT(DISTINCT chat_jid) AS n FROM messages ${sql}`).get(...args).n
  const sample = db.prepare(
    `SELECT chat_jid, timestamp, substr(text, 1, 80) AS text FROM messages ${sql} ORDER BY timestamp DESC LIMIT 5`
  ).all(...args)

  if (!confirm) {
    return { preview: true, would_delete: count, across_chats: chats, sample, note: 'nothing was deleted - pass confirm: true to proceed' }
  }
  if (!count) return { deleted: 0, note: 'nothing matched' }

  db.prepare(`DELETE FROM messages ${sql}`).run(...args)
  audit('delete_local_messages', { filter, deleted: count })
  return { deleted: count, across_chats: chats, scope: 'local store only - WhatsApp is unchanged' }
}

/** Remove a chat and its messages from the local store. */
export function deleteLocalChat (db, jid, confirm = false) {
  if (!jid) throw new Error('chat jid is required')
  const msgs = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_jid = ?').get(jid).n
  const chat = db.prepare('SELECT jid, name FROM chats WHERE jid = ?').get(jid)
  if (!chat && !msgs) return { deleted: 0, note: 'no such chat in the local store' }

  if (!confirm) {
    return { preview: true, chat: chat?.name || jid, would_delete_messages: msgs, note: 'nothing was deleted - pass confirm: true to proceed' }
  }
  db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(jid)
  db.prepare('DELETE FROM chats WHERE jid = ?').run(jid)
  audit('delete_local_chat', { jid, name: chat?.name ?? null, messages: msgs })
  return { deleted_chat: chat?.name || jid, deleted_messages: msgs, scope: 'local store only - WhatsApp is unchanged' }
}

/**
 * Empty the local store completely.
 *
 * Credentials live in data/auth and are untouched, so the bridge stays linked
 * and will re-sync whatever history WhatsApp still holds.
 */
export function purgeLocalDatabase (db, confirm = false) {
  const counts = {
    messages: db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,
    chats: db.prepare('SELECT COUNT(*) AS n FROM chats').get().n,
    contacts: db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n
  }
  if (!confirm) {
    return { preview: true, would_delete: counts, note: 'nothing was deleted - pass confirm: true to proceed' }
  }
  db.exec('DELETE FROM messages; DELETE FROM chats; DELETE FROM contacts;')
  audit('purge_local_database', counts)
  return { purged: counts, kept: 'data/auth - the account stays linked', scope: 'local store only - WhatsApp is unchanged' }
}

/**
 * The most recent messages in a chat, in the shape chatModify wants.
 *
 * WhatsApp needs a reference point for a clear or a delete, otherwise the
 * change cannot be applied on its side.
 */
export function lastMessagesFor (db, jid, limit = 1) {
  return db.prepare(
    'SELECT id, is_from_me, timestamp FROM messages WHERE chat_jid = ? ORDER BY timestamp DESC LIMIT ?'
  ).all(jid, limit).map(m => ({
    key: { remoteJid: jid, id: m.id, fromMe: !!m.is_from_me },
    messageTimestamp: m.timestamp
  }))
}

export { audit as auditDelete, AUDIT as DELETE_LOG }
