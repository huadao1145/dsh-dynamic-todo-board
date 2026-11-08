#!/usr/bin/env node
/**
 * Regenerate the README/marketplace screenshots from a FIXTURE.
 *
 *   node tools/capture-fixture.mjs
 *
 * Why a fixture and not the running GUI: `capture-screenshots.mjs` drives a
 * live profile and needs that profile's browser credentials, so it can only run
 * where somebody is logged in. These images have to be reproducible by anyone
 * reading the repo — a screenshot you cannot regenerate is documentation that
 * silently rots.
 *
 * What is REAL here:
 *   - the plugin's own `client/client.js` is loaded, and the stylesheets under
 *     test are the ones it actually installs (through `apply()`, not a copy);
 *   - the panel's node structure, class names, control placement and glyphs are
 *     transcribed from the component's own render function, so the CSS applies
 *     exactly as it does in the product. The classes are asserted against the
 *     stylesheet's selectors before the shot, so a rename fails here instead of
 *     shipping a picture of a panel that no longer exists;
 *   - text, counts, and chips are consistent with each other (the footer's
 *     "未验收 N" is computed from the rows that are drawn).
 *
 * What is NOT real: the host's data. There is no board, no session list and no
 * API behind it — the rows below are a scripted demo. The panel does not know
 * the difference (it is a pure function of its props), but a reader should.
 *
 * Environment overrides:
 *   DSHTB_CHROME  chromium executable  (default Chrome on Windows)
 *   DSHTB_PORT    DevTools port        (default 9224 — not the other tools' ports)
 *   DSHTB_OUT     output directory     (default <repo>/assets)
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = process.env.DSHTB_OUT ? resolve(process.env.DSHTB_OUT) : join(ROOT, 'assets')
const PORT = Number(process.env.DSHTB_PORT ?? 9224)
const CHROME =
  process.env.DSHTB_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PROFILE = join(tmpdir(), 'dshtb-fixture-profile')
const VIEW = { width: 1440, height: 1300 }
/**
 * The geometry the panel is drawn at.
 *
 * Taller than the GUI's default 660px on purpose: a screenshot has to show the
 * whole board at once (composer, queue, 已完成, footer), and at 660 the list is
 * clipped exactly where it stops being interesting. The width is the real one.
 * `CARD_ROOM` overrides the stylesheet's own `max-height:min(80vh,680px)` — a
 * documented ceiling for the floating panel, and the one rule a picture of the
 * whole board has to lift.
 */
const PANEL = { w: 520, h: 1320 }
const CARD_ROOM = 1320
/**
 * The one ceiling a whole-board picture has to lift: the shipped stylesheet
 * caps the panel at `min(80vh, 680px)`, which is right for a floating panel and
 * wrong for a screenshot that has to show the composer, the queue, 已完成 and
 * the footer at once.
 *
 * It is injected AFTER `apply()` on purpose — at equal specificity the later
 * rule wins, and the plugin's own sheets land in `<head>` when `apply()` runs.
 * Put this in the page's own `<style>` and it silently loses.
 */
const CARD_FIT = `.dshtb-root{max-height:none !important}.dshtb-card{max-height:${CARD_ROOM}px !important}
  /* The panel is sized by its content here, not fixed: a screenshot must not
     carry empty space that the real panel would never show. A shot that wants
     the product's own short height sets it inline, with priority. */
  .dshtb-root{height:auto !important}`
const BUILD = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --------------------------------------------------------------- demo board

/**
 * A board that tells the plugin's whole story in one screen, and that stays
 * internally consistent: `open` is the open rows, `done` is the verified ones,
 * and the counts in the header/footer are derived from those two arrays below.
 */
const dir = String.raw`D:\DSH\plugin`
const demo = () => ({
  dir: dir,
  rows: [
    {
      title: '把插件适配到 DSH 会话格式 v4',
      dir: dir,
      mode: '续跑',
      state: '已完成',
      stateCls: 'ok',
      when: '不定时',
      note: '验收：注入的 notice 带 plugin:dsh-todo-board，且整轮不再被拒。',
      aiDone: true,
    },
    {
      title: '同步 npm 与 GitHub 仓库，补 tag',
      dir: dir,
      mode: '续跑',
      state: '进行中',
      stateCls: 'run',
      when: '不定时',
      note: '',
      aiDone: false,
    },
    {
      title: '重新截三张 README 截图',
      dir: dir,
      mode: '提醒',
      state: '未派发',
      stateCls: 'idle',
      when: '09-27 09:30',
      due: false,
      images: 2,
      aiDone: false,
    },
    {
      title: '给 dsh-session-cleaner 补一条按目录筛选',
      dir: String.raw`D:\DSH\plugin\dsh-session-cleaner`,
      mode: '新会话',
      state: '已派发',
      stateCls: 'sent',
      when: '不定时',
      note: '',
      session: 'a41f7c',
      aiDone: false,
    },
    {
      title: '把审批框里的模式写成中文标签',
      dir: dir,
      mode: '提醒',
      state: '图片被拒',
      stateCls: 'bad',
      when: '不定时',
      note: '',
      images: 1,
      aiDone: false,
    },
  ],
  done: [
    {
      title: '更新 CHANGELOG 到 0.11.2',
      dir: dir,
      mode: '续跑',
      when: '不定时',
      note: '',
      state: '已完成',
      stateCls: 'ok',
      aiDone: true,
    },
    {
      title: '确认 engines.dsh 收到 >=0.1.7-rc.2',
      dir: dir,
      mode: '提醒',
      when: '不定时',
      note: '',
      state: '已完成',
      stateCls: 'ok',
      aiDone: true,
    },
  ],
})

// ------------------------------------------------------------ panel markup

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * One row.
 *
 * Mirrors `item()` in client.js: grip, the two checkboxes (square = the agent's
 * own tick, round = your verification), title, the note line, the facts line,
 * the chip row, and the hover-only action buttons. `finished` rows drop the
 * grip and the ▶ — a completed row is out of the queue.
 */
function row(item, { finished = false } = {}) {
  const aiOn = item.aiDone ? ' on' : ''
  const meOn = finished ? ' on' : ''
  const imgs =
    item.images > 0
      ? `<div class="dshtb-imgs">${Array.from(
          { length: item.images },
          (_, i) =>
            `<span class="dshtb-imgwrap"><img class="dshtb-img" src="${thumb(i)}" alt="附图 ${i + 1}"><button class="dshtb-imgx" title="移除这张图片">✕</button></span>`,
        ).join('')}</div>`
      : ''
  const facts =
    `目录 ${esc(item.dir)}` +
    (item.session ? `  ·  会话 ${item.session}` : '')
  const when =
    item.when === '不定时'
      ? `<button class="dshtb-chip quiet" title="点这里给这条待办设置定时执行时间">◴ 不定时</button>`
      : `<button class="dshtb-chip${item.due ? ' due' : ''}" title="定时执行：${esc(
          item.when,
        )}\n点这里改时间">◴ ${esc(item.when)} ✎</button><button class="dshtb-chip x" title="取消定时">✕</button>`
  return `
    <div class="dshtb-item${finished ? ' done' : ''}">
      ${finished ? '' : '<span class="dshtb-grip" title="拖动调整执行顺序">⠿</span>'}
      <div class="dshtb-checks">
        <button class="dshtb-cb ai${aiOn}" title="AI 已完成（模型自己勾的，撤销不会删掉这条待办）">${item.aiDone ? '✓' : ''}</button>
        <button class="dshtb-cb me${meOn}" title="已验收（只有你能勾）">${finished ? '✓' : ''}</button>
      </div>
      <div class="dshtb-body">
        <div class="dshtb-t" title="双击编辑">${esc(item.title)}</div>
        ${item.note ? `<div class="dshtb-note" title="备注：\n${esc(item.note)}">${esc(item.note)}</div>` : ''}
        <div class="dshtb-facts">${esc(facts)}</div>
        ${imgs}
        <div class="dshtb-meta">
          <button class="dshtb-chip" title="点击切换执行模式（当前：${esc(item.mode)}）">${esc(item.mode)}</button>
          <span class="dshtb-chip ${item.stateCls}">${esc(item.state)}</span>
          ${when}
        </div>
      </div>
      <div class="dshtb-acts">
        ${finished ? '' : '<button class="dshtb-ic" title="立即派发（等于面板的 ▶）">▶</button>'}
        <button class="dshtb-ic" title="删除这条待办">✕</button>
      </div>
    </div>`
}

/** The panel as the component renders it, transcribed from `TodoBoard`. */
function panel({ skin = null, logOpen = false, height = null } = {}) {
  const d = demo()
  // The header's number is what the HOST counts as open: rows you have not
  // verified AND the agent has not ticked. An `已完成` row leaves the queue, so
  // counting it here would overstate the work left — the one error in this
  // fixture a reader could not detect.
  const open = d.rows.filter((r) => r.state !== '已完成').length
  // "待验" is the other side of the same fact: ticked by the agent, not yet
  // verified by you. Both numbers come from the rows actually drawn.
  const awaiting = d.rows.filter((r) => r.state === '已完成').length
  const groups = []
  for (const item of d.rows) {
    const last = groups[groups.length - 1]
    if (last && last.key === item.dir) last.items.push(item)
    else groups.push({ key: item.dir, items: [item] })
  }
  const doneGroups = [{ key: d.dir, items: d.done }]
  const skinAttr = skin === null ? '' : ` data-dshtb-skin="${skin}"`
  // Segment counts read off the same rows, so the tabs and the list agree.
  const segments = [
    ['当前目录', d.rows.filter((r) => r.state !== '已完成' && r.dir === d.dir).length, true],
    ['当前会话', 3, false],
    ['全部', open, false],
  ]
    .map(
      ([label, n, on]) =>
        `<button class="${on ? 'on' : ''}">${label}<em>${n}</em></button>`,
    )
    .join('')
  const logBody = `
        <div class="dshtb-logview">
          <div class="dshtb-logbar">
            <button class="on">error</button><button class="on">warn</button><button>info</button><button>debug</button>
            <button class="dshtb-logsrc on">本插件</button><button class="dshtb-logsrc">其他</button><button class="dshtb-logsrc">全部</button>
            <input class="dshtb-logfilter" placeholder="过滤关键字…" value="">
          </div>
          <div class="dshtb-logmeta">3 条 · 更早的记录已被内存环回收</div>
          <div class="dshtb-logbar"><button>复制</button><button>导出 .txt</button><button>清空显示</button></div>
          <div class="dshtb-loglist">
            <div class="dshtb-logrow error"><span class="at">09:41:07</span><span class="lv">error</span><span class="body">route 500 /dsh-todo-board/api <span class="src">[dsh-todo-board]</span></span></div>
            <div class="dshtb-logrow error"><span class="at">09:41:07</span><span class="lv">error</span><span class="body">inject notice refused: format v4 message requires a producer-owned source kind <span class="src">[dsh-todo-board]</span></span></div>
            <div class="dshtb-logrow warn"><span class="at">09:38:52</span><span class="lv">warn</span><span class="body">dispatch failed attempt 3 · dir D:\DSH\plugin · 图片被拒 <span class="src">[dsh-todo-board]</span></span></div>
          </div>
        </div>`
  return `
<div class="dshtb-root"${skinAttr} style="width:${PANEL.w}px;top:0;right:0;position:relative${
    height === null ? '' : `;height:${height}px !important`
  }">
  <div class="dshtb-card">
    <div class="dshtb-head" title="拖动移动 · 双击还原位置">
      <span class="dshtb-title" title="存储：D:\DSH\dsh-home\todo-board\board.json"><b>☑</b> TODO</span>
      <span class="dshtb-sp"></span>
      <span class="dshtb-stats"><i title="未验收">${open}</i>${awaiting > 0 ? `<i title="AI 已完成，等你验收">待验 ${awaiting}</i>` : ''}</span>
      <button class="dshtb-skin" title="界面：蓝白\n点击切换下一套（共 4 套）">◻</button>
      <button class="dshtb-log${logOpen ? ' on' : ''}" title="开发者日志">${logOpen ? '←' : '⚙'}</button>
      <button class="dshtb-fold" title="收起为一行（只留计数与下一条待办）">–</button>
    </div>${
      logOpen
        ? logBody
        : `
    <div class="dshtb-seg">${segments}</div>
    <button class="dshtb-sect"><span class="car">▾</span>新增待办</button>
    <div class="dshtb-compose">
      <div class="dshtb-add">
        <textarea rows="3" placeholder="新增待办…（Enter 添加，Shift+Enter 换行，Ctrl+V 粘贴截图）"></textarea>
        <button class="dshtb-ic" title="添加">＋</button>
      </div>
      <div class="dshtb-modes">
        <button class="on" title="提醒">提醒</button><button title="自动续跑">续跑</button><button title="自动新会话">新会话</button>
      </div>
      <div class="dshtb-hint">只在这里提醒你，不会自动发送任何消息。</div>
      <div class="dshtb-when"><span class="lbl">定时</span><input type="datetime-local" title="到点后才执行（留空 = 立即可以执行）"><span class="dshtb-hint">不填</span></div>
      <div class="dshtb-dir"><span class="lbl">目录</span><input placeholder="留空 = 用当前会话的工作目录" title="这条待办归到哪个目录"></div>
    </div>
    <button class="dshtb-sect"><span class="car">▾</span>待办列表<em>${d.rows.length}</em></button>
    <div class="dshtb-list">
      <div class="dshtb-listhint">你可以通过点击更改任务执行模式，但不建议任务开始执行后更改</div>
      ${groups
        .map(
          (g) =>
            `<div class="dshtb-group">${esc(g.key)}</div>` +
            g.items.map((i) => row(i)).join(''),
        )
        .join('')}
    </div>
    <button class="dshtb-sect"><span class="car">▾</span>已完成<em>${d.done.length}</em></button>
    <div class="dshtb-donelist">
      ${doneGroups
        .map(
          (g) =>
            `<div class="dshtb-group">${esc(g.key)}</div>` +
            g.items.map((i) => row(i, { finished: true })).join(''),
        )
        .join('')}
    </div>
    <div class="dshtb-foot">
      <span title="客户端构建标记">v${BUILD}</span>
      <span title="还没验收的条数">未验收 ${open}</span>
      ${awaiting > 0 ? `<span title="AI 已完成、等你验收">· 待验 ${awaiting}</span>` : ''}
      <span class="dshtb-sp"></span>
      <button class="dshtb-link" title="删除所有已验收的条目">清理已验收 ${d.done.length}</button>
      <button class="dshtb-link" title="打开 Cordis 动态插件面板">Cordis Plugin</button>
    </div>`
    }
    <div class="dshtb-resize" title="拖动缩放 · 双击还原"></div>
  </div>
</div>`
}

/** A tiny inline placeholder for row thumbnails, so the page needs no network. */
function thumb(i) {
  const hue = 210 + i * 24
  return (
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="hsl(${hue} 30% 26%)"/><path d="M8 46l14-16 10 11 8-9 16 18z" fill="hsl(${hue} 40% 62%)"/><circle cx="46" cy="18" r="6" fill="hsl(${hue} 50% 70%)"/></svg>`,
    )
  )
}

/** The product's design tokens, as the GUI supplies them. Values from its dark theme. */
const TOKENS = `
:root{
  --dsw-alias-border-l1:#33384a;--dsw-alias-border-l2:#454b60;
  --dsw-alias-bg-overlay:#1b1e28;--dsw-alias-bg-layer-1:#242833;--dsw-alias-bg-layer-2:#2b303d;
  --dsw-alias-label-primary:#e9ebf2;--dsw-alias-label-secondary:#9aa1b4;
  --dsw-alias-brand-primary:#5b78ff;--dsw-alias-state-success-primary:#3fb950;
  --dsw-alias-state-warn-primary:#d29922;--dsw-alias-state-error-primary:#f85149;
}
html,body{margin:0;height:100%;background:#eef2f9;color:#122240;
  font:13px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif}
/* The section header's count, as the real header renders it. The plugin's own
   sheet styles the label and the rule, not this number. */
.dshtb-sect em{font-style:normal;font:600 11px/1 ui-monospace,Consolas,monospace;
  font-variant-numeric:tabular-nums;opacity:.6}
`

/**
 * Four panels side by side do not fit a 1440 viewport at full size, so the
 * gallery is scaled — the looks differ in palette, type scale and row density,
 * and comparing them is the whole point of the picture.
 */
const GALLERY_SCALE = 0.64
const GALLERY_SKINS = [
  ['ticket', '蓝白 ticket（默认）'],
  ['plain', '素白 plain'],
  ['dense', '紧凑 dense'],
  ['theme', '随主题 theme'],
]

/**
 * The three shots.
 *
 * `backdrop` paints the case around the panel so a reader sees where it sits in
 * the product. It is deliberately abstract — the real sidebar and conversation
 * are NOT this plugin's to draw, and a screenshot that invents them would be
 * documentation of someone else's UI.
 */
const SHOTS = [
  {
    file: 'screenshot-1.png',
    title: 'in place',
    html: `<div class="backdrop"></div>
      <div class="stage stage-right">${panel({ height: 620 })}</div>
      <div class="caption">面板默认停在窗口右上角 · 可拖动 / 缩放 / 收成一行</div>`,
    extra: `
      /* An abstract surface, not a drawing of the GUI. Painting a fake sidebar
         and a fake conversation would be documentation of somebody else's UI —
         and it would go stale without this plugin changing at all. */
      .backdrop{position:fixed;inset:0;
        background:
          radial-gradient(1100px 700px at 78% 8%, #202634 0%, #171a22 55%, #12141a 100%),
          linear-gradient(180deg,#171a22,#12141a)}
      .backdrop::after{content:'';position:absolute;inset:0;opacity:.5;
        background-image:linear-gradient(#ffffff08 1px,transparent 1px),linear-gradient(90deg,#ffffff08 1px,transparent 1px);
        background-size:36px 36px}
      .stage-right{position:fixed;top:56px;right:16px}
      .stage-right .dshtb-root{position:relative;top:0;right:0}
      .caption{position:fixed;left:28px;bottom:24px;font:500 12px/1.5 ui-monospace,Consolas,monospace;color:#6b7386}`,
    clip: null,
  },
  {
    file: 'screenshot-2.png',
    title: 'the panel',
    html: `<div class="stage">${panel({ height: PANEL.h })}</div>`,
    extra: `
      body{display:flex;align-items:center;justify-content:center}
      .stage .dshtb-root{position:relative;top:0;right:0}`,
    clip: '.dshtb-root',
  },
  {
    file: 'screenshot-3.png',
    title: 'skins',
    html: `<div class="gallery">
      ${GALLERY_SKINS.map(
        ([s, caption]) =>
          `<figure class="cell"><div class="wrap">${panel({ skin: s, height: PANEL.h })}</div><figcaption>${caption}</figcaption></figure>`,
      ).join('')}
    </div>`,
    extra: `
      body{display:block}
      .gallery{display:flex;gap:16px;padding:20px;align-items:flex-start}
      .cell{margin:0;flex:0 0 auto}
      .cell .wrap{width:${Math.round(PANEL.w * GALLERY_SCALE)}px;height:${Math.round(
        PANEL.h * GALLERY_SCALE,
      )}px;overflow:hidden;border-radius:12px;outline:1px solid #dbe3ef}
      .cell .dshtb-root{position:relative;top:0;right:0;height:${PANEL.h}px;
        transform:scale(${GALLERY_SCALE});transform-origin:top left}
      .cell figcaption{padding:9px 2px 0;font:600 12px/1.3 ui-monospace,Consolas,monospace;color:#64789b}`,
    clip: '.gallery',
  },
  {
    file: 'screenshot-4.png',
    title: 'developer log',
    html: `<div class="stage">${panel({ logOpen: true, height: 620 })}</div>`,
    extra: `
      body{display:flex;align-items:center;justify-content:center}
      .stage .dshtb-root{position:relative;top:0;right:0}`,
    clip: '.dshtb-root',
  },
]

// --------------------------------------------------------------- CDP plumbing

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
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', () => rej(new Error('DevTools websocket failed')), { once: true })
    })
    return new Cdp(ws)
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.seq
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) rej(new Error(`${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, {
        method,
        resolve: (v) => {
          clearTimeout(timer)
          res(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          rej(e)
        },
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (res.exceptionDetails) {
      const text =
        res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'unknown'
      throw new Error(`evaluate failed: ${text}`)
    }
    return res.result?.value
  }

  async navigate(url) {
    const loaded = new Promise((res) => {
      const once = (event) => {
        const msg = JSON.parse(typeof event.data === 'string' ? event.data : '{}')
        if (msg.method === 'Page.loadEventFired') {
          this.ws.removeEventListener('message', once)
          res()
        }
      }
      this.ws.addEventListener('message', once)
    })
    await this.send('Page.navigate', { url })
    await loaded
  }

  async shot(file, clip) {
    const params = { format: 'png' }
    if (clip) {
      params.clip = { ...clip, scale: 2 }
      params.captureBeyondViewport = true
    }
    const { data } = await this.send('Page.captureScreenshot', params)
    writeFileSync(file, Buffer.from(data, 'base64'))
    return file
  }
}

// ------------------------------------------------------------------ the run

/**
 * The page under test.
 *
 * `client.js` is a CommonJS factory handed to the module loader, so a two-line
 * loader stub is enough to get the real stylesheets installed by the real
 * `apply()` — no GUI, no React, no network. Everything after that is the
 * fixture markup, which the installed CSS addresses by class name.
 */
function page(body, extra) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>dsh-todo-board fixture</title>
<style>${TOKENS}${extra}</style></head>
<body>
<script>window.__ModuleLoader__ = { load(entry) { window.__entry = entry } }</script>
<script src="file:///${join(ROOT, 'client', 'client.js').replace(/\\/g, '/')}"></script>
${body}
<script>
  const out = []
  try {
    const mod = window.__entry.factory((name) => {
      if (name === 'react') return { createElement: () => null }
      throw new Error('unexpected require: ' + name)
    })
    mod.apply({
      effect: (cb) => { cb(); return () => {} },
      slots: { inject: (_n, register) => register(), register: () => {} },
    })
    // Geometry override, after the plugin's own sheets are in the document.
    const fit = document.createElement('style')
    fit.textContent = ${JSON.stringify(CARD_FIT)}
    document.head.appendChild(fit)
    // Size each gallery cell to the panel's own rendered height, so a shorter
    // skin (dense sets a smaller type scale) is not padded out with empty space
    // the product would never show.
    for (const cell of document.querySelectorAll('.cell .wrap')) {
      const card = cell.querySelector('.dshtb-card')
      if (card) cell.style.height = Math.ceil(card.getBoundingClientRect().height * ${GALLERY_SCALE}) + 'px'
    }
    const sheets = [...document.head.querySelectorAll('style[data-dsh-todo-board]')]
    out.push({ ok: true, sheets: sheets.length, css: sheets.reduce((n, s) => n + s.textContent.length, 0) })
  } catch (err) {
    out.push({ ok: false, error: String((err && err.message) || err) })
  }
  window.__fixture = out[0]
</script>
</body></html>`
}

/**
 * Fail before taking a picture if the fixture has drifted from the stylesheet.
 *
 * The dangerous failure is silent: a renamed class still renders, it just
 * renders UNSTYLED, and the screenshot then documents a panel that does not
 * exist. So every class the fixture uses must be a selector the plugin's own CSS
 * actually declares.
 */
async function assertStyled(cdp, classes) {
  const missing = await cdp.evaluate(`(() => {
    const css = [...document.head.querySelectorAll('style[data-dsh-todo-board]')]
      .map((s) => s.textContent).join('\\n')
    return ${JSON.stringify(classes)}.filter((c) => !css.includes('.' + c))
  })()`)
  if (missing.length > 0) {
    throw new Error(
      'fixture class(es) not declared by the plugin stylesheet: ' + missing.join(', '),
    )
  }
}

async function main() {
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--allow-file-access-from-files',
      `--user-data-dir=${PROFILE}`,
      `--remote-debugging-port=${PORT}`,
      `--window-size=${VIEW.width},${VIEW.height}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  try {
    const version = await jsonOverHttp('/json/version')
    const targets = await jsonOverHttp('/json/list')
    const pageTarget = targets.find((t) => t.type === 'page')
    if (pageTarget === undefined) throw new Error('no page target in Chromium')
    const cdp = await Cdp.connect(pageTarget.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: VIEW.width,
      height: VIEW.height,
      deviceScaleFactor: 2,
      mobile: false,
    })

    mkdirSync(OUT, { recursive: true })
    const written = []

    // Layout diagnostic: load any page and dump the selectors it exposes on
    // `window.__m`. Used to size the panel against the real stylesheet's
    // max-height instead of guessing.
    if (process.env.DSHTB_MEASURE) {
      const target = process.env.DSHTB_MEASURE
      await cdp.navigate('file:///' + resolve(target).replace(/\\/g, '/'))
      await sleep(500)
      const measured = await cdp.evaluate('JSON.stringify(window.__m || null)')
      writeFileSync(join(OUT, 'measure.json'), measured ?? 'null', 'utf8')
      console.log('measured → ' + join(OUT, 'measure.json'))
      return
    }

    for (const shot of SHOTS) {
      const file = join(tmpdir(), `dshtb-fixture-${shot.file}.html`)
      writeFileSync(file, page(shot.html, shot.extra), 'utf8')
      await cdp.navigate('file:///' + file.replace(/\\/g, '/'))
      await sleep(600)

      const state = await cdp.evaluate('window.__fixture')
      if (!state?.ok) throw new Error(`${shot.file}: client half failed to apply — ${state?.error}`)
      await assertStyled(cdp, FIXTURE_CLASSES)

      let clip = null
      if (shot.clip !== null) {
        const rect = await cdp.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(shot.clip)})
          if (!el) return null
          const r = el.getBoundingClientRect()
          return { x: Math.max(0, Math.floor(r.x)), y: Math.max(0, Math.floor(r.y)),
                   width: Math.ceil(r.width), height: Math.ceil(r.height) }
        })()`)
        if (rect === null) throw new Error(`${shot.file}: clip target ${shot.clip} not found`)
        clip = rect
        if (process.env.DSHTB_DEBUG) {
          console.error(
            shot.file + ' DIAG ' + JSON.stringify(await cdp.evaluate(`(() => {
              const root = document.querySelector('.dshtb-root')
              const card = document.querySelector('.dshtb-card')
              const list = document.querySelector('.dshtb-list')
              const cs = (el) => { const s = getComputedStyle(el); return { h: s.height, maxH: s.maxHeight, ov: s.overflow } }
              const box = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)] }
              return { viewport: [innerWidth, innerHeight], rootBox: box(root), cardBox: box(card),
                       rootCss: cs(root), cardCss: cs(card),
                       cardScroll: [card.clientHeight, card.scrollHeight],
                       fit: document.head.lastElementChild.textContent.slice(0, 60),
                       listBox: list ? box(list) : null, listScroll: list ? [list.clientHeight, list.scrollHeight] : null }
            })()`)),
          )
        }
      }

      const target = join(OUT, shot.file)
      await cdp.shot(target, clip)
      const size = readFileSync(target).length
      written.push({ file: shot.file, title: shot.title, bytes: size, clip })
      console.log(
        `${shot.file}  ${shot.title.padEnd(16)} ${String(Math.round(size / 1024)).padStart(5)} KiB` +
          (clip ? `  clip ${clip.width}×${clip.height}@2x` : ''),
      )
    }

    writeFileSync(
      join(OUT, '..', 'screenshots.json'),
      JSON.stringify(written.map((w) => 'assets/' + w.file), null, 2) + '\n',
      'utf8',
    )
    console.log(
      JSON.stringify(
        { ok: true, browser: version.Browser, sheets: await cdp.evaluate('window.__fixture.sheets'), files: written },
        null,
        2,
      ),
    )
  } finally {
    chrome.kill()
  }
}

/**
 * Every panel class the fixture draws, checked against the stylesheet before a
 * picture is taken. Keeping the list here (rather than deriving it from the
 * markup) is the point: it is the assertion, not a summary of the input.
 */
const FIXTURE_CLASSES = [
  'dshtb-root', 'dshtb-card', 'dshtb-head', 'dshtb-title', 'dshtb-sp', 'dshtb-stats',
  'dshtb-skin', 'dshtb-log', 'dshtb-dot', 'dshtb-fold', 'dshtb-resize',
  'dshtb-seg', 'dshtb-sect', 'dshtb-compose', 'dshtb-add', 'dshtb-ic', 'dshtb-modes',
  'dshtb-hint', 'dshtb-when', 'dshtb-whenedit', 'dshtb-dir',
  'dshtb-list', 'dshtb-listhint', 'dshtb-group',
  'dshtb-item', 'dshtb-grip', 'dshtb-checks', 'dshtb-cb', 'dshtb-body', 'dshtb-t',
  'dshtb-note', 'dshtb-facts', 'dshtb-meta', 'dshtb-chip', 'dshtb-whenchip', 'dshtb-acts',
  'dshtb-imgs', 'dshtb-imgwrap', 'dshtb-img', 'dshtb-imgx',
  'dshtb-donelist', 'dshtb-foot', 'dshtb-link',
  'dshtb-logview', 'dshtb-logbar', 'dshtb-logsrc', 'dshtb-logfilter', 'dshtb-logmeta',
  'dshtb-loglist', 'dshtb-logrow',
]

main().catch((err) => {
  console.error('capture failed: ' + (err && err.stack ? err.stack : err))
  process.exitCode = 1
})
