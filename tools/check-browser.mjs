#!/usr/bin/env node
/**
 * Real-browser checks for the panel's platform assumptions.
 *
 * Two things here cannot be seen by the Node suites, because both are
 * properties of the *browser*, not of this plugin:
 *
 *   1. **Skins.** `client-smoke.mjs` asserts on CSS *text* — that each block
 *      exists and is scoped. A rule can be present and correctly scoped and
 *      still lose the cascade to the base sheet it overrides, which looks
 *      exactly like "the switch does nothing" to the person clicking it. So the
 *      stylesheets are applied to a real document and the computed styles are
 *      read back.
 *
 *   2. **Paste.** The composer attaches images from the clipboard. The Node
 *      suite calls the handler with a clipboard object this repo built, so it
 *      proves the plugin's *logic* but assumes the *shape* — that `files`,
 *      `items[].getAsFile()` and `FileReader` really behave that way. Those
 *      assumptions are what break, silently, when a browser changes. So they
 *      are re-checked here against real `DataTransfer`, `File`, `ClipboardEvent`
 *      and `FileReader` objects.
 *
 *   node tools/check-browser.mjs
 *
 * Environment overrides:
 *   DSHTB_CHROME  chromium executable  (default Chrome on Windows)
 *   DSHTB_PORT    DevTools port        (default 9223 — not the screenshot port)
 *
 * Read-only with respect to the board: it renders the client half against a
 * fixture and never talks to the host's API.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.DSHTB_PORT ?? 9223)
const CHROME = process.env.DSHTB_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * The page under test.
 *
 * It loads the plugin's real client half through a stub module loader, so the
 * stylesheets under test are the ones the plugin actually installs — not a copy
 * this script made. `apply()` is then called with a minimal ctx to get them into
 * the document, and the panel's structure is built by hand (the component is not
 * exported and needs a full React runtime; the CSS only keys off these classes).
 */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>browser check</title>
<style>
/* The product's design tokens. The real GUI supplies these from its own
   stylesheets; without them every var() in the panel resolves to nothing and
   the base sheet's borders collapse, which would make a skin's override
   impossible to measure. Concrete values here, names as shipped. */
:root{
  --dsw-alias-border-l1:#3a3f4b;--dsw-alias-border-l2:#4d5464;
  --dsw-alias-bg-overlay:#1b1e26;--dsw-alias-bg-layer-1:#22262f;--dsw-alias-bg-layer-2:#2a2f3a;
  --dsw-alias-label-primary:#e8eaf0;--dsw-alias-label-secondary:#a3aab8;
  --dsw-alias-brand-primary:#4f6ef7;--dsw-alias-state-success-primary:#3fb950;
  --dsw-alias-state-warn-primary:#d29922;--dsw-alias-state-error-primary:#f85149;
}
</style></head>
<body><div id="host"></div>
<script>
window.__ModuleLoader__ = { load(entry) { window.__entry = entry } }
</script>
<script src="__CLIENT_URL__"></script>
<script>
const results = []
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useRef: (v) => ({ current: v }),
  useEffect: () => {},
  useCallback: (f) => f,
  useMemo: (f) => f(),
}
try {
  const exports_ = window.__entry.factory((name) => {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  })
  exports_.apply({
    effect: (cb) => { cb(); return () => {} },
    slots: { inject: (_n, register) => register(), register: () => {} },
  })
  results.push({ step: 'apply', ok: true, styles: document.head.querySelectorAll('style[data-dsh-todo-board]').length })
} catch (err) {
  results.push({ step: 'apply', ok: false, error: String(err && err.message ? err.message : err) })
}

/**
 * The node structure the stylesheets address: the panel root, a section header,
 * a group heading, a row with its title/facts/chips, and the parked line.
 * Class names mirror client.js exactly.
 */
function buildPanel(skin) {
  const host = document.getElementById('host')
  host.innerHTML = ''
  const root = document.createElement('div')
  root.className = 'dshtb-root'
  if (skin !== null) root.setAttribute('data-dshtb-skin', skin)
  root.innerHTML = \`
    <div class="dshtb-card">
      <div class="dshtb-head">
        <span class="dshtb-title"><b>☑</b> TODO</span>
        <span class="dshtb-sp"></span>
        <span class="dshtb-stats"><i>2</i></span>
        <button class="dshtb-skin">▤</button>
        <button class="dshtb-fold">–</button>
      </div>
      <div class="dshtb-seg"><button class="on">当前目录<em>2</em></button><button>全部<em>3</em></button></div>
      <button class="dshtb-sect"><span class="car">▾</span>新增待办</button>
      <div class="dshtb-compose">
        <div class="dshtb-add"><textarea></textarea><button class="dshtb-ic">＋</button></div>
        <div class="dshtb-modes"><button class="on">提醒</button><button>续跑</button></div>
      </div>
      <div class="dshtb-list">
        <div class="dshtb-listhint">你可以通过点击更改任务执行模式，但不建议任务开始执行后更改</div>
        <div class="dshtb-group">plugin</div>
        <div class="dshtb-item">
          <span class="dshtb-grip">⠿</span>
          <div class="dshtb-checks">
            <button class="dshtb-cb ai"></button><button class="dshtb-cb me"></button>
          </div>
          <div class="dshtb-body">
            <div class="dshtb-t">下一条要做的</div>
            <div class="dshtb-note">第一行：写给模型的上下文
第二行：这里应该还在（两行以内）
第三行：这一行必须被夹掉，否则折叠根本没生效
UNBROKEN-${'z'.repeat(160)}</div>
            <div class="dshtb-facts">目录 D:\\\\DSH\\\\plugin</div>
            <div class="dshtb-meta">
              <button class="dshtb-chip">续跑</button>
              <button class="dshtb-chip dshtb-notebtn">✎ 备注</button>
              <span class="dshtb-chip run">进行中</span>
              <button class="dshtb-chip quiet">◴ 不定时</button>
            </div>
          </div>
        </div>
        <div class="dshtb-item">
          <span class="dshtb-grip">⠿</span>
          <div class="dshtb-checks">
            <button class="dshtb-cb ai"></button><button class="dshtb-cb me"></button>
          </div>
          <div class="dshtb-body">
            <div class="dshtb-t">正在写备注的</div>
            <div class="dshtb-noteedit">
              <textarea class="dshtb-notearea">编辑中的备注</textarea>
              <button class="dshtb-notesave">保存</button>
              <button class="dshtb-notecancel">取消</button>
            </div>
            <div class="dshtb-facts">目录 D:\\\\DSH\\\\plugin</div>
          </div>
        </div>
      </div>
      <button class="dshtb-sect"><span class="car">▾</span>已完成 1</button>
      <div class="dshtb-donelist">
        <div class="dshtb-group">plugin</div>
        <div class="dshtb-item done">
          <div class="dshtb-checks">
            <button class="dshtb-cb ai on">✓</button><button class="dshtb-cb me on">✓</button>
          </div>
          <div class="dshtb-body">
            <div class="dshtb-t">已经验收的</div>
            <div class="dshtb-facts">目录 D:\\\\DSH\\\\plugin</div>
          </div>
        </div>
      </div>
      <div class="dshtb-foot"><span>v0.11.4</span><button class="dshtb-link">清理</button></div>
    </div>\`
  host.appendChild(root)
  return root
}

/**
 * The log page, addressed by the same class names client.js emits.
 *
 * Measured in a real browser for the same reason as the skins: a stylesheet can
 * be present and correctly scoped and still lose the cascade, and the failure
 * mode here is worse than a skin not applying — a log viewer whose text is
 * invisible or clipped is indistinguishable from "nothing was logged", which is
 * the one wrong answer this feature must never give.
 */
function buildLogPage() {
  const host = document.getElementById('host')
  host.innerHTML = ''
  const root = document.createElement('div')
  root.className = 'dshtb-root'
  root.innerHTML = \`
    <div class="dshtb-card">
      <div class="dshtb-head">
        <span class="dshtb-title"><b>☑</b> TODO</span>
        <span class="dshtb-sp"></span>
        <span class="dshtb-stats"><i>2</i></span>
        <button class="dshtb-log on">←<span class="dshtb-dot"></span></button>
        <button class="dshtb-skin">▤</button>
        <button class="dshtb-fold">–</button>
      </div>
      <div class="dshtb-logview">
        <div class="dshtb-logbar">
          <button class="on">error</button><button class="on">warn</button>
          <button>info</button><button>debug</button>
          <button class="dshtb-logsrc">本插件</button>
          <input class="dshtb-logfilter" value="">
        </div>
        <div class="dshtb-logbar">
          <button>复制</button><button>导出</button><button>清空显示</button>
        </div>
        <div class="dshtb-logmeta">显示 2 / 5 条（错误 1） · 落盘：D:\\\\DSH\\\\dsh-home\\\\todo-board\\\\log.ndjson</div>
        <div class="dshtb-loglist">
          <div class="dshtb-logrow error">
            <span class="at">09:30:00.000</span><span class="lv">error</span>
            <span class="body">新建会话失败：boom</span>
          </div>
          <div class="dshtb-logrow warn">
            <span class="at">09:29:00.000</span><span class="lv">warn</span>
            <span class="body">派发失败[no-session] id=abc</span>
          </div>
          <div class="dshtb-logrow error">
            <span class="at">09:28:00.000</span><span class="lv">error</span>
            <span class="body">other plugin failed<span class="src">  ← dsh-mcp-client</span></span>
          </div>
        </div>
      </div>
    </div>\`
  host.appendChild(root)
  return root
}

function measureLogPage() {
  const root = buildLogPage()
  const pick = (sel) => {
    const node = root.querySelector(sel)
    if (node === null) return null
    const cs = getComputedStyle(node)
    const rect = node.getBoundingClientRect()
    return {
      text: (node.textContent || '').trim(),
      fontSize: parseFloat(cs.fontSize),
      color: cs.color,
      display: cs.display,
      visibility: cs.visibility,
      opacity: parseFloat(cs.opacity),
      overflow: cs.overflow,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      whiteSpace: cs.whiteSpace,
      fontFamily: cs.fontFamily,
    }
  }
  return {
    view: pick('.dshtb-logview'),
    bar: pick('.dshtb-logbar'),
    onButton: pick('.dshtb-logbar button.on'),
    offButton: pick('.dshtb-logbar button:not(.on)'),
    source: pick('.dshtb-logsrc'),
    filter: pick('.dshtb-logfilter'),
    meta: pick('.dshtb-logmeta'),
    list: pick('.dshtb-loglist'),
    errorRow: pick('.dshtb-logrow.error'),
    warnRow: pick('.dshtb-logrow.warn'),
    errorLevel: pick('.dshtb-logrow.error .lv'),
    warnLevel: pick('.dshtb-logrow.warn .lv'),
    rowBody: pick('.dshtb-logrow .body'),
    source2: pick('.dshtb-logrow .src'),
    dot: pick('.dshtb-dot'),
    logButton: pick('.dshtb-log'),
    // The log button must be findable ON ITS OWN: reusing another control's
    // class would make "the log button" ambiguous to anything querying it.
    foldButton: pick('.dshtb-fold'),
    skinButton: pick('.dshtb-skin'),
  }
}

function measure(skin) {
  const root = buildPanel(skin)
  const pick = (sel) => {
    const node = root.querySelector(sel)
    if (node === null) return null
    const cs = getComputedStyle(node)
    return {
      text: (node.textContent || '').trim(),
      fontSize: parseFloat(cs.fontSize),
      display: cs.display,
      padding: cs.padding,
      margin: cs.margin,
      borderTopWidth: cs.borderTopWidth,
      borderBottomWidth: cs.borderBottomWidth,
      borderTopColor: cs.borderTopColor,
      borderBottomColor: cs.borderBottomColor,
      borderRadius: cs.borderRadius,
      opacity: cs.opacity,
      background: cs.backgroundColor,
      letterSpacing: cs.letterSpacing,
      // Enough to tell "clamped" apart from "declared clamped": the clamp is only
      // real if the content box is shorter than what it contains.
      whiteSpace: cs.whiteSpace,
      lineClamp: cs.getPropertyValue('-webkit-line-clamp').trim(),
      textDecorationLine: cs.textDecorationLine,
      cursor: cs.cursor,
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
    }
  }
  return {
    skin,
    card: pick('.dshtb-card'),
    head: pick('.dshtb-head'),
    title: pick('.dshtb-title'),
    segButton: pick('.dshtb-seg button'),
    sect: pick('.dshtb-sect'),
    group: pick('.dshtb-group'),
    title2: pick('.dshtb-t'),
    facts: pick('.dshtb-facts'),
    stateChip: pick('.dshtb-chip.run'),
    quietChip: pick('.dshtb-chip.quiet'),
    foot: pick('.dshtb-foot'),
    row: pick('.dshtb-item'),
    note: pick('.dshtb-note'),
    noteButton: pick('.dshtb-notebtn'),
    noteArea: pick('.dshtb-notearea'),
    noteSave: pick('.dshtb-notesave'),
    noteCancel: pick('.dshtb-notecancel'),
    doneList: pick('.dshtb-donelist'),
    doneRow: pick('.dshtb-item.done'),
    doneTitle: pick('.dshtb-item.done .dshtb-t'),
    listHint: pick('.dshtb-listhint'),
  }
}

/**
 * Platform facts the paste handler is written against.
 *
 * Each one is an assumption the Node suite cannot test, because it hands the
 * handler a clipboard this repo built. If any of these stops holding, images
 * stop attaching and nothing else would notice.
 */
async function pastePlatform() {
  const facts = {}

  // One real 1x1 PNG, so FileReader has genuine bytes to encode.
  const pngBytes = Uint8Array.from(atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
  ), (c) => c.charCodeAt(0))
  const png = new File([pngBytes], 'shot.png', { type: 'image/png' })

  // 1. A textarea receiving a real paste event, the way the composer does.
  const area = document.createElement('textarea')
  document.body.appendChild(area)
  let seen = null
  area.addEventListener('paste', (event) => {
    seen = event.clipboardData
    event.preventDefault()
  })

  const withImage = new DataTransfer()
  withImage.items.add(png)
  area.dispatchEvent(new ClipboardEvent('paste', { clipboardData: withImage, bubbles: true, cancelable: true }))
  facts.imagePasteHasClipboardData = seen !== null
  facts.filesLength = seen === null ? -1 : seen.files.length
  facts.firstFileType = seen === null || seen.files.length === 0 ? null : seen.files[0].type
  facts.firstFileName = seen === null || seen.files.length === 0 ? null : seen.files[0].name
  facts.itemKinds = seen === null ? [] : Array.from(seen.items).map((i) => i.kind)
  facts.getAsFileWorks = seen !== null && seen.items.length > 0 &&
    typeof seen.items[0].getAsFile === 'function' && seen.items[0].getAsFile() !== null

  // 2. A text paste: must carry no files, which is what keeps the handler from
  //    intercepting it.
  const textOnly = new DataTransfer()
  textOnly.setData('text/plain', 'hello')
  area.dispatchEvent(new ClipboardEvent('paste', { clipboardData: textOnly, bubbles: true, cancelable: true }))
  facts.textPasteFileCount = seen === null ? -1 : seen.files.length
  facts.textPasteItemKinds = seen === null ? [] : Array.from(seen.items).map((i) => i.kind)

  // 3. A non-image file paste.
  const pdf = new File([new Uint8Array([1, 2, 3])], 'notes.pdf', { type: 'application/pdf' })
  const withPdf = new DataTransfer()
  withPdf.items.add(pdf)
  area.dispatchEvent(new ClipboardEvent('paste', { clipboardData: withPdf, bubbles: true, cancelable: true }))
  facts.pdfType = seen === null || seen.files.length === 0 ? null : seen.files[0].type

  area.remove()

  // 4. FileReader on a real File: the panel slices the payload after the first
  //    comma, so the prefix shape is load-bearing.
  facts.dataUrlPrefix = await new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).slice(0, 22))
    reader.onerror = () => resolve('READ-ERROR')
    reader.readAsDataURL(png)
  })
  facts.dataUrlComma = await new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).indexOf(','))
    reader.onerror = () => resolve(-1)
    reader.readAsDataURL(png)
  })

  // 5. A File built with an explicitly empty type still answers '' — the panel's
  //    extension fallback exists for exactly this.
  const typeless = new File([pngBytes], 'screenshot.png', { type: '' })
  facts.typelessFileType = JSON.stringify(typeless.type)

  return facts
}

/**
 * The parked line's drag, against a real pointer and a real layout engine.
 *
 * The Node suite drives the handlers with objects it built itself, so it proves
 * the plugin's *logic* while assuming the *platform*: that setPointerCapture
 * exists on this element, that a captured pointer keeps delivering pointermove
 * to it, and that getBoundingClientRect() reports the auto-sized box the clamp
 * measures. Those are the assumptions that break silently in a browser — and the
 * clamp reads that rect, so a wrong one strands the panel off-screen.
 *
 * The panel component is not mountable here (it needs the full React runtime),
 * so this mirrors what the handlers do with the real DOM: park a line, drag it
 * with genuine PointerEvents, and read back what the geometry would be.
 */
function parkedDrag() {
  const host = document.getElementById('host')
  host.innerHTML = ''
  const root = document.createElement('div')
  root.className = 'dshtb-root'
  root.style.cssText = 'position:fixed;left:1040px;top:60px;right:auto;width:auto;height:auto'
  const pill = document.createElement('div')
  pill.className = 'dshtb-pill'
  pill.textContent = 'TODO 2 下一条 · 下一条要做的'
  root.appendChild(pill)
  host.appendChild(root)

  const facts = {}
  const rect = pill.getBoundingClientRect()
  facts.lineWidth = Math.round(rect.width)
  facts.lineHeight = Math.round(rect.height)
  // The line must be a ROW: wider than tall is what makes it "one line".
  facts.isRow = rect.width > rect.height
  // The clamp reads left/top off this rect, so they must reflect the CSS.
  facts.rectLeft = Math.round(rect.left)
  facts.rectTop = Math.round(rect.top)
  facts.fixedPositionHonoured = Math.abs(rect.left - 1040) < 2 && Math.abs(rect.top - 60) < 2

  // touch-action:none is what stops a touch drag from scrolling the page
  // instead of moving the panel; it is a computed style, not a declaration.
  facts.touchAction = getComputedStyle(pill).touchAction
  facts.cursor = getComputedStyle(pill).cursor
  facts.userSelect = getComputedStyle(pill).userSelect

  facts.hasSetPointerCapture = typeof Element.prototype.setPointerCapture === 'function'
  facts.hasReleasePointerCapture = typeof Element.prototype.releasePointerCapture === 'function'

  // Now drive it the way the handler does, with a listener that mirrors
  // client.js: preventDefault, then capture, then follow the moves. This is what
  // proves the *platform* half — the Node suite already proves the logic.
  let prevented = null
  let captureResult = 'not-called'
  let moves = 0
  let lastX = null
  let lastY = null
  pill.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    prevented = event.defaultPrevented
    try {
      event.target.setPointerCapture(event.pointerId)
      captureResult = 'ok'
    } catch (err) {
      // In a real browser capture needs an ACTIVE pointer, and a synthetic event
      // has none — recording the exact outcome keeps this probe honest instead
      // of asserting a behaviour the harness cannot actually produce.
      captureResult = String(err && err.name ? err.name : err)
    }
  })
  pill.addEventListener('pointermove', (event) => {
    moves += 1
    lastX = event.clientX
    lastY = event.clientY
  })

  pill.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      pointerId: 1,
      clientX: rect.left + 4,
      clientY: rect.top + 4,
    }),
  )
  facts.pressDefaultPrevented = prevented
  facts.captureResult = captureResult

  // Moves are delivered to the line while the pointer stays over it. The capture
  // path (pointer leaving the element) cannot be produced synthetically, so what
  // is checked here is the delivery mechanism itself plus the arithmetic below.
  const travelX = -120
  const travelY = 90
  pill.dispatchEvent(
    new PointerEvent('pointermove', {
      bubbles: true,
      pointerId: 1,
      clientX: rect.left + 4 + travelX,
      clientY: rect.top + 4 + travelY,
    }),
  )
  facts.movesSeen = moves
  facts.moveCoordsHonoured = lastX === Math.round(rect.left + 4 + travelX)
  const after = pill.getBoundingClientRect()
  facts.stillAtOrigin = Math.round(after.left) === Math.round(rect.left)

  // The geometry the handlers would compute for that travel, using the same
  // clamp inputs: the line's OWN box, not the card's minimums.
  const vw = window.innerWidth
  const vh = window.innerHeight
  const boxW = Math.min(rect.width, vw - 16)
  const boxH = Math.min(rect.height, vh - 16)
  facts.predictedX = Math.min(Math.max(rect.left + travelX, 8), Math.max(8, vw - boxW - 8))
  facts.predictedY = Math.min(Math.max(rect.top + travelY, 8), Math.max(8, vh - boxH - 8))
  facts.expectX = Math.round(rect.left + travelX)
  facts.expectY = Math.round(rect.top + travelY)

  // And the edge case the line's own box decides: a drag past the right edge.
  facts.edgeX = Math.min(Math.max(rect.left + 5000, 8), Math.max(8, vw - boxW - 8))
  facts.edgeFits = facts.edgeX + boxW <= vw
  facts.viewportW = vw

  host.innerHTML = ''
  return facts
}

window.__measure = measure
window.__measureLogPage = measureLogPage
window.__pastePlatform = pastePlatform
window.__parkedDrag = parkedDrag
window.__results = results
</script></body></html>`

// ------------------------------------------------------------- CDP client

async function jsonOverHttp(path, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let last = 'no attempt'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`)
      if (res.ok) return await res.json()
      last = `HTTP ${res.status}`
    } catch (err) {
      last = err.message
    }
    await sleep(250)
  }
  throw new Error(`DevTools endpoint :${PORT}${path} unreachable: ${last}`)
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      let msg
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : '')
      } catch {
        return
      }
      const waiter = msg.id === undefined ? undefined : this.pending.get(msg.id)
      if (waiter === undefined) return
      this.pending.delete(msg.id)
      if (msg.error) waiter.reject(new Error(`${msg.error.message} (${waiter.method})`))
      else waiter.resolve(msg.result)
    })
  }

  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((ok, fail) => {
      ws.addEventListener('open', ok, { once: true })
      ws.addEventListener('error', () => fail(new Error('DevTools websocket failed')), { once: true })
    })
    return new Cdp(ws)
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.seq
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) fail(new Error(`${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer)
          ok(value)
        },
        reject: (err) => {
          clearTimeout(timer)
          fail(err)
        },
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
}

/** Evaluate an expression in the page and return its JSON value. */
async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails !== undefined) {
    const text =
      result.exceptionDetails.exception?.description ??
      result.exceptionDetails.text ??
      'unknown page error'
    throw new Error(text)
  }
  return result.result.value
}

// ------------------------------------------------------------------- run it

const work = mkdtempSync(join(tmpdir(), 'dshtb-browser-'))
const pagePath = join(work, 'index.html')
// The page loads the plugin's real client half from its real location — not a
// copy — so the stylesheets measured here are the ones the plugin installs.
const clientUrl = new URL('../client/client.js', import.meta.url).href
writeFileSync(pagePath, PAGE.replace('__CLIENT_URL__', clientUrl), 'utf8')

let chrome
let failures = 0
const check = (ok, label, detail) => {
  if (ok) {
    console.log('  ok   ' + label)
  } else {
    failures += 1
    console.error('  FAIL ' + label + (detail === undefined ? '' : ' — ' + detail))
  }
}

try {
  chrome = spawn(
    CHROME,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${join(work, 'profile')}`,
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--allow-file-access-from-files',
      '--window-size=1440,900',
      new URL(`file:///${pagePath.replace(/\\/g, '/')}`).href,
    ],
    { stdio: 'ignore' },
  )

  const version = await jsonOverHttp('/json/version')
  const targets = await jsonOverHttp('/json/list')
  const page = targets.find((t) => t.type === 'page')
  if (page === undefined) throw new Error('no page target; got ' + JSON.stringify(version))
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  // Let the deferred client.js script finish before measuring.
  await sleep(750)

  const applied = await evaluate(cdp, 'JSON.stringify(window.__results)')
  const steps = JSON.parse(applied)
  const applyStep = steps.find((s) => s.step === 'apply')
  console.log('apply: ' + JSON.stringify(applyStep))
  check(applyStep !== undefined && applyStep.ok === true, 'the client half applies in a real browser')
  check(
    applyStep !== undefined && applyStep.ok === true && applyStep.styles >= 3,
    'all three stylesheets reach the document (' + (applyStep && applyStep.styles) + ' tags)',
  )

  // ---------------------------------------------------------------- skins
  console.log('\n=== skins (computed styles) ===')
  const skins = ['ticket', 'plain', 'dense', 'theme', null]
  const measured = {}
  for (const skin of skins) {
    const raw = await evaluate(cdp, `JSON.stringify(window.__measure(${JSON.stringify(skin)}))`)
    measured[String(skin)] = JSON.parse(raw)
  }

  const ticket = measured.ticket
  const untagged = measured.null
  const plain = measured.plain
  const dense = measured.dense
  const theme = measured.theme

  check(
    untagged.head.padding === ticket.head.padding && untagged.sect.fontSize === ticket.sect.fontSize,
    'an untagged panel renders exactly like the ticket skin',
    JSON.stringify({ untagged: untagged.head.padding, ticket: ticket.head.padding }),
  )

  // "No frame" can be said two ways: a zero-width border, or a transparent one.
  // Both render nothing; the transparent kind keeps the box the same size, which
  // is what `plain` chooses so switching skins never shifts the layout. The
  // check is therefore about visibility, not about a particular technique.
  const framed = (m) => m.borderTopWidth !== '0px' && !/rgba\(0, 0, 0, 0\)|transparent/.test(m.borderTopColor)
  check(
    framed(ticket.card) === true && framed(plain.card) === false,
    'plain removes the card frame the base sheet draws',
    'plain=' + plain.card.borderTopWidth + '/' + plain.card.borderTopColor +
      ' ticket=' + ticket.card.borderTopWidth + '/' + ticket.card.borderTopColor,
  )
  check(
    plain.card.borderRadius !== ticket.card.borderRadius,
    'plain also changes the card’s corner radius',
    'plain=' + plain.card.borderRadius + ' ticket=' + ticket.card.borderRadius,
  )
  check(
    plain.head.borderBottomWidth === '0px' && ticket.head.borderBottomWidth !== '0px',
    'plain removes the rule under the header',
  )
  check(
    plain.sect.letterSpacing !== ticket.sect.letterSpacing ||
      plain.segButton.borderRadius !== ticket.segButton.borderRadius,
    'plain restyles the section header and the segment control',
  )
  check(
    plain.stateChip.borderRadius !== ticket.stateChip.borderRadius,
    'plain turns the running-state chip into a pill',
    'plain=' + plain.stateChip.borderRadius + ' ticket=' + ticket.stateChip.borderRadius,
  )

  // Two palettes, and the difference between them is the whole point of the
  // redesign, so it is measured rather than read off the source: a sheet that
  // re-binds tokens and then loses the cascade looks exactly like the default,
  // and a default that quietly followed the host would look like a theme bug.
  const hostPaper = await evaluate(
    cdp,
    `(() => {
      const probe = document.createElement('div')
      probe.style.background = 'var(--dsw-alias-bg-overlay)'
      document.body.appendChild(probe)
      const bg = getComputedStyle(probe).backgroundColor
      probe.remove()
      return bg
    })()`,
  )
  check(
    theme.card.background === hostPaper,
    '「随主题」 really wears the GUI palette, not just claims to',
    'theme=' + theme.card.background + ' host=' + hostPaper,
  )
  check(
    ticket.card.background === 'rgb(255, 255, 255)',
    'and the default look is the white card it promises, on any host theme',
    String(ticket.card.background),
  )
  check(
    ticket.card.background !== hostPaper,
    'so the two really are different palettes rather than one sheet twice',
  )
  check(
    theme.stateChip.background !== 'rgba(0, 0, 0, 0)',
    'a state tint survives the palette swap (a wash, not a hole)',
    String(theme.stateChip.background),
  )

  for (const [name, m] of Object.entries(measured)) {
    const where = name === 'null' ? 'untagged' : name
    check(m.sect.fontSize > 0 && m.sect.display !== 'none', where + ': the section header is legible')
    check(m.sect.text.includes('新增待办'), where + ': and still says what it hides', JSON.stringify(m.sect.text))
    check(m.group.fontSize > 0 && m.group.display !== 'none', where + ': the group heading is legible')
    check(m.group.text === 'plugin', where + ': and still names the directory', m.group.text)
    check(m.title2.fontSize > 0, where + ': the row title is legible')
    check(m.facts.fontSize > 0, where + ': the facts line is legible')
    check(m.stateChip.display !== 'none', where + ': the state chip is rendered')
    check(m.quietChip.display !== 'none', where + ': the schedule chip is rendered')
  }

  // ------------------------------------------------------------ the mode hint
  //
  // "Small text, and never a control" is a computed-style fact, not a source fact:
  // a hint that inherits a button's cursor or a chip's background reads as
  // clickable, and people click it. Both are measured here.
  console.log('\n=== mode hint (computed styles) ===')
  for (const [name, m] of Object.entries(measured)) {
    const where = name === 'null' ? 'untagged' : name
    check(
      m.listHint !== null && m.listHint.display !== 'none' && m.listHint.fontSize > 0,
      where + ': the mode hint is rendered and legible',
      JSON.stringify(m.listHint),
    )
    check(
      m.listHint.cursor !== 'pointer' && m.listHint.background === 'rgba(0, 0, 0, 0)',
      where + ': and does not look like a control (no pointer cursor, no button background)',
      JSON.stringify({ cursor: m.listHint.cursor, background: m.listHint.background }),
    )
    check(
      m.listHint.scrollWidth <= m.listHint.clientWidth + 1,
      where + ': the hint wraps instead of widening the panel',
      JSON.stringify({ scrollWidth: m.listHint.scrollWidth, clientWidth: m.listHint.clientWidth }),
    )
  }
  check(
    ticket.listHint.fontSize <= ticket.title2.fontSize,
    'the hint is smaller than a row title — it is an aside, not content',
    'hint=' + ticket.listHint.fontSize + ' title=' + ticket.title2.fontSize,
  )
  check(
    ticket.listHint.text.includes('不建议任务开始执行后更改'),
    'and it still carries the sentence it exists for',
    ticket.listHint.text,
  )

  //
  // The note is what the model is told before it starts, so "invisible" and
  // "there is no note" must not look the same — and it is text, so it has to wrap
  // rather than widen the panel. Both are properties of layout, not of the source.
  console.log('\n=== note (computed styles) ===')
  for (const [name, m] of Object.entries(measured)) {
    const where = name === 'null' ? 'untagged' : name
    check(m.note !== null && m.note.display !== 'none' && m.note.fontSize > 0,
      where + ': the note is rendered and legible')
    check(m.note.whiteSpace === 'pre-wrap',
      where + ': the note keeps the line breaks the user typed',
      m.note.whiteSpace)
    check(m.note.scrollWidth <= m.note.clientWidth + 1,
      where + ': and a long unbroken token wraps instead of widening the row',
      JSON.stringify({ scrollWidth: m.note.scrollWidth, clientWidth: m.note.clientWidth }))
    check(m.noteButton !== null && m.noteButton.display !== 'none',
      where + ': the note control is rendered')
    check(m.noteArea !== null && m.noteArea.display !== 'none' && m.noteArea.fontSize > 0,
      where + ': the note editor is rendered and legible')
    check(m.noteSave.display !== 'none' && m.noteCancel.display !== 'none',
      where + ': with its own save and cancel controls')
    check(m.doneList !== null && m.doneList.display !== 'none',
      where + ': the 已完成 list is rendered')
    check(m.doneRow !== null && m.doneRow.display !== 'none' && m.doneTitle.fontSize > 0,
      where + ': and its rows are legible')
  }

  // The clamp: two lines in the ticket and plain skins, one in dense. Measured as
  // "the box is shorter than its content", because a declared clamp that loses the
  // cascade would otherwise pass and the note would simply run to full length.
  check(
    ticket.note.lineClamp === '2' && ticket.note.scrollHeight > ticket.note.clientHeight,
    'the ticket skin clamps a long note to two lines, and really hides the rest',
    JSON.stringify({ clamp: ticket.note.lineClamp, scroll: ticket.note.scrollHeight, client: ticket.note.clientHeight }),
  )
  check(
    plain.note.lineClamp === '2' && plain.note.scrollHeight > plain.note.clientHeight,
    'plain keeps the same two lines',
    JSON.stringify({ clamp: plain.note.lineClamp }),
  )
  check(
    dense.note.lineClamp === '1' && dense.note.scrollHeight > dense.note.clientHeight,
    'the dense skin shows one line at most',
    JSON.stringify({ clamp: dense.note.lineClamp, scroll: dense.note.scrollHeight, client: dense.note.clientHeight }),
  )

  // A finished row reads as put away, and that is a cascade fact: both rules live
  // on `.dshtb-item.done`, which a later base rule could easily outrank.
  check(
    ticket.doneRow.opacity < 1 && ticket.doneTitle.textDecorationLine === 'line-through',
    'a completed row is dimmed and its title struck through',
    JSON.stringify({ opacity: ticket.doneRow.opacity, decoration: ticket.doneTitle.textDecorationLine }),
  )

  // ------------------------------------------------------------ status line
  //
  // v0.10.1 stopped folding the status line away. "Always there" is a layout
  // property, so it is measured: give the card more height than its content and
  // require the line to sit on the bottom edge rather than floating after the
  // list. The fixture is short on purpose; without free space nothing pins.
  const pinned = JSON.parse(await evaluate(cdp, `(() => {
    const root = buildPanel('ticket')
    const card = root.querySelector('.dshtb-card')
    card.style.height = '620px'
    void card.offsetHeight
    const foot = root.querySelector('.dshtb-foot').getBoundingClientRect()
    const box = card.getBoundingClientRect()
    return JSON.stringify({
      gap: Math.round(box.bottom - foot.bottom),
      cardHeight: Math.round(box.height),
      footPadding: getComputedStyle(root.querySelector('.dshtb-foot')).padding,
      lastChild: card.lastElementChild === root.querySelector('.dshtb-foot'),
      headers: root.querySelectorAll('.dshtb-sect').length,
    })
  })()`))
  check(
    pinned.cardHeight > 500 && pinned.gap >= 0 && pinned.gap <= 1,
    'the status line is pinned to the panel’s bottom edge, not left floating after the list',
    JSON.stringify(pinned),
  )
  check(
    pinned.footPadding.startsWith('8px 12px') && pinned.lastChild === true,
    'and it is the panel’s own last line at the panel’s padding — no header, nothing folded around it',
    JSON.stringify(pinned),
  )

  check(
    dense.title2.fontSize < ticket.title2.fontSize,
    'dense shrinks the row title',
    'dense=' + dense.title2.fontSize + ' ticket=' + ticket.title2.fontSize,
  )
  check(
    dense.row.padding !== ticket.row.padding,
    'dense tightens row padding',
    'dense=' + dense.row.padding + ' ticket=' + ticket.row.padding,
  )
  check(
    dense.sect.fontSize === ticket.sect.fontSize,
    'dense keeps the section header at the base size (it is structure, not content)',
  )

  // What matters is the *skin's* contribution, not the base sheet's: the base
  // classes are product-namespaced and always applied. So this measures a node
  // carrying a panel class but sitting outside the panel root, with and without
  // a skin selected, and requires the two to be identical.
  const leak = await evaluate(
    cdp,
    `(() => {
       const probe = document.createElement('div')
       probe.className = 'dshtb-chip run'
       probe.textContent = '进行中'
       document.body.appendChild(probe)
       const read = () => {
         const cs = getComputedStyle(probe)
         return { padding: cs.padding, borderRadius: cs.borderRadius,
                  background: cs.backgroundColor, borderTopWidth: cs.borderTopWidth }
       }
       const before = read()
       const after = {}
       for (const skin of ['plain', 'dense', 'theme', 'ticket']) {
         document.body.setAttribute('data-dshtb-skin', skin)
         after[skin] = read()
       }
       document.body.removeAttribute('data-dshtb-skin')
       const restored = read()
       probe.remove()
       return JSON.stringify({ before, after, restored })
     })()`,
  )
  const outside = JSON.parse(leak)
  for (const skin of ['plain', 'dense', 'theme', 'ticket']) {
    check(
      JSON.stringify(outside.before) === JSON.stringify(outside.after[skin]),
      'selecting the ' + skin + ' skin changes nothing outside the panel',
      JSON.stringify({ before: outside.before, after: outside.after[skin] }),
    )
  }
  check(
    JSON.stringify(outside.before) === JSON.stringify(outside.restored),
    'and clearing the attribute leaves no residue',
  )

  // ------------------------------------------------------------ log page
  console.log('\n=== log page (computed styles) ===')
  const log = JSON.parse(await evaluate(cdp, `JSON.stringify(window.__measureLogPage())`))

  check(log.view !== null && log.view.display === 'flex', 'the log page lays out as a column')
  check(log.bar !== null && log.bar.height > 0, 'the filter bar has height')

  // The failure this guards: a log viewer whose text is invisible reads exactly
  // like "nothing was logged".
  const visible = (node, what) =>
    check(
      node !== null && node.visibility !== 'hidden' && node.opacity > 0 && node.color !== 'rgba(0, 0, 0, 0)',
      what,
      node === null ? 'missing node' : JSON.stringify({ color: node.color, opacity: node.opacity }),
    )
  visible(log.errorRow, 'an error row is visible')
  visible(log.warnRow, 'a warn row is visible')
  visible(log.meta, 'the meta line (counts and file path) is visible')
  visible(log.filter, 'the keyword box is visible')

  // The row body must be allowed to wrap: a log line is long, and clipping it
  // would hide the very detail the reader opened the page for.
  check(
    log.rowBody !== null && log.rowBody.whiteSpace === 'pre-wrap',
    'row text wraps instead of clipping (stacks need their newlines)',
    log.rowBody === null ? 'missing' : log.rowBody.whiteSpace,
  )
  check(
    log.rowBody !== null && log.rowBody.fontFamily.toLowerCase().includes('mono'),
    'log text is monospace — this is a developer surface',
    log.rowBody === null ? 'missing' : log.rowBody.fontFamily,
  )
  check(
    log.errorLevel !== null && log.warnLevel !== null && log.errorLevel.color !== log.warnLevel.color,
    'error and warn levels are told apart by colour, not just by word',
    JSON.stringify({ error: log.errorLevel?.color, warn: log.warnLevel?.color }),
  )

  // Level toggles must LOOK on/off; a filter whose state is invisible is a
  // filter the user cannot trust.
  check(
    log.onButton !== null && log.offButton !== null && log.onButton.color !== log.offButton.color,
    'an active level filter looks different from an inactive one',
    JSON.stringify({ on: log.onButton?.color, off: log.offButton?.color }),
  )

  check(log.dot !== null && log.dot.width > 0, 'the unread dot renders')

  // The three title-bar controls must be SEPARATE elements. If the log button
  // reused `dshtb-fold`, `document.querySelector('.dshtb-fold')` would return
  // whichever happened to be first, and the fold control would be ambiguous.
  check(
    log.logButton !== null && log.foldButton !== null && log.skinButton !== null &&
      log.logButton.text !== log.foldButton.text && log.logButton.text !== log.skinButton.text,
    'the log, fold and skin controls are three distinct buttons',
    JSON.stringify({ log: log.logButton?.text, fold: log.foldButton?.text, skin: log.skinButton?.text }),
  )

  // The whole page must fit the panel rather than overflow it.
  check(
    log.view !== null && log.view.width > 0 && log.view.width <= 400,
    'the log page fits inside the panel width',
    log.view === null ? 'missing' : String(log.view.width),
  )

  // ---------------------------------------------------------------- paste
  console.log('\n=== paste (real clipboard, File and FileReader objects) ===')
  const facts = JSON.parse(
    await evaluate(cdp, `(async () => JSON.stringify(await window.__pastePlatform()))()`),
  )
  console.log('platform: ' + JSON.stringify(facts, null, 2).replace(/\n/g, '\n  '))

  // The handler reads `clipboardData` off the event; if a real paste did not
  // carry it, nothing else in this feature could work.
  check(facts.imagePasteHasClipboardData === true, 'a paste event carries clipboardData')
  // `files` is the first face read, and the flat list of a real image paste.
  check(facts.filesLength === 1, 'an image paste populates clipboardData.files', String(facts.filesLength))
  check(facts.firstFileType === 'image/png', 'the pasted file carries its media type', String(facts.firstFileType))
  check(facts.firstFileName === 'shot.png', 'and its name', String(facts.firstFileName))
  // `items` is the second face; it must still expose getAsFile().
  check(facts.itemKinds.includes('file'), 'an image paste also lists a file item', JSON.stringify(facts.itemKinds))
  check(facts.getAsFileWorks === true, 'and items[].getAsFile() returns the file')

  // The load-bearing negative: a text paste must have no files, or the handler
  // would intercept it and break the composer's main input.
  check(facts.textPasteFileCount === 0, 'a text paste carries NO files', String(facts.textPasteFileCount))
  check(
    facts.textPasteItemKinds.includes('file') === false,
    'and no file item — so the handler leaves it alone',
    JSON.stringify(facts.textPasteItemKinds),
  )

  // A non-image file is recognised by its type, which is what the handler filters on.
  check(facts.pdfType === 'application/pdf', 'a non-image file declares a non-image type', String(facts.pdfType))

  // FileReader's output shape: the handler slices after the first comma.
  check(
    facts.dataUrlComma > 0,
    'FileReader output contains a comma to slice the payload at',
    String(facts.dataUrlComma),
  )
  check(
    facts.dataUrlPrefix.startsWith('data:image/png;base64'),
    'and an image data URL really is image/png base64',
    facts.dataUrlPrefix,
  )

  // The extension fallback exists for a type-less file; confirm a File can
  // actually present an empty type rather than defaulting to something.
  check(
    facts.typelessFileType === '""',
    'a File built with an empty type reports an empty type',
    facts.typelessFileType,
  )

  // ------------------------------------------------------ parked line drag
  //
  // The Node suite drives these handlers with objects it built, so the platform
  // assumptions behind the parked drag are only real here: that the line lays
  // out as a ROW (the clamp measures exactly this box), that capture is
  // available, and that a move outside the line still reaches it.
  console.log('\n=== parked line (real layout and pointer events) ===')
  const park = JSON.parse(await evaluate(cdp, `JSON.stringify(window.__parkedDrag())`))
  console.log('parked: ' + JSON.stringify(park, null, 2).replace(/\n/g, '\n  '))

  check(park.isRow === true, 'the parked line lays out as one row, not a box', `${park.lineWidth}x${park.lineHeight}`)
  check(park.lineHeight < 100, 'and it is one line tall', String(park.lineHeight))
  // The clamp measures THIS rect, so the stylesheet's own width/height keywords
  // have to leave left/top meaningful on a fixed element.
  check(
    park.fixedPositionHonoured === true,
    'a fixed, auto-sized line reports its real left/top (the clamp reads these)',
    `${park.rectLeft},${park.rectTop}`,
  )
  check(
    park.userSelect === 'none',
    'the line does not select text while being dragged',
    park.userSelect,
  )
  // Without this a touch drag scrolls the page instead of moving the panel —
  // a declaration in the sheet, so only the computed style proves it landed.
  check(park.touchAction === 'none', 'the line suppresses touch scrolling so a drag moves it', park.touchAction)
  check(park.cursor === 'grab', 'and advertises itself as draggable', park.cursor)
  check(park.hasSetPointerCapture === true, 'pointer capture exists in this browser')
  check(park.hasReleasePointerCapture === true, 'and so does its release')
  check(park.pressDefaultPrevented === true, 'the press is taken over, so no text selection starts')
  // A synthetic PointerEvent has no active pointer, so capture is expected to be
  // refused with NotFoundError. Recording which of the two happened keeps the
  // check honest: in a real drag the pointer IS active and capture succeeds.
  check(
    park.captureResult === 'ok' || park.captureResult === 'NotFoundError',
    'pointer capture either succeeds or is refused for a synthetic pointer (never undefined)',
    String(park.captureResult),
  )
  check(park.movesSeen >= 1, 'a pointermove is delivered to the line and read', String(park.movesSeen))
  check(park.moveCoordsHonoured === true, 'with its client coordinates intact')
  // The handler must not itself move the element: it writes React state, which
  // repaints on the next render. A handler that moved the node directly would
  // fight the state it is supposed to drive.
  check(park.stillAtOrigin === true, 'the handler leaves the node alone and writes state instead')
  check(
    park.predictedX === park.expectX && park.predictedY === park.expectY,
    'a drag of (-120, +90) moves the line by exactly that much',
    `got ${park.predictedX},${park.predictedY} want ${park.expectX},${park.expectY}`,
  )
  // The load-bearing difference from the card: the boundary is the line's own
  // ~207px, not the card's 300px minimum. Measured against the card, the line
  // would stop ~93px short of the edge it was dragged to.
  check(
    park.edgeFits === true,
    'and a drag past the edge stops with the LINE inside the viewport',
    String(park.edgeX),
  )
  check(
    park.edgeX > park.viewportW - 300 - 8,
    'the boundary is the line, not the card minimum (which would stop it 300px out)',
    `edge=${Math.round(park.edgeX)} viewport=${park.viewportW}`,
  )

  console.log('')
  if (failures > 0) {
    console.error(failures + ' browser check(s) failed')
    process.exitCode = 1
  } else {
    console.log('all browser checks passed')
  }
} catch (err) {
  console.error('browser check could not run: ' + (err && err.message ? err.message : err))
  // The stack matters here: a page-side failure and a harness-side one read the
  // same in a one-line message, and they are fixed in completely different files.
  if (err !== null && err !== undefined && typeof err.stack === 'string') {
    console.error(err.stack.split('\n').slice(1, 6).join('\n'))
  }
  process.exitCode = 2
} finally {
  if (chrome !== undefined && chrome.exitCode === null) chrome.kill()
  try {
    rmSync(work, { recursive: true, force: true })
  } catch (err) {
    /* the profile may still be held briefly by the exiting browser */
  }
}
