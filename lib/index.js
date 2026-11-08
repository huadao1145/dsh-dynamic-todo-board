/**
 * dsh-todo-board — Host half.
 *
 * Owns one durable board file, the `todo_board` model tool, the turn-end
 * auto-continue hook, one system-prompt section, and the
 * `/dsh-todo-board/api` route the browser half talks to.
 *
 * Deliberately imports nothing from `@deepseek-ai/*`: a profile-installed
 * plugin resolves modules from its own directory, and the harness packages are
 * not reachable from there. Everything goes through `ctx`.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-todo-board'

const MODES = ['remind', 'resume', 'newSession']
/**
 * Cap on the container walk in {@link effectiveTarget}.
 *
 * A user can drag A under B and then B under A, so the walk is bounded twice
 * over: a visited set catches direct cycles and this cap catches the deep
 * chains that would otherwise be legal but pointless. A real plan nests one or
 * two deep, so anything past this is a hand-made knot, not a plan.
 */
const MAX_OWNER_DEPTH = 16
/**
 * How many sessions one turn end may open — the DEFAULT of a user setting.
 *
 * A spawn used to end the chain — the fresh session then found the rest of the
 * directory's rows by itself. Now it only owns its own children, so the
 * originating session has to come back for more. Ten is generous for a real
 * plan and still bounded: an unbounded loop here would open sessions in a
 * tight `await` chain while the turn boundary waits on this listener.
 *
 * 0.13.4 made this adjustable (`settings.maxTurnSessions`). The cap matters
 * because `MAX_PLAN_ITEMS` allows a 20-step plan: with the old hardcoded 10, a
 * twenty-step plan of `newSession` rows could only half-dispatch at one turn
 * end, and nothing guaranteed a "next time". The constant stays as the default.
 */
const MAX_TURN_SESSIONS = 10
const ROUTE = '/dsh-todo-board/api'
const IMAGE_ROUTE = '/dsh-todo-board/image'
const TOOL_NAME = 'todo_board'

/** Scheduled todos fire at minute precision, in the host machine's local time. */
const SCHEDULE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/
/** Safety net beside the exact timer: a suspended machine never delivers a timeout. */
const SCHEDULE_TICK_MS = 30000
/** Attachments one todo may carry; keeps a prompt from becoming an image dump. */
const MAX_IMAGES_PER_TODO = 4
/**
 * Rows one `add` may create at once.
 *
 * A plan costs ONE approval, which is the whole point of batch creation — but an
 * approval nobody can read is not consent either, so there is a ceiling. Twenty
 * steps is already a long plan; beyond that the honest answer is "two batches",
 * not a wall of text in a dialog.
 */
const MAX_PLAN_ITEMS = 20
/**
 * When the deterministic "this looks multi-stage" nudge fires.
 *
 * BOTH thresholds must hold: a message shorter than this is never a plan, and
 * fewer than this many staged markers is not a staged job. Conservative on
 * purpose — a false positive costs the user one pointless question, but a noisy
 * plugin is one people turn off, which costs them the feature entirely.
 */
const PLAN_NUDGE_MIN_CHARS = 200
const PLAN_NUDGE_MIN_MARKERS = 2

/**
 * The planning nudge's user-facing knobs, and their defaults.
 *
 * These used to be two module constants, which meant "this looks multi-stage"
 * was decided by whoever last edited the source. The thresholds are subjective
 * — a user who writes long briefs gets a false positive every time, one who
 * writes short terse requests never gets the offer at all — and the cost of
 * getting them wrong is not "one extra question": the nudge fires at most ONCE
 * per session (`planningNudged`), so a single bad call spends the session's one
 * chance.
 *
 * So they live on the board now, next to the rows they govern, with the module
 * constants as the defaults. `nudge: false` turns the offer off entirely.
 */
/**
 * Whether unanswered questions from a conversation are captured onto the board
 * automatically.
 *
 * ON by default because that is the whole feature: the board is supposed to hold
 * what the user has NOT decided yet, and asking him to type it in himself is the
 * manual board he already had. The panel carries a one-click switch, because
 * there are runs where a capture would be noise (a brainstorming session, a
 * throwaway experiment) and the honest answer there is "off for now", not
 * "edit the JSON".
 */
/**
 * Whether "did he actually answer it?" is handed to the session's own model
 * instead of the keyword lists below.
 *
 * The user's complaint that started this: the keyword verdicts are wrong about
 * Chinese. 「嗯，先放着吧」 and 「嗯，就这个」 differ by three characters and mean
 * opposite things; 「行，那两个回头再说」 answers one question and defers the
 * other. Lists can be patched forever and will still meet a sentence they have
 * never seen. Only a reader of the language settles those, and one is already
 * running this very session.
 *
 * OFF by default, deliberately: the call is billed to whatever provider the
 * session uses, and while that is the free-of-charge DeepSeek here, a deployment
 * may be wired to a metered one. Spending money at the end of a conversation is
 * not a decision a plugin gets to make on the user's behalf — so it is offered as
 * a switch and never switched on by the plugin itself.
 *
 * The keyword heuristics stay and are the fallback: an unreachable model, an
 * abort, a timeout or an unparseable answer all fall through to them. Having the
 * model is a way to be more accurate, not a way to stop working without it.
 */
const DEFAULT_SETTINGS = {
  autoCapture: true,
  autoJudge: false,
  nudge: true,
  minChars: PLAN_NUDGE_MIN_CHARS,
  minEntries: PLAN_NUDGE_MIN_MARKERS,
  maxTurnSessions: MAX_TURN_SESSIONS,
}

/**
 * One stored panel geometry, or `null` when nothing usable was written.
 *
 * Where the user parked the floating card is a PREFERENCE, not session state,
 * so it belongs beside the board rather than in the browser. `localStorage`
 * looked fine until the deployment moved between ports: storage is keyed by
 * ORIGIN, so `127.0.0.1:41012` and `127.0.0.1:25005` are different sites and
 * every restart looked like a first run.
 *
 * `w`/`h` may be `null` — that is the parked line, whose size is decided by CSS
 * (it hugs its own text), not by a stored number.
 */
function normalizeLayout(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
  const x = finite(raw.x)
  const y = finite(raw.y)
  if (x === null || y === null) return null
  const size = (value) => {
    const n = finite(value)
    return n !== null && n > 0 ? n : null
  }
  return { x, y, w: size(raw.w), h: size(raw.h) }
}
/** Bounds accepted by both the loader and the settings write path. */
const MIN_CHARS_RANGE = { min: 10, max: 10_000 }
const MIN_ENTRIES_RANGE = { min: 1, max: 100 }
/**
 * How many `newSession` containers one turn end may open.
 *
 * `MAX_TURN_SESSIONS` is the default; this is the range a user may set. The
 * lower bound is 1 because 0 would mean "never spawn", which is what mode
 * `remind` already expresses — two ways to say the same thing is one too many.
 * The upper bound is deliberately modest: this loop runs inside the
 * turn-stopping hook that the harness awaits, so a large value turns one turn
 * end into a long stall, and the queue is re-scanned after every spawn anyway.
 */
const MAX_TURN_SESSIONS_RANGE = { min: 1, max: 50 }

/**
 * Coerce one settings field into range, falling back to its default.
 *
 * Every field is independent: one bad value must not discard the ones the user
 * did get right, and a hand-edited `settings` object must never make the whole
 * board unreadable. Returns a fresh object; never mutates its input.
 */
function normalizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const clampInt = (value, range, fallback) =>
    Number.isInteger(value) && value >= range.min && value <= range.max ? value : fallback
  return {
    autoCapture:
      typeof source.autoCapture === 'boolean' ? source.autoCapture : DEFAULT_SETTINGS.autoCapture,
    autoJudge: typeof source.autoJudge === 'boolean' ? source.autoJudge : DEFAULT_SETTINGS.autoJudge,
    nudge: typeof source.nudge === 'boolean' ? source.nudge : DEFAULT_SETTINGS.nudge,
    minChars: clampInt(source.minChars, MIN_CHARS_RANGE, DEFAULT_SETTINGS.minChars),
    minEntries: clampInt(source.minEntries, MIN_ENTRIES_RANGE, DEFAULT_SETTINGS.minEntries),
    maxTurnSessions: clampInt(
      source.maxTurnSessions,
      MAX_TURN_SESSIONS_RANGE,
      DEFAULT_SETTINGS.maxTurnSessions,
    ),
  }
}
const MEDIA_TYPE_BY_EXTENSION = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}
const MEDIA_TYPES = Object.values(MEDIA_TYPE_BY_EXTENSION)

/**
 * The prompt a user can paste to make the model plan a long task onto the board.
 *
 * ONE definition, three places it is shown: the `/todo` command, the runtime
 * skill's body, and the README. A template that exists twice drifts, and the copy
 * a user pastes is the one nobody tests — so `tools/check-template-parity.mjs`
 * compares this string against the README's fenced block, exactly.
 *
 * It is written as instructions TO THE MODEL, because that is what gets injected.
 */
const PLAN_TEMPLATE = [
  '用 TODO 板把这件事拆成可执行的步骤，然后按顺序做。',
  '',
  '【目标】<一句话说清最终要什么>',
  '【边界】<不要做什么、必须遵守什么>',
  '【完成标准】<怎么算做完；能跑命令/看结果最好>',
  '',
  '拆分要求：',
  '1. 每条一句话、彼此有顺序、能独立验收；一条只交付一件事，别把两件事塞一条；',
  '2. 先给我看拆分结果，我确认后再写进板子；我说改就改；',
  '3. 每条待办的备注（note）里写清：验收标准 + 已知的坑/前置条件；',
  '4. 定好顺序后，用一次 action="add" 的 items 把整份计划写进去（一次审批），不要一条一条建。',
  '',
  '执行要求：',
  '5. 开始后每做完一条，立刻 action="done" 勾成「AI 已完成」，再取同目录下一条继续，不要停下来问我；',
  '6. 中途要加步骤就告诉我，别自己闷着改范围。',
  '',
  '（我没特别说的话：默认拆 3–8 步；建好后用 ask_user_question 问我「就按这个做（立刻开始）／只建清单不开始／我再改改」。）',
].join('\n')

/**
 * A row whose target session is gone stays pending (it is *not* stamped as
 * dispatched), so the scheduler and the turn-end hook would both keep picking
 * it. These bound that retry: the first re-attempt waits a minute, each further
 * failure doubles it, and a row that stays stuck settles at one attempt every
 * half hour instead of one every tick.
 */
const LOST_RETRY_BASE_MS = 60_000
const LOST_RETRY_MAX_MS = 30 * 60_000

// --------------------------------------------------------------- small utils

function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured
  return join(homedir(), '.dsh')
}

function boardFile() {
  return join(dshHome(), 'todo-board', 'board.json')
}

/** Case-insensitive, backslash-normalized directory key. */
function normalizeDir(dir) {
  if (typeof dir !== 'string' || dir === '') return ''
  let s = dir.replace(/\//g, '\\')
  while (s.length > 1 && s.endsWith('\\')) s = s.slice(0, -1)
  return s.toLowerCase()
}

/**
 * Keep only durable-shaped image references, so a corrupt or hand-edited board
 * can never smuggle an arbitrary object into a user message.
 */
function normalizeImages(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    if (typeof entry.attachmentId !== 'string' || entry.attachmentId === '') continue
    if (MEDIA_TYPES.indexOf(entry.mediaType) < 0) continue
    const ref = {
      attachmentId: entry.attachmentId,
      mediaType: entry.mediaType,
      bytes: typeof entry.bytes === 'number' ? entry.bytes : 0,
      width: typeof entry.width === 'number' ? entry.width : 0,
      height: typeof entry.height === 'number' ? entry.height : 0,
    }
    if (typeof entry.name === 'string' && entry.name !== '') ref.name = entry.name
    out.push(ref)
    if (out.length >= MAX_IMAGES_PER_TODO) break
  }
  return out
}

function dirLabel(dir) {
  if (typeof dir !== 'string' || dir === '') return '(未指定目录)'
  const parts = dir.split(/[\\/]/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : dir
}

/** Local `YYYY-MM-DDTHH:mm` for one epoch value — the board's schedule format. */
function formatLocal(ms) {
  const date = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return (
    date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    'T' + pad(date.getHours()) + ':' + pad(date.getMinutes())
  )
}

/**
 * Accept only a strict local `YYYY-MM-DDTHH:mm`, or an ISO string that carries
 * an explicit offset (`Z` / `±HH:MM`) which is folded into host local time.
 * Returns `''` for anything else, so a bad value clears the schedule instead of
 * silently arming a wrong instant.
 */
function normalizeSchedule(value) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (text === '') return ''
  const local = SCHEDULE_PATTERN.exec(text)
  if (local !== null) {
    const ms = new Date(
      Number(local[1]), Number(local[2]) - 1, Number(local[3]), Number(local[4]), Number(local[5]), 0, 0,
    ).getTime()
    return Number.isFinite(ms) && formatLocal(ms) === text ? text : ''
  }
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(text)) return ''
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? formatLocal(ms) : ''
}

/** Epoch ms of a stored schedule, or 0 when it is absent/unparseable. */
function scheduleMs(schedule) {
  const normalized = normalizeSchedule(schedule)
  return normalized === '' ? 0 : new Date(normalized).getTime()
}

/** Human-facing clock, e.g. `09:30` (today/tomorrow) or `09-12 09:30`. */
function scheduleLabel(schedule) {
  const ms = scheduleMs(schedule)
  if (ms === 0) return ''
  const pad = (n) => String(n).padStart(2, '0')
  const date = new Date(ms)
  const clock = pad(date.getHours()) + ':' + pad(date.getMinutes())
  const today = formatLocal(Date.now()).slice(0, 10)
  const day = formatLocal(ms).slice(0, 10)
  if (day === today) return clock
  if (day === formatLocal(Date.now() + 86400000).slice(0, 10)) return '明天 ' + clock
  return day.slice(5) + ' ' + clock
}

function errText(err) {
  if (err === undefined || err === null) return 'unknown error'
  if (typeof err === 'string') return err
  if (typeof err.message === 'string') return err.message
  return String(err)
}

function sendJson(response, status, payload) {
  try {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(payload))
  } catch (err) {
    /* the browser navigated away mid-request */
  }
}

async function readJsonBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  const parsed = JSON.parse(text)
  return parsed !== null && typeof parsed === 'object' ? parsed : {}
}

// ------------------------------------------------------------- request trust
//
// The harness fences its own `/api` channel against the two confused-deputy
// paths a browser opens against a local HTTP server — DNS rebinding, and a
// malicious page firing cross-site requests. That fence is registered PER
// CHANNEL (`dsh-client-connection` `register(owner, channel, ...)`), so a
// plugin route outside `/api` is not covered by it; ours is not. Restated here
// because this plugin owns a board that can spawn sessions and burn tokens, and
// (once the log view exists) a route that can return process-wide diagnostics.
//
// `Host` is the load-bearing check, and that is not an implementation detail:
// over plain HTTP a browser attaches neither `Origin` nor Fetch-Metadata to
// reads (images, navigations — those headers go only to trustworthy
// destinations), so an unmarked request may still be a rebound browser read,
// and `Host` is the one header rebinding cannot forge. The marker checks are
// the second half: they catch the cross-site request a rebound-name Host
// cannot.

/** Whether a WHATWG hostname names the local loopback authority. */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

/** Normalized URL of a `Host`-header authority, or undefined when unparsable. */
function parseAuthority(authority) {
  try {
    return new URL('http://' + authority)
  } catch (err) {
    return undefined
  }
}

/** Canonical `hostname[:port]` of a parsed authority, default ports stripped. */
function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL('https://' + entry).port
  return port === '' ? entryUrl.hostname : entryUrl.hostname + ':' + port
}

/**
 * Whether the request authority matches a declared trusted entry.
 *
 * Mirrors the harness rule: an entry carrying an explicit port matches that
 * exact authority, a port-less entry matches the hostname on any port (the
 * shape the CLI derives for LAN serving, where the port may be OS-assigned).
 */
function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/** One header by lowercased name, from Node's headers object or a Fetch Headers. */
function headerValue(headers, wanted) {
  if (headers === undefined || headers === null) return undefined
  if (typeof headers.get === 'function') {
    const got = headers.get(wanted)
    return typeof got === 'string' ? got : undefined
  }
  const found = headers[wanted]
  return typeof found === 'string' ? found : undefined
}

/**
 * Decide whether one request may reach a plugin route.
 *
 * @returns the HTTP status to refuse with, or `undefined` to allow — the same
 *   shape the harness uses, so both fences read alike.
 */
function requestRejection(request, trustedHosts) {
  const headers = request === undefined || request === null ? undefined : request.headers
  const host = headerValue(headers, 'host')
  if (host === undefined) return 403
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return 403
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return 403
  if (headerValue(headers, 'sec-fetch-site') === 'cross-site') return 403
  const origin = headerValue(headers, 'origin')
  if (origin === undefined) return undefined
  try {
    return new URL(origin).host === hostUrl.host ? undefined : 403
  } catch (err) {
    return 403
  }
}

// -------------------------------------------------------------- diagnostics
//
// Pure helpers for the developer log the panel can show behind a button. They
// live at module scope so the Node suite can exercise them directly — the
// formatting and redaction rules are the part worth testing, and neither needs
// a context.

const LOG_NAME = 'dsh-todo-board'
/** Numeric severity, matching cordis' own scale (lower is more severe). */
const LOG_LEVEL_NUMBER = { error: 0, info: 1, warn: 2, debug: 3 }
const LOG_LEVEL_BY_NUMBER = ['error', 'info', 'warn', 'debug']
/** Records kept in memory for the panel; the file keeps its own, larger tail. */
const LOG_RING_MAX = 500
/** One record's rendered detail is capped so a single dump cannot fill the ring. */
const LOG_DETAIL_MAX = 4000
const LOG_FILE_MAX_BYTES = 256 * 1024

function boardLogFile() {
  return join(dshHome(), 'todo-board', 'log.ndjson')
}

/** JSON that never throws on cycles or BigInt, unlike a bare `JSON.stringify`. */
function safeJson(value) {
  const seen = new WeakSet()
  try {
    return JSON.stringify(value, (key, entry) => {
      if (typeof entry === 'bigint') return String(entry)
      if (entry !== null && typeof entry === 'object') {
        if (seen.has(entry)) return '[circular]'
        seen.add(entry)
      }
      return entry
    }) ?? String(value)
  } catch (err) {
    return String(value)
  }
}

function describeValue(value) {
  if (value instanceof Error) return errorDetail(value)
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return String(value)
  if (typeof value === 'object') return safeJson(value)
  return String(value)
}

/**
 * Render an `Error` for a log line.
 *
 * `stack` first — a diagnostic log without a stack loses half its value. The
 * cause and own enumerable properties are folded in beside it: cordis delivers
 * a non-`Error` `cause` as its OWN record (verified), and on its own that
 * record is an unattributed object dump, so naming it here is what makes the
 * pair readable.
 */
function errorDetail(err) {
  const head = typeof err.stack === 'string' && err.stack !== '' ? err.stack : String(err.message ?? err)
  const extra = []
  if (err.cause !== undefined && err.cause !== null) extra.push('cause=' + describeValue(err.cause))
  for (const key of Object.keys(err)) extra.push(key + '=' + describeValue(err[key]))
  return extra.length === 0 ? head : head + '\n  (' + extra.join(', ') + ')'
}

/**
 * Format raw logger arguments into one readable line.
 *
 * Required because `Message.args` is UNFORMATTED (verified: `%s`/`%d`/`%o`
 * arrive verbatim) and cordis' own `Logger.format` is a static method on the
 * `Logger` class, which a plugin cannot reach — `LoggerService` exposes no
 * formatter. So this reproduces the parts that matter, and nothing else.
 */
function formatLogArgs(args) {
  const list = Array.isArray(args) ? args.slice() : []
  if (list.length === 0) return ''
  if (list[0] instanceof Error) {
    list[0] = errorDetail(list[0])
    list.unshift('%s')
  } else if (typeof list[0] !== 'string') {
    // A bare object/`Error`-free first argument would otherwise be lost.
    list.unshift('%o')
  }
  let format = String(list.shift())
  format = format.replace(/%([a-zA-Z%])/g, (match, char) => {
    if (match === '%%') return '%'
    if (list.length === 0) return match
    const value = list.shift()
    if (char === 's') return String(value)
    if (char === 'd' || char === 'i') return String(Math.trunc(Number(value)))
    if (char === 'f') return String(Number(value))
    if (char === 'o' || char === 'O') return safeJson(value)
    // `%c`/`%C` are colour directives: they carry no text.
    if (char === 'c' || char === 'C') return ''
    return match
  })
  for (const value of list) format += ' ' + describeValue(value)
  return format
}

/**
 * Mask credentials before a line is stored or shown. **Load-bearing, not
 * hardening** — see `docs/design-log-view.md` §3.2, where four leak paths were
 * reproduced. The lesson from that spike is that a leaked key never arrives
 * from a careless `logger.warn(secret)`: it arrives inside a message someone
 * else composed, usually an `Error.message` from a config-validation failure,
 * so this must run on EVERY record's write path rather than once per error.
 *
 * Coverage is deliberately stated rather than implied:
 *   * known credential shapes (`sk-`, GitHub, npm, bearer);
 *   * values under a secret-looking KEY in a JSON dump — this is the
 *     `dsh-mcp-client` union case, which dumps the whole config including
 *     `env` and `headers`;
 *   * `key: value` pairs in plain text;
 *   * schemastery's "value position" echoes (`credential ref "…"`, `but got …`),
 *     which carry whatever the user pasted and therefore need no prefix at all —
 *     `ctx7sk-…` is the reproduced example.
 *
 * NOT covered, and worth knowing: a secret with no recognizable prefix sitting
 * under a non-secret-looking key in a JSON dump. The set of leak shapes is
 * concrete and enumerable rather than "all logs are dangerous", and this is the
 * edge that stays open.
 */
function redact(text) {
  let out = typeof text === 'string' ? text : String(text)
  try {
    out = out.split(homedir()).join('~')
  } catch (err) {
    /* no home directory to collapse */
  }
  return (
    out
      // Control characters would let a logged payload forge extra visual lines
      // in the panel. Newlines and tabs are kept: they carry stack traces, and
      // this file is NDJSON, so a newline inside a value is escaped by
      // `JSON.stringify` and can never become a real record separator.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
      .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, 'gh*_***')
      .replace(/\bnpm_[A-Za-z0-9]{16,}/g, 'npm_***')
      // The value class excludes quotes: `Authorization":"Bearer sk-…"` must
      // keep its closing quote, or the surrounding JSON stops parsing and the
      // dump we kept for diagnosis becomes unreadable.
      .replace(/\bbearer\s+[^\s"']+/gi, 'Bearer ***')
      // This MUST run before the generic `key: value` rule below. That rule
      // treats `credential` as a key and then eats the very next token — which
      // here is the word `ref`, leaving the quoted secret untouched. Caught by
      // the redaction test rather than by review.
      .replace(/(credential ref\s+)"[^"]*"/gi, '$1"***"')
      .replace(
        /("(?:[A-Za-z0-9_-]*(?:token|secret|key|password|authorization|credential)[A-Za-z0-9_-]*)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
        '$1"***"',
      )
      .replace(
        // Requires a real ASSIGNMENT separator (`:` or `=`), never bare
        // whitespace. The reference implementation accepts any whitespace,
        // which turns ordinary diagnostics into mush: `apiKey expected string
        // but got X` becomes `apiKey ***string but got X`, losing the sentence
        // that made the record worth keeping. Caught by the redaction test.
        /((?:authorization|token|apikey|api-key|password|secret|credential)\b["']?\s*[:=]\s*)("(?:[^"]*)"|'(?:[^']*)'|[^\s,;)}\]]+)/gi,
        // Quote characters are preserved in the replacement. A log line is not
        // parsed, but a mangled dump is harder to read than a masked one, and
        // the whole point of keeping the dump is that a person reads it.
        (match, prefix, value) =>
          prefix + (value.startsWith('"') ? '"***"' : value.startsWith("'") ? "'***'" : '***'),
      )
      // schemastery echoes the received value here, which can be an arbitrary
      // user-pasted string (the reproduced `Config(SECRET)` bare-scalar case).
      // Two constraints learned from the actual output rather than from review,
      // both about not destroying the record we are trying to make safe:
      //   * the lookahead keeps the diagnostic value of the common non-secret
      //     answers (`[object Object]`, type words, numbers);
      //   * the value must not START with JSON punctuation, or the whole config
      //     dump behind it is swallowed and `dsh-mcp-client`'s union failure —
      //     the case worth diagnosing — becomes one unreadable `***`.
      .replace(
        /\bbut got\s+(?![\[{"'])(?!\[object Object\]|undefined|null|true\b|false\b|-?\d)[^\s,;)}\]]+/gi,
        'but got ***',
      )
  )
}

/** Clamp one rendered detail, marking that it was cut. */
function clampDetail(text) {
  return text.length > LOG_DETAIL_MAX ? text.slice(0, LOG_DETAIL_MAX) + '…(截断)' : text
}

/** The panel's record shape for one captured log message. */
function logRecord(message, detail) {
  const type = typeof message.type === 'string' ? message.type : LOG_LEVEL_BY_NUMBER[message.level] ?? 'info'
  let source = ''
  try {
    const fiber = message.fiber === undefined || message.fiber === null ? undefined : message.fiber.deref()
    const runtimeName = fiber === undefined || fiber === null ? undefined : fiber.runtime?.name
    if (typeof runtimeName === 'string') source = runtimeName
  } catch (err) {
    /* a dead fiber reference just means no attribution */
  }
  return {
    sn: message.sn,
    ts: message.ts,
    level: type,
    source,
    logger: typeof message.name === 'string' ? message.name : '',
    detail: clampDetail(redact(detail)),
  }
}

// ------------------------------------------------------------- tool schemas
// Raw JSON Schema (not the author-facing `defineTool` spec), because a
// profile-installed plugin cannot import `@deepseek-ai/dsh-tools`.

const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'add', 'done', 'reopen', 'note', 'schedule', 'update', 'reorder', 'dispatch'],
      description: '要执行的操作。',
    },
    title: { type: 'string', description: 'add 时的待办内容（一句话）；update 时改标题。' },
    id: { type: 'string', description: 'done / reopen / note / schedule / update / dispatch 时的待办 id。' },
    dir: {
      type: 'string',
      description: 'list / add 时的目标目录，update 时改目录；省略则使用当前会话的工作目录。',
    },
    mode: {
      type: 'string',
      enum: MODES,
      description:
        'add / update 时的执行模式：remind=只提醒，resume=AI 停下后自动在同一会话续跑，newSession=自动新开会话执行。add 时默认 remind。',
    },
    note: { type: 'string', description: 'add / note 时的备注文本；update 时同样改备注（空字符串即清空）。' },
    items: {
      type: 'array',
      description:
        'add 时一次创建多条（**拆分长任务/多阶段任务时用这个**）：一次调用、一次审批就写入整份计划，' +
        '顺序即数组顺序。每条可带自己的 title / note / mode / schedule / images / parent；' +
        'parent 填本批次里更靠前那条的下标，用来把后续步骤挂到某个「自动新会话」条目下，' +
        '让它们跟着进入那个新会话。给 items 时外层的 title 等字段被忽略，dir 仍然生效。最多 ' +
        MAX_PLAN_ITEMS + ' 条，**任意一条不合法则整批不写入**。',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: '这一条待办的内容（一句话，可独立验收）。' },
          note: {
            type: 'string',
            description: '这一条的备注：写给执行会话的上下文，建议写清验收标准与前置条件。',
          },
          mode: { type: 'string', enum: MODES, description: '这一条的执行模式，默认 remind。' },
          parent: {
            type: 'number',
            description:
              '可选：挂到本批次里更靠前的那一条下面，填它的下标（0 起）。父条目是「自动新会话」时，' +
              '它会在父条目开出的新会话里执行；父条目是别的模式时，只作为分组，子条目仍留在当前会话。' +
              '只能指向前面的条目，不能指向自己或后面的条目。',
          },
          schedule: {
            type: 'string',
            description: '这一条的定时执行时间（本地 YYYY-MM-DDTHH:mm），不填即不定时。',
          },
          images: {
            type: 'array',
            items: { type: 'string' },
            description: '这一条的图片：主机上图片文件的绝对路径，最多 ' + MAX_IMAGES_PER_TODO + ' 张。',
          },
        },
        required: ['title'],
      },
    },
    ids: {
      type: 'array',
      items: { type: 'string' },
      description:
        'reorder 时新的从上到下顺序（待办 id 数组）。只接受同一个目录内的待办；未列出的待办保持原有相对顺序跟在后面。',
    },
    schedule: {
      type: 'string',
      description:
        'add / schedule 时的定时执行时间，本地时间格式 YYYY-MM-DDTHH:mm（也接受带偏移量的 ISO 8601）。到点后该待办才可被派发；空字符串表示取消定时。',
    },
    all: { type: 'boolean', description: 'list 时是否列出所有目录的待办，默认 false。' },
    images: {
      type: 'array',
      items: { type: 'string' },
      description:
        'add 时的图片：每项是主机上的图片文件绝对路径（png / jpg / webp / gif）。最多 ' +
        MAX_IMAGES_PER_TODO + ' 张；文件会被存进附件库，派发时作为真正的图片一起发给模型。',
    },
  },
  required: ['action'],
}

const TOOL_STATES = ['pending', 'dispatched', 'running', 'done', 'lost']
/** Human-facing names for the same states, used in the list readout. */
const STATE_LABEL = {
  pending: '未派发',
  dispatched: '已派发',
  running: '进行中',
  done: '已完成',
  lost: '目标会话丢失',
}

const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message: { type: 'string' },
    todos: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          dirLabel: { type: 'string' },
          mode: { type: 'string', enum: MODES },
          schedule: { type: 'string' },
          imageCount: { type: 'number' },
          aiDone: { type: 'boolean' },
          verified: { type: 'boolean' },
          state: { type: 'string', enum: TOOL_STATES },
          // Where this row runs. `after` names a container row, so the model can
          // see the tree it just built — and see which container to flip later.
          parentId: { type: 'string' },
        },
        required: [
          'id', 'title', 'dirLabel', 'mode', 'schedule', 'imageCount', 'aiDone', 'verified', 'state',
          'parentId',
        ],
      },
    },
  },
  required: ['message', 'todos'],
}

// -------------------------------------------------------------------- plugin

export function apply(ctx) {
  const board = { version: 1, seq: 0, todos: [], settings: { ...DEFAULT_SETTINGS }, layout: null }
  let storageError = ''

  // ------------------------------------------------------------ log storage
  //
  // The built-in `ctx.logger.buffer` CANNOT be the source here: cordis
  // registers its buffer exporter without a `levels` map, so the gate falls
  // back to `INFO` and every `warn`/`debug` is dropped before it is stored
  // (verified against `cordis/src/logger.ts:213-221` and `:155`). That is
  // exactly the level where this plugin's dispatch failures live, so the ring
  // is fed by our own exporter instead.
  //
  // Only ONE exporter is ever registered, and it is never removed by hand: the
  // disposer `ctx.logger.exporter()` returns is buggy when two exporters exist
  // (`:232-237` deletes `this._snExporter`, the LATEST id, not the one it
  // captured), so removal rides the fiber teardown instead — the path that was
  // verified correct.

  /** Newest-last records for the panel; `sn` is the process-wide cursor. */
  const logRing = []
  let logDropped = 0
  /** Highest `sn` seen, so the panel can ask for "everything after this". */
  let logSeq = 0
  /** Newest error/warn, for the button dot the panel shows without opening the view. */
  let logAlertSn = 0
  let logAlertAt = 0
  /** Set once writing the file has failed (read-only or full disk). */
  let logFileOff = false
  let logFileBytes = 0
  let logWriteError = ''

  function logLine(record) {
    return (
      JSON.stringify({
        ts: record.ts,
        level: record.level,
        source: record.source,
        logger: record.logger,
        detail: record.detail,
      }) + '\n'
    )
  }

  /**
   * Rewrite the log file keeping its newest half.
   *
   * Called after an append crosses the ceiling, never only on mount: a
   * long-lived process that trims once still grows without bound (the
   * reference implementation measured 3.2 MB after 20k events).
   */
  function trimLogFile(file) {
    const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line !== '')
    const kept = []
    let bytes = 0
    for (let i = lines.length - 1; i >= 0 && bytes <= LOG_FILE_MAX_BYTES / 2; i--) {
      kept.unshift(lines[i] + '\n')
      bytes += lines[i].length + 1
    }
    writeFileSync(file, kept.join(''), { encoding: 'utf8', mode: 0o600 })
    logFileBytes = bytes
  }

  /**
   * Append one record, or stop trying.
   *
   * A write failure disables persistence for the rest of the process but leaves
   * the in-memory log working — one bad write must not break every later
   * record, and a read-only disk is a reason to lose the file, not the view.
   */
  function persistLog(record) {
    if (logFileOff) return
    try {
      const file = boardLogFile()
      mkdirSync(dirname(file), { recursive: true })
      const line = logLine(record)
      // `mode` only applies when the file is created, so a fresh file gets
      // 0o600: this log can carry another plugin's error context.
      appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 })
      logFileBytes += Buffer.byteLength(line)
      if (logFileBytes > LOG_FILE_MAX_BYTES) trimLogFile(file)
      logWriteError = ''
    } catch (err) {
      logFileOff = true
      logWriteError = errText(err)
    }
  }

  function captureLog(message, detail) {
    const record = logRecord(message, detail)
    logRing.push(record)
    if (logRing.length > LOG_RING_MAX) {
      logRing.splice(0, logRing.length - LOG_RING_MAX)
      logDropped += 1
    }
    if (typeof record.sn === 'number' && record.sn > logSeq) logSeq = record.sn
    // `warn` counts as an alert too: this plugin's own "parked a todo" lines are
    // warnings, and a silently parked todo is exactly what the dot is for.
    if (record.level === 'error' || record.level === 'warn') {
      logAlertSn = record.sn
      logAlertAt = record.ts
    }
    persistLog(record)
  }

  /**
   * Write one line of our own, through the normal logger path.
   *
   * Going through `ctx.logger` rather than the sink directly keeps a single
   * funnel: these lines are formatted and redacted exactly like captured ones,
   * and they still reach the console exporter.
   */
  function log(level, text, err) {
    try {
      const logger = ctx.logger
      if (logger === undefined || typeof logger[level] !== 'function') return
      if (err === undefined) logger[level](text)
      else logger[level](text + '：' + errText(err))
    } catch (failure) {
      /* logging must never break the caller */
    }
  }

  ctx.logger?.exporter?.({
    // Our own lines at every level; everything else at `error` only. This is
    // the "own plugin only" default: the reproduced leak paths all live in
    // OTHER plugins' config-validation errors, so the narrower scope keeps the
    // blast radius small — and `default: 0` is a scope choice, not a safety
    // boundary, since a leak on the error path still arrives here.
    levels: { [LOG_NAME]: LOG_LEVEL_NUMBER.debug, default: LOG_LEVEL_NUMBER.error },
    export: (message) => {
      try {
        captureLog(message, formatLogArgs(message.args))
      } catch (err) {
        /* a broken record must not break the logger */
      }
    },
  })

  // Restore the byte count from a previous process, and trim an oversized file
  // once at mount so a log that grew while nothing was watching is bounded
  // before the first new line lands.
  try {
    const file = boardLogFile()
    if (existsSync(file)) {
      logFileBytes = statSync(file).size
      if (logFileBytes > LOG_FILE_MAX_BYTES) trimLogFile(file)
    }
  } catch (err) {
    logFileOff = true
    logWriteError = errText(err)
  }

  // ---------------------------------------------------------------- records

  function touch(todo) {
    todo.updatedAt = Date.now()
  }

  /**
   * Drop the stuck marker, so the row is queue-eligible again the moment it
   * really has somewhere to land. Called on every successful dispatch and on
   * every user action that re-targets the row.
   */
  function clearLost(todo) {
    todo.lostAt = 0
    todo.lostKind = ''
    todo.lostReason = ''
    todo.lostAttempts = 0
  }

  /**
   * Record a dispatch that could not be delivered, and pace the next attempt.
   *
   * Every failure path must go through here. A failed row that keeps neither a
   * `dispatchedAt` nor a `lostAt` stamp stays permanently "due", and
   * `armTimer` → `fireDue` → `.finally(armTimer)` then re-enters through
   * microtasks alone: the retry loop never yields, the event loop never runs,
   * and the host freezes. The backoff is what makes the retry terminate.
   *
   * `kind` is machine-readable (`no-session` / `image` / `spawn` / `preset` /
   * `agents`), so the panel can name the actual problem: an image refusal is not
   * a missing session, even though both park the row the same way.
   */
  function markLost(todo, kind, reason) {
    const previous = todo.lostAt
    todo.lostAt = Date.now()
    todo.lostKind = kind
    todo.lostReason = reason
    // Consecutive failures back off; an earlier, unrelated recovery resets it.
    todo.lostAttempts = previous === 0 ? 1 : todo.lostAttempts + 1
    touch(todo)
    afterChange()
    // Logged here rather than at each call site: this is the single funnel every
    // dispatch failure passes through, so nothing can be parked invisibly. The
    // row already carries the reason for the panel; what the log adds is the
    // context the row has no room for — which directory, which target session,
    // and how many attempts this has taken.
    const level = kind === 'no-session' || kind === 'image' ? 'warn' : 'error'
    log(
      level,
      'todo-board: 派发失败[' + kind + '] id=' + todo.id +
        ' 目录=' + (todo.dirPath || '(未指定)') +
        ' 模式=' + todo.mode +
        ' 目标会话=' + (todo.runSessionId || todo.sourceSessionId || '(无)') +
        ' 第 ' + todo.lostAttempts + ' 次' +
        ' 原因=' + reason,
    )
  }

  /**
   * Which session runs a row.
   *
   * `session` names a live session outright; an empty id is legitimate and
   * means 「no owner yet」 — a row planned outside any session carries it.
   *
   * `after` names a CONTAINER row and deliberately stores no resolved target.
   * The target is resolved at dispatch time by {@link effectiveTarget}, so
   * flipping a container's mode — the remind planning state becoming
   * newSession — moves its children along with zero cascade rewrites. Storing
   * a resolved target instead would turn every later mode edit, cross-box drag
   * and reparent into a correctness risk in exactly the one place that cannot
   * see the whole subtree.
   *
   * @param raw - the persisted `runIn`, if any.
   * @param sourceSessionId - the row's planner, used only to migrate.
   * @returns A detached, well-formed ownership record.
   */
  function normalizeRunIn(raw, sourceSessionId) {
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      const id = typeof raw.id === 'string' ? raw.id : ''
      if (raw.kind === 'after' && id !== '') return { kind: 'after', id }
      if (raw.kind === 'session') return { kind: 'session', id }
    }
    // Forward migration: a row written before ownership existed ran in the
    // session that planned it. Deriving that here keeps an old board file
    // honest instead of leaving every legacy row unowned. A row that already
    // carries a well-formed `runIn` never reaches this fallback.
    return { kind: 'session', id: sourceSessionId }
  }

  function normalize(raw) {
    if (raw === null || typeof raw !== 'object') return null
    const title = typeof raw.title === 'string' ? raw.title : ''
    if (title === '') return null
    const dirPath =
      typeof raw.dirPath === 'string' ? raw.dirPath : typeof raw.dir === 'string' ? raw.dir : ''
    const sourceSessionId = typeof raw.sourceSessionId === 'string' ? raw.sourceSessionId : ''
    return {
      id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : randomUUID(),
      title,
      dir: normalizeDir(dirPath),
      dirPath,
      mode: MODES.indexOf(raw.mode) >= 0 ? raw.mode : 'remind',
      aiDone: raw.aiDone === true,
      verified: raw.verified === true,
      note: typeof raw.note === 'string' ? raw.note : '',
      images: normalizeImages(raw.images),
      schedule: normalizeSchedule(raw.schedule),
      remindedAt: typeof raw.remindedAt === 'number' ? raw.remindedAt : 0,
      order: typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : -1,
      sourceSessionId,
      runIn: normalizeRunIn(raw.runIn, sourceSessionId),
      sourceSessionTitle: typeof raw.sourceSessionTitle === 'string' ? raw.sourceSessionTitle : '',
      // Where in the source conversation this row came from, so the panel can put
      // the user back at the exact turn that raised the question. `seq` is the
      // session-log offset of the `user/message` event; `turn` is the agent turn
      // number, kept as a human-readable fallback because a seq alone is useless
      // once a log has been compacted or forked.
      sourceSeq: typeof raw.sourceSeq === 'number' && Number.isFinite(raw.sourceSeq) ? raw.sourceSeq : 0,
      sourceTurn:
        typeof raw.sourceTurn === 'number' && Number.isFinite(raw.sourceTurn) ? raw.sourceTurn : 0,
      // True for rows this plugin wrote by itself. The panel shows it as a chip
      // and the auto-capture engine uses it to skip rows it already created.
      autoCaptured: raw.autoCaptured === true,
      dispatchedAt: typeof raw.dispatchedAt === 'number' ? raw.dispatchedAt : 0,
      lostAt: typeof raw.lostAt === 'number' ? raw.lostAt : 0,
      lostKind: typeof raw.lostKind === 'string' ? raw.lostKind : '',
      lostReason: typeof raw.lostReason === 'string' ? raw.lostReason : '',
      lostAttempts: typeof raw.lostAttempts === 'number' ? raw.lostAttempts : 0,
      runSessionId: typeof raw.runSessionId === 'string' ? raw.runSessionId : '',
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
    }
  }

  function renumber() {
    for (let i = 0; i < board.todos.length; i++) board.todos[i].order = i
  }

  function nextOrder() {
    let max = -1
    for (const todo of board.todos) if (todo.order > max) max = todo.order
    return max + 1
  }

  function find(id) {
    for (const todo of board.todos) if (todo.id === id) return todo
    return undefined
  }

  /**
   * The session that will actually run a row, resolving container ownership.
   *
   * `runIn.kind === 'session'` answers outright. `runIn.kind === 'after'`
   * names a container, and what the answer IS depends on what that container
   * does:
   *
   *   - a `newSession` container opens its own future session, so its children
   *     belong to that session — this is the chain's handoff;
   *   - any other container creates no session. A `remind` container is the
   *     planning state (the shape is settled, nothing runs yet), and a
   *     `resume` row is only grouping. Both simply inherit where the
   *     container itself runs, so they can never orphan their children.
   *
   * Resolving here rather than at write time is the whole point: flipping a
   * container from `remind` to `newSession` moves its entire subtree with no
   * cascade, because no resolved target was ever written down.
   *
   * A container that has not spawned yet answers '' — its children are not
   * eligible anywhere until it does, which is correct rather than pending.
   *
   * @param todo - the row to resolve.
   * @param seen - visited ids, for cycle detection.
   * @param depth - remaining walk budget.
   * @returns The owning session id, or '' when there is none yet.
   */
  /**
 * Whether making `todo` a child of `parentId` would put it inside its own
 * subtree.
 *
 * The walk mirrors {@link effectiveTarget}'s bound: a visited set for direct
 * knots and a depth cap for the deep-but-legal chains. This is checked at the
 * moment of the edit rather than at dispatch, because a cycle the panel lets
 * you build is one the user only discovers when nothing runs.
 */
function wouldCycle(todo, parentId) {
  const guard = new Set([todo.id])
  let cursor = parentId
  for (let depth = 0; depth <= MAX_OWNER_DEPTH; depth++) {
    if (cursor === todo.id) return true
    if (guard.has(cursor)) return false
    guard.add(cursor)
    const parent = find(cursor)
    if (parent === undefined || parent.runIn.kind !== 'after') return false
    cursor = parent.runIn.id
  }
  return true
}

  function effectiveTarget(todo, seen, depth) {
    const guard = seen === undefined ? new Set() : seen
    const level = depth === undefined ? 0 : depth
    if (guard.has(todo.id) || level > MAX_OWNER_DEPTH) return ''
    guard.add(todo.id)
    if (todo.runIn.kind === 'session') return todo.runIn.id
    const parent = find(todo.runIn.id)
    // A container that no longer exists leaves the row with no owner rather
    // than silently reattaching it to whoever happens to be running.
    if (parent === undefined) return ''
    if (parent.mode === 'newSession') {
      return parent.runSessionId !== ''
        ? parent.runSessionId
        : effectiveTarget(parent, guard, level + 1)
    }
    return effectiveTarget(parent, guard, level + 1)
  }

  /**
   * Live sessions by id, with the status that tells 「已派发」 from 「进行中」.
   * Built once per snapshot rather than once per row.
   */
  function liveSessions() {
    const map = new Map()
    const agents = ctx.get('agents')
    if (agents === undefined) return map
    for (const agent of agents.list()) {
      map.set(agent.id, typeof agent.status === 'string' ? agent.status : 'idle')
    }
    return map
  }

  /**
   * The session a row would be handed to right now — mirrors `dispatch`.
   *
   * A row that has already run once still reports where it ran, so the panel can
   * show 「已派发」 against a live session. Before it has run, the answer is its
   * resolved owner — which is NOT always the planner, once the row has been
   * re-parented or its container has spawned.
   */
  function targetSessionId(todo) {
    if (todo.mode === 'newSession') return todo.runSessionId
    if (todo.runSessionId !== '') return todo.runSessionId
    return effectiveTarget(todo)
  }

  /**
   * A row's lifecycle, derived on the spot rather than stored: a persisted state
   * field could drift from the stamps it is supposed to describe, and 「进行中」
   * depends on live agent status, which no file can hold.
   *
   *   pending    未派发 — never handed to a session
   *   dispatched 已派发 — handed over, target still alive but idle
   *   running    进行中 — handed over, target is working right now
   *   done       已完成 — AI finished (or the user verified it)
   *   lost       目标会话丢失 — dispatch found nowhere to land
   *
   * `done` outranks `lost`: a row someone has already ticked off is finished,
   * whatever became of the session it was headed for.
   */
  function todoState(todo, live) {
    if (todo.verified || todo.aiDone) return 'done'
    if (todo.lostAt > 0) return 'lost'
    if (todo.dispatchedAt > 0) {
      const target = targetSessionId(todo)
      if (target !== '' && live.get(target) === 'running') return 'running'
      return 'dispatched'
    }
    return 'pending'
  }

  /** Panel record: full detail. Never used as a Tool return value. */
  function plain(todo, live) {
    const sessions = live === undefined ? liveSessions() : live
    const target = targetSessionId(todo)
    return {
      id: todo.id,
      title: todo.title,
      dir: todo.dir,
      dirPath: todo.dirPath,
      dirLabel: dirLabel(todo.dirPath || todo.dir),
      mode: todo.mode,
      aiDone: todo.aiDone === true,
      verified: todo.verified === true,
      note: todo.note,
      images: todo.images.map((image) => ({ ...image })),
      schedule: todo.schedule,
      dueAt: scheduleMs(todo.schedule),
      remindedAt: todo.remindedAt,
      order: todo.order,
      sourceSessionId: todo.sourceSessionId,
      runIn: { kind: todo.runIn.kind, id: todo.runIn.id },
      // Where the row runs (or has run): a spawned container and a dispatched
      // row report their runSessionId so the session that executes them owns
      // them on the panel. Before a newSession container has spawned the
      // answer is '' (nowhere yet), so fall back to the container walk — the
      // planning session keeps the row until the session it opens exists.
      // pendingOwned/dispatch keep effectiveTarget directly.
      ownerSessionId: target !== '' ? target : effectiveTarget(todo),
      sourceSessionTitle: todo.sourceSessionTitle,
      sourceSeq: todo.sourceSeq,
      sourceTurn: todo.sourceTurn,
      autoCaptured: todo.autoCaptured === true,
      dispatchedAt: todo.dispatchedAt,
      lostAt: todo.lostAt,
      lostKind: todo.lostKind,
      lostReason: todo.lostReason,
      lostAttempts: todo.lostAttempts,
      state: todoState(todo, sessions),
      targetAlive: target !== '' && sessions.has(target),
      runSessionId: todo.runSessionId,
      createdAt: todo.createdAt,
      updatedAt: todo.updatedAt,
    }
  }

  /** Exactly TOOL_OUTPUT_SCHEMA's item shape. */
  function toolTodo(todo, live) {
    const sessions = live === undefined ? liveSessions() : live
    return {
      id: todo.id,
      title: todo.title,
      dirLabel: dirLabel(todo.dirPath || todo.dir),
      mode: todo.mode,
      schedule: todo.schedule,
      imageCount: todo.images.length,
      aiDone: todo.aiDone === true,
      verified: todo.verified === true,
      state: todoState(todo, sessions),
      // Flattened on purpose: the model reads this far more often than the panel
      // does, and `''` is the honest answer for a row that hangs off nothing.
      parentId: todo.runIn.kind === 'after' ? todo.runIn.id : '',
    }
  }

  // ------------------------------------------------------------ persistence

  function load() {
    try {
      const file = boardFile()
      if (!existsSync(file)) {
        save()
        return
      }
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.todos)) {
        log('error', 'todo-board: 待办文件结构不对，已忽略其内容：' + file)
        return
      }
      const kept = []
      for (const raw of parsed.todos) {
        const todo = normalize(raw)
        if (todo !== null) kept.push(todo)
      }
      if (kept.length !== parsed.todos.length) {
        log(
          'warn',
          'todo-board: 读取待办时跳过了 ' + (parsed.todos.length - kept.length) +
            ' 条无法解析的记录（共 ' + parsed.todos.length + ' 条）',
        )
      }
      // Legacy rows carry order -1: fall back to creation order, then densify.
      kept.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
      board.todos = kept
      renumber()
      board.seq = typeof parsed.seq === 'number' ? parsed.seq : kept.length
      // Settings arrived after the first boards were written, so an older file
      // simply has no `settings` key — that is a DEFAULT, not an error. A
      // hand-edited or corrupt one degrades per field (see normalizeSettings):
      // one bad number must never cost the user their whole board.
      board.settings = normalizeSettings(parsed.settings)
      // Absent for a board written before the panel had host-side geometry,
      // and that is a DEFAULT (no preference yet), not an error.
      board.layout = normalizeLayout(parsed.layout)
      storageError = ''
    } catch (err) {
      storageError = '读取待办文件失败：' + errText(err)
      log('error', 'todo-board: 读取待办文件失败：' + boardFile(), err)
    }
  }

  function save() {
    try {
      const file = boardFile()
      mkdirSync(dirname(file), { recursive: true })
      const tmp = file + '.tmp'
      writeFileSync(tmp, JSON.stringify(board, null, 2), 'utf8')
      renameSync(tmp, file)
      storageError = ''
    } catch (err) {
      storageError = '写入待办文件失败：' + errText(err)
      log('error', 'todo-board: 写入待办文件失败：' + boardFile(), err)
    }
  }

  load()

  // ------------------------------------------------------------- scheduling
  //
  // A scheduled todo becomes eligible only at its local wall-clock minute. One
  // self-rearming timer tracks the nearest target; a coarse tick beside it
  // catches timers a suspended machine never delivered. Both paths are
  // idempotent through `dispatchedAt` / `remindedAt`.

  let scheduleTimer
  let scheduleTick
  /** Ids whose dispatch is in flight — a second tick must not send them twice. */
  const firing = new Set()

  /**
   * A stuck row keeps its place in the queue, so both schedulers would pick it
   * again the moment they look. This is what paces those retries: the first
   * re-attempt waits a minute, each further failure doubles the wait, and a row
   * that never recovers settles at one attempt per half hour. Manual ▶ ignores
   * this on purpose — a person clicking the button means 「try right now」.
   */
  function lostRetryReady(todo, now) {
    if (todo.lostAt === 0) return true
    const attempts = todo.lostAttempts > 0 ? todo.lostAttempts : 1
    const delay = Math.min(LOST_RETRY_BASE_MS * Math.pow(2, attempts - 1), LOST_RETRY_MAX_MS)
    return now - todo.lostAt >= delay
  }

  /** Pending todo whose scheduled minute has arrived, earliest first. */
  function nextDue(now) {
    let best
    let bestMs = 0
    for (const todo of board.todos) {
      if (todo.verified || todo.aiDone) continue
      // A dispatch already on its way is not due again: its state stamp lands
      // only when it completes, so without this the timer would re-enter it.
      if (firing.has(todo.id)) continue
      const ms = scheduleMs(todo.schedule)
      if (ms === 0 || ms > now) continue
      if (todo.dispatchedAt > 0 || todo.remindedAt > 0) continue
      if (!lostRetryReady(todo, now)) continue
      if (best === undefined || ms < bestMs) {
        best = todo
        bestMs = ms
      }
    }
    return best
  }

  /** Earliest pending schedule strictly in the future; 0 when none is set. */
  function nextFuture(now) {
    let soonest = 0
    for (const todo of board.todos) {
      if (todo.verified || todo.aiDone) continue
      const ms = scheduleMs(todo.schedule)
      if (ms <= now) continue
      if (soonest === 0 || ms < soonest) soonest = ms
    }
    return soonest
  }

  /** Point the exact timer at the nearest target, or at the next check when none is set. */
  function armTimer() {
    if (scheduleTimer !== undefined) {
      clearTimeout(scheduleTimer)
      scheduleTimer = undefined
    }
    const now = Date.now()
    if (nextDue(now) !== undefined) {
      fireDue()
      return
    }
    const soonest = nextFuture(now)
    scheduleTimer = setTimeout(
      () => {
        scheduleTimer = undefined
        fireDue()
      },
      soonest === 0 ? SCHEDULE_TICK_MS : Math.max(250, soonest - now),
    )
    // Never hold the host process open on this timer alone.
    if (typeof scheduleTimer.unref === 'function') scheduleTimer.unref()
  }

  /**
   * Dispatch every todo whose time has come.
   *
   * `remind` never wakes the model: it only stamps the reminder so the panel can
   * surface it. The other two modes reuse the manual dispatch path, so a
   * scheduled task lands exactly where the ▶ button would send it.
   *
   * The destination is the row's RESOLVED owner, not the session that planned
   * it. Once a chain has been handed to a fresh session, a scheduled row in
   * that chain belongs where the rest of it went; sending it back to the
   * planner would be the one route that contradicted the handoff.
   */
  function fireDue() {
    for (let todo = nextDue(Date.now()); todo !== undefined; todo = nextDue(Date.now())) {
      if (firing.has(todo.id)) break
      if (todo.mode === 'remind') {
        todo.remindedAt = Date.now()
        touch(todo)
        save()
        continue
      }
      firing.add(todo.id)
      void dispatch(todo, effectiveTarget(todo))
        .catch((err) => {
          log('error', 'todo-board: 定时派发失败（id=' + todo.id + '）', err)
        })
        .finally(() => {
          firing.delete(todo.id)
          armTimer()
        })
    }
    armTimer()
  }

  /** Any board mutation may have moved a target, so every write re-arms. */
  function afterChange() {
    save()
    armTimer()
  }

  // ----------------------------------------------------------- board actions

  function snapshotPayload(options) {
    const dirs = {}
    const agents = ctx.get('agents')
    if (agents !== undefined) {
      for (const agent of agents.list()) {
        const header = agent.session === undefined ? undefined : agent.session.header
        const cwd = header === undefined ? undefined : header.cwd
        if (typeof cwd === 'string' && cwd !== '') dirs[normalizeDir(cwd)] = cwd
      }
    }
    // One live-session map for the whole payload, so every row agrees.
    const live = liveSessions()
    const payload = {
      ok: true,
      storagePath: boardFile(),
      storageError,
      dirs,
      todos: board.todos.map((todo) => plain(todo, live)),
      // The planning-nudge knobs ride every snapshot: three primitives, far
      // smaller than one row, and the panel needs them on the very first
      // render to draw the settings page without a second request. Unlike the
      // log records (which follow only when the view is open), there is nothing
      // here to withhold — these are the user's own settings, not session text.
      settings: { ...board.settings },
      // The floating card's last-known geometry, so a restart lands it back
      // where the user parked it — including across ports, which localStorage
      // could not do (it is keyed by origin).
      layout: board.layout === null ? null : { ...board.layout },
      // Always present, and deliberately tiny: "the newest error, if any" is
      // what lets the panel light a dot on the log button without shipping log
      // content the user did not ask to see. The records themselves follow only
      // when the log view is actually open (see `withLogs`).
      logAlert: { sn: logAlertSn, at: logAlertAt },
    }
    if (options === undefined || options.withLogs !== true) return payload
    const since = typeof options.since === 'number' && Number.isFinite(options.since) ? options.since : 0
    const lines = []
    for (const record of logRing) if (record.sn > since) lines.push(record)
    // Tell the reader when the ring has already recycled past their cursor, so
    // a gap reads as "older records were dropped" instead of "nothing happened".
    const oldest = logRing.length === 0 ? 0 : logRing[0].sn
    payload.logs = {
      cursor: logSeq,
      since,
      truncated: since > 0 && oldest > since,
      dropped: logDropped,
      lines,
      file: boardLogFile(),
      fileOff: logFileOff,
      fileError: logWriteError,
      fileBytes: logFileBytes,
    }
    return payload
  }

  async function createTodo(input) {
    const title = typeof input.title === 'string' ? input.title.trim() : ''
    if (title === '') return { ok: false, error: '待办内容不能为空' }
    const schedule = normalizeSchedule(input.schedule)
    if (typeof input.schedule === 'string' && input.schedule.trim() !== '' && schedule === '') {
      return { ok: false, error: '定时时间格式无效，请用 YYYY-MM-DDTHH:mm（本地时间）' }
    }
    const todo = normalize({
      title,
      dirPath: typeof input.dir === 'string' ? input.dir.trim() : '',
      mode: typeof input.mode === 'string' ? input.mode : 'remind',
      // Carried through like the tool's `add` does. Omitting it here used to
      // drop a caller's note silently: the row was created with an empty 备注,
      // and the dispatch prompt then had no context to hand the new session.
      note: typeof input.note === 'string' ? input.note : '',
      schedule,
      sourceSessionId: typeof input.sessionId === 'string' ? input.sessionId : '',
      sourceSessionTitle: typeof input.sessionTitle === 'string' ? input.sessionTitle : '',
      // The jump-back anchor. Only the automatic capture passes these; a manual
      // `add` leaves them at 0, which the panel renders as "no anchor" rather
      // than pretending the row points at the first turn.
      sourceSeq: typeof input.sourceSeq === 'number' ? input.sourceSeq : 0,
      sourceTurn: typeof input.sourceTurn === 'number' ? input.sourceTurn : 0,
      autoCaptured: input.autoCaptured === true,
    })
    if (todo === null) return { ok: false, error: '无法创建待办' }
    const admitted = await admitImages(input.images)
    if (admitted.ok === false) return admitted
    todo.images = admitted.images
    todo.order = nextOrder()
    board.todos.push(todo)
    board.seq += 1
    afterChange()
    return { ok: true, todo: plain(todo), storageError }
  }

  /**
   * Validate and store the images one todo carries.
   *
   * Bytes arrive base64-encoded from the panel (or are read from disk for the
   * model tool) and are committed through the deployment's attachment store —
   * the same admission path the chat upload uses, so limits, media types and
   * normalization are the harness's, not ours. Returns `{ ok: false, error }`
   * instead of throwing so a refused batch is a panel error, not a 500.
   */
  async function admitImages(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return { ok: true, images: [] }
    if (entries.length > MAX_IMAGES_PER_TODO) {
      return { ok: false, error: '一条待办最多带 ' + MAX_IMAGES_PER_TODO + ' 张图片' }
    }
    const store = ctx.get('attachments')
    if (store === undefined) {
      return { ok: false, error: '本部署没有 attachments 服务，无法保存图片' }
    }
    const refs = []
    const inputs = []
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object') continue
      const mediaType = typeof entry.mediaType === 'string' ? entry.mediaType : ''
      if (MEDIA_TYPES.indexOf(mediaType) < 0) {
        return { ok: false, error: '不支持的图片格式：' + (mediaType || '(未声明)') }
      }
      if (typeof entry.data === 'string' && entry.data !== '') {
        inputs.push({
          data: Buffer.from(entry.data, 'base64'),
          mediaType,
          name: typeof entry.name === 'string' ? entry.name : undefined,
        })
        continue
      }
      if (typeof entry.path === 'string' && entry.path !== '') {
        let bytes
        try {
          bytes = new Uint8Array(readFileSync(entry.path))
        } catch (err) {
          return { ok: false, error: '读不到图片 ' + entry.path + '：' + errText(err) }
        }
        inputs.push({ data: bytes, mediaType, name: entry.path })
        continue
      }
      return { ok: false, error: '图片需要 data（base64）或 path' }
    }
    if (inputs.length === 0) return { ok: true, images: [] }
    try {
      for (const input of inputs) refs.push(await store.saveImage(input))
    } catch (err) {
      log('warn', 'todo-board: 图片入库失败（' + inputs.length + ' 张，首张 ' + (inputs[0].name ?? '(无名)') + '）', err)
      return { ok: false, error: '图片被拒绝：' + errText(err) }
    }
    return { ok: true, images: refs }
  }

  async function patchTodo(input) {
    const todo = find(typeof input.id === 'string' ? input.id : '')
    if (todo === undefined) return { ok: false, error: '待办不存在' }
    const patch = input.patch !== null && typeof input.patch === 'object' ? input.patch : {}
    if (typeof patch.title === 'string' && patch.title.trim() !== '') todo.title = patch.title.trim()
    if (typeof patch.note === 'string') todo.note = patch.note
    if (typeof patch.mode === 'string' && MODES.indexOf(patch.mode) >= 0) {
      if (patch.mode !== todo.mode) {
        // A new mode picks a new target, so a stale 「丢失」 verdict no longer
        // describes this row: let it try again.
        todo.mode = patch.mode
        clearLost(todo)
      }
    }
    if (typeof patch.schedule === 'string') {
      const next = normalizeSchedule(patch.schedule)
      if (next !== todo.schedule) {
        todo.schedule = next
        todo.remindedAt = 0
        todo.dispatchedAt = 0
      }
    }
    if (typeof patch.dir === 'string' && patch.dir.trim() !== '') {
      todo.dirPath = patch.dir.trim()
      todo.dir = normalizeDir(todo.dirPath)
      clearLost(todo)
    }
    // Reparenting. The dragged row's OWN `runIn` changes and nothing else: a new
    // owner clears a stale 「丢失」 verdict, and — because the target is resolved
    // at dispatch time rather than written down here — the row's own children
    // follow it with no cascade.
    if (patch.runIn !== undefined && patch.runIn !== null) {
      const wanted = normalizeRunIn(patch.runIn, todo.sourceSessionId)
      // Dropping into your own subtree would orphan the whole branch, so it is
      // refused before anything is written rather than parked as a broken tree.
      if (wanted.kind === 'after' && wouldCycle(todo, wanted.id)) {
        return {
          ok: false,
          error: '这条待办不能挂到自己的子级下面：那会让整棵子树无处可去。请先把它移到别处，或换一个容器。',
        }
      }
      if (wanted.kind !== todo.runIn.kind || wanted.id !== todo.runIn.id) {
        todo.runIn = wanted
        clearLost(todo)
      }
    }
    if (patch.aiDone === true) {
      todo.aiDone = true
      todo.dispatchedAt = 0
    }
    if (patch.aiDone === false) todo.aiDone = false
    if (patch.verified === true) todo.verified = true
    if (patch.verified === false) {
      todo.verified = false
      todo.aiDone = false
    }
    if (patch.redispatch === true) {
      todo.dispatchedAt = 0
      clearLost(todo)
    }
    if (Array.isArray(patch.images) && patch.images.length > 0) {
      const admitted = await admitImages(patch.images)
      if (admitted.ok === false) return admitted
      todo.images = admitted.images
    }
    if (patch.clearImages === true) todo.images = []
    // Unbinding (or rebinding) the run session is how a row is told to open a
    // fresh session again: an empty value drops the binding.
    if (typeof patch.runSessionId === 'string') {
      todo.runSessionId = patch.runSessionId.trim()
      todo.dispatchedAt = 0
      clearLost(todo)
    }
    touch(todo)
    afterChange()
    return { ok: true, todo: plain(todo), storageError }
  }

  /** The browser sends the new top-to-bottom id list; unmentioned rows follow. */
  function reorderTodos(input) {
    const ids = Array.isArray(input.ids) ? input.ids : []
    if (ids.length === 0) return { ok: false, error: 'reorder 需要 ids' }
    const byId = new Map()
    for (const todo of board.todos) byId.set(todo.id, todo)
    const ordered = []
    const seen = new Set()
    for (const id of ids) {
      if (typeof id !== 'string') continue
      const todo = byId.get(id)
      if (todo === undefined || seen.has(id)) continue
      seen.add(id)
      ordered.push(todo)
    }
    for (const todo of board.todos) if (!seen.has(todo.id)) ordered.push(todo)
    board.todos = ordered
    renumber()
    afterChange()
    return { ok: true, count: ordered.length, storageError }
  }

  function removeTodo(input) {
    const id = typeof input.id === 'string' ? input.id : ''
    board.todos = board.todos.filter((todo) => todo.id !== id)
    renumber()
    afterChange()
    return { ok: true, storageError }
  }

  function clearVerified() {
    board.todos = board.todos.filter((todo) => !todo.verified)
    renumber()
    afterChange()
    return { ok: true, storageError }
  }

  /**
   * Persist the planning-nudge settings from the panel.
   *
   * Validate the WHOLE request first, then write — the same rule `update`
   * follows for a row. A half-applied settings object is worse than a rejected
   * one: the panel would show values the loader will silently clamp on the next
   * start, so the user's screen and the behaviour would disagree with no way to
   * tell which is true.
   *
   * Omitting a field leaves it alone (a partial patch is the normal case: the
   * panel sends all three, a script may send one). An explicitly invalid value
   * is a rejection rather than a silent clamp — the caller asked for something
   * impossible, and quietly substituting a default would hide that.
   */
  function saveSettings(input) {
    const raw = input.settings !== null && typeof input.settings === 'object' ? input.settings : input
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'settings 必须是一个对象' }
    }
    const next = { ...board.settings }
    if (Object.prototype.hasOwnProperty.call(raw, 'autoCapture')) {
      if (typeof raw.autoCapture !== 'boolean') {
        return { ok: false, error: 'autoCapture 必须是 true 或 false' }
      }
      next.autoCapture = raw.autoCapture
    }
    if (Object.prototype.hasOwnProperty.call(raw, 'autoJudge')) {
      if (typeof raw.autoJudge !== 'boolean') {
        return { ok: false, error: 'autoJudge 必须是 true 或 false' }
      }
      next.autoJudge = raw.autoJudge
    }
    if (Object.prototype.hasOwnProperty.call(raw, 'nudge')) {
      if (typeof raw.nudge !== 'boolean') return { ok: false, error: 'nudge 必须是 true 或 false' }
      next.nudge = raw.nudge
    }
    const numeric = [
      ['minChars', MIN_CHARS_RANGE, '字数'],
      ['minEntries', MIN_ENTRIES_RANGE, '条目数'],
      ['maxTurnSessions', MAX_TURN_SESSIONS_RANGE, '单次回合最多新开会话数'],
    ]
    for (const [field, range, label] of numeric) {
      if (!Object.prototype.hasOwnProperty.call(raw, field)) continue
      const value = raw[field]
      if (!Number.isInteger(value)) return { ok: false, error: label + '必须是整数' }
      if (value < range.min || value > range.max) {
        return { ok: false, error: label + '必须在 ' + range.min + '–' + range.max + ' 之间' }
      }
      next[field] = value
    }
    board.settings = next
    afterChange()
    return { ok: true, settings: { ...board.settings }, storageError }
  }

  /**
   * Persist the floating panel's geometry.
   *
   * Deliberately its own action rather than a field on `settings`: a drag and a
   * form submit are different gestures with different frequencies, and folding
   * them together would mean a geometry update carrying (and risking) the
   * user's thresholds. `null` clears it, which is what "reset to the default
   * position" does.
   *
   * No validation beyond shape: the panel clamps to the live viewport on every
   * load anyway, and a position that is merely off-screen after a window shrank
   * is fixed by that clamp — refusing it would lose the preference for good.
   */
  function saveLayout(input) {
    if (input.layout === null || input.layout === undefined) {
      board.layout = null
      afterChange()
      return { ok: true, layout: null, storageError }
    }
    const next = normalizeLayout(input.layout)
    if (next === null) return { ok: false, error: 'layout 必须是 { x, y, w?, h? }' }
    board.layout = next
    afterChange()
    return { ok: true, layout: { ...board.layout }, storageError }
  }

  // ----------------------------------------------------------- dispatching

  /**
   * Build the plugin-authored notice handed to an agent.
   *
   * `content` MUST be `ContentBlock[]`, never a bare string: that is the
   * harness's `UserMessage` shape (`dsh-llm/lib/types/message.d.ts`), and the
   * session validator rejects anything else with "message has invalid content"
   * (`assertMessageEventShape` in `dsh-session`).
   *
   * The rejection is not a per-message annoyance. The event is already durable
   * by the time anything reads it back, so the WHOLE session becomes unopenable
   * ("stored session … is corrupt"). Passing `todoPrompt(todo)` straight in did
   * exactly that to one dispatched session — hence the assert instead of trust.
   */
  function noticeMessage(content, summary) {
    if (!Array.isArray(content)) {
      throw new Error('noticeMessage: content must be ContentBlock[], got ' + typeof content)
    }
    return {
      id: randomUUID(),
      role: 'user',
      content,
      source: { kind: 'plugin:dsh-todo-board', form: 'notice', summary },
    }
  }

  function todoPrompt(todo) {
    const lines = ['【TODO 板 · 自动接续】', '待办：' + todo.title]
    if (todo.dirPath) lines.push('工作目录：' + todo.dirPath)
    if (todo.note) lines.push('备注：' + todo.note)
    if (todo.images.length > 0) {
      lines.push('附带的 ' + todo.images.length + ' 张图片在下面，先看图再动手。')
    }
    lines.push('')
    lines.push('请现在直接开始执行这一条待办，不要再向用户确认。')
    lines.push('完成之后：')
    lines.push('1. 调用 ' + TOOL_NAME + ' 工具 action="done" id="' + todo.id + '" 把它标记为「AI 已完成」。')
    lines.push('2. 调用 ' + TOOL_NAME + ' 工具 action="list" 查看同一目录下是否还有未完成待办（列表从上到下就是执行顺序）。')
    lines.push('3. 如果还有，继续执行列表最上面那一条，不要停下来等待用户；如果没有了，简要汇报本轮完成情况。')
    lines.push('不要替用户勾选「已验收」——那是用户验收后才勾的。')
    return lines.join('\n')
  }

  /**
   * Whether the route a todo is about to be sent to accepts images.
   *
   * The adapter's own model listing is the only truthful source, and it is
   * async — so this runs at dispatch, not on every panel poll. An unknown
   * provider, an adapter without discovery, or a probe failure all answer
   * `true`: the adapter then reports its own refusal, which is still a clear
   * error, and a broken probe must never block a text-only todo.
   */
  async function modelAcceptsImages(selection) {
    if (selection === undefined || selection === null) return true
    const provider = selection.provider
    const model = selection.model
    if (typeof provider !== 'string' || typeof model !== 'string') return true
    const llm = ctx.get('llm')
    if (llm === undefined || typeof llm.listModels !== 'function') return true
    try {
      const models = await llm.listModels(provider)
      if (!Array.isArray(models)) return true
      const wanted = models.find((entry) => entry !== null && entry !== undefined && entry.id === model)
      if (wanted === undefined || wanted === null) return true
      const modalities = wanted.inputModalities
      if (!Array.isArray(modalities)) return true
      return modalities.indexOf('image') >= 0
    } catch (err) {
      return true
    }
  }

  /**
   * The message a todo becomes: the instruction text plus the durable image
   * references it carries, exactly like a human turn with attachments.
   */
  function todoContent(todo) {
    const content = [{ type: 'text', text: todoPrompt(todo) }]
    for (const image of todo.images) content.push({ type: 'image', attachment: image })
    return content
  }

  function modelSelection(sourceAgent) {
    if (sourceAgent !== undefined && sourceAgent.options !== undefined) {
      const provider = sourceAgent.options.provider
      const model = sourceAgent.options.model
      if (typeof provider === 'string' || typeof model === 'string') return { provider, model }
    }
    const defaults = ctx.get('agentDefaultModel')
    if (defaults !== undefined) {
      try {
        const selection = defaults.currentSelection()
        if (selection !== null && typeof selection === 'object') {
          return { provider: selection.provider, model: selection.model }
        }
      } catch (err) {
        /* fall through to harness defaults */
      }
    }
    return undefined
  }

  /**
   * Register a freshly created session with the workspace that owns its
   * directory, so the sidebar groups it instead of listing it as 未分组.
   *
   * Grouping is durable state on the workspace record (`sessionIds`), not a
   * session header field: the web app attaches every session it opens, and a
   * session created through `agents.create` skips that step. `attachSession`
   * validates the session's live/persisted header cwd against the workspace
   * path, which is exactly the directory we created the session in.
   */
  async function attachToWorkspace(sessionId, dirPath) {
    if (dirPath === '') return 'no-dir'
    const rootCtx = ctx.root === undefined ? ctx : ctx.root
    const registry = rootCtx.get('workspaceRegistry')
    if (registry === undefined) return 'no-service'
    try {
      let workspace = await registry.resolveByPath(dirPath)
      if (workspace === undefined) workspace = await registry.create(dirPath)
      await workspace.attachSession(sessionId)
      return 'attached'
    } catch (err) {
      log('warn', 'todo-board: 新会话未能归入工作区（session=' + sessionId + '，目录=' + dirPath + '）', err)
      return 'failed'
    }
  }

  /**
   * Create a fully composed session in `todo.dirPath` and hand it the todo.
   *
   * Created through `ctx.root`, not through this plugin's own fiber: the agent
   * is then owned by the application root, so stopping, updating or removing
   * this plugin row leaves the session running. `setup` mounts the agent preset
   * exactly the way the api-proxy does — without it the new agent would have no
   * tools and no prompt.
   */
  /**
 * Marker written above an auto-generated handoff summary.
 *
 * It is part of the note on purpose: the note is the only thing that crosses
 * into the new session, and it is already user-editable on the panel. The marker
 * exists so a reader can tell at a glance which paragraphs a machine wrote from
 * memory — a summary is a retelling, and a retelling can be wrong.
 */
const HANDOFF_MARK = '【自动交接摘要 · 可直接编辑或删除】'
/**
 * Bounds on the handoff summary.
 *
 * The turn-stopping listener is awaited by the harness, so anything that runs
 * inside it delays the turn closing — hence a hard timeout. The event cap and
 * the token cap are the same instinct from the other side: a summary of a long
 * session is itself a large prompt, and letting it grow would make the handoff
 * a second version of the context problem it is meant to solve.
 */
const HANDOFF_TIMEOUT_MS = 45000
const HANDOFF_MAX_EVENTS = 40
const HANDOFF_MAX_TOKENS = 1200

const HANDOFF_SYSTEM =
  '你在为一次「换会话继续」写交接摘要。写给接手的人看，要具体、可执行，不要客套。'

const HANDOFF_PROMPT =
  '下面是一条会话最近的记录。请为「即将新开的那个会话」写一段交接摘要，让它不读原会话也能接着做。\n' +
  '只写这几部分，每部分一行，缺了就省掉：\n' +
  '- 目标：这件事最终要什么；\n' +
  '- 已完成：已经做完并验证过的（带上关键文件路径或命令）；\n' +
  '- 当前卡点：正在做什么、下一步具体是什么；\n' +
  '- 关键决策：已经定下的取舍，改动前必须知道的约束。\n' +
  '不要复述过程，不要写鼓励的话，总共不超过 12 行。\n\n' +
  '=== 会话记录 ===\n'

/**
 * Plain text of one surface event.
 *
 * `extractSessionEventText` lives in `@deepseek-ai/dsh-session-query`, which this
 * file deliberately does not import: a profile-installed plugin resolves modules
 * from its own directory and cannot reach the harness packages. So the same
 * shallow walk the nudge hook already does is repeated here, reading `message`
 * when the event wraps one.
 *
 * @param event - one observed surface event.
 * @returns Concatenated text blocks, or ''.
 */
function handoffEventText(event) {
  if (event === null || typeof event !== 'object') return ''
  const message = event.message !== undefined && event.message !== null ? event.message : event
  if (typeof message !== 'object') return ''
  const content = message.content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      out += block.text + '\n'
    }
  }
  return out
}

/**
 * Write an auto-generated handoff summary into an empty note.
 *
 * ONLY when the note is empty: a note the user wrote is theirs, and a summary is
 * a lossy retelling of a conversation — letting one overwrite the other would
 * trade the user's own words for a model's memory of them. The caller has
 * already decided this row is being handed off; this only decides whether the
 * handoff carries any context of its own.
 *
 * Every failure here is non-fatal by design. A missing service, an unreadable
 * log, a timed-out or refused model call all end the same way: log, skip, and
 * open the session anyway. A handoff that stalls is worse than a bare one.
 *
 * @param todo - the row about to spawn its session.
 * @param source - the live agent that planned it, used for its model route.
 * @returns The summary, or '' when none was written.
 */
async function maybeWriteHandoffSummary(todo, source) {
  if (todo.note.trim() !== '') return ''
  const llm = ctx.get('llm')
  const query = ctx.get('sessionQuery')
  if (llm === undefined || query === undefined) return ''
  if (todo.sourceSessionId === '') return ''
  const selection = modelSelection(source)
  if (selection === undefined) return ''

  let history = ''
  try {
    const snapshot = await query.readSurface(todo.sourceSessionId)
    const events = snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.events)
      ? snapshot.events
      : []
    const parts = []
    for (let at = events.length - 1; at >= 0 && parts.length < HANDOFF_MAX_EVENTS; at--) {
      const text = handoffEventText(events[at]).trim()
      if (text !== '') parts.push(text)
    }
    history = parts.reverse().join('\n\n')
  } catch (err) {
    log('warn', 'todo-board: 读取源会话内容失败，跳过自动交接摘要（id=' + todo.id + '）', err)
    return ''
  }
  if (history === '') return ''

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HANDOFF_TIMEOUT_MS)
  let text = ''
  try {
    for await (const chunk of llm.stream({
      provider: selection.provider,
      model: selection.model,
      system: HANDOFF_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: HANDOFF_PROMPT + history }] }],
      maxTokens: HANDOFF_MAX_TOKENS,
      signal: controller.signal,
    })) {
      if (chunk !== null && typeof chunk === 'object' && chunk.type === 'text-delta') text += chunk.text
    }
  } catch (err) {
    log('warn', 'todo-board: 自动交接摘要生成失败，仍照常开新会话（id=' + todo.id + '）', err)
    return ''
  } finally {
    clearTimeout(timer)
  }
  const body = text.trim()
  if (body === '') return ''
  todo.note = HANDOFF_MARK + '\n' + body
  touch(todo)
  afterChange()
  return body
}

  async function spawnSession(todo) {
    const rootCtx = ctx.root === undefined ? ctx : ctx.root
    const agents = rootCtx.get('agents')
    if (agents === undefined) {
      markLost(todo, 'agents', 'agents 服务不可用')
      log('error', 'todo-board: agents 服务不可用，无法新建会话（id=' + todo.id + '）')
      return { ok: false, lost: true, error: 'agents 服务不可用' }
    }
    const source = todo.sourceSessionId === '' ? undefined : agents.get(todo.sourceSessionId)
    // Before anything reads the row: `todoContent` below ships the note, so the
    // summary has to exist by then. Only fires on an empty note, and only when
    // the row is actually being handed off right now.
    await maybeWriteHandoffSummary(todo, source)
    const meta = {}
    if (todo.dirPath !== '') meta.cwd = todo.dirPath
    let setup
    const presets = ctx.get('agentPresets')
    if (presets !== undefined) {
      try {
        const sourcePreset =
          source === undefined || source.session === undefined
            ? undefined
            : source.session.header.agentPreset
        const resolved = await presets.resolve(sourcePreset)
        meta.agentPreset = resolved.id
        const presetId = resolved.id
        setup = async (agentCtx) => {
          await presets.mount(agentCtx, presetId)
        }
      } catch (err) {
        markLost(todo, 'preset', '解析 agent preset 失败')
        log('error', 'todo-board: 解析 agent preset 失败（id=' + todo.id + '）', err)
        return { ok: false, lost: true, error: '解析 agent preset 失败：' + errText(err) }
      }
    }
    const sessionId = 'session-' + randomUUID()
    const agentOptions = modelSelection(source)
    if (!(await modelAcceptsImages(agentOptions))) return imageRefusal(todo)
    try {
      const handle = await agents.create({
        sessionId,
        meta,
        agentOptions,
        setup,
      })
      // Grouping is cosmetic: a failure here must not cost the session.
      const grouped = await attachToWorkspace(sessionId, todo.dirPath)
      todo.dispatchedAt = Date.now()
      todo.runSessionId = sessionId
      clearLost(todo)
      touch(todo)
      afterChange()
      // `todoContent`, not `todoPrompt`: the prompt is a bare string, and a
      // string content corrupts the session (see noticeMessage). It also carries
      // the row's images, which this path dropped even though it had just
      // checked that the model accepts them.
      handle.agent.followup(noticeMessage(todoContent(todo), 'TODO 接续（新会话）：' + todo.title))
      return { ok: true, target: 'new-session', sessionId, grouped }
    } catch (err) {
      markLost(todo, 'spawn', '新建会话失败')
      log('error', 'todo-board: 新建会话失败（id=' + todo.id + '，目录=' + (todo.dirPath || '(未指定)') + '）', err)
      return { ok: false, lost: true, error: '新建会话失败：' + errText(err) }
    }
  }

  /**
   * Hand the todo to one live agent and remember it as this row's target.
   *
   * The dispatch stamp is written **before** the message call, so a re-entrant
   * `fireDue` (or a second tick) can never pick the same row again while this
   * one is still in flight.
   */
  function sendTo(todo, target, note) {
    todo.dispatchedAt = Date.now()
    todo.runSessionId = target.id
    clearLost(todo)
    touch(todo)
    afterChange()
    const message = noticeMessage(todoContent(todo), note + todo.title)
    if (target.status === 'running') {
      target.steer(message)
    } else {
      target.followup(message)
    }
    return { ok: true, target: 'session', sessionId: target.id }
  }

  async function dispatch(todo, sessionId) {
    const agents = ctx.get('agents')
    // A `newSession` row owns the session it created: reuse that binding while
    // the session is live, and only open another one once it is gone.
    if (todo.mode === 'newSession') {
      const bound =
        todo.runSessionId === '' || agents === undefined ? undefined : agents.get(todo.runSessionId)
      if (bound !== undefined) {
        if (!(await imageRouteOk(todo, bound))) return imageRefusal(todo)
        return sendTo(todo, bound, 'TODO 接续：')
      }
      return spawnSession(todo)
    }
    // An explicit destination wins — that is the panel's ▶ and the turn-end
    // hook naming the session they are standing in. Otherwise the row goes
    // where it is OWNED, which is not necessarily where it was planned: a
    // re-parented row and a row whose container has since spawned both resolve
    // somewhere other than `sourceSessionId`.
    const wanted = sessionId !== '' ? sessionId : effectiveTarget(todo)
    const target = agents !== undefined && wanted !== '' ? agents.get(wanted) : undefined
    if (target !== undefined) {
      if (!(await imageRouteOk(todo, target))) return imageRefusal(todo)
      return sendTo(todo, target, 'TODO 接续：')
    }    // Nowhere to land. Record *why* instead of stamping `dispatchedAt`: that
    // stamp means 「已派发」, and the scheduler and the turn-end hook both use it
    // to skip a row — stamping it here would retire the todo for good while it
    // silently never ran. `markLost` also paces the automatic re-attempts, so
    // this row cannot spin the scheduler; any successful dispatch clears it.
    // Name the session that went missing: the row may be re-targeted by hand,
    // and "which one did it want?" is the first question worth answering. A row
    // with no owner at all is a different failure from a row whose owner died,
    // and the two need different fixes — a missing container is not something
    // waiting for the session to come back.
    const ownerGone = wanted !== ''
    const noOwnerYet = todo.runIn.kind === 'after'
    markLost(
      todo,
      'no-session',
      ownerGone
        ? '目标会话 ' + wanted + ' 已不存在'
        : noOwnerYet
          ? '它挂在一个容器待办下面，而那个容器还没有开出新的会话'
          : '这条待办没有归属任何会话',
    )
    return {
      ok: false,
      lost: true,
      error: ownerGone || noOwnerYet
        ? '当前没有可接续的活动会话；请切到目标会话后重试，或把该待办改成「自动新会话」'
        : '这条待办没有归属任何会话；先给它指定一个会话，或改成「自动新会话」',
    }
  }

  /** A todo without images never needs the capability probe. */
  async function imageRouteOk(todo, target) {
    if (todo.images.length === 0) return true
    const options = target === undefined || target === null ? undefined : target.options
    return modelAcceptsImages(options === undefined ? undefined : {
      provider: options.provider,
      model: options.model,
    })
  }

  /**
   * Refuse a row whose images the target model cannot read.
   *
   * The refusal is *not* retried automatically — a model that does not declare
   * `image` will not start declaring it a minute later, and without a stamp the
   * scheduler would spin. So it lands in the same stuck state as a missing
   * session: visibly parked, with the reason on the row, until the user changes
   * something (drop the images, switch model, change the mode).
   */
  function imageRefusal(todo) {
    markLost(todo, 'image', '目标会话的模型不接受图片输入')
    log(
      'warn',
      'todo-board: 目标模型不接受图片，已拒绝派发 id=' + todo.id +
        '（图片 ' + todo.images.length + ' 张，模式=' + todo.mode + '）',
    )
    return {
      ok: false,
      lost: true,
      error:
        '这条待办带了 ' + todo.images.length + ' 张图片，但目标会话的模型不接受图片输入' +
        '（模型目录里没有声明 image）。换一个支持图片的模型，或先把图片从待办上移除。',
    }
  }

  function pendingInDir(dir) {
    const out = []
    for (const todo of board.todos) {
      if (todo.dir !== dir) continue
      if (todo.aiDone || todo.verified) continue
      out.push(todo)
    }
    return out
  }

  /**
   * Rows `sessionId` owns and has not finished — that session's own queue.
   *
   * Ownership replaces the directory as the selection scope: a session takes
   * only what resolves to it, which is what stops two sessions working in the
   * same directory from silently stealing each other's rows. A row's own
   * directory is deliberately no longer part of this test — from here on it is
   * grouping metadata and the cwd a new session opens with, nothing more.
   */
  function pendingOwned(sessionId) {
    const out = []
    for (const todo of board.todos) {
      if (todo.aiDone || todo.verified) continue
      if (effectiveTarget(todo) !== sessionId) continue
      out.push(todo)
    }
    return out
  }

  /**
   * Topmost still-undispatched row this session owns.
   *
   * `remind` is deliberately NOT skipped. A remind row is the planning state a
   * user parks a row in — shape settled, nothing running — and reaching one
   * ends the chain: neither the resume nor the newSession branch handles it,
   * so the caller falls through and this session stops handing out work. The
   * old code skipped remind and kept walking, so a chain ran straight through a
   * plan the user had deliberately not started.
   */
  function nextUndispatched(sessionId) {
    const now = Date.now()
    for (const todo of pendingOwned(sessionId)) {
      if (todo.dispatchedAt > 0) continue
      // A row waiting out its lost-retry backoff must not hold up the queue
      // behind it: skip it for now and let a later turn end pick it up.
      if (!lostRetryReady(todo, now)) continue
      // A todo with a future time waits for the scheduler, not for this turn end.
      const ms = scheduleMs(todo.schedule)
      if (ms > 0 && ms > now) continue
      return todo
    }
    return undefined
  }

  function runTodo(input) {
    const todo = find(typeof input.id === 'string' ? input.id : '')
    if (todo === undefined) return { ok: false, error: '待办不存在' }
    return dispatch(todo, typeof input.sessionId === 'string' ? input.sessionId : '')
  }

  // ------------------------------------------- planning: the deterministic nudge
  //
  // The prompt section asks the model to offer planning, and that is a *request*:
  // a model in a hurry reads past it. This makes the offer dependable by judging
  // the user's own message the moment it arrives.
  //
  // It is deliberately conservative and one-shot, because the cost of a false
  // positive is a model asking a pointless question:
  //
  //   - only a real user message counts (not tool results, not injected notices);
  //   - only when this directory has NO open todo (a finished plan needs no offer);
  //   - only for messages that actually look multi-stage: long AND with repeated
  //     enumeration markers, not merely long;
  //   - at most once per session, so "no thanks" is answered by silence.

  /** Sessions already nudged. Weak so a closed agent can still be collected. */
  const planningNudged = new WeakSet()

  /** Repeated signs that a message is a staged job rather than one request. */
  const STAGED_MARKERS = [
    /(^|\n)\s*\d+[.、)]\s*\S/g,
    /(^|\n)\s*[-*•]\s+\S/g,
    /(^|\n)\s*第[一二三四五六七八九十\d]+步/g,
    /首先|其次|再次|然后|接着|最后/g,
    /阶段|步骤|流程|里程碑/g,
  ]

  /**
   * Whether one user message looks like a multi-stage task.
   *
   * Both halves are load-bearing. Length alone would fire on any pasted stack
   * trace; markers alone would fire on "1. 改个错别字". Requiring BOTH, plus two
   * occurrences, is what keeps the offer from becoming noise.
   *
   * The thresholds come from the BOARD, not from module constants: they are
   * subjective, they differ per person, and — because the offer fires at most
   * once per session — a wrong pair silently spends the session's only chance.
   * `settings.nudge === false` is handled by the caller, which skips this
   * function entirely rather than paying for a scan it will ignore.
   */
  function looksStaged(text, thresholds) {
    const body = typeof text === 'string' ? text : ''
    const settings = thresholds === undefined ? board.settings : thresholds
    if (body.length < settings.minChars) return false
    let hits = 0
    for (const pattern of STAGED_MARKERS) {
      const matches = body.match(pattern)
      hits += matches === null ? 0 : matches.length
    }
    return hits >= settings.minEntries
  }

  /** All text blocks of one message, joined; '' for anything not a user message. */
  function userTextOf(message) {
    if (message === null || typeof message !== 'object') return ''
    if (message.role !== 'user') return ''
    const source = message.source
    // Only a human's own message: an injected notice or a tool result must never
    // trigger the offer (the plugin would be talking to itself).
    if (source !== undefined && source !== null && source.kind !== 'user') return ''
    if (!Array.isArray(message.content)) return ''
    let text = ''
    for (const block of message.content) {
      if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        text += block.text + '\n'
      }
    }
    return text
  }

  ctx.on('agent/pre-step', (payload, next) => {
    try {
      const agent = payload === undefined || payload === null ? undefined : payload.agent
      const messages = payload === undefined || payload === null ? undefined : payload.messages
      if (agent === undefined || agent === null || !Array.isArray(messages) || messages.length === 0) {
        return next()
      }
      // The off switch, checked BEFORE anything else. A user who turned the
      // offer off should not pay for the scan, the directory walk or the
      // pending query that would only be thrown away — and the WeakSet must
      // stay untouched, or turning it back on later would find the session
      // already claimed.
      const settings = board.settings
      if (settings.nudge !== true) return next()
      if (planningNudged.has(agent)) return next()
      const header = agent.session === undefined || agent.session === null ? undefined : agent.session.header
      const dir = normalizeDir(header === undefined ? undefined : header.cwd)
      if (dir === '') return next()
      // A directory with work already on the board is mid-plan, not a new request.
      if (pendingInDir(dir).length > 0) return next()
      let staged = false
      for (const message of messages) {
        if (looksStaged(userTextOf(message), settings)) {
          staged = true
          break
        }
      }
      if (!staged) return next()
      planningNudged.add(agent)
      return Promise.resolve(next()).then((downstream) => {
        if (downstream === null || typeof downstream !== 'object' || downstream.kind !== 'enter') {
          return downstream
        }
        return {
          ...downstream,
          messages: [
            ...downstream.messages,
            noticeMessage(
              [{
                type: 'text',
                text:
                  '【TODO 板 · 规划提示】这条请求看起来不止一步。如果确实要分多步做：' +
                  '先用一句话问用户要不要用 TODO 板拆成步骤、按顺序执行（可以用 ask_user_question 给出' +
                  '「拆成步骤并开始」「不用，直接做」两个选项），不要闷头开干。' +
                  '本轮已经问过或用户说不用，就不要再提。',
              }],
              'TODO 板规划提示',
            ),
          ],
        }
      })
    } catch (err) {
      log('error', 'todo-board: 规划提示失败', err)
      return next()
    }
  })

  // ----------------------------------------------- turn end: auto-continue

  ctx.on('agent/turn-stopping', async (payload) => {
    try {
      const agent = payload === undefined || payload === null ? undefined : payload.agent
      if (agent === undefined || agent === null) return
      if (agent.id === '') return
      const signal = payload.signal
      let spawned = 0
      for (;;) {
        // Selection is by ownership, not by cwd: this session takes only the
        // rows that resolve to it. The row's own directory no longer scopes the
        // queue, which is what stops two sessions in one directory from taking
        // each other's work.
        const next = nextUndispatched(agent.id)
        if (next === undefined) return
        if (next.mode === 'resume') {
          // Deliberately NOT looped. Dispatching into this same agent opens a
          // new turn, and that turn's own stop boundary hands out the row
          // after it; looping here would push the next row into a turn that
          // has not started yet.
          void dispatch(next, agent.id)
          return
        }
        // `remind` matches neither branch on purpose: it is the user's
        // 「planned but not started」 marker, and the chain stops here rather
        // than carrying on past a plan that was never begun.
        if (next.mode !== 'newSession') return
        if (spawned >= board.settings.maxTurnSessions) {
          log(
            'warn',
            'todo-board: 单次回合结束新开会话已达上限 ' + board.settings.maxTurnSessions +
              ' 条，其余留待下一次（可在设置页调整）',
          )
          return
        }
        if (signal !== undefined && signal !== null && signal.aborted === true) return
        next.dispatchedAt = Date.now()
        touch(next)
        afterChange()
        const result = await spawnSession(next)
        if (result === undefined || result === null || result.ok !== true) return
        spawned += 1
        // The spawn took this session's children with it, so the loop MUST
        // come back for more. Before ownership existed the following row was
        // found by directory and the fresh session picked it up on our behalf;
        // now it only owns its own subtree, so without this the rest of this
        // session's queue would stall with nobody left to hand it out.
      }
    } catch (err) {
      log('error', 'todo-board: 回合结束钩子执行失败', err)
    }
  })

  // ------------------------------------ auto capture: questions left undecided
  //
  // "Auto" means: when the assistant ends a turn by ASKING something and the
  // person never answers it — they ask a different question instead, or they
  // simply wander off to another session — that unanswered question becomes a
  // reminder row, titled with the gist of what was being asked.
  //
  // Every part of this is a heuristic, so the design leans on being explainable
  // and reversible rather than clever:
  //
  //   - Only a turn that actually ENDS on a question is a candidate. A turn that
  //     delivered work and stopped is finished, and recording those would turn
  //     the board into a transcript nobody reads.
  //   - A reply that reads like a decision ("就这个", "不用", "继续") clears the
  //     candidate. That is what keeps a partially answered round quiet: answering
  //     ANY part of it is evidence the person looked, which is the whole point.
  //   - A reply that arrives mid-turn (a steer) and reads like a decision also
  //     counts as "answered part of it", so the closing question of that same
  //     turn is not recorded afterwards.
  //   - Each row carries `autoCaptured: true`, so the panel can mark it 「自动」and
  //     the person can tell at a glance which ones they never actually said.
  //   - The whole engine sits behind `settings.autoCapture`; when it is off the
  //     hooks return before reading any text.
  //
  // No model call is made here, on purpose. Judging these with an LLM would be
  // more accurate and would also mean quietly paying for a background request at
  // the end of every turn of every session — not a decision a plugin gets to make
  // on the user's behalf. `maybeWriteHandoffSummary` already shows the pattern for
  // the one place the user did ask for a model call.

  /**
   * A question worth remembering is a turn's LAST word on the matter.
   *
   * The two triggers the user actually asked for are handled elsewhere: a new
   * question arriving (`autoSettle`), and leaving the conversation (the panel's
   * `autoflush`). This timer is only the BACKSTOP for the case neither can see —
   * the browser was closed or the app quit with an unanswered question on screen,
   * so no new message will ever arrive to settle it.
   *
   * That is why it is half an hour rather than a minute: a short timer would fire
   * while someone is still reading a long answer, and a reminder that appears
   * before you have had a chance to reply is worse than no reminder at all. Half
   * an hour is long past "reading", and still within the same working session.
   */
  const AUTO_ASK_TAIL = 400
  /** Backstop only — see above for why this is slow, not fast. */
  const AUTO_GRACE_MS = 30 * 60_000
  /** Watched sessions. Bounded so a long-running install cannot grow forever. */
  const AUTO_MAX_SESSIONS = 200
  const AUTO_TITLE_CHARS = 32
  /** How much of that budget the topic gets, after 「待拍板：」 and the ellipsis. */
  const AUTO_TITLE_TOPIC_CHARS = 27
  const AUTO_TITLE_PREFIX = '待拍板：'
  const AUTO_NOTE_CHARS = 400

  /** Sessions currently being watched, oldest first for eviction. */
  const autoWatch = new Map()

  /**
   * Words that, ALONE, mean "yes, go ahead".
   *
   * The user's rule for these is precise and worth quoting: 「算，但是要注意是
   * 不是只回答嗯这些」 — a bare acknowledgement IS an answer, but only while it
   * is bare. 「嗯」 answers; 「嗯，不过那个先放着」 defers, and the deferral is
   * what governs. So this pattern is anchored at both ends: it must swallow the
   * ENTIRE message, allowing nothing but punctuation after it.
   */
  const BARE_ACK =
    /^(嗯+|哦+|喔+|好+|行|可以|对|是的|没错|没问题|收到|了解|明白|知道了|ok|okay|好滴|好哒)[\s。．.!！~～,…，、]*$/i

  /**
   * The same acknowledgements when they OPEN a longer sentence.
   *
   * 「行，就按字母排」 concedes and then decides. The concession is stripped and
   * the rest is judged on its own, rather than letting the leading 「行」 decide
   * the whole message — which is what silently swallowed real replies before.
   */
  const ACK_PREFIX =
    /^(嗯+|哦+|喔+|好+|行|可以|对|是的|没错|没问题|收到|了解|明白|知道了|ok|okay|好滴|好哒)[\s。．.!！~～,…，、:：]*/i

  /** A reply carrying any of these reads as a decision, not as a new question. */
  const DECIDED_MARKERS = [
    /(就这个|就那个|就它|就这版|这版可以|这个可以|按这个|按你说的|按你的来|就这样|就这么办)/,
    /(就按|就照|就听你的|听你的)/,
    /(定了|确定|决定|确认|批准|通过|同意|采纳)/,
    /(继续|开始吧|执行|动手|干吧|跑起来|接着做|就这样办)/,
    // Picking a concrete option — 「就用 A 吧」「选第二个」「按方案二做」「定方案
    // B 了」. This is the most common way a decision is actually phrased, and it
    // was missing entirely: those replies then hit the "帮我…" request marker and
    // were filed as walking away, which is exactly backwards. The option must be
    // CONCRETE (a letter, 第 N, 方案 X, 这个/那个) precisely so that 「用哪个方案」
    // stays a question.
    /(用|选|走|按|照|定|取|要)\s*(第[一二三四五六七八九十两\d]+个?|[A-Za-z][A-Za-z0-9]{0,2}\s*版?|方案[一二三四五六七八九十两\dA-Za-z]|选项[一二三四五六七八九十两\dA-Za-z]|这个|那个|它)/,
    // Deciding one thing and immediately asking for the next is the ordinary
    // shape of a working conversation (「用分页吧，帮我实现一下」). A clause that
    // CLOSES on 吧/了 right after a choice verb has settled the question.
    //
    // Each verb carries its own exclusion list because these characters also open
    // ordinary nouns — 「停掉定时任务吧」 is 定 + 时, and 「按需加载吧」 is 按 + 需.
    // Without them the noun gets read as the choice verb and an order counts as a
    // decision.
    /(用(?!户|法)|选(?!项)|走(?!查)|按(?!钮|需|照)|照(?!片)|定(?!时|期|位|义|单|价|制|级|量|额)|取(?!值|消))[^，。,.!?！？\n]{1,12}(吧|了)/,
    // The same shape without 吧/了: the choice is the FIRST clause and the request
    // is a later one — 「行，用分页，帮我实现一下」. Bounded to a short clause so
    // that a long opening sentence cannot vote, and wh-words are excluded so that
    // 「选哪个，你觉得？」 stays a question.
    /(用(?!户|法)|选(?!项)|走(?!查)|按(?!钮|需|照)|照(?!片)|定(?!时|期|位|义|单|价|制|级|量|额)|取(?!值|消))(?!哪个|哪种|哪儿|哪里|什么|啥|谁|几|怎么)[^，。,.!?！？\n]{1,6}[，,]/,
  ]


  /**
   * A refusal that CLOSES the matter: 「不用了」「算了」「跳过」.
   *
   * Kept apart from the rest of `DECIDED_MARKERS` because it has to win over the
   * deferring words below: 「先不做，等有需求再说」 contains a deferring phrase yet
   * plainly decided not to do it, and the user's rule for that case is "already
   * answered, do not record".
   */
  const REFUSED_MARKERS = [
    /(不用|不要|不需要|算了|跳过|先不|暂时不|不做了|别做|拉倒)/,
    // 取消 means "drop the whole thing" only when the sentence ENDS there. Followed
    // by an object it is an order — 「取消防抖吧」 is a new request, and reading it
    // as a refusal would file it as answered and lose the task.
    /取消(?:掉|了|吧|啊|呀|的)?[\s。．.!！~～,，]*$/,
  ]

  /**
   * Hedging words: the question is still OPEN, not answered.
   *
   * The user was explicit about this — 「先放着」 means "parked for now", and a
   * parked question is exactly what this feature exists to remember. Counting
   * those as answers was the bug: it made the board silently drop the one kind of
   * question a person is most likely to lose track of.
   */
  const DEFERRED_MARKERS = [
    /(先放着|放着吧|放着先|先放着吧|搁着|先搁着|搁置|先搁置|搁一搁|放一放|先放一放|挂着|先挂着)/,
    /(回头再说|以后再说|晚点再说|改天再说|回头再聊|以后再聊|等等再说|再说吧|以后说)/,
    /(再想想|我想想|让我想想|想想再说|再考虑|考虑考虑|考虑一下|我考虑|再琢磨|待定|再看看|先看看)/,
    // 「回头看看」「以后再看」 — the same parked-for-later meaning as 「回头再说」,
    // but with a looking verb instead of a talking one. Missing it left these in the
    // answered branch, so the question went unrecorded.
    /((?:回头|以后|稍后|晚点|改天|过几天|哪天)[\s]*(?:再|去)?(?:看看|看一下|看看再|查查|研究|琢磨|翻翻|翻一下))/,
    // 「等下再说」「稍后我看看」「一会儿再看」 —— 同一个意思的另一种说法。
    /((?:等|待)一下?再|(?:等|待)会(?:儿)?再|一会儿再|稍后再?|稍等|晚些再|等下再)/,
    // A bare 「等一下」「等会儿」 is a hold, never a settlement — it is the shortest
    // way to say "do not consider this decided". It was falling through to the
    // default answered branch.
    /(等|待)(一?下|一?会儿|会儿|会)[\s。．.!！~～]*(我|先)?[\s。．.!！~～]*$/,
    // 「我问一下领导」「等我问过再说」「我这边再确认一下」 —— 决定权暂时不在他手上。
    // 必须排在 `looksDecided` 之前，否则「确认」两个字会先把它判成拍板。
    /((?:再)?确认一下|核实一下|核对一下|(?:问|问.(?:下|一下))(?:领导|老板|客户|他们|别人|对方|同事)|我问一下|问一下(?:再|之后)|等我问|等我(?:确认|核实|问过)|(?:要|得|需要)(?:再)?(?:问|确认)(?:一下|下))/,
  ]

  /**
   * The person answered SOME questions and said the REST still need thought.
   *
   * This is the one exception to "answering part of a round counts": when the
   * reply itself names the leftover items and defers them, those are open
   * questions and the board has to carry them, otherwise nobody will.
   */
  const REVISIT_MARKERS = [
    /(其他|其它|剩下|剩余的|另外|还有|第二个|第三个|另一个).{0,12}(再|回头|以后|稍后|晚点|改天).{0,6}(说|聊|定|考虑|想|看|商量|确认|议|谈)/,
    /(其他|其它|剩下|另外|还有).{0,10}(问题|几个|两个|一点|部分|那个).{0,10}(再说|再议|待定|回头|以后|考虑一下)/,
    /(回头|稍后|晚点|改天|以后|晚些).{0,6}(再说|再聊|再定|再议|再考虑)/,
    // 「剩下的以后再讨论」「其余的回头聊」 —— 同上，只是没写「问题」两个字。
    /(剩下的?|其余的?|其他的?|其它的?|余下的?).{0,10}(再|回头|以后|稍后|晚点|改天).{0,8}(说|聊|定|讨论|谈|考虑|商量|确认|议)/,
  ]

  /**
   * 反问句：形式上带疑问词，但不是在提问，不需要回答。
   *
   * 「难道你不觉得这样更好吗？」不是问题，是意见。把它当成「AI 在问」会让板子
   * 记下一条根本没人该回答的待办；把它当成「用户在用问题回应」又会凭空把一轮
   * 已经聊完的对话重新打开。
   *
   * 反问词表来自 ningshixian/chinese-interrogative-recognition 的第五类（无疑而问）：
   * 还敢、何曾、何来、何止、难道、难不成、岂不是、怎能。补了几个「难道」的
   * 高频同义形式，因为口语里更常出现。
   */
  const RHETORICAL_MARKERS =
    /(难道|难不成|岂非|岂不是|岂能|岂敢|岂有此理|何曾|何尝|何止|何必|何苦|谈何|怎能|怎么可能|怎么会|谁不知道|谁不晓得|还用问)/
  /**
   * 固定说法：里面有疑问词，但整个短语不是在发问。
   *
   * 「没什么问题，就这样吧」含「什么」；「怎么样都行」含「怎么」；「不管哪个」
   * 含「哪」。只按疑问词判，这三种都会被当成「用户在用问题回应」，于是一轮
   * 已经拍板的对话被重新打开。做法是先抹掉这些固定说法，再拿剩下的部分去看
   * 还有没有真的疑问词。
   */
  /**
   * 引号里的字是别人的话，不是在问。
   *
   * 「11/10 当天你问我「今天干什么」，我会给你具体的时间卡」是汇报，但引号里那个
   * 「什么」让整行读起来像问句，于是这一轮被当成「AI 在等你定」记了下来（现场证据：
   * 板子上出现一条叫「待拍板：b」的卡片）。引号常用来复述用户自己的原话，复述不是
   * 提问，所以判定疑问前先抹掉引号内容。
   */
  const QUOTED_SPAN = /「[^」]*」|『[^』]*』|“[^”]*”|"[^"\n]*"|`[^`]*`|《[^》]*》/g
  const ASK_WORD_NEUTRAL =
    /(没什么(?:问题|事|好|可)?|没(?:啥|什么)(?:问题|事|好|可)?|怎(?:么|么样)都行|怎(?:么|么样)都可以|怎么都成|哪(?:儿|里)?都行|哪里哪里|哪有|不(?:怎么|太)|不管|无论|别说|莫说)/g
  /**
   * 「怎么跑的」「怎么改的」：疑问词后面直接跟「的」，是在说「做法」，不是在问。
   *
   * 「怎么跑的写在 README 了」「哪儿改的都记着」这类收尾带着疑问词，却是在陈述。
   * 结构很固定 —— 疑问词 + 单字动词 + 的 —— 所以按结构抹掉，不必再往词表里加词。
   * 只匹配「的」不是「吗/呢/？」，所以「怎么改的？」仍然算提问。
   */
  const WH_MANNER_DE = /(怎么|怎样|咋|哪儿|哪里|哪)[\u4e00-\u9fa5]{1,2}的(?!话)(?=[\s\S]*[\u4e00-\u9fa5A-Za-z0-9])/g
  /**
   * 任指（周遍性）：疑问词被「都/也」吞掉，整句是在说「全部」，不是在问。
   *
   * 「什么都别改」「哪一步都不能跳过」「怎么改都行」「多少个都无所谓」都带着疑问
   * 词，却没有一句在发问 —— 这是汉语里疑问代词的非疑问用法，按词表永远补不完，
   * 按结构判就一次解决：`疑问词 …（近距离）… 都/也/全/总` 就是任指，把疑问词抹掉、
   * 只留「都」。
   *
   * 只抹疑问词而不直接判「不是问句」，是因为「你什么时候都可以吗？」同样是任指
   * 结构，却仍然是真提问 —— 抹掉之后句尾的「吗」还能把它认出来。
   */
  const WH_UNIVERSAL =
    /(什么|啥|哪(?:儿|里|个|些|步|种|样|怕)?|怎么|怎样|咋|多少|谁|几(?:个|种|时)?)[^。！？!?\n]{0,8}?(都|也|全|总)/g
  /**
   * 犹豫语：话说了，但没定。
   *
   * 「不确定」「还没想好」「看情况」「说不好」都是把问题留在原处 —— 用户没有
   * 拍板，只是还没想清楚。按「已回答」处理会让这一类最常见的悬而未决彻底消失，
   * 而那正是这个功能存在的理由。
   */
  const UNCERTAIN_MARKERS = [
    /(不(?:太|怎么|够)?确定|不(?:太|怎么|够)?肯定|没(?:有)?想好|还没想好|没(?:有)?定|还没定|没(?:有)?决定|还没决定)/,
    /(不知道|不清楚|说不好|不好说|拿不准|吃不准|没主意|心里没底)/,
    /(看情况|视情况|再说吧|看吧|看以后|等等看|走着瞧|还没准|不一定)/,
    // 「还没呢」「还没有」 —— 一句话的犹豫，最常见的那种。
    /^(还没|还没有|还没呢|还没有呢|没呢|没有呢)[\s。．.!！~～]*$/,
  ]
  /**
   * 把决定权交回去 —— 这是一种决定，不是没回答。
   *
   * 「都可以」「你定」「随便」「你看着办」听上去像敷衍，实际已经把选择权明确
   * 让渡给了对方，这一轮到此结束。把它算成「没答」会记下一条用户根本没打算再
   * 处理的待办。
   */
  const DELEGATE_MARKERS = [
    /(都可以|都行|随便|随你|依你|听你的|按你的来)/,
    /(你(?:来)?定|你决定|你看着办|你说了算|你选|你挑|你觉得好就行)/,
  ]
  /**
   * 正反问（V 不 V / V 没 V）：汉语句式里的第四类。
   *
   * 「去不去」「行不行」「要不要」都是提问，且不需要问号。原本靠硬编码的
   * 「是不是 / 有没有 / 行不行 / 可不可以」四个词兜着，遇到「去不去」「改不改」
   * 就漏了。这里用一个通用的重复结构判断：同一个字（或同一个双字词）夹在
   * 「不 / 没」两边。这个词法事实取自同一份问句分类代码。
   */
  const POS_NEG = /([\u4e00-\u9fa5])(?:不|没)\1/

  /**
   * Rejecting the offered options, with nothing offered in their place.
   *
   * 「这个不行」 closes one option and opens nothing — the question is still exactly
   * where it was, and the assistant has to come back with something new. 「换一个」
   * is the same request in other words. Both were landing in the default
   * "answered" branch, which is why these kept disappearing from the board.
   *
   * The match alone is not enough: 「不行，太重了」 rejects AND says why, which is
   * direction the assistant can act on, so `looksRejectedOptions` only fires when
   * nothing is left over after the rejection phrase (see `REJECT_RESIDUE_CHARS`).
   */
  const REJECT_OPTION_MARKERS = [
    /(不行|不太行|不合适|不太合适|不喜欢|不满意|不接受|不采纳|不考虑|不靠谱)/,
    /(都|全|俩都|两个都|三个都)[^。！？!?\n]{0,4}不(行|好|合适|靠谱|满意|喜欢|接受|想|要|用|选|要|做)/,
  ]
  /**
   * Asking for a different set of options. This is never an answer — the person
   * has rejected what was on the table and is waiting for more, so it is checked
   * before the "did they explain why" test below.
   */
  const RENEW_OPTION_MARKERS =
    /(换一个|换一个吧|再换一个|换个|换一款|换一版|重来|重做|重新做|再做一遍|再想一个|再给一版|再给几个|还有别的吗|还有其他的吗)/
  /** How much explanation has to follow a rejection for it to count as direction. */
  const REJECT_RESIDUE_CHARS = 2

  /** ...but only when asking the question is what the turn was doing. */
  const ASK_MARKERS = [
    /(要不要|需不需要|是否需要|是否要|可以吗|行吗|好吗|好不好|怎么样|如何)/,
    // 「你想用哪个」「你打算什么时候发」 ask; 「如果你想更快」「你想要的观感」 are
    // conditional clauses and statements. The difference is grammatical, so it has
    // to be required rather than guessed: an interrogative must follow the subject
    // within a few characters, or the sentence must end in a question mark.
    /(你想|你希望|你打算|你更倾向|你倾向|你倾向)[^。！!？?\n]{0,12}(哪|什么|怎么|多少|要不要|是否|几个|几时|什么时候|如何)/,
    /(你想|你希望|你打算|你更倾向|你倾向)[^。！!？?\n]{0,20}[？?]/,
    /请你?(选择|确认|决定|告诉我)/,
    // 「需要我」 alone is a statement, not a question: 「这条流程需要我手动执行
    // memory.mjs」 reads as an explanation of who does what. Found in the field — a
    // 2400-character report whose only candidate was that sentence, so a turn that
    // asked nothing was recorded as an open question. The offer has to be phrased
    // as one to count: a question mark, 吗, or 呢 has to follow it closely.
    /(需要我|要我)[^。！!？?\n]{0,12}[？?吗呢]/,
  ]

  // A turn that ends by asking the person to DO something and report back is
  // still a turn that expects an answer — 「请回我一句：嗯，先放着吧」「试一下，
  // 把结果发我」。Without these the plugin saw only the polite sign-off that
  // usually follows （「回完我立刻查板子。」）and concluded nobody was asked
  // anything. Found in the field: a real question, a new topic next turn, and an
  // empty board.
  const AWAIT_REPLY_MARKERS = [
    /(请|麻烦)(你)?(回|答|告|发|试|跑|给我)(我|一句|一下|一声)?/,
    /(回|答|复|告|发|给)我(一句|一下|一声|个|下|吧)?/,
    /你(试|跑|点|看|确认|检查|核对)(一?下|一?遍|看)?/,
    /把(结果|这个|那个|它|日志|报错)[^。！!？?\n]{0,8}(发|贴|告|回|传|给我)/,
    /(告诉|通知|汇报|反馈)(我|一下|一声)/,
  ]

  /**
   * Signs that a message is asking for NEW work rather than answering a question.
   *
   * This is the discriminator that decides whether a pending question was walked
   * away from. It is deliberately the only one: see `looksAnswered` for why the
   * test is biased toward silence.
   */
  const REQUEST_MARKERS = [
    /(帮我|请你?帮|麻烦你?|给我|替我)/,
    /(能不能|可不可以|可不可以帮|可以帮我)/,
    /(我要你|我想要|我需要你|我想让你|我要做|我想做)/,
    // An imperative that opens the message. Leading adverbs are allowed through
    // because 「先把首页轮播改成自动播放」 is the ordinary shape of a new request
    // and it was falling through to "they are still thinking about my question" —
    // exactly backwards.
    //
    // The adverbs are followed by an optional topic and an optional adverb-ish
    // particle on purpose: 「另外，这个也要改」 names the thing before the verb,
    // and anchoring straight onto the verb missed it. 「然后按这个跑一遍」 puts a
    // preposition in front of the topic as well. Only a short, closed set of
    // fillers is allowed through — letting any words in would turn ordinary
    // sentences ("这个方案可以") into requests.
    /^(先|再|然后|接着|顺便|另外|还有|再者|还是先)*[，,、：:\s]*(按|照|用|拿|把)?(这个|那个|它|这里|那里|这儿|那儿|这些|那些)?(也|都|还|再|要|得|一下)*(删掉|清掉|移掉|停掉|砍掉|撤掉|干掉|去掉|取消|改|修|加|删|做|写|生成|检查|看|跑|部署|实现|优化|重写|补|导出|总结|整理|把|换|清|移|停|启动|安装|卸载|刷新|重载|重启|重连|拉取|推送|提交|回滚|合并|打包|上线|发版|同步|备份|迁移|替换|保存|打开|关掉|关闭|删除|新增|添加|调整|更新|升级|降级|压缩|转|复制|粘贴|下载|上传)(?!好|完|过|成|了|错|对|掉|动|正)/,
    // 「重做一遍」「再改改」「你重做一遍」 —— the imperative does not have to be the
    // very first character; a short lead-in is normal speech. Anchored to a closed
    // set of redo verbs so ordinary statements do not become requests.
    /(重做|重来|再改改|再改一下|再试一遍|再跑一遍|再来一遍|再做一次)/,
  ]

  /**
   * Whether a message is itself asking something.
   *
   * Only used to decide whether a reply ENGAGED with the question it followed.
   * Someone who answers a question with "你是说 A 还是 B？" has not settled
   * anything, and someone who opens a whole new question ("第二件事用什么方案")
   * has plainly moved on — both are the case worth remembering, not an answer.
   */
  const ASKING_WORDS =
    /(什么|啥|哪|怎么|咋|为什么|为啥|多少|是否|多久|几(?:个|种|点|号|次|天|年)|几点|干什么|干嘛|是不是|有没有|行不行|可不可以)/

  /**
   * 「你觉得呢」「你说呢」「那你觉得呢」 —— 把问题推回去，什么都没定。
   *
   * These read like engagement, so the default branch ("they are thinking about
   * it") swallowed them. But the person has answered a question with another
   * question and is waiting on the assistant — the opposite of settled.
   */
  const ASK_BACK_MARKERS =
    /(你觉得呢|你看呢|你说呢|你认为呢|你怎么看|你怎么想|你觉得如何|你看着呢|您觉得呢|那你呢|你呢|你确定吗|你确定|这样对吧|对吧|是吧|对吗|是这样吗)/

  /**
   * Whether the text is really asking something.
   *
   * Modelled on the five Chinese question types (是非问 / 特指问 / 选择问 /
   * 正反问 / 反问句) rather than on a flat list of words, because the list is what
   * kept getting fooled:
   *
   *   - 「没什么问题」 and 「怎么样都行」 carry question words and are not
   *     questions. They are stripped first (`ASK_WORD_NEUTRAL`) so the words
   *     inside a fixed phrase cannot vote.
   *   - 「去不去」「改不改」 ask without a question mark or a wh-word at all; that
   *     is the 正反问 pattern `V 不 V`, matched structurally rather than by
   *     enumerating every verb.
   *   - 「A 还是 B」 is 选择问 and always a question.
   *   - A sentence ending in 吗/么 asks; one ending in 呢/吧/啊 only leans that way,
   *     so it needs a question mark or a wh-word as well.
   *   - 「难道你不觉得…？」 is 反问句: a rhetorical sentence wearing a question
   *     mark. It is an opinion, not a question, and nobody owes it an answer.
   */
  function looksInterrogative(text) {
    const body = typeof text === 'string' ? text.trim() : ''
    if (body === '') return false
    // Rhetorical questions are not questions. Tested first, because they are
    // shaped exactly like the ones below — question words, question mark and all
    // — and would otherwise always match.
    if (RHETORICAL_MARKERS.test(body)) return false
    // Words inside quotes belong to somebody else — usually the person being read
    // back to themselves. 「11/10 当天你问我「今天干什么」，我会给你具体的时间卡」
    // is a report, yet the quoted 什么 made the whole line read as a question and
    // the turn was captured as open (live evidence: a card titled 「待拍板：b」).
    let stripped = body.replace(QUOTED_SPAN, ' ')
    // Strip fixed phrases that merely contain a question word, then judge what
    // is left: 「没什么问题，就这样吧」 must not read as a question.
    stripped = stripped.replace(ASK_WORD_NEUTRAL, ' ')
    // Then drop wh-words that are doing universal work rather than asking
    // (「什么都别改」「怎么改都行」). Only the wh-word goes; the sentence around it
    // stays, so a genuine question built the same way survives on its 吗/？.
    stripped = stripped.replace(WH_UNIVERSAL, '$2')
    // 「怎么跑的」「哪儿改的」 describe the method, not a question. 的 is what
    // distinguishes them from 「怎么改的？」 which still ends in a question mark —
    // and a bare 「怎么改的」 at the very end of the message stays a question too,
    // which is why this only strips a match that has something after it.
    stripped = stripped.replace(WH_MANNER_DE, ' ')
    if (/[？?]\s*$/.test(stripped)) return true
    // 正反问: 「去不去」「行不行」「改不改」.
    if (POS_NEG.test(stripped)) return true
    // 选择问: 「A 还是 B」.
    if (/还是/.test(stripped)) return true
    // 特指问: a wh-word is doing work in the sentence.
    if (ASKING_WORDS.test(stripped)) return true
    // 是非问: strong modal particles ask even without punctuation; the weak
    // ones (呢/吧/啊) only do so together with a question mark, handled above.
    if (/[吗么]\s*$/.test(stripped)) return true
    // 吗 is a question particle and nothing else — it never appears inside a
    // wh-word (unlike 么, which is why that one stays anchored to the end). So a
    // 吗 ANYWHERE asks, including when the sentence keeps talking afterwards:
    // 「选好了吗，你看看」 「照这样行吗，你看着办」 are questions, not decisions.
    if (/吗/.test(stripped.replace(/吗啡/g, ' '))) return true
    // 「你觉得呢」「你说呢」 ask by construction — no wh-word, no particle, no mark.
    if (ASK_BACK_MARKERS.test(stripped)) return true
    return false
  }

  /**
   * Plain text of one message's text blocks, joined.
   *
   * Deliberately does NOT check role or source: callers know which side of the
   * conversation they are holding, and `userTextOf` (the planning nudge's copy)
   * must keep its stricter "a real human message" rule for its own reasons.
   */
  function messageTextOf(message) {
    if (message === null || typeof message !== 'object') return ''
    if (!Array.isArray(message.content)) return ''
    let text = ''
    for (const block of message.content) {
      if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        text += block.text + '\n'
      }
    }
    return text
  }

  /**
   * Whether a reply means "I read your question" rather than "next topic".
   *
   * The rules here are the user's own, in his own words, because the first
   * version of this function got Chinese conversational context badly wrong:
   *
   *   1. 「算」 — a bare acknowledgement answers. 「嗯」「好」「行」 are answers.
   *      But the user's caveat was 「注意是不是只回答嗯这些，后面如果还有别的回复
   *      还要审查一下」: if the message keeps talking after the 「嗯」, the rest
   *      decides, not the acknowledgement. That is why `BARE_ACK` is anchored to
   *      the whole message and `ACK_PREFIX` only strips a leading concession.
   *   2. 「先放着不算，是暂时搁置的意思」 — deferring is NOT answering. A parked
   *      question is precisely the thing this feature exists to remember, so
   *      `DEFERRED_MARKERS` returns "not answered".
   *   3. 「多个问题只回答一个算做出回复」 — answering ANY one of the round's
   *      questions counts as having engaged with it. That is why this function
   *      never needs to count questions: engaging at all wins.
   *   4. …「除非有明确说明其他问题还要考虑回头再说」 — the exception. When the
   *      reply itself defers the remainder, those leftovers are open and the
   *      board has to carry them.
   *
   * Below that, the original bias still governs: writing a reminder the user did
   * not want is noise they must clean up, so only a reply that reads as a fresh
   * request (or a fresh question) counts as walking away.
   */
  function looksAnswered(text, askText) {
    const body = typeof text === 'string' ? text.trim() : ''
    // Nothing said at all cannot be walking away from anything.
    if (body === '') return true
    // Rule 1, the narrow form: a message that IS only an acknowledgement.
    if (BARE_ACK.test(body)) return true
    // Rule 2: parking the question leaves it open, and no other marker here
    // should be allowed to hide that — 「行，那两个先放着」 concedes but defers.
    if (looksDeferred(body)) return false
    // 「都可以」「你定」「随便」 hand the choice back — that closes the question even
    // when the sentence is shaped like a question or admits doubt:
    // 「随便，你觉得哪个好就用哪个」 carries 哪, 「不知道，你决定吧」 carries 不知道.
    // An explicit hand-back outranks both: the next move is the assistant's, so a
    // reminder saying "the AI is waiting on you" would simply be false.
    if (looksDelegated(body)) return true
    // Still chewing on it. 「不确定」「还没想好」「看情况」 are the most common
    // shape of an undecided question and used to fall through to "answered".
    if (looksUncertain(body)) return false
    // Throwing the offered options away without naming a replacement leaves the
    // question exactly where it was: 「这个不行」「A 和 B 都不太行」「换一个」.
    if (looksRejectedOptions(body)) return false
    // Rule 4: answering some and deferring the rest still leaves work on the
    // table, and that is exactly what a reminder is for.
    if (looksRevisit(body)) return false
    // A reply that is ITSELF a question settled nothing, and this has to be
    // decided before any decision word gets a vote. 「定了吗，还是要改」「按这个来
    // 行不行，你确认下」 carry 定/按 (decision words) and are still questions —
    // letting the decision markers run first answered them on the user's behalf.
    if (looksInterrogative(body)) return false
    if (looksRefused(body)) return true
    if (looksDecided(body)) return true
    // Rule 1, the wide form: a leading 「行」/「好」 concedes, and whatever
    // follows is judged on its own merits rather than decided by the prefix.
    const afterAck = body.replace(ACK_PREFIX, '').trim()
    if (afterAck !== '' && afterAck !== body) {
      if (looksDeferred(afterAck)) return false
      if (looksDelegated(afterAck)) return true
      if (looksUncertain(afterAck)) return false
      if (looksRevisit(afterAck)) return false
      if (looksInterrogative(afterAck)) return false
      if (looksRefused(afterAck)) return true
      if (looksDecided(afterAck)) return true
    }
    // 「改标题吧」 answering 「你想改标题还是改图？」 is a CHOICE, and the imperative
    // marker for 改 was reading it as fresh work — recording the very question the
    // person had just answered. Checked before the request markers for that reason,
    // and it needs the ask text to do it: without something to echo it refuses.
    if (looksChoseByEcho(body, askText)) return true
    // "帮我改改标题" after being asked a question means they moved on — and the
    // length test that used to guard this was wrong, because the shortest
    // possible new request ("改标题") is exactly the case that must be caught.
    for (const pattern of REQUEST_MARKERS) if (pattern.test(body)) return false
    // Everything else is someone reading, choosing, or thinking. Keep quiet.
    return true
  }

  /** Whether the assistant's closing words were a question aimed at the user. */
  function looksAsked(text) {
    const body = typeof text === 'string' ? text : ''
    if (body.trim() === '') return false
    const tail = body.slice(-AUTO_ASK_TAIL)
    // 反问句 wears a question mark but asks nothing — 「难道还需要我提醒你吗」 is
    // an opinion. Treating it as a question invents a reminder for something the
    // assistant already decided.
    if (RHETORICAL_MARKERS.test(tail)) return false
    const last = tail.replace(/[\s"'”’」』）)]+$/, '')
    // A trailing question mark is the strongest signal there is, and the one the
    // model itself chose to use. Everything below is a fallback for the turns
    // that ask without punctuating.
    if (last.endsWith('？') || last.endsWith('?')) return true
    // MOST questions are not the last sentence, they are the second to last:
    // "要提到 80% 吗？这会拖慢 CI，你决定。" asks plainly and then keeps talking.
    // Judging only by the final character dropped every one of those, which is
    // the shape of a real answer rather than an edge case — so the last LINE is
    // checked as well, not just the last character.
    const lastLine = tail.split(/\n+/).filter((l) => l.trim() !== '').pop() ?? ''
    if (/[？?]/.test(lastLine)) return true
    // The last line is where a question actually lives, so the full five-type test
    // is run on it. Without this, 特指问 without a question mark — 「用哪个方案」
    // 「走哪条路」 — read as a statement, and a genuine question went unrecorded.
    // Only the LAST line is tested on purpose: an assistant explaining something
    // mentions 「什么」 constantly, and testing the whole message would make almost
    // every turn look like a question.
    if (looksInterrogative(lastLine)) return true
    for (const pattern of ASK_MARKERS) if (pattern.test(tail)) return true
    // A sign-off after the question is the ordinary shape, not an edge case:
    // 「请回我一句：嗯，先放着吧」 … 「回完我立刻查板子。」 Ended by an instruction
    // to go do something and report back, that turn is still waiting on a person.
    // Checked over the whole tail rather than the last line, because the request
    // and the sign-off are usually different lines.
    for (const pattern of AWAIT_REPLY_MARKERS) if (pattern.test(tail)) return true
    return false
  }

  /** Whether a reply reads as "I have decided" rather than "here is another thing". */
  function looksDecided(text) {
    const body = typeof text === 'string' ? text : ''
    if (body.trim() === '') return false
    for (const pattern of DECIDED_MARKERS) if (pattern.test(body)) return true
    return false
  }

  /** Whether a reply closes the matter with "no" — 「不用了」「算了」. */
  function looksRefused(text) {
    const body = typeof text === 'string' ? text : ''
    if (body.trim() === '') return false
    for (const pattern of REFUSED_MARKERS) if (pattern.test(body)) return true
    return false
  }

  /**
   * Whether a reply is PARKING the question rather than answering it.
   *
   * 「先放着」 is the case the user called out by name: it means "not now, and
   * not because I decided anything". A parked question is still open, so this is
   * the one signal that has to beat the decision markers — 「行，先放着吧」 reads
   * as agreement but settles nothing, and recording it as answered is how the
   * board quietly loses the item a person most wants to be reminded of.
   */
  function looksDeferred(text) {
    const body = typeof text === 'string' ? text : ''
    if (body.trim() === '') return false
    for (const pattern of DEFERRED_MARKERS) if (pattern.test(body)) return true
    return false
  }

  /** Whether a reply answers some questions and explicitly defers the rest. */
  function looksRevisit(text) {
    const body = typeof text === 'string' ? text : ''
    if (body.trim() === '') return false
    for (const pattern of REVISIT_MARKERS) if (pattern.test(body)) return true
    return false
  }

  /**
   * Whether a reply rejects what was offered without choosing anything else.
   *
   * 「这个不行」 closes one option and opens nothing — the question is unanswered.
   * 「换一个」 asks for a new set to pick from. Both were landing in the default
   * "answered" branch.
   */
  function looksRejectedOptions(text) {
    const body = typeof text === 'string' ? text.trim() : ''
    if (body === '') return false
    // Asking for another set of options is always unanswered, however it is
    // phrased: 「换一个」 「还有别的吗」 do not pick anything.
    if (RENEW_OPTION_MARKERS.test(body)) return true
    for (const pattern of REJECT_OPTION_MARKERS) {
      const match = pattern.exec(body)
      if (match === null) continue
      // Whatever FOLLOWS the rejection is direction: 「不行，太重了」 and
      // 「这个不行，换成那个圆角的」 both tell the assistant what to do next, so the
      // question is answered even though the option was refused. Only a bare
      // rejection leaves it open. What comes BEFORE is just which option was
      // being talked about — 「这个不行」 names the subject, not a next step.
      const rest = body.slice(match.index + match[0].length).replace(/[\s。．.!！~～，,、]+/g, '')
      return rest.length < REJECT_RESIDUE_CHARS
    }
    return false
  }

  /**
   * Whether a reply is visibly still undecided.
   *
   * 「不确定」「还没想好」「看情况」 say nothing about WHICH way the person leans,
   * only that they have not picked. 「说不好」 is a hedge, not a decision — and it
   * reads as agreement to a keyword matcher, which is how these were being
   * recorded as answered and then silently dropped from the board.
   */
  function looksUncertain(text) {
    const body = typeof text === 'string' ? text : ''
    if (body.trim() === '') return false
    for (const pattern of UNCERTAIN_MARKERS) if (pattern.test(body)) return true
    return false
  }

  /**
   * Whether a reply hands the decision back to the assistant.
   *
   * 「都可以」「你定」「随便」 look like brush-offs and are actually the opposite:
   * the person has decided that they do not want to decide. The round is over,
   * and a reminder that says "the AI is waiting on you" would be false.
   */
  function looksDelegated(text) {
    const body = typeof text === 'string' ? text : ''
    if (body.trim() === '') return false
    for (const pattern of DELEGATE_MARKERS) if (pattern.test(body)) return true
    return false
  }

  /**
   * A reply that echoes one of the options the assistant just offered, and stops.
   *
   * 「改标题吧」 answering 「你想改标题还是改图？」 is a choice — and the imperative
   * marker for 改 was reading it as fresh work, which recorded the very question
   * the person had just answered. The give-away is that the thing they named was
   * literally on the table a moment ago; 「刷新一下吧」 said to an assistant that
   * never offered a refresh is an order and stays one.
   *
   * So this needs the ask text, and refuses to answer without it: short-plus-吧
   * alone covers 「用那个吧」 (a choice) and 「重启一下服务吧」 (an order) alike, and
   * guessing "answered" on that evidence would silently drop real requests.
   */
  const ECHO_REQUEST_FRAMING = /(帮我|请你?|麻烦|给我|替我|能不能|可不可以|我要你|我想要你|需要你)/
  const ECHO_TAIL = /(吧|了|就行|就好|就成|可以|成|好|对)$/
  /** Longer than this and it is prose, not an echo of one option. */
  const ECHO_MAX_CHARS = 14
  /** No suffix shorter than this can tell one option from another. */
  const ECHO_MIN_STEM = 2
  /** The shapes that make a question a yes/no one rather than an either/or. */
  const YES_NO_ASK = /(要不要|需不需要|是否需要|是否要|有没有必要|该不该|是不是该|要不要先|吗)/

  function looksYesNoAsk(text) {
    const body = typeof text === 'string' ? text : ''
    return body.trim() !== '' && YES_NO_ASK.test(body)
  }

  function looksChoseByEcho(text, askText) {
    const body = typeof text === 'string' ? text.trim() : ''
    if (body === '') return false
    if (body.length > ECHO_MAX_CHARS) return false
    if (ECHO_REQUEST_FRAMING.test(body)) return false
    const trimmed = body.replace(/[\s。．.!！~～]+$/, '')
    // 「先放着吧」「再说吧」 end the same way and mean the opposite; they are caught
    // by the deferral check before this ever runs, but guard again at the source.
    if (looksDeferred(body) || looksUncertain(body)) return false
    const asked = typeof askText === 'string' ? askText : ''
    if (asked.trim() === '') return false
    const offered = asked.replace(/[，,、。．.？?！!；;：:\s]+/g, '')
    const bare = trimmed.replace(/[，,、\s]+/g, '')
    // An exact echo of what was offered needs no 吧/了 to prove itself: answering
    // 「先做登录还是先做支付？」 with 「先做登录」 is a choice even though it closes
    // like an instruction. Requiring the whole reply (not a suffix) keeps it tight —
    // 「做登录页吧」 said unprompted is still an order.
    if (bare.length >= ECHO_MIN_STEM && offered.includes(bare)) return true
    // A yes/no question answered by naming HOW to do it: 「要不要先加超时？」
    // → 「加个 3 秒的吧」. The spec is new, but the verb came straight from the
    // question, so agreeing is what the reply is doing.
    //
    // Guarded to yes/no asks on purpose. In a choice question (「先做登录还是先做
    // 支付？」) the reply has to name one of the offered items —「做登录页吧」 invents
    // a third thing and is an order, so it must not ride the verb through.
    const lead =
      looksYesNoAsk(asked) && !/还是/.test(asked)
        ? /^(?:先|再|然后|就)?(删掉|清掉|移掉|停掉|砍掉|撤掉|干掉|去掉|取消|改|修|加|删|做|写|生成|检查|看|跑|部署|实现|优化|重写|补|导出|总结|整理|换|清|移|停|启动|安装|卸载|刷新|重载|重启|合并|打包|上线|发版|同步|备份|迁移|替换|保存|打开|关闭|删除|新增|添加|调整|更新|升级|降级|压缩|复制|下载|上传)/.exec(
            bare,
          )
        : null
    if (lead !== null && offered.includes(lead[1])) return true
    if (!ECHO_TAIL.test(trimmed)) return false
    const stem = trimmed.replace(ECHO_TAIL, '').replace(/[，,、\s]+/g, '')
    if (stem.length < ECHO_MIN_STEM) return false
    // Longest suffix of what they said, matched against what was offered:
    // 「那就分页吧」 still echoes an offer of 分页.
    for (let from = 0; from <= stem.length - ECHO_MIN_STEM; from += 1) {
      if (offered.includes(stem.slice(from))) return true
    }
    return false
  }

  /**
   * Whether a mid-turn remark actually settles the question the turn is asking.
   *
   * Stricter than `looksAnswered` on purpose. Answering the closing question is
   * a positive act — 「行，就按字母排」, 「不用了」, 「嗯」 — while "still reading"
   * is not, and a steer that merely comments must leave the question open. The
   * deferring words win here too: 「行，先放着」 concedes and parks, which is not
   * a settlement.
   */
  function settlesQuestion(text, askText) {
    const body = typeof text === 'string' ? text.trim() : ''
    if (body === '') return false
    if (looksDeferred(body)) return false
    // An explicit hand-back closes the question even when it also admits doubt —
    // 「不知道，你决定吧」 is both, and the hand-back is the operative half. Same
    // ordering as `looksAnswered`, so the two never disagree.
    if (looksDelegated(body)) return true
    if (looksUncertain(body)) return false
    // Answering one question and deferring the rest is the exception the user
    // called out — 「就按第一个来，剩下的问题再说」 settles the first and leaves
    // the remainder open, so the turn must not be closed as answered.
    if (looksRevisit(body)) return false
    // A question cannot settle anything. 「定了吗，还是要改」 and 「按这个来行不行，
    // 你确认下」 both carry decision words and are still asking — the same trap
    // `looksAnswered` has, and settling the turn on a question would cancel the
    // reminder the question was going to produce.
    if (looksInterrogative(body)) return false
    if (BARE_ACK.test(body)) return true
    if (looksRefused(body)) return true
    if (looksDecided(body)) return true
    // 「改标题吧」 is the ordinary way to pick one of the options just offered.
    if (looksChoseByEcho(body, askText)) return true
    const afterAck = body.replace(ACK_PREFIX, '').trim()
    if (afterAck !== '' && afterAck !== body) {
      if (looksDeferred(afterAck)) return false
      if (looksDelegated(afterAck)) return true
      if (looksUncertain(afterAck)) return false
      if (looksRevisit(afterAck)) return false
      if (looksInterrogative(afterAck)) return false
      if (looksRefused(afterAck)) return true
      if (looksDecided(afterAck)) return true
      if (looksChoseByEcho(afterAck, askText)) return true
    }
    return false
  }

  /**
   * Ask the session's own model whether the reply settled the question.
   *
   * The keyword lists encode what happened in one language on one afternoon; a
   * model reads what the sentence MEANS. That matters most for exactly the
   * shapes the lists keep getting wrong — 「嗯，先放着吧」 (a bare 嗯 that turns
   * out to be a deferral), 「行，那两个回头再说」 (one answered, one deferred),
   * 「都可以，你定」 (a real answer, no keyword in it).
   *
   * Returns `undefined` for every kind of failure — no llm service, no model
   * route, a timeout, an abort, an answer that is not one of the three words.
   * `undefined` means "use the heuristics", never "assume answered": falling back
   * to the previous behaviour is the safe direction, because a wrongly recorded
   * reminder is noise the user must clear.
   */
  const AUTO_JUDGE_TIMEOUT_MS = 8000
  const AUTO_JUDGE_MAX_TOKENS = 8
  const AUTO_JUDGE_SYSTEM = [
    '你在判断一段中文对话里，用户有没有对 AI 最后提出的问题作出决定。',
    '只回一个词：ANSWERED、OPEN 或 DEFERRED。',
    'ANSWERED：用户作答了——选了方案、给了方向、明确否掉，或只说「嗯」「好」「行」「可以」等表示认可。',
    'DEFERRED：用户把问题搁置了——「先放着」「回头再说」「我再想想」「暂时搁置」，或答复里明说其余部分还要再议。',
    'OPEN：用户完全没理会这个问题，直接说别的事、提了新需求，或用另一个问题回应。',
    '拿不准时回 OPEN，不要回 ANSWERED。',
  ].join('\n')

  function autoModelSelection(sessionId) {
    const rootCtx = ctx.root === undefined ? ctx : ctx.root
    const agents = rootCtx.get('agents')
    if (agents !== undefined && agents !== null) {
      try {
        const agent = agents.get(sessionId)
        if (agent !== undefined && agent !== null) {
          const selection = modelSelection(agent)
          if (selection !== undefined) return selection
        }
      } catch (err) {
        /* fall through to the harness default route */
      }
    }
    return modelSelection(undefined)
  }

  /** ANSWERED → true, anything else parseable → false, unparseable → undefined. */
  function parseVerdict(text) {
    const body = typeof text === 'string' ? text.trim().toUpperCase() : ''
    if (body === '') return undefined
    if (body.includes('DEFERRED') || body.includes('OPEN')) return false
    if (body.includes('ANSWERED')) return true
    // The model was told to answer with one English word; a Chinese answer is a
    // sign it ignored the contract rather than a verdict worth trusting.
    return undefined
  }

  async function judgeWithModel(sessionId, unit, replyText) {
    const llm = ctx.get('llm')
    if (llm === undefined || llm === null) return undefined
    const selection = autoModelSelection(sessionId)
    if (selection === undefined) return undefined
    const ask = condenseText(unit.askText, AUTO_NOTE_CHARS)
    const reply = condenseText(replyText, AUTO_NOTE_CHARS)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), AUTO_JUDGE_TIMEOUT_MS)
    let text = ''
    try {
      for await (const chunk of llm.stream({
        provider: selection.provider,
        model: selection.model,
        system: AUTO_JUDGE_SYSTEM,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'AI 的问题：\n' + ask + '\n\n用户的回复：\n' + reply }],
          },
        ],
        maxTokens: AUTO_JUDGE_MAX_TOKENS,
        temperature: 0,
        signal: controller.signal,
      })) {
        if (chunk !== null && typeof chunk === 'object' && chunk.type === 'text-delta') {
          text += chunk.text
        }
      }
    } catch (err) {
      log('warn', 'todo-board: 模型判定失败，改用本地判定（会话=' + sessionId + '）', err)
      return undefined
    } finally {
      clearTimeout(timer)
    }
    return parseVerdict(text)
  }

  /** Squeeze one block of prose into a single scannable line. */
  function condenseText(text, max) {
    let body = typeof text === 'string' ? text : ''
    body = body.replace(/```[\s\S]*?```/g, ' ')
    body = body.replace(/`[^`]*`/g, ' ')
    body = body.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    body = body.replace(/https?:\/\/\S+/g, ' ')
    body = body.replace(/[#>*_~]/g, ' ')
    body = body.replace(/\s+/g, ' ').trim()
    if (body.length <= max) return body
    return body.slice(0, max).replace(/[\s，,。.;；:：、]+$/, '') + '…'
  }

  /**
   * The row's title: what the person will recognise, plus what is being waited on.
   *
   * The USER's own words come first because that is what they will search their
   * memory for; the assistant's question is the fallback for a round that opened
   * without a clear request.
   *
   * It has to be a SUMMARY, not a truncated first line — the user asked for
   * 「概括关键信息，一眼明白」, and dumping forty characters of "帮我看看这个方案
   * 能不能上生产，我担心并发顶不住" off the front of a paragraph is not that.
   * `summarizeTopic` strips the request framing, keeps the clause that carries
   * the actual question, and prefixes the subject when there is one.
   */
  function autoTitle(unit) {
    const asked = () => {
      const topic = summarizeTopic(unit.userText, AUTO_TITLE_TOPIC_CHARS)
      // The assistant's side is named by `summarizeQuestion`, not by
      // `summarizeTopic`: an assistant turn is an essay that asks at the end, so
      // scanning it from the front picks an aside out of the middle. `summarizeTopic`
      // is still the fallback for the turns whose closing sentence is a plain
      // statement ("你决定就好") and carries nothing to name.
      const question = summarizeQuestion(unit.askText, AUTO_TITLE_TOPIC_CHARS)
      const said = summarizeTopic(unit.askText, AUTO_TITLE_TOPIC_CHARS)
      // What the row is FOR decides which sentence names it. The reminder says
      // 「AI 在等你定」, so the name belongs to the question that is still open.
      //
      // Which of the two questions that is depends on whether the person's own
      // question got answered, and the length of the reply is the only honest proxy
      // available here:
      //   · A one-line reply ("放仓库根目录还是 ci 目录？") is a question BACK. The
      //     person's question is still open, and its subject (「A 项目的部署脚本」)
      //     is the part that makes the card mean something.
      //   · A thousand-character answer has answered it. The open thing is the
      //     follow-up on the end; naming the answered question instead produced
      //     「待拍板：为什么说当前请求的额度已用尽」 for a question that had just
      //     been answered in full, so the card read as though nothing had been said.
      const longReply = typeof unit.askText === 'string' && unit.askText.length > AUTO_TITLE_LONG_REPLY
      // The order below is the preference; `polishTitle` is the veto. A candidate
      // that names nothing is skipped and the next one is tried, because the card
      // is read before it is clicked and 「待拍板：b」 tells the reader nothing.
      const candidates = []
      const offer = question !== '' && ASK_OFFER.test(question) && !looksVagueQuestion(question)
      if (offer) candidates.push(question)
      if (longReply && question !== '' && !looksVagueQuestion(question)) candidates.push(question)
      if (topic !== '' && TITLE_ASK_CUE.test(topic)) candidates.push(topic)
      if (topic !== '') candidates.push(topic)
      if (question !== '') candidates.push(question)
      // `said` exists for the short turn whose closing line is a plain statement
      // ("你决定就好") and therefore has nothing to quote. On a long turn it is
      // just a slice out of an essay, and naming the card after it produced
      // 「待拍板：已记下 B：接下来两天怎么走 - 明天（11/09」 — the session name is
      // the more honest answer there.
      if (!longReply && said !== '') candidates.push(said)
      for (const candidate of candidates) {
        const named = polishTitle(candidate)
        if (named !== '') return named
      }
      const where = unit.sessionTitle !== '' ? unit.sessionTitle : dirLabel(unit.dirPath)
      return where !== '' ? where : '一个还没定下来的问题'
    }
    // The cap is on the WHOLE title, not on the topic. 「待拍板：」 is four
    // characters of the budget and the ellipsis is one more, so a topic-only cap
    // quietly produced titles fifty characters wide on a card built for forty.
    const title = AUTO_TITLE_PREFIX + asked()
    if (title.length <= AUTO_TITLE_CHARS) return title
    return title.slice(0, AUTO_TITLE_CHARS - 1).replace(/[\s，,。.;；:：、]+$/, '') + '…'
  }

  const TITLE_LEAD = /^(?:帮我|请你?|麻烦你?|给我|替我|我想要?|我需要你|我要你|能不能|可不可以|可不可以帮|可以帮我|请)+/
  const TITLE_JOIN = /^(?:但是|不过|然后|另外|而且|所以|因为|就是|只是|还有|以及|或者|的话)/
  const TITLE_ASK_CUE =
    /(能不能|要不要|该不该|会不会|有没有|是不是|行不行|可不可以|是不是该|怎么|怎样|如何|哪|什么|啥|多少|是否|还是|should i|shall i|do you|would you|which|whether)/

  // Words that ask but say nothing. 「你更倾向哪一个」is a real question and a
  // useless title: the card would say a decision is pending without saying about
  // what. When the assistant's closing question reduces to these, the subject has
  // to come from the person's own words instead.
  //
  // Verbs are deliberately NOT in this list — 「要不要我先做个登录页」strips down
  // to 「先做个登录页」and that object is the whole point of naming it.
  // Above this, the assistant said enough to have answered what the person asked,
  // so the still-open thing is the follow-up it tacked on at the end. Below it, the
  // assistant only asked something back and the person's own question is untouched.
  const AUTO_TITLE_LONG_REPLY = 240
  const VAGUE_TOKENS =
    /(?:你们|你|您|我们|我|的|了|呢|吗|吧|啊|呀|嘛|那|这|这个|那个|这里|那里|它|想|要|希望|觉得|认为|更|比较|倾向|偏好|选择|选|应该|该|是否|要不要|需不需要|是不是|能不能|可不可以|行不行|该不该|还是|或者|和|与|及|一下|怎么|怎样|如何|什么|啥|哪些|哪种|哪个|哪|几|多少|为什么|确定不了|看|说|办|决定|就好|可以|就行|继续|接着)/g

  function looksVagueQuestion(text) {
    if (typeof text !== 'string') return true
    const body = condenseText(text, 60).replace(/[，,。．.!！？?；;：:、\s\u2026]+/g, '')
    const rest = body.replace(VAGUE_TOKENS, '')
    return rest.length < 6
  }

  // A name can pass every shape check and still say nothing. Live evidence from
  // the running Host: 「待拍板：b」 — the person's whole message was the single
  // letter that picked option B — and 「待拍板：生效了」. Both were real sentences,
  // so nothing earlier rejected them; they were just not about anything. And
  // 「待拍板：要不要我标掉或处理，你」 was a question clipped mid-clause by the
  // sentence split. A card is read before it is clicked, so the name has to clear
  // a floor on how much it actually says.
  const TITLE_MIN_CJK = 4

  /** Drop a person/tone particle the sentence splitter left hanging on the end. */
  function trimDanglingTail(text) {
    let out = typeof text === 'string' ? text.trim() : ''
    for (let guard = 0; guard < 3; guard += 1) {
      const next = out.replace(/[，,、；;：:]?\s*(?:你|您|我|他|她|它|咱们|我们)\s*$/, '').trim()
      if (next === out) break
      out = next
    }
    return out.replace(/[，,、；;：:]+$/, '').trim()
  }

  /** Whether a candidate actually names something to decide. */
  function polishTitle(text) {
    const body = trimDanglingTail(text)
    if (body === '') return ''
    const cjk = (body.match(/[\u4e00-\u9fa5]/g) || []).length
    const latin = (body.match(/[A-Za-z]+/g) || []).length
    // Two Latin words are enough to name a thing ("Redux 还是 Zustand"); one
    // letter is not a topic, it is an answer.
    if (cjk < TITLE_MIN_CJK && latin < 2) return ''
    // A name that stops inside a bracket or after a connective was cut, not made.
    if (/[（(【\[「《-]$/.test(body)) return ''
    return body
  }

  // A sentence earns 「this is the question」 by its shape, not by containing a
  // cue word somewhere in the middle. The assistant writes 「是否」 「什么」 「怎么」
  // all over a long explanation; only the closing sentence is addressed to the
  // person. Real evidence: a 6600-character answer was titled 「待拍板：是否真的
  // 执行取决于模型在上下文快满那一刻是否自觉照做」 — a statement from the middle
  // of the report — while the actual ask was the last line, 「要我改阈值，告诉我
  // 一声」.
  const QUESTION_OPEN =
    /^(?:那|那么|所以|然后)?[，,]?\s*(要不要|要我|需要我|需不需要|需不需要我|是不是|能不能|可不可以|行不行|该不该|是否|还是|你(?:想|要|希望|觉得|更倾向)|确定不了)/
  const QUESTION_SOFT_END = /(吗|呢)[\s。．.!！~～]*$/
  // 「告诉我一声」 is the politeness after the ask, not part of it. 「你说一声」 is
  // the same tail with the subject left in, which the live Host produced as
  // 「待拍板：要不要我标掉或处理，你」 — the sentence split had cut the tail off and
  // kept the pronoun.
  const QUESTION_NUDGE_TAIL =
    /[，,、]?\s*(告诉我一声|告诉我一下|告诉我|回我一句|回我一下|跟我说一声|说一声|你来说一声|你说一声|你决定|你看着办|你定)[\s。．.!！~～？?]*$/

  /**
   * Where the last question could have started inside a run-on sentence.
   *
   * Group 1 is the opener itself, so the match length minus that gives the cut.
   * 「另外」「那」 are included because they are how a Chinese sentence pivots
   * from explaining to asking. 「还是」 is deliberately NOT an opener: it sits in
   * the MIDDLE of a choice question (「要我现在就重启，还是你自己来」), and cutting
   * there left titles like 「还是你自己来」 that name the alternative instead of
   * the decision.
   */
  const ASK_CLAUSE_START =
    /(?:^|[。！!？?；;\n，,、\s])(?:那|那么|所以|然后|另外|还有|最后|总之)?[，,]?\s*(要不要|要我|需要我|需不需要我?|是不是|能不能|可不可以|行不行|该不该|是否)/g

  /**
   * A closing line that offers to DO something is always the open item.
   *
   * 「要不要我把这两条删掉重来」 and 「要我现在就重启，还是你自己来」 both leave the
   * person with a switch in front of them, so the card belongs to that line — even
   * when the reply was short and even when the person's own message was also a
   * question. A question BACK (「放仓库根目录还是 ci 目录？」) is not one of these:
   * it asks the person for a fact, not for a go-ahead, and there the subject of
   * their own question is what the card has to say.
   */
  const ASK_OFFER = /^(?:那|那么)?[，,]?\s*(要不要|要我|需要我|需不需要我?|是不是要我|我可以?帮我)/

  /** Whether one clause is shaped like something addressed to the reader. */
  function looksQuestionClause(part) {
    const body = typeof part === 'string' ? part.trim() : ''
    if (body.length < 4) return false
    if (/[？?]/.test(body)) return true
    if (QUESTION_SOFT_END.test(body)) return true
    if (QUESTION_OPEN.test(body)) return true
    if (/(要不要|需不需要|是不是|能不能|可不可以|行不行|该不该|还是|是否)/.test(body)) return true
    return false
  }

  /**
   * The sentence in an assistant turn that is actually addressed to the person.
   *
   * Assistant turns are essays: they explain, list, quote, and then ask. Scanning
   * from the FRONT therefore finds an aside; the question is at the END. This
   * walks the sentences backwards and takes the last one shaped like a question,
   * so a long report is named after the thing it finally asked.
   */
  function questionSentence(text) {
    const flat = condenseText(text, 20_000)
    if (flat === '') return ''
    const shielded = flat.replace(/(\d)\.(\d)/g, '$1\u0000$2')
    const sentences = shielded.split(/(?<=[。！!？?；;\n])/).map((part) => part.replace(/\u0000/g, '.'))
    for (let i = sentences.length - 1; i >= 0; i -= 1) {
      const raw = sentences[i].trim().replace(TITLE_JOIN, '').trim()
      if (raw === '') continue
      if (looksQuestionClause(raw)) return raw
    }
    return ''
  }

  /** One line naming the open question, taken from the end of the assistant turn. */
  function summarizeQuestion(text, max) {
    const sentence = questionSentence(text)
    if (sentence === '') return ''
    // The sentence walker splits on 。！？；and newlines. When the ask rides on the
    // tail of a long run of prose with no such delimiter — bullets, table cells,
    // an em-dash list — the whole run comes back as one "sentence" and the name
    // becomes thirty characters of whatever preceded the question. Real evidence:
    // 「待拍板：当前为什么没触发 我刚查了上下文状态（ ）： | 项目…」. Cut at the last
    // place a question could have started.
    const opened = lastAskClauseStart(sentence)
    const core = opened > 0 ? sentence.slice(opened) : sentence
    const body = core.replace(QUESTION_NUDGE_TAIL, '').replace(/[？?\s]+$/, '').trim()
    if (body === '') return ''
    return condenseText(body, max)
  }

  /** Index in `sentence` where the final question clause begins, or 0 if unknown. */
  function lastAskClauseStart(sentence) {
    let at = 0
    ASK_CLAUSE_START.lastIndex = 0
    for (;;) {
      const hit = ASK_CLAUSE_START.exec(sentence)
      if (hit === null) return at
      at = hit.index + hit[0].length - hit[1].length
    }
  }

  /**
   * One line that names the decision, built from the person's own sentence.
   *
   * 「帮我看看这个方案能不能上生产，我担心并发顶不住」 becomes 「这个方案能不能
   * 上生产」: the request framing goes, the clause that holds the question stays,
   * and the clause that only explains the worry is dropped. When the first clause
   * is a plain subject rather than a question, it is kept as a prefix so the row
   * still says WHAT is undecided.
   */
  function summarizeTopic(text, max) {
    const flat = condenseText(text, 10_000)
    if (flat === '') return ''
    let body = flat
    // Peel the request framing off the front, repeatedly: 「帮我看看」 「我想给」.
    for (let guard = 0; guard < 4; guard += 1) {
      const next = body.replace(TITLE_LEAD, '').trim()
      if (next === body) break
      body = next
    }
    // A trailing politeness tail is not part of the topic.
    body = body.replace(/[，,、]?\s*(?:谢谢|多谢|辛苦了?|感谢)[\s。．.!！~～]*$/, '').trim()
    if (body === '') return ''
    // A bare ASCII period is a sentence break only when it is not sitting inside a
    // number. Splitting on it unconditionally turned 「旧版 5.1 也一起卸掉」 into
    // 「旧版 5」 plus 「1 也一起卸掉」, and the title kept the half without the verb.
    const shielded = body.replace(/(\d)\.(\d)/g, '$1\u0000$2')
    const clauses = shielded
      .split(/[，,。！!？?；;\n]+|[.]\s+/)
      .map((part) => part.trim().replace(TITLE_JOIN, '').trim().replace(/\u0000/g, '.'))
      .filter((part) => part !== '')
    if (clauses.length === 0) return ''
    const at = clauses.findIndex((part) => TITLE_ASK_CUE.test(part))
    if (at < 0) return condenseText(clauses[0], max)
    // A cue that lands on a stub clause is only the tail of the question: 「要我现在
    // 就重启，还是你自己来？」 — the thing being decided is the clause before it.
    // Naming the row 「还是你自己来」 throws away every word that says what about.
    // 「不确定配色怎么选」 has the same problem from the other side: it says the
    // uncertainty but not what is uncertain (the 夜间模式).
    let start = at
    let askedText = clauses[at]
    if (askedText.length < 12 && at > 0) {
      start = at - 1
      askedText = clauses[at - 1] + '，' + askedText
    }
    // The subject clause only helps when it is short, comes before the question,
    // and is not already folded into it — otherwise the question reads clearly.
    const head = clauses[0]
    if (start > 0 && head.length <= 16 && !TITLE_ASK_CUE.test(head)) {
      const joined = head + '：' + askedText
      if (joined.length <= max) return joined
    }
    return condenseText(askedText, max)
  }

  /** Re-arm the abandon timer for one entry's pending question. */
  function autoRearm(entry) {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
    const timer = setTimeout(() => {
      entry.timer = undefined
      const unit = entry.pending
      if (unit === undefined) return
      entry.pending = undefined
      fireCapture(unit, 'left')
    }, AUTO_GRACE_MS)
    if (typeof timer.unref === 'function') timer.unref()
    entry.timer = timer
  }

  /**
   * Look up (or start) the watch entry for one session.
   *
   * Returns `undefined` for subagent sessions on purpose: nobody talks in those,
   * so every "unanswered question" there would be the parent agent's own scratch
   * work showing up as a reminder for a person who never saw it.
   */
  function autoEntryOf(session) {
    if (session === null || typeof session !== 'object') return undefined
    const id = typeof session.id === 'string' ? session.id : ''
    if (id === '') return undefined
    const header = session.header
    if (header !== null && header !== undefined && header.origin === 'subagent') return undefined
    const known = autoWatch.get(id)
    if (known !== undefined) {
      // Re-insert to keep Map order as an LRU.
      autoWatch.delete(id)
      autoWatch.set(id, known)
      return known
    }
    const dirPath =
      header !== null && header !== undefined && typeof header.cwd === 'string' ? header.cwd : ''
    const entry = {
      sessionId: id,
      sessionTitle: '',
      dirPath,
      turn: 0,
      running: false,
      userText: '',
      userSeq: 0,
      userTurn: 0,
      lastAssistant: '',
      answeredInTurn: false,
      // Whether the assistant has already spoken since the last user message —
      // the tell that any later user message in the same turn is a steer.
      spokeThisTurn: false,
      // Whether the current turn has already closed. Guards the `spokeThisTurn`
      // tell against log orderings where the next turn's message lands first.
      turnEnded: false,
      pending: undefined,
      timer: undefined,
    }
    autoWatch.set(id, entry)
    if (autoWatch.size > AUTO_MAX_SESSIONS) {
      const oldest = autoWatch.keys().next()
      if (oldest.done !== true) {
        const dropped = autoWatch.get(oldest.value)
        if (dropped !== undefined && dropped.timer !== undefined) clearTimeout(dropped.timer)
        autoWatch.delete(oldest.value)
      }
    }
    return entry
  }

  /**
   * Write one pending question onto the board.
   *
   * Rows are keyed by (session, user-message seq) so re-asking the same thing in
   * the same session can never produce a second identical reminder, even after a
   * restart clears the in-memory watch state: the check reads the board itself.
   */
  async function autoCapture(unit, reason) {
    if (board.settings.autoCapture !== true) return
    if (unit === undefined || unit === null) return
    const seq = typeof unit.userSeq === 'number' ? unit.userSeq : 0
    if (seq <= 0) return
    const already = () => board.todos.some((todo) => {
      return todo.sourceSessionId === unit.sessionId && todo.sourceSeq === seq
    })
    if (already()) return
    let sessionTitle = typeof unit.sessionTitle === 'string' ? unit.sessionTitle : ''
    if (sessionTitle === '') {
      const query = ctx.get('sessionQuery')
      if (query !== undefined && query !== null && typeof query.readTitle === 'function') {
        try {
          const title = await query.readTitle(unit.sessionId)
          if (typeof title === 'string' && title.trim() !== '') sessionTitle = title.trim()
        } catch (err) {
          // A missing title is cosmetic: the row still says which directory it
          // came from, so this must never cost the capture itself.
        }
      }
    }
    if (already()) return
    const lines = []
    const ask = condenseText(unit.askText, AUTO_NOTE_CHARS)
    if (ask !== '') lines.push('AI 在等你定：' + ask)
    const where = sessionTitle !== '' ? sessionTitle : dirLabel(unit.dirPath)
    if (where !== '') lines.push('会话：' + where)
    if (typeof unit.turn === 'number' && unit.turn > 0) lines.push('第 ' + unit.turn + ' 轮之后一直没定')
    const result = await createTodo({
      title: autoTitle({ ...unit, sessionTitle }),
      dir: typeof unit.dirPath === 'string' ? unit.dirPath : '',
      mode: 'remind',
      note: lines.join('\n'),
      sessionId: unit.sessionId,
      sessionTitle,
      sourceSeq: seq,
      sourceTurn: typeof unit.userTurn === 'number' ? unit.userTurn : 0,
      autoCaptured: true,
    })
    if (result !== undefined && result !== null && result.ok === true) {
      log(
        'info',
        'todo-board: 自动记下未拍板的问题（' + reason + '）' + (result.todo === undefined ? '' : result.todo.title),
      )
    } else {
      log(
        'warn',
        'todo-board: 自动记下未拍板的问题失败：' +
          (result !== undefined && result !== null && typeof result.error === 'string' ? result.error : '未知原因'),
      )
    }
  }

  /**
   * Fire one capture without letting it become an unhandled rejection.
   *
   * `autoCapture` awaits `createTodo`, which awaits `admitImages` and touches
   * the filesystem. Every caller here is a synchronous event hook that cannot
   * await anything without stalling the turn, so the promise is deliberately
   * left alone — but not without a catch: a rejected promise nobody holds kills
   * the process on modern Node, and losing a reminder is never worth that.
   */
  function fireCapture(unit, reason) {
    void autoCapture(unit, reason).catch((err) => {
      log('error', 'todo-board: 自动记录未拍板的问题失败', err)
    })
  }

  /**
   * Settle the pending question against the reply that just arrived.
   *
   * "Answered" is judged by `looksAnswered`, NOT by whether the words match a
   * decision phrase. A person who answers 「第二个吧」, or who writes three
   * paragraphs working through the trade-offs, has plainly looked at the question
   * and must not be handed a reminder for it afterwards. Only a reply that reads
   * as a fresh request counts as having moved on — which is exactly the case the
   * user asked to be recorded.
   *
   * When `autoJudge` is on, the session's own model makes that call instead and
   * the heuristics only step in if it cannot answer. See `DEFAULT_SETTINGS`.
   */
  function autoSettle(entry, replyText) {
    const unit = entry.pending
    if (unit === undefined) return
    entry.pending = undefined
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
    // The model is asked only when the user turned it on. It runs off the event
    // loop's critical path: `session/event` is a fire-and-forget feed and must
    // not block on a network round trip, so the verdict comes back later and the
    // write happens then.
    if (board.settings.autoJudge === true) {
      void judgeWithModel(unit.sessionId, unit, replyText)
        .then((verdict) => {
          // `undefined` is "the model could not answer" and falls back to the
          // keyword verdict rather than to either of its two opinions.
          if (verdict === true) return
          if (verdict === false) {
            fireCapture(unit, 'moved-on')
            return
          }
          if (!looksAnswered(replyText, unit.askText)) fireCapture(unit, 'moved-on')
        })
        .catch((err) => {
          log('error', 'todo-board: 自动记录判定失败', err)
          if (!looksAnswered(replyText, unit.askText)) fireCapture(unit, 'moved-on')
        })
      return
    }
    if (looksAnswered(replyText, unit.askText)) return
    fireCapture(unit, 'moved-on')
  }

  /** Write out one session's outstanding question right now, if there is one. */
  function autoFlush(sessionId) {
    const entry = autoWatch.get(typeof sessionId === 'string' ? sessionId : '')
    if (entry === undefined) return 0
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
    const unit = entry.pending
    entry.pending = undefined
    if (unit === undefined) return 0
    fireCapture(unit, 'left')
    return 1
  }

  ctx.on('session/event', (session, event) => {
    try {
      if (board.settings.autoCapture !== true) return
      if (event === null || event === undefined) return
      const type = event.type
      if (
        type !== 'user/message' &&
        type !== 'assistant/message' &&
        type !== 'turn/start' &&
        type !== 'turn/end'
      ) {
        return
      }
      const entry = autoEntryOf(session)
      if (entry === undefined) return
      const data = event.data
      if (type === 'turn/start') {
        entry.turn = data !== null && data !== undefined && typeof data.turn === 'number' ? data.turn : entry.turn + 1
        entry.answeredInTurn = false
        entry.spokeThisTurn = false
        entry.turnEnded = false
        return
      }
      if (type === 'user/message') {
        if (data === null || data === undefined || data.role !== 'user') return
        const source = data.source
        // Only a human's own words. An injected notice or a tool result would be
        // the plugin answering itself.
        if (source === undefined || source === null || source.kind !== 'user') return
        const text = messageTextOf(data)
        if (text.trim() === '') return
        // A question still pending is settled by the NEXT thing the person says,
        // whatever it turns out to be — `autoSettle` decides whether that counts
        // as having answered it.
        if (entry.pending !== undefined) autoSettle(entry, text)
        // Two messages inside ONE turn means the second landed mid-turn (a steer):
        // a correction or an addition, not the question the turn is about, so it
        // must neither become the row's title nor move the "which seq produced
        // this" marker. It does prove the person was looking, so a decision spoken
        // here clears the turn's own closing question below.
        //
        // Detected by "the assistant has already spoken since the last user
        // message" rather than by comparing turn numbers: the log ordering between
        // `turn/start` and the turn's first `user/message` is not something this
        // plugin controls, and a number comparison would then misread an ordinary
        // new request as a steer and drop it silently.
        //
        // `turnEnded` guards that same race from the other side: a lingering
        // `spokeThisTurn` from the PREVIOUS turn must not make the next turn's
        // opening question look like an insertion into a turn that already closed.
        const midTurn = entry.spokeThisTurn === true && entry.turnEnded !== true
        if (midTurn) {
          // A steer settles the turn's closing question only when it actually
          // decides something. `looksAnswered` is too generous here — it also
          // counts "still thinking" as engaged — so the stricter predicate is
          // used: only an explicit concession, refusal or decision clears it.
          if (settlesQuestion(text, entry.lastAssistant)) entry.answeredInTurn = true
          return
        }
        entry.userText = text
        entry.userSeq = typeof event.seq === 'number' ? event.seq : 0
        entry.userTurn = entry.turn
        entry.lastAssistant = ''
        return
      }
      if (type === 'assistant/message') {
        const message = data === null || data === undefined ? undefined : data.message
        const text = messageTextOf(message)
        if (text.trim() !== '') entry.lastAssistant = text
        if (data !== null && data !== undefined && typeof data.turn === 'number') entry.turn = data.turn
        // The assistant having spoken is what makes any LATER user message in this
        // same turn a steer rather than the turn's opening request.
        entry.spokeThisTurn = true
        return
      }
      // turn/end — the only place a question becomes a candidate, because it is
      // the only place that knows how the turn actually finished.
      entry.turnEnded = true
      if (entry.userSeq === 0) return
      const reason = data === null || data === undefined ? undefined : data.reason
      const kind =
        reason !== null && typeof reason === 'object' && typeof reason.kind === 'string'
          ? reason.kind
          : 'completed'
      if (kind !== 'completed') return
      if (entry.answeredInTurn === true) return
      if (!looksAsked(entry.lastAssistant)) return
      entry.pending = {
        sessionId: entry.sessionId,
        sessionTitle: entry.sessionTitle,
        dirPath: entry.dirPath,
        userText: entry.userText,
        userSeq: entry.userSeq,
        userTurn: entry.userTurn,
        askText: entry.lastAssistant,
        turn: entry.turn,
      }
      autoRearm(entry)
    } catch (err) {
      log('error', 'todo-board: 自动记录未拍板的问题失败', err)
    }
  })

  // The session going idle is what "the user left" looks like from up here: the
  // turn is over, nothing is running, and if the last thing said was a question
  // nobody is going to answer it by waiting.
  ctx.on('agent/status', (payload) => {
    try {
      if (board.settings.autoCapture !== true) return
      const agent = payload === null || payload === undefined ? undefined : payload.agent
      if (agent === null || agent === undefined || typeof agent.id !== 'string') return
      const entry = autoWatch.get(agent.id)
      if (entry === undefined) return
      const status = payload.status
      entry.running = status === 'running'
      if (status !== 'idle') return
      if (entry.pending === undefined) return
      autoRearm(entry)
    } catch (err) {
      log('error', 'todo-board: 自动记录空闲判定失败', err)
    }
  })

  // A disposed agent is the end of that conversation: hand its question to the
  // board now rather than leaving it for a timer that will never fire.
  ctx.on('agent/disposed', (payload) => {
    try {
      const agent = payload === null || payload === undefined ? undefined : payload.agent
      if (agent === null || agent === undefined || typeof agent.id !== 'string') return
      autoFlush(agent.id)
      const entry = autoWatch.get(agent.id)
      if (entry !== undefined && entry.timer !== undefined) clearTimeout(entry.timer)
      autoWatch.delete(agent.id)
    } catch (err) {
      log('error', 'todo-board: 自动记录收尾失败', err)
    }
  })

  // -------------------------------------------------------- prompt section
  //
  // BOTH of these are `ctx.inject`, NOT an eager `ctx.get`, and that is
  // load-bearing rather than stylistic.
  //
  // The plugin row may be applied BEFORE the `tools` / `systemPrompt` services
  // exist (the loader's order is not ours to choose). An eager read then sees
  // `undefined`, and the old `if (x !== undefined) { … }` guard skipped the
  // registration SILENTLY and permanently — the tool simply never existed, with
  // no error anywhere. Verified: composing the registry after this plugin left
  // `tools.get('todo_board') === undefined`.
  //
  // The symptom was invisible from the panel: the HTTP routes use
  // `ctx.inject(['webServer'], …)`, which WAITS, so the board kept working while
  // the model had no tool and no prompt section at all. `node tools/smoke.mjs`
  // could not catch it either, because that stub hands `ctx.get` a tools service
  // directly.
  //
  // `ctx.inject` re-runs the callback whenever a required service appears (and
  // unloads when it goes away), so registration survives any load order.

  ctx.inject(['systemPrompt'], (promptCtx) => {
    const prompt = promptCtx.get('systemPrompt')
    if (prompt === undefined) return
    promptCtx.effect(
      () =>
        prompt.section({
          name: 'todo-board',
          order: 150,
          text: [
            '## TODO 板（跨会话待办）',
            '用户维护着一个按工作目录分组的待办板，你可以用 `' + TOOL_NAME + '` 工具读写它。',
            '- 列表**从上到下就是执行顺序**（用户可拖动调整）；你应按这个顺序取任务。',
            '- 每完成一项工作，立刻用 `' + TOOL_NAME + '` action="done" 把对应待办标记为「AI 已完成」（左勾）。',
            '- 完成一项后，用 `' + TOOL_NAME + '` action="list" 查看**当前工作目录**下是否还有未完成待办；如果有，继续执行**列表最上面**那一条，不要停下来等待用户。',
            '- 你只能勾左勾（AI 已完成）；右勾（已验收）由用户自己勾，永远不要代勾。',
            '- 待办可以带**定时时间**（本地 `YYYY-MM-DDTHH:mm`）：带定时且还没到点的待办**先别做**，到点后 DSH 会自动派发它；你可以用 action="schedule" 给某条待办设置或取消时间。',
            '- 待办也可以带**图片**：面板上可直接附图；你用 action="add" 时传 `images`（主机上图片文件的绝对路径）即可，派发时这些图会作为真正的图片发给你。列表里会标注图片张数。',
            '- 如果用户给的任务不在待办板上，也可以先 action="add" 记一条再动手（新条目会被追加到最底下）。',
            '- 你也可以改板子：action="update" 改标题/模式/目录/备注，action="reorder" 传 `ids` 重排**同一个目录内**的顺序（用户希望某条先做时用得上），action="dispatch" 立即派发一条尚未派发的待办。',
            '- **除 list / done / reopen 外，所有写操作都会先弹给用户审批**（这是用户明确要求的）。被拒绝就停手，把情况告诉用户，不要换个说法反复重试同一件事。',
            '- **用户给的是多阶段/长任务时，先问一句再动手**：如果这件事明显要分几步做，而**当前目录下还没有**待办，先用一句话（或 ask_user_question）问用户：要不要用 TODO 板把它拆成步骤、按顺序执行？不要闷头开干。要拆就用一次 action="add" 的 `items` 把整份计划写进去（一次审批），每条 note 写清验收标准。',
            '- **当前目录下已经有待办时，不要再问**：直接按上面的顺序继续做即可。这一条是防唠叨的开关 —— 板子非空就问，会变成每一轮都问。',
            '- **续跑按归属走，不按目录走**：每条待办属于一条会话（`runIn`），只会被那条会话接走；' +
              '同目录的另一条会话不会顺手把你的活干了。子条目（`parent`）归到父容器开的那个会话去。',
            '- **`remind` 是链条断点**：列表里读到 `remind` 就停下，不要越过它继续往下执行 —— ' +
              '它表示用户想先把计划摆出来、还没开始。',
          ].join('\n'),
        }),
      'dsh-todo-board: prompt section',
    )
  })

  // ----------------------------------------------------------- approval gate
  //
  // Writing the board is gated at the REGISTRY layer, not inside the tool body:
  // `tools/pre-execute` is a cordis waterfall, and returning `{ kind: 'ask' }`
  // hands the call to `dsh-user-approval` before the body can run. That
  // placement is the point — a model cannot route around a registry-level gate
  // the way it can route around a prompt sentence — and a refusal comes back as
  // a real failed tool result (`the user rejected tool "todo_board"`), so the
  // model knows the write did not happen instead of believing it succeeded.
  //
  // fail-closed is the harness's, not ours (`dsh-tools/lib/index.js:3314-3365`):
  // no approval service, no agent to route through, or any non-grant verdict all
  // deny. Nothing here needs an approval channel of its own.
  //
  // Two paths deliberately do NOT pass through this gate:
  //
  //   - the PANEL's writes, which ride the HTTP route and are authorized by the
  //     browser session there (`refuseUntrusted`);
  //   - the scheduler and the turn-end hook, which are not tool calls (and are
  //     outside any open turn, where `approval.request()` cannot even be called).
  //
  // That split is the agreed boundary — approval guards *changing the board*,
  // never *running the queue* — so the panel's ▶ stays a plain click and the
  // auto-continue chain stays automatic.
  //
  // `done` / `reopen` are let through on purpose. They are the model's own
  // checkbox: the auto-continue loop the user asked for is literally "finish a
  // todo, call action=done, take the next one", and under a `danger-full-access`
  // deployment (approval policy `never`) an `ask` here would be denied every
  // single time and silently break that loop. Neither can start work either —
  // `pendingInDir` treats an `aiDone` row as not pending.
  //
  // Everything else asks, INCLUDING an action this version does not know:
  // an unrecognized action must fail closed, not slip past the gate.

  // `note` joined this list in 0.13.4. The reasoning is the same one that put
  // `done` here: a note is prose on a row the user already owns — it deletes
  // nothing, dispatches nothing, re-parents nothing, and cannot start work
  // (`pendingInDir` ignores it). Asking for it puts a dialog in the middle of
  // the one loop the board exists for, "do a step, write down what the next one
  // needs", and under `approval: 'never'` that dialog fails closed every time,
  // so the loop simply breaks.
  //
  // `schedule` deliberately STAYS gated: a schedule makes the row run later
  // without anyone watching, which is the one thing a note cannot do.
  const APPROVAL_FREE_ACTIONS = ['list', 'done', 'reopen', 'note']

  /**
   * One line describing the pending write, so the approval dialog states what
   * the model is about to do rather than only naming the tool.
   */
  function approvalDetail(action, input) {
    const id = typeof input.id === 'string' ? input.id : ''
    const title = typeof input.title === 'string' ? input.title.trim() : ''
    const where = title !== '' ? '「' + title + '」' : id !== '' ? '（id ' + id + '）' : ''
    if (action === 'add') {
      // A plan shows up IN THE DIALOG, step by step. One approval for a batch is
      // only honest if the approver can read what the batch is — otherwise the
      // gate degenerates into a single "yes" for an unread list.
      if (Array.isArray(input.items) && input.items.length > 0) {
        const titles = input.items.map((entry, at) => {
          const one = entry !== null && typeof entry === 'object' ? entry : {}
          const text = typeof one.title === 'string' ? one.title.trim() : ''
          return at + 1 + '. ' + (text === '' ? '(缺 title)' : text)
        })
        const modes = new Set()
        for (const entry of input.items) {
          const one = entry !== null && typeof entry === 'object' ? entry : {}
          if (typeof one.mode === 'string') modes.add(one.mode)
        }
        const auto = [...modes].some((mode) => mode !== 'remind')
        return (
          '新增计划（' + input.items.length + ' 步' +
          (auto ? '，含会自动派发的步骤' : '') + '）：\n' + titles.join('\n')
        )
      }
      const mode = typeof input.mode === 'string' ? input.mode : 'remind'
      return (
        '新增待办' + where + '，模式 ' + mode +
        (mode === 'remind' ? '' : '（这条会被自动派发执行）')
      )
    }
    if (action === 'note') return '改备注' + where
    if (action === 'schedule') {
      const at = typeof input.schedule === 'string' ? input.schedule.trim() : ''
      return at === '' ? '取消定时' + where : '设定时' + where + ' → ' + at
    }
    if (action === 'update') {
      const fields = []
      if (typeof input.title === 'string' && input.title.trim() !== '') fields.push('标题')
      if (typeof input.mode === 'string') fields.push('模式 ' + input.mode)
      if (typeof input.dir === 'string' && input.dir.trim() !== '') fields.push('目录 ' + input.dir.trim())
      if (typeof input.note === 'string') fields.push(input.note === '' ? '备注（清空）' : '备注')
      return '修改待办' + where + (fields.length === 0 ? '' : '：' + fields.join('、'))
    }
    if (action === 'reorder') {
      // Resolved against the live board: "which row ends up on top" is the one
      // fact that makes a reorder approvable at a glance.
      const ids = Array.isArray(input.ids)
        ? input.ids.filter((entry) => typeof entry === 'string')
        : []
      const top = ids.length === 0 ? undefined : find(ids[0])
      return (
        '调整待办顺序（' + ids.length + ' 条' +
        (top === undefined ? '' : '，最上面将是「' + top.title + '」') + '）'
      )
    }
    if (action === 'dispatch') {
      const todo = id === '' ? undefined : find(id)
      return '立即派发待办' + (todo === undefined ? where : '「' + todo.title + '」')
    }
    return '执行 ' + action + where
  }

  /**
   * Look one service up the way {@link harnessConnection} does: this context
   * first, then the application root, and `undefined` rather than a throw when
   * the provider is absent or its accessor fails.
   */
  function serviceNamed(name) {
    const rootCtx = ctx.root === undefined ? ctx : ctx.root
    for (const source of [ctx, rootCtx]) {
      try {
        if (source === undefined || source === null || typeof source.get !== 'function') continue
        const service = source.get(name)
        if (service === undefined || service === null) continue
        return service
      } catch (err) {
        /* fall through to the next source */
      }
    }
    return undefined
  }

  /**
   * This session's approval policy, or `undefined` when it cannot be read.
   *
   * `never` is the one value that matters, because `dsh-user-approval`'s
   * `decide()` returns `rejected` on it BEFORE consulting any answerer
   * (`lib/index.js:175`). So under `never` an `ask` is not "a question the user
   * may decline" — it is a guaranteed denial, phrased as if the user had said no
   * to a dialog they never saw. Reading the policy is how the gate tells those
   * two situations apart.
   *
   * Every failure path returns `undefined`, which reads as "cannot prove
   * prompts are impossible" and therefore keeps the gate asking.
   */
  function approvalPolicyOf(session) {
    if (session === undefined || session === null) return undefined
    try {
      const approval = serviceNamed('approval')
      if (approval === undefined || typeof approval.effectivePolicy !== 'function') {
        return undefined
      }
      const policy = approval.effectivePolicy(session)
      return policy === 'never' || policy === 'ask' ? policy : undefined
    } catch (err) {
      /* an unreadable policy must not be mistaken for a permissive one */
      return undefined
    }
  }

  /**
   * Whether the deployment has ALREADY granted this write on its own.
   *
   * The condition is deliberately narrow, and it is NOT "the policy is
   * `never`". `sandbox` and `approval` are two of the three independent
   * permission knobs (`permission/preset`, `sandbox/mode`, `approval/policy`),
   * so `never` can be paired with a `read-only` or `workspace-write` sandbox —
   * the preset then reads back as `custom`. That pairing matters here because
   * this plugin writes `board.json` with HOST privileges: the write never
   * passes through the sandbox at all, so under a restricted sandbox the
   * approval gate is the only thing standing between the model and the file.
   * Auto-allowing on `never` alone would hand out a write channel the sandbox
   * deliberately withheld.
   *
   * So the two knobs are read from whichever source is authoritative for each:
   * the SANDBOX from the resolved preset bundle, the APPROVAL POLICY from
   * `approval.effectivePolicy(session)` — which is why this function opens with
   * that check rather than trusting anything the permission table says.
   *
   * The sandbox half comes from the RESOLVED bundle and not from the preset's
   * NAME. `presets` is a configurable table (`permissionPresets`'s own Config
   * schema declares it), and driving the shipped `derive()` over the whole knob
   * grid shows the difference is not academic: point the key `danger-full-access`
   * at a `workspace-write` bundle and `derive()` starts returning that very name
   * for a `workspace-write` session. A name is a label. `bundle.sandbox`, by
   * contrast, equals the session's real sandbox in every branch of `derive()` —
   * each branch either matched on it or explicitly re-checked it.
   *
   * The APPROVAL half must NOT come from the bundle, for the mirror-image reason:
   * `derive()` deliberately keeps returning the live `auto` preset once the
   * policy moves to `never` ("a still-selected Auto also matches the `never`
   * approval policy"), and `auto`'s bundle documents approval `ask` forever. A
   * gate that read approval off that bundle would keep refusing a session that
   * really is full-access + never.
   *
   * Everything unreadable answers `false`, i.e. keep asking. That direction is
   * the point: if `resolve`/`specOf` ever vanish from this service, the plugin
   * degrades to its old "always ask" behaviour — it does not start guessing.
   */
  function writeAlreadyUnrestricted(session) {
    if (approvalPolicyOf(session) !== 'never') return false
    try {
      const presets = serviceNamed('permissionPresets')
      if (presets === undefined || typeof presets.current !== 'function') return false
      // `current()` folds the session's permission projection and THROWS when
      // that projection is not registered ("permissions session projection is
      // not registered" appears in real logs), which the catch below absorbs.
      const spec = presetSpecOf(presets, presets.current(session))
      if (spec === undefined || spec === null) return false
      return spec.sandbox === 'danger-full-access'
    } catch (err) {
      return false
    }
  }

  /**
   * Resolve one preset name to its knob bundle, or `undefined` when this build
   * cannot say. `resolve` is the documented accessor but throws by design for
   * `custom` and unknown names; `specOf` is the same lookup without the throw.
   * Both are tried, and a build offering neither yields `undefined` — which the
   * caller reads as "cannot prove full access", never as "full access".
   */
  function presetSpecOf(presets, name) {
    if (typeof presets.resolve === 'function') {
      try {
        const spec = presets.resolve(name)
        return spec === undefined ? undefined : spec
      } catch (err) {
        return undefined
      }
    }
    if (typeof presets.specOf !== 'function') return undefined
    try {
      return presets.specOf(name)
    } catch (err) {
      return undefined
    }
  }

  /**
   * The denial used when prompts are impossible but the sandbox does not
   * already permit the write. Same outcome as letting the `ask` fail, but the
   * reason names the actual cause instead of blaming the user.
   */
  function noPromptsReason(action, input) {
    return (
      'AI 要修改待办板，但本会话的审批策略是 `never`：审批框被禁用，' +
      '需要审批的动作会被直接拒绝，所以这次写入没有发生（不是你点了拒绝）。' +
      '待办板由插件以宿主权限写盘，不经过 shell 沙箱，' +
      '因此在沙箱未放开完全文件访问时，审批是唯一的确认方式。' +
      '改用 `workspace-write` 预设、或把审批策略改回 `ask` 即可放行，' +
      '也可以直接在浮动面板里操作。本次尝试：' +
      approvalDetail(action, input)
    )
  }

  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec === undefined || exec === null || exec.name !== TOOL_NAME) return next()
    // `createExecution` freezes the model's arguments onto the execution, and
    // leaves them `undefined` when argument validation failed. Mirror the tool
    // body's own default (`list`) so gate and body never disagree.
    const input =
      exec.arguments !== null && typeof exec.arguments === 'object' ? exec.arguments : {}
    const action = typeof input.action === 'string' ? input.action : 'list'
    if (APPROVAL_FREE_ACTIONS.indexOf(action) >= 0) return next()

    const agent = exec.agent
    const session = agent === undefined || agent === null ? undefined : agent.session

    // `danger-full-access` grants full file access AND disables prompts, so the
    // write adds no capability the deployment did not already grant — and an
    // `ask` there is GUARANTEED to be denied, which turns the gate into a wall
    // that blocks the unattended queue the board exists for. Worse, the wall is
    // the wrong shape: a model that wants a row on the board can still reach
    // `board.json` with the file tools under that sandbox, and hand-editing it
    // skips validation, the `seq` counter and the atomic replace. Letting the
    // proper tool through is the safer of the two.
    if (writeAlreadyUnrestricted(session)) return next()

    // Prompts are impossible but the sandbox does NOT already permit the write.
    // Denying is the same verdict the `ask` would reach, so nothing is weakened;
    // the reason is just true about why.
    if (approvalPolicyOf(session) === 'never') {
      return { kind: 'deny', reason: noPromptsReason(action, input) }
    }

    return { kind: 'ask', reason: 'AI 要修改待办板：' + approvalDetail(action, input) }
  })

  // ------------------------------------------------------------ model tool

  ctx.inject(['tools'], (toolsCtx) => {
    const tools = toolsCtx.get('tools')
    if (tools === undefined) return
    {
    const definition = {
      name: TOOL_NAME,
      description:
        '读写跨会话 TODO 板。列表从上到下就是执行顺序（用户可拖动调整）。action=list 查看待办（默认当前工作目录），action=add 新增（追加到底部，可用 images 附主机上的图片文件），action=done 标记 AI 已完成（左勾），action=reopen 撤销左勾，action=note 追加备注，action=schedule 设置/取消定时执行时间，action=update 改标题/模式/目录/备注，action=reorder 用 ids 重排同一目录内的顺序，action=dispatch 立即派发一条尚未派发的待办。带 schedule 的待办到点后才会被派发。**除 list / done / reopen / note 外，所有写操作都会先弹给用户审批；被拒绝就停手，不要反复重试。** ' +
        // `done` / `reopen` say what they DO, in effect terms. Under an
        // LLM-backed review preset (`dsh-experimental-auto-review`), the
        // reviewer sees this description and classifies the call by its actual
        // effects; a checkbox flip that deletes nothing and rewrites no
        // content is low risk, and saying so here is the one lever this plugin
        // has over that classification. It is deliberately NOT a promise about
        // approval — the reviewer decides, and the "高风险/中风险动作要拒绝"
        // rules still apply to everything else.
        '动作效果：done 只把该行标记为「AI 已完成」（翻转一个布尔），reopen 只撤销这个标记 —— 两者都不删除任何行、不改写标题或备注、不新建会话、不派发任务。',
      parameters: TOOL_PARAMETERS,
      output: {
        schema: TOOL_OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      async execute(args, exec) {
        const input = args !== null && typeof args === 'object' ? args : {}
        const action = typeof input.action === 'string' ? input.action : 'list'
        const agent = exec === undefined || exec === null ? undefined : exec.agent
        const header = agent === undefined || agent === null ? undefined : agent.session.header
        const cwd = header !== undefined && typeof header.cwd === 'string' ? header.cwd : ''
        // One live-session map per tool call, so every row in the reply agrees.
        const live = liveSessions()

        if (action === 'add') {
          // One entry point for a single todo and for a whole plan: a plan is the
          // same rows, created in one call so they cost ONE approval instead of
          // one per step. `items` wins when both are given.
          const requested = Array.isArray(input.items) && input.items.length > 0
            ? input.items
            : [{ title: input.title, note: input.note, mode: input.mode, schedule: input.schedule, images: input.images }]
          if (Array.isArray(input.items) && input.items.length > MAX_PLAN_ITEMS) {
            return {
              message:
                '一次最多创建 ' + MAX_PLAN_ITEMS + ' 条（收到 ' + input.items.length +
                ' 条）。请拆成两批：这样每次审批框里的计划都还是人读得完的。',
              todos: [],
            }
          }
          const dirPath = typeof input.dir === 'string' && input.dir !== '' ? input.dir : cwd

          // -- stage 1: validate the WHOLE plan, touching nothing -----------------
          //
          // All-or-nothing is the contract, and it is not decoration: a half-built
          // plan is worse than none, because the user approved a list and would get
          // a different one. So every item is checked before the first row lands.
          const staged = []
          for (let at = 0; at < requested.length; at++) {
            const entry = requested[at] !== null && typeof requested[at] === 'object' ? requested[at] : {}
            const where = requested.length === 1 ? '' : '第 ' + (at + 1) + ' 条：'
            const title = typeof entry.title === 'string' ? entry.title.trim() : ''
            if (title === '') {
              return { message: where + 'add 需要提供 title，整批未创建（一条都没落库）。', todos: [] }
            }
            if (typeof entry.mode === 'string' && MODES.indexOf(entry.mode) < 0) {
              return {
                message: where + 'mode 只能是 ' + MODES.join(' / ') + '，整批未创建（一条都没落库）。',
                todos: [],
              }
            }
            const schedule = normalizeSchedule(entry.schedule)
            if (typeof entry.schedule === 'string' && entry.schedule.trim() !== '' && schedule === '') {
              return {
                message: where + 'schedule 格式无效，请用 YYYY-MM-DDTHH:mm（本地时间）；整批未创建（一条都没落库）。',
                todos: [],
              }
            }
            // Paths are read here, at the board boundary, and stored durably so a
            // later dispatch needs no filesystem access of its own.
            const imageEntries = []
            if (Array.isArray(entry.images) && entry.images.length > 0) {
              for (const path of entry.images) {
                if (typeof path !== 'string' || path.trim() === '') {
                  return { message: where + 'images 需要是图片文件的绝对路径数组；整批未创建（一条都没落库）。', todos: [] }
                }
                const trimmed = path.trim()
                const mediaType = MEDIA_TYPE_BY_EXTENSION[extname(trimmed).toLowerCase()]
                if (mediaType === undefined) {
                  return {
                    message: where + '不支持的图片扩展名：' + trimmed +
                      '（支持 png / jpg / jpeg / webp / gif）；整批未创建（一条都没落库）。',
                    todos: [],
                  }
                }
                imageEntries.push({ path: trimmed, mediaType })
              }
            }
            // `parent` is the index, WITHIN THIS SAME BATCH, of the row this one hangs
            // under. It must point strictly BACKWARDS, which makes a cycle
            // impossible to express rather than something to detect later, and
            // guarantees the container is committed before its child needs it.
            let parentAt = -1
            if (entry.parent !== undefined && entry.parent !== null) {
              parentAt = typeof entry.parent === 'number' ? entry.parent : Number.NaN
              if (!Number.isInteger(parentAt) || parentAt < 0 || parentAt >= at) {
                return {
                  message: where + 'parent 只能是本批次里更靠前的一条的下标（0 到 ' + (at - 1) +
                    ' 之间，不能指向自己或后面的条目）；整批未创建（一条都没落库）。',
                  todos: [],
                }
              }
            }
            staged.push({ title, schedule, imageEntries, parentAt, entry })
          }

          // -- stage 2: admit every image, still touching no row -----------------
          const admitted = []
          for (let at = 0; at < staged.length; at++) {
            const images = await admitImages(staged[at].imageEntries)
            if (images.ok === false) {
              return {
                message:
                  (staged.length === 1 ? '' : '第 ' + (at + 1) + ' 条：') + images.error +
                  '；整批未创建（一条都没落库）。',
                todos: [],
              }
            }
            admitted.push(images)
          }

          // -- stage 3: commit, in order -----------------------------------------
          const created = []
          for (let at = 0; at < staged.length; at++) {
            const item = staged[at]
            const todo = normalize({
              title: item.title,
              dirPath,
              mode: typeof item.entry.mode === 'string' ? item.entry.mode : 'remind',
              note: typeof item.entry.note === 'string' ? item.entry.note : '',
              schedule: item.schedule,
              sourceSessionId: agent === undefined || agent === null ? '' : agent.id,
            })
            if (todo === null) {
              return { message: '无法创建这条待办。', todos: created.map((row) => toolTodo(row, live)) }
            }
            todo.images = admitted[at].images
            todo.order = nextOrder()
            board.todos.push(todo)
            board.seq += 1
            // The container is always an EARLIER row in this batch, so it is
            // already in `created` and its id is stable.
            if (item.parentAt >= 0) todo.runIn = { kind: 'after', id: created[item.parentAt].id }
            created.push(todo)
          }
          if (created.length > 0) afterChange()

          if (created.length === 1) {
            const todo = created[0]
            return {
              message:
                '已新增待办「' + todo.title + '」（目录：' + (dirPath || '(未指定)') + '，模式：' +
                todo.mode +
                (todo.schedule === '' ? '' : '，定时：' + todo.schedule + '（' + scheduleLabel(todo.schedule) + '）') +
                (todo.images.length === 0 ? '' : '，图片：' + todo.images.length + ' 张') +
                '，追加到列表底部，id：' + todo.id + '）。',
              todos: [toolTodo(todo, live)],
            }
          }
          return {
            message:
              '已新增计划：' + created.length + ' 条，按顺序追加到列表底部（目录：' +
              (dirPath || '(未指定)') + '，模式：' + created[0].mode + '）。\n' +
              created.map((todo, at) => at + 1 + '. ' + todo.title + ' ｜ id=' + todo.id).join('\n') +
              '\n现在把这份列表复述给用户，然后按上面说的确认方式问一句是否开始。',
            todos: created.map((todo) => toolTodo(todo, live)),
          }
        }

        if (action === 'done' || action === 'reopen' || action === 'note' || action === 'schedule') {
          const id = typeof input.id === 'string' ? input.id : ''
          const todo = find(id)
          if (todo === undefined) return { message: '找不到 id 为 ' + (id || '(空)') + ' 的待办。', todos: [] }
          if (action === 'done') {
            todo.aiDone = true
            todo.dispatchedAt = 0
          } else if (action === 'reopen') {
            todo.aiDone = false
          } else if (action === 'schedule') {
            const next = normalizeSchedule(input.schedule)
            if (typeof input.schedule === 'string' && input.schedule.trim() !== '' && next === '') {
              return { message: 'schedule 格式无效，请用 YYYY-MM-DDTHH:mm（本地时间）。', todos: [] }
            }
            todo.schedule = next
            todo.remindedAt = 0
            todo.dispatchedAt = 0
          } else {
            todo.note = typeof input.note === 'string' ? input.note : ''
          }
          touch(todo)
          afterChange()
          const label =
            action === 'done'
              ? '已标记 AI 完成'
              : action === 'reopen'
                ? '已撤销 AI 完成'
                : action === 'schedule'
                  ? todo.schedule === ''
                    ? '已取消定时'
                    : '已设置定时 ' + todo.schedule + '（' + scheduleLabel(todo.schedule) + '）'
                  : '已更新备注'
          return { message: label + '：「' + todo.title + '」。', todos: [toolTodo(todo, live)] }
        }

        if (action === 'dispatch') {
          const id = typeof input.id === 'string' ? input.id : ''
          const todo = find(id)
          if (todo === undefined) return { message: '找不到 id 为 ' + (id || '(空)') + ' 的待办。', todos: [] }
          // The panel's ▶ is enabled for exactly this state, so the tool keeps
          // the same rule rather than inventing a second one: re-sending a row
          // that is already out there is duplicate work, and a done row is not
          // work at all.
          const state = todoState(todo, live)
          if (state !== 'pending') {
            return {
              message:
                '只有「未派发」的待办能派发；「' + todo.title + '」现在是「' + STATE_LABEL[state] + '」。',
              todos: [toolTodo(todo, live)],
            }
          }
          const result = await runTodo({
            id,
            sessionId: agent === undefined || agent === null ? '' : agent.id,
          })
          if (result.ok === false) return { message: result.error, todos: [toolTodo(todo, live)] }
          return {
            message:
              '已派发「' + todo.title + '」（' +
              (result.target === 'session' ? '会话 ' + result.sessionId : '新会话 ' + result.sessionId) +
              '）。',
            todos: [toolTodo(todo, live)],
          }
        }

        if (action === 'update') {
          const id = typeof input.id === 'string' ? input.id : ''
          const todo = find(id)
          if (todo === undefined) return { message: '找不到 id 为 ' + (id || '(空)') + ' 的待办。', todos: [] }
          // Validated as a whole BEFORE anything is written: a request naming one
          // bad field must not half-apply the good ones, or neither the model nor
          // the user who approved it can tell what actually changed.
          const wantedMode = typeof input.mode === 'string' ? input.mode : ''
          if (wantedMode !== '' && MODES.indexOf(wantedMode) < 0) {
            return { message: 'mode 只能是 ' + MODES.join(' / ') + '，未做任何改动。', todos: [] }
          }
          const wantedTitle = typeof input.title === 'string' ? input.title.trim() : ''
          if (typeof input.title === 'string' && wantedTitle === '') {
            return { message: 'title 不能改成空字符串，未做任何改动。', todos: [] }
          }
          const wantedDir = typeof input.dir === 'string' ? input.dir.trim() : ''
          if (typeof input.dir === 'string' && wantedDir === '') {
            return { message: 'dir 不能改成空字符串，未做任何改动。', todos: [] }
          }
          const changes = []
          if (wantedTitle !== '' && wantedTitle !== todo.title) {
            todo.title = wantedTitle
            changes.push('标题')
          }
          if (wantedMode !== '' && wantedMode !== todo.mode) {
            todo.mode = wantedMode
            // A new mode picks a new target, so a stale 「丢失」 verdict no
            // longer describes this row.
            clearLost(todo)
            changes.push('模式 ' + wantedMode)
          }
          if (wantedDir !== '' && normalizeDir(wantedDir) !== todo.dir) {
            todo.dirPath = wantedDir
            todo.dir = normalizeDir(wantedDir)
            clearLost(todo)
            changes.push('目录 ' + dirLabel(wantedDir))
          }
          if (typeof input.note === 'string' && input.note !== todo.note) {
            todo.note = input.note
            changes.push(input.note === '' ? '备注（清空）' : '备注')
          }
          if (changes.length === 0) {
            return {
              message: 'update 至少要改一项（title / mode / dir / note），且新值要和现在不同。',
              todos: [toolTodo(todo, live)],
            }
          }
          touch(todo)
          afterChange()
          return {
            message: '已更新「' + todo.title + '」：' + changes.join('、') + '。',
            todos: [toolTodo(todo, live)],
          }
        }

        if (action === 'reorder') {
          const ids = Array.isArray(input.ids)
            ? input.ids.filter((entry) => typeof entry === 'string' && entry !== '')
            : []
          if (ids.length === 0) {
            return { message: 'reorder 需要 ids：新的从上到下顺序（待办 id 数组）。', todos: [] }
          }
          const rows = []
          for (const id of ids) {
            const todo = find(id)
            if (todo === undefined) {
              return { message: '找不到 id 为 ' + id + ' 的待办，顺序未改动。', todos: [] }
            }
            if (rows.indexOf(todo) >= 0) {
              return { message: 'ids 里重复出现 ' + id + '，顺序未改动。', todos: [] }
            }
            rows.push(todo)
          }
          // One directory only. The panel groups by directory, and the two modes
          // push each directory's queue independently — so a list spanning
          // directories would silently reorder queues the user never offered to
          // reorder, while looking like a single harmless move.
          const dirs = []
          for (const row of rows) if (dirs.indexOf(row.dir) < 0) dirs.push(row.dir)
          if (dirs.length > 1) {
            return {
              message: 'reorder 只接受同一个目录内的待办，这次跨了 ' + dirs.length + ' 个目录，顺序未改动。',
              todos: [],
            }
          }
          reorderTodos({ ids })
          return {
            message:
              '已调整顺序（' + rows.length + ' 条，目录 ' + dirLabel(rows[0].dirPath || rows[0].dir) + '）：' +
              rows.map((row) => row.title).join(' → ') + '。',
            todos: rows.map((row) => toolTodo(row, live)),
          }
        }

        const all = input.all === true
        const wanted =
          typeof input.dir === 'string' && input.dir !== '' ? normalizeDir(input.dir) : normalizeDir(cwd)
        const list = []
        for (const todo of board.todos) {
          if (todo.verified) continue
          if (!all && wanted !== '' && todo.dir !== wanted) continue
          list.push(todo)
        }
        const shown = list.slice(0, 40)
        if (shown.length === 0) {
          return {
            message: all
              ? '待办板为空（没有未验收的条目）。'
              : '目录 ' + (cwd || '(未知)') + ' 下没有未完成的待办。',
            todos: [],
          }
        }
        const lines = [
          '未验收的待办共 ' + list.length + ' 条' +
            (all ? '' : '（目录 ' + (cwd || '(未知)') + '）') +
            '，从上到下就是执行顺序：',
        ]
        for (let i = 0; i < shown.length; i++) {
          const todo = shown[i]
          const ms = scheduleMs(todo.schedule)
          lines.push(
            i + 1 + '. [' + (todo.aiDone ? 'x' : ' ') + '] ' + todo.title +
              ' ｜ id=' + todo.id +
              ' ｜ 目录=' + dirLabel(todo.dirPath || todo.dir) +
              ' ｜ 模式=' + todo.mode +
              ' ｜ 状态=' + STATE_LABEL[todoState(todo, live)] +
              (todo.images.length === 0 ? '' : ' ｜ 图片=' + todo.images.length + ' 张') +
              (ms === 0
                ? ''
                : ' ｜ 定时=' + todo.schedule + (ms > Date.now() ? '（未到点，先别做）' : '（已到点）')),
          )
        }
        return { message: lines.join('\n'), todos: shown.map((todo) => toolTodo(todo, live)) }
      },
    }
    ctx.effect(() => tools.register(definition), 'dsh-todo-board: todo_board tool')
    }
  })

  // ------------------------------------------------- planning: skill + command
  //
  // Two halves of the same feature, and they are deliberately separate:
  //
  //   - `/todo <目标>` is the USER's entry point: it injects the template into
  //     the current session, so "拆一下这件事" is one line away.
  //   - the runtime skill is the MODEL's manual: when to split, how to size the
  //     steps, what belongs in a note. It loads on demand, so none of it costs
  //     context until a task actually needs planning.
  //
  // Both are `ctx.inject` + effect, for the same load-order reason as the tool
  // (the services may be provided after this row is applied), and both degrade
  // quietly: a deployment without `skills`/`commands` keeps working.

  /** The skill body: the manual. Assembled from the same constants the tool uses. */
  function planningSkillBody() {
    return [
      '# 用 TODO 板规划并按步执行长任务',
      '',
      '## 什么时候该拆',
      '',
      '- 用户给的任务明显分几步、或一句话说不完（多文件、多阶段、要跑好几轮验证）；',
      '- 用户明确说「拆一下 / 规划一下 / 用 TODO 板做 / 按步来」。',
      '',
      '**如果当前工作目录下已经有待办，就不要拆也不要问** —— 继续按既有顺序做即可。',
      '重复拆分会把一份计划变成两份互不相干的清单。',
      '',
      '## 怎么拆',
      '',
      '- 一条只交付一件事，能独立验收；把「改 A 再跑 B 验证」里真正可验收的那件事写成一条；',
      '- 顺序写进列表顺序（列表从上到下就是执行顺序），不要靠 note 描述顺序；',
      '- 3–8 步是常见区间。一步能做完的事不需要板子；二十步以上请分批，`add` 的 `items` 上限是 ' +
        MAX_PLAN_ITEMS + ' 条；',
      '- **每条都用 note 写清验收标准与前置条件**：note 会和标题一起发给执行它的会话，' +
        '是唯一能跨会话传递上下文的地方（面板上用户也能看到它）。',
      '',
      '## 怎么建（一次调用、一次审批）',
      '',
      '用一次 `action="add"`，把整份计划放进 `items`：',
      '',
      '```json',
      '{"action":"add","dir":"<工作目录>","items":[',
      '  {"title":"第一步…","note":"验收标准：…","mode":"resume"},',
      '  {"title":"第二步…","note":"验收标准：…","mode":"resume"}',
      ']}',
      '```',
      '',
      '- 一次调用 = 一次审批框，框里会列出每一步的标题供用户过目；',
      '- **任意一条不合法，整批都不会写入**，修好再交一次；',
      '- 先给用户看拆分结果、得到确认，再调用 —— 别把「先写板子再解释」当成默认流程。',
      '',
      '## 怎么把后续步骤放进一个新会话',
      '',
      '在 `items` 里给某一条填 `"mode":"newSession"`，再给后面的条目填 `"parent":<它的下标>`，' +
      '它们就会被带走，在那个新会话里按顺序执行：',
      '',
      '```json',
      '{"action":"add","dir":"<工作目录>","items":[',
      '  {"title":"调研…","note":"…","mode":"resume"},',
      '  {"title":"开新会话做实现","note":"…","mode":"newSession"},',
      '  {"title":"实现主体","note":"…","mode":"resume","parent":1},',
      '  {"title":"补测试","note":"…","mode":"resume","parent":1}',
      ']}',
      '```',
      '',
      '- `parent` 只能指向**本批次里更靠前**的条目（0 起），不能指向自己或后面的条目；',
      '- 父条目是 `newSession` 时子条目跟着进新会话；父条目是别的模式时只作分组，子条目仍留在当前会话；',
      '- 用户之后在面板上拖动就能改归属 —— 你现在写死的只是起点。',
      '',
      '## 模式怎么选',
      '',
      '- `resume`：同一条会话连跑，上下文连续。**大部分步骤用它**；',
      '- `newSession`：这一步起一条新会话。适合「上下文已经很长、换个干净会话接着做」，' +
      '或者这一步之后的活会被别的步骤带偏；',
      '- `remind`：只建清单、由用户点面板 ▶ 逐个开始 —— 用户明确说「只列个清单」时用这个。' +
      '**读到 `remind` 时链条会停**：它是「先规划、暂不开始」的标记，所以它后面同会话的待办不会自动接着跑。',
      '',
      '## 建完之后',
      '',
      '1. 把这份列表复述给用户（标题 + 顺序即可，不要把 note 全文倒出来）；',
      '2. 用 `ask_user_question` 问一句，三个选项：',
      '   - `就按这个做（立刻开始）` —— 用户选它，就等于授权了第一步；',
      '   - `只建清单不开始` —— 不要派发，等用户自己点 ▶；',
      '   - `我再改改` —— 按用户说的改（`update` / `reorder`），改完再问。',
      '3. 开始之后：每做完一条立刻 `action="done"`（左勾），再 `action="list"` 取同目录下一条继续，' +
        '不要停下来问用户 —— 这正是这个板子的用途。',
      '',
      '## 可粘贴给用户的模板',
      '',
      '```',
      PLAN_TEMPLATE,
      '```',
      '',
      '用户想主动让模型拆的时候，把上面这段（或 `/todo <目标>`）给他即可。',
    ].join('\n')
  }

  ctx.inject(['skills'], (skillCtx) => {
    const skills = skillCtx.get('skills')
    if (skills === undefined || typeof skills.register !== 'function') return
    skillCtx.effect(
      () =>
        skills.register({
          name: 'todo-board-planning',
          description:
            '把长任务/多阶段任务拆成 TODO 板的步骤并按顺序执行：拆分粒度、note 写什么、如何一次写入整份计划、' +
            '执行模式怎么选、建完怎么问用户。当用户给的任务分多步、或说「拆一下/规划一下/用 TODO 板做」时使用。',
          whenToUse:
            '用户交来明显可分步的长任务时；或用户提到 TODO 板、待办、按步执行、拆任务时。' +
            '当前目录下已经有待办时不要用（那说明计划已经建好了）。',
          content: planningSkillBody(),
          source: 'dsh-todo-board',
          invocation: { modelInvocable: true, userInvocable: true },
        }),
      'dsh-todo-board: planning skill',
    )
  })

  ctx.inject(['commands'], (commandCtx) => {
    const commands = commandCtx.get('commands')
    if (commands === undefined || typeof commands.register !== 'function') return
    commandCtx.effect(
      () =>
        commands.register({
          name: 'todo',
          description: '把一件事交给 TODO 板来规划和按步执行（注入拆分模板）',
          input: {
            hint: '[<目标>]',
            // The user's own attachments ride along, so "/todo 修好这个" on top of
            // a screenshot hands the model both without a second step.
            attachments: true,
          },
          handler: (invocation) => {
            const goal = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : ''
            const agent = invocation.agent
            if (agent === undefined || agent === null || typeof agent.followup !== 'function') {
              return { kind: 'error', text: '这个会话暂时不能接收消息，无法注入拆分模板。' }
            }
            // `/todo` with no goal is a usage error, NOT an injection. Injecting the
            // template alone would make the model plan "<一句话说清最终要什么>"
            // literally — a command that silently does the wrong thing is worse
            // than one that asks for its argument.
            if (goal === '') {
              return {
                kind: 'error',
                text: '用法：/todo <目标>。例如 /todo 把日志模块拆成可验收的几步并做完。',
              }
            }
            const text = PLAN_TEMPLATE.replace('【目标】<一句话说清最终要什么>', '【目标】' + goal)
            const attachments = Array.isArray(invocation.attachments) ? invocation.attachments : []
            agent.followup(
              noticeMessage(
                [{ type: 'text', text }, ...attachments],
                'TODO 板拆分模板：' + goal,
              ),
            )
            return { kind: 'success', text: '已把「' + goal + '」交给模型拆分，稍等它给出计划。' }
          },
        }),
      'dsh-todo-board: /todo command',
    )
  })

  // ---------------------------------------------- scheduled execution timer
  //
  // Armed here rather than inline above so the timer is torn down with the
  // plugin row instead of leaking a timeout across a reload.

  ctx.effect(() => {
    armTimer()
    scheduleTick = setInterval(() => fireDue(), SCHEDULE_TICK_MS)
    if (typeof scheduleTick.unref === 'function') scheduleTick.unref()
    return () => {
      if (scheduleTimer !== undefined) clearTimeout(scheduleTimer)
      if (scheduleTick !== undefined) clearInterval(scheduleTick)
      scheduleTimer = undefined
      scheduleTick = undefined
    }
  }, 'dsh-todo-board: scheduled execution timer')

  // ------------------------------------------------------------ HTTP route

  /**
   * Non-loopback authorities this deployment serves.
   *
   * Read from the web runtime when it exists; absent (a non-web host, or one
   * without `dsh-web-app`) leaves loopback-only, which is the right default for
   * a plugin route. Resolved per request rather than cached at load: the
   * runtime is provided by a sibling row and need not exist yet when this
   * plugin's own rows mount.
   *
   * Only the FALLBACK fence reads this now (see `harnessConnection`): when the
   * harness's own gate is present it already carries the same trusted-host list.
   */
  function trustedHosts() {
    const rootCtx = ctx.root === undefined ? ctx : ctx.root
    for (const source of [ctx, rootCtx]) {
      try {
        if (source === undefined || typeof source.get !== 'function') continue
        const runtime = source.get('webRuntime')
        const hosts = runtime === undefined || runtime === null ? undefined : runtime.trustedHosts
        if (Array.isArray(hosts)) return hosts
      } catch (err) {
        /* fall through to the next source */
      }
    }
    return []
  }

  /**
   * The harness' own Host Connection gate, when this deployment has one.
   *
   * `dsh-client-connection` provides it as the `connection` service, and its
   * `requestRejection` is the WHOLE fence:
   *
   *   1. `isTrustedApiRequest` — Host/Origin, the half v0.9.0 restated locally;
   *   2. `browserAuth.isAuthenticated` — is this a browser we handed a session?
   *
   * Only the second half answers "may a local process talk to this route?", and
   * that is exactly the half the restatement was missing: an AI with a shell
   * could POST the board route directly and bypass the approval gate on the
   * tool entirely (`docs/design-ai-dispatch.md` §12). Borrowing the harness's
   * gate closes that channel AND keeps working when DSH changes how it
   * authenticates.
   *
   * Resolved per request rather than cached at load, like `trustedHosts()`: the
   * service comes from a sibling row and need not exist yet when this plugin's
   * own rows mount.
   */
  function harnessConnection() {
    const rootCtx = ctx.root === undefined ? ctx : ctx.root
    for (const source of [ctx, rootCtx]) {
      try {
        if (source === undefined || source === null || typeof source.get !== 'function') continue
        const connection = source.get('connection')
        if (connection === undefined || connection === null) continue
        if (typeof connection.requestRejection !== 'function') continue
        return connection
      } catch (err) {
        /* fall through to the next source */
      }
    }
    return undefined
  }

  /**
   * Refusals already seen, per requesting host.
   *
   * Replaces a plain "log the first 20" counter. That cap assumed noise comes
   * from many DISTINCT requests; in practice one caller (the plugin market,
   * probing every local route) retries forever, so the log filled with twenty
   * identical lines per process start and everything else was buried. Keying by
   * host makes the first one verbose and the rest silent, which is the shape
   * the noise actually has.
   */
  const refusalCounts = new Map()

  /**
   * Apply the trust fence, answering the request when it fails.
   *
   * The harness gate is preferred; the local restatement is the fallback for a
   * deployment without `dsh-client-connection` (it is still the only fence
   * there, and `tools/check-fence-parity.mjs` keeps it honest against the
   * original). Both return the same shape — a status, or `undefined` to allow —
   * so nothing downstream cares which one answered.
   *
   * @returns true when the response is already sent and the caller must stop.
   */
  function refuseUntrusted(request, response, label) {
    const connection = harnessConnection()
    let status
    let fence = 'harness'
    if (connection === undefined) {
      fence = 'local'
      status = requestRejection(request, trustedHosts())
    } else {
      try {
        status = connection.requestRejection(request)
      } catch (err) {
        // A gate that throws must refuse the request, not take the route down.
        log('error', 'todo-board: 信任校验抛错，按拒绝处理（' + label + '）', err)
        status = 403
      }
      // Only `undefined` means allow. Anything else that is not a status is a
      // gate we do not understand, and fail-closed is the only safe reading.
      if (status !== undefined && typeof status !== 'number') status = 403
    }
    if (status === undefined) return false
    // Worth recording: the honest cause is usually a deployment detail (a LAN
    // address not in `trustedHosts`, or a browser that never exchanged the
    // `?token=` launch URL for a session cookie) rather than an attack, and
    // "why is the panel getting 401/403?" is otherwise unanswerable.
    //
    // NOISE CONTROL, learned the hard way: a cap of "20 entries" per process
    // looked sufficient, but one known caller (the plugin market probing every
    // local route) retries constantly, so a restart produced twenty fresh
    // warnings and buried everything else in the log. The cap counted LOG LINES
    // when what repeats is the CALLER.
    //
    // So refusals are aggregated per host: the first refusal from a host is
    // logged in full (that is the one a human needs to read), and every later
    // one from that same host only bumps a counter that rides the next line.
    // A genuinely new host still gets its own full message, and the totals are
    // flushed when the process ends, so nothing is lost — just folded.
    const headers = request === undefined || request === null ? undefined : request.headers
    const host = String(headerValue(headers, 'host') ?? '(无)')
    const seenRefusal = refusalCounts.get(host)
    if (seenRefusal === undefined) {
      refusalCounts.set(host, 1)
      log(
        'warn',
        'todo-board: 拒绝了未通过信任校验的请求（' + label + '，' + fence +
          '，status=' + status +
          (status === 401 ? '（缺少浏览器会话凭据：用 dsh web 打印的那条带 token 的地址重开页面）' : '') +
          '，host=' + host +
          '，origin=' + String(headerValue(headers, 'origin') ?? '(无)') +
          '，sec-fetch-site=' + String(headerValue(headers, 'sec-fetch-site') ?? '(无)') +
          '。同一来源的后续拒绝只累计，不再逐条记录）',
      )
    } else {
      refusalCounts.set(host, seenRefusal + 1)
    }
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(status === 401 ? 'unauthorized' : 'forbidden')
    return true
  }

  /**
   * Serve one attachment's bytes for the panel's thumbnails.
   *
   * The harness' own image route is session-scoped and refuses an attachment no
   * session log references — ours live on the board, so the board is the
   * authority here: an id that no todo references is a 404, never a read.
   */
  async function sendBoardImage(response, attachmentId) {
    let ref
    for (const todo of board.todos) {
      for (const image of todo.images) {
        if (image.attachmentId === attachmentId) {
          ref = image
          break
        }
      }
      if (ref !== undefined) break
    }
    if (ref === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('unknown attachment')
      return
    }
    const store = ctx.get('attachments')
    if (store === undefined) {
      response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('attachments service unavailable')
      return
    }
    const stored = await store.readImage(ref)
    const body = Buffer.from(stored.data)
    response.writeHead(200, {
      'content-type': stored.ref.mediaType,
      'content-length': String(body.length),
      'cache-control': 'private, max-age=3600',
    })
    response.end(body)
  }

  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(
      () =>
        hostCtx.webServer.register({
          kind: 'prefix',
          path: IMAGE_ROUTE,
          handler: async (request, response) => {
            try {
              if (refuseUntrusted(request, response, 'image')) return
              if (request.method !== 'GET') {
                response.writeHead(405, { allow: 'GET' })
                response.end()
                return
              }
              const url = new URL(request.url === undefined ? '/' : request.url, 'http://localhost')
              const id = url.searchParams.get('id')
              await sendBoardImage(response, id === null ? '' : id)
            } catch (err) {
              response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
              response.end(errText(err))
            }
          },
        }),
      'dsh-todo-board: image route',
    )
  })

  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(
      () =>
        hostCtx.webServer.register({
          kind: 'exact',
          path: ROUTE,
          handler: async (request, response) => {
            try {
              if (refuseUntrusted(request, response, 'api')) return
              if (request.method === 'GET') {
                // Log content rides the EXISTING poll rather than a second
                // transport, and only when the log view is open. That keeps the
                // idle payload byte-for-byte what it always was — which is also
                // what satisfies "平时不能在面板中暴露给用户": with the view
                // closed, no log text ever leaves the host.
                const url = new URL(request.url === undefined ? '/' : request.url, 'http://localhost')
                const wantsLogs = url.searchParams.get('logs') === '1'
                const sinceRaw = Number(url.searchParams.get('since'))
                sendJson(
                  response,
                  200,
                  snapshotPayload({
                    withLogs: wantsLogs,
                    since: Number.isFinite(sinceRaw) ? sinceRaw : 0,
                  }),
                )
                return
              }
              if (request.method !== 'POST') {
                response.writeHead(405, { allow: 'GET, POST' })
                response.end()
                return
              }
              const body = await readJsonBody(request)
              const action = typeof body.action === 'string' ? body.action : ''
              let result
              if (action === 'create') result = await createTodo(body)
              else if (action === 'patch') result = await patchTodo(body)
              else if (action === 'reorder') result = reorderTodos(body)
              else if (action === 'remove') result = removeTodo(body)
              else if (action === 'clearVerified') result = clearVerified()
              else if (action === 'settings') result = saveSettings(body)
              else if (action === 'layout') result = saveLayout(body)
              else if (action === 'run') result = await runTodo(body)
              // The panel reports that the person walked away from a session.
              // The host already catches that through `agent/disposed` and the
              // grace timer, but neither fires while the browser simply switches
              // conversations — the session stays alive and stays quiet. This is
              // the one signal only the client has.
              else if (action === 'autoflush') result = { ok: true, flushed: autoFlush(body.sessionId) }
              else result = { ok: false, error: 'unknown action: ' + (action || '(empty)') }
              sendJson(response, 200, result)
            } catch (err) {
              log('error', 'todo-board: HTTP 路由处理失败（api）', err)
              sendJson(response, 500, { ok: false, error: errText(err) })
            }
          },
        }),
      'dsh-todo-board: api route',
    )
  })
}
