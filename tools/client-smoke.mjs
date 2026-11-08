/**
 * Browser-half smoke test for dsh-todo-board.
 *
 * The client module only reaches for `require('react')` and a few globals, so it
 * can be loaded in Node against a tiny hook runtime and a stub DOM. That is
 * enough to pin down the panel's folding behaviour — which sections exist, what
 * the parked one-line view shows, and that the title bar's drag handle does not
 * swallow a click meant for a button.
 *
 *   node tools/client-smoke.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// ------------------------------------------------------------- React shim

let hooks = []
let cursor = 0
let rendering = false
let scheduled = false
const pendingEffects = []

function scheduleRender() {
  if (rendering) {
    scheduled = true
    return
  }
  let guard = 0
  do {
    scheduled = false
    render()
    guard += 1
  } while (scheduled && guard < 50)
}

function flushEffects() {
  if (pendingEffects.length === 0) return
  const running = pendingEffects.splice(0, pendingEffects.length)
  for (const effect of running) {
    if (typeof effect.cleanup === 'function') effect.cleanup()
    const cleanup = effect.run()
    effect.cleanup = typeof cleanup === 'function' ? cleanup : undefined
    effect.ran = true
  }
}

function slot(at) {
  if (hooks[at] === undefined) hooks[at] = {}
  return hooks[at]
}

const React = {
  createElement(type, props, ...children) {
    const flat = []
    const push = (value) => {
      if (value === null || value === undefined || value === false || value === true) return
      if (Array.isArray(value)) {
        for (const item of value) push(item)
        return
      }
      flat.push(value)
    }
    for (const child of children) push(child)
    const node = { type, props: props === null || props === undefined ? {} : props, children: flat }
    // A real renderer attaches `ref.current` to the DOM node; the panel reads the
    // parked line's own box through it to bound that box against the viewport.
    // Only the pill is stubbed — the other refs (the two growing textareas) need
    // a `style` object, which is a different stub with a different job.
    if (node.props.className === 'dshtb-pill' && node.props.ref !== undefined && node.props.ref !== null) {
      node.props.ref.current = { getBoundingClientRect: () => pillRect }
    }
    return node
  },
  useState(initial) {
    const at = cursor
    cursor += 1
    const store = slot(at)
    if (!('value' in store)) store.value = typeof initial === 'function' ? initial() : initial
    return [
      store.value,
      (next) => {
        store.value = typeof next === 'function' ? next(store.value) : next
        scheduleRender()
      },
    ]
  },
  useRef(initial) {
    const at = cursor
    cursor += 1
    const store = slot(at)
    if (store.ref === undefined) store.ref = { current: initial }
    return store.ref
  },
  useEffect(run, deps) {
    const at = cursor
    cursor += 1
    const store = slot(at)
    const previous = store.deps
    const changed =
      previous === undefined ||
      deps === undefined ||
      deps.length !== previous.length ||
      deps.some((value, i) => !Object.is(value, previous[i]))
    if (!changed) return
    store.deps = deps
    // Cleanup belongs to the effect that installed it, not to the slot.
    const effect = { run }
    if (typeof store.cleanup === 'function') effect.cleanup = store.cleanup
    store.cleanup = undefined
    pendingEffects.push(effect)
    store.effect = effect
  },
}

// ------------------------------------------------------------- DOM stubs

const storage = new Map()
const listeners = []

// The interval the polling effect installs is never fired: this test drives
// renders through the controls, not through the clock.
/**
 * The callbacks registered through `window.setInterval`, so a test can drive the
 * poll explicitly.
 *
 * The panel's polling effect installs one interval on mount, and everything it
 * captures comes from THAT first render. A stale closure there is a real bug
 * class (state read inside a once-installed interval), and it cannot be seen
 * without the ability to fire the tick.
 */
const intervals = []
/** Ids of the intervals the component has cleared; `setInterval` returns its id. */
const clearedIntervals = new Set()

/** The callbacks that are still live (registered and not cleared). */
function liveTicks() {
  return intervals.filter((_, index) => !clearedIntervals.has(index + 1))
}

globalThis.window = {
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
  setInterval: (fn) => (intervals.push(fn), intervals.length),
  clearInterval: (id) => {
    clearedIntervals.add(id)
  },
  // The log view uses this to clear its transient "已复制" note; without it the
  // copy/export paths would throw instead of merely being untested.
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  addEventListener: (type, listener) => listeners.push({ type, listener }),
  removeEventListener: (type, listener) => {
    const at = listeners.findIndex((l) => l.type === type && l.listener === listener)
    if (at >= 0) listeners.splice(at, 1)
  },
  innerWidth: 1440,
  innerHeight: 900,
}

/** What the browser does on a viewport change: fire the resize listeners. */
function resizeTo(width, height) {
  globalThis.window.innerWidth = width
  globalThis.window.innerHeight = height
  const fired = listeners.filter((l) => l.type === 'resize')
  for (const l of fired) l.listener({ type: 'resize' })
  return fired.length
}

/** Listeners registered on the document stub, by event name. */
const documentListeners = new Map()

/** Flip the stubbed page between visible and hidden, and fire the listeners. */
function setVisibility(state) {
  globalThis.document.visibilityState = state
  for (const listener of documentListeners.get('visibilitychange') ?? []) {
    listener({ type: 'visibilitychange' })
  }
}

globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  // The poll effect suspends its interval while the page is hidden, so the
  // stub has to model BOTH halves of that contract: a visibility state to read
  // and a listener registry to fire. A stub that only answered
  // `addEventListener` with a no-op would let the production code pass while
  // never actually stopping the timer — the exact class of "test answers a
  // question production never asks" this suite has been bitten by before.
  visibilityState: 'visible',
  addEventListener: (event, listener) => {
    const set = documentListeners.get(event) ?? new Set()
    set.add(listener)
    documentListeners.set(event, set)
  },
  removeEventListener: (event, listener) => {
    const set = documentListeners.get(event)
    if (set !== undefined) set.delete(listener)
  },
  createElement: (tag) => {
    const attrs = {}
    const node = {
      tagName: tag,
      setAttribute: (name, value) => {
        attrs[name] = value
      },
      getAttribute: (name) => (name in attrs ? attrs[name] : null),
      remove() {},
      style: {},
      // The export path builds an <a download> and clicks it; recording that
      // click is how the test observes a download without a real browser.
      click() {
        if (tag === 'a' && typeof node.download === 'string') {
          downloads.push({ filename: node.download, href: node.href })
        }
      },
    }
    return node
  },
  // Recorded, not discarded: which stylesheets a plugin installs is exactly the
  // kind of thing that silently stops happening.
  head: {
    appendChild(node) {
      headStyles.push(node)
    },
  },
  body: {
    appendChild() {},
  },
}

/** Downloads triggered through a stub `<a download>`, in order. */
const downloads = []

/**
 * The parked line's box, as the browser would report it.
 *
 * The line is auto-sized: it is one row of text, so its width follows the next
 * todo's title up to a CSS cap. A clamp that assumed the card's box instead
 * would be measuring a shape this state does not have, which is exactly what the
 * re-clamp test below pins down. Mutable so a test can state the size it means.
 */
let pillRect = { left: 1040, top: 60, width: 220, height: 40 }

/** Every <style> apply() has installed, in order. */
const headStyles = []

/**
 * `FileReader`, reduced to what the panel uses: `readAsDataURL` plus the two
 * handlers it assigns. Real enough to prove the encoder is wired up, and
 * deliberately async-flavoured (the callback runs on a later tick) so a test
 * cannot accidentally depend on it resolving synchronously.
 */
const readAsDataURL = []
globalThis.FileReader = class {
  readAsDataURL(file) {
    readAsDataURL.push(file)
    // Some files carry no MIME type — exactly the clipboard case the panel has
    // to survive — so the stub encodes what it was given and lets the panel add
    // the media type, rather than inventing one here.
    const type = typeof file.type === 'string' && file.type !== '' ? file.type : 'application/octet-stream'
    setTimeout(() => {
      if (typeof this.onerror === 'function' && file.__readFails === true) {
        this.onerror(new Error('stub read failure'))
        return
      }
      this.result = 'data:' + type + ';base64,' + String(file.__base64 || 'QUJD')
      if (typeof this.onload === 'function') this.onload({})
    }, 0)
  }
}

/** One image file as the browser would hand it over on a clipboard payload. */
function imageFile(name, type, base64) {
  return { name, type, __base64: base64 === undefined ? 'QUJD' : base64 }
}

/** A plain text/plain clipboard, as a normal copy produces. */
function textClipboard(text) {
  return { files: [], items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }], __text: text }
}

/** A clipboard carrying images, reachable through both faces the panel reads. */
function imageClipboard(files) {
  return {
    files,
    items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
  }
}

/**
 * A paste event whose `preventDefault` is recorded.
 *
 * Whether the panel suppresses the default is the whole contract of this
 * feature: swallowing a text paste would break the composer's main input.
 */
function pasteEvent(clipboard) {
  const event = {
    clipboardData: clipboard,
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true
    },
    stopPropagation() {},
  }
  return event
}

// ------------------------------------------------------------ board data

const CWD = 'D:\\DSH\\plugin'
const DIR_KEY = CWD.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

/**
 * A panel row as the host sends it. `state` is derived host-side (it depends on
 * live agent status), so the fixture spells it out rather than recomputing it —
 * a wrong default here would hide a real client bug.
 */
function todo(over) {
  const base = {
    id: 'x',
    title: 'x',
    dir: DIR_KEY,
    dirPath: CWD,
    dirLabel: 'plugin',
    mode: 'resume',
    aiDone: false,
    verified: false,
    note: '',
    images: [],
    schedule: '',
    dueAt: 0,
    remindedAt: 0,
    order: 0,
    sourceSessionId: 's1',
    sourceSessionTitle: '会话',
    // Ownership is resolved host-side (containers, cycles and all) and shipped
    // ready to use. The panel groups by THIS, not by `sourceSessionId`: once a
    // row is re-parented or its container spawns, the session that runs it stops
    // being the session that planned it.
    runIn: { kind: 'session', id: 's1' },
    ownerSessionId: 's1',
    dispatchedAt: 0,
    lostAt: 0,
    state: 'pending',
    targetAlive: true,
    runSessionId: '',
    createdAt: 1,
    updatedAt: 1,
  }
  const merged = { ...base, ...over }
  // Keep the derived fields honest for the common cases, so a test that only
  // wants "a finished row" does not have to restate them.
  if (over.state === undefined) {
    if (merged.verified || merged.aiDone) merged.state = 'done'
    else if (merged.lostAt > 0) merged.state = 'lost'
    else if (merged.dispatchedAt > 0) merged.state = 'dispatched'
  }
  return merged
}

const snapshot = {
  ok: true,
  storagePath: 'D:\\DSH\\dsh-home\\todo-board\\board.json',
  // The alert cursor rides every poll, including the idle one. It is the ONE
  // thing about the log that leaves the host while the view is closed, and the
  // dot on the log button is the only thing it feeds.
  logAlert: { sn: 30, at: 1700000002000 },
  todos: [
    todo({ id: 'a', title: '下一条要做的', order: 0 }),
    todo({ id: 'b', title: 'AI 已做完的', order: 1, aiDone: true }),
    todo({ id: 'c', title: '已验收的', order: 2, verified: true }),
  ],
}

/** Every POST the panel makes, so a test can assert on the wire payload. */
const calls = []

/**
 * Log records the stubbed host would return, newest last.
 *
 * `sn` values are deliberately sparse (10, 20 …) so a test can tell "the panel
 * asked from the right cursor" apart from "the panel re-fetched everything".
 */
const logLines = [
  { sn: 10, ts: 1700000000000, level: 'info', source: 'dsh-todo-board', logger: 'dsh-todo-board', detail: '启动完成' },
  { sn: 20, ts: 1700000001000, level: 'warn', source: 'dsh-todo-board', logger: 'dsh-todo-board', detail: '派发失败[no-session] id=abc' },
  { sn: 30, ts: 1700000002000, level: 'error', source: 'dsh-todo-board', logger: 'dsh-todo-board', detail: '新建会话失败：boom' },
  { sn: 40, ts: 1700000003000, level: 'error', source: 'dsh-mcp-client', logger: 'dsh-mcp-client', detail: 'other plugin failed' },
  { sn: 50, ts: 1700000004000, level: 'debug', source: 'dsh-todo-board', logger: 'dsh-todo-board', detail: 'debug detail' },
]

/** Every `since` the panel has asked for, so cursor behaviour is assertable. */
const logRequests = []
const logInfo = { cursor: 50, truncated: false, dropped: 0, file: 'D:\\DSH\\dsh-home\\todo-board\\log.ndjson', fileOff: false, fileError: '', fileBytes: 123 }

/**
 * When set, the stubbed host answers like the harness gate with no browser
 * session: 401. Used once, at the end, to check the panel explains that refusal.
 */
let unauthorized = false

/** Counts EVERY request, GET and POST alike — the poll is a GET, so `calls`
 *  (which only records POST bodies) cannot answer "did it fetch?". */
const fetchCount = { value: 0 }

globalThis.fetch = async (url, options) => {
  fetchCount.value += 1
  const target = String(url)
  if (unauthorized) return { ok: false, status: 401, json: async () => ({ ok: false }) }
  if (target.includes('logs=1')) {
    const since = Number(new URL('http://x' + target).searchParams.get('since'))
    logRequests.push(Number.isFinite(since) ? since : -1)
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        todos: snapshot.todos,
        logAlert: { sn: 30, at: 1700000002000 },
        logs: { ...logInfo, since, lines: logLines.filter((line) => line.sn > since) },
      }),
    }
  }
  if (options !== undefined && typeof options.body === 'string') {
    try {
      calls.push(JSON.parse(options.body))
    } catch (err) {
      calls.push({ unparseable: options.body })
    }
  }
  // Returns the SAME object, not a copy: the suite mutates `snapshot.todos`
  // between polls to model a board that changed under the panel.
  return { ok: true, status: 200, json: async () => snapshot }
}

// ----------------------------------------------------- load the client half

let factory = null
globalThis.window.__ModuleLoader__ = {
  load(entry) {
    factory = entry.factory
  },
}

const clientUrl = new URL('../client/client.js', import.meta.url)
await import(clientUrl.href)
assert.ok(factory !== null, 'client.js registered itself with the module loader')

const exports_ = factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})
assert.equal(exports_.name, 'dsh-todo-board')

// The footer prints this marker so a running browser can prove which build it
// loaded, which is the first question whenever a UI change "does not show up".
// It is bumped by hand, so it drifts from package.json silently — that already
// happened once. The footer is only useful if the two agree, so they are tied
// together here rather than trusted.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const buildMarker = readFileSync(clientUrl, 'utf8').match(/const BUILD = '([^']+)'/)
assert.ok(buildMarker !== null, 'the client half declares a build marker')
assert.equal(
  buildMarker[1],
  pkg.version,
  'the client build marker matches package.json (footer would otherwise lie about which build is live)',
)

// ------------------------------------------------------------ render tree

const TodoBoard = (() => {
  // The component is not exported; it is the slot target `apply()` registers.
  let captured = null
  exports_.apply({
    effect: (callback) => {
      callback()
      return () => {}
    },
    slots: {
      inject: (_name, register) => register(),
      register: (_options, component) => {
        captured = component
      },
    },
  })
  assert.ok(captured !== null, 'apply() registered the overlay component')
  return captured
})()

function findByClass(node, className) {
  const out = []
  const walk = (current) => {
    if (current === null || current === undefined || typeof current !== 'object') return
    const cls = current.props?.className
    if (typeof cls === 'string' && cls.split(/\s+/).includes(className)) out.push(current)
    if (Array.isArray(current.children)) for (const child of current.children) walk(child)
  }
  walk(node)
  return out
}

/** Every node whose props satisfy `predicate`; the generic sibling of the above. */
function findWhere(node, predicate) {
  const out = []
  const walk = (current) => {
    if (current === null || current === undefined || typeof current !== 'object') return
    if (current.props !== undefined && current.props !== null && predicate(current.props)) out.push(current)
    if (Array.isArray(current.children)) for (const child of current.children) walk(child)
  }
  walk(node)
  return out
}

function textOf(node) {  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (node === null || node === undefined || typeof node !== 'object') return ''
  return node.children.map(textOf).join('')
}

function findByText(node, needle) {
  const out = []
  const walk = (current) => {
    if (current === null || current === undefined || typeof current !== 'object') return
    if (textOf(current).includes(needle)) out.push(current)
    if (Array.isArray(current.children)) for (const child of current.children) walk(child)
  }
  walk(node)
  return out
}

/**
 * The session-list store, shaped the way the harness really sends it.
 *
 * `{ ids, byId, phase, projectionsBySession }` — there is **no** `current` key.
 * This fixture used to spell one anyway, and that is why the scope tabs could be
 * broken in the browser for several releases while this suite stayed green: the
 * panel read `s.current`, which is `undefined` in production and `'s1'` here, so
 * the fixture answered a question the real store never answers. A fixture that
 * invents a field is worse than no fixture — it converts a live bug into a
 * passing test.
 *
 * The current session is the row the main view **retains**, which is how the
 * harness itself derives it (`dsh-client-ui-layout`, `-workspace`, `-cordis`,
 * `-settings-general`, `-session` all scan for `retainedBy.mainView > 0`).
 */
function sessionsSnapshot() {
  return {
    ids: ['s2', 's1'],
    byId: {
      // Listed, but NO view retains it — and deliberately first, so "stop at the
      // first row" is a distinguishable bug from "find the row the main view
      // retains". With a single-session fixture those two are the same thing, and
      // the test would pass for a reason it never checked.
      s2: { id: 's2', cwd: 'D:\\somewhere\\else', title: '后台会话', retainedBy: {} },
      s1: { id: 's1', cwd: CWD, title: '会话', retainedBy: { mainView: 1 } },
    },
    phase: 'ready',
    projectionsBySession: {},
  }
}

/**
 * The same store seen from the OTHER session: `s2` is the one the main view
 * retains. This is the spawned-session view — a `newSession` container that
 * has opened `s2`, and rows whose `ownerSessionId` the host resolved to `s2`.
 */
function sessionsSnapshotFromSpawned() {
  const snapshot = sessionsSnapshot()
  snapshot.byId.s2.retainedBy = { mainView: 1 }
  snapshot.byId.s1.retainedBy = {}
  return snapshot
}

// `activeSessions` lets one test stand in the OTHER session — the spawned one —
// without touching any other call site: `render()` reads it, so the view point
// survives the re-renders a click triggers.
let activeSessions = null

function render() {
  cursor = 0
  rendering = true
  let tree
  try {
    tree = TodoBoard({ useSessions: (select) => select(activeSessions ?? sessionsSnapshot()) })
  } finally {
    rendering = false
  }
  flushEffects()
  return tree
}

/**
 * Mount the component from scratch, as a page load would.
 *
 * `useState` initializers only run on a real first mount, and the shim's hook
 * store would otherwise carry state across renders — so a test that seeds
 * localStorage and expects the panel to pick it up must reset the store first.
 */
function remount() {
  hooks = []
  cursor = 0
  scheduled = false
  pendingEffects.length = 0
  return render()
}

function click(node) {
  assert.equal(typeof node.props.onClick, 'function', 'the node is clickable')
  node.props.onClick({ preventDefault() {}, stopPropagation() {} })
  return render()
}

function sectionButton(tree, label) {
  const found = findByClass(tree, 'dshtb-sect').filter((node) => textOf(node).includes(label))
  assert.equal(found.length, 1, 'exactly one section header reads ' + label)
  return found[0]
}

// ------------------------------------------------------------- assertions

let tree = render()
// Let the polling effect's fetch settle and re-render with real data.
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()

assert.equal(findByClass(tree, 'dshtb-card').length, 1, 'the expanded panel renders')
assert.equal(
  findByClass(tree, 'dshtb-add').length,
  1,
  'the composer is visible by default',
)
assert.deepEqual(
  findByClass(tree, 'dshtb-sect').map((node) => textOf(node).replace(/[▾▸]/g, '')),
  ['新增待办', '待办列表 2', '已完成 1'],
  'every section is labelled with its own state — and the verified row counts as 已完成, not as 待办',
)
// The status line is not a section: no header, nothing to fold, and therefore no
// way to hide the two facts it carries.
assert.equal(
  findByClass(tree, 'dshtb-sect').some((node) => textOf(node).includes('面板')),
  false,
  'the status line has no section header any more',
)
assert.equal(findByClass(tree, 'dshtb-foot').length, 1, 'and the status line itself is still there')
console.log('render  OK')

// -- folding a section away keeps its header as the way back ---------------

tree = click(sectionButton(tree, '新增待办'))
assert.equal(findByClass(tree, 'dshtb-add').length, 0, 'the folded composer is gone')
assert.equal(
  sectionButton(tree, '新增待办').props['aria-expanded'],
  'false',
  'the section header reports the folded state',
)
assert.ok(
  JSON.parse(storage.get('dsh.todoBoard.sections.v1')).compose === false,
  'the folded section is persisted',
)

// The list folds the same way, and its header carries the row count.
tree = click(sectionButton(tree, '待办列表'))
assert.equal(findByClass(tree, 'dshtb-list').length, 0, 'the folded list is gone')
assert.ok(
  textOf(sectionButton(tree, '待办列表')).includes('待办列表 2'),
  'the folded list header keeps its count',
)

// The completed section folds on its own, and only its own body goes away.
tree = click(sectionButton(tree, '已完成'))
assert.equal(findByClass(tree, 'dshtb-donelist').length, 0, 'the folded completed list is gone')
assert.equal(findByClass(tree, 'dshtb-list').length, 0, 'and the open list is still folded')
assert.ok(
  JSON.parse(storage.get('dsh.todoBoard.sections.v1')).done === false,
  'folding the completed section is persisted like the others',
)
// Every section is folded away right now. The status line has to still be there:
// it is the one element whose disappearance would be a lie by omission ("which
// build am I looking at?", "how much is actually left?").
assert.equal(findByClass(tree, 'dshtb-foot').length, 1, 'the status line survives folding every section')
assert.ok(
  textOf(findByClass(tree, 'dshtb-foot')[0]).includes('未验收'),
  'still carrying the open count',
)
tree = click(sectionButton(tree, '已完成'))
assert.equal(findByClass(tree, 'dshtb-donelist').length, 1, 'unfolding brings the completed list back')

// Unfolding restores it.
tree = click(sectionButton(tree, '待办列表'))
assert.equal(findByClass(tree, 'dshtb-list').length, 1, 'unfolding brings the list back')
console.log('sections OK')

// -- the title-bar button is not eaten by the drag handle -----------------

const head = findByClass(tree, 'dshtb-head')[0]
let captures = 0
head.props.onPointerDown({
  button: 0,
  pointerId: 1,
  clientX: 0,
  clientY: 0,
  target: { closest: () => ({}) },
  currentTarget: {
    closest: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 380, height: 500 }) }),
    setPointerCapture: () => {
      captures += 1
    },
  },
  preventDefault() {},
})
assert.equal(captures, 0, 'pressing a button in the title bar never starts a drag')

head.props.onPointerDown({
  button: 0,
  pointerId: 1,
  clientX: 0,
  clientY: 0,
  target: { closest: () => null },
  currentTarget: {
    closest: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 380, height: 500 }) }),
    setPointerCapture: () => {
      captures += 1
    },
  },
  preventDefault() {},
})
assert.equal(captures, 1, 'pressing the bar itself still starts a drag')
console.log('drag    OK')

// -- parking the panel as one line ----------------------------------------

const fold = findByClass(tree, 'dshtb-fold')[0]
assert.equal(textOf(fold), '\u2013', 'the header carries a fold control')
tree = click(fold)
assert.equal(findByClass(tree, 'dshtb-card').length, 0, 'the parked panel drops the card')

const pill = findByClass(tree, 'dshtb-pill')[0]
assert.ok(pill !== undefined, 'the parked panel is one line')
const pillText = textOf(pill)
assert.ok(pillText.includes('TODO'), 'the line names the board')
assert.ok(pillText.includes('2'), 'the line counts the 2 unfinished todos')
assert.ok(pillText.includes('待验 1'), 'the line counts the 1 todo awaiting verification')
assert.ok(pillText.includes('下一条 · 下一条要做的'), 'the line shows the next todo, not a finished one')

// The line itself is the way back.
tree = click(pill)
assert.equal(findByClass(tree, 'dshtb-card').length, 1, 'clicking the line unfolds the panel')
console.log('park    OK')

// -- the parked line is draggable -----------------------------------------
//
// Parking used to be a dead end for positioning: the drag handle lives in the
// title bar, which the parked state does not render, so a panel that had been
// folded away could only be moved by unfolding it first. The line now carries
// its own drag — but it is also still the click that unfolds the panel, and
// those two jobs share one gesture, so both halves are pinned here.

/** The panel's painted position, whether or not a size was chosen. */
function positionOf(tree) {
  const root = findByClass(tree, 'dshtb-root')[0]
  const style = root.props.style
  if (style === undefined || style.left === undefined) return null
  return { x: parseFloat(style.left), y: parseFloat(style.top) }
}

/** The size the panel would paint, or null where nothing has been chosen. */
function sizeOf(tree) {
  const root = findByClass(tree, 'dshtb-root')[0]
  const style = root.props.style
  if (style === undefined) return null
  return {
    w: style.width === undefined ? null : parseFloat(style.width),
    h: style.height === undefined ? null : parseFloat(style.height),
  }
}

/**
 * Drive one press-move-release on the parked line, the way a pointer would.
 *
 * @param pill - The parked line node from the current render.
 * @param dx - Horizontal travel.
 * @param dy - Vertical travel.
 * @param box - The rect the line reports for itself.
 * @returns The tree after the gesture.
 */
function dragParked(pill, dx, dy, box) {
  const rect = box === undefined ? { left: 1040, top: 60, width: 220, height: 40 } : box
  let captured = 0
  const currentTarget = {
    getBoundingClientRect: () => rect,
    setPointerCapture: () => {
      captured += 1
    },
  }
  const at = (x, y) => ({
    button: 0,
    pointerId: 7,
    clientX: x,
    clientY: y,
    currentTarget,
    preventDefault() {},
    stopPropagation() {},
  })
  pill.props.onPointerDown(at(rect.left, rect.top))
  assert.equal(captured, 1, 'the press captures the pointer so the drag survives leaving the line')
  let next = render()
  // One move past the slop, then one to the final offset: a single jump would
  // not prove the slop is measured rather than assumed.
  findByClass(next, 'dshtb-pill')[0].props.onPointerMove(at(rect.left + dx, rect.top + dy))
  next = render()
  findByClass(next, 'dshtb-pill')[0].props.onPointerMove(at(rect.left + dx, rect.top + dy))
  next = render()
  findByClass(next, 'dshtb-pill')[0].props.onPointerUp(at(rect.left + dx, rect.top + dy))
  return render()
}

// Start from a clean slate so the drag is the only thing that writes geometry.
storage.delete('dsh.todoBoard.layout.v1')
tree = remount()
tree = click(findByClass(tree, 'dshtb-fold')[0])
assert.equal(findByClass(tree, 'dshtb-pill').length, 1, 'the panel is parked for the drag tests')

const dragged = dragParked(findByClass(tree, 'dshtb-pill')[0], -120, 90)
assert.deepEqual(
  positionOf(dragged),
  { x: 920, y: 150 },
  'dragging the line moves it by exactly the pointer travel',
)
const storedAfterDrag = JSON.parse(storage.get('dsh.todoBoard.layout.v1'))
assert.equal(storedAfterDrag.x, 920, 'the dragged position is persisted')
assert.equal(storedAfterDrag.y, 150, 'on both axes')

// The critical one: the line is 40px tall and auto-wide, and neither number may
// become the card's geometry. A parked drag moves the panel; it does not resize it.
assert.equal(
  storedAfterDrag.w,
  null,
  'moving the line never promotes the line width into the card width',
)
assert.equal(
  storedAfterDrag.h,
  null,
  'nor the line height into the card height',
)

// A press that drags must not also read as the click that unfolds the panel:
// the browser fires both, and unfolding after a move is the bug this prevents.
tree = click(findByClass(tree, 'dshtb-pill')[0])
assert.equal(
  findByClass(tree, 'dshtb-card').length,
  0,
  'the click that ends a drag does not unfold the panel',
)

// ...while a press that stays put is still a click.
const stillPress = findByClass(tree, 'dshtb-pill')[0]
stillPress.props.onPointerDown({
  button: 0,
  pointerId: 8,
  clientX: 920,
  clientY: 150,
  currentTarget: {
    getBoundingClientRect: () => ({ left: 920, top: 150, width: 220, height: 40 }),
    setPointerCapture: () => {},
  },
  preventDefault() {},
  stopPropagation() {},
})
stillPress.props.onPointerMove({ pointerId: 8, clientX: 921, clientY: 150 })
stillPress.props.onPointerUp({ pointerId: 8 })
tree = click(findByClass(tree, 'dshtb-pill')[0])
assert.equal(
  findByClass(tree, 'dshtb-card').length,
  1,
  'a press under the slop still unfolds the panel — the line stays clickable',
)

// The unfolded card must come back at its own size, not the line's: a width of
// 220 (or a height of 40) here would mean the parked drag resized the panel.
const afterUnfold = sizeOf(tree)
assert.equal(afterUnfold.w, null, 'unfolding uses the stylesheet width, not the line width')
assert.equal(afterUnfold.h, null, 'and the stylesheet height, not the line height')
console.log('parkdrag OK')

// A re-clamp while parked must bound the line by the LINE's box. Using the
// card's minimums here would fling a short line 300px away from its edge.
resizeTo(1440, 900)
tree = remount()
tree = click(findByClass(tree, 'dshtb-fold')[0])
const parkedNearEdge = dragParked(findByClass(tree, 'dshtb-pill')[0], 500, 0)
const parkedX = positionOf(parkedNearEdge).x
const lineW = 220
assert.ok(
  parkedX + lineW <= 1440 - 8,
  'a parked drag stops at the viewport edge measured from the line itself',
)
assert.ok(parkedX > 1440 - 300 - 8, 'and is not clamped back by the card minimum width')

// A viewport change while parked takes the SAME branch. The line sits at the
// right edge of a wide window; narrowing must pull it back in by the line's own
// width. Measuring against the card's 300px minimum would leave it 80px too far
// left — on screen, but no longer where the edge it was dragged to actually is.
assert.equal(positionOf(parkedNearEdge).x, 1212, 'the line parks at the right edge of 1440')
resizeTo(900, 700)
tree = render()
const afterNarrow = positionOf(tree)
assert.ok(afterNarrow.x + lineW <= 900 - 8, 'narrowing pulls the parked line back inside the viewport')
assert.equal(
  afterNarrow.x,
  900 - lineW - 8,
  'and stops it exactly at the edge measured from the line, not from the card minimum',
)
console.log('parkclamp OK')

// -- a size-less layout survives a reload as a size-less layout ------------
//
// A parked drag stores a position with no size on purpose. Reloading that must
// give the panel back its own geometry — the moment a null size is "helpfully"
// rounded up (to MIN_W, say), a line-only move has silently resized the card and
// the panel comes back as a 300px box the user never asked for.
storage.set('dsh.todoBoard.layout.v1', JSON.stringify({ x: 420, y: 80, w: null, h: null }))
resizeTo(1440, 900)
tree = remount()
const sizeLess = sizeOf(tree)
assert.deepEqual(positionOf(tree), { x: 420, y: 80 }, 'a size-less stored position is honoured')
assert.equal(sizeLess.w, null, 'and stays size-less, so the stylesheet still decides the width')
assert.equal(sizeLess.h, null, 'on both axes')
console.log('sizeless OK')

// -- the panel stays inside the viewport as the window changes -------------
//
// A stored position is absolute pixels, so a viewport that shrinks under it
// leaves the panel cropped and unusable — and clearing localStorage by hand was
// the only way back, because nothing re-clamped on a window resize. Dragging
// alone never fires on a window resize, which is how the panel went missing.

/** The live geometry the panel would paint, or null for CSS defaults. */
function geometry(tree) {
  const root = findByClass(tree, 'dshtb-root')[0]
  const style = root.props.style
  if (style === undefined || style.left === undefined) return null
  return {
    x: parseFloat(style.left),
    y: parseFloat(style.top),
    w: parseFloat(style.width),
    h: parseFloat(style.height),
  }
}

/** Is the panel reachable by a pointer at the given viewport? */
function onScreen(g, vw, vh) {
  if (g === null) return true
  return g.x < vw && g.x + g.w > 0 && g.y < vh && g.y + g.h > 0
}

// Park the panel near the right edge of a wide window, the way a drag would.
// The viewport is set before mounting: this is a reload in a window still big
// enough for the saved spot. PARKED_X is the rightmost x that fits 1440 wide.
const PARKED_X = 1040
resizeTo(1440, 900)
storage.set('dsh.todoBoard.layout.v1', JSON.stringify({ x: PARKED_X, y: 60, w: 380, h: 600 }))
tree = remount()
const wide = geometry(tree)
assert.ok(wide !== null, 'a stored layout is applied')
assert.equal(wide.x, PARKED_X, 'and applied as stored while there is room for it')
assert.equal(onScreen(wide, 1440, 900), true, 'it is on screen while the window is wide')

// The window narrows under the stored position.
const firedNow = resizeTo(900, 700)
tree = render()
const narrow = geometry(tree)
assert.ok(firedNow >= 1, 'the panel listens for viewport changes')
assert.equal(
  onScreen(narrow, 900, 700),
  true,
  'shrinking the window pulls the panel back into view instead of cropping it',
)
assert.ok(narrow.x + narrow.w <= 900, 'and its right edge is inside the viewport')

// Widening again puts it back exactly where it was left — the same result a
// reload gives — and must not have rewritten the stored geometry.
resizeTo(1440, 900)
tree = render()
assert.equal(geometry(tree).x, PARKED_X, 'widening restores the chosen spot, not the clamped one')
assert.equal(
  JSON.parse(storage.get('dsh.todoBoard.layout.v1')).x,
  PARKED_X,
  'the geometry on disk is left intact, not overwritten by the clamp',
)

// The round trip repeats: a one-way clamp would leave it stuck in the corner.
resizeTo(900, 700)
tree = render()
assert.equal(onScreen(geometry(tree), 900, 700), true, 'a second shrink clamps again')
resizeTo(1440, 900)
tree = render()
assert.equal(geometry(tree).x, PARKED_X, 'and a second widen restores it again')

// A viewport that can never be that wide again still shows the panel.
resizeTo(640, 480)
tree = render()
assert.equal(
  onScreen(geometry(tree), 640, 480),
  true,
  'a viewport that will never be wide again still shows the panel',
)

// A reload alone recovers a layout stored far off-screen by an older session or
// a bigger monitor — no localStorage surgery needed.
storage.set('dsh.todoBoard.layout.v1', JSON.stringify({ x: 5000, y: 4000, w: 380, h: 600 }))
resizeTo(1440, 900)
tree = remount()
const recovered = geometry(tree)
assert.equal(onScreen(recovered, 1440, 900), true, 'a layout stored far off-screen is clamped on load')
assert.ok(recovered.x + recovered.w <= 1440, 'with its right edge inside the viewport')
assert.ok(recovered.y + recovered.h <= 900, 'and its bottom edge inside the viewport')
console.log('clamp   OK')

// -- a dispatched / parked row cannot be dispatched by hand ----------------

/** The ▶ button of the row whose title matches. */
function runButton(tree, title) {
  const row = findByClass(tree, 'dshtb-item').filter((node) => textOf(node).includes(title))
  assert.equal(row.length, 1, 'exactly one row reads ' + title)
  const acts = findByClass(row[0], 'dshtb-acts')[0]
  const button = acts.children.find((child) => textOf(child) === '\u25B6')
  assert.ok(button !== undefined, 'the row carries a ▶ control')
  return button
}

snapshot.todos = [
  todo({ id: 'p', title: '还没派发的', order: 0 }),
  todo({ id: 'd', title: '已经派发的', order: 1, dispatchedAt: 1700000000000, state: 'dispatched' }),
  todo({ id: 'r', title: '正在跑的', order: 2, dispatchedAt: 1700000000000, state: 'running' }),
  todo({ id: 'l', title: '目标丢了的', order: 3, lostAt: 1700000000000, state: 'lost', targetAlive: false }),
]
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()

assert.equal(runButton(tree, '还没派发的').props.disabled, false, 'an undispatched row can be sent by hand')
assert.equal(runButton(tree, '已经派发的').props.disabled, true, 'a dispatched row cannot be sent twice')
assert.equal(runButton(tree, '正在跑的').props.disabled, true, 'a running row cannot be sent again')
assert.equal(runButton(tree, '目标丢了的').props.disabled, true, 'a stranded row cannot be dispatched')
assert.ok(
  runButton(tree, '目标丢了的').props.title.includes('目标会话已丢失'),
  'the disabled ▶ explains why',
)

// EVERY row states its state, in words. An earlier version labelled only the
// states deemed to "need attention" and left 未派发 / 已完成 silent, which meant
// most rows showed no state at all — the question this chip exists to answer.
// findByClass matches whole class tokens, so ask for the modifier directly.
const STATE_WORDS = ['未派发', '已派发', '进行中', '已完成', '目标会话丢失']
const stateWords = (title) => {
  const row = findByClass(tree, 'dshtb-item').filter((node) => textOf(node).includes(title))[0]
  return findByClass(row, 'dshtb-chip').map(textOf).filter((t) => STATE_WORDS.includes(t))
}
assert.deepEqual(stateWords('还没派发的'), ['未派发'], 'an undispatched row says 未派发')
assert.deepEqual(stateWords('已经派发的'), ['已派发'], 'a dispatched row says 已派发')
assert.deepEqual(stateWords('正在跑的'), ['进行中'], 'a running row says 进行中')
assert.deepEqual(stateWords('目标丢了的'), ['目标会话丢失'], 'a stranded row says so')

// Exactly one state chip per row, so the row never contradicts itself.
for (const title of ['还没派发的', '已经派发的', '正在跑的', '目标丢了的']) {
  assert.equal(stateWords(title).length, 1, 'exactly one state chip on ' + title)
}

// A finished row is labelled too, not only implied by the strikethrough. The
// strikethrough itself stays tied to *verification* (the user's own tick), so an
// AI-finished row is labelled 已完成 while still reading at full strength.
snapshot.todos = [todo({ id: 'z', title: '做完的', order: 0, verified: true })]
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()
assert.deepEqual(stateWords('做完的'), ['已完成'], 'a finished row says 已完成')
assert.ok(
  findByClass(tree, 'dshtb-item')[0].props.className.includes('done'),
  'a verified row keeps its struck-through styling',
)

snapshot.todos = [todo({ id: 'y', title: 'AI说做完了', order: 0, aiDone: true })]
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()
assert.deepEqual(
  stateWords('AI说做完了'),
  ['已完成'],
  'an AI-finished row is labelled 已完成 before you verify it',
)
console.log('runlock OK')

// A row parked for a *different* reason must not claim the session vanished.
// (The host sends `lostKind`; the browser must trust it.)
snapshot.todos = [
  todo({
    id: 'i',
    title: '图片被拒的',
    order: 0,
    lostAt: 1700000000000,
    lostKind: 'image',
    lostReason: '目标会话的模型不接受图片输入',
    state: 'lost',
  }),
]
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()
const imageRow = findByClass(tree, 'dshtb-item').filter((node) => textOf(node).includes('图片被拒的'))[0]
assert.ok(textOf(imageRow).includes('图片被拒'), 'an image refusal is labelled as such')
assert.ok(
  textOf(imageRow).includes('目标会话丢失') === false,
  'and does NOT claim the target session is gone',
)
assert.ok(
  findByClass(imageRow, 'bad')[0].props.title.includes('换一个支持图片的模型'),
  'its tooltip names the actual way out',
)
console.log('lostkind OK')

// -- the directory field says what an empty value means --------------------

// The composer was folded away by the section test above; bring it back.
tree = click(sectionButton(tree, '新增待办'))
assert.equal(findByClass(tree, 'dshtb-add').length, 1, 'the composer is back')

const dirBox = findByClass(tree, 'dshtb-dir')[0]
assert.ok(dirBox !== undefined, 'the composer carries a directory row')
const dirLabelNode = dirBox.children.find((child) => child.props.className === 'lbl')
assert.ok(dirLabelNode !== undefined, 'the directory field carries a visible label')
assert.equal(textOf(dirLabelNode), '目录', 'and it is not empty')
const dirField = dirBox.children.find((child) => child.type === 'input')
assert.ok(
  dirField.props.placeholder.includes('留空'),
  'the placeholder explains the empty case instead of impersonating a value: ' +
    dirField.props.placeholder,
)
assert.equal(dirField.props.value, '', 'and the field really is empty')
assert.ok(
  dirField.props.title.includes('留空 = 跟随当前会话的工作目录'),
  'the tooltip states what the value decides',
)
console.log('dirfield OK')

// -- each fact is stated once per row --------------------------------------
//
// The directory lives in the facts line in full, so it must NOT also be a chip
// repeating just the basename. The schedule is the mirror image: it lives in its
// own chip and must NOT also be repeated in the facts line.

snapshot.todos = [
  todo({ id: 's', title: '带定时的', order: 0, schedule: '2030-01-02T03:04', dirPath: CWD }),
  todo({ id: 'n', title: '不定时的', order: 1, schedule: '' }),
]
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()

const rowFor = (title) =>
  findByClass(tree, 'dshtb-item').filter((node) => textOf(node).includes(title))[0]

const scheduledRow = rowFor('带定时的')
const factsText = textOf(findByClass(scheduledRow, 'dshtb-facts')[0])
assert.ok(factsText.includes('目录 ' + CWD), 'the facts line still names the directory in full')
assert.ok(
  factsText.includes('定时') === false,
  'the facts line no longer repeats the schedule: ' + factsText,
)
assert.ok(
  findByClass(scheduledRow, 'dshtb-chip').filter((c) => textOf(c).includes('01-02')).length === 1,
  'the schedule is carried by exactly one chip',
)

// The directory is not chipped anywhere on the row.
const chipTexts = findByClass(scheduledRow, 'dshtb-chip').map(textOf)
assert.ok(
  chipTexts.includes('plugin') === false,
  'no chip repeats the directory basename: ' + JSON.stringify(chipTexts),
)

// A row with no schedule still offers a way to set one.
const unscheduledRow = rowFor('不定时的')
const quiet = findByClass(unscheduledRow, 'quiet')
assert.equal(quiet.length, 1, 'an unscheduled row carries a way to add a time')
assert.equal(textOf(quiet[0]), '\u25F4 不定时', 'and it reads as unscheduled')
assert.equal(
  findByClass(unscheduledRow, 'dshtb-facts')[0] === undefined,
  false,
  'the facts line is still rendered',
)
console.log('rowfacts OK')

// -- an existing row can set, change, and clear its schedule ---------------

const quietButton = findByClass(unscheduledRow, 'quiet')[0]
assert.equal(typeof quietButton.props.onClick, 'function', 'the chip is clickable')
quietButton.props.onClick({ preventDefault() {}, stopPropagation() {} })
tree = render()

// The picker replaces the chip in place, seeded with the current (empty) value.
const pickerRow = rowFor('不定时的')
const picker = findByClass(pickerRow, 'dshtb-whenedit')[0]
assert.ok(picker !== undefined, 'clicking the chip opens an inline time picker')
assert.equal(picker.props.value, '', 'seeded with the row’s current (absent) time')
assert.equal(picker.props.type, 'datetime-local', 'and it is a real time control')

// Typing a value and confirming patches the row through the same route the
// composer uses, rather than a second code path.
const beforePatch = calls.length
picker.props.onChange({ target: { value: '2031-05-06T07:08' } })
tree = render()
const confirmButton = findByClass(rowFor('不定时的'), 'dshtb-whenchip')[0].children.find(
  (child) => textOf(child) === '\u2713',
)
assert.ok(confirmButton !== undefined, 'the picker offers a confirm control')
confirmButton.props.onClick({ preventDefault() {}, stopPropagation() {} })
await new Promise((resolve) => setTimeout(resolve, 0))
const lastCall = calls[calls.length - 1]
assert.equal(calls.length, beforePatch + 1, 'confirming sends exactly one request')
assert.equal(lastCall.action, 'patch', 'through the panel’s patch action')
assert.equal(lastCall.id, 'n', 'for the row that was edited')
assert.equal(lastCall.patch.schedule, '2031-05-06T07:08', 'carrying the chosen time')

// Changing an existing time is the same control, seeded with what is set.
tree = render()
const timeChip = findByClass(rowFor('带定时的'), 'dshtb-chip').find((c) => textOf(c).includes('01-02'))
timeChip.props.onClick({ preventDefault() {}, stopPropagation() {} })
tree = render()
assert.equal(
  findByClass(rowFor('带定时的'), 'dshtb-whenedit')[0].props.value,
  '2030-01-02T03:04',
  're-opening the picker seeds it with the existing time, so it can be changed',
)

// Escape closes without touching the board.
const openRow = rowFor('带定时的')
findByClass(openRow, 'dshtb-whenedit')[0].props.onKeyDown({ key: 'Escape', preventDefault() {} })
tree = render()
assert.equal(findByClass(rowFor('带定时的'), 'dshtb-whenedit').length, 0, 'Escape closes the picker')

// The ✕ beside a set time clears it, and is a sibling so its click is unambiguous.
const clearX = findByClass(rowFor('带定时的'), 'x')[0]
assert.ok(clearX !== undefined, 'a set time carries its own clear control')
assert.equal(typeof clearX.props.onClick, 'function', 'which is clickable')
const beforeClear = calls.length
clearX.props.onClick({ preventDefault() {}, stopPropagation() {} })
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(calls[calls.length - 1].patch.schedule, '', 'clearing sends an empty schedule')
assert.equal(calls.length, beforeClear + 1, 'and sends exactly one request')
console.log('rowsech OK')

// -- the scope tabs actually scope ----------------------------------------
//
// The bug this exists for: `cwd` and `currentId` were both read off a store key
// that does not exist (`s.current`), so they collapsed to `''` / `undefined`.
// 「当前目录」 then compared every row's `dir` against `''`, and 「当前会话」
// compared `sourceSessionId` against `undefined` — neither can ever match, so
// both tabs listed nothing while the row labels (which come from the host
// payload) kept showing the right directory. The fixture is what hid it: it
// spelled a `current` field the real store never sends.
//
// So this test asserts on ROWS, not on chrome: a tab that is highlighted but
// lists nothing is exactly the failure mode being guarded.
snapshot.todos = [
  todo({ id: 'both', title: '同目录同会话', order: 0 }),
  // Planned by s2, so it runs in s2 — and the panel must NOT list it under s1
  // merely because it shares this directory. That conflation is the bug.
  todo({ id: 'dir', title: '同目录异会话', order: 1, sourceSessionId: 's2', ownerSessionId: 's2', updatedAt: 5 }),
  todo({
    id: 'other',
    title: '异目录同会话',
    order: 2,
    dir: 'd:\\elsewhere',
    dirPath: 'D:\\elsewhere',
  }),
  // Planned by s2 but OWNED by s1: a handed-off row. Grouping by planner would
  // hide it from the session that actually has to run it, so ownership is what
  // the tab narrows on.
  todo({
    id: 'handed',
    title: '交接来的',
    order: 3,
    sourceSessionId: 's2',
    dir: 'd:\\elsewhere',
    dirPath: 'D:\\elsewhere',
  }),
]
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()

/** Row titles in the OPEN list. `dshtb-t` is the title node, so chips and facts cannot leak in. */
const openTitles = () => findByClass(tree, 'dshtb-t').map(textOf)
const scopeTab = (label) =>
  findByClass(tree, 'dshtb-seg')[0].children.filter((node) => textOf(node).includes(label))[0]

// The default tab is 「当前会话」, and it has to agree with what the rows say.
assert.deepEqual(
  openTitles(),
  ['同目录同会话', '异目录同会话', '交接来的'],
  'the default 「当前会话」 tab lists the rows this session OWNS — including one it did not plan',
)
assert.ok(
  textOf(scopeTab('当前会话')).includes('3'),
  'and its count is ownership-based, not zero and not everything',
)

tree = click(scopeTab('当前目录'))
assert.deepEqual(
  openTitles(),
  ['同目录异会话', '同目录同会话'],
  '「当前目录」 narrows by directory — and still groups by owner inside it, so s2\'s newer box leads',
)

tree = click(scopeTab('全部'))
assert.deepEqual(
  openTitles(),
  ['同目录异会话', '同目录同会话', '异目录同会话', '交接来的'],
  '「全部」 is the union, grouped by owning session and ordered box-first — s2 moved last, so its box floats',
)

// The rows are grouped into EXECUTION boxes now, not listed flat: box headers
// name who runs the rows, and on the wide views they carry the directory too.
const boxTitles = () => findByClass(tree, 'dshtb-group').map(textOf)
assert.deepEqual(
  boxTitles(),
  ['后台会话 · plugin', '会话 · plugin'],
  'every box names its session, and the wide views add the directory it runs in',
)

tree = click(scopeTab('当前会话'))
assert.deepEqual(
  openTitles(),
  ['同目录同会话', '异目录同会话', '交接来的'],
  'and the tabs still work after switching',
)
// 「当前会话」 is one box by construction, and it drops the directory suffix —
// the whole point of that tab is the session you are standing in.
assert.deepEqual(boxTitles(), ['会话'], 'the default tab is a single box, named without a directory')
console.log('scope   OK')

// -- containers: a row that takes its children with it ------------------------
//
// The shape this feature exists for: todo2 is a `newSession` container, todo3
// hangs under it and travels into the session todo2 opens, and todo4 sits below
// todo2 in the list but belongs to THIS session — so it runs here after the
// handoff instead of being carried away.
snapshot.todos = [
  todo({ id: 'todo1', title: '第一步', order: 0 }),
  todo({ id: 'todo2', title: '第二步开新会话', order: 1, mode: 'newSession' }),
  todo({
    id: 'todo3',
    title: '带走的子级',
    order: 2,
    ownerSessionId: '',
    runIn: { kind: 'after', id: 'todo2' },
  }),
  todo({ id: 'todo4', title: '留在本会话', order: 3 }),
]
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()

assert.deepEqual(
  openTitles(),
  ['第一步', '第二步开新会话', '带走的子级', '留在本会话'],
  'a child owned by a session that does not exist yet still shows on its container\'s tab',
)
const nests = () =>
  findByClass(tree, 'dshtb-item').map((node) => {
    const title = findByClass(node, 'dshtb-t')[0]
    return (title === undefined ? '?' : textOf(title)) + ':' + node.props['data-dshtb-nest']
  })
assert.deepEqual(
  nests(),
  ['第一步:0', '第二步开新会话:0', '带走的子级:1', '留在本会话:0'],
  'only the container\'s child is indented — todo4 sits below todo2 without being owned by it',
)
console.log('nesting OK')

// -- the spawned session's own view -----------------------------------------
//
// v0.13.1, problem 2: a `newSession` container that has spawned must be OWNED
// by the session it opened — the host now reports `ownerSessionId` from where
// the row runs, not where it was planned. Standing in the spawned session
// (s2), the board has to list the container AND its still-undispatched
// children, because `effectiveTarget` of a child resolves through the spawned
// container to s2. Before the fix the host shipped the planner as owner for
// the container, the spawned session's tab counted 3 and rendered zero rows.
snapshot.todos = [
  todo({
    id: 'container',
    title: '容器：开出的会话',
    order: 0,
    mode: 'newSession',
    runSessionId: 's2',
    ownerSessionId: 's2',
  }),
  todo({
    id: 'kid1',
    title: '跟过去的子级一',
    order: 1,
    ownerSessionId: 's2',
    runIn: { kind: 'after', id: 'container' },
  }),
  todo({
    id: 'kid2',
    title: '跟过去的子级二',
    order: 2,
    ownerSessionId: 's2',
    runIn: { kind: 'after', id: 'container' },
  }),
]
activeSessions = sessionsSnapshotFromSpawned()
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()

assert.deepEqual(
  openTitles(),
  ['容器：开出的会话', '跟过去的子级一', '跟过去的子级二'],
  'the session a container opened OWNS the container and its children — 3 rows, not 0',
)
assert.equal(
  textOf(scopeTab('当前会话')).includes('3'),
  true,
  'and the tab counts all three',
)
activeSessions = null
console.log('spawned OK')

// -- orphans: a child whose parent is out of scope -----------------------------
//
// v0.13.1, same release: `boxTree` used to bucket every `after` row under its
// parent and then only walk from roots present in scope — a child whose parent
// is missing from the scope (verified away, another tab, or a container owned
// by a different session) was silently DROPPED: counted nowhere, rendered
// nowhere. The fix promotes it to a root instead. This fixture has the child
// on this tab with its parent absent, and the assert is that it still renders.
snapshot.todos = [
  todo({ id: 'gone', title: '已被验收的父级', order: 0, verified: true }),
  todo({
    id: 'orphan',
    title: '父级已验收的子级',
    order: 1,
    runIn: { kind: 'after', id: 'gone' },
  }),
]
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()

// `openTitles` reads the whole tree, and the verified parent legitimately
// renders in the 已完成 section below — so scope the read to the open list's
// own container (`.dshtb-list` wraps only the queue).
const openListTitles = () =>
  findByClass(findByClass(tree, 'dshtb-list')[0], 'dshtb-t').map(textOf)
assert.deepEqual(
  openListTitles(),
  ['父级已验收的子级'],
  'an orphaned child still renders — promoted to a root instead of silently dropped',
)
assert.equal(
  findByClass(tree, 'dshtb-item')[0].props['data-dshtb-nest'],
  '0',
  'and it renders un-nested: there is no parent here to nest under',
)
console.log('orphan  OK')

snapshot.todos = [todo({ id: 'c', title: '已验收的', verified: true })]
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()
tree = click(findByClass(tree, 'dshtb-fold')[0])
assert.ok(
  textOf(findByClass(tree, 'dshtb-pill')[0]).includes('当前会话已清空'),
  'an empty board says so instead of naming a task',
)
console.log('empty   OK')

// -- switchable skins ------------------------------------------------------
//
// Four looks, one cycle control in the title bar. What the tests pin down is
// what can silently rot: that a switch actually reaches the DOM attribute the
// stylesheets are scoped by, that it is remembered, that it survives parking the
// panel, and that an id no longer shipped falls back instead of leaving the
// panel wearing nothing.

snapshot.todos = [todo({ id: 'a', title: '下一条要做的', order: 0 })]
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()

const skinRoot = () => findByClass(tree, 'dshtb-root')[0]
const skinButton = () => findByClass(tree, 'dshtb-skin')[0]

// The previous test parks the panel to check the empty line, so start from the
// expanded state the title-bar control lives in.
const parkedButton = findByClass(tree, 'dshtb-pill')[0]
if (parkedButton !== undefined) tree = click(parkedButton)
assert.ok(findByClass(tree, 'dshtb-card')[0] !== undefined, 'the panel is expanded to test the skin control')

assert.equal(skinRoot().props['data-dshtb-skin'], 'ticket', 'the default skin is the blue-and-white look')
assert.ok(skinButton() !== undefined, 'the title bar carries the skin control')

// The control must not be confused with the fold control: they are separate
// buttons in the same row, and nothing may find one while looking for the other.
assert.equal(findByClass(tree, 'dshtb-fold').length, 1, 'the fold control is still its own button')

const firstGlyph = textOf(skinButton())
tree = click(skinButton())
assert.equal(skinRoot().props['data-dshtb-skin'], 'plain', 'clicking steps to the second skin')
assert.notEqual(textOf(skinButton()), firstGlyph, 'the control shows which skin is now on')
assert.equal(storage.get('dsh.todoBoard.skin.v1'), 'plain', 'the choice is persisted')

tree = click(skinButton())
assert.equal(skinRoot().props['data-dshtb-skin'], 'dense', 'clicking again steps to the third skin')

// The fourth look is a palette, not a layout: same sheet, GUI tokens bound in.
// It has to be reachable by the same one-click cycle, or it is not a skin.
tree = click(skinButton())
assert.equal(
  skinRoot().props['data-dshtb-skin'],
  'theme',
  'the theme-following look is part of the cycle too',
)
assert.ok(
  (headStyles.find((node) => node.getAttribute('data-dsh-todo-board-skin') === 'theme') || {})
    .textContent.includes('--dsw-alias-bg-overlay'),
  'and it really re-binds the palette to the GUI tokens',
)

tree = click(skinButton())
assert.equal(skinRoot().props['data-dshtb-skin'], 'ticket', 'and the cycle wraps to the default')

// The tooltip has to name the skin it is about to leave, or the button is a
// guess. It is read from the same table the cycle walks.
tree = click(skinButton())
assert.ok(
  skinButton().props.title.includes('素白'),
  'the tooltip names the active skin: ' + skinButton().props.title,
)
assert.ok(
  skinButton().props.title.includes('素白') && skinButton().props['aria-label'].includes('素白'),
  'and the accessible name agrees with the tooltip',
)

// Parking the panel must not drop the skin: it is the same panel.
tree = click(findByClass(tree, 'dshtb-fold')[0])
assert.equal(findByClass(tree, 'dshtb-card').length, 0, 'the panel is parked')
assert.equal(
  skinRoot().props['data-dshtb-skin'],
  'plain',
  'the parked line wears the same skin as the expanded panel',
)

// A reload picks the stored skin back up...
storage.set('dsh.todoBoard.skin.v1', 'dense')
tree = remount()
assert.equal(skinRoot().props['data-dshtb-skin'], 'dense', 'a stored skin is restored on mount')

// ...and an id this build no longer ships falls back rather than applying
// nothing (which would leave the panel with no skin rules at all).
storage.set('dsh.todoBoard.skin.v1', 'a-skin-that-was-removed')
tree = remount()
assert.equal(skinRoot().props['data-dshtb-skin'], 'ticket', 'an unknown stored skin falls back')

storage.delete('dsh.todoBoard.skin.v1')
tree = remount()
assert.equal(skinRoot().props['data-dshtb-skin'], 'ticket', 'and an absent one uses the default')
console.log('skins   OK')

// -- the skins are stylesheets, and every one of them is actually injected --
//
// The attribute above proves which skin is *selected*; it says nothing about
// whether the rules for it exist on the page. A skin whose block was never
// injected still sets the attribute and still reports its name — and renders
// the default look, which is precisely the failure that would look like "the
// switch does nothing" rather than like a bug.

assert.ok(
  headStyles.some((node) => node.getAttribute('data-dsh-todo-board-skin') === 'plain'),
  'the plain skin stylesheet is injected',
)
assert.ok(
  headStyles.some((node) => node.getAttribute('data-dsh-todo-board-skin') === 'dense'),
  'the dense skin stylesheet is injected',
)
assert.ok(
  headStyles.some((node) => node.getAttribute('data-dsh-todo-board-skin') === 'theme'),
  'the theme skin stylesheet is injected',
)
assert.ok(
  headStyles.some((node) => node.getAttribute('data-dsh-todo-board') === ''),
  'the base stylesheet is injected',
)
// v0.13.1: every tag we inject must claim its module id. dsh-client-modules'
// claimStyles adopts any untagged <style> for whichever plugin materializes
// next, and that plugin's HMR replace then deletes it — the base sheet losing
// its mark is how a whole panel's styling vanishes on an unrelated plugin's
// code change.
assert.ok(
  headStyles
    .filter((node) => node.getAttribute('data-dsh-todo-board') === '')
    .every((node) => node.getAttribute('data-plugin') === 'dsh-todo-board'),
  'every injected style tag is marked data-plugin=dsh-todo-board (no orphan styles to be claimed and deleted by another plugin\'s HMR)',
)

// The looks must be different looks, not one block registered twice: the
// optional sheets have to differ from each other and from the base.
const sheetOf = (id) =>
  (headStyles.find((node) => node.getAttribute('data-dsh-todo-board-skin') === id) || {}).textContent
for (const id of ['plain', 'dense', 'theme']) {
  for (const other of ['plain', 'dense', 'theme'].filter((entry) => entry !== id)) {
    assert.notEqual(sheetOf(id), sheetOf(other), id + ' and ' + other + ' are different sheets')
  }
}

// Every rule in an optional sheet must be scoped to its own skin, or selecting
// one skin would restyle the others — and, worse, anything a scoped selector
// missed would leak out of the panel onto the rest of the GUI.
for (const id of ['plain', 'dense', 'theme']) {
  // Comments are stripped first: they carry prose (and punctuation) that a
  // brace-splitting scan would otherwise read as part of a selector.
  const body = sheetOf(id).replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = body.split('}').filter((chunk) => chunk.includes('{'))
  assert.ok(rules.length > 0, 'the ' + id + ' sheet has rules')
  for (const rule of rules) {
    const selector = rule.split('{')[0].trim()
    assert.ok(
      selector.includes('[data-dshtb-skin="' + id + '"]'),
      'every ' + id + ' rule is scoped to its own skin: ' + selector,
    )
    assert.ok(
      selector.startsWith('.dshtb-root'),
      'and none of them can escape the panel: ' + selector,
    )
  }
}
console.log('skincss OK')

// -- a skin may restyle text, never delete it ------------------------------
//
// `font-size:0` and `display:none` are how a stylesheet silently removes a
// label, and no tree-walking test above can see it: the node is still in the
// tree, still has its text, and renders blank. Two rules matter most, because
// each is the only place its fact is stated — a section header is what a folded
// section is hiding, and a group heading is the directory a row belongs to.

const labelRules = []
for (const id of ['plain', 'dense', 'theme']) {
  const body = sheetOf(id).replace(/\/\*[\s\S]*?\*\//g, '')
  for (const rule of body.split('}').filter((chunk) => chunk.includes('{'))) {
    const [selector, declarations] = [rule.split('{')[0].trim(), rule.split('{')[1] || '']
    // Only rules aimed at a label-bearing node are checked; a rule that hides a
    // decorative ::after or a resize grip is not hiding information.
    const labelBearing =
      /\.dshtb-(sect|group|t|facts|empty|title)(?![\w-])/.test(selector) &&
      selector.includes('::after') === false
    if (labelBearing) labelRules.push({ id, selector, declarations })
  }
}

assert.ok(labelRules.length > 0, 'the skins do restyle label-bearing nodes')
for (const rule of labelRules) {
  assert.ok(
    /font-size\s*:\s*0(?![.\d])/.test(rule.declarations) === false,
    'skin ' + rule.id + ' must not set font-size:0 on a label: ' + rule.selector,
  )
  assert.ok(
    /display\s*:\s*none/.test(rule.declarations) === false,
    'skin ' + rule.id + ' must not remove a label outright: ' + rule.selector,
  )
}
console.log('skintext OK')

// -- pasting images into the composer --------------------------------------
//
// Images are attached by pasting into the composer; the file-picker button is
// gone. The contract that matters is not "images get attached" but *when the
// paste is intercepted*: a text paste must reach the textarea untouched, or the
// main way of writing a task breaks in order to support a side one.

snapshot.todos = [todo({ id: 'a', title: '下一条要做的', order: 0 })]
await new Promise((resolve) => setTimeout(resolve, 0))
tree = remount()
const composer = () => findByClass(tree, 'dshtb-add')[0].children.find((c) => c.type === 'textarea')
/** The panel's per-todo image cap. Must match `MAX_IMAGES` in client.js. */
const MAX_IMAGES = 4
const pasteInto = (clipboard) => {
  const event = pasteEvent(clipboard)
  composer().props.onPaste(event)
  return event
}

assert.equal(typeof composer().props.onPaste, 'function', 'the composer handles paste')
assert.ok(
  composer().props.placeholder.includes('Ctrl+V'),
  'and says so, since there is no picker button left to discover: ' + composer().props.placeholder,
)

// The picker button is gone, nothing else offers a file input, and no standing
// hint occupies the composer while nothing is attached: the capability is named
// by the placeholder, and the attachment area appears only once it has content.
assert.equal(
  findByClass(tree, 'dshtb-attach').length,
  0,
  'the attachment area is absent while nothing is attached (no standing hint)',
)
assert.equal(
  findByText(tree, '截图后在这里').length,
  0,
  'the removed hint text does not come back',
)
assert.ok(
  findByText(tree, 'PNG/JPG/WebP/GIF').length === 0,
  'and neither does its format blurb in the composer',
)
assert.equal(
  findByText(tree, '📎').length,
  0,
  'and no picker label survives anywhere in the panel',
)
assert.equal(
  findByClass(tree, 'dshtb-add')[0].children.filter((c) => c.type === 'input').length,
  0,
  'and nothing offers a file input',
)

// A text paste must not be intercepted.
const textPaste = pasteInto(textClipboard('just some words'))
assert.equal(textPaste.defaultPrevented, false, 'a text paste is NOT intercepted')
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()
assert.equal(findByClass(tree, 'dshtb-thumb').length, 0, 'and attaches nothing')

// An image paste is intercepted and becomes a thumbnail.
const oneImage = pasteInto(imageClipboard([imageFile('shot.png', 'image/png')]))
assert.equal(oneImage.defaultPrevented, true, 'an image paste IS intercepted')
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()
assert.equal(findByClass(tree, 'dshtb-thumb').length, 1, 'the pasted image becomes a thumbnail')

// Removing the standing hint must not remove the counter: that is the thing
// that carries information once something IS attached, and it is now the only
// on-screen statement of the limit.
assert.equal(
  findByClass(tree, 'dshtb-attach').length,
  1,
  'the attachment area appears once an image is attached',
)
assert.ok(
  textOf(findByClass(tree, 'dshtb-attach')[0]).includes('已附 1 / ' + MAX_IMAGES + ' 张'),
  'and the counter reports how many of the limit are used: ' +
    textOf(findByClass(tree, 'dshtb-attach')[0]),
)

// Every format the control advertises must still be accepted: the hint was the
// only place those four extensions were named, so removing it is exactly the
// change that could quietly take the support with it.
for (const [name, type, expected] of [
  ['a.PNG', 'image/png', 'data:image/png;base64,'],
  ['b.jpg', 'image/jpeg', 'data:image/jpeg;base64,'],
  ['c.webp', 'image/webp', 'data:image/webp;base64,'],
  ['d.gif', 'image/gif', 'data:image/gif;base64,'],
]) {
  // A fresh composer per case, so each one stands alone and none of them leaves
  // attachments behind for the test that follows.
  tree = remount()
  const event = pasteInto(imageClipboard([{ name, type, __base64: 'QUJD' }]))
  assert.equal(event.defaultPrevented, true, name + ' is accepted as an image')
  await new Promise((resolve) => setTimeout(resolve, 0))
  tree = render()
  const thumbs = findByClass(tree, 'dshtb-thumb')
  assert.equal(thumbs.length, 1, name + ' attaches exactly one image')
  assert.equal(
    thumbs[0].children.find((c) => c.type === 'img').props.src,
    expected + 'QUJD',
    name + ' keeps its media type through paste',
  )
}

// The extension fallback must survive case and a four-letter extension, since
// it is the only thing standing between a typeless clipboard image and a host
// refusal.
for (const [name, expected] of [
  ['x.jpeg', 'data:image/jpeg;base64,'],
  ['y.JPEG', 'data:image/jpeg;base64,'],
]) {
  tree = remount()
  const event = pasteInto(imageClipboard([{ name, type: '', __base64: 'QUJD' }]))
  assert.equal(event.defaultPrevented, true, 'a typeless ' + name + ' is still an image')
  await new Promise((resolve) => setTimeout(resolve, 0))
  tree = render()
  const thumbs = findByClass(tree, 'dshtb-thumb')
  assert.equal(thumbs.length, 1, 'a typeless ' + name + ' attaches')
  assert.equal(
    thumbs[0].children.find((c) => c.type === 'img').props.src,
    expected + 'QUJD',
    'and resolves its media type from the extension',
  )
}

// Leave the composer empty for the tests that follow.
tree = remount()

// A pasted image with no MIME type must still carry a usable one: the host
// validates strictly and would refuse an undeclared media type outright. A
// typed image is pasted first so this also pins that a typeless one joins it
// rather than replacing it.
pasteInto(imageClipboard([imageFile('typed.png', 'image/png')]))
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()
assert.equal(findByClass(tree, 'dshtb-thumb').length, 1, 'the typed image is attached first')

const typeless = pasteInto(imageClipboard([{ name: 'screenshot.png', type: '', __base64: 'QUJD' }]))
assert.equal(typeless.defaultPrevented, true, 'a typeless image paste is still an image paste')
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()
const thumbs = findByClass(tree, 'dshtb-thumb')
assert.equal(thumbs.length, 2, 'the typeless image is attached too — it does not replace the first')
const srcs = thumbs.map((t) => t.children.find((c) => c.type === 'img').props.src)
assert.ok(
  srcs.some((src) => src.startsWith('data:image/png;base64,')),
  'a typeless clipboard image is sent with the media type its name implies: ' + JSON.stringify(srcs),
)

// Text pasted alongside an image on the same payload is not treated as an image.
tree = remount()
const mixed = pasteInto({
  files: [imageFile('mixed.png', 'image/png')],
  items: [
    { kind: 'string', type: 'text/plain', getAsFile: () => null },
    { kind: 'file', type: 'image/png', getAsFile: () => imageFile('mixed.png', 'image/png') },
  ],
})
assert.equal(mixed.defaultPrevented, true, 'an image on the payload still counts as an image paste')
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()
assert.equal(findByClass(tree, 'dshtb-thumb').length, 1, 'and exactly one image is attached')

// A non-image file paste is left alone: it is not this panel's to consume.
tree = remount()
const notImage = pasteInto(imageClipboard([{ name: 'notes.pdf', type: 'application/pdf' }]))
assert.equal(notImage.defaultPrevented, false, 'a non-image file paste is NOT intercepted')
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()
assert.equal(findByClass(tree, 'dshtb-thumb').length, 0, 'and attaches nothing')

// A file with no type and an extension the host does not admit is refused
// rather than forwarded to fail host-side.
const unknownExt = pasteInto(imageClipboard([{ name: 'mystery.bmp', type: '' }]))
assert.equal(unknownExt.defaultPrevented, false, 'an unadmitted extension is not treated as an image')
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()
assert.equal(findByClass(tree, 'dshtb-thumb').length, 0, 'and attaches nothing')
console.log('paste   OK')

// -- the attachment limit is enforced on paste -----------------------------

tree = remount()
// Fill to the limit, then paste one more.
const room = MAX_IMAGES
const fill = pasteInto(imageClipboard([imageFile('a.png', 'image/png'), imageFile('b.png', 'image/png'), imageFile('c.png', 'image/png'), imageFile('d.png', 'image/png')]))
assert.equal(fill.defaultPrevented, true, 'a full batch paste is intercepted')
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()
assert.equal(findByClass(tree, 'dshtb-thumb').length, room, 'all ' + room + ' images attached')

const overLimit = pasteInto(imageClipboard([imageFile('e.png', 'image/png')]))
assert.equal(overLimit.defaultPrevented, true, 'pasting past the limit is still intercepted')
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()
assert.equal(
  findByClass(tree, 'dshtb-thumb').length,
  room,
  'and the extra image is not attached — the limit holds',
)
assert.ok(
  textOf(tree).includes('最多带 ' + room + ' 张'),
  'and the panel says why nothing was attached: ' + textOf(findByClass(tree, 'dshtb-err')[0] || { children: [] }),
)

// A batch that overflows a partially-filled composer attaches what fits and
// says so, rather than silently dropping the rest or refusing the paste.
tree = remount()
pasteInto(imageClipboard([imageFile('1.png', 'image/png'), imageFile('2.png', 'image/png')]))
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()
assert.equal(findByClass(tree, 'dshtb-thumb').length, 2, 'two images attached first')
pasteInto(imageClipboard([
  imageFile('3.png', 'image/png'),
  imageFile('4.png', 'image/png'),
  imageFile('5.png', 'image/png'),
]))
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()
assert.equal(findByClass(tree, 'dshtb-thumb').length, room, 'a partial batch fills the remaining room')
assert.ok(
  textOf(tree).includes('只粘贴了前 2 张'),
  'and the panel reports how many it took: ' + textOf(findByClass(tree, 'dshtb-err')[0] || { children: [] }),
)

// The pasted bytes must reach the board: the whole point of attaching them is
// that they ride along with the todo when it is created.
const beforeAdd = calls.length
composer().props.onChange({ target: { value: '带粘贴图片的待办' } })
tree = render()
// The add control is the button inside the composer row, not whatever ancestor
// happens to contain the glyph first.
const addButton = findByClass(tree, 'dshtb-add')[0].children.find(
  (child) => child.type === 'button' && textOf(child) === '\uFF0B',
)
assert.ok(addButton !== undefined, 'the composer offers an add control')
click(addButton)
await new Promise((resolve) => setTimeout(resolve, 0))
const created = calls[calls.length - 1]
assert.equal(calls.length, beforeAdd + 1, 'adding sends exactly one request')
assert.equal(created.action, 'create', 'through the create action')
// The same dead read that emptied the scope tabs also emptied these three: with
// `cwd`/`currentId` collapsed, a row created from the panel was filed under NO
// directory (`dir: ''`) and NO origin session — and that is PERSISTED, so the
// row then never matches 「当前目录」, never shows a session chip, and has no
// session to continue in. A code fix cannot repair rows already written, so it
// has to be pinned at the boundary where they are written.
assert.equal(created.dir, CWD, 'a row created with no directory typed is filed under the session cwd')
assert.equal(created.sessionId, 's1', 'and carries the origin session it came from')
assert.equal(created.sessionTitle, '会话', 'with that session\'s title, so the chip can name it')
assert.equal(created.images.length, room, 'carrying every pasted image: ' + created.images.length)
assert.ok(
  created.images.every((image) => typeof image.data === 'string' && image.data !== '' && typeof image.mediaType === 'string' && image.mediaType !== ''),
  'each with the base64 payload and a declared media type the host admits',
)
console.log('pastelimit OK')

// ------------------------------------------------------------- log view
//
// The log is a developer surface that must stay out of a normal user's way,
// while still being reachable the moment something breaks. Three properties
// carry that, and each is asserted here because each can regress invisibly:
//
//   1. the board view never requests log content;
//   2. the button advertises itself only when an error/warn is unread;
//   3. opening it shows records, filters them, and can export them.

tree = remount()
assert.equal(logRequests.length, 0, 'the board view never asks the host for log content')

// The button carries no dot while nothing has gone wrong that the user has not
// seen; a permanently-lit dot would be noise and would stop meaning anything.
const logButton = () => findByClass(tree, 'dshtb-log').filter((node) => node.type === 'button')[0]
assert.ok(logButton() !== undefined, 'the title bar carries a log control')
assert.equal(
  findByClass(tree, 'dshtb-dot').length,
  0,
  'no dot before anything has been acknowledged-vs-unread',
)

// Opening the view fetches immediately rather than waiting up to a full poll.
tree = click(logButton())
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()
assert.ok(logRequests.length >= 1, 'opening the log view asks the host for records')
assert.equal(logRequests[0], 0, 'the first request asks from the beginning')
assert.equal(findByClass(tree, 'dshtb-logview').length, 1, 'the log page replaces the board')
assert.equal(findByClass(tree, 'dshtb-add').length, 0, 'and the composer is not rendered behind it')

// Default filters: error+warn, own plugin only. That is what the dot points at.
const logRows = () => findByClass(tree, 'dshtb-logrow')
const rowText = () => logRows().map((row) => textOf(row)).join('\n')
assert.ok(logRows().length > 0, 'records are listed')
assert.ok(rowText().includes('新建会话失败'), 'the error is shown')
assert.ok(rowText().includes('派发失败'), 'so is the warn')
assert.ok(!rowText().includes('启动完成'), 'info is filtered out by default')
assert.ok(!rowText().includes('debug detail'), 'debug is filtered out by default')
assert.ok(
  !rowText().includes('other plugin failed'),
  'another plugin\'s record is hidden while the source filter is 「本插件」',
)

// **The poll must keep feeding the OPEN view.** The interval is installed once
// on mount, so anything it reads has to see the CURRENT state — a stale
// `logOpen` closure leaves the page frozen at whatever the open-effect fetched,
// which looks like a working viewer that simply never shows anything new. The
// shim's interval is captured rather than fired, so this drives it by hand.
// The LAST registered callback belongs to the current mount (earlier mounts
// registered their own, and this suite remounts many times).
//
// This runs before the filter assertions below because it appends a record; the
// fixture those assertions describe is the one captured so far.
const tick = intervals[intervals.length - 1]
assert.equal(typeof tick, 'function', 'the panel installs a polling interval')
const beforeTick = logRequests.length
const newestBefore = logLines[logLines.length - 1].sn
logLines.push({
  sn: 60,
  ts: 1700000005000,
  level: 'error',
  source: 'dsh-todo-board',
  logger: 'dsh-todo-board',
  detail: 'arrived while the log view was open',
})
tick()
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()
assert.ok(
  logRequests.length > beforeTick,
  'the poll keeps fetching logs while the view is open (a stale closure would stop here)',
)
assert.equal(
  logRequests[logRequests.length - 1],
  newestBefore,
  'and asks from the newest cursor it already holds, not from zero',
)
assert.ok(
  textOf(tree).includes('arrived while the log view was open'),
  'so a record that arrives while the page is open shows up on the next tick',
)
assert.ok(
  textOf(logRows()[0]).includes('arrived while the log view was open'),
  'and it lands at the top, like every other newest record',
)
// Drop it again, so the ordering assertion below still describes the base fixture.
logLines.pop()
tree = remount()
tree = click(logButton())
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()

// Newest first: the thing that just broke should be at the top without scrolling.
assert.ok(
  textOf(logRows()[0]).includes('新建会话失败'),
  'the newest matching record is first',
)

// Level filters are additive toggles.
const errorButton = () =>
  findByClass(tree, 'dshtb-logbar')[0].children.find(
    (child) => child.type === 'button' && textOf(child) === 'error',
  )
const infoButton = () =>
  findByClass(tree, 'dshtb-logbar')[0].children.find(
    (child) => child.type === 'button' && textOf(child) === 'info',
  )
tree = click(infoButton())
assert.ok(rowText().includes('启动完成'), 'turning on info adds info records')
tree = click(errorButton())
assert.ok(!rowText().includes('新建会话失败'), 'turning off error removes error records')
assert.ok(rowText().includes('派发失败'), 'while the untouched level stays on')

// Every level off would be indistinguishable from "nothing was logged", so the
// last one cannot be switched off. Narrow down to exactly one level first:
// `error` was just turned off and `info` is on, so this leaves only `warn`.
tree = click(infoButton())
assert.ok(rowText().includes('派发失败'), 'warn still shows with info off again')
assert.ok(!rowText().includes('启动完成'), 'and info is gone again')
tree = click(
  findByClass(tree, 'dshtb-logbar')[0].children.find(
    (child) => child.type === 'button' && textOf(child) === 'warn',
  ),
)
assert.ok(rowText().includes('派发失败'), 'the last remaining level cannot be switched off')
tree = click(errorButton())
tree = click(infoButton())

// The source toggle cycles 本插件 -> 其他插件 -> 全部 -> 本插件.
const sourceButton = () =>
  findByClass(tree, 'dshtb-logbar')[0].children.find(
    (child) => child.type === 'button' && /本插件|其他插件|全部/.test(textOf(child)),
  )
tree = click(sourceButton())
assert.equal(textOf(sourceButton()), '其他插件', 'the source toggle advances')
assert.ok(rowText().includes('other plugin failed'), 'other plugins\' records are reachable')
assert.ok(!rowText().includes('派发失败'), 'and ours are excluded in that mode')
tree = click(sourceButton())
assert.equal(textOf(sourceButton()), '全部', 'the toggle reaches 全部')
assert.ok(rowText().includes('other plugin failed') && rowText().includes('派发失败'), '全部 shows both')
tree = click(sourceButton())
assert.equal(textOf(sourceButton()), '本插件', 'and cycles back to our own records')
assert.equal(
  storage.get('dsh.todoBoard.logSource.v1'),
  'self',
  'the chosen source is remembered for next time',
)

// The keyword filter narrows within the active levels and source.
tree = click(infoButton())
const queryBox = findByClass(tree, 'dshtb-logfilter')[0]
queryBox.props.onChange({ target: { value: 'never-matches-this' } })
tree = render()
assert.equal(logRows().length, 0, 'a non-matching keyword empties the list')
assert.ok(
  textOf(tree).includes('当前筛选下没有记录'),
  'and the empty state explains it is the filter, not a lack of logs',
)
queryBox.props.onChange({ target: { value: '派发' } })
tree = render()
assert.equal(logRows().length, 1, 'a matching keyword narrows to the matching record')
queryBox.props.onChange({ target: { value: '' } })
tree = render()

// The dot: lit for an unread error, cleared by opening the view. This is the
// whole "tell the developer without bothering the user" contract.
tree = remount()
tree = click(logButton())
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()
tree = click(logButton()) // close again
assert.equal(findByClass(tree, 'dshtb-logview').length, 0, 'the view closes back to the board')
assert.equal(
  findByClass(tree, 'dshtb-dot').length,
  0,
  'reading the log clears the dot — it does not stay lit forever',
)

// The copy and export paths are assembled client-side, so they get real stubs
// rather than a test-only hook: what matters is that clicking 复制 puts the
// VISIBLE records on the clipboard, and that the file carries a header saying
// what it is.
const copied = []
// Node 24 ships a read-only `navigator`, so this must be defined rather than
// assigned — an assignment throws only on newer runtimes, which would make the
// suite's behaviour depend on the Node version.
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: (value) => (copied.push(value), Promise.resolve()) } },
  configurable: true,
  writable: true,
})
globalThis.Blob = class {
  constructor(parts) {
    this.parts = parts
  }
}
globalThis.URL.createObjectURL = () => 'blob:stub'
globalThis.URL.revokeObjectURL = () => {}

tree = remount()
tree = click(logButton())
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()

const barButton = (label) =>
  findByClass(tree, 'dshtb-logbar')
    .flatMap((bar) => bar.children)
    .find((child) => child.type === 'button' && textOf(child) === label)

const beforeCopy = copied.length
assert.ok(barButton('复制') !== undefined, 'the log view offers a copy control')
tree = click(barButton('复制'))
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(copied.length, beforeCopy + 1, 'copying puts text on the clipboard')
const clip = copied[copied.length - 1]
assert.ok(clip.includes('新建会话失败'), 'the copied text carries the records on screen')
assert.ok(!clip.includes('启动完成'), 'and respects the active filters, like the list does')
assert.ok(clip.includes('# dsh-todo-board 日志'), 'the copied text is labelled with what it is')
assert.ok(
  clip.includes('请自行确认'),
  'and warns that it may contain paths and other plugins\' context before being shared',
)

assert.ok(barButton('导出') !== undefined, 'the log view offers an export control')
const beforeExport = downloads.length
tree = click(barButton('导出'))
assert.equal(downloads.length, beforeExport + 1, 'exporting produces a download')
assert.ok(
  downloads[downloads.length - 1].filename.endsWith('.txt'),
  'the export is a .txt named for the plugin: ' + downloads[downloads.length - 1].filename,
)

// Clearing the panel's own view must be local: a diagnostic surface that
// deleted the host's evidence would be a trap.
tree = click(barButton('清空显示'))
assert.equal(logRows().length, 0, 'clearing empties the visible list')
assert.ok(
  textOf(tree).includes('清空本面板显示'),
  'and says the clearing was local to the panel',
)

console.log('logs    OK')

// ------------------------------------------------------- settings page (v0.13.3)
//
// The planning-nudge knobs are the one place a user edits how the plugin
// behaves, and the host validates the same values on the way in. Three things
// are worth pinning here, because each one has a plausible way to be wrong:
//
//   1. the button exists in the header and opens a PAGE (not a drawer over the
//      board), closing the log page if it was open — two pages at once is a
//      state the layout has no answer for;
//   2. the two numbers are STRINGS in the draft, so an empty field stays empty
//      instead of silently becoming 0;
//   3. saving sends `{ settings: { nudge, minChars, minEntries } }` through the
//      same `call()` every other panel write uses.
assert.equal(findByClass(tree, 'dshtb-logview').length, 1, 'the log page is still open from the cases above')

// Opening settings from the log page must CLOSE it: the two are both
// replacements for the board body, and two at once is a state with no answer.
const settingsButton = findByClass(tree, 'dshtb-settings')[0]
assert.ok(settingsButton !== undefined, 'the header offers a settings button')
tree = click(settingsButton)
assert.equal(findByClass(tree, 'dshtb-logview').length, 0, 'opening settings closed the log page')
assert.equal(findByClass(tree, 'dshtb-settingsview').length, 1, 'and the settings page is shown')
assert.equal(
  findByClass(tree, 'dshtb-seg').length,
  0,
  'the scope tabs are hidden while the settings page is open',
)
assert.equal(
  findByClass(tree, 'dshtb-foot').length,
  0,
  'and the status line is hidden too, exactly like the log page',
)

const nudgeToggle = findWhere(tree, (props) => props.type === 'checkbox' && props['aria-label'] === '长任务主动提醒我拆分')[0]
assert.ok(nudgeToggle !== undefined, 'the page offers an on/off switch')
assert.equal(nudgeToggle.props.checked, true, 'the switch starts from the saved value (on)')

const numbers = findByClass(tree, 'dshtb-setnum')
assert.equal(numbers.length, 3, 'and three number inputs: 字数, 条目数 and 单次回合最多新开会话')
assert.equal(numbers[0].props.value, '200', '字数 starts from the saved value, as a string')
assert.equal(numbers[1].props.value, '2', '条目数 starts from the saved value, as a string')
assert.equal(
  numbers[2].props.value,
  '10',
  'and the spawn cap starts from its saved value — the default that MAX_PLAN_ITEMS can outrun',
)

// Turning the switch off disables both numbers: a threshold nobody can reach
// while the feature is off is a field that lies about mattering.
nudgeToggle.props.onChange({ target: { checked: false } })
tree = render()
const numbersOff = findByClass(tree, 'dshtb-setnum')
assert.equal(numbersOff[0].props.disabled, true, 'turning the switch off disables 字数')
assert.equal(numbersOff[1].props.disabled, true, 'and 条目数')

// Saving goes through the SAME `call()` every other panel write uses, with the
// three fields under `settings` — the host's `saveSettings` reads exactly that
// shape, so a rename here would be a panel that silently does nothing.
const callsBefore = calls.length
const saveButton = findByClass(tree, 'dshtb-setbtn').find((n) => textOf(n).includes('保存'))
assert.ok(saveButton !== undefined, 'the page offers a 保存 button')
saveButton.props.onClick({ preventDefault() {}, stopPropagation() {} })
await new Promise((resolve) => setTimeout(resolve, 0))
const settingsCalls = calls.slice(callsBefore).filter((c) => c !== null && typeof c === 'object' && c.action === 'settings')
assert.equal(settingsCalls.length, 1, 'saving posts exactly one settings action')
assert.equal(settingsCalls[0].settings.nudge, false, 'the payload carries the switch')
assert.equal(settingsCalls[0].settings.minChars, 200, 'and 字数 as a NUMBER, not the draft string')
assert.equal(settingsCalls[0].settings.minEntries, 2, 'and 条目数 as a number too')
assert.equal(
  settingsCalls[0].settings.maxTurnSessions,
  10,
  'and the spawn cap, also as a number — a string here would be rejected by the host',
)
tree = render()

console.log('settings OK')

// ------------------------------------------------- polling visibility (v0.13.3)
//
// The panel used to poll every 2.5s unconditionally — including while the tab
// was hidden, where nothing reads the result. The fix suspends the interval and
// re-arms it on return. Both halves are asserted here, because either one alone
// is a plausible half-fix: stopping without re-arming freezes the panel on
// return, and re-arming without an immediate refresh shows stale data for a
// whole tick.
{
  // Counting intervals is unreliable here: other effects install their own.
  // What actually matters is BEHAVIOUR — while hidden the poll must not fetch,
  // and on return it must fetch right away.
  const hiddenCallsBefore = fetchCount.value
  setVisibility('hidden')
  // Fire only the intervals that are still live. A suspended poll has had its
  // interval cleared, so it contributes no callback here — which is exactly the
  // property under test.
  for (const tick of liveTicks()) tick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const fetchedWhileHidden = fetchCount.value - hiddenCallsBefore
  assert.equal(
    fetchedWhileHidden,
    0,
    'a hidden page does not fetch (the interval is suspended, not merely slowed)',
  )

  const visibleCallsBefore = fetchCount.value
  setVisibility('visible')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(
    fetchCount.value > visibleCallsBefore,
    'and it fetches IMMEDIATELY on return rather than waiting out a tick',
  )
  tree = render()
  console.log('poll    OK')
}


// -- v0.9.1: a refused poll explains itself ----------------------------------
//
// The board route now borrows the harness' own gate, which wants the browser
// session cookie DSH issues when you open the URL `dsh web` prints. A missing
// cookie is therefore the one new refusal a user can actually hit, and "HTTP
// 401" on its own would leave the panel looking broken with nothing to act on —
// the failure mode this plugin keeps insisting must name its own cause.

unauthorized = true
tree = remount()
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()
const refusal = textOf(findByClass(tree, 'dshtb-err')[0] || { children: [] })
assert.ok(refusal.includes('401'), 'a refused poll is reported to the user: ' + refusal)
assert.ok(
  refusal.includes('token') && refusal.includes('dsh web'),
  'and names the fix instead of leaving a bare status code: ' + refusal,
)

unauthorized = false
tree = remount()
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()
assert.equal(
  findByClass(tree, 'dshtb-err').length,
  0,
  'and the notice clears as soon as the gate lets the panel back in',
)
console.log('refuse  OK')

// -- the mode hint inside the open list --------------------------------------
//
// One line explaining the mode chip the rows carry. Three things matter about it:
// it is inside the list (not floating somewhere else), it says what it is
// supposed to say, and it is TEXT — a hint that looks like a control is worse
// than no hint, because people click it.

snapshot.todos = [
  todo({ id: 'h1', title: '有行的', order: 0 }),
  todo({ id: 'h2', title: '另一行', order: 1 }),
]
tree = remount()
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()

const HINT_TEXT = '你可以通过点击更改任务执行模式，但不建议任务开始执行后更改'
const listNode = findByClass(tree, 'dshtb-list')[0]
const hintNode = findByClass(tree, 'dshtb-listhint')[0]
assert.ok(listNode !== undefined, 'the open list is rendered')
assert.ok(hintNode !== undefined, 'and the mode hint is rendered')
assert.equal(textOf(hintNode), HINT_TEXT, 'with exactly the wording asked for')
assert.equal(hintNode.type, 'div', 'as plain text, never a control')
assert.ok(
  listNode.children.includes(hintNode),
  'and INSIDE the list, so it travels with the rows it is about',
)
assert.equal(
  listNode.children.filter((child) => child !== null && child.props !== undefined && child.props.className === 'dshtb-listhint').length,
  1,
  'rendered once, not once per row and not once per group',
)

// With no rows there is no mode to change, so the advice would be noise.
snapshot.todos = []
tree = remount()
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()
assert.equal(
  findByClass(tree, 'dshtb-listhint').length,
  0,
  'an empty list carries no mode hint (there is no mode to change)',
)
console.log('modehint OK')

// -- the 已完成 section: ticking the round box MOVES the row -----------------
//
// The point of the section is that a verified row leaves the queue. Everything
// here is therefore about the move — it is out of the open list, it is in the
// completed one, and the two controls that could put it back (the round box, and
// the ✕) still work from where it now sits.

const LONG_NOTE = '第一行\n第二行\n第三行'

snapshot.todos = [
  todo({ id: 'open1', title: '还没做的', order: 0, updatedAt: 50 }),
  todo({ id: 'open2', title: 'AI 做完等你验收', order: 1, aiDone: true, updatedAt: 60 }),
  todo({ id: 'done1', title: '早就验收的', order: 2, verified: true, updatedAt: 10 }),
  todo({ id: 'done2', title: '刚验收的', order: 3, verified: true, updatedAt: 99, note: LONG_NOTE }),
]
tree = remount()
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()

const listRowTitles = () => findByClass(tree, 'dshtb-list').flatMap((node) => findByClass(node, 'dshtb-t')).map(textOf)
const doneRowTitles = () => findByClass(tree, 'dshtb-donelist').flatMap((node) => findByClass(node, 'dshtb-t')).map(textOf)
const doneRow = (title) => findByClass(tree, 'dshtb-donelist').flatMap((node) => findByClass(node, 'dshtb-item')).find((node) => textOf(node).includes(title))

assert.deepEqual(
  listRowTitles(),
  ['还没做的', 'AI 做完等你验收'],
  'a verified row is not in the open list any more',
)
assert.deepEqual(
  doneRowTitles(),
  ['刚验收的', '早就验收的'],
  'it is in the completed list, newest first, so the row you just ticked is on top',
)
assert.ok(
  textOf(sectionButton(tree, '已完成')).includes('已完成 2'),
  'and the section header counts them',
)

// The move itself: the round box on an OPEN row sends verified:true, and once the
// host answers, that row is in the other list.
const beforeVerify = calls.length
tree = click(findByClass(rowFor('还没做的'), 'dshtb-cb').find((node) => node.props['aria-label'] === '用户已验收'))
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(calls.length, beforeVerify + 1, 'ticking the round box sends exactly one request')
assert.deepEqual(
  calls[calls.length - 1],
  { action: 'patch', id: 'open1', patch: { verified: true } },
  'as a patch that verifies that row',
)

snapshot.todos = snapshot.todos.map((row) =>
  row.id === 'open1' ? { ...row, verified: true, updatedAt: 200 } : row,
)
tree = render()
assert.equal(
  listRowTitles().includes('还没做的'),
  false,
  'after the host confirms, the row is gone from the open list',
)
assert.equal(doneRowTitles()[0], '还没做的', 'and it leads the completed list it just moved into')

// The round box in the completed list is the way back — same control, same
// meaning, so un-ticking is not a one-way trip.
const back = doneRow('还没做的')
const backBox = findByClass(back, 'dshtb-cb').find((node) => node.props['aria-label'] === '用户已验收')
assert.equal(backBox.props.className.includes('on'), true, 'the box reads as ticked in the completed list')
const beforeUndo = calls.length
backBox.props.onClick({ preventDefault() {}, stopPropagation() {} })
await new Promise((resolve) => setTimeout(resolve, 0))
assert.deepEqual(
  calls[calls.length - 1],
  { action: 'patch', id: 'open1', patch: { verified: false } },
  'un-ticking it patches verified:false, so the row can come back',
)
assert.equal(calls.length, beforeUndo + 1, 'and sends exactly one request')

// A finished row is out of the queue, so it carries nothing that could reorder
// it: no handle on screen, and no drop handling that would move open rows.
const finishedRow = doneRow('刚验收的')
assert.equal(finishedRow.props.draggable, false, 'a completed row cannot be dragged')
assert.equal(findByClass(finishedRow, 'dshtb-grip').length, 0, 'and shows no drag handle')
assert.equal(finishedRow.props.onDrop, undefined, 'nor is it a drop target')
assert.equal(
  findByClass(rowFor('AI 做完等你验收'), 'dshtb-grip').length,
  1,
  'while an open row still has its handle',
)
console.log('done    OK')

// -- the note: preview under the title, its own editor -----------------------
//
// Host side has carried `note` all along (it is what the dispatched session is
// told); the panel used to hide it, so the context a model would receive was
// invisible until after dispatch. These cases are about seeing it and editing it
// without a length limit and without touching the title editor.

snapshot.todos = [
  todo({ id: 'plain', title: '空白备注的', order: 0 }),
  todo({ id: 'noted', title: '带备注的', order: 1, note: LONG_NOTE, updatedAt: 40 }),
]
tree = remount()
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()

const notedRow = rowFor('带备注的')
const plainRow = rowFor('空白备注的')
const noteNode = findByClass(notedRow, 'dshtb-note')[0]
assert.ok(noteNode !== undefined, 'a note is rendered on the row')
assert.equal(textOf(noteNode), LONG_NOTE, 'with every character of it, newlines included')
assert.equal(noteNode.type, 'div', 'as plain text, not a control')
assert.equal(
  findByClass(plainRow, 'dshtb-note').length,
  0,
  'a row with no note renders no note block at all',
)

// The editor is its own control with its own class: the title editor is a
// different element, and neither can be found while looking for the other.
const noteButton = findByClass(notedRow, 'dshtb-notebtn')[0]
assert.ok(noteButton !== undefined, 'the row offers a note control')
assert.equal(noteButton.type, 'button', 'which is a real button')
assert.equal(
  findByClass(notedRow, 'dshtb-edit').length,
  0,
  'and is not the title editor',
)

noteButton.props.onClick({ preventDefault() {}, stopPropagation() {} })
tree = render()
const area = findByClass(rowFor('带备注的'), 'dshtb-notearea')[0]
assert.ok(area !== undefined, 'opening it reveals a textarea')
assert.equal(area.type, 'textarea', 'a textarea, not a single-line input')
assert.equal(area.props.value, LONG_NOTE, 'seeded with the existing note, so it can be edited')
assert.equal(
  findByClass(rowFor('带备注的'), 'dshtb-note').length,
  0,
  'and the preview gives way to the editor rather than sitting behind it',
)

// Everything typed is sent verbatim: not trimmed, not capped. A silently dropped
// character here would be a lie about the context the model gets.
const huge = '  ' + 'x'.repeat(4000) + '\n尾巴  '
area.props.onChange({ target: { value: huge } })
tree = render()
const beforeNoteSave = calls.length
findByClass(rowFor('带备注的'), 'dshtb-notesave')[0].props.onClick({ preventDefault() {}, stopPropagation() {} })
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(calls.length, beforeNoteSave + 1, 'saving sends exactly one request')
assert.equal(calls[calls.length - 1].action, 'patch', 'through the panel patch action')
assert.equal(calls[calls.length - 1].id, 'noted', 'for the row that was edited')
assert.equal(
  calls[calls.length - 1].patch.note,
  huge,
  'carrying the note byte for byte (no trim, no cap)',
)

// Enter saves; Shift+Enter must keep making lines.
const reopen = () => {
  findByClass(rowFor('带备注的'), 'dshtb-notebtn')[0].props.onClick({ preventDefault() {}, stopPropagation() {} })
  return render()
}
tree = reopen()
findByClass(rowFor('带备注的'), 'dshtb-notearea')[0].props.onChange({ target: { value: '换行写\n第二行' } })
tree = render()
const beforeShift = calls.length
findByClass(rowFor('带备注的'), 'dshtb-notearea')[0].props.onKeyDown({
  key: 'Enter',
  shiftKey: true,
  preventDefault() {},
})
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(calls.length, beforeShift, 'Shift+Enter makes a newline instead of saving')
assert.equal(
  findByClass(rowFor('带备注的'), 'dshtb-notearea')[0].props.value,
  '换行写\n第二行',
  'and the text is still there to keep editing',
)

findByClass(rowFor('带备注的'), 'dshtb-notearea')[0].props.onKeyDown({ key: 'Enter', preventDefault() {} })
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(calls[calls.length - 1].patch.note, '换行写\n第二行', 'plain Enter saves the note')

// Escape abandons the edit: nothing is sent and the preview comes back as it was.
tree = reopen()
findByClass(rowFor('带备注的'), 'dshtb-notearea')[0].props.onChange({ target: { value: '不要保存这段' } })
tree = render()
const beforeEsc = calls.length
findByClass(rowFor('带备注的'), 'dshtb-notearea')[0].props.onKeyDown({ key: 'Escape', preventDefault() {} })
await new Promise((resolve) => setTimeout(resolve, 0))
tree = render()
assert.equal(calls.length, beforeEsc, 'Escape sends nothing')
assert.equal(findByClass(rowFor('带备注的'), 'dshtb-notearea').length, 0, 'and closes the editor')
assert.equal(textOf(findByClass(rowFor('带备注的'), 'dshtb-note')[0]), LONG_NOTE, 'leaving the note untouched')

// Clearing is an edit like any other: an empty textarea saves an empty note.
tree = reopen()
findByClass(rowFor('带备注的'), 'dshtb-notearea')[0].props.onChange({ target: { value: '' } })
tree = render()
findByClass(rowFor('带备注的'), 'dshtb-notesave')[0].props.onClick({ preventDefault() {}, stopPropagation() {} })
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(calls[calls.length - 1].patch.note, '', 'an empty note is saved as an empty note')

// A note can be added to a row that has none, from the same control.
tree = render()
findByClass(rowFor('空白备注的'), 'dshtb-notebtn')[0].props.onClick({ preventDefault() {}, stopPropagation() {} })
tree = render()
assert.equal(
  findByClass(rowFor('空白备注的'), 'dshtb-notearea')[0].props.value,
  '',
  'the same control opens an empty editor for a row that has no note',
)
console.log('note    OK')

console.log('\nall browser-half smoke checks passed')
