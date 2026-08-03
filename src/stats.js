/** Quick health check on the local store. node src/stats.js */
import { openDb } from './db.js'

const db = openDb({ readOnly: true })
const g = sql => db.prepare(sql).get()

const t = g(`
  SELECT (SELECT COUNT(*) FROM messages)      messages,
         (SELECT COUNT(*) FROM chats)         chats,
         (SELECT COUNT(*) FROM contacts)      contacts,
         (SELECT COUNT(*) FROM lid_map)       lid_pairs,
         (SELECT COUNT(*) FROM name_for_jid)  resolvable_names,
         (SELECT MIN(timestamp) FROM messages) oldest,
         (SELECT MAX(timestamp) FROM messages) newest
`)

const named = g(`
  SELECT COUNT(*) total,
         SUM(CASE WHEN COALESCE(NULLIF(c.name, ''), n.name) IS NOT NULL THEN 1 ELSE 0 END) named
  FROM chats c
  LEFT JOIN name_for_jid n ON n.jid = c.jid
  WHERE c.jid IN (SELECT DISTINCT chat_jid FROM messages)
`)

const d = ts => (ts ? new Date(Number(ts) * 1000).toISOString().slice(0, 10) : '-')

console.log(`messages          ${t.messages}`)
console.log(`chats             ${t.chats}`)
console.log(`contacts          ${t.contacts}`)
console.log(`lid<->pn pairs    ${t.lid_pairs}`)
console.log(`resolvable names  ${t.resolvable_names}`)
console.log(`history           ${d(t.oldest)} .. ${d(t.newest)}`)
console.log(`chats named       ${named.named}/${named.total} (${Math.round(named.named / named.total * 100)}%)`)

db.close()
