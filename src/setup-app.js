/**
 * What happens when the user double-clicks the executable.
 *
 * A local web page rather than a console window. The buyer for this product is
 * a business owner, and a black terminal filled with scrolling text reads as
 * "something has gone wrong" no matter what it says. A browser tab reads as
 * software. It also gives us a QR code as an actual image rather than ASCII
 * art, which people photograph far more reliably.
 *
 * The server binds to 127.0.0.1 on an ephemeral port, so nothing is reachable
 * from outside the machine.
 *
 * The bridge runs as a child process rather than in here, because that is how
 * it runs in production too - one long-lived process that outlives this window.
 * We watch its [status] lines to drive the UI.
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { BRAND } from './brand.js'
import { ensureDataDir, isPackaged } from './paths.js'
import { activate, check, looksLikeKey } from './licence.js'
import { findClaude, mcpEntry, writeConfig, isRegistered, configBlock, desktopConfigPath, claudeCodeConfigPath } from './claude-config.js'
import * as autostart from './autostart.js'

const DATA = ensureDataDir()
const QR_PNG = join(DATA, 'qr.png')

/** Everything the UI needs to render, in one object it polls for. */
const state = {
  step: 'licence',        // licence | claude | link | register | done
  licensed: false,
  plan: null,
  claude: null,
  qrReady: false,
  qrAttempt: 0,
  connected: false,
  registered: [],
  autostart: false,
  error: null,
  // Set when setup is finished and the window can be closed.
  finished: false
}

let bridge = null

/** The config entry Claude needs, which differs packaged vs from source. */
function entry () {
  return mcpEntry({
    packaged: isPackaged(),
    execPath: process.execPath,
    scriptPath: join(__dirname ?? '', 'mcp-server.js')
  })
}

/** Start the WhatsApp connection and follow what it reports. */
function startBridge () {
  if (bridge) return
  // Packaged, process.execPath IS the product, so it takes the flags directly.
  // From source it is the node binary, which needs the script path first.
  const args = isPackaged()
    ? ['--bridge', '--no-open']
    : [process.argv[1], '--bridge', '--no-open']

  bridge = spawn(process.execPath, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true
  })

  let buf = ''
  bridge.stderr.on('data', chunk => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line.startsWith('[status]')) continue
      let msg
      try {
        msg = JSON.parse(line.slice(8).trim())
      } catch { continue }

      if (msg.state === 'qr') {
        state.qrReady = true
        state.qrAttempt = msg.attempt || 0
        state.step = 'link'
      }
      if (msg.state === 'connected') {
        state.connected = true
        state.qrReady = false
        if (state.step === 'link') state.step = 'register'
      }
      if (msg.state === 'logged-out') {
        state.error = 'WhatsApp signed this device out. You will need to link again.'
        state.connected = false
      }
    }
  })

  bridge.on('exit', code => {
    bridge = null
    if (!state.connected && code !== 0) {
      state.error = 'The WhatsApp connection stopped unexpectedly. Close this window and run the app again.'
    }
  })
}

/** Write ourselves into every Claude config we can find. */
function register () {
  const e = entry()
  const results = []
  const claude = findClaude()

  for (const target of [
    { name: 'Claude Desktop', path: desktopConfigPath(), when: claude.desktop.installed },
    { name: 'Claude Code', path: claudeCodeConfigPath(), when: claude.code.configured }
  ]) {
    if (!target.when) continue
    if (isRegistered(target.path, e)) {
      results.push({ name: target.name, ok: true, unchanged: true })
      continue
    }
    const r = writeConfig(target.path, e)
    results.push({ name: target.name, ok: r.ok, reason: r.reason, existed: r.existed })
  }

  state.registered = results

  const auto = autostart.enable(process.execPath)
  state.autostart = auto.ok

  state.step = 'done'
  state.finished = true
  return results
}

/* ----------------------------------------------------------------- the page */

const page = () => `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${BRAND.name} setup</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --muted:#666; --line:#e5e5e5; --accent:#111; --ok:#0a7; --err:#c33; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#111; --fg:#eee; --muted:#999; --line:#2a2a2a; --accent:#eee; }
  }
  * { box-sizing: border-box }
  body { margin:0; font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
         background:var(--bg); color:var(--fg); display:flex; justify-content:center; padding:48px 20px }
  main { width:100%; max-width:440px }
  h1 { font-size:22px; margin:0 0 4px; letter-spacing:-.01em }
  .tag { color:var(--muted); margin:0 0 32px }
  .steps { display:flex; gap:6px; margin-bottom:28px }
  .steps i { flex:1; height:3px; border-radius:2px; background:var(--line) }
  .steps i.on { background:var(--accent) }
  .card { border:1px solid var(--line); border-radius:12px; padding:24px }
  h2 { font-size:16px; margin:0 0 6px }
  p { margin:0 0 16px; color:var(--muted) }
  input { width:100%; padding:11px 13px; font:inherit; letter-spacing:.06em; text-transform:uppercase;
          border:1px solid var(--line); border-radius:8px; background:transparent; color:var(--fg) }
  button { width:100%; padding:11px; font:inherit; font-weight:500; margin-top:12px; cursor:pointer;
           border:0; border-radius:8px; background:var(--accent); color:var(--bg) }
  button:disabled { opacity:.5; cursor:default }
  .qr { display:block; width:260px; height:260px; margin:0 auto 16px; border-radius:8px; background:#fff }
  ol { margin:0; padding-left:20px; color:var(--muted) }
  li { margin-bottom:6px }
  .err { color:var(--err); margin-top:12px }
  .ok { color:var(--ok) }
  .row { display:flex; justify-content:space-between; padding:7px 0; border-bottom:1px solid var(--line) }
  .row:last-child { border:0 }
  code { background:var(--line); padding:2px 6px; border-radius:4px; font-size:13px }
  .try { border:1px solid var(--line); border-radius:8px; padding:12px 14px; margin-top:6px; font-size:14px }
</style>
<main>
  <h1>${BRAND.name}</h1>
  <p class="tag">${BRAND.tagline}</p>
  <div class="steps" id="steps"><i></i><i></i><i></i><i></i></div>
  <div class="card" id="card">Loading…</div>
</main>
<script>
const STEPS = ['licence','claude','link','register','done']
let busy = false

async function poll () {
  if (busy) return
  const s = await (await fetch('/api/state')).json()
  render(s)
}

function render (s) {
  const idx = STEPS.indexOf(s.step)
  document.querySelectorAll('#steps i').forEach((el, i) => el.classList.toggle('on', i <= idx - (s.step==='done'?0:1)))
  const c = document.getElementById('card')

  if (s.step === 'licence') {
    if (c.dataset.k === 'licence') return
    c.dataset.k = 'licence'
    c.innerHTML = \`<h2>Enter your licence key</h2>
      <p>It was emailed to you when you bought \${'${BRAND.name}'}.</p>
      <input id="key" placeholder="ABCD-EFGH-IJKL-MNOP" autocomplete="off" spellcheck="false">
      <button id="go">Continue</button><div class="err" id="e"></div>\`
    const go = document.getElementById('go'), key = document.getElementById('key'), e = document.getElementById('e')
    key.focus()
    const submit = async () => {
      busy = true; go.disabled = true; go.textContent = 'Checking…'; e.textContent = ''
      const r = await (await fetch('/api/licence', {
        method:'POST', headers:{'content-type':'application/json'},
        body: JSON.stringify({ key: key.value })
      })).json()
      busy = false
      if (!r.ok) { e.textContent = r.reason; go.disabled = false; go.textContent = 'Continue'; return }
      c.dataset.k = ''
    }
    go.onclick = submit
    key.onkeydown = ev => { if (ev.key === 'Enter') submit() }
    return
  }

  if (s.step === 'claude') {
    if (c.dataset.k === 'claude') return
    c.dataset.k = 'claude'
    c.innerHTML = \`<h2>Claude isn't installed yet</h2>
      <p>\${'${BRAND.name}'} works inside Claude. Install it, open it once, then come back here.</p>
      <ol><li>Download Claude from <code>claude.ai/download</code></li>
      <li>Install and open it once</li><li>Click below</li></ol>
      <button id="again">I've installed Claude</button>\`
    document.getElementById('again').onclick = async () => {
      busy = true; await fetch('/api/recheck', { method:'POST' }); busy = false; c.dataset.k = ''
    }
    return
  }

  if (s.step === 'link') {
    if (c.dataset.k !== 'link') {
      c.dataset.k = 'link'
      c.innerHTML = \`<h2>Link your WhatsApp</h2>
        <p>Scan once. You won't need to do this again.</p>
        <img class="qr" id="qr" alt="QR code">
        <ol><li>Open WhatsApp on your phone</li>
        <li>Settings → Linked devices → Link a device</li>
        <li>Point your camera at this code</li></ol>\`
    }
    if (s.qrReady) document.getElementById('qr').src = '/api/qr?t=' + Date.now()
    return
  }

  if (s.step === 'register') {
    if (c.dataset.k === 'register') return
    c.dataset.k = 'register'
    c.innerHTML = \`<h2 class="ok">WhatsApp connected</h2>
      <p>Setting up Claude…</p>\`
    busy = true
    fetch('/api/register', { method:'POST' }).then(() => { busy = false; c.dataset.k = '' })
    return
  }

  if (s.step === 'done') {
    if (c.dataset.k === 'done') return
    c.dataset.k = 'done'
    const rows = (s.registered || []).map(r =>
      \`<div class="row"><span>\${r.name}</span><span class="\${r.ok?'ok':'err'}">\${r.ok?'ready':r.reason||'failed'}</span></div>\`).join('')
    c.innerHTML = \`<h2 class="ok">All set</h2>
      <p>Restart Claude, then try asking:</p>
      <div class="try">"What's in my WhatsApp from this week?"</div>
      <div class="try">"Who's waiting on a reply from me?"</div>
      <div style="margin-top:20px">\${rows}
      <div class="row"><span>Starts automatically</span><span class="\${s.autostart?'ok':'err'}">\${s.autostart?'yes':'no'}</span></div></div>
      <p style="margin-top:20px;font-size:13px">Your messages stay on this computer. You can close this window.</p>\`
    return
  }
}

poll(); setInterval(poll, 1200)
</script>`

/* --------------------------------------------------------------- the server */

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const readBody = req => new Promise(resolve => {
  let raw = ''
  req.on('data', c => { raw += c; if (raw.length > 8192) req.destroy() })
  req.on('end', () => { try { resolve(JSON.parse(raw)) } catch { resolve({}) } })
})

/** Work out which step we are on, given what is already true. */
async function refresh () {
  const lic = await check()
  state.licensed = lic.licensed
  state.plan = lic.plan ?? null

  if (!state.licensed) { state.step = 'licence'; return }

  const claude = findClaude()
  state.claude = { desktop: claude.desktop.installed, code: claude.code.configured }
  if (!claude.any) { state.step = 'claude'; return }

  if (state.finished) { state.step = 'done'; return }
  if (state.connected) { state.step = 'register'; return }

  startBridge()
  state.step = 'link'
}

const server = createServer(async (req, res) => {
  const url = req.url.split('?')[0]

  if (url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(page())
  }

  if (url === '/api/state') {
    if (!state.finished) await refresh()
    return json(res, 200, state)
  }

  if (url === '/api/licence' && req.method === 'POST') {
    const { key } = await readBody(req)
    if (!looksLikeKey(key)) {
      return json(res, 200, { ok: false, reason: 'That does not look like a licence key. It should look like ABCD-EFGH-IJKL-MNOP.' })
    }
    const r = await activate(key)
    if (r.ok) await refresh()
    return json(res, 200, r)
  }

  if (url === '/api/recheck' && req.method === 'POST') {
    await refresh()
    return json(res, 200, { ok: true })
  }

  if (url === '/api/register' && req.method === 'POST') {
    return json(res, 200, { ok: true, results: register() })
  }

  if (url === '/api/qr') {
    if (!existsSync(QR_PNG)) return json(res, 404, { error: 'no code yet' })
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
    return res.end(readFileSync(QR_PNG))
  }

  json(res, 404, { error: 'not found' })
})

/** Open the setup page in the default browser. Best-effort. */
function openBrowser (url) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]]
      : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  try {
    const c = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    c.on('error', () => {})
    c.unref()
  } catch { /* the URL is printed below either way */ }
}

server.listen(0, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${server.address().port}`
  console.error(`${BRAND.name} setup: ${url}`)
  openBrowser(url)
})

// The bridge must outlive this window, so it is deliberately not killed here.
process.on('SIGINT', () => process.exit(0))
