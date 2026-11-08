/**
 * Regression test: every message this plugin injects into a session must be a
 * well-formed event for the REAL session validator.
 *
 * Why this exists. The dispatched notice used to be built with a bare string
 * `content`:
 *
 *     { id, role: 'user', content: '【TODO 板 · 自动接续】…', source: {…} }
 *
 * `dsh-session` requires `ContentBlock[]` and rejects the event outright
 * ("message has invalid content", `assertMessageEventShape`). Because the event
 * is already durable by then, the rejection is not a per-message annoyance: the
 * WHOLE session becomes unopenable — "stored session … is corrupt". That
 * happened to a real dispatched session, whose history could only be recovered
 * by rewriting the log. Every existing suite passed, because none of them asked
 * the real validator.
 *
 * So this drives the actual dispatch paths and feeds each injected message to
 * the genuine `adoptSessionEvent()` — the same function the persistence layer
 * validates with. A control case pins the old failure mode, so the check cannot
 * quietly become vacuous if a refactor makes the validator unreachable.
 *
 * The message SOURCE bit us a second time, when DSH moved to session format v4.
 * The notice still carried the retired v3 wrapper
 *
 *     source: { kind: 'plugin', plugin: 'dsh-todo-board', form: 'notice' }
 *
 * and `dsh-session-format` refuses every NEWLY written v4 message whose source
 * kind is not producer-owned — "format v4 message requires a producer-owned
 * source kind" — which fails the whole turn. (Reading an old log is different:
 * the v3 -> v4 migration edge rewrites the wrapper on the way in.) The source
 * asserts below therefore pin `plugin:dsh-todo-board`, and note that
 * `adoptSessionEvent` does NOT validate sources — that check lives in the
 * persistence layer — so a source control built on it would pass vacuously.
 *
 *   node tools/check-session-format.mjs
 *
 * Requires the DSH install; skipped loudly if `dsh-session` is missing.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DSH = 'C:/Users/XIAO/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/'
const SESSION = process.env.DSHTB_SESSION ?? 'file:///' + DSH + 'dsh-session/lib/index.js'

let adoptSessionEvent
try {
  ;({ adoptSessionEvent } = await import(SESSION))
} catch (err) {
  console.log('SKIP  — dsh-session 不可解析（可用 DSHTB_SESSION 覆盖）:', err.message)
  process.exit(0)
}
if (typeof adoptSessionEvent !== 'function') {
  console.log('SKIP  — dsh-session 没有导出 adoptSessionEvent')
  process.exit(0)
}

const home = mkdtempSync(join(tmpdir(), 'dshtb-fmt-'))
process.env.DSH_HOME = home

const mod = await import('../lib/index.js')

const registered = { tool: null, routes: [], listeners: [] }
const DIR = 'D:\\fmt\\project'

/** Every message the plugin hands to an agent, tagged with the path it took. */
const injected = []
const record = (via) => (message) => injected.push({ via, message })

const liveAgent = {
  id: 'session-live',
  status: 'idle',
  options: { provider: 'p', model: 'm' },
  session: { header: { id: 'session-live', cwd: DIR } },
  followup: record('resume/followup'),
  steer: record('resume/steer'),
}
const createdAgent = {
  id: 'session-created',
  status: 'idle',
  followup: record('newSession/followup'),
  steer: record('newSession/steer'),
}

const agentsStub = {
  list: () => [liveAgent],
  get: (id) => (id === liveAgent.id ? liveAgent : undefined),
  async create() {
    return { agent: createdAgent, sessionId: createdAgent.id }
  },
}
const presetsStub = {
  async resolve() {
    return { id: 'standard' }
  },
  async mount() {},
}
// Enough of the attachment store for `admitImages`: it only calls saveImage.
const attachmentsStub = { async saveImage() { return { id: 'att-1' } } }
const webServer = { register: (route) => (registered.routes.push(route), () => {}) }

function makeCtx() {
  const ctx = {
    root: undefined,
    webServer,
    get(key) {
      if (key === 'tools') return { register: (d) => ((registered.tool = d), () => {}) }
      if (key === 'systemPrompt') return { section: () => () => {} }
      if (key === 'agents') return agentsStub
      if (key === 'agentPresets') return presetsStub
      if (key === 'attachments') return attachmentsStub
      if (key === 'webServer') return webServer
      return undefined
    },
    on(event, listener) {
      registered.listeners.push({ event, listener })
      return () => {}
    },
    effect(callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    inject(names, callback) {
      callback(ctx)
    },
    logger: { error() {}, warn() {}, info() {}, debug() {} },
  }
  return ctx
}

mod.apply(makeCtx())
const apiRoute = registered.routes.find((route) => route.path === '/dsh-todo-board/api')
assert.ok(apiRoute !== undefined, 'the api route is registered')

async function postJson(payload) {
  const box = { body: '' }
  const response = {
    writeHead() {},
    end(body) {
      box.body = body === undefined ? '' : String(body)
    },
  }
  const chunks = [Buffer.from(JSON.stringify(payload), 'utf8')]
  const request = {
    method: 'POST',
    // The trust fence refuses a request with no `Host`, so a browser-shaped
    // stub must carry one.
    headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
  await apiRoute.handler(request, response)
  return JSON.parse(box.body)
}

/** Create a row and dispatch it, returning the row. */
async function dispatchRow(fields) {
  const created = await postJson({ action: 'create', dir: DIR, ...fields })
  assert.equal(created.ok, true, 'the row is created: ' + JSON.stringify(created))
  const ran = await postJson({ action: 'run', id: created.todo.id, sessionId: liveAgent.id })
  assert.equal(ran.ok, true, 'the row dispatches: ' + JSON.stringify(ran))
  return created.todo
}

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

// ---- Drive every path that injects a message ------------------------------

await dispatchRow({ title: '续跑：普通', mode: 'resume' })
await dispatchRow({
  title: '续跑：带图',
  mode: 'resume',
  images: [{ mediaType: 'image/png', data: PNG, name: 'a.png' }],
})
await dispatchRow({ title: '新会话', mode: 'newSession' })

// The steer branch is chosen by target status, not by row shape.
liveAgent.status = 'running'
await dispatchRow({ title: '续跑：目标正忙', mode: 'resume' })
liveAgent.status = 'idle'

const vias = injected.map((entry) => entry.via).sort()
assert.deepEqual(
  vias,
  ['newSession/followup', 'resume/followup', 'resume/followup', 'resume/steer'],
  'all four injection paths were exercised: ' + JSON.stringify(vias),
)

// ---- Every injected message must satisfy the real validator ---------------

for (const { via, message } of injected) {
  assert.equal(message.role, 'user', via + ': role is user')
  assert.equal(typeof message.id, 'string', via + ': carries an id')
  assert.ok(message.id !== '', via + ': id is non-empty')
  // Session format v4 requires a PRODUCER-OWNED source kind. The old v3
  // wrapper (`{ kind: 'plugin', plugin: 'dsh-todo-board' }`) is retired: the
  // persistence layer refuses it outright with "format v4 message requires a
  // producer-owned source kind", which fails the turn that produced the notice.
  // The v3 -> v4 migration edge rewrites that wrapper when READING an old log,
  // but a newly written message must carry `plugin:<name>` from the start.
  assert.equal(
    message.source?.kind,
    'plugin:dsh-todo-board',
    via + ': carries a producer-owned source kind',
  )
  assert.equal(
    message.source?.plugin,
    undefined,
    via + ': carries no retired v3 plugin wrapper field',
  )
  assert.ok(Array.isArray(message.content), via + ': content is ContentBlock[]')

  // The real thing: the same validation the persistence layer runs on load.
  // `surfaceOp` is added by the harness's surface manager when it accepts the
  // message as an event (the durable event carries it), and it is validated
  // BEFORE content — so it must be present for this to test what we mean.
  const event = { type: 'user/message', seq: 1, surfaceOp: 'append', data: message }
  assert.doesNotThrow(
    () => adoptSessionEvent(event),
    via + ': passes the harness session validator',
  )
}

// ---- The row's images must ride along as blocks (they used to be dropped) --

const withImage = injected.find((entry) => entry.message.content.some((b) => b.type === 'image'))
assert.ok(withImage !== undefined, 'the image row injects an image block')
assert.ok(
  withImage.message.content[0].type === 'text' &&
    typeof withImage.message.content[0].text === 'string',
  'the image row still leads with its text block',
)
assert.equal(withImage.message.content.length, 2, 'one text block plus one image block')

// ---- Non-vacuous control: the bare-string content MUST be rejected --------
//
// The source here is the CURRENT producer-owned shape on purpose. The source
// kind is validated by the persistence layer (`dsh-session-format`), not by
// `adoptSessionEvent`, so leaving a retired wrapper here would only make the
// fixture look like a second, silent bug. With a valid source the rejection
// can only be about content.
//
// `surfaceOp` is present on purpose too: it is validated before content, so
// omitting it would make this pass for the wrong reason and stop guarding the
// bug it exists for.

assert.throws(
  () =>
    adoptSessionEvent({
      type: 'user/message',
      seq: 8,
      surfaceOp: 'append',
      data: {
        id: 'x',
        role: 'user',
        content: '【TODO 板 · 自动接续】…',
        source: { kind: 'plugin:dsh-todo-board', form: 'notice' },
      },
    }),
  /invalid content/,
  'the validator rejects a bare-string content — this is the shape that corrupted a session',
)

rmSync(home, { recursive: true, force: true })

console.log('format  OK — ' + injected.length + ' injected messages pass adoptSessionEvent')
console.log('        paths: ' + vias.join(', '))
console.log('        control: a string content is rejected (the old bug is still caught)')
console.log('\nall session-format checks passed')
