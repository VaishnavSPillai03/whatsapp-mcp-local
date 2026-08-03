/**
 * Loads Baileys' LID <-> phone-number mappings into the lid_map table.
 *
 * Baileys learns these pairs as it syncs and persists them through the auth key
 * store, which useMultiFileAuthState writes as one JSON file per key:
 *
 *   lid-mapping-919810007690.json          -> "82274544545899"   (phone -> lid)
 *   lid-mapping-82274544545899_reverse.json -> "919810007690"    (lid -> phone)
 *
 * Reading the files directly means no second WhatsApp connection is needed, so
 * this is safe to run while the bridge is live.
 *
 * Standalone:  node src/lid-import.js
 */
import { readdirSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { openDb, AUTH_DIR } from './db.js'

const FILE_RE = /^lid-mapping-(.+?)(_reverse)?\.json$/

export function importLidMappings (db) {
  let files
  try {
    files = readdirSync(AUTH_DIR)
  } catch {
    return { scanned: 0, imported: 0 } // not linked yet
  }

  const insert = db.prepare(`
    INSERT INTO lid_map (lid_user, pn_user) VALUES (?, ?)
    ON CONFLICT(lid_user) DO UPDATE SET pn_user = excluded.pn_user
  `)

  let scanned = 0
  const pairs = new Map()

  for (const f of files) {
    const m = FILE_RE.exec(f)
    if (!m) continue
    scanned++

    const [, key, isReverse] = m
    let value
    try {
      value = JSON.parse(readFileSync(`${AUTH_DIR}/${f}`, 'utf8'))
    } catch {
      continue
    }
    // Values are bare user parts, but tolerate a full jid just in case.
    if (typeof value !== 'string' || !value) continue
    const other = value.split('@')[0].split(':')[0]
    const self = key.split('@')[0].split(':')[0]
    if (!/^\d+$/.test(other) || !/^\d+$/.test(self)) continue

    // `_reverse` files are keyed by LID; plain files are keyed by phone number.
    if (isReverse) pairs.set(self, other)
    else pairs.set(other, self)
  }

  db.exec('BEGIN')
  try {
    for (const [lid, pn] of pairs) insert.run(lid, pn)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  return { scanned, imported: pairs.size }
}

// Run directly rather than imported by the bridge. pathToFileURL matters on
// Windows: a raw `file://` + `C:\...` never matches Node's `file:///C:/...`.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = openDb()
  const { scanned, imported } = importLidMappings(db)
  console.log(`scanned ${scanned} mapping files, stored ${imported} LID<->phone pairs`)

  const named = db.prepare('SELECT COUNT(*) c FROM name_for_jid').get().c
  console.log(`name_for_jid now resolves ${named} jids`)
  db.close()
}
