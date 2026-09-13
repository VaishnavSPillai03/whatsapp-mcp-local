/**
 * Test suite. Runs against a throwaway database in the OS temp directory —
 * it never reads or writes your real store.
 *
 *   node test/run.js
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TMP = mkdtempSync(join(tmpdir(), 'wa-mcp-test-'))
const DB = join(TMP, 'store.db')
const AUTH = join(TMP, 'auth')

process.env.WHATSAPP_MCP_DB = DB
process.env.WHATSAPP_MCP_AUTH = AUTH

let passed = 0
const failures = []
function check (name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (err) {
    failures.push(name)
    console.log(`  FAIL ${name}\n       ${err.message}`)
  }
}

// ------------------------------------------------- first-run (empty store)

// Everything here runs against a store that has never been synced, which is what
// a new user sees before linking. It must not look like a crash.
console.log('\nfirst run, nothing synced yet')

const emptyDir = join(TMP, 'empty')
const emptyEnv = {
  ...process.env,
  WHATSAPP_MCP_DB: join(emptyDir, 'store.db'),
  WHATSAPP_MCP_AUTH: join(emptyDir, 'auth')
}
const runScript = script => {
  const r = spawnSync(process.execPath, [join(ROOT, 'src', script)], {
    env: emptyEnv, encoding: 'utf8'
  })
  return `${r.stdout}${r.stderr}`
}

const statsOut = runScript('stats.js')
check('stats.js prints no NaN on an empty store', () => {
  assert.ok(!/NaN/.test(statsOut), `got: ${statsOut}`)
})
check('stats.js prints no raw null on an empty store', () => {
  assert.ok(!/\bnull\b/.test(statsOut), `got: ${statsOut}`)
})
check('stats.js explains what to do next', () => {
  assert.match(statsOut, /bridge\.js/)
})

const lidOut = runScript('lid-import.js')
check('lid-import survives a missing auth folder', () => {
  assert.match(lidOut, /scanned 0 mapping files/)
})

// ---------------------------------------------------------------- fixtures

const { openDb } = await import('../src/db.js')
const { importLidMappings } = await import('../src/lid-import.js')

// Mapping files exactly as Baileys' multi-file auth state writes them.
mkdirSync(AUTH, { recursive: true })
writeFileSync(join(AUTH, 'lid-mapping-919810007690.json'), JSON.stringify('82274544545899'))
writeFileSync(join(AUTH, 'lid-mapping-77712345678901_reverse.json'), JSON.stringify('919900000001'))
writeFileSync(join(AUTH, 'not-a-mapping.json'), JSON.stringify('ignore me'))
writeFileSync(join(AUTH, 'lid-mapping-garbage.json'), 'not json at all')

const db = openDb()
const now = Math.floor(Date.now() / 1000)

const contact = db.prepare('INSERT INTO contacts (jid, name, notify) VALUES (?, ?, ?)')
// Saved in the address book under a phone number...
contact.run('919810007690@s.whatsapp.net', 'Vinay Sir', null)
// ...while WhatsApp knows them by LID with a self-chosen profile name.
contact.run('82274544545899@lid', null, 'Vinay Pasricha')
contact.run('919900000001@s.whatsapp.net', 'Second Contact', null)

const chat = db.prepare('INSERT INTO chats (jid, name, is_group, last_message_time) VALUES (?, ?, ?, ?)')
chat.run('82274544545899@lid', null, 0, now - 60)          // named only via mapping
chat.run('77712345678901@lid', null, 0, now - 120)         // named via reverse mapping
chat.run('120363001122334455@g.us', 'Trip Planning', 1, now - 30)
chat.run('999999999999@lid', null, 0, now - 200)           // genuinely unknown

const msg = db.prepare(`
  INSERT INTO messages (id, chat_jid, sender_jid, sender_name, timestamp, text, media_type, is_from_me)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`)
msg.run('a1', '82274544545899@lid', '82274544545899@lid', 'Vinay P', now - 600, 'the quarterly numbers are ready', null, 0)
msg.run('a2', '82274544545899@lid', null, null, now - 300, 'thanks, reviewing now', null, 1)
msg.run('a3', '82274544545899@lid', '82274544545899@lid', 'Vinay P', now - 60, null, 'image', 0)
msg.run('b1', '77712345678901@lid', '77712345678901@lid', 'SC', now - 120, 'reverse mapping works', null, 0)
msg.run('g1', '120363001122334455@g.us', '82274544545899@lid', 'Vinay P', now - 30, 'group message here', null, 0)
msg.run('u1', '999999999999@lid', '999999999999@lid', null, now - 200, 'from an unsaved number', null, 0)

console.log('\nlid-import')
const { imported } = importLidMappings(db)
check('imports both mapping directions, skips junk files', () => {
  assert.equal(imported, 2)
})
check('phone -> lid pair stored', () => {
  const r = db.prepare('SELECT pn_user FROM lid_map WHERE lid_user = ?').get('82274544545899')
  assert.equal(r?.pn_user, '919810007690')
})
check('_reverse file (lid -> phone) stored', () => {
  const r = db.prepare('SELECT pn_user FROM lid_map WHERE lid_user = ?').get('77712345678901')
  assert.equal(r?.pn_user, '919900000001')
})
check('re-running is idempotent', () => {
  const again = importLidMappings(db)
  assert.equal(again.imported, 2)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM lid_map').get().c, 2)
})

console.log('\nname resolution')
check('address-book name wins over profile name', () => {
  const r = db.prepare('SELECT name FROM name_for_jid WHERE jid = ?').get('82274544545899@lid')
  assert.equal(r?.name, 'Vinay Sir')
})
check('one row per jid', () => {
  const r = db.prepare('SELECT jid, COUNT(*) c FROM name_for_jid GROUP BY jid HAVING c > 1').all()
  assert.equal(r.length, 0)
})
check('unmapped jid resolves to nothing rather than erroring', () => {
  assert.equal(db.prepare('SELECT name FROM name_for_jid WHERE jid = ?').get('999999999999@lid'), undefined)
})
db.close()

// ---------------------------------------------------------------- MCP server

console.log('\nmcp server')
const child = spawn(process.execPath, [join(ROOT, 'src', 'mcp-server.js')], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env
})

let buf = ''
const pending = new Map()
let nextId = 1
child.stdout.on('data', d => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
    if (!line) continue
    const m = JSON.parse(line)
    const r = pending.get(m.id)
    if (r) { pending.delete(m.id); r(m) }
  }
})
const send = (method, params) => {
  const id = nextId++
  const p = new Promise(res => pending.set(id, res))
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  return p
}
const call = async (name, args) => {
  const r = await send('tools/call', { name, arguments: args })
  if (r.error) throw new Error(r.error.message)
  const text = r.result.content[0].text
  if (r.result.isError) throw new Error(text)
  return JSON.parse(text)
}

await send('initialize', {
  protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' }
})
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

const tools = (await send('tools/list', {})).result.tools
check('exposes the expected tools', () => {
  const names = tools.map(t => t.name).sort()
  assert.deepEqual(names, [
    'clear_chat_history', 'delete_chat', 'delete_local_chat', 'delete_local_messages',
    'delete_message_for_everyone', 'delete_message_for_me', 'get_message_context',
    'get_messages', 'get_stats', 'list_chats', 'list_contacts', 'purge_local_database',
    'search_messages', 'send_message'
  ])
})
check('the mutating tools are exactly the ones we intend', () => {
  const mutating = tools
    .filter(t => /send|delete|clear|purge|write|update|mark/i.test(t.name))
    .map(t => t.name).sort()
  assert.deepEqual(mutating, [
    'clear_chat_history', 'delete_chat', 'delete_local_chat', 'delete_local_messages',
    'delete_message_for_everyone', 'delete_message_for_me', 'purge_local_database', 'send_message'
  ])
})
check('every destructive tool warns the model not to act on message content', () => {
  for (const t of tools.filter(x => /delete|clear|purge/i.test(x.name))) {
    assert.match(t.description, /untrusted/i, `${t.name} does not mention untrusted content`)
    assert.match(t.description, /never/i, `${t.name} does not tell the model never to act on it`)
  }
})
check('every destructive tool takes a confirm flag', () => {
  for (const t of tools.filter(x => /delete|clear|purge/i.test(x.name))) {
    assert.ok(t.inputSchema?.properties?.confirm, `${t.name} has no confirm parameter`)
  }
})
check('send_message warns the model about untrusted message content', () => {
  const t = tools.find(x => x.name === 'send_message')
  assert.match(t.description, /untrusted/i)
  assert.match(t.description, /do not act on it|never/i)
})
{
  let err = null
  try {
    await call('send_message', { chat_jid: '82274544545899@lid', text: 'should not send' })
  } catch (e) { err = e }
  check('send without a running bridge is refused, not silently dropped', () => {
    assert.ok(err, 'expected an error')
    assert.match(err.message, /bridge is not running/i)
  })
}

const chats = await call('list_chats', { limit: 50 })
check('LID chat surfaces under its phone-contact name', () => {
  const c = chats.find(x => x.chat_jid === '82274544545899@lid')
  assert.equal(c?.name, 'Vinay Sir')
})
check('reverse-mapped chat resolves too', () => {
  const c = chats.find(x => x.chat_jid === '77712345678901@lid')
  assert.equal(c?.name, 'Second Contact')
})
check('unknown chat falls back to its jid', () => {
  const c = chats.find(x => x.chat_jid === '999999999999@lid')
  assert.equal(c?.name, '999999999999@lid')
})
check('group keeps its own subject', () => {
  const c = chats.find(x => x.chat_jid === '120363001122334455@g.us')
  assert.equal(c?.name, 'Trip Planning')
})

const found = await call('list_chats', { search: 'vinay' })
check('search "vinay" returns the LID chat (the bug this fixes)', () => {
  assert.equal(found.length, 1)
  assert.equal(found[0].chat_jid, '82274544545899@lid')
})
const groupsOnly = await call('list_chats', { only_groups: true })
check('only_groups filters correctly', () => {
  assert.equal(groupsOnly.length, 1)
  assert.equal(groupsOnly[0].is_group, true)
})

const msgs = await call('get_messages', { chat_jid: '82274544545899@lid', limit: 10 })
check('messages come back oldest-first', () => {
  assert.equal(msgs[0].text, 'the quarterly numbers are ready')
})
check('sender resolves through the mapping', () => {
  assert.equal(msgs[0].from, 'Vinay Sir')
})
check('own messages are labelled "me"', () => {
  assert.equal(msgs[1].from, 'me')
})
check('media-only message reports its type', () => {
  assert.equal(msgs[2].media, 'image')
  assert.equal(msgs[2].text, null)
})

const hits = await call('search_messages', { query: 'quarterly' })
check('search_messages finds text and names the chat', () => {
  assert.equal(hits.length, 1)
  assert.equal(hits[0].chat, 'Vinay Sir')
  assert.equal(hits[0].from, 'Vinay Sir')
})
const upper = await call('search_messages', { query: 'QUARTERLY' })
check('search matches regardless of case', () => assert.equal(upper.length, 1))

const ctx = await call('get_message_context', {
  chat_jid: '82274544545899@lid', time: hits[0].time, before: 1, after: 1
})
check('context returns surrounding messages', () => {
  assert.ok(ctx.length >= 2)
})

const contacts = await call('list_contacts', { search: 'vinay' })
check('contact search resolves through the mapping', () => {
  assert.ok(contacts.some(c => c.name === 'Vinay Sir'))
})

const stats = await call('get_stats', {})
check('stats report the seeded totals', () => {
  assert.equal(stats.messages, 6)
  assert.equal(stats.chats, 4)
})

let threw = false
try { await call('get_messages', { chat_jid: 'x@lid', before_time: 'not-a-date' }) } catch { threw = true }
check('invalid date is reported as an error, not a crash', () => assert.equal(threw, true))

// ------------------------------------------------------- read-only mode

// The point of read-only mode is that a second client — ChatGPT over a tunnel,
// say — cannot send or delete. That guarantee is worth a test of its own,
// because it is enforced by code rather than by a tool description.
console.log('\nread-only mode')
{
  const ro = spawn(process.execPath, [join(ROOT, 'src', 'mcp-server.js')], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, WHATSAPP_MCP_READONLY: '1' }
  })
  let rbuf = ''
  const rpend = new Map()
  let rid = 1
  ro.stdout.on('data', d => {
    rbuf += d
    let i
    while ((i = rbuf.indexOf('\n')) >= 0) {
      const line = rbuf.slice(0, i).trim(); rbuf = rbuf.slice(i + 1)
      if (!line) continue
      const m = JSON.parse(line)
      const r = rpend.get(m.id)
      if (r) { rpend.delete(m.id); r(m) }
    }
  })
  const rsend = (method, params) => {
    const id = rid++
    const p = new Promise(res => rpend.set(id, res))
    ro.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return p
  }
  await rsend('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' }
  })
  ro.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const roTools = (await rsend('tools/list', {})).result.tools.map(t => t.name).sort()

  check('read-only mode exposes only the read tools', () => {
    assert.deepEqual(roTools, [
      'get_message_context', 'get_messages', 'get_stats',
      'list_chats', 'list_contacts', 'search_messages'
    ])
  })
  check('read-only mode registers no send or delete tool at all', () => {
    const bad = roTools.filter(n => /send|delete|clear|purge/i.test(n))
    assert.deepEqual(bad, [], `these should not exist in read-only mode: ${bad}`)
  })
  {
    const r = await rsend('tools/call', { name: 'send_message', arguments: { chat_jid: 'x@lid', text: 'nope' } })
    check('calling send_message in read-only mode fails rather than sending', () => {
      assert.ok(r.error || r.result?.isError, 'send_message was callable in read-only mode')
    })
  }
  {
    const r = await rsend('tools/call', { name: 'purge_local_database', arguments: { confirm: true } })
    check('calling purge_local_database in read-only mode fails rather than wiping', () => {
      assert.ok(r.error || r.result?.isError, 'purge was callable in read-only mode')
    })
  }
  await new Promise(res => { ro.once('exit', res); ro.kill() })
}

// ------------------------------------------------------- local deletion

// These run against a throwaway copy of the fixture store, so a bug here can
// never reach the real database.
console.log('\nlocal deletion')
{
  const { deleteLocalMessages, deleteLocalChat, purgeLocalDatabase, lastMessagesFor } =
    await import('../src/delete.js')

  // The fixture handle is closed by this point, so read it fresh each time and
  // copy into a new file. Every case below gets its own untouched database.
  let seq = 0
  const fresh = () => {
    const src = openDb({ readOnly: true, path: DB })
    const d = openDb({ readOnly: false, path: join(TMP, `del-${++seq}.db`) })
    for (const row of src.prepare('SELECT * FROM chats').all()) {
      d.prepare('INSERT INTO chats (jid,name,is_group,last_message_time) VALUES (?,?,?,?)')
        .run(row.jid, row.name, row.is_group, row.last_message_time)
    }
    for (const row of src.prepare('SELECT * FROM contacts').all()) {
      d.prepare('INSERT INTO contacts (jid,name,notify) VALUES (?,?,?)').run(row.jid, row.name, row.notify)
    }
    for (const row of src.prepare('SELECT * FROM messages').all()) {
      d.prepare('INSERT INTO messages (id,chat_jid,sender_jid,sender_name,timestamp,text,media_type,is_from_me) VALUES (?,?,?,?,?,?,?,?)')
        .run(row.id, row.chat_jid, row.sender_jid, row.sender_name, row.timestamp, row.text, row.media_type, row.is_from_me)
    }
    src.close()
    return d
  }

  {
    const d = fresh()
    const before = d.prepare('SELECT COUNT(*) AS n FROM messages').get().n
    const preview = deleteLocalMessages(d, { chat_jid: '82274544545899@lid' })
    check('preview reports a count without deleting anything', () => {
      assert.equal(preview.preview, true)
      assert.ok(preview.would_delete > 0)
      assert.equal(d.prepare('SELECT COUNT(*) AS n FROM messages').get().n, before)
    })
    const done = deleteLocalMessages(d, { chat_jid: '82274544545899@lid', confirm: true })
    check('confirm: true deletes exactly what the preview promised', () => {
      assert.equal(done.deleted, preview.would_delete)
      assert.equal(d.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_jid = ?').get('82274544545899@lid').n, 0)
    })
    check('other chats are left alone', () => {
      assert.ok(d.prepare('SELECT COUNT(*) AS n FROM messages').get().n > 0)
    })
    d.close()
  }

  {
    const d = fresh()
    let err = null
    try { deleteLocalMessages(d, { confirm: true }) } catch (e) { err = e }
    check('refuses to wipe every message when no filter is given', () => {
      assert.ok(err, 'an unfiltered delete was allowed')
      assert.match(err.message, /filter|purge/i)
    })
    check('the refusal really did leave the data alone', () => {
      assert.ok(d.prepare('SELECT COUNT(*) AS n FROM messages').get().n > 0)
    })
    d.close()
  }

  {
    const d = fresh()
    const kept = d.prepare('SELECT COUNT(*) AS n FROM messages WHERE is_from_me = 0').get().n
    deleteLocalMessages(d, { from_me: true, confirm: true })
    check('from_me filter deletes only your own messages', () => {
      assert.equal(d.prepare('SELECT COUNT(*) AS n FROM messages WHERE is_from_me = 1').get().n, 0)
      assert.equal(d.prepare('SELECT COUNT(*) AS n FROM messages WHERE is_from_me = 0').get().n, kept)
    })
    d.close()
  }

  {
    const d = fresh()
    const p = deleteLocalChat(d, '82274544545899@lid')
    check('deleting a chat previews before acting', () => {
      assert.equal(p.preview, true)
      assert.ok(d.prepare('SELECT COUNT(*) AS n FROM chats WHERE jid = ?').get('82274544545899@lid').n > 0)
    })
    deleteLocalChat(d, '82274544545899@lid', true)
    check('confirmed chat delete removes the chat and its messages', () => {
      assert.equal(d.prepare('SELECT COUNT(*) AS n FROM chats WHERE jid = ?').get('82274544545899@lid').n, 0)
      assert.equal(d.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_jid = ?').get('82274544545899@lid').n, 0)
    })
    check('deleting a chat that does not exist is not an error', () => {
      assert.equal(deleteLocalChat(d, 'nobody@lid', true).deleted, 0)
    })
    d.close()
  }

  {
    const d = fresh()
    const p = purgeLocalDatabase(d)
    check('purge previews the totals without touching them', () => {
      assert.equal(p.preview, true)
      assert.ok(d.prepare('SELECT COUNT(*) AS n FROM messages').get().n > 0)
    })
    purgeLocalDatabase(d, true)
    check('confirmed purge empties every table', () => {
      for (const t of ['messages', 'chats', 'contacts']) {
        assert.equal(d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, `${t} was not emptied`)
      }
    })
    d.close()
  }

  {
    const d = fresh()
    const last = lastMessagesFor(d, '82274544545899@lid', 1)
    check('lastMessagesFor returns the shape chatModify needs', () => {
      assert.equal(last.length, 1)
      assert.equal(last[0].key.remoteJid, '82274544545899@lid')
      assert.equal(typeof last[0].key.id, 'string')
      assert.equal(typeof last[0].key.fromMe, 'boolean')
      assert.equal(typeof last[0].messageTimestamp, 'number')
    })
    check('lastMessagesFor on an unknown chat returns nothing rather than throwing', () => {
      assert.deepEqual(lastMessagesFor(d, 'nobody@lid', 1), [])
    })
    d.close()
  }
}

// ------------------------------------------------- control server (sending)

console.log('\ncontrol server')
{
  // Deletion over the control channel. A stub socket records what Baileys would
  // have been asked to do, so the wire shape is checked without touching WhatsApp.
  const { startControlServer } = await import('../src/control-server.js')
  const calls = []
  const sock = {
    sendMessage: async (jid, content) => { calls.push({ fn: 'sendMessage', jid, content }); return { key: { id: 'REVOKED' } } },
    chatModify: async (mod, jid) => { calls.push({ fn: 'chatModify', jid, mod }) }
  }
  const dir = join(TMP, 'ctl-del')
  mkdirSync(dir, { recursive: true })
  const ctl = startControlServer(() => sock, { dataDir: dir, logger: { error () {} }, minGapMs: 0 })
  await new Promise(r => setTimeout(r, 50))
  const cfg = JSON.parse(readFileSync(join(dir, 'control.json'), 'utf8'))
  const post = async body => {
    const res = await fetch(`http://127.0.0.1:${cfg.port}/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify(body)
    })
    return { status: res.status, body: await res.json().catch(() => ({})) }
  }

  const revoke = await post({ action: 'revoke', to: 'x@lid', message_id: 'a1' })
  check('revoke asks Baileys to delete for everyone', () => {
    assert.equal(revoke.status, 200)
    const c = calls.find(c => c.fn === 'sendMessage')
    assert.equal(c.content.delete.id, 'a1')
    assert.equal(c.content.delete.fromMe, true)
  })

  const clear = await post({ action: 'clear_chat', to: 'x@lid', last_messages: [{ key: { id: 'a1' }, messageTimestamp: 1 }] })
  check('clear_chat goes through chatModify with a reference message', () => {
    assert.equal(clear.status, 200)
    assert.equal(calls.at(-1).mod.clear, true)
  })

  const noRef = await post({ action: 'delete_chat', to: 'x@lid' })
  check('clear/delete without a reference message is refused, not guessed', () => {
    assert.equal(noRef.status, 400)
    assert.match(noRef.body.error, /last_messages/)
  })

  const bad = await post({ action: 'nuke_everything', to: 'x@lid' })
  check('an unknown delete action is rejected', () => {
    assert.equal(bad.status, 400)
    assert.match(bad.body.error, /must be one of/)
  })

  const noId = await post({ action: 'revoke', to: 'x@lid' })
  check('revoke without a message id is rejected', () => assert.equal(noId.status, 400))

  check('every whatsapp-side deletion is written to deleted.log', () => {
    const log = readFileSync(join(dir, 'deleted.log'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(log.length, 2, 'only the two successful calls should be logged')
    assert.equal(log[0].action, 'revoke')
    assert.equal(log[1].action, 'clear_chat')
  })

  const unauth = await fetch(`http://127.0.0.1:${cfg.port}/delete`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
  })
  check('/delete rejects a missing token', () => assert.equal(unauth.status, 401))

  ctl.close()
}
{
  // /check and /groups. Both only read — nothing is delivered and nothing is
  // written — but both reach WhatsApp, so the request shapes are worth pinning.
  const { startControlServer } = await import('../src/control-server.js')
  const sock = {
    // Baileys returns only the numbers it resolved; absence is the answer for the rest
    onWhatsApp: async (...jids) => jids
      .filter(j => !j.startsWith('999'))
      .map(j => ({ jid: j, exists: true })),
    groupFetchAllParticipating: async () => ({
      'a@g.us': { id: 'a@g.us', subject: 'Open Group', announce: false, participants: [{ id: '1@s.whatsapp.net' }, { id: '2@s.whatsapp.net', admin: 'admin' }] },
      'b@g.us': { id: 'b@g.us', subject: 'Announce Only', announce: true, participants: [{ id: '3@s.whatsapp.net' }] }
    })
  }
  const dir = join(TMP, 'ctl-read')
  mkdirSync(dir, { recursive: true })
  const ctl = startControlServer(() => sock, { dataDir: dir, logger: { error () {} } })
  await new Promise(r => setTimeout(r, 50))
  const cfg = JSON.parse(readFileSync(join(dir, 'control.json'), 'utf8'))
  const post = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${cfg.port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify(body)
    })
    return { status: res.status, body: await res.json().catch(() => ({})) }
  }

  const chk = await post('/check', { numbers: ['919810007690', '9998887776655'] })
  check('/check reports which numbers have WhatsApp accounts', () => {
    assert.equal(chk.status, 200)
    const live = chk.body.results.find(r => r.number === '919810007690')
    const dead = chk.body.results.find(r => r.number === '9998887776655')
    assert.equal(live.exists, true)
    assert.equal(dead.exists, false, 'a number WhatsApp did not resolve should come back false')
  })

  const dirty = await post('/check', { numbers: ['+91 98100 07690', 'abc', '12'] })
  check('/check strips formatting and drops unusable entries', () => {
    assert.equal(dirty.status, 200)
    assert.equal(dirty.body.results.length, 1, 'only the real number should survive cleaning')
    assert.equal(dirty.body.results[0].number, '919810007690')
  })

  const tooMany = await post('/check', { numbers: Array.from({ length: 51 }, (_, i) => `9198100076${String(i).padStart(2, '0')}`) })
  check('/check refuses more than 50 numbers in one call', () => {
    assert.equal(tooMany.status, 400)
    assert.match(tooMany.body.error, /too many/i)
  })

  const noNums = await post('/check', {})
  check('/check rejects a request with no numbers', () => assert.equal(noNums.status, 400))

  const groups = await post('/groups', {})
  check('/groups lists groups with size and whether posting is restricted', () => {
    assert.equal(groups.status, 200)
    assert.equal(groups.body.count, 2)
    const open = groups.body.groups.find(g => g.subject === 'Open Group')
    const announce = groups.body.groups.find(g => g.subject === 'Announce Only')
    assert.equal(open.size, 2)
    assert.equal(open.announce, false)
    assert.equal(announce.announce, true, 'admin-only groups must be flagged, or you plan a post you cannot make')
  })

  const one = await post('/groups', { jid: 'a@g.us' })
  check('/groups returns the member list only when a jid is asked for', () => {
    assert.equal(one.status, 200)
    assert.equal(one.body.participants.length, 2)
    assert.equal(one.body.participants[1].admin, 'admin')
    assert.ok(!groups.body.groups[0].participants, 'the bulk listing must not leak rosters')
  })

  const missing = await post('/groups', { jid: 'nope@g.us' })
  check('/groups 404s on a group this account is not in', () => assert.equal(missing.status, 404))

  const unauthed = await fetch(`http://127.0.0.1:${cfg.port}/groups`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
  })
  check('/groups rejects a missing token', () => assert.equal(unauthed.status, 401))

  ctl.close()
}
{
  const { startControlServer } = await import('../src/control-server.js')

  // Stands in for Baileys: the socket object is REPLACED on every reconnect, which
  // is what broke sending when the server captured it once at startup.
  let liveSocket = { sendMessage: async () => ({ key: { id: 'FIRST' } }) }
  const ctl = startControlServer(() => liveSocket, {
    dataDir: TMP,
    logger: { error () {} },
    minGapMs: 0 // fire assertions back to back; pacing is verified separately
  })

  await new Promise(r => setTimeout(r, 150))
  const { port, token } = JSON.parse(readFileSync(join(TMP, 'control.json'), 'utf8'))
  const post = (body, tok = token) => fetch(`http://127.0.0.1:${port}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
    body: JSON.stringify(body)
  })

  const good = await post({ to: 'x@lid', text: 'hello' })
  check('accepts a valid send', () => assert.equal(good.status, 200))

  const unauth = await post({ to: 'x@lid', text: 'hi' }, 'wrong-token')
  check('rejects a bad token', () => assert.equal(unauth.status, 401))

  const badJid = await post({ to: 'nope', text: 'hi' })
  check('rejects a malformed jid', () => assert.equal(badJid.status, 400))

  const empty = await post({ to: 'x@lid', text: '   ' })
  check('rejects empty text', () => assert.equal(empty.status, 400))

  // The regression: after a reconnect Baileys hands back a NEW socket object.
  liveSocket = { sendMessage: async () => ({ key: { id: 'SECOND' } }) }
  const afterReconnect = await post({ to: 'x@lid', text: 'after reconnect' })
  const body = await afterReconnect.json()
  check('still sends after the socket is replaced (reconnect)', () => {
    assert.equal(afterReconnect.status, 200)
    assert.equal(body.id, 'SECOND', 'used a stale socket captured at startup')
  })

  liveSocket = null
  const disconnected = await post({ to: 'x@lid', text: 'while down' })
  check('returns 503 while disconnected rather than a confusing failure', () => {
    assert.equal(disconnected.status, 503)
  })

  ctl.close()
  await new Promise(r => setTimeout(r, 50))
}

// Pacing is a separate concern from the socket handling above, so it gets its own
// server with production-like limits.
{
  const { startControlServer } = await import('../src/control-server.js')
  const dir = join(TMP, 'ratelimit')
  mkdirSync(dir, { recursive: true })
  const ctl = startControlServer(() => ({ sendMessage: async () => ({ key: { id: 'X' } }) }), {
    dataDir: dir, logger: { error () {} }, minGapMs: 5000
  })
  await new Promise(r => setTimeout(r, 150))
  const { port, token } = JSON.parse(readFileSync(join(dir, 'control.json'), 'utf8'))
  const post = () => fetch(`http://127.0.0.1:${port}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: 'x@lid', text: 'burst' })
  })

  const first = await post()
  const second = await post()
  check('throttles a burst instead of blasting messages', () => {
    assert.equal(first.status, 200)
    assert.equal(second.status, 429)
  })

  ctl.close()
  await new Promise(r => setTimeout(r, 50))
}

// ---------------------------------------------------------------- teardown

// Wait for the child to actually exit. On Windows it keeps a handle on the
// database file, and rmSync fails with EPERM if we race it.
await new Promise(resolve => {
  child.once('exit', resolve)
  child.kill()
})

try {
  rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
} catch (err) {
  console.log(`  note: could not remove temp dir ${TMP} (${err.code})`)
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log('failed: ' + failures.join(', '))
  process.exit(1)
}
