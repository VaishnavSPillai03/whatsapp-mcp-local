import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export const DB_PATH = process.env.WHATSAPP_MCP_DB || join(ROOT, 'data', 'store.db')
export const AUTH_DIR = process.env.WHATSAPP_MCP_AUTH || join(ROOT, 'data', 'auth')

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (
  jid               TEXT PRIMARY KEY,
  name              TEXT,
  is_group          INTEGER NOT NULL DEFAULT 0,
  last_message_time INTEGER
);

CREATE TABLE IF NOT EXISTS contacts (
  jid    TEXT PRIMARY KEY,
  name   TEXT,
  notify TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT    NOT NULL,
  chat_jid    TEXT    NOT NULL,
  sender_jid  TEXT,
  sender_name TEXT,
  timestamp   INTEGER NOT NULL,
  text        TEXT,
  media_type  TEXT,
  is_from_me  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (id, chat_jid)
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages (chat_jid, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_messages_time      ON messages (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_chats_last         ON chats (last_message_time DESC);

-- WhatsApp now addresses most chats by LID rather than phone number, and the two
-- namespaces are disjoint: a chat keyed 82274544545899@lid has no visible link to
-- the contact 919810007690@s.whatsapp.net that names it. Baileys learns these pairs
-- and writes them to the auth folder; lid-import.js loads them here.
CREATE TABLE IF NOT EXISTS lid_map (
  lid_user TEXT PRIMARY KEY,
  pn_user  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lid_map_pn ON lid_map (pn_user);
`

/*
 * Best display name for any user JID, looking through the LID mapping in both
 * directions. Address-book names (contacts.name) outrank WhatsApp profile names
 * (contacts.notify) whichever side of the mapping they come from — if you saved
 * someone as "Vinay Sir", that beats their self-chosen "Vinay Pasricha".
 */
const NAME_VIEW = `
CREATE VIEW IF NOT EXISTS name_for_jid AS
SELECT jid, name FROM (
  SELECT jid, name, ROW_NUMBER() OVER (PARTITION BY jid ORDER BY priority) rn
  FROM (
    -- 1. contact stored against this exact jid, address-book name
    SELECT c.jid AS jid, NULLIF(c.name, '') AS name, 1 AS priority
      FROM contacts c
    UNION ALL
    -- 2. lid jid -> phone contact, address-book name
    SELECT lm.lid_user || '@lid', NULLIF(c.name, ''), 2
      FROM lid_map lm JOIN contacts c ON c.jid = lm.pn_user || '@s.whatsapp.net'
    UNION ALL
    -- 3. phone jid -> lid contact, address-book name
    SELECT lm.pn_user || '@s.whatsapp.net', NULLIF(c.name, ''), 3
      FROM lid_map lm JOIN contacts c ON c.jid = lm.lid_user || '@lid'
    UNION ALL
    -- 4-6. same three routes, falling back to the profile name
    SELECT c.jid, NULLIF(c.notify, ''), 4 FROM contacts c
    UNION ALL
    SELECT lm.lid_user || '@lid', NULLIF(c.notify, ''), 5
      FROM lid_map lm JOIN contacts c ON c.jid = lm.pn_user || '@s.whatsapp.net'
    UNION ALL
    SELECT lm.pn_user || '@s.whatsapp.net', NULLIF(c.notify, ''), 6
      FROM lid_map lm JOIN contacts c ON c.jid = lm.lid_user || '@lid'
  ) WHERE name IS NOT NULL
) WHERE rn = 1
`

/**
 * Create the db file and schema if they aren't there yet. Safe to call repeatedly —
 * the MCP server calls it before opening read-only, since sqlite can't open a
 * missing file in read-only mode.
 */
export function ensureSchema () {
  mkdirSync(dirname(DB_PATH), { recursive: true })
  const db = new DatabaseSync(DB_PATH)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(SCHEMA)
  // Dropped and recreated so the definition tracks this file rather than whatever
  // an older run happened to create.
  db.exec('DROP VIEW IF EXISTS name_for_jid')
  db.exec(NAME_VIEW)
  db.close()
}

export function openDb ({ readOnly = false } = {}) {
  ensureSchema()
  const db = new DatabaseSync(DB_PATH, { readOnly })
  // WAL lets the MCP server read while the bridge is mid-write.
  if (!readOnly) db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}
