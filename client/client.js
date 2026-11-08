window.__ModuleLoader__.load({ id: "dsh-todo-board", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict'

/**
 * dsh-todo-board — browser half.
 *
 * Floating board in `shell.overlay` (frame-wide layer, top-right). Design
 * direction: a quiet white card on a blue accent — hairlines instead of
 * frames, one tinted colour per state, and motion used only where it carries
 * meaning (row arrival, a box being checked).
 *
 * Transport: GET/POST `/dsh-todo-board/api`.
 * Rows are drag-reorderable; on-screen top-to-bottom order IS the
 * auto-continue execution order.
 */

const React = require('react')
const h = React.createElement

const ROUTE = '/dsh-todo-board/api'
const MODES = ['remind', 'resume', 'newSession']
/** Must not exceed the host's MAX_IMAGES_PER_TODO. */
const MAX_IMAGES = 4
const MEDIA_TYPE_BY_EXTENSION = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}
const MODE_LABEL = { remind: '提醒', resume: '自动续跑', newSession: '自动新会话' }
const MODE_SHORT = { remind: '提醒', resume: '续跑', newSession: '新会话' }
const MODE_HINT = {
  remind: '只在这里提醒你，不会自动发送任何消息。',
  resume: 'AI 一停就自动把这条注入当前会话继续跑。',
  newSession: 'AI 一停就自动新建一个同目录会话来执行。',
}
/**
 * Every row carries exactly one state chip, because a state you have to infer is
 * a state you cannot see. An earlier version labelled only the states that "need
 * attention" (已派发 / 进行中 / 悬住) and left 未派发 and 已完成 silent, on the
 * theory that an empty checkbox and a struck-through title already said it —
 * in practice that meant most rows showed no state at all, which is exactly the
 * question it was supposed to answer.
 *
 * Emphasis still varies, so a board of ordinary rows stays quiet: only 进行中 and
 * a stuck row shout, and `done` recedes.
 */
const STATE_CHIP = {
  pending: { label: '未派发', cls: 'idle', hint: '还没交给任何会话；点 ▶ 可以立即接续到当前会话。' },
  dispatched: { label: '已派发', cls: 'sent', hint: '已经派发过一次，目标会话还在。' },
  running: { label: '进行中', cls: 'run', hint: '目标会话正在执行这条待办。' },
  done: { label: '已完成', cls: 'ok', hint: 'AI 已勾选完成；等你验收。' },
  lost: { label: '目标会话丢失', cls: 'bad', hint: '派发失败，已停下等待处理。' },
}
/**
 * What a parked row is actually parked on. `lostKind` comes from the host, so a
 * refusal is labelled by its real cause rather than always blaming a missing
 * session. The hint is the way out, not a restatement of the problem.
 */
const LOST_CHIP = {
  'no-session': {
    label: STATE_CHIP.lost.label,
    hint: '改执行模式、换目录，或等到点自动重试（间隔会逐次拉长）。',
  },
  image: {
    label: '图片被拒',
    hint: '目标模型不接受图片输入：换一个支持图片的模型，或先移除待办上的图片。',
  },
  spawn: { label: '建会话失败', hint: '新建会话没有成功；修好后会按退避自动重试。' },
  preset: { label: '预设解析失败', hint: '解析 agent preset 失败；修好后会按退避自动重试。' },
  agents: { label: '服务不可用', hint: 'agents 服务不可用；恢复后会按退避自动重试。' },
}
const MONO = 'ui-monospace,"Cascadia Mono","SF Mono",Menlo,Consolas,monospace'

/**
 * The four looks the panel can wear, in cycle order.
 *
 * The first is the default and is deliberately NOT described by a block further
 * down: it *is* the base stylesheet, which stays unscoped, and each skin block
 * then states only what it changes. One description of the default look rather
 * than two that can drift apart.
 *
 * Every colour in that base sheet is a `var(--tb-*)`, which is what lets
 * `theme` be a palette swap rather than a second copy of every rule: it
 * re-binds those variables to the GUI's tokens and nothing else.
 *
 * A skin is presentation only — it may move padding, borders, type and density,
 * but never which control exists, what a control means, or what goes on the
 * wire. The square 「AI 已完成」 box versus the round 「已验收」 box is meaning
 * rather than decoration, so it stays square-and-round in all four.
 *
 * The default's id is still `ticket`: that string is what earlier builds wrote
 * into localStorage, and renaming it would silently drop a stored choice.
 */
const SKINS = [
  { id: 'ticket', name: '蓝白', glyph: '\u25FB', hint: '白底蓝字、状态是一块淡色、留白克制（默认）' },
  { id: 'plain', name: '素白', glyph: '\u25A4', hint: '去掉卡片边框与分隔线，只靠留白分层；状态收成一个色点' },
  { id: 'dense', name: '紧凑', glyph: '\u2263', hint: '同样极简，字号行距各降一档，一屏能看更多条' },
  { id: 'theme', name: '随主题', glyph: '\u25D1', hint: '跟 DSH 界面走：深色界面下这块板也是深色的' },
]

/**
 * The plugin build this browser half belongs to, printed in the footer.
 *
 * It tracks `package.json`'s version rather than "the last time this file
 * changed": the footer answers "which build am I actually looking at?", and the
 * host and browser halves of one release are one build. `client-smoke.mjs` pins
 * the two together, because a footer that lies is worse than no footer.
 */
const BUILD = '0.14.11'

/**
 * How often a VISIBLE panel re-reads the board.
 *
 * Named rather than inlined because two places now depend on it (the interval
 * and the tests), and because the number is a judgement call worth seeing in
 * one place: fast enough that a row the AI just ticked feels immediate, slow
 * enough that the host is not answering 400 requests a minute.
 *
 * While the page is hidden the interval is suspended outright — see the poll
 * effect.
 */
const POLL_MS = 2500

/**
 * Severity filters in the log view, most severe first.
 *
 * `error` is the default because that is what the dot on the log button means:
 * opening the view to see why the dot lit should not first require narrowing a
 * list. `debug` is only ever present when the host captured it, and the host
 * keeps it in memory only — so a reader who sees debug lines is looking at
 * something that will not survive a restart, which the view says out loud.
 */
const LOG_LEVELS = ['error', 'warn', 'info', 'debug']
const LOG_SOURCE_KEY = 'dsh.todoBoard.logSource.v1'
/** Log lines the panel keeps client-side, so scrolling back costs no requests. */
const LOG_KEEP = 400

const CSS = `
/* ---------------------------------------------------------------------------
   The default look: 「蓝白」 — a white card, blue ink, one soft accent.

   Every colour in this sheet is a var(--tb-*). That is what keeps a skin a
   skin: the 「随主题」 block further down re-binds those variables to the GUI's
   own tokens and the whole panel follows the host, while every rule here —
   layout, type, density, motion — stays exactly as it is. So the panel owns
   its palette by default and borrows the host's on request, and neither choice
   costs the other one its design.
   --------------------------------------------------------------------------- */
.dshtb-root{position:fixed;top:56px;right:16px;z-index:2147482000;pointer-events:auto;
  /* 纸：卡片本身、最浅的一层填充、最深的一层悬停 */
  --tb-paper:#ffffff;--tb-mist:#f4f7fc;--tb-haze:#e9f0fc;
  /* 线 */
  --tb-line:#e3e9f3;--tb-edge:#cdd9ea;
  /* 字 */
  --tb-ink:#122240;--tb-dim:#64789b;--tb-faint:#95a4bd;
  /* 蓝 */
  --tb-blue:#2f6bff;--tb-blue-deep:#1b53d6;--tb-blue-wash:#eaf1ff;
  /* 状态色都配一份淡底：状态用色块说，不再用一圈边框说 */
  --tb-green:#0f9d58;--tb-green-wash:#e7f6ee;
  --tb-amber:#bd740a;--tb-amber-wash:#fdf2e0;
  --tb-red:#d92d2d;--tb-red-wash:#fdecec;
  --tb-ring:rgba(47,107,255,.16);
  --tb-shadow:0 18px 44px -20px rgba(18,42,86,.30),0 2px 6px -2px rgba(18,42,86,.08);
  --tb-lift:0 1px 2px rgba(18,42,86,.08);
  display:flex;flex-direction:column;width:380px;max-width:calc(100vw - 32px);
  max-height:min(80vh,680px);font-size:13px;line-height:1.5;color:var(--tb-ink);
  color-scheme:light}
.dshtb-root *{box-sizing:border-box}
.dshtb-card{position:relative;flex:1;min-height:0;display:flex;flex-direction:column;border-radius:16px;
  background:var(--tb-paper);border:1px solid var(--tb-line);overflow:hidden;
  box-shadow:var(--tb-shadow);animation:dshtb-in .16s ease-out}
.dshtb-resize{position:absolute;right:1px;bottom:1px;width:16px;height:16px;cursor:nwse-resize;
  opacity:.5;background:
    linear-gradient(135deg,transparent 46%,currentColor 46%,currentColor 54%,transparent 54%),
    linear-gradient(135deg,transparent 68%,currentColor 68%,currentColor 76%,transparent 76%);
  color:var(--tb-faint)}
.dshtb-resize:hover{opacity:1;color:var(--tb-blue)}
@keyframes dshtb-in{from{opacity:0;transform:translateY(-6px) scale(.985)}to{opacity:1;transform:none}}
.dshtb-head{display:flex;align-items:center;gap:8px;padding:11px 13px;
  border-bottom:1px solid var(--tb-line);cursor:move;user-select:none}
.dshtb-title{font-weight:700;letter-spacing:.01em;white-space:nowrap}
.dshtb-title b{color:var(--tb-blue)}
/* The header counts are badges, not dots: on a white card a tinted pill reads as
   a number. 待验 (waiting on you) is the only one that gets a colour of its own,
   because it is the only one that is asking you for something. */
.dshtb-stats{display:flex;gap:6px;font:600 11px/1 ${MONO};font-variant-numeric:tabular-nums;
  white-space:nowrap}
.dshtb-stats i{font-style:normal;display:inline-flex;align-items:center;gap:4px;padding:3px 8px;
  border-radius:7px;background:var(--tb-blue-wash);color:var(--tb-blue-deep)}
.dshtb-stats i+i{background:var(--tb-amber-wash);color:var(--tb-amber)}
.dshtb-sp{flex:1}
/* Three title-bar controls, one geometry: the fold control, the skin control
   and the log control. They stay separate classes because they are separate
   controls — the fold parks the panel, the skin changes how it looks, the log
   swaps the page — and nothing should be able to find one while looking for
   another. Only the shared geometry lives in this rule. */
.dshtb-fold,.dshtb-skin,.dshtb-log,.dshtb-settings,.dshtb-auto{width:26px;height:26px;border:1px solid transparent;border-radius:8px;
  background:transparent;color:var(--tb-faint);cursor:pointer;font:600 14px/1 ${MONO};padding:0;
  display:grid;place-items:center;transition:background .12s,color .12s}
.dshtb-fold:hover,.dshtb-skin:hover,.dshtb-log:hover,.dshtb-settings:hover,.dshtb-auto:hover{background:var(--tb-haze);color:var(--tb-blue-deep)}
.dshtb-fold:focus-visible,.dshtb-skin:focus-visible,.dshtb-log:focus-visible,.dshtb-settings:focus-visible,.dshtb-auto:focus-visible{outline:2px solid var(--tb-blue);outline-offset:1px}
/* Auto-capture on: the dot is filled and blue, so "is it recording" is answerable
   from across the desk. Off is a hollow ring, deliberately not a red slash — this
   is a mode, not an error. */
.dshtb-auto.on{color:var(--tb-blue)}
/* Section label doubling as the fold/unfold control for what follows it. */
.dshtb-sect{display:flex;align-items:center;gap:6px;width:100%;padding:11px 14px 6px;
  border:0;background:transparent;cursor:pointer;user-select:none;text-align:left;
  font:600 11.5px/1 inherit;letter-spacing:.02em;color:var(--tb-dim);
  transition:color .12s}
.dshtb-sect:hover{color:var(--tb-blue-deep)}
.dshtb-sect::after{content:'';flex:1;height:1px;background:var(--tb-line)}
.dshtb-sect .car{font:700 10px/1 ${MONO};color:var(--tb-dim);transition:color .12s}
.dshtb-sect:hover .car{color:var(--tb-blue)}
/* The scope switcher: a track, and a white pill for whatever is selected. */
.dshtb-seg{display:flex;gap:2px;margin:10px 12px 2px;padding:3px;border-radius:12px;
  background:var(--tb-mist);border:1px solid transparent}
.dshtb-seg button{flex:1;display:flex;align-items:center;justify-content:center;gap:5px;padding:6px 5px;
  border:0;border-radius:9px;background:transparent;color:var(--tb-dim);font:inherit;font-size:12.5px;
  cursor:pointer;transition:background .14s,color .14s,box-shadow .14s}
.dshtb-seg button:hover{color:var(--tb-ink)}
.dshtb-seg button.on{background:var(--tb-paper);color:var(--tb-blue-deep);font-weight:600;
  box-shadow:var(--tb-lift)}
.dshtb-seg em{font-style:normal;font:600 11px/1 ${MONO};font-variant-numeric:tabular-nums;
  color:var(--tb-faint)}
.dshtb-seg button.on em{color:var(--tb-blue)}
.dshtb-compose{display:flex;flex-direction:column;gap:9px;padding:11px 13px 13px}
.dshtb-add{display:flex;gap:8px;align-items:flex-end}
.dshtb-add textarea{flex:1;min-width:0;min-height:66px;max-height:180px;resize:vertical;
  padding:9px 11px;border-radius:11px;border:1px solid var(--tb-line);
  background:var(--tb-mist);color:var(--tb-ink);font:inherit;font-size:13px;line-height:1.5;
  outline:none;transition:border-color .14s,box-shadow .14s,background .14s}
.dshtb-add textarea::placeholder{color:var(--tb-faint)}
.dshtb-add textarea:focus{background:var(--tb-paper);border-color:var(--tb-blue);
  box-shadow:0 0 0 3px var(--tb-ring)}
/* The composer's ＋ is the panel's one filled button — the action the whole card
   exists for. It shares a class with a row's hover icons because it shares a
   shape, not a job, so the fill is scoped to the composer. */
.dshtb-add .dshtb-ic{flex:0 0 auto;width:34px;height:34px;border-radius:10px;font-size:15px;
  background:var(--tb-blue);color:#fff}
.dshtb-add .dshtb-ic:hover:not(:disabled){background:var(--tb-blue-deep);color:#fff}
.dshtb-add .dshtb-ic:disabled{background:var(--tb-mist);color:var(--tb-faint);opacity:1}
/* The execution mode is a three-way choice, so it is drawn as one: the same
   track-and-pill shape as the scope switcher, in a row of its own. */
.dshtb-modes{display:flex;gap:2px;align-self:flex-start;padding:3px;border-radius:11px;
  background:var(--tb-mist)}
.dshtb-modes button{padding:6px 14px;border:0;border-radius:9px;background:transparent;color:var(--tb-dim);
  font:inherit;font-size:12.5px;line-height:1.2;cursor:pointer;white-space:nowrap;
  transition:background .14s,color .14s,box-shadow .14s}
.dshtb-modes button:hover{color:var(--tb-ink)}
.dshtb-modes button.on{background:var(--tb-paper);color:var(--tb-blue-deep);font-weight:600;
  box-shadow:var(--tb-lift)}
.dshtb-hint{font-size:11.5px;color:var(--tb-faint);line-height:1.45}
.dshtb-dir,.dshtb-when{display:flex;align-items:center;gap:8px;font:600 11px/1 ${MONO};color:var(--tb-dim)}
.dshtb-dir .lbl,.dshtb-when .lbl{letter-spacing:.06em;flex:0 0 auto}
.dshtb-dir input,.dshtb-when input{flex:1;min-width:0;padding:7px 9px;border-radius:9px;
  border:1px solid var(--tb-line);background:var(--tb-mist);color:var(--tb-ink);font:inherit;
  font-size:12px;outline:none;transition:border-color .14s,box-shadow .14s,background .14s}
.dshtb-dir input::placeholder{color:var(--tb-faint)}
.dshtb-dir input:focus,.dshtb-when input:focus{background:var(--tb-paper);border-color:var(--tb-blue);
  box-shadow:0 0 0 3px var(--tb-ring)}
/* The attachment area holds a hint and the pending thumbnails — no picker
   control, so no label styling belongs here any more. */
.dshtb-attach{display:flex;flex-direction:column;gap:6px}
.dshtb-thumbs{display:flex;flex-wrap:wrap;gap:6px}
.dshtb-thumb{position:relative;width:52px;height:52px;padding:0;border:1px solid var(--tb-line);
  border-radius:10px;background:var(--tb-mist);cursor:pointer;overflow:hidden}
.dshtb-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.dshtb-thumb .x{position:absolute;top:0;right:0;padding:0 3px;background:rgba(18,34,64,.62);color:#fff;
  font:700 10px/1.4 ${MONO};border-bottom-left-radius:7px}
.dshtb-imgs{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.dshtb-imgwrap{position:relative;display:inline-flex}
.dshtb-img{width:64px;height:64px;object-fit:cover;border-radius:10px;border:1px solid var(--tb-line);
  cursor:zoom-in;display:block}
.dshtb-imgx{position:absolute;top:-5px;right:-5px;width:17px;height:17px;padding:0;border:0;border-radius:50%;
  background:var(--tb-paper);color:var(--tb-dim);
  box-shadow:0 0 0 1px var(--tb-line),0 1px 3px rgba(18,42,86,.2);
  font:700 9px/1 ${MONO};cursor:pointer;display:grid;place-items:center}
.dshtb-imgx:hover{color:var(--tb-red)}
.dshtb-light{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:10px;background:rgba(14,24,44,.72);cursor:zoom-out;
  animation:dshtb-in .14s ease-out}
.dshtb-light img{max-width:88vw;max-height:82vh;border-radius:12px;box-shadow:0 20px 60px -18px rgba(8,18,38,.7);cursor:default}
.dshtb-lightcap{font:600 11px/1.4 ${MONO};color:#fff;opacity:.85}
.dshtb-list,.dshtb-donelist{overflow:auto;padding:2px 0 8px;scrollbar-width:thin}
.dshtb-list::-webkit-scrollbar,.dshtb-donelist::-webkit-scrollbar{width:9px}
.dshtb-list::-webkit-scrollbar-thumb,.dshtb-donelist::-webkit-scrollbar-thumb{background:var(--tb-edge);border-radius:5px;
  border:3px solid transparent;background-clip:content-box}
/* The one line that explains the mode chip, inside the list it applies to. Small
   and dim on purpose: it is read once, and it must never read as a control. */
.dshtb-listhint{padding:8px 14px 4px;font-size:11px;line-height:1.45;color:var(--tb-faint)}
/* A box header names the session that runs the rows under it, so it stays a
   real label — it just stops shouting. */
.dshtb-group{display:flex;align-items:center;gap:7px;padding:10px 14px 4px;
  font:600 11px/1 ${MONO};color:var(--tb-faint)}
.dshtb-group::after{content:'';flex:1;height:1px;background:var(--tb-line)}
/* A row nested under a container is indented, and a hairline keeps the eye on
   the parent column. Four levels is all the styling carries; the tree itself
   allows deeper, and beyond this the indent simply stops growing. */
.dshtb-item[data-dshtb-nest="1"]{margin-left:16px;border-left:2px solid var(--tb-line);border-top-left-radius:0;border-bottom-left-radius:0}
.dshtb-item[data-dshtb-nest="2"]{margin-left:32px;border-left:2px solid var(--tb-line);border-top-left-radius:0;border-bottom-left-radius:0}
.dshtb-item[data-dshtb-nest="3"]{margin-left:48px;border-left:2px solid var(--tb-line);border-top-left-radius:0;border-bottom-left-radius:0}
.dshtb-item[data-dshtb-nest="4"]{margin-left:64px;border-left:2px solid var(--tb-line);border-top-left-radius:0;border-bottom-left-radius:0}
.dshtb-boxempty{padding:8px 14px 10px;font-size:12px;color:var(--tb-faint)}
/* The gap between rows is the SIBLING drop zone. It is invisible until a drag
   starts, so the list keeps its old density and the extra target costs nothing
   when nobody is moving anything. */
.dshtb-gap{height:0;margin:0 14px;transition:height .1s ease}
.dshtb-gap.live{height:8px}
.dshtb-group.droptarget{background:var(--tb-blue-wash);border-radius:8px}
/* A row is the unit of work: it only gets a surface when the pointer is on it,
   and the bar on its left is the same blue every other rule in this sheet uses. */
.dshtb-item{display:flex;gap:9px;padding:9px 14px;align-items:flex-start;position:relative;
  border-top:2px solid transparent;animation:dshtb-row .2s ease-out both;transition:background .12s}
@keyframes dshtb-row{from{opacity:0;transform:translateX(-5px)}to{opacity:1;transform:none}}
.dshtb-item::before{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;background:transparent;
  transition:background .12s}
.dshtb-item:hover{background:var(--tb-haze)}
.dshtb-item:hover::before{background:var(--tb-blue)}
.dshtb-item.done{opacity:.6}
.dshtb-item.done .dshtb-t{text-decoration:line-through}
.dshtb-item.dragging{opacity:.3}
.dshtb-item.over{border-top-color:var(--tb-blue)}
.dshtb-grip{flex:0 0 auto;width:9px;padding-top:4px;cursor:grab;user-select:none;opacity:0;
  color:var(--tb-faint);font:700 10px/1 ${MONO};letter-spacing:-1px;transition:opacity .12s}
.dshtb-item:hover .dshtb-grip,.dshtb-item.dragging .dshtb-grip{opacity:.8}
.dshtb-grip:active{cursor:grabbing}
.dshtb-checks{display:flex;flex-direction:column;gap:6px;padding-top:1px;flex:0 0 auto}
.dshtb-cb{width:17px;height:17px;padding:0;border:1.5px solid var(--tb-edge);background:var(--tb-paper);
  cursor:pointer;display:grid;place-items:center;font:700 10px/1 ${MONO};color:transparent;
  transition:background .14s,border-color .14s,color .14s}
/* Square is the agent's own tick, round is yours — that is meaning, not
   decoration, so it survives every skin. */
.dshtb-cb.ai{border-radius:5px}
.dshtb-cb.me{border-radius:50%}
.dshtb-cb:hover{border-color:var(--tb-blue)}
.dshtb-cb.ai.on{background:var(--tb-blue);border-color:var(--tb-blue);color:#fff}
.dshtb-cb.me.on{background:var(--tb-green);border-color:var(--tb-green);color:#fff}
.dshtb-cb.on{animation:dshtb-pop .18s ease-out}
@keyframes dshtb-pop{0%{transform:scale(.55)}60%{transform:scale(1.18)}100%{transform:scale(1)}}
.dshtb-body{flex:1;min-width:0}
.dshtb-t{font-size:13px;word-break:break-word;white-space:pre-wrap;line-height:1.45}
.dshtb-facts{margin-top:3px;font:400 11px/1.4 ${MONO};font-variant-numeric:tabular-nums;
  color:var(--tb-faint);word-break:break-all}
.dshtb-t input{width:100%;padding:2px 6px;border-radius:6px;border:1px solid var(--tb-blue);
  background:var(--tb-mist);color:var(--tb-ink);font:inherit;outline:none;
  box-shadow:0 0 0 3px var(--tb-ring)}
.dshtb-edit{display:block;width:100%;min-height:76px;max-height:220px;resize:vertical;
  padding:7px 9px;border-radius:10px;border:1px solid var(--tb-blue);background:var(--tb-paper);
  color:var(--tb-ink);font:inherit;font-size:13px;line-height:1.45;outline:none;
  box-shadow:0 0 0 3px var(--tb-ring)}
.dshtb-edit::placeholder{color:var(--tb-faint)}
/* The note: plain text, never a control, so it must not look like one — no
   border, no background, no pointer cursor. It sits directly under the title and
   is clamped to two lines (one in the dense skin); the clamp is visual only, the
   whole string stays in the DOM, so selecting a row still copies every character.
   overflow-wrap:anywhere is load-bearing: notes are pasted paths and logs, and a
   long unbroken token would otherwise widen the panel instead of wrapping. */
.dshtb-note{margin-top:3px;font-size:11.5px;line-height:1.45;color:var(--tb-dim);
  white-space:pre-wrap;overflow-wrap:anywhere;
  display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
/* The note editor is its own control (never folded into the title editor): a
   note is multi-line text, and the title editor's single-line commit rules would
   cut it in half. */
.dshtb-noteedit{display:flex;flex-wrap:wrap;gap:6px;margin-top:5px}
.dshtb-notearea{flex:1 0 100%;width:100%;min-height:54px;max-height:220px;resize:vertical;
  padding:7px 9px;border-radius:10px;border:1px solid var(--tb-blue);background:var(--tb-paper);
  color:var(--tb-ink);font:inherit;font-size:12.5px;line-height:1.45;outline:none;
  box-shadow:0 0 0 3px var(--tb-ring)}
.dshtb-notearea::placeholder{color:var(--tb-faint)}
.dshtb-notesave,.dshtb-notecancel{padding:4px 11px;border:1px solid var(--tb-line);border-radius:8px;
  background:var(--tb-paper);color:var(--tb-dim);font:inherit;font-size:11.5px;cursor:pointer;
  transition:border-color .12s,color .12s,background .12s}
.dshtb-notesave{background:var(--tb-blue);border-color:var(--tb-blue);color:#fff}
.dshtb-notesave:hover{background:var(--tb-blue-deep);border-color:var(--tb-blue-deep);color:#fff}
.dshtb-notecancel:hover{border-color:var(--tb-edge);color:var(--tb-ink)}
/* State stops being a frame and becomes a tint: the word reads first and the
   colour says what it is, so only 「进行中」, 「到点」 and a stuck row get weight. */
.dshtb-meta{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px;
  font:400 12px/1.5 ${MONO};color:var(--tb-dim)}
.dshtb-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:7px;
  background:var(--tb-mist);border:1px solid transparent;white-space:nowrap;
  font:inherit;font-size:11.5px;color:var(--tb-dim)}
button.dshtb-chip{cursor:pointer;font:inherit;color:inherit;transition:background .12s,color .12s}
button.dshtb-chip:hover{background:var(--tb-haze);color:var(--tb-ink)}
.dshtb-chip.sent{background:var(--tb-green-wash);color:var(--tb-green)}
.dshtb-chip.idle{opacity:.75}
.dshtb-chip.ok{background:var(--tb-green-wash);color:var(--tb-green)}
.dshtb-chip.due{background:var(--tb-amber-wash);color:var(--tb-amber);font-weight:600}
.dshtb-chip.run{background:var(--tb-blue-wash);color:var(--tb-blue-deep);font-weight:600}
.dshtb-chip.bad{background:var(--tb-red-wash);color:var(--tb-red);font-weight:600;cursor:help}
.dshtb-chip.quiet{opacity:.75}
/* Written by the plugin, not by the person. Blue-wash rather than a loud colour:
   it is a provenance note, not a warning. */
.dshtb-chip.auto{background:var(--tb-blue-wash);color:var(--tb-blue-deep);font-weight:600}
/* An auto-captured row keeps its action row visible — the 回到原会话 button is
   the point of that row, and a button you have to hover to discover is a button
   nobody discovers. Hand-written rows stay quiet until hover. */
.dshtb-item.auto .dshtb-acts{opacity:1}
.dshtb-chip.quiet:hover{opacity:1}
/* The ✕ sits beside the time chip rather than inside it: a button may not nest
   another control, and keep it narrow so the pair reads as one chip. */
.dshtb-chip.x{padding:2px 5px;cursor:pointer}
.dshtb-whenchip{display:inline-flex;align-items:center;gap:2px;padding:1px 4px;border-radius:7px;
  background:var(--tb-blue-wash);border:1px solid transparent}
.dshtb-whenedit{padding:1px 4px;border:0;background:transparent;color:var(--tb-ink);
  font:inherit;font-size:11px;outline:none}
.dshtb-whenchip .dshtb-ic{width:18px;height:18px;font-size:10px}
.dshtb-acts{display:flex;gap:1px;flex:0 0 auto;opacity:0;transition:opacity .12s}
.dshtb-item:hover .dshtb-acts{opacity:1}
.dshtb-ic{width:22px;height:22px;padding:0;border:0;border-radius:7px;background:transparent;
  color:var(--tb-faint);cursor:pointer;display:grid;place-items:center;font-size:11px;
  transition:background .12s,color .12s}
.dshtb-ic:hover{background:var(--tb-paper);color:var(--tb-ink)}
.dshtb-ic:disabled{opacity:.4;cursor:default}
.dshtb-empty{padding:26px 16px;text-align:center;color:var(--tb-faint)}
.dshtb-empty b{display:block;font:700 24px/1 ${MONO};opacity:.4;margin-bottom:9px}
.dshtb-empty span{font-size:11px;opacity:.9}
/* One short line, not an empty box: an empty section should cost nothing. */
.dshtb-doneempty{padding:6px 14px 8px;font-size:11.5px;color:var(--tb-faint)}
.dshtb-foot{display:flex;align-items:center;flex-wrap:wrap;gap:6px 8px;padding:8px 12px;
  border-top:1px solid var(--tb-line);margin-top:auto;
  font:600 11px/1 ${MONO};font-variant-numeric:tabular-nums;color:var(--tb-dim)}
.dshtb-link{padding:3px 8px;border:1px solid transparent;border-radius:7px;background:transparent;
  color:var(--tb-dim);font:inherit;cursor:pointer;transition:background .12s,color .12s}
.dshtb-link:hover{background:var(--tb-haze);color:var(--tb-blue-deep)}
.dshtb-link.off{opacity:.5;cursor:not-allowed}
/* Shipped Cordis popup: parked under this panel, right-aligned to it.
   !important beats the inline left/bottom the panel computes from its anchor. */
[data-dsh-todo-cordis]>div:first-child{left:auto !important;bottom:auto !important;
  right:var(--dsh-todo-cordis-right,16px) !important;
  top:var(--dsh-todo-cordis-top,120px) !important;
  max-height:var(--dsh-todo-cordis-maxh,60vh) !important}
.dshtb-err{padding:7px 13px;background:var(--tb-red-wash);color:var(--tb-red);
  font:400 10.5px/1.45 ${MONO};word-break:break-all;border-top:1px solid var(--tb-line)}
/* Parked as one line: label + counts + the next task, expandable by a click.
   align-self keeps it hugging its content instead of stretching to the card width. */
.dshtb-pill{align-self:flex-start;display:flex;align-items:center;gap:9px;min-width:0;
  max-width:calc(100vw - 32px);padding:7px 12px;border-radius:12px;
  background:var(--tb-paper);border:1px solid var(--tb-line);cursor:grab;user-select:none;
  touch-action:none;box-shadow:var(--tb-shadow);transition:border-color .14s}
.dshtb-pill:active{cursor:grabbing}
.dshtb-pill:hover{border-color:var(--tb-edge)}
.dshtb-pill .lbl{font:700 10px/1 ${MONO};letter-spacing:.14em;color:var(--tb-blue)}
.dshtb-pill .next{flex:1;min-width:0;max-width:220px;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;font-size:12px;color:var(--tb-dim)}
.dshtb-pill .next.q{font-style:italic;opacity:.8}
.dshtb-badge{min-width:19px;height:19px;padding:0 6px;border-radius:10px;background:var(--tb-blue);
  color:#fff;font:700 10px/1 ${MONO};font-variant-numeric:tabular-nums;
  display:inline-grid;place-items:center}
.dshtb-badge.warn{background:var(--tb-amber-wash);color:var(--tb-amber)}
/* The log button and its "something went wrong" dot. The dot rides the button
   instead of a separate node so it cannot drift away from the control it
   annotates, and it is absolutely positioned so lighting it never reflows the
   title bar. */
.dshtb-log{position:relative}
.dshtb-log.on{background:var(--tb-blue-wash);color:var(--tb-blue-deep)}
/* Settings view. Same page-swap shape as the log view, but it is a FORM: the
   only surface here a user types into besides the composer. */
.dshtb-settings.on{background:var(--tb-blue-wash);color:var(--tb-blue-deep)}
.dshtb-settingsview{display:flex;flex-direction:column;min-height:0;flex:1;padding:4px 14px 12px;gap:11px;
  overflow-y:auto}
.dshtb-settingsview .dshtb-setrow{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--tb-ink)}
.dshtb-settingsview label.dshtb-setrow{cursor:pointer}
.dshtb-settingsview input[type=checkbox]{width:15px;height:15px;accent-color:var(--tb-blue);cursor:pointer}
.dshtb-setnum{width:84px;padding:5px 8px;border-radius:7px;border:1px solid var(--tb-line);
  background:var(--tb-paper);color:var(--tb-ink);font:inherit;font-size:12.5px}
.dshtb-setnum:focus{outline:none;border-color:var(--tb-blue);box-shadow:0 0 0 3px var(--tb-ring)}
.dshtb-setnum:disabled{opacity:.45;cursor:not-allowed}
.dshtb-sethint{font-size:11.5px;color:var(--tb-faint);line-height:1.5}
.dshtb-setactions{display:flex;align-items:center;gap:8px;padding-top:2px}
.dshtb-setbtn{padding:6px 13px;border-radius:8px;border:1px solid var(--tb-line);background:var(--tb-paper);
  color:var(--tb-ink);font:inherit;font-size:12.5px;cursor:pointer}
.dshtb-setbtn:hover{background:var(--tb-haze);border-color:var(--tb-blue)}
.dshtb-setbtn.primary{background:var(--tb-blue);border-color:var(--tb-blue);color:#fff}
.dshtb-setbtn.primary:hover{background:var(--tb-blue-deep);border-color:var(--tb-blue-deep)}
.dshtb-setbtn:disabled{opacity:.5;cursor:not-allowed}
.dshtb-seterr{font-size:12px;color:var(--tb-red);line-height:1.5}
.dshtb-dot{position:absolute;top:2px;right:2px;width:6px;height:6px;border-radius:50%;
  background:var(--tb-red);box-shadow:0 0 0 1.5px var(--tb-paper)}
/* Developer view: monospace, dense, unabashedly plain. This is not a surface to
   make pretty — it is a surface to read a stack trace on. */
.dshtb-logview{display:flex;flex-direction:column;min-height:0;flex:1}
.dshtb-logbar{display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:8px 13px;
  border-bottom:1px solid var(--tb-line)}
.dshtb-logbar button{padding:3px 9px;border-radius:7px;border:1px solid transparent;
  background:var(--tb-mist);color:var(--tb-dim);font:600 10.5px/1.4 ${MONO};cursor:pointer;
  transition:background .12s,color .12s}
.dshtb-logbar button:hover{color:var(--tb-ink)}
.dshtb-logbar button.on{background:var(--tb-blue-wash);color:var(--tb-blue-deep)}
/* The source toggle is its own class rather than a reuse of the title-bar log
   button: same reason the three title-bar controls are separate — a class is
   how something finds exactly one control. */
.dshtb-logsrc{min-width:56px}
.dshtb-logfilter{flex:1;min-width:90px;padding:4px 9px;border-radius:8px;border:1px solid var(--tb-line);
  background:var(--tb-mist);color:var(--tb-ink);font:400 11px/1.4 ${MONO};outline:none;
  transition:border-color .14s,box-shadow .14s}
.dshtb-logfilter:focus{border-color:var(--tb-blue);box-shadow:0 0 0 3px var(--tb-ring)}
.dshtb-logmeta{padding:6px 13px;border-bottom:1px solid var(--tb-line);
  font:400 10px/1.5 ${MONO};color:var(--tb-faint);word-break:break-all}
.dshtb-logmeta b{color:var(--tb-amber);font-weight:700}
.dshtb-loglist{flex:1;min-height:0;overflow:auto;padding:2px 0}
.dshtb-logrow{display:flex;gap:9px;padding:5px 13px;border-bottom:1px solid var(--tb-line);
  font:400 10.5px/1.55 ${MONO};align-items:flex-start}
.dshtb-logrow:hover{background:var(--tb-haze)}
.dshtb-logrow .at{flex:0 0 auto;opacity:.6;font-variant-numeric:tabular-nums}
.dshtb-logrow .lv{flex:0 0 auto;font-weight:700;text-transform:uppercase;letter-spacing:.05em}
.dshtb-logrow.error .lv{color:var(--tb-red)}
.dshtb-logrow.warn .lv{color:var(--tb-amber)}
.dshtb-logrow.info .lv{color:var(--tb-faint)}
.dshtb-logrow.debug .lv{opacity:.65}
.dshtb-logrow .body{flex:1;min-width:0;white-space:pre-wrap;word-break:break-word}
.dshtb-logrow .src{opacity:.6}
.dshtb-logempty{padding:22px 14px;text-align:center;color:var(--tb-faint);font:400 11.5px/1.6 ${MONO}}
`

/**
 * The optional skins, each scoped by `[data-dshtb-skin]` on the panel root.
 *
 * They are additive on purpose: the base stylesheet above describes the default
 * 「蓝白」 look, so disabling a declaration here restores the shipped panel
 * rather than an unstyled one. Everything is scoped under the root attribute,
 * so no skin can reach a node outside this panel — the GUI around it is never
 * affected by which skin is selected.
 *
 * `plain` is the information diet: no frames, no rules, no chips — a state
 * becomes a coloured dot, and the schedule becomes the only chip left, because
 * it is the one thing a row must stay able to change.
 */
const CSS_PLAIN = `
.dshtb-root[data-dshtb-skin="plain"] .dshtb-card{
  border-color:transparent;border-radius:18px;box-shadow:var(--tb-shadow)}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-head{border-bottom:0;padding:13px 15px 8px}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-title{font-weight:600;letter-spacing:0}
/* With no frame anywhere else on the card, a filled count badge would be the
   loudest thing in the header — so the counts go back to being readouts, and
   待验 keeps the one colour it has. */
.dshtb-root[data-dshtb-skin="plain"] .dshtb-stats{gap:11px}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-stats i,
.dshtb-root[data-dshtb-skin="plain"] .dshtb-stats i+i{background:transparent;padding:0;color:var(--tb-dim)}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-stats i+i{color:var(--tb-amber)}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-seg{
  background:transparent;border:0;border-radius:0;padding:0 15px;margin:8px 0 0;gap:18px}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-seg button{
  flex:0 0 auto;padding:4px 0;border-radius:0;border-bottom:1.5px solid transparent;
  font-size:12.5px;color:var(--tb-dim)}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-seg button:hover{color:var(--tb-ink)}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-seg button.on{
  background:transparent;box-shadow:none;color:var(--tb-blue-deep);border-bottom-color:var(--tb-blue);
  font-weight:600}
/* The section label stays legible and keeps saying what it hides — it just
   stops shouting. It is NOT hidden: the label is the only thing that says what
   a folded section is, which is the whole reason it doubles as the control. */
.dshtb-root[data-dshtb-skin="plain"] .dshtb-sect{
  letter-spacing:0;padding:11px 15px 5px;gap:6px;font:600 12px/1 inherit}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-sect .car{font-size:10px;color:var(--tb-faint)}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-sect::after{display:none}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-compose{padding:9px 15px 14px}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-add textarea{
  border-color:transparent;background:var(--tb-mist);border-radius:12px;padding:10px 12px}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-add textarea:focus{
  background:var(--tb-paper);border-color:var(--tb-blue);box-shadow:0 0 0 3px var(--tb-ring)}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-modes{gap:0;padding:0;background:transparent}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-modes button{padding:5px 13px;border-radius:0}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-modes button:hover{background:transparent;color:var(--tb-ink)}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-modes button.on{
  background:transparent;box-shadow:inset 0 -1.5px 0 var(--tb-blue);color:var(--tb-blue-deep)}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-dir input,
.dshtb-root[data-dshtb-skin="plain"] .dshtb-when input{border-color:transparent;background:var(--tb-mist)}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-list,
.dshtb-root[data-dshtb-skin="plain"] .dshtb-donelist{padding:0 0 10px}
/* The group heading is the directory a row belongs to, so it stays readable —
   it just loses its rule and its tracking. Keeping the text at a small size
   rather than at zero is deliberate: a zero font size here would erase the only
   on-screen statement of which directory you are looking at. */
.dshtb-root[data-dshtb-skin="plain"] .dshtb-group{
  padding:13px 15px 2px;font:600 11px/1 ${MONO};color:var(--tb-faint)}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-group::after{display:none}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-item{padding:9px 15px;gap:10px}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-item:hover{background:var(--tb-mist)}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-item::before{display:none}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-grip{opacity:.28}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-facts{font-size:10.5px;opacity:.85}
/* A state stops being a tinted label and becomes its own colour: a dot for the
   quiet states, a filled pill only where the row is actually asking for you. */
.dshtb-root[data-dshtb-skin="plain"] .dshtb-chip{
  border:0;background:transparent;padding:0;gap:5px;font-size:11.5px;border-radius:0}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-chip::before{
  content:'';width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.45;flex:0 0 auto}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-chip.idle{opacity:.6}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-chip.sent::before,
.dshtb-root[data-dshtb-skin="plain"] .dshtb-chip.ok::before{opacity:.9}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-chip.run,
.dshtb-root[data-dshtb-skin="plain"] .dshtb-chip.bad{padding:2px 9px;border-radius:999px}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-chip.run{background:var(--tb-blue-wash);color:var(--tb-blue-deep)}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-chip.bad{background:var(--tb-red-wash);color:var(--tb-red)}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-chip.run::before,
.dshtb-root[data-dshtb-skin="plain"] .dshtb-chip.bad::before{opacity:1}
/* The schedule keeps a real frame: it is the one chip that must still look
   like something you can press. */
.dshtb-root[data-dshtb-skin="plain"] .dshtb-chip.quiet,
.dshtb-root[data-dshtb-skin="plain"] .dshtb-chip.due{
  border:1px solid var(--tb-edge);border-radius:999px;padding:2px 9px;background:transparent}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-chip.quiet::before,
.dshtb-root[data-dshtb-skin="plain"] .dshtb-chip.due::before,
.dshtb-root[data-dshtb-skin="plain"] .dshtb-chip.x::before{display:none}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-whenchip{background:var(--tb-blue-wash);border-radius:999px}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-img,
.dshtb-root[data-dshtb-skin="plain"] .dshtb-thumb{border-color:transparent}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-foot{border-top:0;padding-top:2px}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-link{border-color:transparent}
.dshtb-root[data-dshtb-skin="plain"] .dshtb-pill{border-color:transparent;border-radius:14px}
`

/** `dense` keeps the structure of the default look and removes its air. */
const CSS_DENSE = `
.dshtb-root[data-dshtb-skin="dense"]{font-size:12px;line-height:1.42}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-head{padding:8px 11px;gap:6px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-card{border-radius:12px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-stats{gap:5px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-stats i{padding:2px 7px;font-size:10.5px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-fold,
.dshtb-root[data-dshtb-skin="dense"] .dshtb-skin,
.dshtb-root[data-dshtb-skin="dense"] .dshtb-log{width:22px;height:22px;font-size:12px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-seg{margin:7px 10px 0;padding:2px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-seg button{padding:4px 4px;font-size:12px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-sect{padding:7px 11px 4px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-compose{padding:9px 11px;gap:7px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-add textarea{min-height:48px;padding:7px 9px;font-size:12.5px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-add .dshtb-ic{width:28px;height:28px;border-radius:9px;font-size:13px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-modes{padding:2px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-modes button{padding:5px 11px;font-size:12px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-item{padding:6px 11px;gap:7px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-group{padding:8px 11px 3px;font-size:10.5px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-t{font-size:12.5px;line-height:1.4}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-facts{font-size:10.5px;margin-top:2px}
/* One line, not two: the dense skin exists to fit more rows on one screen. */
.dshtb-root[data-dshtb-skin="dense"] .dshtb-note{-webkit-line-clamp:1;font-size:11px;margin-top:2px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-notearea{font-size:12px;min-height:46px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-doneempty{padding:4px 11px 6px;font-size:11px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-meta{gap:4px;margin-top:4px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-chip{padding:1px 7px;font-size:11px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-cb{width:15px;height:15px;font-size:9px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-checks{gap:5px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-img{width:46px;height:46px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-thumb{width:40px;height:40px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-ic{width:19px;height:19px;font-size:10px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-foot{padding:6px 11px;gap:5px 7px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-pill{padding:5px 10px;gap:7px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-badge{min-width:17px;height:17px;font-size:9.5px}
.dshtb-root[data-dshtb-skin="dense"] .dshtb-empty{padding:16px 12px}
`

/**
 * `theme` is the look this panel had before it had one of its own: the same
 * layout, type and motion, with the palette re-bound to the GUI's own tokens.
 * It is deliberately the only block in this file that reads `--dsw-alias-*`.
 *
 * It exists because the panel is an overlay on somebody else's surface. On a
 * dark GUI a white card is a beacon — the right default on a light one, the
 * wrong one on the other. So the default stays blue-and-white, and one click
 * hands the colours back to the host.
 *
 * The tints are `color-mix(…, transparent)` rather than opaque colours: a wash
 * has to stay a wash over a card whose surface the user has chosen, and here
 * that surface may be dark.
 */
const CSS_THEME = `
.dshtb-root[data-dshtb-skin="theme"]{
  --tb-paper:var(--dsw-alias-bg-overlay);
  --tb-mist:var(--dsw-alias-bg-layer-1);
  --tb-haze:var(--dsw-alias-bg-layer-2);
  --tb-line:var(--dsw-alias-border-l1);
  --tb-edge:var(--dsw-alias-border-l2);
  --tb-ink:var(--dsw-alias-label-primary);
  --tb-dim:var(--dsw-alias-label-secondary);
  --tb-faint:color-mix(in srgb,var(--dsw-alias-label-secondary) 72%,transparent);
  --tb-blue:var(--dsw-alias-brand-primary);
  --tb-blue-deep:var(--dsw-alias-brand-primary);
  --tb-blue-wash:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent);
  --tb-green:var(--dsw-alias-state-success-primary);
  --tb-green-wash:color-mix(in srgb,var(--dsw-alias-state-success-primary) 18%,transparent);
  --tb-amber:var(--dsw-alias-state-warn-primary);
  --tb-amber-wash:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 20%,transparent);
  --tb-red:var(--dsw-alias-state-error-primary);
  --tb-red-wash:color-mix(in srgb,var(--dsw-alias-state-error-primary) 18%,transparent);
  --tb-ring:color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,transparent);
  --tb-shadow:0 18px 44px -20px rgba(0,0,0,.5);
  --tb-lift:0 1px 3px rgba(0,0,0,.24);
  color-scheme:light dark}
/* Two places were drawn against a white card and have to follow the surface: the
   hover plate behind a row icon, and the white-on-brand note button, whose label
   is only readable because the brand colour is dark enough in this palette. */
.dshtb-root[data-dshtb-skin="theme"] .dshtb-ic:hover{background:var(--tb-mist)}
.dshtb-root[data-dshtb-skin="theme"] .dshtb-cb{background:var(--tb-paper)}
`

/** Skin id -> its block. The default is absent: the base sheet IS its definition. */
const SKIN_CSS = { plain: CSS_PLAIN, dense: CSS_DENSE, theme: CSS_THEME }

const isSkin = (id) => SKINS.some((skin) => skin.id === id)

// ---------------------------------------------------------------------------
// Bridge to the shipped Cordis dynamic-plugin panel.
//
// That panel belongs to @deepseek-ai/dsh-client-ui-cordis and lives in the
// sidebar footer. No slot API can move another plugin's entry, so this is a
// DOM bridge with three parts:
//
//   1. locate the trigger by the `data-cordis-badge` attribute it renders
//      itself — stable across versions and locales, and still present when the
//      sidebar collapses to the 56px rail, where the text label is not
//      rendered at all (text matching is only a fallback);
//   2. hide its sidebar row, so the entry exists only inside this panel;
//   3. park the shipped popup UNDER this panel: the popup is a child of that
//      same layer, and a tagged, !important CSS rule overrides the inline
//      `left`/`bottom` the panel computes from the layer's rect. That makes the
//      placement independent of the collapsed anchor and guarantees the two
//      panels never overlap.
//
// The layer's inline styles and attribute are restored when this plugin
// unloads.
// ---------------------------------------------------------------------------
const CORDIS_TRIGGER = 'Cordis Plugin'
const CORDIS_BADGE_SELECTOR = 'button[data-cordis-badge]'
const CORDIS_LAYER_ATTR = 'data-dsh-todo-cordis'
let cordisSaved = null

function cordisBadge() {
  const direct = document.querySelector(CORDIS_BADGE_SELECTOR)
  if (direct !== null) return direct
  const buttons = document.querySelectorAll('button')
  for (const button of buttons) {
    // Never match this panel's own footer entry: it carries the same label.
    if (button.closest('.dshtb-root') !== null) continue
    const text = button.textContent === null ? '' : button.textContent.trim()
    // Prefix match: the shipped badge appends a running count.
    if (text.indexOf(CORDIS_TRIGGER) === 0) return button
  }
  return null
}

function collapseCordisFooter() {
  if (cordisSaved !== null && cordisSaved.button.isConnected) return
  const badge = cordisBadge()
  if (badge === null) return
  const row = badge.parentElement
  const layer = row === null ? null : row.parentElement
  // Refuse to touch any ancestor of this panel: collapsing our own card would
  // hide the entire board behind its own overflow:hidden.
  const owner = layer === null ? row : layer
  if (owner === null || owner.querySelector('.dshtb-root') !== null) return
  cordisSaved = {
    button: badge,
    row,
    layer,
    rowDisplay: row === null ? '' : row.style.display,
    layerHeight: layer === null ? '' : layer.style.height,
    layerMargin: layer === null ? '' : layer.style.margin,
    layerPadding: layer === null ? '' : layer.style.padding,
  }
  if (row !== null) row.style.display = 'none'
  if (layer !== null) {
    layer.style.height = '0px'
    layer.style.margin = '0px'
    layer.style.padding = '0px'
    layer.setAttribute(CORDIS_LAYER_ATTR, '')
  }
}

/**
 * Keep the shipped popup parked directly under this panel, right-aligned to
 * it, with a max-height that stops it running off the bottom of the viewport.
 * Recomputed on every poll so dragging or resizing this panel moves it too.
 */
function anchorCordisPanel() {
  const layer = cordisSaved === null ? null : cordisSaved.layer
  if (layer === null || !layer.isConnected) return
  const root = document.querySelector('.dshtb-root')
  if (root === null) return
  const rect = root.getBoundingClientRect()
  const gap = 8
  layer.style.setProperty('--dsh-todo-cordis-right', Math.max(8, Math.round(window.innerWidth - rect.right)) + 'px')
  layer.style.setProperty('--dsh-todo-cordis-top', Math.round(rect.bottom + gap) + 'px')
  layer.style.setProperty(
    '--dsh-todo-cordis-maxh',
    Math.max(160, Math.round(window.innerHeight - rect.bottom - gap * 3)) + 'px',
  )
}

function restoreCordisFooter() {
  if (cordisSaved === null) return
  const saved = cordisSaved
  cordisSaved = null
  if (saved.row !== null && saved.row.isConnected) saved.row.style.display = saved.rowDisplay
  if (saved.layer !== null && saved.layer.isConnected) {
    saved.layer.style.height = saved.layerHeight
    saved.layer.style.margin = saved.layerMargin
    saved.layer.style.padding = saved.layerPadding
    saved.layer.removeAttribute(CORDIS_LAYER_ATTR)
  }
}

/**
 * Open — never toggle — the shipped panel from this one.
 *
 * The badge sits inside a collapsed row, so a bare `.click()` races the
 * panel's own dismiss-on-outside-pointer hook: that hook sees a pointer
 * outside its root and closes whatever we just opened. Priming the interaction
 * with a pointerdown/mousedown dispatched ON the badge makes the target
 * "inside", so the click survives.
 *
 * @returns whether the shipped trigger was found at all.
 */
function openCordisPanel() {
  const badge = cordisBadge()
  if (badge === null) return false
  if (badge.getAttribute('aria-expanded') === 'true') return true
  try {
    const options = { bubbles: true, cancelable: true, view: window }
    badge.dispatchEvent(new PointerEvent('pointerdown', options))
    badge.dispatchEvent(new MouseEvent('mousedown', options))
  } catch (err) {
    /* no PointerEvent in this engine: the plain click below still tries */
  }
  badge.click()
  return true
}

// --------------------------------------------------------------- transport

async function request(method, body) {
  const response =
    body === undefined
      ? await fetch(ROUTE, { headers: { accept: 'application/json' } })
      : await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
  if (!response.ok) throw new Error(failureText(response.status))
  return response.json()
}

/**
 * Turn one refusal status into something the user can act on.
 *
 * 401 is the status v0.9.1 introduced: the board route now borrows the harness'
 * own gate, which wants the browser-session cookie DSH issues when you open the
 * URL `dsh web` prints. A bare "HTTP 401" would leave the panel looking broken
 * with no hint, and this is the one failure whose fix is a single action.
 */
function failureText(status) {
  if (status === 401) {
    return 'HTTP 401 —— 浏览器没有 DSH 会话凭据。请用 `dsh web` 打印的那条带 token 的地址重开页面'
  }
  return 'HTTP ' + status
}

const transport = {
  snapshot: () => request('GET'),
  call: (method, args) => request('POST', Object.assign({ action: method }, args)),
  /**
   * Fetch log records newer than `since`.
   *
   * Only ever called while the log view is open — that is the whole reason the
   * host gates log content behind a query flag, and it is what keeps the idle
   * poll byte-for-byte what it was before this feature existed.
   */
  logs: (since) =>
    fetch(ROUTE + '?logs=1&since=' + encodeURIComponent(String(since)), {
      headers: { accept: 'application/json' },
    }).then((response) => {
      if (!response.ok) throw new Error(failureText(response.status))
      return response.json()
    }),
}

function describe(failure) {
  if (failure === null || failure === undefined) return 'unknown error'
  if (typeof failure === 'string') return failure
  if (typeof failure.message === 'string') return failure.message
  return String(failure)
}

/** Durable attachment bytes, served by this plugin's own board-scoped route. */
function imageUrl(attachmentId) {
  return ROUTE.replace(/\/api$/, '/image') + '?id=' + encodeURIComponent(String(attachmentId))
}

// --------------------------------------------------------------- log view
//
// The developer log. Its content never rides the idle poll: the host withholds
// it unless the view is open, so these helpers only ever run on a panel where
// someone deliberately opened the log.

/** `HH:MM:SS.mmm` from an epoch stamp — enough to line a line up with an action. */
function logClock(ts) {
  if (typeof ts !== 'number' || !isFinite(ts)) return '--:--:--'
  const date = new Date(ts)
  const pad = (n, width) => String(n).padStart(width === undefined ? 2 : width, '0')
  return (
    pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds()) +
    '.' + pad(date.getMilliseconds(), 3)
  )
}

/**
 * One record's filterable text, lowercased once per render pass rather than per
 * keystroke-range — the list is capped, so this stays cheap.
 */
function logHaystack(line) {
  return (String(line.detail) + ' ' + String(line.logger) + ' ' + String(line.source)).toLowerCase()
}

/** Which source bucket a record belongs to, for the 来源 toggle. */
function logSourceOf(line) {
  // The host names this plugin's own fiber, so a record from us is exactly the
  // one whose source matches. Anything else is another plugin's error (the
  // exporter scope keeps those at `error` only).
  return line.source === 'dsh-todo-board' ? 'self' : 'other'
}

/** Load the last-used source filter, defaulting to our own records. */
function loadLogSource() {
  try {
    const raw = window.localStorage.getItem(LOG_SOURCE_KEY)
    return raw === 'other' ? 'other' : 'self'
  } catch (err) {
    return 'self'
  }
}

function saveLogSource(value) {
  try {
    window.localStorage.setItem(LOG_SOURCE_KEY, value)
  } catch (err) {
    /* storage unavailable */
  }
}

/**
 * The whole log as plain text, for the clipboard and the download.
 *
 * Redaction already ran on every line at the host, but it runs AGAIN here on
 * the assembled text. That is deliberate rather than redundant: this string
 * leaves the machine — it is pasted into an issue or saved to a file and handed
 * to someone else — and the host's guarantee covers what it stored, not what a
 * future edit to this client might add.
 */
function logAsText(info) {
  const lines = info === undefined || info === null ? [] : info.render
  const head = [
    '# dsh-todo-board 日志',
    '# 导出时间：' + new Date().toISOString(),
    '# 面板构建：v' + BUILD,
    '# 记录数：' + (Array.isArray(lines) ? lines.length : 0),
    '# 说明：本文件可能包含本机路径与其他插件的错误上下文，贴出去前请自行确认。',
    '',
  ]
  const body = (Array.isArray(lines) ? lines : []).map(
    (line) =>
      logClock(line.ts) + ' ' + String(line.level).toUpperCase().padEnd(5) +
      ' [' + (line.source || line.logger || '?') + '] ' + line.detail,
  )
  return head.concat(body).join('\n')
}

/** Trigger a browser download of `text`, without a server round trip. */
function downloadText(filename, text) {
  try {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    // Revoked on a later tick: revoking synchronously can cancel the download
    // in some engines before it has read the blob.
    window.setTimeout(() => URL.revokeObjectURL(url), 10000)
    return true
  } catch (err) {
    return false
  }
}

/** Copy `text`, falling back to a hidden textarea where the async API is absent. */
function copyText(text) {
  try {
    if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(text).then(
        () => true,
        () => false,
      )
    }
  } catch (err) {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return Promise.resolve(ok)
  } catch (err) {
    return Promise.resolve(false)
  }
}

// ------------------------------------------------------------- panel layout

const LAYOUT_KEY = 'dsh.todoBoard.layout.v1'
const MIN_W = 300
const MIN_H = 260
/** The shipped CSS width of the card, used as a fallback when bounding a position. */
const DEFAULT_W = 380
/** The parked line is one row of text; only its height fallback needs to know that. */
const PILL_H = 40
/** Pointer travel (in px) that turns a press on the parked line into a drag. */
const PARK_SLOP = 3

/**
 * A stored size is either a usable number or "never chosen" (null).
 *
 * The difference matters now that the parked line is draggable. Moving the line
 * is a position change and nothing else, so it must not launder the line's own
 * auto-sized rect into the card's geometry — that would leave the panel 40px
 * tall (or 300 wide, via MIN_W) the next time it unfolds.
 */
function dimension(value) {
  // One expression, deliberately: `Number(null)` is 0 and `Number(undefined)` is
  // NaN, so both fall out of the same test as a bad string would. An early
  // `return null` for the two JSON cases would be dead weight the guard below
  // could no longer reach — and an unreachable line is an untested one.
  const size = Number(value)
  return isFinite(size) && size > 0 ? size : null
}

function loadLayout() {
  try {
    const raw = window.localStorage.getItem(LAYOUT_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return null
    const x = Number(parsed.x)
    const y = Number(parsed.y)
    if (!isFinite(x) || !isFinite(y)) return null
    return { x, y, w: dimension(parsed.w), h: dimension(parsed.h) }
  } catch (err) {
    return null
  }
}

/**
 * Coerce a layout that came from the HOST (board.json) into the same shape
 * `loadLayout` produces, or `null` when it is not usable.
 *
 * The host is the source of truth now: localStorage is keyed by origin, so a
 * restart on a different port read as "first run" and the panel jumped back to
 * its default spot. Keeping the reading logic here (rather than trusting the
 * payload) means a hand-edited board cannot hand the panel a NaN.
 */
function layoutFromHost(value) {
  if (value === null || value === undefined || typeof value !== 'object') return null
  const x = Number(value.x)
  const y = Number(value.y)
  if (!isFinite(x) || !isFinite(y)) return null
  return { x, y, w: dimension(value.w), h: dimension(value.h) }
}

/**
 * How the module-level layout helpers reach the component's transport.
 *
 * `saveLayout` lives at module scope (it predates the panel and the tests drive
 * it directly), while the HTTP call lives inside the component. A single
 * module-level slot is the least machinery that connects them without turning
 * every geometry write into a prop drilled through the render tree.
 */
let hostSaveLayout = null

/**
 * Write the geometry to BOTH places, on purpose.
 *
 * The host copy is the one that survives a port change, so it is the source of
 * truth on load. The localStorage copy is a local fast path that survives the
 * branch where the host route is unreachable (older host, or a session without
 * the credentials the route requires): the panel should still remember where
 * you put it within this browser even then. Writing both is cheap — a drag ends
 * with one of each.
 */
function saveLayout(layout) {
  // Local copy first and unconditionally: it is what the NEXT render in this
  // browser reads, and it must be correct even if the host write fails.
  try {
    if (layout === null) window.localStorage.removeItem(LAYOUT_KEY)
    else window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout))
  } catch (err) {
    /* storage unavailable */
  }
  // Then the durable copy. Fire-and-forget: a geometry write must never make
  // the panel feel laggy, and a failure here is recoverable from the local one.
  try {
    if (typeof hostSaveLayout === 'function') hostSaveLayout(layout)
  } catch (err) {
    /* the host channel is not wired yet; the local copy is enough */
  }
}

/**
 * Folded sections and the parked panel survive a reload: folding away the
 * composer is something you do once, not once per page load.
 */
const SECTIONS_KEY = 'dsh.todoBoard.sections.v1'
const SECTION_IDS = ['compose', 'list', 'done']

function loadSections() {
  const state = { compose: true, list: true, done: true }
  try {
    const raw = window.localStorage.getItem(SECTIONS_KEY)
    if (raw === null) return state
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return state
    for (const id of SECTION_IDS) if (typeof parsed[id] === 'boolean') state[id] = parsed[id]
  } catch (err) {
    /* keep the defaults */
  }
  return state
}

function saveSections(state) {
  try {
    window.localStorage.setItem(SECTIONS_KEY, JSON.stringify(state))
  } catch (err) {
    /* storage unavailable */
  }
}

/**
 * Which skin the panel wears.
 *
 * Stored beside the layout and the folded sections, so it survives a reload the
 * same way they do — a look you chose once is a look you keep. A stored id that
 * is no longer in SKINS (a skin removed in an upgrade) falls back to the default
 * instead of leaving the panel wearing nothing.
 */
const SKIN_KEY = 'dsh.todoBoard.skin.v1'

function loadSkin() {
  try {
    const raw = window.localStorage.getItem(SKIN_KEY)
    return typeof raw === 'string' && isSkin(raw) ? raw : SKINS[0].id
  } catch (err) {
    return SKINS[0].id
  }
}

function saveSkin(id) {
  try {
    window.localStorage.setItem(SKIN_KEY, id)
  } catch (err) {
    /* storage unavailable */
  }
}

/**
 * Fit a card geometry inside the viewport.
 *
 * A `null` width or height means "the stylesheet decides", and stays null: only
 * an actual resize of the card writes a size. The two fallbacks exist purely so
 * that a position can still be bounded when no size is known yet — the card's
 * shipped CSS width, and its CSS `max-height` cap.
 */
function clampLayout(layout) {
  const maxW = Math.max(MIN_W, window.innerWidth - 16)
  const maxH = Math.max(MIN_H, window.innerHeight - 16)
  const w = layout.w === null ? null : Math.min(Math.max(layout.w, MIN_W), maxW)
  const h = layout.h === null ? null : Math.min(Math.max(layout.h, MIN_H), maxH)
  const boxW = w === null ? Math.min(DEFAULT_W, Math.max(0, window.innerWidth - 16)) : w
  const boxH = h === null ? Math.min(680, Math.max(0, window.innerHeight * 0.8)) : h
  const x = Math.min(Math.max(layout.x, 8), Math.max(8, window.innerWidth - boxW - 8))
  const y = Math.min(Math.max(layout.y, 8), Math.max(8, window.innerHeight - boxH - 8))
  return { x, y, w, h }
}

/**
 * Fit the parked line's position inside the viewport, from its measured size.
 *
 * Separate from {@link clampLayout} because the parked line is a different
 * shape: it is one auto-sized row, so neither the card's minimums nor its
 * default width apply. The rect is measured rather than assumed — the line's
 * width follows the text of the next todo, up to a CSS cap.
 *
 * @param layout - Position to clamp; only x and y are read.
 * @param rect - The parked line's live bounding box, in viewport coordinates.
 * @returns The same geometry with x and y brought back inside the viewport.
 */
function clampParked(layout, rect) {
  const boxW = Math.min(rect.width, Math.max(0, window.innerWidth - 16))
  const boxH = Math.min(rect.height, Math.max(0, window.innerHeight - 16))
  const x = Math.min(Math.max(layout.x, 8), Math.max(8, window.innerWidth - boxW - 8))
  const y = Math.min(Math.max(layout.y, 8), Math.max(8, window.innerHeight - boxH - 8))
  return { x, y, w: layout.w, h: layout.h }
}

function sameLayout(a, b) {
  if (a === b) return true
  if (a === null || b === null) return false
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}

/**
 * The parked line's box, for clamping when no live element is available.
 *
 * A re-clamp can be asked to run before the line has been laid out (a resize
 * event between mount and first paint, or the catch-up call the effect makes on
 * install). Falling back to the row's own CSS height and the card's width keeps
 * the position bounded in that window instead of clamping against nothing.
 */
function pillBox(element) {
  if (element !== null && element !== undefined && typeof element.getBoundingClientRect === 'function') {
    const rect = element.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) return { width: rect.width, height: rect.height }
  }
  return { width: Math.min(DEFAULT_W, window.innerWidth - 16), height: PILL_H }
}

/**
 * The geometry the user actually chose, kept apart from the one being rendered.
 *
 * They differ whenever the viewport is too small for the choice: the rendered
 * geometry is clamped to fit right now, while the chosen one is remembered, so
 * widening the window again returns the panel to where it was put — the same
 * position a reload would produce from disk. Re-clamping stays repeatable
 * instead of being a one-way trip into the corner.
 */
function initialGeometry() {
  const stored = loadLayout()
  return { preferred: stored, clamped: stored === null ? null : clampLayout(stored) }
}

/**
 * A foldable section of the panel: its label doubles as the control that shows
 * and hides the body, so a folded panel still says what it is hiding.
 *
 * @param options.id - stable key, also handed back to `onToggle`.
 * @param options.name - section name, used in the tooltip.
 * @param options.note - optional count rendered after the name.
 * @param options.open - whether the body is currently visible.
 * @param options.onToggle - called with `id` when the header is clicked.
 * @param options.body - the single keyed element to hide when folded.
 * @returns header and body as siblings, ready to spread into a children list.
 */
function foldable(options) {
  const { id, name, note, open, onToggle, body } = options
  return [
    h(
      'button',
      {
        key: id,
        className: 'dshtb-sect',
        'aria-expanded': open ? 'true' : 'false',
        title: (open ? '折叠' : '展开') + '「' + name + '」',
        onClick: () => onToggle(id),
      },
      h('span', { className: 'car' }, open ? '\u25BE' : '\u25B8'),
      note === undefined ? name : name + ' ' + note,
    ),
    open ? body : null,
  ]
}

// --------------------------------------------------------------- component

/**
 * The session the panel was showing when it last rendered.
 *
 * Module level on purpose: it is not render state — nothing should re-render
 * because it changed — and the panel is a singleton.
 */
let lastFlushId = ''

function TodoBoard(props) {
  // Host services, when the slot wrapper could supply them. Read lazily inside
  // the one handler that needs them (see `jumpBack`): declaring them in
  // `exports.inject` would make a missing service fail the whole panel.
  const appCtx = props.appCtx === undefined ? null : props.appCtx
  // The session list store is `{ ids, byId, phase, projectionsBySession }` — it
  // has NO `current` key. Reading `s.current` therefore always yielded
  // `undefined`, and BOTH `currentId` and `cwd` collapsed to `''`. That is what
  // broke the scope tabs while the row labels stayed correct: the labels come
  // from the host payload (`dirLabel`), whereas 「当前目录」 compared every row's
  // `dir` against `''` (nothing can match) and 「当前会话」 compared
  // `sourceSessionId` against `undefined`. Derive the current session the way the
  // harness itself does — the summary the main view retains.
  const currentSummary = props.useSessions((s) => {
    const byId = s === undefined || s === null ? undefined : s.byId
    if (byId === undefined || byId === null) return undefined
    for (const row of Object.values(byId)) {
      if (row !== null && typeof row === 'object' && ((row.retainedBy ?? {}).mainView ?? 0) > 0) return row
    }
    return undefined
  })
  const currentId = currentSummary === undefined || currentSummary === null ? undefined : currentSummary.id
  const cwd =
    currentSummary !== undefined && currentSummary !== null && typeof currentSummary.cwd === 'string'
      ? currentSummary.cwd
      : ''
  const currentTitle =
    currentSummary !== undefined && currentSummary !== null && typeof currentSummary.title === 'string'
      ? currentSummary.title
      : ''

  // Every retained session, for naming the execution boxes. The panel reads no
  // activity timestamp off this store, so a box is named and ordered from what
  // the host already ships — see `boxTree`.
  const sessionRows = props.useSessions((s) => {
    const byId = s === undefined || s === null ? undefined : s.byId
    return byId === undefined || byId === null ? {} : byId
  })

  const [open, setOpen] = React.useState(true)
  const [data, setData] = React.useState(null)
  const [err, setErr] = React.useState('')
  const [draft, setDraft] = React.useState('')
  const [mode, setMode] = React.useState('remind')
  const [dirInput, setDirInput] = React.useState('')
  const [when, setWhen] = React.useState('')
  const [pending, setPending] = React.useState([])
  const [noteId, setNoteId] = React.useState('')
  const [noteDraft, setNoteDraft] = React.useState('')
  const [viewing, setViewing] = React.useState(null)
  const [filter, setFilter] = React.useState('all')
  const [busy, setBusy] = React.useState(false)
  const [dragId, setDragId] = React.useState('')
  const [overId, setOverId] = React.useState('')
  const [editId, setEditId] = React.useState('')
  const [editText, setEditText] = React.useState('')
  /** Row whose schedule is being edited inline, and the draft time for it. */
  const [whenId, setWhenId] = React.useState('')
  const [whenDraft, setWhenDraft] = React.useState('')
  // Geometry is read once per mount, lazily: `initialGeometry` touches
  // localStorage, and the panel re-renders on every 2.5s poll, so calling it in
  // a ref initializer (which evaluates its argument each render) would re-read
  // storage forever.
  const initial = React.useState(initialGeometry)[0]
  const [layout, setLayout] = React.useState(initial.clamped)
  const [cordisFound, setCordisFound] = React.useState(true)
  const [sections, setSections] = React.useState(loadSections)
  const [skin, setSkin] = React.useState(loadSkin)
  /**
   * Whether the panel is showing the log instead of the board.
   *
   * Not persisted on purpose: this is a diagnostic view, and reopening the GUI
   * into a log page would be a worse default than reopening into the board. The
   * cost is that a reload closes it, which for a debugging trip is fine.
   */
  const [logOpen, setLogOpen] = React.useState(false)
  /**
   * Whether the panel is showing the settings page.
   *
   * Sits beside `logOpen` rather than replacing it with a single "page" state:
   * the two are independent toggles the user reaches for directly (the log
   * button, the settings button), and collapsing them into one enum would mean
   * inventing a rule for "settings while the log is open".
   *
   * Not persisted, same reasoning as the log view: reopening the GUI into a
   * settings form is a worse default than reopening onto the board.
   */
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  /** The form's working copy; `null` until the first sync from the payload. */
  const [settingsDraft, setSettingsDraft] = React.useState(null)
  const [settingsErr, setSettingsErr] = React.useState('')
  const [logLevels, setLogLevels] = React.useState({ error: true, warn: true, info: false, debug: false })
  const [logSource, setLogSource] = React.useState(loadLogSource)
  const [logQuery, setLogQuery] = React.useState('')
  const [logLines, setLogLines] = React.useState([])
  /** Newest `sn` collected, so each poll asks only for what it lacks. */
  const logCursorRef = React.useRef(0)
  /** Newest error/warn `sn` the user has already looked at. */
  const logSeenRef = React.useRef(0)
  /**
   * `logOpen`, readable from the polling closure.
   *
   * The interval effect runs ONCE (empty deps), so it captures the first
   * render's `refresh` — where `logOpen` is `false` forever. Reading the state
   * variable there would leave the log view frozen at whatever the open-effect
   * fetched, with the 2.5s poll silently never updating it. A ref is the only
   * way that once-installed interval can see the current value.
   */
  const logOpenRef = React.useRef(false)
  const [logNote, setLogNote] = React.useState('')
  const [logCopied, setLogCopied] = React.useState('')
  const preferredRef = React.useRef(initial.preferred)
  const layoutRef = React.useRef(null)
  const dragRef = React.useRef(null)
  /** Live press on the parked line: its start point, its rect, and whether it dragged. */
  const parkRef = React.useRef(null)
  const inputRef = React.useRef(null)
  const editRef = React.useRef(null)
  /** The parked line's element, so a re-clamp can measure the box it must fit. */
  const pillRef = React.useRef(null)
  /** id -> remindedAt already surfaced, so a reminder notifies exactly once. */
  const seenReminders = React.useRef({})

  /**
   * Whether the host's saved geometry has been adopted yet.
   *
   * `initialGeometry()` runs during the first render, before any HTTP response
   * exists, so the panel necessarily starts from its localStorage copy (or the
   * CSS default). The host copy is the durable one — it survives a port change,
   * which localStorage cannot — so the first snapshot that carries it wins.
   *
   * ONCE, deliberately: the poll re-delivers the same geometry every 2.5s, and
   * re-applying it would fight the user's next drag for a couple of seconds
   * every time they move the panel.
   */
  const adoptedHostLayout = React.useRef(false)

  function applyLayout(next) {
    const clamped = clampLayout(next)
    // A drag is an explicit choice, so record it as the preferred geometry too.
    preferredRef.current = clamped
    layoutRef.current = clamped
    setLayout(clamped)
  }

  /**
   * Move the parked line, keeping its size out of the deal.
   *
   * The line is one auto-sized row, so its position is clamped against its own
   * measured box rather than the card's minimums — and the stored width/height
   * are carried through untouched, because they belong to the unfolded card.
   */
  function applyParkedLayout(next, rect) {
    const clamped = clampParked(next, rect)
    preferredRef.current = clamped
    layoutRef.current = clamped
    setLayout(clamped)
  }

  /** Seed a concrete geometry from the live rect, so CSS defaults stop applying. */
  function seedFrom(event, mode) {
    if (event.button !== 0) return null
    const root = event.currentTarget.closest('.dshtb-root')
    if (root === null) return null
    const rect = root.getBoundingClientRect()
    const origin = { x: rect.left, y: rect.top, w: rect.width, h: rect.height }
    layoutRef.current = clampLayout(origin)
    setLayout(layoutRef.current)
    dragRef.current = { mode, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
    return origin
  }

  function beginDrag(event) {
    // A pointerdown on a control inside the title bar must not start a drag:
    // setPointerCapture retargets the following click to the captured element,
    // so the button underneath would never see it.
    const target = event.target
    if (target !== null && typeof target.closest === 'function' && target.closest('button') !== null) {
      return
    }
    seedFrom(event, 'move')
  }

  function beginResize(event) {
    if (seedFrom(event, 'size') === null) return
    event.stopPropagation()
  }

  function movePointer(event) {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (drag.mode === 'move') {
      applyLayout({ x: drag.origin.x + dx, y: drag.origin.y + dy, w: drag.origin.w, h: drag.origin.h })
    } else {
      applyLayout({ x: drag.origin.x, y: drag.origin.y, w: drag.origin.w + dx, h: drag.origin.h + dy })
    }
  }

  /**
   * Press on the parked line: a candidate drag that is still a click.
   *
   * Nothing moves until the pointer has travelled past {@link PARK_SLOP}, so a
   * press that never moves still reaches the click handler and unfolds the
   * panel. The line has no controls inside it, so — unlike the title bar — the
   * pointer can be captured here without stealing anyone else's click.
   */
  function beginParkDrag(event) {
    if (event.button !== 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    const current = layoutRef.current
    const stored = preferredRef.current
    parkRef.current = {
      pointerId: event.pointerId,
      active: true,
      moved: false,
      startX: event.clientX,
      startY: event.clientY,
      rect,
      // The size belongs to the unfolded card; only x/y are ever rewritten here.
      origin: {
        x: rect.left,
        y: rect.top,
        w: current === null ? (stored === null ? null : stored.w) : current.w,
        h: current === null ? (stored === null ? null : stored.h) : current.h,
      },
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  function moveParkDrag(event) {
    const drag = parkRef.current
    if (drag === null || drag.active !== true || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    // Under the slop this is still a click on the way to unfolding the panel.
    if (drag.moved !== true) {
      if (Math.abs(dx) < PARK_SLOP && Math.abs(dy) < PARK_SLOP) return
      drag.moved = true
    }
    applyParkedLayout({ x: drag.origin.x + dx, y: drag.origin.y + dy, w: drag.origin.w, h: drag.origin.h }, drag.rect)
  }

  function endParkDrag() {
    const drag = parkRef.current
    if (drag === null || drag.active !== true) return
    drag.active = false
    // `moved` is deliberately left set: the click that follows this pointerup
    // must not unfold a panel the user just dragged somewhere.
    if (drag.moved === true) saveLayout(layoutRef.current)
  }

  /** Unfold the parked line — unless the press that ended here was a drag. */
  function unparkOnClick() {
    const drag = parkRef.current
    if (drag !== null && drag.moved === true) {
      drag.moved = false
      return
    }
    setOpen(true)
  }

  function endPointer() {
    if (dragRef.current === null) return
    dragRef.current = null
    saveLayout(layoutRef.current)
  }

  function resetLayout() {
    // Clearing the preferred geometry too, or the resize effect would clamp it
    // straight back and the double-click restore would appear to do nothing.
    preferredRef.current = null
    layoutRef.current = null
    setLayout(null)
    saveLayout(null)
  }

  /**
   * Keep the panel inside the viewport as the viewport changes.
   *
   * Dragging and resizing clamp already, but neither runs when the *window*
   * changes size — so a panel parked at an absolute x is silently cropped once
   * the window narrows, and a viewport that can never be that wide again (a
   * smaller monitor, a permanent zoom) strands it for good. Re-clamping here is
   * what makes the panel follow the viewport instead of leaving it behind.
   *
   * It re-derives from `preferredRef` rather than from what is currently
   * rendered, so the clamp is repeatable: narrowing fits the panel on screen,
   * and widening puts it back exactly where the user left it — the same result
   * a reload would give. Nothing here is written to disk; the chosen geometry is
   * only persisted by an actual drag or resize.
   */
  React.useEffect(() => {
    const reclamp = () => {
      setLayout((current) => {
        if (current === null) return current
        const preferred = preferredRef.current
        const source = preferred === null ? current : preferred
        // The parked line is auto-sized, so it is bounded by its own measured
        // box: the card's minimums describe a shape this state does not have.
        const next = open ? clampLayout(source) : clampParked(source, pillBox(pillRef.current))
        // Returning the same object lets React bail out, so a resize that
        // changes nothing does not re-render the panel.
        return sameLayout(next, current) ? current : next
      })
    }

    window.addEventListener('resize', reclamp)
    // `visualViewport` fires for browser zoom, which does not always resize.
    if (window.visualViewport !== undefined && window.visualViewport !== null) {
      window.visualViewport.addEventListener('resize', reclamp)
    }
    // Catch a viewport that changed before this effect attached (or while the
    // tab was hidden and events were coalesced).
    reclamp()

    return () => {
      window.removeEventListener('resize', reclamp)
      if (window.visualViewport !== undefined && window.visualViewport !== null) {
        window.visualViewport.removeEventListener('resize', reclamp)
      }
    }
  }, [open])

  // Keep the drag-time ref equal to the rendered geometry, so a reclamp (or any
  // other state change) can never leave it pointing at a stale rect.
  React.useEffect(() => {
    layoutRef.current = layout
  }, [layout])

  /** Fold one section of the panel away, or bring it back. */
  function toggleSection(id) {
    setSections((current) => {
      const next = { ...current, [id]: !current[id] }
      saveSections(next)
      return next
    })
  }

  /** Park the whole panel as a single line, or unfold it again. */
  function togglePanel() {
    setOpen((current) => !current)
  }

  /**
   * Step to the next skin and remember it.
   *
   * A cycle rather than a picker: with three looks, a cycle needs no menu, no
   * chrome and no room — and the one place it lives (the title bar) is the one
   * place you are already looking when you want the panel to look different.
   */
  function cycleSkin() {
    setSkin((current) => {
      const at = SKINS.findIndex((entry) => entry.id === current)
      const next = SKINS[(at + 1) % SKINS.length].id
      saveSkin(next)
      return next
    })
  }

  // Grow the composer with its content, up to the CSS max-height.
  React.useEffect(() => {
    const el = inputRef.current
    if (el === null) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 180) + 'px'
  }, [draft])

  // The rename field grows with the text the same way, so a long todo stays
  // readable while it is being edited.
  React.useEffect(() => {
    const el = editRef.current
    if (el === null) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 220) + 'px'
  }, [editText, editId])

  /**
   * Fetch log records newer than what we hold.
   *
   * Runs on the SAME 2.5s cadence as the board poll and only while the view is
   * open — diagnostics do not need to be live, and reusing the existing poll
   * means no second transport to keep working. Errors are contained: a failing
   * log fetch must not disturb the board, which is the panel's actual job.
   */
  function refreshLogs() {
    transport.logs(logCursorRef.current).then(
      (result) => {
        const info = result === null || result === undefined ? undefined : result.logs
        if (info === undefined) {
          // A blank page reads as "nothing was ever logged", which is the one
          // wrong answer here. Say what actually happened instead: the host
          // answered without any log payload, which means an older host build
          // (pre-0.9.0) or a route that refused the request.
          setLogNote('主机没有返回日志内容 —— 可能是插件主机半边未更新（本页需要 0.9.0 及以上）')
          return
        }
        if (typeof info.cursor === 'number' && info.cursor > logCursorRef.current) {
          logCursorRef.current = info.cursor
        }
        // Everything the view is now showing counts as read, so closing it
        // leaves no dot behind for records the user just looked at.
        logSeenRef.current = Math.max(logSeenRef.current, logCursorRef.current)
        const fresh = Array.isArray(info.lines) ? info.lines : []
        if (fresh.length > 0) {
          setLogLines((current) => {
            const merged = current.concat(fresh)
            // Trim from the FRONT: the newest records are the ones a reader is
            // looking at, and a capped list that dropped them would be useless.
            return merged.length > LOG_KEEP ? merged.slice(merged.length - LOG_KEEP) : merged
          })
        }
        // The ring may have recycled past our cursor while the view was closed,
        // which reads as "nothing happened" unless we say so. The host's ring
        // size is not named here: this client does not know it, and inventing a
        // number would be worse than saying what actually happened.
        const notes = []
        if (info.truncated === true) notes.push('更早的记录已被内存环回收，完整历史在落盘文件里')
        if (info.dropped > 0) notes.push('进程启动以来已丢弃 ' + info.dropped + ' 条')
        if (info.fileOff === true) {
          notes.push('日志文件写入已停用（' + (info.fileError || '未知原因') + '），内存日志仍在')
        } else if (typeof info.file === 'string' && info.file !== '') {
          notes.push('落盘：' + info.file)
        }
        setLogNote(notes.join(' · '))
      },
      (failure) => setLogNote('读取日志失败：' + describe(failure)),
    )
  }

  function refresh() {
    transport.snapshot().then(
      (result) => {
        setData(result)
        setErr('')
        if (result !== null && result !== undefined && Array.isArray(result.todos)) {
          notifyDue(result.todos)
        }
      },
      (failure) => setErr(describe(failure)),
    )
    // `logOpenRef`, not `logOpen`: `refresh` is captured by an interval
    // installed once (empty deps), so the state variable would be frozen at its
    // first value (`false`) and the open log view would never update again.
    if (logOpenRef.current) refreshLogs()
    collapseCordisFooter()
    anchorCordisPanel()
    setCordisFound(cordisBadge() !== null)
  }

  /**
   * Poll the board, but only as often as you can actually see it.
   *
   * 2.5s is the right cadence for a panel someone is looking at — it is what
   * makes a row the AI just ticked feel immediate. It is the wrong cadence for
   * a panel that is minimised, in a background tab, or on a locked screen:
   * nobody reads those pixels, yet the request keeps firing, and a day of that
   * is tens of thousands of fetches that all resolve into nothing.
   *
   * So the interval is *suspended* while the page is hidden and re-armed (with
   * an immediate refresh) the moment it is visible again. Suspending rather
   * than slowing down is deliberate: a hidden panel has nothing to keep warm,
   * and the returning `visibilitychange` gives us a precise "now is when the
   * user is looking" signal that a slower timer would not.
   *
   * `refreshRef` holds the latest closure so the interval handler never
   * captures a stale `refresh` — the effect below runs once, on mount.
   */
  const refreshRef = React.useRef(refresh)
  React.useEffect(() => {
    refreshRef.current = refresh
  })

  React.useEffect(() => {
    const visible = () => document.visibilityState !== 'hidden'
    let timer = null

    const start = () => {
      if (timer !== null) return
      timer = window.setInterval(() => refreshRef.current(), POLL_MS)
    }
    const stop = () => {
      if (timer === null) return
      window.clearInterval(timer)
      timer = null
    }

    const onVisibility = () => {
      if (visible()) {
        // Catch up FIRST, then resume the cadence: coming back to a panel that
        // shows a 40-minute-old board for the next tick reads as broken.
        refreshRef.current()
        start()
      } else {
        stop()
      }
    }

    refreshRef.current()
    if (visible()) start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      stop()
    }
  }, [])

  /**
   * Fetch as soon as the view opens.
   *
   * The 2.5s interval alone would leave a blank panel for up to one tick after
   * a click, which reads as "the button did nothing" — the one moment this
   * feature must not look broken.
   */
  React.useEffect(() => {
    logOpenRef.current = logOpen
    if (logOpen) refreshLogs()
  }, [logOpen])

  // Ask once for desktop-notification permission, so a due 「提醒」待办 can
  // surface even while the panel is collapsed.
  React.useEffect(() => {
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {})
      }
    } catch (err) {
      /* no Notification API in this engine */
    }
  }, [])

  const todos = data !== null && data !== undefined && Array.isArray(data.todos) ? data.todos : []

  // Adopt the host's geometry the first time a snapshot carries one. See
  // `adoptedHostLayout` for why this happens once rather than on every poll.
  React.useEffect(() => {
    if (adoptedHostLayout.current) return
    if (data === null || data === undefined) return
    const fromHost = layoutFromHost(data.layout)
    if (fromHost === null) return
    adoptedHostLayout.current = true
    applyLayout(fromHost)
    // `applyLayout` is stable in behaviour (it writes refs and one state set).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  // Hand the module-level `saveLayout` a way to reach the transport. Cleared on
  // unmount so a stale closure cannot outlive the component.
  React.useEffect(() => {
    hostSaveLayout = (geometry) => {
      call('layout', { layout: geometry })
    }
    return () => {
      hostSaveLayout = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])


  /**
   * The saved settings, as the host last reported them. Every poll refreshes
   * this, so a board edited by a script or another browser converges instead of
   * showing a stale form forever.
   */
  const savedSettings =
    data !== null && data !== undefined && data.settings !== null && typeof data.settings === 'object'
      ? data.settings
      : { autoCapture: true, autoJudge: false, nudge: true, minChars: 200, minEntries: 2, maxTurnSessions: 10 }

  /**
   * Auto-capture, as the header button sees it.
   *
   * The switch belongs on the panel, not only in the settings page: which mode
   * someone wants changes with what they are doing — exploring a new idea, or
   * heads-down on one thread — and a two-step trip through a dialog is enough to
   * make them stop using the feature at all. The settings page keeps the same
   * value, so both stay honest.
   */
  const autoOn = savedSettings.autoCapture !== false
  function toggleAutoCapture() {
    call('settings', { settings: { autoCapture: !autoOn } })
  }

  /**
   * Tell the host we left a conversation.
   *
   * The host cannot see the browser's active session, so "the person walked away
   * without answering" is invisible to it until something says so. Switching
   * tabs is that moment: whatever question was still hanging in the session we
   * just left gets flushed to the board right then, instead of waiting out the
   * half-hour grace timer.
   */
  React.useEffect(() => {
    const leaving = lastFlushId
    if (leaving !== '' && currentId !== undefined && currentId !== leaving) {
      transport.call('autoflush', { sessionId: leaving }).catch(() => undefined)
    }
    lastFlushId = currentId === undefined ? '' : currentId
  }, [currentId])

  // The draft is a WORKING COPY, seeded when the page OPENS and then owned by
  // the form: the 2.5s poll must never overwrite what the user is halfway
  // through typing. Seeding on the open transition (rather than on every
  // `savedSettings` change) is exactly what keeps 「恢复默认」 honest too — it
  // edits the draft and does not touch the saved value.
  React.useEffect(() => {
    if (!settingsOpen) return
    setSettingsDraft({
      autoCapture: savedSettings.autoCapture !== false,
      autoJudge: savedSettings.autoJudge === true,
      nudge: savedSettings.nudge !== false,
      minChars: String(savedSettings.minChars),
      minEntries: String(savedSettings.minEntries),
      maxTurnSessions: String(savedSettings.maxTurnSessions),
    })
    setSettingsErr('')
    // Keyed on the OPEN transition only; see the comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen])
  const cwdKey = cwd === '' ? '' : cwd.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

  const byDir = todos.filter((t) => t.dir === cwdKey)
  // Ownership, not authorship: which session RUNS a row is no longer the session
  // that planned it, once the row has been re-parented or its container has
  // spawned. The host resolves that walk — containers, cycles and all — and ships
  // the answer as `ownerSessionId`, so the panel never restates the rule.
  // A container's children are owned by a session that does not exist YET, so
  // `ownerSessionId` is empty for them and the plain test drops them. They still
  // belong on this tab: the container that will carry them is right here, and a
  // row you cannot see is a row you cannot drag out again. So the tab also takes
  // anything nested under a row it owns, walking up the chain with the same
  // bound the host uses.
  const ownedByCurrent = (list, sessionId) => {
    const owned = new Set()
    for (const row of list) if (row.ownerSessionId === sessionId) owned.add(row.id)
    let grew = true
    while (grew) {
      grew = false
      for (const row of list) {
        const runIn = row.runIn
        if (runIn === undefined || runIn === null || runIn.kind !== 'after') continue
        if (owned.has(row.id) || !owned.has(runIn.id)) continue
        owned.add(row.id)
        grew = true
      }
    }
    return owned
  }
  const currentOwned = ownedByCurrent(todos, currentId)
  const bySession = todos.filter((t) => currentOwned.has(t.id))
  const scope = filter === 'dir' ? byDir : filter === 'session' ? bySession : todos
  // The open list and the completed list are two halves of one scope: a row is in
  // exactly one of them, which is what makes ticking the round box a MOVE rather
  // than a copy. Only the open half is draggable, and `dropOn` reads exactly this
  // array — so a finished row can never be dragged into the queue's order.
  const visible = scope
    .filter((t) => !t.verified)
    .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
  // Newest first: the row you just ticked has to land at the top of the section
  // you are looking at, otherwise the move is invisible and looks like a deletion.
  const completed = scope
    .filter((t) => t.verified)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || b.order - a.order)

  const awaitingVerify = todos.filter((t) => t.aiDone && !t.verified).length
  const verifiedCount = todos.filter((t) => t.verified).length
  const openCount = todos.filter((t) => !t.verified).length

  /** Group rows by directory, preserving the order they arrive in. */
  function dirGroups(list) {
    const out = []
    const index = {}
    for (const todo of list) {
      const key = todo.dirLabel || '(未指定目录)'
      if (index[key] === undefined) {
        index[key] = out.length
        out.push({ key, items: [] })
      }
      out[index[key]].items.push(todo)
    }
    return out
  }

  /**
   * The scope's rows as execution boxes.
   *
   * A box is a SESSION that runs rows, not a directory: ownership is what the
   * dispatch path follows, so it is what the panel explains. Within a box rows
   * keep their `order`, and a row with children becomes a container — its
   * children are indented beneath it and travel with it when it opens a session.
   *
   * A row whose owner is gone has nowhere to run, so it gets no box at all:
   * better absent than parked under a header the user cannot act on. The
   * current session is always present, so there is somewhere to aim a new row
   * and the list never looks like it lost everything.
   *
   * A child whose parent is missing from this scope — verified away, owned by
   * another tab, or its container spawned into a session this view cannot see —
   * is promoted to a root instead of dropped: a row you cannot see is a row
   * you cannot drag out again.
   *
   * Boxes are ordered by the newest row they own. The session store carries no
   * activity timestamp, so "which of my sessions moved last" is answered from
   * the rows themselves rather than inventing a second clock.
   */
  function boxTree(list, currentId) {
    // The orphan rule above, applied at bucketing time: a parent that is not
    // in this scope can never be walked to, so its child becomes a root here.
    const present = new Set()
    for (const todo of list) present.add(todo.id)
    const childrenOf = new Map()
    const roots = []
    for (const todo of list) {
      const runIn = todo.runIn
      if (
        runIn !== undefined &&
        runIn !== null &&
        runIn.kind === 'after' &&
        present.has(runIn.id)
      ) {
        const bucket = childrenOf.get(runIn.id)
        if (bucket === undefined) childrenOf.set(runIn.id, [todo])
        else bucket.push(todo)
      } else {
        roots.push(todo)
      }
    }
    // `seen` is the client-side twin of the host's cycle guard: a hand-made knot
    // must not become an infinite walk here either.
    const walk = (todo, depth, seen) => {
      if (seen.has(todo.id)) return []
      seen.add(todo.id)
      const out = [{ todo, depth }]
      const kids = childrenOf.get(todo.id)
      if (kids !== undefined) for (const kid of kids) out.push(...walk(kid, depth + 1, seen))
      return out
    }
    const boxes = []
    const byKey = new Map()
    for (const root of roots) {
      const key = typeof root.ownerSessionId === 'string' ? root.ownerSessionId : ''
      if (key === '') {
        // A row whose owner session does not exist yet (container children
        // parked under a not-yet-spawned session). On the "全部" tab these
        // would vanish entirely — keep them under a synthetic box labelled by
        // their own dirLabel so every row is always somewhere.
        const fallbackKey = root.dirLabel || '(未指定)'
        let fbox = byKey.get(fallbackKey)
        if (fbox === undefined) {
          fbox = { key: fallbackKey, entries: [], newest: 0, dirLabel: root.dirLabel || '(未指定)' }
          byKey.set(fallbackKey, fbox)
          boxes.push(fbox)
        }
        fbox.entries.push({ todo: root, depth: 0 })
        const updated = root.updatedAt || 0
        if (updated > fbox.newest) fbox.newest = updated
        continue
      }
      let box = byKey.get(key)
      if (box === undefined) {
        box = { key, entries: [], newest: 0, dirLabel: '' }
        byKey.set(key, box)
        boxes.push(box)
      }
      const entries = walk(root, 0, new Set())
      box.entries.push(...entries)
      for (const entry of entries) {
        const updated = entry.todo.updatedAt || 0
        if (updated > box.newest) box.newest = updated
      }
      if (box.dirLabel === '') box.dirLabel = root.dirLabel || '(未指定目录)'
    }
    boxes.sort((a, b) => b.newest - a.newest || a.key.localeCompare(b.key))
    if (currentId !== undefined && currentId !== '' && !byKey.has(currentId)) {
      boxes.unshift({
        key: currentId,
        entries: [],
        newest: 0,
        dirLabel: cwd === '' ? '(当前会话)' : cwd,
      })
    }
    return boxes
  }

  /** The header text of one box: who runs it, plus where, on the wide views. */
  function boxLabel(box) {
    const row = sessionRows === undefined || sessionRows === null ? undefined : sessionRows[box.key]
    const title =
      row !== undefined && row !== null && typeof row.title === 'string' && row.title !== ''
        ? row.title
        : box.key.slice(-6)
    return filter === 'session' ? title : title + ' · ' + box.dirLabel
  }

  const groups = dirGroups(visible)
  const doneGroups = dirGroups(completed)

  // ------------------------------------------------------------ log view data

  /**
   * The dot on the log button: lit when an error/warn arrived that the user has
   * not looked at yet.
   *
   * `!logOpen` is part of the condition, not an optimisation. An error that
   * arrives WHILE the view is open must not light a dot on the page the user is
   * already reading — and it would, because the cursor that clears the dot is
   * only ever compared against records the user has actually been shown. The
   * effect below keeps the cursor level with what the open view has displayed.
   *
   * It is fed by `data.logAlert`, which the host sends on EVERY poll even with
   * the view closed. That is the deliberate exception to "no log leaves the
   * host": one number, no text, and without it the dot could only appear after
   * the user opened the view it is supposed to be pointing at.
   */
  const alertSn =
    data !== null && data !== undefined && data.logAlert !== undefined && data.logAlert !== null &&
    typeof data.logAlert.sn === 'number'
      ? data.logAlert.sn
      : 0
  const logAlert = !logOpen && alertSn > logSeenRef.current && alertSn > 0

  const activeLevels = LOG_LEVELS.filter((level) => logLevels[level] === true)
  const query = logQuery.trim().toLowerCase()
  const logRender = logLines.filter((line) => {
    if (activeLevels.indexOf(String(line.level)) < 0) return false
    const source = logSourceOf(line)
    if (logSource === 'self' && source !== 'self') return false
    // "全部" shows everything the exporter delivered; "其他插件" narrows to
    // records the exporter only ever admits at `error`, so the label says so.
    if (logSource === 'other' && source !== 'other') return false
    if (query !== '' && !logHaystack(line).includes(query)) return false
    return true
  })
  // Newest first: the reason someone opens this view is the thing that just
  // broke, and the newest record is always at the top without scrolling.
  const logShown = logRender.slice().reverse()
  const latestError = logLines.filter((line) => line.level === 'error').length

  function toggleLog() {
    setLogOpen((current) => !current)
  }

  // Opening one page closes the other: they are both replacements for the board
  // body, and showing two at once is a state the layout has no answer for.
  function toggleSettings() {
    setSettingsOpen((current) => {
      if (!current) setLogOpen(false)
      return !current
    })
  }

  /** Parse one numeric field, or `undefined` when it is not a whole number. */
  function draftNumber(value) {
    const text = String(value === undefined || value === null ? '' : value).trim()
    if (!/^\d+$/.test(text)) return undefined
    const parsed = Number(text)
    return Number.isSafeInteger(parsed) ? parsed : undefined
  }

  /**
   * Write the draft. The host validates too (and wins): this only catches the
   * obvious cases early enough to keep an invalid number from ever being sent.
   */
  function saveSettingsDraft() {
    if (settingsDraft === null) return
    const minChars = draftNumber(settingsDraft.minChars)
    const minEntries = draftNumber(settingsDraft.minEntries)
    const maxTurnSessions = draftNumber(settingsDraft.maxTurnSessions)
    if (minChars === undefined) {
      setSettingsErr('字数必须是整数')
      return
    }
    if (minEntries === undefined) {
      setSettingsErr('条目数必须是整数')
      return
    }
    if (maxTurnSessions === undefined) {
      setSettingsErr('单次回合最多新开会话必须是整数')
      return
    }
    setSettingsErr('')
    call('settings', {
      settings: {
        autoCapture: settingsDraft.autoCapture === true,
        autoJudge: settingsDraft.autoJudge === true,
        nudge: settingsDraft.nudge === true,
        minChars,
        minEntries,
        maxTurnSessions,
      },
    })
  }

  function resetSettingsDraft() {
    setSettingsDraft({
      autoCapture: true,
      autoJudge: false,
      nudge: true,
      minChars: '200',
      minEntries: '2',
      maxTurnSessions: '10',
    })
    setSettingsErr('')
  }

  function toggleLogLevel(level) {
    setLogLevels((current) => {
      const next = { ...current, [level]: !current[level] }
      // Never leave every filter off: an empty list would be indistinguishable
      // from "nothing was logged", which is the one wrong answer here.
      if (!LOG_LEVELS.some((id) => next[id] === true)) return current
      return next
    })
  }

  function cycleLogSource() {
    setLogSource((current) => {
      const next = current === 'self' ? 'other' : current === 'other' ? 'all' : 'self'
      saveLogSource(next)
      return next
    })
  }

  function copyLog() {
    const text = logAsText({ render: logShown })
    copyText(text).then((ok) => {
      setLogCopied(ok ? '已复制 ' + logShown.length + ' 条' : '复制失败')
      window.setTimeout(() => setLogCopied(''), 2000)
    })
  }

  function exportLog() {
    const text = logAsText({ render: logShown })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const ok = downloadText('dsh-todo-board-log-' + stamp + '.txt', text)
    setLogCopied(ok ? '已导出' : '导出失败')
    window.setTimeout(() => setLogCopied(''), 2000)
  }

  function clearLogView() {
    // Local only, and deliberately so: this drops the panel's copy, not the
    // host's records. A "clear" that deleted evidence on the host would be a
    // trap on a diagnostic surface.
    setLogLines([])
    setLogCopied('已清空本面板显示')
    window.setTimeout(() => setLogCopied(''), 2000)
  }

  async function call(method, args) {
    setBusy(true)
    try {
      const result = await transport.call(method, args)
      if (result !== null && result !== undefined && result.ok === false && typeof result.error === 'string') {
        setErr(result.error)
      } else {
        setErr('')
      }
    } catch (failure) {
      setErr(describe(failure))
    }
    setBusy(false)
    refresh()
  }

  function add() {
    const title = draft.trim()
    if (title === '') return
    const targetDir = dirInput.trim() !== '' ? dirInput.trim() : cwd
    const images = pending
    setDraft('')
    setWhen('')
    setPending([])
    call('create', {
      title,
      mode,
      dir: targetDir,
      schedule: when,
      images,
      sessionId: currentId === undefined ? '' : currentId,
      sessionTitle: currentTitle,
    })
  }

  /** Read one image file into the wire shape the host admits. */
  function readImageFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(new Error('读取失败：' + (file.name || '剪贴板图片')))
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : ''
        const comma = result.indexOf(',')
        if (comma < 0) {
          reject(new Error('无法编码：' + (file.name || '剪贴板图片')))
          return
        }
        resolve({
          data: result.slice(comma + 1),
          // A clipboard image does not always carry a MIME type — a screenshot
          // from some tools arrives with an empty `type`. The host validates the
          // media type strictly and would reject it as 「(未声明)」, so fall back
          // to the filename's extension, which is what the host itself would do.
          mediaType: imageMediaType(file),
          name: file.name || 'clipboard.png',
        })
      }
      reader.readAsDataURL(file)
    })
  }

  /**
   * The MIME type to send for one picked or pasted image.
   *
   * `file.type` first, because that is the browser's own answer and it is right
   * for every normal paste. The extension is the fallback for the clipboard
   * cases that arrive without one.
   */
  function imageMediaType(file) {
    if (typeof file.type === 'string' && file.type !== '') return file.type
    const name = typeof file.name === 'string' ? file.name : ''
    const dot = name.lastIndexOf('.')
    if (dot < 0) return ''
    return MEDIA_TYPE_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] || ''
  }

  /** Whether one clipboard entry is an image this panel can carry. */
  function isImageFile(file) {
    if (file === null || file === undefined) return false
    if (typeof file.type === 'string' && file.type.indexOf('image/') === 0) return true
    // No type at all: accept it only if the name says it is one of the four
    // formats the host admits, so an unknown extension cannot ride along.
    return typeof file.type === 'string' && file.type === '' && imageMediaType(file) !== ''
  }

  /**
   * The image files on one clipboard payload, in clipboard order.
   *
   * Both faces are read because they disagree about what pasting a file means:
   * `files` is the flat list, `items` distinguishes an image from the text you
   * copied alongside it. Either alone misses real pastes.
   */
  function clipboardImages(clipboard) {
    if (clipboard === null || clipboard === undefined) return []
    const out = []
    const files = clipboard.files
    if (files !== undefined && files !== null && files.length > 0) {
      for (const file of Array.from(files)) if (isImageFile(file)) out.push(file)
      if (out.length > 0) return out
    }
    const items = clipboard.items
    if (items === undefined || items === null) return out
    for (const item of Array.from(items)) {
      if (item.kind !== 'file') continue
      const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null
      if (isImageFile(file)) out.push(file)
    }
    return out
  }

  /**
   * Attach whatever images a paste carried.
   *
   * `preventDefault` fires **only** when there really are images on the
   * clipboard: pasting text into the composer is the ordinary way to write a
   * task, and swallowing that would break the main input to support a side one.
   * The paste is left entirely alone when it is text.
   */
  function pasteImages(event) {
    const files = clipboardImages(event.clipboardData)
    if (files.length === 0) return
    // An image paste never also means "insert this text", so the default is
    // suppressed from here on — including the over-limit case, where the point
    // is to say why nothing was attached rather than to paste a filename.
    event.preventDefault()
    if (pending.length >= MAX_IMAGES) {
      setErr('一条待办最多带 ' + MAX_IMAGES + ' 张图片，先移除一张再粘贴')
      return
    }
    const room = MAX_IMAGES - pending.length
    const wanted = files.slice(0, room)
    setBusy(true)
    Promise.all(wanted.map(readImageFile)).then(
      (encoded) => {
        setPending((current) => current.concat(encoded).slice(0, MAX_IMAGES))
        setErr(
          files.length > room
            ? '只粘贴了前 ' + room + ' 张（上限 ' + MAX_IMAGES + ' 张），其余已忽略'
            : '',
        )
        setBusy(false)
      },
      (failure) => {
        setErr(describe(failure))
        setBusy(false)
      },
    )
  }

  function setSchedule(todo, value) {
    patch(todo.id, { schedule: value })
  }

  /** Open the inline picker for one row, seeded with its current time. */
  function beginWhen(todo) {
    setWhenId(todo.id)
    setWhenDraft(todo.schedule || '')
  }

  /** Commit the picker: an empty value clears the schedule, as it does at add. */
  function commitWhen(id) {
    const value = whenDraft
    setWhenId('')
    setWhenDraft('')
    patch(id, { schedule: value })
  }

  /** One desktop notification per reminder the host has stamped as due. */
  function notifyDue(list) {
    for (const todo of list) {
      const stamp = typeof todo.remindedAt === 'number' ? todo.remindedAt : 0
      if (stamp === 0) {
        delete seenReminders.current[todo.id]
        continue
      }
      if (seenReminders.current[todo.id] === stamp) continue
      seenReminders.current[todo.id] = stamp
      if (todo.verified) continue
      try {
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          new Notification('TODO 到时间了', { body: todo.title, tag: 'dshtb-' + todo.id })
        }
      } catch (err) {
        /* notification blocked: the row chip still shows 已到时间 */
      }
    }
  }

  function patch(id, p) {
    call('patch', { id, patch: p })
  }

  function cycleMode(todo) {
    const next = MODES[(MODES.indexOf(todo.mode) + 1) % MODES.length]
    patch(todo.id, { mode: next })
  }

  function beginEdit(todo) {
    setEditId(todo.id)
    setEditText(todo.title)
  }

  function commitEdit() {
    const id = editId
    const text = editText.trim()
    setEditId('')
    if (id === '' || text === '') return
    patch(id, { title: text })
  }

  function beginNote(todo) {
    setNoteId(todo.id)
    setNoteDraft(typeof todo.note === 'string' ? todo.note : '')
  }

  function cancelNote() {
    setNoteId('')
    setNoteDraft('')
  }

  /**
   * Save the note exactly as typed.
   *
   * Not trimmed, not capped. The note is the context the model reads before it
   * starts, and it is free text: a character this function silently dropped
   * would be a lie in the one place the panel has to be a faithful view of the
   * board. If a limit is ever wanted it belongs in the host, as a refusal.
   */
  function commitNote(id) {
    const text = noteDraft
    cancelNote()
    patch(id, { note: text })
  }

  /**
   * Drop ON a row: become its child.
   *
   * Ownership is what decides where a row runs, so this is the drop that
   * changes it. Only the dragged row's own `runIn` is sent — the host resolves
   * the target at dispatch time, so a subtree moves with its root without the
   * panel having to restate anything.
   */
  function dropAsChild(parentId) {
    const from = dragId
    setDragId('')
    setOverId('')
    if (from === '' || from === parentId) return
    call('patch', { id: from, patch: { runIn: { kind: 'after', id: parentId } } })
  }

  /** Drop on a box header: move the row to that session. */
  function dropOnBox(sessionId) {
    const from = dragId
    setDragId('')
    setOverId('')
    if (from === '' || sessionId === '') return
    call('patch', { id: from, patch: { runIn: { kind: 'session', id: sessionId } } })
  }

  /**
   * Drop in the GAP between rows: reorder only, ownership untouched.
   *
   * This is the sibling move. Keeping it on the gap is what lets a row sit
   * below a container without belonging to it — the case where a row looks
   * nested but has to stay in this session and run here after the handoff.
   *
   * @param afterId - the row to land behind; '' means the very top.
   */
  function dropAt(afterId) {
    const from = dragId
    setDragId('')
    setOverId('')
    if (from === '') return
    const ids = visible.map((t) => t.id)
    const fromIndex = ids.indexOf(from)
    if (fromIndex < 0) return
    ids.splice(fromIndex, 1)
    const anchor = afterId === '' ? -1 : ids.indexOf(afterId)
    if (afterId !== '' && anchor < 0) {
      call('reorder', { ids })
      return
    }
    ids.splice(anchor + 1, 0, from)
    call('reorder', { ids })
  }

  /**
   * One row of either list.
   *
   * @param completed - true inside the 已完成 section. A finished row is no
   *   longer part of the queue: it carries no drag handle and no drop target,
   *   because `dropOn` reorders the OPEN list and the row no longer sits in it.
   */
  function item(todo, rowIndex, completed, depth) {
    const finished = completed === true
    let cls = 'dshtb-item'
    if (todo.verified) cls += ' done'
    if (todo.autoCaptured === true) cls += ' auto'
    if (dragId === todo.id) cls += ' dragging'
    if (overId === todo.id && dragId !== '' && dragId !== todo.id) cls += ' over'
    // Nesting depth inside its container. It is presentation only — ownership
    // comes from `runIn` — but a row that travels with a container has to LOOK
    // like it does, or dragging it out later makes no sense.
    const nest = typeof depth === 'number' && depth > 0 ? Math.min(depth, 4) : 0

    // Only a row that has never been handed over can be dispatched by hand.
    // Everything else is either already sent, already finished, or stuck on a
    // session that no longer exists. If `state` is missing entirely (a browser
    // half newer than its host, e.g. a half-applied update) fall back to the raw
    // stamp, so the button degrades instead of locking every row.
    const state = typeof todo.state === 'string' ? todo.state : (todo.dispatchedAt > 0 ? 'dispatched' : 'pending')
    const runnable = state === 'pending'

    // Read once, here, because both the chip row and the body use it. The note is
    // plain text: it is never trimmed, never capped, and never parsed.
    const noteText = typeof todo.note === 'string' ? todo.note : ''

    // The directory is NOT a chip: the facts line under the title already names
    // it in full, and the chip only repeated the basename. The schedule is the
    // mirror image — it lives here as a chip and is deliberately absent from the
    // facts line, so neither fact is stated twice on one row.
    const meta = [
      h(
        'button',
        {
          className: 'dshtb-chip',
          key: 'm',
          title: '点击切换执行模式（当前：' + MODE_LABEL[todo.mode] + '）',
          onClick: () => cycleMode(todo),
        },
        MODE_SHORT[todo.mode],
      ),
    ]
    // A row the plugin wrote itself says so, and always in the same slot — right
    // after the mode chip, before the state chip — so the eye learns one place
    // instead of hunting for it.
    if (todo.autoCaptured === true) {
      meta.push(
        h(
          'span',
          {
            className: 'dshtb-chip auto',
            key: 'a',
            title: '这条是插件替你记的：AI 问完、你没回答就换了话题或离开会话',
          },
          '自动',
        ),
      )
    }
    if (state === 'lost') {
      const attempts = typeof todo.lostAttempts === 'number' && todo.lostAttempts > 1
        ? '（已自动重试 ' + todo.lostAttempts + ' 次）'
        : ''
      // A parked row is not always a *missing session*: the target model can
      // refuse images, and spawning can fail. Name the actual cause and fix.
      const lost = LOST_CHIP[todo.lostKind] || LOST_CHIP['no-session']
      meta.push(
        h(
          'span',
          {
            className: 'dshtb-chip bad',
            key: 's',
            title:
              (todo.lostReason || '目标会话已不存在') + '，无法自动接续' + attempts + '。\n' + lost.hint,
          },
          lost.label,
        ),
      )
    } else {
      // Every other state gets its chip, always. `dispatched` additionally warns
      // when the session it went to has since closed: that is *not* the same as
      // 目标会话丢失 (a dispatch that never landed), and it is deliberately not
      // auto-retried, because the work may already have been done once.
      const chip = STATE_CHIP[state] || STATE_CHIP.pending
      const title =
        state === 'dispatched' && todo.targetAlive === false
          ? chip.hint +
            '\n但目标会话已经不在了。不确定它是否跑完，所以不会自动重试；想重跑就改执行模式或换目录。'
          : chip.hint
      meta.push(h('span', { className: 'dshtb-chip ' + chip.cls, key: 's', title }, chip.label))
    }
    // The schedule chip is always rendered, not only when a time is set: a row
    // added without one must still be able to get it later, which is the whole
    // point of editing the board rather than only composing into it.
    if (whenId === todo.id) {
      meta.push(
        h(
          'span',
          { className: 'dshtb-whenchip', key: 'w' },
          h('input', {
            type: 'datetime-local',
            className: 'dshtb-whenedit',
            value: whenDraft,
            autoFocus: true,
            title: '选择到点执行的时间（留空 = 不定时）',
            onChange: (e) => setWhenDraft(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitWhen(todo.id)
              }
              if (e.key === 'Escape') {
                setWhenId('')
                setWhenDraft('')
              }
            },
          }),
          h(
            'button',
            {
              className: 'dshtb-ic',
              title: '保存定时',
              onClick: () => commitWhen(todo.id),
            },
            '\u2713',
          ),
          h(
            'button',
            {
              className: 'dshtb-ic',
              title: '取消',
              onClick: () => {
                setWhenId('')
                setWhenDraft('')
              },
            },
            '\u2715',
          ),
        ),
      )
    } else if (todo.schedule) {
      const due = typeof todo.dueAt === 'number' && todo.dueAt > 0 && todo.dueAt <= Date.now()
      meta.push(
        h(
          'button',
          {
            className: 'dshtb-chip' + (due ? ' due' : ''),
            key: 'w',
            title:
              (due ? '已到时间：' : '定时执行：') + todo.schedule + '\n点这里改时间',
            onClick: () => beginWhen(todo),
          },
          (due ? '\u23F0 ' : '\u25F4 ') + todo.schedule.slice(5).replace('T', ' ') + ' \u270E',
        ),
        // A sibling, not a nested control: an interactive element inside a
        // button is invalid and its clicks are ambiguous.
        h(
          'button',
          {
            className: 'dshtb-chip x',
            key: 'wx',
            title: '取消定时',
            onClick: () => setSchedule(todo, ''),
          },
          '\u2715',
        ),
      )
    } else {
      meta.push(
        h(
          'button',
          {
            className: 'dshtb-chip quiet',
            key: 'w',
            title: '点这里给这条待办设置定时执行时间',
            onClick: () => beginWhen(todo),
          },
          '\u25F4 不定时',
        ),
      )
    }
    // The note's own control, and the only one: `dshtb-chip` gives it the panel's
    // shared chip geometry (what the mode / schedule chips wear), while
    // `dshtb-notebtn` is the unique hook — a test looking for the note control can
    // never land on a mode chip or a time chip by accident.
    meta.push(
      h(
        'button',
        {
          className: 'dshtb-chip dshtb-notebtn',
          key: 'n',
          title:
            noteText === ''
              ? '给这条待办加备注：写给模型的上下文，派发时会一起发过去'
              : '编辑备注（当前 ' + noteText.length + ' 字）',
          onClick: () => beginNote(todo),
        },
        noteText === '' ? '\uFF0B 备注' : '\u270E 备注',
      ),
    )
    if (todo.sourceSessionTitle) {
      meta.push(h('span', { className: 'dshtb-chip', key: 't' }, todo.sourceSessionTitle))
    }
    // The bound run session is deliberately NOT shown on the row: it is an
    // internal detail, and the panel stays readable without it. The binding is
    // still what ▶ reuses; `todo_board list` and the host API expose it when
    // it actually matters.

    // Renaming happens inline and to the full width of the row: a long todo
    // needs to be readable while you edit it, not squeezed into one line.
    const editNode =
      editId === todo.id
        ? h('textarea', {
            className: 'dshtb-edit',
            ref: editRef,
            autoFocus: true,
            rows: 2,
            value: editText,
            onChange: (e) => setEditText(e.target.value),
            onBlur: commitEdit,
            onKeyDown: (e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                commitEdit()
              }
              if (e.key === 'Escape') setEditId('')
            },
          })
        : null

    const titleNode = editNode === null
      ? h('div', { className: 'dshtb-t', title: '双击编辑', onDoubleClick: () => beginEdit(todo) }, todo.title)
      : editNode

    // The note lives under the title as plain text — never a control, and never
    // inside the single-line title editor, which would cut a multi-line note in
    // half. While it is being edited the preview gives way to its own textarea;
    // `title` carries the full text so a clamped note is still readable on hover.
    const noteNode =
      noteId === todo.id
        ? h(
            'div',
            { className: 'dshtb-noteedit' },
            h('textarea', {
              className: 'dshtb-notearea',
              autoFocus: true,
              rows: 3,
              placeholder: '备注：写给这条待办的上下文（派发时会和标题一起发给模型）',
              value: noteDraft,
              onChange: (e) => setNoteDraft(e.target.value),
              onKeyDown: (e) => {
                // Enter saves, Shift+Enter makes a line: a note is multi-line, so
                // the newline key has to be the one that keeps typing.
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  commitNote(todo.id)
                }
                if (e.key === 'Escape') cancelNote()
              },
            }),
            h(
              'button',
              { className: 'dshtb-notesave', title: '保存备注（Enter）', onClick: () => commitNote(todo.id) },
              '保存',
            ),
            h('button', { className: 'dshtb-notecancel', title: '取消（Esc）', onClick: cancelNote }, '取消'),
          )
        : noteText === ''
          ? null
          : h('div', { className: 'dshtb-note', title: '备注：\n' + noteText }, noteText)

    // A plain monospace readout under the title: the directory in full, which a
    // long path would otherwise bury in a narrow panel, plus the bound session.
    // The schedule is deliberately NOT repeated here — its own chip carries it —
    // so no single fact is stated twice on one row.
    const facts = []
    facts.push('目录 ' + (todo.dirPath || todo.dir || '(未指定)'))
    if (todo.runSessionId && todo.mode !== 'newSession') {
      facts.push('会话 ' + todo.runSessionId.slice(-6))
    }
    const detailNode = h('div', { className: 'dshtb-facts' }, facts.join('  ·  '))

    // Attached images: thumbnails on the row, click to enlarge, ✕ to drop.
    const images = Array.isArray(todo.images) ? todo.images : []
    const imagesNode =
      images.length === 0
        ? null
        : h(
            'div',
            { className: 'dshtb-imgs' },
            images.map((image, at) =>
              h(
                'span',
                { className: 'dshtb-imgwrap', key: 'i' + at },
                h('img', {
                  className: 'dshtb-img',
                  src: imageUrl(image.attachmentId),
                  alt: image.name || '附图',
                  title: (image.name || '附图') + ' · ' + image.width + '×' + image.height + '（点击放大）',
                  onClick: () => setViewing(image),
                  onError: (e) => {
                    e.currentTarget.style.opacity = '0.25'
                  },
                }),
                h(
                  'button',
                  {
                    className: 'dshtb-imgx',
                    title: '移除这张图片',
                    onClick: () => patch(todo.id, {
                      images: images.filter((_, i) => i !== at),
                      clearImages: images.length === 1,
                    }),
                  },
                  '\u2715',
                ),
              ),
            ),
          )

    // A finished row belongs to no queue, so it is neither draggable nor a drop
    // target: `dropOn` reorders the OPEN list, and this row is not in it any more.
    const dragProps = finished
      ? {}
      : {
          onDragStart: (e) => {
            setDragId(todo.id)
            if (e.dataTransfer) {
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', todo.id)
            }
          },
          onDragOver: (e) => {
            e.preventDefault()
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
            if (overId !== todo.id) setOverId(todo.id)
          },
          onDragLeave: () => {
            if (overId === todo.id) setOverId('')
          },
          onDrop: (e) => {
            e.preventDefault()
            dropAsChild(todo.id)
          },
          onDragEnd: () => {
            setDragId('')
            setOverId('')
          },
        }

    return h(
      'div',
      {
        className: cls,
        'data-dshtb-nest': String(nest),
        key: todo.id,
        style: { animationDelay: Math.min(rowIndex, 12) * 18 + 'ms' },
        draggable: finished ? false : editId !== todo.id,
        ...dragProps,
      },
      // No handle on a finished row: an inert grip would still read as "drag me".
      // The row simply starts a little further left, which is what "not in the
      // queue any more" looks like.
      finished ? null : h('span', { className: 'dshtb-grip', title: '拖动调整执行顺序' }, '\u283F'),
      h(
        'div',
        { className: 'dshtb-checks' },
        h(
          'button',
          {
            className: 'dshtb-cb ai' + (todo.aiDone ? ' on' : ''),
            'aria-label': 'AI 已完成',
            title: todo.aiDone ? 'AI 已完成 — 点击撤销' : 'AI 已完成（由 AI 自动勾选，也可手点）',
            onClick: () => patch(todo.id, { aiDone: !todo.aiDone }),
          },
          todo.aiDone ? '\u2713' : '',
        ),
        h(
          'button',
          {
            className: 'dshtb-cb me' + (todo.verified ? ' on' : ''),
            'aria-label': '用户已验收',
            title: todo.verified ? '已验收 — 点击撤销' : '用户已验收（只有你能勾）',
            onClick: () => patch(todo.id, { verified: !todo.verified }),
          },
          todo.verified ? '\u2713' : '',
        ),
      ),
      h(
        'div',
        { className: 'dshtb-body' },
        titleNode,
        noteNode,
        detailNode,
        imagesNode,
        h('div', { className: 'dshtb-meta' }, meta),
      ),
      h(
        'div',
        { className: 'dshtb-acts' },
        // Every row carries the button so the action row keeps its shape, but
        // only an auto-captured row has a conversation to return to; on a
        // hand-written row there is nowhere to go, and a button that silently
        // does nothing is worse than a greyed one.
        h(
          'button',
          {
            className: 'dshtb-ic jump',
            title:
              todo.autoCaptured === true && typeof todo.sourceSessionId === 'string' && todo.sourceSessionId !== ''
                ? '回到提出这个问题的那个会话' +
                  (typeof todo.sourceTurn === 'number' && todo.sourceTurn > 0
                    ? '（第 ' + todo.sourceTurn + ' 轮之后）'
                    : '')
                : '这条是手写的，没有来源会话可跳回',
            disabled:
              busy ||
              todo.autoCaptured !== true ||
              typeof todo.sourceSessionId !== 'string' ||
              todo.sourceSessionId === '',
            onClick: () => jumpBack(todo),
          },
          '\u21A9',
        ),
        h(
          'button',
          {
            className: 'dshtb-ic',
            // Once a row has been handed to a session, sending it again just
            // duplicates work — the automatic paths decide when it runs next.
            // A row whose target is gone is also locked, because ▶ would send it
            // to whatever session happens to be open, not the one it belongs to.
            title: runnable
              ? '立即接续到当前会话'
              : state === 'lost'
                ? '目标会话已丢失，不能手动派发；改模式/换目录或等到点自动重试'
                : '已派发，不能重复派发',
            disabled: busy || !runnable,
            onClick: () =>
              call('run', { id: todo.id, sessionId: currentId === undefined ? '' : currentId }),
          },
          '\u25B6',
        ),
        h(
          'button',
          {
            className: 'dshtb-ic',
            title: '删除',
            disabled: busy,
            onClick: () => call('remove', { id: todo.id }),
          },
          '\u2715',
        ),
      ),
    )
  }

  if (!open) {
    const next = visible.filter((t) => !t.verified && !t.aiDone)[0]
    return h(
      'div',
      {
        className: 'dshtb-root',
        // The skin travels with the parked line too: it is the same panel.
        'data-dshtb-skin': skin,
        // Always auto-sized: the line hugs its content, which is the point of
        // this state — so the card's stored width and height stay out of it.
        style:
          layout === null
            ? {}
            : {
                left: layout.x + 'px',
                top: layout.y + 'px',
                right: 'auto',
                width: 'auto',
                height: 'auto',
                maxWidth: 'none',
                maxHeight: 'none',
              },
      },
      h(
        'div',
        {
          className: 'dshtb-pill',
          role: 'button',
          tabIndex: 0,
          ref: pillRef,
          title:
            'TODO 板 · 点击展开 · 拖动移动' +
            (next === undefined ? '（没有未完成待办）' : '：' + next.title) +
            (data !== null && data !== undefined && data.storagePath ? '\n存储：' + data.storagePath : ''),
          // A press that travels is a move; a press that does not is still the
          // click that unfolds the panel (see `beginParkDrag`).
          onPointerDown: beginParkDrag,
          onPointerMove: moveParkDrag,
          onPointerUp: endParkDrag,
          onPointerCancel: endParkDrag,
          onClick: unparkOnClick,
          onKeyDown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setOpen(true)
            }
          },
        },
        h('span', { className: 'lbl' }, 'TODO'),
        h(
          'span',
          { className: 'dshtb-badge' + (awaitingVerify > 0 ? ' warn' : '') },
          String(openCount),
        ),
        next === undefined
          ? h(
              'span',
              { className: 'next q' },
              filter === 'session'
                ? '当前会话已清空'
                : filter === 'dir'
                  ? '当前目录已清空'
                  : '没有未完成待办',
            )
          : h('span', { className: 'next' }, '下一条 · ' + next.title),
        awaitingVerify > 0 ? h('span', { className: 'dshtb-badge warn' }, '待验 ' + awaitingVerify) : null,
      ),
    )
  }

  // 全部 first and default: every session's todos are visible, grouped by
  // session. 目录 and 当前会话 narrow down when the user wants to focus.
  const segments = [
    { id: 'all', label: '全部', count: openCount },
    { id: 'dir', label: '当前目录', count: byDir.filter((t) => !t.verified).length },
    { id: 'session', label: '当前会话', count: bySession.filter((t) => !t.verified).length },
  ].map((seg) =>
    h(
      'button',
      {
        key: seg.id,
        className: filter === seg.id ? 'on' : '',
        onClick: () => setFilter(seg.id),
      },
      seg.label,
      h('em', null, String(seg.count)),
    ),
  )

  // Boxes, not directory headers: dispatch follows ownership, so the panel
  // explains ownership. 「当前会话」 has exactly one box by construction, which
  // is why that tab still reads like the flat list it always was.
  let rowIndex = 0
  const boxes = boxTree(visible, currentId)
  // Boxes always exist — the current session is always shown — so emptiness is
  // a question about ROWS, never about boxes. Counting entries is what keeps
  // the empty state and the mode hint honest on a fresh board.
  const openRowCount = boxes.reduce((total, box) => total + box.entries.length, 0)
  // A drop GAP before every row, and the box header is itself a target. Together
  // they separate the two moves: the gap reorders within a box, the row reparents,
  // the header hands the row to another session.
  const gap = (afterId) =>
    h('div', {
      key: 'gap-' + afterId,
      className: 'dshtb-gap' + (dragId !== '' ? ' live' : ''),
      onDragOver: (e) => {
        e.preventDefault()
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      },
      onDrop: (e) => {
        e.preventDefault()
        dropAt(afterId)
      },
    })
  const rows = boxes.map((box) =>
    h(
      'div',
      { key: 'box-' + box.key },
      h(
        'div',
        {
          className: 'dshtb-group' + (dragId !== '' ? ' droptarget' : ''),
          onDragOver: (e) => {
            e.preventDefault()
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
          },
          onDrop: (e) => {
            e.preventDefault()
            dropOnBox(box.key)
          },
          title: '把待办拖到这里＝交给这条会话执行',
        },
        boxLabel(box),
      ),
      box.entries.length === 0
        ? h('div', { className: 'dshtb-boxempty' }, '这个会话还没有待办')
        : box.entries.flatMap((entry) => [
            gap(entry.todo.id),
            item(entry.todo, rowIndex++, false, entry.depth),
          ]),
    ),
  )

  // The title-bar control doubles as the readout of which skin is on: its glyph
  // is the skin, and its tooltip names that skin and what it changes. Resolved
  // from the same table the cycle walks, so the label can never describe a
  // different skin than the one being applied.
  const activeSkin = SKINS.find((entry) => entry.id === skin) || SKINS[0]
  const skinName = activeSkin.name
  const skinHint = activeSkin.hint
  const skinGlyph = activeSkin.glyph

  // A null width or height means "the stylesheet decides": that is the state
  // after the line was dragged while parked, and it must survive unfolding so
  // the card comes back at its own size rather than the line's.
  const rootStyle =
    layout === null
      ? {}
      : {
          left: layout.x + 'px',
          top: layout.y + 'px',
          right: 'auto',
          ...(layout.w === null ? {} : { width: layout.w + 'px', maxWidth: 'none' }),
          ...(layout.h === null ? {} : { height: layout.h + 'px', maxHeight: 'none' }),
        }

  /**
   * The log page, rendered in place of the board inside the same floating
   * window — same frame, same drag and resize, no second window. Deliberately
   * plain: it is a developer surface, so it uses monospace, wraps long text and
   * spends no effort on decoration.
   */
  /**
   * The settings page: the planning-nudge knobs.
   *
   * A form, not a list — the only interactive surface here besides the
   * composer, so it uses real inputs and a real submit button. The numbers are
   * kept as STRINGS in the draft: `''` is a state a number cannot represent,
   * and treating it as `0` would silently save a threshold nobody can reach.
   */
  const setNum = (field) => (e) => {
    const value = e !== undefined && e.target !== undefined ? e.target.value : ''
    setSettingsDraft((current) => (current === null ? current : { ...current, [field]: value }))
  }
  const settingsView = h(
    'div',
    { className: 'dshtb-settingsview' },
    h(
      'label',
      { className: 'dshtb-setrow' },
      h('input', {
        type: 'checkbox',
        checked: settingsDraft === null ? true : settingsDraft.autoCapture === true,
        onChange: (e) =>
          setSettingsDraft((current) =>
            current === null ? current : { ...current, autoCapture: e.target.checked === true },
          ),
        'aria-label': '自动把没拍板的问题记成待办',
      }),
      '自动把没拍板的问题记成待办',
    ),
    h(
      'div',
      { className: 'dshtb-sethint' },
      'AI 问完一句、你没回答就换了话题或离开会话，插件会把那个问题记成一条待办，标题就是「在等你定什么」。' +
        '只要这轮你答过其中一部分、给过做法，就算你看过了，不记。关掉它就只剩你手写的待办——' +
        '面板头部那个 ● / ○ 按钮随时可以一键切换，不用进来。',
    ),
    h(
      'label',
      { className: 'dshtb-setrow' },
      h('input', {
        type: 'checkbox',
        checked: settingsDraft === null ? false : settingsDraft.autoJudge === true,
        onChange: (e) =>
          setSettingsDraft((current) =>
            current === null ? current : { ...current, autoJudge: e.target.checked === true },
          ),
        'aria-label': '让模型判断算不算回答了',
      }),
      '让模型判断「算不算回答了」',
    ),
    h(
      'div',
      { className: 'dshtb-sethint' },
      '默认用本地关键词判，「嗯，先放着吧」和「嗯，就这个」只差几个字、意思相反，这种地方关键词会失手。' +
        '勾上之后，这句话连同 AI 的原问题交给**当前会话正在用的模型**，只让它回一个词：答了 / 没答 / 搁置。' +
        '走你本来就有的模型路由（DeepSeek 会话不额外计费）；判不了就退回关键词，不会一律当成已回答。',
    ),
    h(
      'label',
      { className: 'dshtb-setrow' },
      h('input', {
        type: 'checkbox',
        checked: settingsDraft === null ? true : settingsDraft.nudge === true,
        onChange: (e) =>
          setSettingsDraft((current) =>
            current === null ? current : { ...current, nudge: e.target.checked === true },
          ),
        'aria-label': '长任务主动提醒我拆分',
      }),
      '长任务主动提醒我拆分',
    ),
    h(
      'div',
      { className: 'dshtb-setrow' },
      h('span', null, '字数 ≥'),
      h('input', {
        className: 'dshtb-setnum',
        type: 'number',
        min: 10,
        max: 10000,
        step: 1,
        value: settingsDraft === null ? '' : settingsDraft.minChars,
        disabled: settingsDraft !== null && settingsDraft.nudge !== true,
        onChange: setNum('minChars'),
        'aria-label': '字数下限',
      }),
    ),
    h(
      'div',
      { className: 'dshtb-setrow' },
      h('span', null, '条目数 ≥'),
      h('input', {
        className: 'dshtb-setnum',
        type: 'number',
        min: 1,
        max: 100,
        step: 1,
        value: settingsDraft === null ? '' : settingsDraft.minEntries,
        disabled: settingsDraft !== null && settingsDraft.nudge !== true,
        onChange: setNum('minEntries'),
        'aria-label': '条目数下限',
      }),
    ),
    h(
      'div',
      { className: 'dshtb-setrow' },
      h('span', null, '单次回合最多新开会话'),
      h('input', {
        className: 'dshtb-setnum',
        type: 'number',
        min: 1,
        max: 50,
        step: 1,
        value: settingsDraft === null ? '' : settingsDraft.maxTurnSessions,
        onChange: setNum('maxTurnSessions'),
        'aria-label': '单次回合最多新开会话数',
      }),
    ),
    h(
      'div',
      { className: 'dshtb-sethint' },
      '「单次回合最多新开会话」：一次回合结束时，最多能为你开出多少个「自动新开会话」的待办。' +
        '到上限后剩下的留到下一次回合，不会丢。计划超过这个数（比如拆了 20 步全是新会话）就想调大。' +
        '默认 10，范围 1–50。',
    ),
    h(
      'div',
      { className: 'dshtb-sethint' },
      '一条消息至少要有这么多字、且出现这么多次编号/列表/「第一步」之类的阶段标记，才会被认为「这事不止一步」。' +
        '关掉开关就完全不提醒。每个会话最多提醒一次。',
    ),
    settingsErr === '' ? null : h('div', { className: 'dshtb-seterr' }, settingsErr),
    h(
      'div',
      { className: 'dshtb-setactions' },
      h(
        'button',
        {
          className: 'dshtb-setbtn primary',
          onClick: saveSettingsDraft,
          disabled: settingsDraft === null || busy,
        },
        '保存',
      ),
      h(
        'button',
        {
          className: 'dshtb-setbtn',
          onClick: resetSettingsDraft,
          disabled: settingsDraft === null,
        },
        '恢复默认',
      ),
    ),
  )

  const logView = h(
    'div',
    { className: 'dshtb-logview' },
    h(
      'div',
      { className: 'dshtb-logbar' },
      LOG_LEVELS.map((level) =>
        h(
          'button',
          {
            key: level,
            className: logLevels[level] === true ? 'on' : '',
            title: '显示 ' + level + ' 级别的记录',
            onClick: () => toggleLogLevel(level),
          },
          level,
        ),
      ),
      h(
        'button',
        {
          className: 'dshtb-logsrc',
          title:
            logSource === 'self'
              ? '当前只显示本插件的记录；点击切到「其他插件」（只会有 error）'
              : logSource === 'other'
                ? '当前只显示其他插件的 error；点击切到「全部」'
                : '当前显示全部来源；点击切回「本插件」',
          onClick: cycleLogSource,
        },
        logSource === 'self' ? '本插件' : logSource === 'other' ? '其他插件' : '全部',
      ),
      h('input', {
        className: 'dshtb-logfilter',
        placeholder: '过滤关键字…',
        value: logQuery,
        onChange: (e) => setLogQuery(e.target.value),
      }),
    ),
    h(
      'div',
      { className: 'dshtb-logbar' },
      h('button', { title: '把当前筛选出的记录复制到剪贴板', onClick: copyLog }, '复制'),
      h('button', { title: '导出为 .txt（已再次脱敏）', onClick: exportLog }, '导出'),
      h('button', { title: '只清空本面板的显示，不影响主机上的记录', onClick: clearLogView }, '清空显示'),
      logCopied !== '' ? h('span', { className: 'dshtb-logmeta' }, logCopied) : null,
    ),
    h(
      'div',
      { className: 'dshtb-logmeta' },
      '显示 ' + logShown.length + ' / ' + logLines.length + ' 条（错误 ' + latestError + '）',
      logNote === '' ? null : ' · ' + logNote,
    ),
    logShown.length === 0
      ? h(
          'div',
          { className: 'dshtb-logempty' },
          logLines.length === 0
            ? '还没有日志。这里记录本插件的失败路径（派发失败、建会话失败、读写板失败等）。'
            : '当前筛选下没有记录。试试放宽级别，或把来源切到「全部」。',
        )
      : h(
          'div',
          { className: 'dshtb-loglist' },
          logShown.map((line, at) =>
            h(
              'div',
              { key: String(line.sn) + '-' + at, className: 'dshtb-logrow ' + String(line.level) },
              h('span', { className: 'at' }, logClock(line.ts)),
              h('span', { className: 'lv' }, String(line.level)),
              h(
                'span',
                { className: 'body' },
                line.detail,
                line.source === '' || line.source === 'dsh-todo-board'
                  ? null
                  : h('span', { className: 'src' }, '  ← ' + line.source),
              ),
            ),
          ),
        ),
  )

  /**
   * Back to the turn that asked the question.
   *
   * Two calls, because they answer different questions: `uiWorkspace.openSession`
   * switches the view to that conversation, and `sessions.using(...).loadThrough(seq)`
   * scrolls it to the turn the row was recorded from. Opening without the second
   * call lands at the newest message, which on a long conversation is exactly
   * where the question is not.
   *
   * Both services are read here rather than injected: a plugin whose panel mounts
   * while one of them is absent would otherwise fail to load entirely, and the
   * board is useful without the jump button.
   */
  function jumpBack(todo) {
    const sessionId = todo.sourceSessionId
    if (typeof sessionId !== 'string' || sessionId === '') return
    const seq = typeof todo.sourceSeq === 'number' ? todo.sourceSeq : 0
    const uiWorkspace = appCtx === null ? undefined : appCtx.get('uiWorkspace')
    const sessions = appCtx === null ? undefined : appCtx.get('sessions')
    const land = () => {
      if (sessions === undefined || sessions === null || seq <= 0) return
      sessions.using(sessionId, { source: 'controllerOperation' }, (ref) => {
        const ready = ref === undefined || ref === null ? undefined : ref.ready
        if (ready === undefined || ready === null) return undefined
        // `ready` is a promise in the current host API and a plain object in
        // older ones; both shapes are handled so the button does not depend on
        // which host it is running against.
        if (typeof ready.then === 'function') {
          return ready.then((settled) => {
            if (settled === undefined || settled === null) return undefined
            if (settled.session === undefined || settled.session === null) return undefined
            return settled.session.loadThrough(seq)
          })
        }
        if (ready.session === undefined || ready.session === null) return undefined
        return ready.session.loadThrough(seq)
      })
    }
    if (uiWorkspace === undefined || uiWorkspace === null || typeof uiWorkspace.openSession !== 'function') {
      land()
      return
    }
    const opened = uiWorkspace.openSession(sessionId)
    if (opened !== undefined && opened !== null && typeof opened.then === 'function') {
      opened.then(land, land)
    } else {
      land()
    }
  }

  return h(
    'div',
    { className: 'dshtb-root', 'data-dshtb-skin': skin, style: rootStyle },
    h(
      'div',
      { className: 'dshtb-card' },
      h(
        'div',
        {
          className: 'dshtb-head',
          title: '拖动移动 · 双击还原位置',
          onPointerDown: beginDrag,
          onPointerMove: movePointer,
          onPointerUp: endPointer,
          onPointerCancel: endPointer,
          onDoubleClick: resetLayout,
        },
        h(
          'span',
          {
            className: 'dshtb-title',
            title:
              (data !== null && data !== undefined && data.storagePath
                ? '存储：' + data.storagePath + '\n'
                : '') +
              '拖动标题栏移动 · 右下角 \u25E2 缩放 · 双击还原 · 拖动 \u283F 调整执行顺序 · 双击标题改名',
          },
          h('b', null, '\u2611'),
          ' TODO',
        ),
        h('span', { className: 'dshtb-sp' }),
        h(
          'span',
          { className: 'dshtb-stats' },
          h('i', { title: '未验收' }, String(openCount)),
          awaitingVerify > 0 ? h('i', { title: 'AI 已完成，等你验收' }, '待验 ' + awaitingVerify) : null,
        ),
        h(
          'button',
          {
            className: 'dshtb-auto' + (autoOn ? ' on' : ''),
            title: autoOn
              ? '自动记录：开\nAI 问完一句、你没回答就换了话题或离开会话，它会自己记一条待办。\n点一下关掉，只剩你手写的。'
              : '自动记录：关\n只显示你手写的待办。\n点一下打开：没拍板的问题自动记下来。',
            'aria-label': autoOn ? '关闭自动记录' : '打开自动记录',
            'aria-pressed': autoOn ? 'true' : 'false',
            onClick: toggleAutoCapture,
          },
          autoOn ? '\u25CF' : '\u25CB',
        ),
        h(
          'button',
          {
            className: 'dshtb-skin',
            title:
              '界面：' + skinName + '\n' + skinHint + '\n点击切换下一套（共 ' + SKINS.length + ' 套）',
            'aria-label': '切换界面风格（当前：' + skinName + '）',
            onClick: cycleSkin,
          },
          skinGlyph,
        ),
        h(
          'button',
          {
            // The dot is the whole "tell the developer without bothering the
            // user" mechanism: the log itself stays out of the way until this
            // button is clicked, and this button only advertises itself when
            // something actually went wrong.
            className: 'dshtb-log' + (logOpen ? ' on' : ''),
            title: logOpen
              ? '回到待办面板'
              : '开发者日志' +
                (logAlert ? '（有新的错误）' : '') +
                '\n平时用不到；出问题时把这里的内容复制给开发者看。',
            'aria-label': logOpen ? '回到待办面板' : '打开开发者日志',
            'aria-pressed': logOpen ? 'true' : 'false',
            onClick: toggleLog,
          },
          logOpen ? '\u2190' : '\u2699',
          logAlert ? h('span', { className: 'dshtb-dot' }) : null,
        ),
        h(
          'button',
          {
            className: 'dshtb-settings' + (settingsOpen ? ' on' : ''),
            title: settingsOpen
              ? '回到待办面板'
              : '设置\n长任务规划提醒：开关、字数与条目数阈值。',
            'aria-label': settingsOpen ? '回到待办面板' : '打开设置',
            'aria-pressed': settingsOpen ? 'true' : 'false',
            onClick: toggleSettings,
          },
          settingsOpen ? '\u2190' : '\u2692',
        ),
        h(
          'button',
          {
            className: 'dshtb-fold',
            title: '收起为一行（只留计数与下一条待办）',
            'aria-label': '收起为一行',
            onClick: togglePanel,
          },
          '\u2013',
        ),
      ),
      logOpen ? logView : null,
      settingsOpen ? settingsView : null,
      logOpen || settingsOpen ? null : h('div', { className: 'dshtb-seg' }, segments),
      // `foldable` returns an ARRAY of [header, body], so it is always spread
      // rather than passed as one child. Nesting the array as a child works in
      // React but hides the subtree from anything that walks `children`
      // directly, which is what the browser-half suite does.
      ...(logOpen || settingsOpen
        ? []
        : foldable({
            id: 'compose',
            name: '新增待办',
            open: sections.compose,
            onToggle: toggleSection,
            body: h(
              'div',
              { className: 'dshtb-compose', key: 'compose-body' },
              h(
                'div',
                { className: 'dshtb-add' },
                h('textarea', {
                  ref: inputRef,
                  rows: 3,
                  placeholder:
                    '新增待办…（Enter 添加，Shift+Enter 换行，Ctrl+V 粘贴截图）',
                  value: draft,
                  onChange: (e) => setDraft(e.target.value),
                  onPaste: pasteImages,
                  onKeyDown: (e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      add()
                    }
                  },
                }),
                h(
                  'button',
                  { className: 'dshtb-ic', title: '添加', disabled: busy || draft.trim() === '', onClick: add },
                  '\uFF0B',
                ),
              ),
              // No picker button and no standing hint: images arrive by pasting into
              // the composer above, and the composer's own placeholder already names
              // Ctrl+V. The attachment area therefore renders NOTHING while empty —
              // the counter appears only once something is attached, which is when
              // it carries information. Format support and the per-todo limit are
              // unchanged: both are enforced on paste and reported when they bite.
              pending.length === 0
                ? null
                : h(
                    'div',
                    { className: 'dshtb-attach' },
                    h(
                      'div',
                      { className: 'dshtb-hint' },
                      '已附 ' + pending.length + ' / ' + MAX_IMAGES + ' 张 · 点缩略图移除',
                    ),
                    h(
                      'div',
                      { className: 'dshtb-thumbs' },
                      pending.map((image, at) =>
                        h(
                          'button',
                          {
                            key: 'p' + at,
                            className: 'dshtb-thumb',
                            title: (image.name || '图片') + '（点击移除）',
                            onClick: () => setPending((current) => current.filter((_, i) => i !== at)),
                          },
                          h('img', { src: 'data:' + image.mediaType + ';base64,' + image.data, alt: image.name || '' }),
                          h('span', { className: 'x' }, '\u2715'),
                        ),
                      ),
                    ),
                  ),
              h(
                'div',
                { className: 'dshtb-modes' },
                MODES.map((id) =>
                  h(
                    'button',
                    { key: id, className: mode === id ? 'on' : '', title: MODE_LABEL[id], onClick: () => setMode(id) },
                    MODE_SHORT[id],
                  ),
                ),
              ),
              h('div', { className: 'dshtb-hint' }, MODE_HINT[mode]),
              h(
                'div',
                { className: 'dshtb-when' },
                h('span', { className: 'lbl' }, '定时'),
                h('input', {
                  type: 'datetime-local',
                  value: when,
                  title: '到点后才执行（留空 = 立即可以执行）',
                  onChange: (e) => setWhen(e.target.value),
                }),
                when !== ''
                  ? h(
                      'button',
                      {
                        className: 'dshtb-ic',
                        title: '取消定时',
                        onClick: () => setWhen(''),
                      },
                      '\u2715',
                    )
                  : h('span', { className: 'dshtb-hint' }, '不填'),
              ),
              h(
                'div',
                { className: 'dshtb-dir' },
                h('span', { className: 'lbl' }, '目录'),
                h('input', {
                  // Empty means 「跟随当前会话」, not 「no directory」, and the old
                  // placeholder ("目录：<cwd>") read like a value that was already
                  // filled in. Say what an empty field will actually do instead.
                  placeholder: cwd === '' ? '留空 = 用当前会话的工作目录' : '留空 = ' + cwd,
                  title:
                    '这条待办归到哪个目录：它决定分组、决定「当前目录」筛选，' +
                    '也决定回合结束后由哪个会话来接续。留空 = 跟随当前会话的工作目录。',
                  value: dirInput,
                  onChange: (e) => setDirInput(e.target.value),
                }),
              ),
            ),
          })),
      ...(logOpen || settingsOpen
        ? []
        : foldable({
            id: 'list',
            name: '待办列表',
            note: visible.length,
            open: sections.list,
            onToggle: toggleSection,
            body:
              openRowCount === 0
                ? h(
                    'div',
                    { className: 'dshtb-empty', key: 'list-body' },
                    h('b', null, '\u2610'),
                    h(
                      'span',
                      null,
                      completed.length > 0
                        ? '未完成的都清空了（已完成的在下面）'
                        : filter === 'session'
                          ? '当前会话还没有待办'
                          : filter === 'dir'
                            ? '当前目录还没有待办'
                            : '还没有待办',
                    ),
                  )
                : h(
                    'div',
                    { className: 'dshtb-list', key: 'list-body' },
                    // The note explains the mode chip the rows carry, so it lives
                    // with them — and only when there ARE rows: with nothing on the
                    // board there is no mode to change and no advice worth giving.
                    h(
                      'div',
                      { className: 'dshtb-listhint' },
                      '你可以通过点击更改任务执行模式，但不建议任务开始执行后更改',
                    ),
                    rows,
                  ),
          })),
      // The other half of the list, between the queue and the panel footer. It is
      // a separate section rather than a filter on the list: ticking the round box
      // has to LOOK like the row left the queue, and a filter would silently keep
      // finished rows one click away from the work you are doing.
      ...(logOpen || settingsOpen
        ? []
        : foldable({
            id: 'done',
            name: '已完成',
            note: completed.length,
            open: sections.done,
            onToggle: toggleSection,
            body:
              doneGroups.length === 0
                ? h(
                    'div',
                    { className: 'dshtb-doneempty', key: 'done-body' },
                    '还没有已验收的待办。勾上每行右边的圆勾，条目就会移到这里。',
                  )
                : h(
                    'div',
                    { className: 'dshtb-donelist', key: 'done-body' },
                    doneGroups.map((group) =>
                      h(
                        'div',
                        { key: 'done-' + group.key },
                        h('div', { className: 'dshtb-group' }, group.key),
                        group.items.map((todo) => item(todo, 0, true)),
                      ),
                    ),
                  ),
          })),
      err !== '' ? h('div', { className: 'dshtb-err' }, err) : null,
      data !== null && data !== undefined && data.storageError
        ? h('div', { className: 'dshtb-err' }, data.storageError)
        : null,
      // The status line is NOT a section any more. It carries exactly two facts —
      // which build is live and how much is still open — and a fact you have to
      // unfold to read is worse than useless: it can be folded away and then lie
      // by omission. So it has no header, no fold, and no stored state; the
      // `.dshtb-sp` keeps the two facts on the left and the two functional
      // entries (empty the 已完成 list, open the Cordis panel) on the right.
      logOpen || settingsOpen
        ? null
        : h(
            'div',
            { className: 'dshtb-foot', key: 'foot' },
            h('span', { title: '客户端构建标记，用来确认浏览器加载的是哪一版' }, 'v' + BUILD),
            h('span', { title: '还没验收的条数' }, '未验收 ' + openCount),
            awaitingVerify > 0 ? h('span', { title: 'AI 已完成、等你验收' }, '· 待验 ' + awaitingVerify) : null,
            h('span', { className: 'dshtb-sp' }),
            verifiedCount > 0
              ? h(
                  'button',
                  {
                    className: 'dshtb-link',
                    title: '删除所有已验收的条目（共 ' + verifiedCount + ' 条）',
                    onClick: () => call('clearVerified'),
                  },
                  '清理已验收 ' + verifiedCount,
                )
              : null,
            h(
              'button',
              {
                className: 'dshtb-link' + (cordisFound ? '' : ' off'),
                title: cordisFound
                  ? '打开 Cordis 动态插件面板（显示在本面板正下方）'
                  : '找不到 Cordis 入口，暂时打不开',
                onClick: openCordisPanel,
              },
              'Cordis Plugin',
            ),
          ),
      h('div', {
        className: 'dshtb-resize',
        title: '拖动缩放 · 双击还原',
        onPointerDown: beginResize,
        onPointerMove: movePointer,
        onPointerUp: endPointer,
        onPointerCancel: endPointer,
        onDoubleClick: resetLayout,
      }),
      viewing === null
        ? null
        : h(
            'div',
            { className: 'dshtb-light', onClick: () => setViewing(null) },
            h('img', {
              src: imageUrl(viewing.attachmentId),
              alt: viewing.name || '附图',
              onClick: (e) => e.stopPropagation(),
            }),
            h('div', { className: 'dshtb-lightcap' }, viewing.name || '附图', ' · ', viewing.width + '×' + viewing.height, ' · 点空白处关闭'),
          ),
    ),
  )
}

// ------------------------------------------------------------ plugin entry

exports.name = 'dsh-todo-board'
exports.inject = ['slots']
exports.apply = function apply(ctx) {
  ctx.effect(
    () => {
      const style = document.createElement('style')
      style.setAttribute('data-dsh-todo-board', '')
      // Pre-tag with our module id: dsh-client-modules' claimStyles adopts any
      // untagged <style> for whichever plugin materializes next, and the next
      // HMR replace of THAT plugin would then delete ours. `data-plugin` keeps
      // ownership where it belongs (same convention as the official packages).
      style.setAttribute('data-plugin', 'dsh-todo-board')
      style.textContent = CSS
      document.head.appendChild(style)
      return () => style.remove()
    },
    'dsh-todo-board: styles',
  )

  // One tag per skin, all live at once and scoped under the root's
  // `data-dshtb-skin`, so switching is an attribute write on one node: no
  // re-injection, no flash of unstyled panel, and unregistering the default
  // skin stays impossible because its rules are never removed.
  for (const id of Object.keys(SKIN_CSS)) {
    ctx.effect(
      () => {
        const style = document.createElement('style')
        style.setAttribute('data-dsh-todo-board', '')
        style.setAttribute('data-plugin', 'dsh-todo-board')
        style.setAttribute('data-dsh-todo-board-skin', id)
        style.textContent = SKIN_CSS[id]
        document.head.appendChild(style)
        return () => style.remove()
      },
      'dsh-todo-board: skin ' + id,
    )
  }

  ctx.effect(() => () => restoreCordisFooter(), 'dsh-todo-board: cordis bridge')

  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      { name: 'shell.overlay', id: 'todo-board', order: 40, label: 'TODO 板' },
      // The board needs two host services (open a session, scroll to a turn) for
      // its 回到原会话 button. They are handed down here rather than listed in
      // `exports.inject`, because an injected service that is missing fails the
      // whole plugin — the panel would not render at all, and the jump button is
      // the smallest thing in it.
      function TodoBoardWithServices(slotProps) {
        return h(TodoBoard, Object.assign({}, slotProps, { appCtx: ctx }))
      }
    ),
  )
}

return module.exports;
} });
