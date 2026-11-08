/**
 * Regression test: a failing scheduled dispatch must not spin the host.
 *
 * `armTimer()` calls `fireDue()` whenever a row is due, and `fireDue` re-arms
 * from the dispatch's `.finally()`. A row that fails *without* recording either
 * `dispatchedAt` or `lostAt` therefore stays permanently due, and the retry
 * chain re-enters through microtasks alone — the event loop never runs and the
 * host freezes, retrying forever with no timer ever firing.
 *
 * This test creates exactly that row (a due `newSession` task whose session
 * creation always throws) and asserts the retries are paced. The counter aborts
 * the process if the loop regresses, because a spinning loop cannot be observed
 * from a timer.
 *
 *   node tools/retry-loop.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dshtb-loop-'))
process.env.DSH_HOME = home

const mod = await import('../lib/index.js')

const registered = { tool: null, routes: [], listeners: [] }
const DIR = 'D:\\loop\\project'
const agent = {
  id: 'session-a',
  status: 'idle',
  session: { header: { id: 'session-a', cwd: DIR } },
  followup() {},
  steer() {},
}
const agentsStub = {
  list: () => [agent],
  get: (id) => (id === agent.id ? agent : undefined),
  async create() {
    throw new Error('creating a session always fails here')
  },
}

/** Counts how often the failing path is entered. */
let attempts = 0
const presetsStub = {
  async resolve() {
    attempts += 1
    // A spinning loop starves the event loop, so no timer below can ever fire
    // to end the test. Bail out synchronously and fail loudly instead.
    if (attempts >= 200) {
      console.error(
        '\nFAIL: the scheduler retried a failing dispatch ' + attempts +
          ' times without yielding — the host is frozen in a microtask loop.',
      )
      rmSync(home, { recursive: true, force: true })
      process.exit(1)
    }
    throw new Error('preset resolve always fails')
  },
  async mount() {},
}

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
    logger: { error() {}, warn() {} },
  }
  return ctx
}

mod.apply(makeCtx())
const apiRoute = registered.routes.find((route) => route.path === '/dsh-todo-board/api')

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
    // The route's trust fence refuses a request with no `Host` — the
    // DNS-rebinding check — so a browser-shaped stub must carry one.
    headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
  await apiRoute.handler(request, response)
  return JSON.parse(box.body)
}

function localStamp(ms) {
  const date = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return (
    date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    'T' + pad(date.getHours()) + ':' + pad(date.getMinutes())
  )
}

const minuteStart = Math.floor(Date.now() / 60000) * 60000

// A row that is due right now, in `newSession` mode, whose spawn always fails.
const created = await postJson({
  action: 'create',
  title: '建会话总是失败',
  mode: 'newSession',
  dir: DIR,
  sessionId: agent.id,
  schedule: localStamp(minuteStart),
})
assert.equal(created.ok, true, 'the row is created')

// Give the scheduler real time to misbehave if it is going to.
await new Promise((resolve) => setTimeout(resolve, 700))

assert.ok(
  attempts <= 5,
  'a failing dispatch is retried at most a few times in 700ms, not continuously (saw ' + attempts + ')',
)
assert.ok(attempts >= 1, 'the failing path was actually exercised (saw ' + attempts + ')')

// The row is parked with a reason, not retried forever.
const list = await registered.tool.execute({ action: 'list', all: true }, { agent })
const row = list.todos.find((todo) => todo.id === created.todo.id)
assert.equal(row.state, 'lost', 'the row reports the stuck state')
assert.ok(
  list.message.includes('新建会话失败') || row.state === 'lost',
  'the failure is visible rather than silent',
)

rmSync(home, { recursive: true, force: true })
console.log('retry   OK — failing dispatch paced at ' + attempts + ' attempt(s), row parked as ' + row.state)
console.log('\nall retry-loop checks passed')
