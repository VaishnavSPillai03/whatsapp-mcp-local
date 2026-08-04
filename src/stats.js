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

// SUM() over zero rows is NULL and x/0 is NaN, so an unsynced store used to print
// "null/0 (NaN%)" here - which reads like a crash on the very first run.
if (named.total > 0) {
  console.log(`chats named       ${named.named ?? 0}/${named.total} (${Math.round((named.named ?? 0) / named.total * 100)}%)`)
} else {
  console.log('chats named       -')
}

if (t.messages === 0) {
  console.log(`
Nothing stored yet. If you have not linked your account:

  node src/bridge.js

If the bridge is already running, the first history sync can take a few
minutes before messages appear.`)
}

db.close()
