/**
 * Integration check: the board route served over a REAL node:http server.
 *
 * `tools/smoke.mjs` calls the route handler directly, which proves the fence's
 * logic but not that Node's real request object reaches it intact — header
 * casing, the async-iterable body, and the response lifecycle all differ once
 * an actual server is in front. This runs the same two routes through one.
 *
 * Read-only with respect to the real board: DSH_HOME points at a temp dir.
 */

import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dshtb-http-'))
process.env.DSH_HOME = home

const mod = await import('../lib/index.js')

const routes = []
const webServer = { register: (route) => (routes.push(route), () => {}) }

/**
 * What `ctx.get('connection')` finds. `undefined` (the default) models a
 * deployment without `dsh-client-connection`, where the locally restated fence
 * is the only one there is; the convergence cases at the end install a stand-in
 * for the harness gate.
 */
let connectionService

const ctx = {
  root: undefined,
  webServer,
  get: (key) =>
    key === 'webServer' ? webServer : key === 'connection' ? connectionService : undefined,
  on: () => () => {},
  effect: (cb) => {
    const d = cb()
    return typeof d === 'function' ? d : () => {}
  },
  inject: (names, cb) => cb(ctx),
  logger: { exporter: () => () => {}, error() {}, warn() {}, info() {}, debug() {} },
}

mod.apply(ctx)
assert.equal(routes.length, 2, 'both routes registered')

const api = routes.find((r) => r.path === '/dsh-todo-board/api')
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname
  const route = routes.find((r) => r.path === path)
  if (route === undefined) {
    res.writeHead(404)
    res.end()
    return
  }
  route.handler(req, res)
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = 'http://127.0.0.1:' + port

async function status(path, options) {
  const response = await fetch(base + path, options)
  const text = await response.text()
  return { status: response.status, text }
}

/**
 * One request with an EXPLICIT `Host` header.
 *
 * `fetch` derives `Host` from the URL, so it cannot express the rebinding case
 * this fence exists for — the whole point is a request whose socket reaches us
 * while its Host names somewhere else. Only a raw client can send that.
 */
function rawRequest(path, { method = 'GET', host, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(body, 'utf8')
    const finalHeaders = { ...headers }
    if (host !== undefined) finalHeaders.host = host
    if (payload !== undefined) finalHeaders['content-length'] = String(payload.length)
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method, headers: finalHeaders },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode, text }))
      },
    )
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

try {
  // A same-origin browser GET is served.
  const ok = await status('/dsh-todo-board/api')
  assert.equal(ok.status, 200, 'a loopback GET is served over real HTTP')
  assert.ok(ok.text.includes('"ok":true'), 'and returns the board payload')

  // The DNS-rebinding case: a Host naming an attacker domain while the socket
  // still reaches us. Sent raw, because `fetch` would rewrite Host to match the
  // URL — which is exactly the forgery this fence must survive.
  const rebound = await rawRequest('/dsh-todo-board/api', { host: 'evil.example' })
  assert.equal(rebound.status, 403, 'a rebound Host is refused over real HTTP')

  // The cross-site case: a preflight-free POST. `text/plain` is a CORS
  // safelisted type, so a malicious page can send this without a preflight —
  // which is why the fence, not the content type, has to be the guard.
  const crossSite = await rawRequest('/dsh-todo-board/api', {
    method: 'POST',
    host: '127.0.0.1:' + port,
    headers: { 'content-type': 'text/plain', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ action: 'clearVerified' }),
  })
  assert.equal(crossSite.status, 403, 'a preflight-free cross-site POST is refused over real HTTP')

  // A foreign Origin on an otherwise fine Host is refused too.
  const badOrigin = await rawRequest('/dsh-todo-board/api', {
    host: '127.0.0.1:' + port,
    headers: { origin: 'http://evil.example' },
  })
  assert.equal(badOrigin.status, 403, 'a foreign Origin is refused over real HTTP')

  // A same-origin POST still works, so the fence did not break the panel.
  const post = await rawRequest('/dsh-todo-board/api', {
    method: 'POST',
    host: '127.0.0.1:' + port,
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ action: 'create', title: '真实 HTTP 写入' }),
  })
  assert.equal(post.status, 200, 'a same-origin POST is served over real HTTP')
  const created = JSON.parse(post.text)
  assert.equal(created.ok, true, 'and actually mutates the board: ' + post.text)

  const after = await status('/dsh-todo-board/api')
  assert.ok(after.text.includes('真实 HTTP 写入'), 'the created row is readable back')
  assert.ok(!after.text.includes('"logs"'), 'and the idle poll still carries no log content')

  // -- settings: the round trip, and the rejection that must not write -------
  //
  // The panel's settings page is a thin client over this action, so the two
  // things that matter are (a) a valid write is readable back off the SAME
  // snapshot the panel polls, and (b) an invalid one is refused AND leaves the
  // board untouched. (b) is the one worth pinning: "validate then write" is
  // easy to get wrong by clamping as you go, and a half-applied settings object
  // makes the panel show values the loader will silently change later.
  const setOk = await rawRequest('/dsh-todo-board/api', {
    method: 'POST',
    host: '127.0.0.1:' + port,
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({
      action: 'settings',
      settings: { nudge: false, minChars: 321, minEntries: 4, maxTurnSessions: 25 },
    }),
  })
  assert.equal(setOk.status, 200, 'a settings POST is served')
  const setOkBody = JSON.parse(setOk.text)
  assert.equal(setOkBody.ok, true, 'settings accepted: ' + setOk.text)
  const snap = await status('/dsh-todo-board/api')
  const snapBody = JSON.parse(snap.text)
  assert.equal(snapBody.settings.nudge, false, 'the snapshot carries the saved nudge switch')
  assert.equal(snapBody.settings.minChars, 321, 'the snapshot carries the saved 字数')
  assert.equal(snapBody.settings.minEntries, 4, 'the snapshot carries the saved 条目数')
  assert.equal(
    snapBody.settings.maxTurnSessions,
    25,
    'and the saved spawn cap — the setting that MAX_PLAN_ITEMS can outrun',
  )

  const beforeBad = (await status('/dsh-todo-board/api')).text
  const setBad = await rawRequest('/dsh-todo-board/api', {
    method: 'POST',
    host: '127.0.0.1:' + port,
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ action: 'settings', settings: { nudge: true, minChars: 999999 } }),
  })
  const setBadBody = JSON.parse(setBad.text)
  assert.equal(setBadBody.ok, false, 'an out-of-range 字数 is refused: ' + setBad.text)
  const afterBad = (await status('/dsh-todo-board/api')).text
  assert.equal(afterBad, beforeBad, 'and a refused settings write changes NOTHING (not even the bad field)')

  // The spawn cap has its own range: 0 would mean "never spawn", which mode
  // `remind` already expresses, and a huge number would stall the turn-stopping
  // hook the harness awaits.
  const capBad = await rawRequest('/dsh-todo-board/api', {
    method: 'POST',
    host: '127.0.0.1:' + port,
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ action: 'settings', settings: { maxTurnSessions: 0 } }),
  })
  assert.equal(JSON.parse(capBad.text).ok, false, 'a spawn cap of 0 is refused')
  const capHigh = await rawRequest('/dsh-todo-board/api', {
    method: 'POST',
    host: '127.0.0.1:' + port,
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ action: 'settings', settings: { maxTurnSessions: 51 } }),
  })
  assert.equal(JSON.parse(capHigh.text).ok, false, 'and so is one above the range')
  const capAfter = JSON.parse((await status('/dsh-todo-board/api')).text)
  assert.equal(capAfter.settings.maxTurnSessions, 25, 'neither refusal disturbed the saved cap')

  // -- layout: the panel's parking spot follows the deployment, not the origin --
  //
  // This moved out of localStorage in 0.13.4 because storage is keyed by ORIGIN:
  // restarting DSH on a different port made the panel forget where it was
  // parked. The host copy is the durable one the panel adopts on load.
  const savedLayout = await rawRequest('/dsh-todo-board/api', {
    method: 'POST',
    host: '127.0.0.1:' + port,
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ action: 'layout', layout: { x: 123, y: 45, w: 420, h: 380 } }),
  })
  assert.equal(JSON.parse(savedLayout.text).ok, true, 'a layout write is accepted')
  const layoutSnap = JSON.parse((await status('/dsh-todo-board/api')).text)
  assert.deepEqual(
    layoutSnap.layout,
    { x: 123, y: 45, w: 420, h: 380 },
    'the snapshot carries the parked geometry back',
  )

  // A parked LINE has no meaningful w/h: those are null, and must round-trip as
  // null rather than being invented (a stored 0 would collapse the card).
  await rawRequest('/dsh-todo-board/api', {
    method: 'POST',
    host: '127.0.0.1:' + port,
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ action: 'layout', layout: { x: 10, y: 20, w: null, h: null } }),
  })
  const parkedSnap = JSON.parse((await status('/dsh-todo-board/api')).text)
  assert.deepEqual(
    parkedSnap.layout,
    { x: 10, y: 20, w: null, h: null },
    'a parked line stores no size, and gets none invented',
  )

  // Garbage is refused outright rather than stored as NaN.
  const badLayout = await rawRequest('/dsh-todo-board/api', {
    method: 'POST',
    host: '127.0.0.1:' + port,
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ action: 'layout', layout: { x: 'left', y: 20 } }),
  })
  assert.equal(JSON.parse(badLayout.text).ok, false, 'a layout without numeric x/y is refused')
  const stillParked = JSON.parse((await status('/dsh-todo-board/api')).text)
  assert.deepEqual(stillParked.layout, { x: 10, y: 20, w: null, h: null }, 'and nothing changed')

  // Clearing is how "reset to the default corner" is expressed.
  await rawRequest('/dsh-todo-board/api', {
    method: 'POST',
    host: '127.0.0.1:' + port,
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ action: 'layout', layout: null }),
  })
  const cleared = JSON.parse((await status('/dsh-todo-board/api')).text)
  assert.equal(cleared.layout, null, 'a null layout clears the preference')

  // A partial patch keeps the fields it did not mention.
  const partial = await rawRequest('/dsh-todo-board/api', {
    method: 'POST',
    host: '127.0.0.1:' + port,
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ action: 'settings', settings: { minEntries: 9 } }),
  })
  assert.equal(JSON.parse(partial.text).ok, true, 'a partial settings patch is accepted')
  const partialSnap = JSON.parse((await status('/dsh-todo-board/api')).text)
  assert.equal(partialSnap.settings.minEntries, 9, 'the patched field changed')
  assert.equal(partialSnap.settings.minChars, 321, 'the fields it omitted are untouched')
  assert.equal(partialSnap.settings.nudge, false, 'including the switch')

  // -- channel convergence: a local shell client can no longer write ---------
  //
  // Everything above ran WITHOUT a `connection` service, so it also pins the
  // fallback fence. But the restated fence only ever asked "is the Host ours?",
  // and a local process can answer yes — which is how an AI with a shell could
  // bypass the approval gate on the tool by POSTing this route directly. The
  // harness gate adds the second question the restatement never asked: does this
  // request carry the browser session we handed out? That is the difference
  // between a fence and an authorization layer.
  connectionService = {
    requestRejection(request) {
      const cookie = request.headers.cookie
      return typeof cookie === 'string' && cookie.includes('dsh-auth-') ? undefined : 401
    },
  }

  const shellWrite = await rawRequest('/dsh-todo-board/api', {
    method: 'POST',
    host: '127.0.0.1:' + port,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'create', title: '绕过审批写进来的一条' }),
  })
  assert.equal(
    shellWrite.status,
    401,
    'a credential-less local client is refused ONCE the harness gate decides',
  )

  const shellRead = await rawRequest('/dsh-todo-board/api', {
    host: '127.0.0.1:' + port,
    headers: { cookie: 'dsh-auth-probe=1' },
  })
  assert.equal(shellRead.status, 200, 'the same client with a session cookie is served')
  assert.ok(
    !shellRead.text.includes('绕过审批写进来的一条'),
    'and the refused write really did not land',
  )

  const panelWrite = await rawRequest('/dsh-todo-board/api', {
    method: 'POST',
    host: '127.0.0.1:' + port,
    headers: { 'content-type': 'application/json', cookie: 'dsh-auth-probe=1' },
    body: JSON.stringify({ action: 'create', title: '面板自己写的' }),
  })
  assert.equal(panelWrite.status, 200, "the browser's own write still works — the panel is not locked out")

  console.log('http    OK — fence holds and the panel still works over real HTTP')
} finally {
  await new Promise((resolve) => server.close(resolve))
  rmSync(home, { recursive: true, force: true })
}
