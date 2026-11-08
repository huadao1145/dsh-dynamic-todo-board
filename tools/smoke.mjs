/**
 * Host-half smoke test for dsh-todo-board.
 *
 * Loads lib/index.js against a stubbed Cordis context and a throwaway DSH_HOME,
 * then exercises apply(), the todo_board tool, the HTTP route, persistence, the
 * top-to-bottom ordering rule, scheduled execution and newSession binding.
 *
 *   node tools/smoke.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dshtb-smoke-'))
process.env.DSH_HOME = home

const mod = await import('../lib/index.js')

const registered = { tool: null, section: null, routes: [], listeners: [], effects: [], skill: null, command: null }

/**
 * What `ctx.get('connection')` finds — the harness' Host Connection gate.
 *
 * `undefined` models a deployment without `dsh-client-connection`, which is the
 * only case where the restated fence is the one in charge. The convergence
 * cases near the end of this file swap a stand-in in.
 */
let connectionService

const DIR = 'D:\\smoke\\project'
const agent = {
  id: 'session-smoke',
  // The handoff summary asks the model this session's own route; without one the
  // summary is skipped by design rather than guessed.
  options: { provider: 'stub-provider', model: 'stub-model' },
  session: { header: { id: 'session-smoke', cwd: DIR } },
  sent: [],
  followup(message) {
    this.sent.push(message)
  },
  steer(message) {
    this.sent.push(message)
  },
}
const exec = { agent }

/** Live agents the stub registry knows about: the origin session plus spawned ones. */
const live = new Map([[agent.id, agent]])
const spawnedAgents = []

function spawnStubAgent(id) {
  const spawned = {
    id,
    status: 'idle',
    session: { header: { id, cwd: DIR } },
    sent: [],
    followup(message) {
      this.sent.push(message)
    },
    steer(message) {
      this.sent.push(message)
    },
  }
  live.set(spawned.id, spawned)
  spawnedAgents.push(spawned)
  return spawned
}

const agentsStub = {
  list: () => [...live.values()],
  // The planning session is live too, so a handoff can look its own route up.
  get: (id) => (id === agent.id ? agent : live.get(id)),
  async create(options) {
    // The factory is handed the caller's session id; honour it like the real one.
    const spawned = spawnStubAgent(options.sessionId)
    if (typeof options.setup === 'function') await options.setup({})
    return { agent: spawned, dispose: async () => {} }
  },
}

const presetsStub = {
  async resolve() {
    return { id: 'standard' }
  },
  async mount() {
    return { id: 'standard' }
  },
}

/** Records which sessions the plugin files under a workspace directory. */
const attached = []
const workspaces = new Map()

/** In-memory stand-in for the durable attachment store. */
const savedImages = new Map()
let imageSeq = 0

const attachmentsStub = {
  async saveImage(input) {
    if (!(input.data instanceof Uint8Array) || input.data.length === 0) {
      throw new Error('image bytes are empty')
    }
    imageSeq += 1
    const ref = {
      attachmentId: 'att-' + imageSeq,
      mediaType: input.mediaType,
      bytes: input.data.length,
      width: 2,
      height: 3,
    }
    if (typeof input.name === 'string' && input.name !== '') ref.name = input.name
    savedImages.set(ref.attachmentId, input.data)
    return ref
  },
  async readImage(ref) {
    const data = savedImages.get(ref.attachmentId)
    if (data === undefined) throw new Error('unknown attachment ' + ref.attachmentId)
    return { ref, data }
  },
}

/** A 1x1 transparent PNG — enough for admission and a real byte round trip. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const workspaceStub = {
  async resolveByPath(path) {
    return workspaces.get(path)
  },
  async create(path) {
    const workspace = {
      id: 'ws-' + (workspaces.size + 1),
      path,
      async attachSession(sessionId) {
        attached.push({ workspaceId: this.id, path, sessionId })
      },
    }
    workspaces.set(path, workspace)
    return workspace
  },
}

/**
 * A faithful-enough stand-in for `ctx.logger`.
 *
 * It reproduces the two facts the plugin's log sink depends on: `exporter()`
 * registers a sink, and an exporter gates by ITS OWN `levels` map before the
 * logger's default — the rule at `cordis/src/logger.ts:155`. Modelling the
 * gate matters here, because getting it wrong is exactly how the built-in
 * buffer silently loses `warn` and `debug`.
 */
function makeLogger() {
  const exporters = []
  let sn = 0
  const LEVEL = { error: 0, info: 1, warn: 2, debug: 3 }
  const logger = {
    calls: [],
    exporter(exporter) {
      exporters.push(exporter)
      return () => {}
    },
    record(type, args) {
      logger.calls.push({ type, args })
      const level = LEVEL[type]
      for (const exporter of exporters) {
        const target = exporter.levels?.['dsh-todo-board'] ?? exporter.levels?.default ?? LEVEL.info
        if (target < level) continue
        sn += 1
        exporter.export({ sn, ts: Date.now(), type, level, name: 'dsh-todo-board', args })
      }
    },
  }
  for (const type of Object.keys(LEVEL)) logger[type] = (...args) => logger.record(type, args)
  return logger
}

const loggerStub = makeLogger()

function makeCtx() {
  // `inject(['webServer'], cb)` hands cb a context where the service is a
  // property, so the stub exposes it both ways.
  const webServer = {
    register(route) {
      registered.routes.push(route)
      return () => {}
    },
  }
  const ctx = {
    root: undefined,
    webServer,
    get(key) {
      if (key === 'tools') {
        return {
          register(definition) {
            registered.tool = definition
            return () => {}
          },
        }
      }
      if (key === 'systemPrompt') {
        return {
          section(section) {
            registered.section = section
            return () => {}
          },
        }
      }
      if (key === 'agents') return agentsStub
      if (key === 'llm') return registered.llm
      if (key === 'sessionQuery') return registered.sessionQuery
      if (key === 'agentPresets') return presetsStub
      if (key === 'attachments') return attachmentsStub
      if (key === 'workspaceRegistry') return workspaceStub
      if (key === 'webServer') return webServer
      if (key === 'connection') return connectionService
      if (key === 'skills') {
        return {
          register(skill) {
            registered.skill = skill
            return () => {}
          },
        }
      }
      if (key === 'commands') {
        return {
          register(command) {
            registered.command = command
            return () => {}
          },
        }
      }
      return undefined
    },
    on(event, listener) {
      registered.listeners.push({ event, listener })
      return () => {}
    },
    effect(callback, label) {
      registered.effects.push(label)
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    inject(names, callback) {
      callback(ctx)
    },
    logger: loggerStub,
  }
  return ctx
}

function fakeResponse() {
  const box = { status: 0, body: '' }
  return {
    box,
    writeHead(status) {
      box.status = status
    },
    end(body) {
      box.body = body === undefined ? '' : String(body)
    },
  }
}

/**
 * Headers every real browser sends. The route's trust fence refuses a request
 * with no `Host` (that is the DNS-rebinding check), so a stub that omits them
 * is not modelling the browser the panel actually runs in.
 */
const BROWSER_HEADERS = { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' }

/** Where the plugin keeps its durable log, beside the board file. */
function boardLogPath() {
  return join(home, 'todo-board', 'log.ndjson')
}

/** Local `YYYY-MM-DDTHH:mm`, the board's schedule format. */
function localStamp(ms) {
  const date = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return (
    date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    'T' + pad(date.getHours()) + ':' + pad(date.getMinutes())
  )
}

/**
 * Fire the turn-end hook and let the dispatch promise chain settle — dispatch
 * awaits the model-capability probe before it sends, so a synchronous call
 * would observe the message count before the message exists.
 */
async function turnStopping() {
  for (const entry of registered.listeners) {
    if (entry.event === 'agent/turn-stopping') entry.listener({ agent })
  }
  await settle()
}

/** Drain microtasks and timers the plugin scheduled with no delay. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

// ------------------------------------------------------------------ apply()

assert.equal(mod.name, 'dsh-todo-board')
mod.apply(makeCtx())

assert.equal(registered.tool?.name, 'todo_board', 'todo_board registered')
assert.equal(registered.tool.parameters.required[0], 'action')
assert.equal(registered.section?.name, 'todo-board', 'prompt section registered')
assert.equal(registered.section.order, 150)
assert.equal(registered.routes.length, 2, 'api and image routes')
assert.equal(registered.routes[0].path, '/dsh-todo-board/image')
assert.equal(registered.routes[1].path, '/dsh-todo-board/api')
const apiRoute = registered.routes[1]
const imageRoute = registered.routes[0]
assert.ok(
  registered.listeners.some((entry) => entry.event === 'agent/turn-stopping'),
  'turn-stopping listener registered',
)
assert.ok(existsSync(join(home, 'todo-board', 'board.json')), 'board file created on first load')
console.log('apply()  OK')

// -------------------------------------------------------- approval (the gate)
//
// The gate is what makes "the AI asks before it changes the board" a mechanism
// rather than a prompt convention, so its exact allowlist is asserted here:
// a read and the model's own checkbox pass, every other write asks — INCLUDING
// an action this version does not know, which must fail closed rather than slip
// through a forgotten `if`.

const gateEntry = registered.listeners.find((entry) => entry.event === 'tools/pre-execute')
assert.ok(gateEntry !== undefined, 'the tools/pre-execute gate is registered')

/** Run the gate over one model call; returns the decision or 'allow'. */
function gate(action, extra) {
  let allowed = false
  const decision = gateEntry.listener(
    { name: 'todo_board', arguments: action === undefined ? undefined : { action, ...extra } },
    () => {
      allowed = true
      return Promise.resolve({ kind: 'allow' })
    },
  )
  return allowed ? 'allow' : decision
}

// 0.13.4 moved `note` into the approval-free set. The two lists are asserted
// SEPARATELY on purpose: a single merged loop would let a future edit move an
// action between them without any test noticing.
for (const action of ['list', 'done', 'reopen', 'note']) {
  assert.equal(gate(action, { id: 'x', note: 'n' }), 'allow', action + ' is not gated')
}
for (const [action, extra] of [
  ['add', { title: 'AI 自建的一条', mode: 'resume' }],
  ['schedule', { id: 'x', schedule: '2030-01-01T00:00' }],
  ['update', { id: 'x' }],
  ['reorder', {}],
  ['dispatch', { id: 'x' }],
  ['something-new', {}],
]) {
  const decision = gate(action, extra)
  assert.equal(decision.kind, 'ask', action + ' asks before writing')
  assert.ok(
    typeof decision.reason === 'string' && decision.reason.includes('待办板'),
    action + ' carries a reason the approval dialog can show',
  )
}

// `schedule` stays gated even though `note` does not: a note is prose the user
// already owns, while a schedule makes the row run later with nobody watching.
// Two ways to say "please ask me first" would be one too many, so the
// distinction is pinned rather than left to the comment above.
assert.equal(gate('note', { id: 'x', note: 'n' }), 'allow', 'note stays approval-free')
assert.equal(
  gate('schedule', { id: 'x', schedule: '2030-01-01T00:00' }).kind,
  'ask',
  'but schedule is still gated — it is the one thing a note cannot do',
)
assert.ok(
  gate('add', { title: 'AI 自建的一条', mode: 'resume' }).reason.includes('resume') &&
    gate('add', { title: 'AI 自建的一条', mode: 'resume' }).reason.includes('自动派发'),
  'the add reason names the mode, so an auto-run row cannot be approved unnoticed',
)
// The dialog is where a person decides, so the reason has to carry the specific
// facts of THIS call — not just the action's name.
assert.ok(
  gate('update', { id: 'x', title: '新标题', mode: 'resume' }).reason.includes('模式 resume'),
  'the update reason lists the fields being changed',
)
assert.ok(
  gate('reorder', { ids: ['a', 'b'] }).reason.includes('2 条'),
  'the reorder reason says how many rows move',
)
assert.equal(gate(undefined, {}), 'allow', 'a malformed call defaults to list, exactly like the tool body')

// ---------------------------------------------------------------------------
// Auto-review compatibility pin (v0.13.2).
//
// `dsh-experimental-auto-review` is an LLM-backed gate that runs BEFORE ours on
// the same `tools/pre-execute` waterfall (`prepend: true`). It classifies a
// pending call by its ACTUAL EFFECTS and reads the tool description from the
// request header to do it. Two things must therefore stay true, and neither is
// enforced anywhere else:
//
//   1. `done` / `reopen` stay approval-free. Making them ask would break the
//      auto-continue loop under `approval: 'never'` — that is the whole reason
//      they are exempt. A future "adapter" must not quietly trade this away.
//   2. The description keeps stating what those two actions DO in effect
//      terms. That sentence is the only lever this plugin has over how the
//      reviewer classifies the call.
//
// This pins the contract, not the reviewer: it cannot promise the reviewer
// allows anything. See docs/report-auto-review-conflict.md.
for (const action of ['done', 'reopen']) {
  assert.equal(
    gate(action, { id: 'x' }),
    'allow',
    action + ' must stay approval-free even under an LLM review preset (the auto-continue loop depends on it)',
  )
}

const toolDescription = registered.tool.description
assert.ok(
  toolDescription.includes('done 只把该行标记为「AI 已完成」'),
  'the description states what done actually does (the reviewer classifies by effect)',
)
assert.ok(
  toolDescription.includes('不删除任何行'),
  'the description says the checkbox actions delete nothing (the reviewer needs the negative too)',
)
console.log('autorev OK')

// Another plugin's tools are none of our business: the gate must pass them on.
let passedOn = false
gateEntry.listener({ name: 'pwsh', arguments: { command: 'echo hi' } }, () => {
  passedOn = true
  return Promise.resolve({ kind: 'allow' })
})
assert.ok(passedOn, 'a foreign tool call goes straight to the next listener')
console.log('gate    OK')

// --------------------------------------------------------------- tool: add

const added = await registered.tool.execute(
  { action: 'add', title: '第二条', mode: 'resume' },
  exec,
)
assert.equal(added.todos.length, 1)
assert.equal(added.todos[0].title, '第二条')
assert.equal(added.todos[0].mode, 'resume')
assert.equal(added.todos[0].schedule, '', 'a plain add carries no schedule')
assert.equal(added.todos[0].aiDone, false)
assert.deepEqual(
  Object.keys(added.todos[0]).sort(),
  ['aiDone', 'dirLabel', 'id', 'imageCount', 'mode', 'parentId', 'schedule', 'state', 'title', 'verified'],
  'tool rows carry exactly the declared schema keys',
)
assert.equal(added.todos[0].state, 'pending', 'a brand-new row has never been dispatched')
const firstId = added.todos[0].id

await registered.tool.execute({ action: 'add', title: '第一条', mode: 'resume' }, exec)

// -------------------------------------------------------------- tool: list

const listed = await registered.tool.execute({ action: 'list' }, exec)
assert.equal(listed.todos.length, 2)
assert.equal(listed.todos[0].title, '第二条', 'appended rows keep insertion order first')
assert.ok(listed.message.includes('从上到下就是执行顺序'), 'list explains the order')

// ------------------------------------------------------ reorder via route

// The route reads the raw request stream, so drive it with an async iterable.
async function postJson(payload) {
  const response = fakeResponse()
  const chunks = [Buffer.from(JSON.stringify(payload), 'utf8')]
  const request = {
    method: 'POST',
    headers: BROWSER_HEADERS,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
  await apiRoute.handler(request, response)
  return JSON.parse(response.box.body)
}

const snapshot = await registered.tool.execute({ action: 'list' }, exec)
const ids = snapshot.todos.map((todo) => todo.id)
const reordered = await postJson({ action: 'reorder', ids: [ids[1], ids[0]] })
assert.equal(reordered.ok, true, 'reorder accepted')
assert.equal(reordered.count, 2)

const afterReorder = await registered.tool.execute({ action: 'list' }, exec)
assert.equal(afterReorder.todos[0].id, ids[1], 'top-to-bottom order persisted')
assert.equal(afterReorder.todos[1].id, ids[0])
console.log('order   OK')

// ------------------------------------------------------------ tool: done

const done = await registered.tool.execute({ action: 'done', id: firstId }, exec)
assert.equal(done.todos[0].aiDone, true)
assert.ok(done.message.includes('已标记 AI 完成'))

const notFound = await registered.tool.execute({ action: 'done', id: 'nope' }, exec)
assert.ok(notFound.message.includes('找不到'))

// -------------------------------------------------------- route: GET + patch

const getResponse = fakeResponse()
await apiRoute.handler({ method: 'GET', headers: BROWSER_HEADERS }, getResponse)
const snapshot2 = JSON.parse(getResponse.box.body)
assert.equal(snapshot2.ok, true)
assert.equal(snapshot2.todos.length, 2)
assert.ok(snapshot2.storagePath.endsWith('board.json'))
assert.ok(snapshot2.todos.every((todo) => typeof todo.order === 'number'))
assert.ok(snapshot2.todos.every((todo) => typeof todo.schedule === 'string'))
assert.ok(snapshot2.todos.every((todo) => typeof todo.dueAt === 'number'), 'panel rows expose dueAt')

const patched = await postJson({ action: 'patch', id: firstId, patch: { verified: true } })
assert.equal(patched.ok, true)
assert.equal(patched.todo.verified, true)

const bad = await postJson({ action: 'nonsense' })
assert.equal(bad.ok, false)
console.log('route   OK')

// ------------------------------------------------------------- persistence

const onDisk = JSON.parse(readFileSync(join(home, 'todo-board', 'board.json'), 'utf8'))
assert.equal(onDisk.todos.length, 2)
assert.equal(onDisk.todos[0].id, ids[1], 'disk order matches the reordered order')
assert.equal(onDisk.todos[0].order, 0)
assert.equal(onDisk.todos[1].order, 1)
console.log('persist OK')

// ---------------------------------------------------------------- schedule

// Created the way the panel creates it: bound to a session, so a scheduled
// `resume` row has somewhere to land when its time comes.
const startCount = agent.sent.length
const minuteStart = Math.floor(Date.now() / 60000) * 60000
const created = await postJson({
  action: 'create',
  title: '到点再干',
  mode: 'resume',
  dir: DIR,
  sessionId: agent.id,
  schedule: localStamp(minuteStart + 60000),
})
assert.equal(created.ok, true, 'create accepts a schedule')
const scheduledId = created.todo.id
assert.equal(created.todo.schedule, localStamp(minuteStart + 60000), 'a local stamp round-trips')
assert.equal(created.todo.dueAt, minuteStart + 60000, 'dueAt mirrors the stamp')
assert.equal(agent.sent.length, startCount, 'a future row does not fire on creation')

const rejected = await postJson({ action: 'create', title: '坏时间', dir: DIR, schedule: 'nonsense' })
assert.equal(rejected.ok, false, 'create refuses an unparseable schedule')

const byTool = await registered.tool.execute(
  { action: 'schedule', id: scheduledId, schedule: localStamp(minuteStart + 7200000) },
  exec,
)
assert.equal(byTool.todos[0].schedule, localStamp(minuteStart + 7200000), 'schedule action moves the time')
await registered.tool.execute({ action: 'schedule', id: scheduledId, schedule: '' }, exec)
assert.equal(
  (await registered.tool.execute({ action: 'list' }, exec)).todos.find((todo) => todo.id === scheduledId)
    .schedule,
  '',
  'an empty schedule clears the timer',
)
await registered.tool.execute({ action: 'schedule', id: scheduledId, schedule: 'not-a-date' }, exec)
assert.equal(
  (await registered.tool.execute({ action: 'list' }, exec)).todos.find((todo) => todo.id === scheduledId)
    .schedule,
  '',
  'an unparseable schedule never arms a wrong instant',
)

// A future time must hold the row back at turn end, even though it sits above
// every other pending row in this directory.
await registered.tool.execute(
  { action: 'schedule', id: scheduledId, schedule: localStamp(minuteStart + 7200000) },
  exec,
)
await registered.tool.execute({ action: 'done', id: ids[0] }, exec)
await registered.tool.execute({ action: 'done', id: ids[1] }, exec)
const gatedCount = agent.sent.length
await registered.tool.execute({ action: 'add', title: '没有定时的一条', mode: 'resume' }, exec)
const boardOrder = (await registered.tool.execute({ action: 'list' }, exec)).todos
assert.equal(
  boardOrder.findIndex((todo) => todo.id === scheduledId) <
    boardOrder.findIndex((todo) => todo.title === '没有定时的一条'),
  true,
  'the future row really is the topmost pending row',
)
await turnStopping()
assert.equal(agent.sent.length, gatedCount + 1, 'turn end dispatches the next todo that is actually due')
assert.ok(
  agent.sent[gatedCount].content[0].text.includes('没有定时的一条'),
  'turn end steps over the not-yet-due row instead of running it',
)
assert.equal(
  (await registered.tool.execute({ action: 'list' }, exec)).todos.find((todo) => todo.id === scheduledId)
    .schedule,
  localStamp(minuteStart + 7200000),
  'the future row keeps its schedule',
)

// Moving the time into the past re-arms the timer, which dispatches the row and
// records it so nothing can fire twice.
await registered.tool.execute({ action: 'schedule', id: scheduledId, schedule: localStamp(minuteStart) }, exec)
assert.equal(agent.sent.length, gatedCount + 2, 'a due todo dispatches through the timer')
assert.ok(
  agent.sent[gatedCount + 1].content[0].text.includes('到点再干'),
  'the dispatched prompt carries the todo title',
)
assert.equal(
  JSON.parse(readFileSync(join(home, 'todo-board', 'board.json'), 'utf8')).todos.find(
    (todo) => todo.id === scheduledId,
  ).dispatchedAt > 0,
  true,
  'dispatch is persisted, so it can never fire twice',
)
console.log('schedule OK')

// ------------------------------------------------------- newSession binding

// The first run opens a session and binds it; the second run must reuse that
// binding instead of opening yet another session.
const spawnedTodo = await postJson({
  action: 'create',
  title: '新会话只开一次',
  mode: 'newSession',
  dir: DIR,
  sessionId: agent.id,
})
assert.equal(spawnedTodo.ok, true)
const boundId = spawnedTodo.todo.id
const firstRun = await postJson({ action: 'run', id: boundId, sessionId: agent.id })
assert.equal(firstRun.ok, true, 'the first run opens a session')
assert.equal(firstRun.target, 'new-session')
assert.equal(spawnedAgents.length, 1, 'exactly one session was created')
assert.equal(firstRun.sessionId, spawnedAgents[0].id)
assert.equal(spawnedAgents[0].sent.length, 1, 'the created session received the task')
assert.equal(attached.length, 1, 'the created session is filed under a workspace')
assert.equal(attached[0].sessionId, spawnedAgents[0].id)
assert.equal(attached[0].path, DIR, 'the workspace is the todo directory')

const snapshotResponse = fakeResponse()
await apiRoute.handler({ method: 'GET', headers: BROWSER_HEADERS }, snapshotResponse)
const panelRow = JSON.parse(snapshotResponse.box.body).todos.find((todo) => todo.id === boundId)
assert.equal(panelRow.runSessionId, spawnedAgents[0].id, 'the created session is bound on the row')
// v0.13.1: ownership follows the run, not the planner. The spawned session's
// panel must see this container as its own row — before the fix `plain()` used
// `effectiveTarget`, which walks to the planning session for a row whose
// `runIn` points at anything but a 'session', hiding the row from the very
// session it spawned.
assert.equal(
  panelRow.ownerSessionId,
  spawnedAgents[0].id,
  'a spawned container is OWNED by the session it opened (the panel groups by owner)',
)

const secondRun = await postJson({ action: 'run', id: boundId, sessionId: agent.id })
assert.equal(secondRun.ok, true, 'the second run succeeds')
assert.equal(secondRun.target, 'session', 'the second run reuses the binding')
assert.equal(secondRun.sessionId, spawnedAgents[0].id)
assert.equal(spawnedAgents.length, 1, 'no second session is created')
assert.equal(spawnedAgents[0].sent.length, 2, 'the bound session got the task again')

// Unbinding is what re-enables opening a fresh session.
const unbound = await postJson({ action: 'patch', id: boundId, patch: { runSessionId: '' } })
assert.equal(unbound.ok, true)
assert.equal(unbound.todo.runSessionId, '', 'the panel can drop the binding')
const thirdRun = await postJson({ action: 'run', id: boundId, sessionId: agent.id })
assert.equal(thirdRun.target, 'new-session', 'after unbinding a new session is opened again')
assert.equal(spawnedAgents.length, 2, 'unbinding really allows a second session')
console.log('binding OK')

// ------------------------------------------------------------------- images

// One todo carries images: they are admitted through the attachment store,
// persisted as durable refs, rendered by the plugin's own byte route, and sent
// to the model as real image blocks.
const withImage = await postJson({
  action: 'create',
  title: '看图干活',
  mode: 'resume',
  dir: DIR,
  sessionId: agent.id,
  images: [{ data: PNG_BASE64, mediaType: 'image/png', name: 'shot.png' }],
})
assert.equal(withImage.ok, true, 'create accepts an image')
const imageId = withImage.todo.id
assert.equal(withImage.todo.images.length, 1, 'the image reference is stored on the row')
const ref = withImage.todo.images[0]
assert.equal(ref.mediaType, 'image/png')
assert.equal(ref.name, 'shot.png')
assert.ok(ref.bytes > 0 && ref.width > 0 && ref.height > 0, 'the ref carries normalized metadata')

const refused = await postJson({
  action: 'create',
  title: '非法图片',
  dir: DIR,
  images: [{ data: PNG_BASE64, mediaType: 'image/tiff' }],
})
assert.equal(refused.ok, false, 'an unsupported media type is refused')
assert.ok(refused.error.includes('不支持的图片格式'), 'the refusal names the reason')

const tooMany = await postJson({
  action: 'create',
  title: '太多图片',
  dir: DIR,
  images: new Array(5).fill({ data: PNG_BASE64, mediaType: 'image/png' }),
})
assert.equal(tooMany.ok, false, 'more images than the cap is refused')

// The plugin's own route serves the bytes, and only for a referenced id.
const imageResponse = {
  status: 0,
  headers: {},
  body: null,
  writeHead(status, headers) {
    this.status = status
    this.headers = headers === undefined ? {} : headers
  },
  end(body) {
    this.body = body
  },
}
await imageRoute.handler(
  { method: 'GET', url: '/dsh-todo-board/image?id=' + ref.attachmentId, headers: BROWSER_HEADERS },
  imageResponse,
)
assert.equal(imageResponse.status, 200, 'a referenced attachment is served')
assert.equal(imageResponse.headers['content-type'], 'image/png')
assert.ok(Buffer.from(imageResponse.body).length > 0, 'the served bytes are non-empty')

const missingResponse = {
  status: 0,
  writeHead(status) {
    this.status = status
  },
  end() {},
}
await imageRoute.handler(
  { method: 'GET', url: '/dsh-todo-board/image?id=att-nope', headers: BROWSER_HEADERS },
  missingResponse,
)
assert.equal(missingResponse.status, 404, 'an unreferenced id is not readable')

// Dispatch turns the attached image into a real image block.
const beforeImageRun = agent.sent.length
await postJson({ action: 'run', id: imageId, sessionId: agent.id })
assert.equal(agent.sent.length, beforeImageRun + 1, 'the todo dispatched')
const sentContent = agent.sent[beforeImageRun].content
assert.equal(sentContent[0].type, 'text')
assert.ok(sentContent[0].text.includes('附带的 1 张图片'), 'the prompt announces the images')
const imageBlocks = sentContent.filter((block) => block.type === 'image')
assert.equal(imageBlocks.length, 1, 'the message carries one image block')
assert.deepEqual(imageBlocks[0].attachment, ref, 'the block is the durable reference itself')

// Dropping the image leaves a text-only todo, and the list reports the count.
const cleared = await postJson({ action: 'patch', id: imageId, patch: { clearImages: true } })
assert.equal(cleared.todo.images.length, 0, 'images can be dropped again')
const listedWithCount = await registered.tool.execute({ action: 'list' }, exec)
assert.equal(
  listedWithCount.todos.every((todo) => typeof todo.imageCount === 'number'),
  true,
  'tool rows report imageCount',
)
console.log('images  OK')

// ------------------------------------------------------------ row lifecycle
//
// The state a row reports is derived from the live session list, and a row whose
// target session is gone must stay *pending* rather than being stamped as
// dispatched — otherwise the scheduler and the turn-end hook both skip it and it
// silently never runs again.

const orphan = await postJson({
  action: 'create',
  title: '目标会话已经没了',
  mode: 'resume',
  dir: DIR,
  sessionId: 'session-that-is-gone',
})
assert.equal(orphan.ok, true)
assert.equal(orphan.todo.state, 'pending', 'a fresh row starts out undispatched')
const orphanId = orphan.todo.id

const orphanRun = await postJson({ action: 'run', id: orphanId, sessionId: '' })
assert.equal(orphanRun.ok, false, 'dispatching to a dead session fails')
assert.equal(orphanRun.lost, true, 'and says the row is stranded')

/** The panel's own view of one row, straight from the GET route. */
async function readRow(id) {
  const response = fakeResponse()
  await apiRoute.handler({ method: 'GET', headers: BROWSER_HEADERS }, response)
  return JSON.parse(response.box.body).todos.find((todo) => todo.id === id)
}

const afterLoss = await readRow(orphanId)
assert.equal(afterLoss.state, 'lost', 'the row reports 目标会话丢失')
assert.equal(afterLoss.targetAlive, false, 'the panel can see the target is gone')
assert.equal(afterLoss.lostKind, 'no-session', 'and says which kind of failure parked it')
assert.equal(
  afterLoss.dispatchedAt,
  0,
  'a failed dispatch must NOT stamp dispatchedAt, or the row is retired for good',
)
assert.ok(afterLoss.lostAt > 0, 'the failure is recorded instead')

// A fresh lost row waits out its first backoff, so the scheduler does not spin.
const orphanList = await registered.tool.execute({ action: 'list', all: true }, exec)
const orphanRow = orphanList.todos.find((todo) => todo.id === orphanId)
assert.equal(orphanRow.state, 'lost', 'the tool reports the same state')
assert.ok(orphanList.message.includes('目标会话丢失'), 'and names it in the readout')

// v0.13.1: ownership follows the run. A resume row planned against a session
// that has since died, then handed by hand to a live one, must be OWNED by the
// session it runs on — the panel groups by owner, and reporting the dead
// planning session parks the row under a box nobody can act on. (The binding
// assert earlier in this file covers the newSession twin of this.)
const rerouted = await postJson({
  action: 'create',
  title: '改派到别的会话',
  mode: 'resume',
  dir: DIR,
  sessionId: 'session-that-is-gone',
})
assert.equal(rerouted.ok, true)
const reroutedRun = await postJson({ action: 'run', id: rerouted.todo.id, sessionId: agent.id })
assert.equal(reroutedRun.ok, true, 'an explicit destination rescues the row')
assert.equal(
  (await readRow(rerouted.todo.id)).ownerSessionId,
  agent.id,
  'a dispatched resume row is OWNED by the session it was handed to, not the dead one it was planned against',
)

// Re-targeting the row clears the verdict: it is queue-eligible again.
const rescued = await postJson({ action: 'patch', id: orphanId, patch: { mode: 'newSession' } })
assert.equal(rescued.ok, true)
assert.equal(rescued.todo.state, 'pending', 'changing the mode clears the lost marker')
assert.equal(rescued.todo.lostAt, 0)
assert.equal(rescued.todo.lostKind, '', 'and clears the recorded failure kind')

// An image the target model refuses parks the row too, but with its own kind —
// the panel must not report a missing session when the session is fine.
const pngRef = (await readRow(imageId)) !== undefined
assert.equal(pngRef, true, 'the image row from the earlier section still exists')
const textOnly = await postJson({
  action: 'create',
  title: '模型看不了这张图',
  mode: 'resume',
  dir: DIR,
  sessionId: agent.id,
  images: [{ data: PNG_BASE64, mediaType: 'image/png' }],
})
assert.equal(textOnly.ok, true, 'the row with an image is created')

// A live but idle target reads as 已派发; a running one reads as 进行中. After the
// rebinding test above, `boundId` is owned by the second spawned session.
await postJson({ action: 'run', id: orphanId, sessionId: agent.id })
const dispatchedRow = await readRow(orphanId)
assert.ok(dispatchedRow.dispatchedAt > 0, 'a successful dispatch stamps the row')
assert.equal(dispatchedRow.targetAlive, true, 'its target session is live')
assert.equal(dispatchedRow.state, 'dispatched', 'a live but idle target reads as 已派发')

const runOwnerId = (await readRow(boundId)).runSessionId
const runOwner = live.get(runOwnerId)
assert.ok(runOwner !== undefined, 'the row is bound to a session the registry knows')
runOwner.status = 'running'
assert.equal((await readRow(boundId)).state, 'running', 'a running target reads as 进行中')
runOwner.status = 'idle'
assert.equal((await readRow(boundId)).state, 'dispatched', 'and falls back to 已派发 when it stops')
console.log('state   OK')

// -- a stranded row neither spins nor blocks the queue ---------------------
//
// Leaving a failed row unstamped is what stops it being retired for good, but it
// also leaves the row queue-eligible. Two things must therefore hold: the
// automatic paths must not re-attempt it on every tick, and it must not sit at
// the top of the queue holding up the rows behind it.

// Clear the deck first: this section asserts on *which* row turn end picks, so
// it must not depend on whatever earlier sections left pending.
for (const leftover of (await registered.tool.execute({ action: 'list', all: true }, exec)).todos) {
  if (!leftover.verified) await registered.tool.execute({ action: 'done', id: leftover.id }, exec)
}

const stranded = await postJson({
  action: 'create',
  title: '卡住的那条',
  mode: 'resume',
  dir: DIR,
  sessionId: 'session-long-gone',
})
const strandedId = stranded.todo.id
await postJson({ action: 'run', id: strandedId, sessionId: '' })
assert.equal((await readRow(strandedId)).state, 'lost', 'the row is stranded')

// A healthy row created after it sits *below* it in the queue.
const healthy = await postJson({
  action: 'create',
  title: '后面那条能跑的',
  mode: 'resume',
  dir: DIR,
  sessionId: agent.id,
})
assert.equal(healthy.ok, true, 'the healthy row is created')
const healthyId = healthy.todo.id

const beforeQueue = agent.sent.length
await turnStopping()
assert.equal(
  agent.sent.length,
  beforeQueue + 1,
  'exactly one row is dispatched — the queue is not blocked and not double-sent',
)
assert.ok(
  agent.sent[beforeQueue].content[0].text.includes('后面那条能跑的'),
  'and it is the healthy row below that ran, not the stranded one',
)
assert.equal((await readRow(strandedId)).state, 'lost', 'the stranded row is still stranded')
assert.equal((await readRow(healthyId)).state, 'dispatched', 'the healthy row was handed over')

// The backoff holds: further turn ends must not re-attempt it immediately.
await turnStopping()
await turnStopping()
const strandedAfter = await readRow(strandedId)
assert.equal(strandedAfter.lostAttempts, 1, 'the retry backoff suppressed immediate re-attempts')
assert.ok(
  Date.now() - strandedAfter.lostAt < 60000,
  'and its next automatic attempt is a minute away, not a tick away',
)
console.log('stranded OK')

// ------------------------------------------------------------ request trust
//
// The route is outside the harness' `/api` channel, so the harness' own fence
// does not cover it and this plugin restates the rule. These cases are the
// regression test for that: without them a later refactor can drop the fence
// and every other check in this file still passes.

async function readStatus(route, request) {
  const response = fakeResponse()
  await route.handler(request, response)
  return response.box.status
}

assert.equal(
  await readStatus(apiRoute, { method: 'GET', headers: { host: '127.0.0.1:3080' } }),
  200,
  'loopback Host is served',
)
assert.equal(
  await readStatus(apiRoute, { method: 'GET', headers: { host: 'localhost:3080' } }),
  200,
  'localhost is loopback too',
)
assert.equal(
  await readStatus(apiRoute, { method: 'GET', headers: { host: '127.0.0.2:3080' } }),
  200,
  'the whole 127/8 block counts as loopback',
)
assert.equal(
  await readStatus(apiRoute, { method: 'GET' }),
  403,
  'a request with no Host is refused — over plain HTTP a browser sends no Origin on reads, so Host is the one header rebinding cannot forge',
)
assert.equal(
  await readStatus(apiRoute, { method: 'GET', headers: { host: 'evil.example:3080' } }),
  403,
  'a rebound attacker domain is refused',
)

// -- refusals are aggregated per host, not capped per process ---------------
//
// The old rule logged the first 20 refusals and then went quiet. That assumed
// the noise came from twenty DIFFERENT requests; what actually happens is that
// one caller (the plugin market) probes every local route on a loop, so each
// process start produced twenty identical lines that buried everything else.
//
// The fix keys on the requesting host: the first refusal from a host is logged
// in full, repeats only bump a counter. Asserted by counting the warning lines
// the logger actually received, because "it returned 403 either way" cannot
// tell the two designs apart.
{
  const refusalWarns = () =>
    loggerStub.calls.filter(
      (call) => call.type === 'warn' && String(call.args[0]).includes('拒绝了未通过信任校验的请求'),
    ).length
  const before = refusalWarns()
  for (let i = 0; i < 5; i += 1) {
    assert.equal(
      await readStatus(apiRoute, { method: 'GET', headers: { host: 'market.example:3080' } }),
      403,
      'an untrusted host is refused every time',
    )
  }
  assert.equal(
    refusalWarns() - before,
    1,
    'but five refusals from ONE host produce ONE warning, not five',
  )

  // A different host is still news — aggregation must not swallow new callers.
  const afterFirst = refusalWarns()
  assert.equal(
    await readStatus(apiRoute, { method: 'GET', headers: { host: 'another.example:3080' } }),
    403,
    'a second untrusted host is refused too',
  )
  assert.equal(refusalWarns() - afterFirst, 1, 'and a NEW host gets its own first warning')
}
assert.equal(
  await readStatus(apiRoute, {
    method: 'GET',
    headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' },
  }),
  403,
  'a cross-site fetch is refused even on a loopback Host',
)
assert.equal(
  await readStatus(apiRoute, {
    method: 'GET',
    headers: { host: '127.0.0.1:3080', origin: 'http://evil.example' },
  }),
  403,
  'a foreign Origin is refused',
)
assert.equal(
  await readStatus(apiRoute, {
    method: 'GET',
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
  }),
  200,
  'a same-origin browser request is served',
)
assert.equal(
  await readStatus(imageRoute, { method: 'GET', url: '/dsh-todo-board/image?id=x' }),
  403,
  'the image route carries the same fence',
)

// The POST body is JSON, but a cross-site form/fetch can post `text/plain`
// without a CORS preflight — which is exactly why the fence, not the
// content-type, has to be what stops it.
const crossSitePost = fakeResponse()
await apiRoute.handler(
  {
    method: 'POST',
    headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ action: 'clearVerified' }), 'utf8')
    },
  },
  crossSitePost,
)
assert.equal(crossSitePost.box.status, 403, 'a preflight-free cross-site POST cannot mutate the board')
console.log('trust   OK')

// --------------------------------------------------------- channel convergence
//
// Every assertion above runs WITHOUT a `connection` service, so they double as
// the fallback's regression test: a deployment that has no
// `dsh-client-connection` still gets the restated fence. What they cannot show
// is the branch that matters in this one — the harness' own gate (Host/Origin
// AND browser authentication) deciding instead, which is the half that stops a
// local process from writing the board behind the approval gate's back.

connectionService = undefined
assert.equal(
  await readStatus(apiRoute, { method: 'GET', headers: { host: '127.0.0.1:3080' } }),
  200,
  'the fallback fence serves when no connection service exists',
)

const gateSaw = []
connectionService = {
  requestRejection(request) {
    gateSaw.push(request.headers?.host ?? '')
    return 401
  },
}
assert.equal(
  await readStatus(apiRoute, { method: 'GET', headers: { host: '127.0.0.1:3080' } }),
  401,
  'a request the local fence would allow is refused once the harness gate decides',
)
assert.equal(gateSaw.length, 1, 'the harness gate is the one that was asked')
assert.equal(gateSaw[0], '127.0.0.1:3080', 'and it saw the real request')

connectionService = { requestRejection: () => undefined }
assert.equal(
  await readStatus(apiRoute, { method: 'GET', headers: { host: '127.0.0.1:3080' } }),
  200,
  'a gate that allows still serves — this is the branch the panel lives on',
)
assert.equal(
  await readStatus(apiRoute, { method: 'GET', headers: { host: 'evil.example' } }),
  200,
  'the harness gate is trusted wholesale: we do not re-judge its verdict',
)

// A gate that throws must refuse, not take the route down with it.
connectionService = {
  requestRejection() {
    throw new Error('gate exploded')
  },
}
assert.equal(
  await readStatus(apiRoute, { method: 'GET', headers: { host: '127.0.0.1:3080' } }),
  403,
  'a throwing gate fails closed',
)

// Back to the default: later sections drive the routes expecting the fallback,
// and a stand-in gate left installed would answer all of them.
connectionService = undefined
assert.equal(
  await readStatus(apiRoute, { method: 'GET', headers: { host: '127.0.0.1:3080' } }),
  200,
  'withdrawing the service restores the restated fence',
)
console.log('conn    OK')

// ------------------------------------------------------------------- logs
//
// The log view is a developer surface, so its two load-bearing rules get
// asserted directly rather than through the panel: nothing leaves the host
// while the view is closed, and stored lines are redacted.

const plainSnapshot = JSON.parse(
  (await (async () => {
    const response = fakeResponse()
    await apiRoute.handler({ method: 'GET', headers: BROWSER_HEADERS }, response)
    return response.box.body
  })()),
)
assert.equal(plainSnapshot.logs, undefined, 'the idle poll ships no log content')
assert.ok(plainSnapshot.logAlert !== undefined, 'but it does ship the alert cursor the button dot needs')
assert.equal(typeof plainSnapshot.logAlert.sn, 'number')

// A dispatch failure is the case the whole feature exists for: it must leave a
// record, because the row only keeps a one-line reason.
const logged = await (async () => {
  const response = fakeResponse()
  await apiRoute.handler(
    { method: 'GET', url: '/dsh-todo-board/api?logs=1&since=0', headers: BROWSER_HEADERS },
    response,
  )
  return JSON.parse(response.box.body)
})()
assert.ok(logged.logs !== undefined, 'the log view can ask for records')
assert.ok(Array.isArray(logged.logs.lines), 'and gets a list')
assert.ok(logged.logs.lines.length > 0, 'the stranded-dispatch failures above were recorded')
assert.ok(
  logged.logs.lines.some((line) => line.detail.includes('派发失败')),
  'a parked dispatch is among them — the row alone would not say why',
)
assert.ok(
  logged.logs.lines.every((line) => typeof line.level === 'string' && typeof line.detail === 'string'),
  'every record carries a level and a detail',
)
assert.ok(
  logged.logs.lines.every((line) => line.detail.length <= 4000),
  'no single record can be unbounded',
)
assert.equal(logged.logs.fileOff, false, 'the log file was writable in this run')
assert.ok(existsSync(logged.logs.file), 'and records reached the durable file')
const savedLines = readFileSync(logged.logs.file, 'utf8').trim().split('\n')
assert.ok(savedLines.length > 0, 'the file is NDJSON with content')
assert.ok(
  savedLines.every((line) => {
    try {
      JSON.parse(line)
      return true
    } catch (err) {
      return false
    }
  }),
  'every file line is independently parseable — one record cannot forge another',
)

// The cursor is a real filter, so a poll does not resend what the panel has.
const cursorProbe = await (async () => {
  const response = fakeResponse()
  await apiRoute.handler(
    {
      method: 'GET',
      url: '/dsh-todo-board/api?logs=1&since=' + logged.logs.cursor,
      headers: BROWSER_HEADERS,
    },
    response,
  )
  return JSON.parse(response.box.body)
})()
assert.equal(cursorProbe.logs.lines.length, 0, 'asking from the newest cursor returns nothing new')

// ------------------------------------------------------- redaction (承重)
//
// Redaction is a bearing structure, not hardening (see
// `docs/design-log-view.md` §3.2, which reproduced four leak paths). It has to
// run on every record's write path, so these drive it through the real sink —
// a unit test on a helper would not prove the sink calls it.
//
// The rule the spike established: a leaked key never arrives from a careless
// `logger.warn(secret)`; it arrives inside a message someone ELSE composed,
// usually an `Error.message` from config validation. So the payloads below are
// shaped like those, not like a deliberate secret dump.

const SECRETS = {
  openai: 'sk-live-REALKEY0123456789abcdef',
  context7: 'ctx7sk-297eea2b-b489-4b3e-b92d-20cb6d5f4bc4',
  github: 'ghp_ABCdef0123456789ABCdef0123456789',
  npm: 'npm_ABCdef0123456789ABCdef0123456789',
}

// Shape 1: `dsh-mcp-client`'s Config is a `z.union`, and schemastery
// JSON.stringifies the WHOLE received value when a union fails — every env
// token and Authorization header in one message. This shape has a live instance
// on this machine.
loggerStub.error(
  new Error(
    'expected {…} | {…} but got {"transport":"bogus","serverName":"github",' +
      '"headers":{"Authorization":"Bearer ' + SECRETS.openai + '"},' +
      '"env":{"GH_TOKEN":"' + SECRETS.openai + '"}}',
  ),
)
// Shape 2: a scalar config value echoed back under its own key.
loggerStub.warn(new Error('$.apiKey expected string but got ' + SECRETS.openai))
// Shape 3: `credentialRef()` echoes its ARGUMENT, which is whatever the user
// pasted — no `sk-` prefix guaranteed, which is why a prefix rule alone fails.
loggerStub.error(
  new Error('credential ref "' + SECRETS.context7 + '" must match /^[A-Za-z_][A-Za-z0-9_]*$/'),
)
// Shape 4: a non-Error `cause` is delivered as its OWN record (verified), so
// redaction must be applied per record rather than once to the thrown error.
loggerStub.error(new Error('wrapper failed', { cause: { apiKey: SECRETS.openai } }))
// Shape 5: log injection — a newline in a payload must not forge a record.
loggerStub.warn('benign prefix\n{"level":"error","detail":"forged"}\u0000\u0007')
// Shape 6: a bare secret in prose. Isolates the PREFIX rule: nothing here is
// under a secret-looking key or behind `Bearer`, so only `sk-…` can catch it.
// Asserted separately because overlapping rules mask each other's markers — in
// the shapes above, `sk-…` is first rewritten and then folded into `Bearer ***`.
loggerStub.warn('upstream said the token is stale: ' + SECRETS.openai)

const secretProbe = await (async () => {
  const response = fakeResponse()
  await apiRoute.handler(
    { method: 'GET', url: '/dsh-todo-board/api?logs=1&since=0', headers: BROWSER_HEADERS },
    response,
  )
  return JSON.parse(response.box.body).logs.lines
})()

const rawFile = readFileSync(boardLogPath(), 'utf8')
for (const [name, value] of Object.entries(SECRETS)) {
  assert.ok(
    !secretProbe.some((line) => line.detail.includes(value)),
    'no record served to the panel contains the ' + name + ' secret',
  )
  assert.ok(!rawFile.includes(value), 'and the on-disk log does not contain the ' + name + ' secret either')
}
assert.ok(
  secretProbe.some((line) => line.detail.includes('stale: sk-***')),
  'a bare secret in prose is masked by the prefix rule',
)
assert.ok(
  secretProbe.some((line) => line.detail.includes('"Authorization":"***"')),
  'an Authorization header is masked',
)
// The bearer rule on its own, with no secret-looking key in front of it.
loggerStub.warn('the api wants bearer ' + SECRETS.openai)
const bearerProbe = await (async () => {
  const response = fakeResponse()
  await apiRoute.handler(
    { method: 'GET', url: '/dsh-todo-board/api?logs=1&since=0', headers: BROWSER_HEADERS },
    response,
  )
  return JSON.parse(response.box.body).logs.lines
})()
assert.ok(
  bearerProbe.some((line) => line.detail.includes('Bearer ***')),
  'a bearer token with no key in front is masked by the bearer rule',
)
// Rules overlap on purpose, so assert the invariant that matters — the secret
// is gone — rather than each rule's exact wording.
assert.ok(
  bearerProbe.every((line) => !line.detail.includes(SECRETS.openai)),
  'no rule ordering leaves the secret behind',
)
assert.ok(
  secretProbe.some((line) => line.detail.includes('credential ref "***"')),
  'the value-position rule covers the no-prefix key that a prefix rule cannot (ctx7sk-…)',
)
assert.ok(
  secretProbe.some((line) => line.detail.includes('"GH_TOKEN":"***"')),
  'a JSON dump keeps its structure while the secret under the key is masked',
)
assert.ok(
  secretProbe.every((line) => !line.detail.includes('\u0000')),
  'control characters are stripped, so a payload cannot corrupt the view',
)
// Log injection is about the FILE, not the detail text: a newline inside a
// payload is fine (stacks need them) as long as it cannot terminate the NDJSON
// record. Read the file fresh — the earlier `savedLines` predates these writes.
const injectionLines = readFileSync(boardLogPath(), 'utf8').trim().split('\n')
assert.equal(
  injectionLines.filter((line) => line.includes('forged')).length,
  1,
  'a newline inside a payload did not forge a second record',
)
assert.ok(
  injectionLines.every((line) => {
    try {
      JSON.parse(line)
      return true
    } catch (err) {
      return false
    }
  }),
  'every file line still parses after an injection attempt',
)

// An `Error` first argument must keep its stack: a diagnostic log without one
// loses half its value, and `String(err)` would flatten it to `Error: msg`.
loggerStub.error(new Error('stack please'))
const stackProbe = await (async () => {
  const response = fakeResponse()
  await apiRoute.handler(
    { method: 'GET', url: '/dsh-todo-board/api?logs=1&since=0', headers: BROWSER_HEADERS },
    response,
  )
  return JSON.parse(response.box.body).logs.lines
})()
assert.ok(
  stackProbe.some((line) => line.detail.includes('stack please') && line.detail.includes('at ')),
  'an Error argument is rendered with its stack, not as "Error: msg"',
)

// Placeholders are RAW in `Message.args` (verified), so the sink must format
// them itself; otherwise `logger.warn('code=%s', v)` stores a literal `%s`.
loggerStub.warn('placeholder %s and %d and %o', 'ABC', 42, { k: 1 })
const formatProbe = await (async () => {
  const response = fakeResponse()
  await apiRoute.handler(
    { method: 'GET', url: '/dsh-todo-board/api?logs=1&since=0', headers: BROWSER_HEADERS },
    response,
  )
  return JSON.parse(response.box.body).logs.lines
})()
assert.ok(
  formatProbe.some((line) => line.detail.includes('placeholder ABC and 42 and {"k":1}')),
  'placeholders are resolved by our own formatter',
)
assert.ok(
  !formatProbe.some((line) => line.detail.includes('%s and')),
  'and no unparsed placeholder is left behind',
)
console.log('redact  OK')

// ------------------------------------------------- tool: model-side actions
//
// `update` / `reorder` / `dispatch` close the gap the panel used to own alone:
// the model could create a row but not edit, order, or start one. All three are
// writes, so all three sit behind the approval gate (asserted above), and all
// three reuse the panel's own code (`reorderTodos`, `runTodo` → `dispatch`), so
// what is asserted here is the CONTRACT: what the model may say, what it is
// refused, and that a refusal changes nothing at all.

const ACTIONS_DIR = 'D:\\smoke\\actions'

for (const title of ['动作 A', '动作 B', '动作 C']) {
  await registered.tool.execute({ action: 'add', title, dir: ACTIONS_DIR, mode: 'resume' }, exec)
}
const actionRows = async () =>
  (await registered.tool.execute({ action: 'list', dir: ACTIONS_DIR }, exec)).todos

const seeded = await actionRows()
assert.equal(seeded.length, 3, 'three rows seeded in their own directory')
const [idA, idB, idC] = seeded.map((row) => row.id)

// -- update: the four editable fields, and nothing half-applied ---------------

const renamed = await registered.tool.execute(
  { action: 'update', id: idA, title: '动作 A（改）', mode: 'newSession', note: '改过的备注' },
  exec,
)
assert.ok(renamed.message.includes('已更新'), 'update reports what it did: ' + renamed.message)
assert.equal(renamed.todos[0].title, '动作 A（改）')
assert.equal(renamed.todos[0].mode, 'newSession', 'the mode moved')
assert.equal(renamed.todos[0].schedule, '', 'update does not silently touch the schedule')

// A bad field refuses the WHOLE request: half-applying would leave both the
// model and the user who approved it unable to say what actually changed.
const badMode = await registered.tool.execute(
  { action: 'update', id: idA, title: '不该生效的新标题', mode: 'teleport' },
  exec,
)
assert.ok(badMode.message.includes('mode'), 'an unknown mode is refused: ' + badMode.message)
assert.equal((await actionRows())[0].title, '动作 A（改）', 'and the valid half did NOT land')

const emptyUpdate = await registered.tool.execute({ action: 'update', id: idA }, exec)
assert.ok(
  emptyUpdate.message.includes('至少'),
  'an update that changes nothing says so: ' + emptyUpdate.message,
)

const noteCleared = await registered.tool.execute({ action: 'update', id: idA, note: '' }, exec)
assert.ok(noteCleared.message.includes('清空'), 'an empty note clears it: ' + noteCleared.message)

// -- reorder: one directory, explicit ids, and refusals that change nothing ---

const moved = await registered.tool.execute({ action: 'reorder', ids: [idC, idA, idB] }, exec)
assert.ok(moved.message.includes('已调整顺序'), 'reorder reports the new order: ' + moved.message)
assert.deepEqual(
  (await actionRows()).map((row) => row.id),
  [idC, idA, idB],
  'and the board reads back in exactly that order',
)

// A row from another directory makes the list cross-directory — refused whole,
// because the panel groups by directory and each queue moves on its own.
await registered.tool.execute({ action: 'add', title: '别的目录的一条', dir: DIR }, exec)
const otherDirId = (await registered.tool.execute({ action: 'list', all: true }, exec)).todos.find(
  (row) => row.title === '别的目录的一条',
).id
const crossDir = await registered.tool.execute({ action: 'reorder', ids: [idB, otherDirId] }, exec)
assert.ok(
  crossDir.message.includes('同一个目录'),
  'a cross-directory reorder is refused: ' + crossDir.message,
)
assert.deepEqual(
  (await actionRows()).map((row) => row.id),
  [idC, idA, idB],
  'and the refused reorder moved nothing',
)

const unknownId = await registered.tool.execute({ action: 'reorder', ids: [idB, 'no-such-id'] }, exec)
assert.ok(unknownId.message.includes('找不到'), 'an id that does not exist is named: ' + unknownId.message)
assert.deepEqual((await actionRows()).map((row) => row.id), [idC, idA, idB], 'and nothing moved')

// -- dispatch: starts a row, and refuses one that is already out there --------

const beforeDispatch = agent.sent.length
const dispatched = await registered.tool.execute({ action: 'dispatch', id: idB }, exec)
assert.ok(dispatched.message.includes('已派发'), 'dispatch reports the target: ' + dispatched.message)
assert.equal(agent.sent.length, beforeDispatch + 1, 'the task landed in the calling session')
assert.ok(
  agent.sent[beforeDispatch].content[0].text.includes('动作 B'),
  'and it is that todo, not another one',
)
assert.equal(dispatched.todos[0].state, 'dispatched', 'the row now reads as dispatched')

const again = await registered.tool.execute({ action: 'dispatch', id: idB }, exec)
assert.ok(
  again.message.includes('未派发') && again.message.includes('已派发'),
  'a second dispatch of the same row is refused with its current state: ' + again.message,
)
assert.equal(agent.sent.length, beforeDispatch + 1, 'and it sent nothing')

await registered.tool.execute({ action: 'done', id: idC }, exec)
const doneDispatch = await registered.tool.execute({ action: 'dispatch', id: idC }, exec)
assert.ok(
  doneDispatch.message.includes('已完成'),
  'a finished row is not dispatchable either: ' + doneDispatch.message,
)
assert.equal(agent.sent.length, beforeDispatch + 1, 'and that sent nothing too')

assert.equal(
  (await registered.tool.execute({ action: 'dispatch', id: 'nope' }, exec)).message.includes('找不到'),
  true,
  'an unknown id is reported, not thrown',
)
console.log('actions OK')

// ------------------------------------------------------------ planning: batch
//
// One `add` for a whole plan is what makes planning usable: N steps would
// otherwise cost N approvals. The price of that convenience is that ONE approval
// now covers N rows, so the two things that matter are (a) the dialog shows every
// step, and (b) a bad item leaves NOTHING behind — a half-built plan is a
// different plan from the one the user approved.

const PLAN_DIR = 'D:\\smoke\\plan'
const planRows = async () =>
  (await registered.tool.execute({ action: 'list', dir: PLAN_DIR }, exec)).todos

const plan = await registered.tool.execute(
  {
    action: 'add',
    dir: PLAN_DIR,
    items: [
      { title: '计划 1', note: '验收：跑 npm test', mode: 'resume' },
      { title: '计划 2', note: '验收：截图', mode: 'resume' },
      { title: '计划 3' },
    ],
  },
  exec,
)
assert.ok(plan.message.includes('已新增计划：3 条'), 'the batch reports itself as a plan: ' + plan.message)
assert.equal(plan.todos.length, 3, 'and returns all three rows')

const planBoard = await planRows()
assert.deepEqual(
  planBoard.map((row) => row.title),
  ['计划 1', '计划 2', '计划 3'],
  'the array order IS the execution order',
)
assert.deepEqual(
  planBoard.map((row) => row.mode),
  ['resume', 'resume', 'remind'],
  'each step keeps its own mode (the third defaults to remind)',
)

// The notes have to survive: they are the only context a dispatched step gets.
await registered.tool.execute({ action: 'note', id: planBoard[0].id, note: '验收：跑 npm test' }, exec)
const planNotes = (await registered.tool.execute({ action: 'list', dir: PLAN_DIR }, exec)).todos
assert.equal(planNotes.length, 3, 'the plan is still three rows after a note edit')

// -- all-or-nothing ---------------------------------------------------------

const countBefore = (await planRows()).length
// `parent` nests a step under an EARLIER step in the same batch. This is how the
// model says 「open a clean session and carry the rest of the work into it」
// instead of defaulting every step to resume. A directory of its own, so the
// batch-count assertions below still measure only their own rows.
const NEST_DIR = 'D:\\smoke\\nest'
const nested = await registered.tool.execute(
  {
    action: 'add',
    dir: NEST_DIR,
    items: [
      { title: '容器：开新会话', mode: 'newSession' },
      { title: '被带走的子级', mode: 'resume', parent: 0 },
      { title: '留在本会话', mode: 'resume' },
    ],
  },
  exec,
)
assert.equal(nested.todos.length, 3, 'a batch may nest its own steps')
const nestedRows = (await registered.tool.execute({ action: 'list', dir: NEST_DIR }, exec)).todos
const container = nestedRows[0]
const child = nestedRows[1]
assert.equal(
  child.parentId,
  container.id,
  'the child names its container by id — so flipping that container to newSession later carries the child along, with no rewrite',
)
assert.equal(container.parentId, '', 'and the container itself hangs off nothing')
assert.equal(nestedRows[2].parentId, '', 'a step with no parent stays owned by the planning session')

// A parent may only point BACKWARDS. That rule is what makes a cycle impossible
// to express rather than something to detect after the board is already knotted.
for (const bad of [-1, 2, 3, 9, 1.5]) {
  const rejected = await registered.tool.execute(
    {
      action: 'add',
      dir: NEST_DIR,
      items: [{ title: 'A', mode: 'resume' }, { title: 'B', mode: 'resume' }, { title: '坏 parent', parent: bad }],
    },
    exec,
  )
  assert.ok(
    rejected.message.includes('parent'),
    'a parent pointing at ' + bad + ' refuses the batch: ' + rejected.message,
  )
  assert.equal(rejected.todos.length, 0, 'and lands nothing')
}

const badPlan = await registered.tool.execute(
  {
    action: 'add',
    dir: PLAN_DIR,
    items: [{ title: '不该落库的 A' }, { title: '   ' }, { title: '不该落库的 B' }],
  },
  exec,
)
assert.ok(badPlan.message.includes('整批未创建'), 'a blank title refuses the batch: ' + badPlan.message)
assert.equal(badPlan.todos.length, 0, 'and returns no rows')
assert.equal(
  (await planRows()).length,
  countBefore,
  'and NOT ONE row landed — the earlier titles in that batch did not sneak in',
)

const badModePlan = await registered.tool.execute(
  { action: 'add', dir: PLAN_DIR, items: [{ title: 'A' }, { title: 'B', mode: 'teleport' }] },
  exec,
)
assert.ok(badModePlan.message.includes('mode'), 'an unknown mode refuses the batch too')
assert.equal((await planRows()).length, countBefore, 'again with nothing written')

const badSchedulePlan = await registered.tool.execute(
  { action: 'add', dir: PLAN_DIR, items: [{ title: 'A' }, { title: 'B', schedule: '明天' }] },
  exec,
)
assert.ok(badSchedulePlan.message.includes('schedule'), 'a bad schedule refuses the batch')
assert.equal((await planRows()).length, countBefore, 'and writes nothing')

// The ceiling exists so an approval is still readable; it refuses rather than
// silently truncating, because a silently shorter plan is a lie about scope.
const oversized = await registered.tool.execute(
  {
    action: 'add',
    dir: PLAN_DIR,
    items: Array.from({ length: 21 }, (_, i) => ({ title: '步骤 ' + (i + 1) })),
  },
  exec,
)
assert.ok(oversized.message.includes('最多创建 20 条'), 'an oversized plan is refused: ' + oversized.message)
assert.equal((await planRows()).length, countBefore, 'and nothing was written')

// A single add still behaves exactly as before (items absent, title present).
const single = await registered.tool.execute({ action: 'add', title: '单条仍照旧', dir: PLAN_DIR }, exec)
assert.ok(single.message.includes('已新增待办'), 'a plain single add still takes the old path')
assert.equal(single.todos.length, 1, 'and returns exactly one row')

// -- the automatic handoff summary ------------------------------------------
//
// A `newSession` row carries only its title and note into the new session, so an
// empty note means the handoff lands with no context at all. This is the rule
// that fixes that — but ONLY for an empty note, and never at the cost of the
// handoff itself.

const HANDOFF_DIR = 'D:\\smoke\\handoff'

const bare = await registered.tool.execute(
  { action: 'add', dir: HANDOFF_DIR, items: [{ title: '空 note 的容器', mode: 'newSession' }] },
  exec,
)
/** One panel snapshot row, including the note — the tool's own list omits it. */
async function handoffPanelRow(id) {
  const response = fakeResponse()
  const request = { method: 'GET', url: '/', headers: BROWSER_HEADERS }
  await apiRoute.handler(request, response)
  const body = JSON.parse(response.box.body)
  return body.todos.find((row) => row.id === id)
}

const bareRow = (await registered.tool.execute({ action: 'list', dir: HANDOFF_DIR }, exec)).todos[0]
let asked = 0
registered.llm = {
  async *stream() {
    asked++
    yield { type: 'text-delta', index: 0, text: '不该被问' }
  },
}
registered.sessionQuery = { async readSurface() { throw new Error('不该被读') } }
await postJson({ action: 'run', id: bareRow.id, sessionId: '' })
// An unreadable source log is not a failed handoff: the row still spawns, and
// nothing was asked of a model that could not have been helped anyway.
assert.equal(asked, 0, 'a failing read ends the summary, not the handoff')

// Now with a readable session, and an empty note.
let promptSeen = ''
registered.llm = {
  async *stream(options) {
    asked++
    promptSeen = options.messages[0].content[0].text
    assert.ok(options.maxTokens > 0, 'the summary is capped, not unbounded')
    yield { type: 'text-delta', index: 0, text: '- 目标：改完归属语义\n- 已完成：runIn 字段' }
  },
}
registered.sessionQuery = {
  async readSurface() {
    return {
      events: [
        { message: { content: [{ type: 'text', text: '用户要求改派发语义' }] } },
        { message: { content: [{ type: 'text', text: '我正在改 fireDue' }] } },
      ],
    }
  },
}
await registered.tool.execute(
  { action: 'add', dir: HANDOFF_DIR, items: [{ title: '有空 note 的容器', mode: 'newSession' }] },
  exec,
)
const secondRow = (await registered.tool.execute({ action: 'list', dir: HANDOFF_DIR }, exec)).todos[1]
asked = 0
await postJson({ action: 'run', id: secondRow.id, sessionId: '' })
assert.equal(asked, 1, 'an empty note asks the model exactly once')
assert.ok(
  promptSeen.includes('正在改 fireDue'),
  'and the transcript it summarizes really is the source session\'s',
)
const summarized = await handoffPanelRow(secondRow.id)
assert.ok(
  summarized.note.startsWith('【自动交接摘要'),
  'the summary lands in the note, behind a marker the user can recognise and edit',
)
assert.ok(summarized.note.includes('已完成：runIn 字段'), 'and it is the model\'s own words')

// A note the user wrote is never overwritten.
await registered.tool.execute(
  {
    action: 'add',
    dir: HANDOFF_DIR,
    items: [{ title: '有 note 的容器', mode: 'newSession', note: '我自己写的交接说明' }],
  },
  exec,
)
const writtenRow = (await registered.tool.execute({ action: 'list', dir: HANDOFF_DIR }, exec)).todos[2]
asked = 0
await postJson({ action: 'run', id: writtenRow.id, sessionId: '' })
assert.equal(asked, 0, 'a note the user wrote is never replaced by a summary')
const untouched = await handoffPanelRow(writtenRow.id)
assert.equal(untouched.note, '我自己写的交接说明', 'and the user\'s own words survive intact')
registered.llm = null
registered.sessionQuery = null

// -- the approval dialog shows the PLAN, not just "add" ----------------------

const planGate = registered.listeners.find((entry) => entry.event === 'tools/pre-execute')
const planReason = planGate.listener(
  {
    name: 'todo_board',
    arguments: { action: 'add', items: [{ title: '步骤甲' }, { title: '步骤乙', mode: 'resume' }] },
  },
  () => {
    throw new Error('the gate must not pass a batch through')
  },
).reason
assert.ok(planReason.includes('新增计划（2 步'), 'the dialog names it as a plan: ' + planReason)
assert.ok(planReason.includes('1. 步骤甲') && planReason.includes('2. 步骤乙'), 'and lists every step')
assert.ok(
  planReason.includes('会自动派发'),
  'and warns when any step would run itself: ' + planReason,
)
console.log('plan    OK')

// --------------------------------------------------- planning: skill + command

assert.ok(registered.skill !== null, 'the planning skill is registered')
assert.equal(registered.skill.name, 'todo-board-planning', 'under its documented name')
assert.equal(registered.skill.provider, undefined, 'letting the harness default it to the runtime provider')
assert.ok(
  registered.skill.invocation.modelInvocable === true && registered.skill.invocation.userInvocable === true,
  'loadable by the model and reachable by the user',
)
assert.ok(
  typeof registered.skill.content === 'string' && registered.skill.content.includes('items'),
  'and its body explains the batch call',
)
// The skill carries the template, so a user who finds the skill can copy it too.
assert.ok(
  registered.skill.content.includes('用 TODO 板把这件事拆成可执行的步骤'),
  'the skill body embeds the paste-able template',
)

assert.ok(registered.command !== null, 'the /todo command is registered')
assert.equal(registered.command.name, 'todo', 'under the short name')
assert.equal(registered.command.input.attachments, true, 'and accepts the user attachments')

const commandAgent = { sent: [], followup(message) { this.sent.push(message) } }
const commandResult = registered.command.handler({
  agent: commandAgent,
  rawInput: '把日志模块拆开并做完',
  attachments: [],
})
assert.equal(commandResult.kind, 'success', 'a usable invocation succeeds: ' + JSON.stringify(commandResult))
assert.equal(commandAgent.sent.length, 1, 'and injects exactly one message')
const injected = commandAgent.sent[0]
assert.equal(injected.role, 'user', 'as a user message, so the model treats it as the request')
assert.ok(
  Array.isArray(injected.content) && injected.content[0].type === 'text',
  'with ContentBlock[] content (a bare string would corrupt the session log)',
)
assert.ok(
  injected.content[0].text.includes('【目标】把日志模块拆开并做完'),
  'the goal replaces the template placeholder: ' + injected.content[0].text.slice(0, 80),
)

// No goal is a usage error: injecting the template alone would make the model
// plan the literal placeholder text.
const emptyResult = registered.command.handler({ agent: commandAgent, rawInput: '  ', attachments: [] })
assert.equal(emptyResult.kind, 'error', 'an empty /todo is refused')
assert.ok(emptyResult.text.includes('/todo <目标>'), 'and says how to call it: ' + emptyResult.text)
assert.equal(commandAgent.sent.length, 1, 'injecting nothing for it')
console.log('plan-ui OK')

// ------------------------------------------------- planning: the deterministic nudge
//
// The judgement is the feature: a nudge that fires on everything is noise, and
// one that never fires is dead code. So both directions are driven through the
// real hook, with a board that is (and is not) empty.

const preStep = registered.listeners.find((entry) => entry.event === 'agent/pre-step')
assert.ok(preStep !== undefined, 'the planning nudge listens on agent/pre-step')

const NUDGE_DIR = 'D:\\smoke\\nudge'
const nudgeAgent = (dir) => ({
  id: 'session-nudge',
  session: { header: { id: 'session-nudge', cwd: dir } },
})
const userMessage = (text) => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })

/** Run the hook; returns the messages the step ends up with (or the original). */
async function viaPreStep(agent, messages) {
  const downstream = { kind: 'enter', messages }
  const out = await preStep.listener(
    { agent, messages },
    () => Promise.resolve(downstream),
  )
  return out === undefined || out === null ? messages : out.messages
}

const staged = [
  '这次要做的东西比较多，麻烦按顺序来，别一次全塞进去：',
  '1. 先把日志模块的接口抽出来，保持行为不变',
  '2. 然后补单元测试，覆盖失败路径',
  '3. 接着把面板上的展示改成新接口',
  '4. 最后更新 README 与 CHANGELOG',
  '',
  '验收标准是 npm test 全绿、npm run guard 全绿，并且我能从 README 里看懂怎么用。',
  '另外注意不要动 public API，不要引入新依赖，不要把已经稳定的调度代码重构掉；',
  '改完我会再跑一遍真实浏览器检查，所以面板的计算样式不要破。',
  '如果中途发现要加步骤，先告诉我再改范围。',
].join('\n')

assert.ok(staged.length >= 200, 'the fixture is long enough to be a staged task: ' + staged.length)

let after = await viaPreStep(nudgeAgent(NUDGE_DIR), [userMessage(staged)])
assert.equal(after.length, 2, 'a staged request on an EMPTY board gets one nudge')
assert.ok(
  after[1].content[0].text.includes('规划提示'),
  'and the nudge is the planning hint: ' + after[1].content[0].text.slice(0, 60),
)
// Producer-owned source kind, not the retired v3 wrapper `{ kind: 'plugin',
// plugin: … }`: session format v4 refuses a newly written message whose source
// kind is not producer-owned, and the refusal fails the whole turn.
assert.equal(
  after[1].source.kind,
  'plugin:dsh-todo-board',
  'sourced as a producer-owned plugin notice, not as the user speaking',
)

// Once per session: the same agent asking again is answered by silence.
after = await viaPreStep(nudgeAgent(NUDGE_DIR), [userMessage(staged)])
const repeatAgent = nudgeAgent(NUDGE_DIR)
await viaPreStep(repeatAgent, [userMessage(staged)])
after = await viaPreStep(repeatAgent, [userMessage(staged)])
assert.equal(after.length, 1, 'the same session is never nudged twice')

// A SHORT message is not a plan, even with several staged markers. This is the
// LENGTH threshold on its own: the markers are all here, so only the length check
// can be what keeps the offer from firing.
after = await viaPreStep(nudgeAgent(NUDGE_DIR), [
  userMessage(['1. 改错别字', '2. 跑一下测试', '3. 提交'].join('\n')),
])
assert.equal(after.length, 1, 'a short but structured message is left alone')

// A LONG message with no staged markers is left alone too — the other threshold,
// on its own.
after = await viaPreStep(nudgeAgent(NUDGE_DIR), [userMessage('报错如下：' + 'x'.repeat(400))])
assert.equal(after.length, 1, 'a long but unstructured message is left alone')

// A board with work on it is mid-plan: no offer.
await registered.tool.execute({ action: 'add', title: '正在做的', dir: NUDGE_DIR }, exec)
after = await viaPreStep(nudgeAgent(NUDGE_DIR), [userMessage(staged)])
assert.equal(after.length, 1, 'a directory that already has todos is not offered planning again')

// ------------------------------------------------- the settings that bound it
//
// The thresholds used to be module constants, which made "this looks
// multi-stage" a question about whoever last edited the source. They are board
// settings now — and a setting nobody honours is worse than no setting at all.
//
// `settings` is read once per load(), so each case boots a FRESH module against
// its own DSH_HOME carrying its own board.json. That is the only honest way to
// drive the live wiring: patching the file of an already-loaded plugin would
// test the file, not the hook.
//
// Both directions are covered. Raising a threshold must SUPPRESS an offer the
// defaults would produce; lowering it must PRODUCE one they would not — a test
// that only proves "raising suppresses" would still pass if the code ignored
// the settings and simply never fired.

/** Boot an isolated plugin instance whose board.json carries `settings`. */
async function bootWithSettings(settings, cwd) {
  const isolatedHome = mkdtempSync(join(tmpdir(), 'dshtb-nudge-'))
  mkdirSync(join(isolatedHome, 'todo-board'), { recursive: true })
  writeFileSync(
    join(isolatedHome, 'todo-board', 'board.json'),
    JSON.stringify({ version: 1, seq: 0, todos: [], settings }, null, 2),
  )
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = isolatedHome
  const mod = await import('../lib/index.js?settings=' + Date.now() + Math.random())
  const seen = { listeners: [] }
  const ownCtx = {
    root: undefined,
    webServer: { register: () => () => {} },
    get: (key) => (key === 'tools' ? { register() { return () => {} } } : undefined),
    on(event, listener) { seen.listeners.push({ event, listener }); return () => {} },
    effect: (cb) => { const d = cb(); return typeof d === 'function' ? d : () => {} },
    inject: (names, cb) => cb(ownCtx),
    logger: { exporter: () => () => {}, error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
  }
  mod.apply(ownCtx)
  process.env.DSH_HOME = previousHome
  const hook = seen.listeners.find((entry) => entry.event === 'agent/pre-step')
  assert.ok(hook !== undefined, 'the hook registers in the isolated instance')
  return {
    /** Run one user message through THIS instance's real hook. */
    async run(text) {
      const messages = [userMessage(text)]
      const downstream = { kind: 'enter', messages }
      const out = await hook.listener({ agent: nudgeAgent(cwd), messages }, () => Promise.resolve(downstream))
      rmSync(isolatedHome, { recursive: true, force: true })
      return out === undefined || out === null ? messages : out.messages
    },
  }
}

// The off switch: nudge:false must not offer, even for a fixture that fires at
// the defaults.
{
  const off = await bootWithSettings({ nudge: false, minChars: 200, minEntries: 2 }, 'D:\\smoke\\nudge-off')
  assert.equal((await off.run(staged)).length, 1, 'nudge:false suppresses the offer entirely')
}

// Raising minEntries suppresses: `staged` is long enough, but its markers are
// nowhere near 50.
{
  const high = await bootWithSettings({ nudge: true, minChars: 200, minEntries: 50 }, 'D:\\smoke\\nudge-high')
  assert.equal((await high.run(staged)).length, 1, 'a raised minEntries suppresses the offer')
}

// Raising minChars suppresses: the fixture is ~400 chars, nowhere near 5000.
{
  const longer = await bootWithSettings({ nudge: true, minChars: 5000, minEntries: 2 }, 'D:\\smoke\\nudge-long')
  assert.equal((await longer.run(staged)).length, 1, 'a raised minChars suppresses the offer')
}

// Lowering BOTH produces an offer the defaults would not: this fixture is short
// and has exactly the markers the defaults already require.
{
  const shortStaged = ['1. 第一步', '2. 第二步'].join('\n')
  assert.ok(shortStaged.length < 200, 'the low-threshold fixture really is shorter than the default')
  const low = await bootWithSettings({ nudge: true, minChars: 10, minEntries: 1 }, 'D:\\smoke\\nudge-low')
  assert.equal((await low.run(shortStaged)).length, 2, 'lowered thresholds produce an offer the defaults would not')
}

// The defaults themselves still fire, so the cases above are not proving that
// the feature is simply broken.
{
  const normal = await bootWithSettings({ nudge: true, minChars: 200, minEntries: 2 }, 'D:\\smoke\\nudge-normal')
  assert.equal((await normal.run(staged)).length, 2, 'the default thresholds still produce an offer')
}

// Tool results and injected notices must never trigger the offer — the plugin
// would otherwise be talking to itself.
after = await viaPreStep(nudgeAgent('D:\\smoke\\nudge2'), [
  { role: 'user', source: { kind: 'tool' }, content: [{ type: 'text', text: staged }] },
])
assert.equal(after.length, 1, 'a tool result is not a user request')
console.log('nudge   OK')

// ------------------------------------------- the per-turn spawn cap (0.13.4)
//
// `MAX_TURN_SESSIONS` used to be a module constant, which meant a plan allowed
// to be twenty steps long could only half-dispatch at one turn end — and
// nothing guaranteed a "next turn". It reads `board.settings` now.
//
// Driving the WHOLE loop would need ten-plus real spawns per case; what can
// actually go wrong is narrower than that, and cheaper to pin: the loop reads a
// saved setting, and the write path refuses a value outside the range. Both are
// asserted here against an isolated instance, because `settings` is read at
// load() time.
{
  const capHome = mkdtempSync(join(tmpdir(), 'dshtb-cap-'))
  mkdirSync(join(capHome, 'todo-board'), { recursive: true })
  writeFileSync(
    join(capHome, 'todo-board', 'board.json'),
    JSON.stringify(
      { version: 1, seq: 0, todos: [], settings: { nudge: true, minChars: 200, minEntries: 2, maxTurnSessions: 3 } },
      null,
      2,
    ),
  )
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = capHome
  const capMod = await import('../lib/index.js?cap=' + Date.now() + Math.random())
  const capRegistered = { listeners: [], tool: null }
  const capCtx = {
    root: undefined,
    webServer: { register: () => () => {} },
    get: (key) => (key === 'tools' ? { register(def) { capRegistered.tool = def; return () => {}; } } : undefined),
    on(event, listener) { capRegistered.listeners.push({ event, listener }); return () => {} },
    effect: (cb) => { const d = cb(); return typeof d === 'function' ? d : () => {} },
    inject: (names, cb) => cb(capCtx),
    logger: { exporter: () => () => {}, error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
  }
  capMod.apply(capCtx)
  // Force a save through the tool so the in-memory settings land on disk;
  // `load()` alone must not rewrite the file.
  await capRegistered.tool.execute(
    { action: 'add', title: 'cap probe', mode: 'remind' },
    { agent: { session: { header: { cwd: 'D:\\smoke\\cap' } }, id: 'sess-cap' } },
  )
  process.env.DSH_HOME = previousHome

  // The saved value is what the loader kept; a bad one would have been clamped.
  const savedCap = JSON.parse(readFileSync(join(capHome, 'todo-board', 'board.json'), 'utf8')).settings
  assert.equal(savedCap.maxTurnSessions, 3, 'a saved spawn cap survives the loader')

  // And the loader CLAMPS rather than trusting: 0 (never spawn) and 999 (stall
  // the turn hook) both come back as the default. The clamp is IN MEMORY —
  // `load()` must not rewrite the file just for reading it — so the way to
  // observe it is to force a real save and read that back.
  for (const [given, label] of [[0, 'zero'], [999, 'far too large']]) {
    const clampHome = mkdtempSync(join(tmpdir(), 'dshtb-cap-clamp-'))
    mkdirSync(join(clampHome, 'todo-board'), { recursive: true })
    writeFileSync(
      join(clampHome, 'todo-board', 'board.json'),
      JSON.stringify(
        { version: 1, seq: 0, todos: [], settings: { nudge: true, minChars: 200, minEntries: 2, maxTurnSessions: given } },
        null,
        2,
      ),
    )
    const prev = process.env.DSH_HOME
    process.env.DSH_HOME = clampHome
    const m = await import('../lib/index.js?capclamp=' + Date.now() + Math.random())
    const reg = { tool: null }
    const c = {
      root: undefined,
      webServer: { register: () => () => {} },
      get: (k) => (k === 'tools' ? { register(def) { reg.tool = def; return () => {}; } } : undefined),
      on: () => () => {},
      effect: (cb) => { const d = cb(); return typeof d === 'function' ? d : () => {} },
      inject: (names, cb) => cb(c),
      logger: { exporter: () => () => {}, error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
    }
    m.apply(c)
    // Force a save through the tool; the in-memory (clamped) settings land on disk.
    await reg.tool.execute(
      { action: 'add', title: 'cap probe', mode: 'remind' },
      { agent: { session: { header: { cwd: 'D:\\smoke\\cap' } }, id: 'sess-cap' } },
    )
    process.env.DSH_HOME = prev
    const after = JSON.parse(readFileSync(join(clampHome, 'todo-board', 'board.json'), 'utf8')).settings
    assert.equal(after.maxTurnSessions, 10, 'a spawn cap of ' + label + ' falls back to the default')
    rmSync(clampHome, { recursive: true, force: true })
  }
  rmSync(capHome, { recursive: true, force: true })
  console.log('cap     OK')
}

rmSync(home, { recursive: true, force: true })
console.log('\nall host-half smoke checks passed')
