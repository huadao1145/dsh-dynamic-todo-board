/**
 * Mutation check for the host-half behaviours that no other suite can prove.
 *
 * Every mutant here is the kind that a green suite keeps green after the code is
 * deleted — which is the only reason this file exists:
 *
 *   - **the approval gate** (v0.9.1) — delete it and every write still works, silently;
 *   - **channel convergence** (v0.9.1) — prefer the local restatement again and the
 *     board route once more accepts any local process;
 *   - **the `ctx.inject` rewrite** (v0.9.1) — go back to a load-order-dependent read
 *     at apply time and the model tool silently disappears (the panel keeps working,
 *     which is exactly why nobody noticed for so long);
 *   - **the model-side actions** (v0.9.1) — drop a guard and `update` half-applies,
 *     `reorder` crosses directories, or `dispatch` re-sends a row;
 *   - **planning** (v0.11.0) — the promises that make a one-approval batch honest
 *     (all-or-nothing, and a dialog that shows the plan) and the two thresholds plus
 *     the one-shot rule that keep the planning offer from becoming noise.
 *
 * So each is applied in turn and the suite that owns it must FAIL. The mutant is
 * reverted on every exit path — including Ctrl-C — and `lib/index.js` is verified
 * byte-for-byte before the run is reported as successful: this file is what the
 * live dev install loads.
 *
 * The child's output is deliberately NOT piped: under a restricted sandbox a
 * piped stdio spawn fails with EPERM, which would look exactly like a caught
 * mutation. Only the exit status is inspected.
 *
 *   node tools/check-host-guard.mjs
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolved from this file, never hard-coded: the repo can live anywhere, and
// this package is published.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const p = join(ROOT, 'lib', 'index.js')

/**
 * The working copy may be CRLF (the repo sets `core.autocrlf`) while the
 * mutants below are written with plain `\n`, so every multi-line pattern is
 * matched against an LF-normalized copy and restored byte-for-byte at the end.
 */
const raw = fs.readFileSync(p, 'utf8')
const NEWLINE = raw.includes('\r\n') ? '\r\n' : '\n'
const original = raw.split('\r\n').join('\n')

function write(text) {
  fs.writeFileSync(p, NEWLINE === '\n' ? text : text.split('\n').join('\r\n'), 'utf8')
}

function restore() {
  try {
    if (fs.readFileSync(p, 'utf8') !== raw) fs.writeFileSync(p, raw, 'utf8')
  } catch (err) {
    console.error('RESTORE FAILED: ' + err.message)
  }
}

// Never leave a mutant on disk, whatever ends the process.
process.on('SIGINT', () => {
  restore()
  process.exit(130)
})
process.on('SIGTERM', () => {
  restore()
  process.exit(143)
})
process.on('uncaughtException', (err) => {
  restore()
  console.error(err)
  process.exit(2)
})

const mutants = [
  {
    // The gate that always says yes: a write lands with no approval asked.
    name: 'approval gate allows every write',
    suite: 'tools/smoke.mjs',
    from: "    return { kind: 'ask', reason: 'AI 要修改待办板：' + approvalDetail(action, input) }",
    to: '    return next()',
  },
  {
    // Gating today's actions but not tomorrow's: a new write action would ship
    // silently ungated, which is the failure mode the allowlist exists to stop.
    name: 'approval gate knows only the actions it was written for',
    suite: 'tools/smoke.mjs',
    from: "    if (APPROVAL_FREE_ACTIONS.indexOf(action) >= 0) return next()",
    to: "    if (action !== 'add') return next()",
  },
  {
    // The pre-0.9.1 fence again: only the local restatement, so a local process
    // (an AI with a shell) may write the board behind the tool gate's back.
    name: 'route ignores the harness connection gate',
    suite: 'tools/smoke.mjs',
    from: "        const connection = source.get('connection')",
    to: '        const connection = undefined',
  },
  {
    // A gate that throws must refuse; reopening on error is how a fence becomes
    // a suggestion.
    name: 'a throwing trust gate fails open',
    suite: 'tools/smoke.mjs',
    from: "        log('error', 'todo-board: 信任校验抛错，按拒绝处理（' + label + '）', err)\n        status = 403",
    to: "        log('error', 'todo-board: 信任校验抛错，按拒绝处理（' + label + '）', err)\n        status = undefined",
  },
  {
    // The v0.9.0 bug itself: decide registration from what exists at apply time.
    // Under the stub suite this still passes — which is precisely why the bug
    // survived — so this mutant is owned by the live-runtime suite.
    name: 'model tool registration depends on load order again',
    suite: 'tools/check-live.mjs',
    from: "  ctx.inject(['tools'], (toolsCtx) => {",
    to: "  if (ctx.get('tools') !== undefined) ctx.inject(['tools'], (toolsCtx) => {",
  },
  {
    // The model-side actions (v0.9.1): each guard is the thing that makes the
    // action safe to hand a model, so each is reverted on its own.
    name: 'update accepts a mode that is not a mode (and half-applies)',
    suite: 'tools/smoke.mjs',
    from: "          if (wantedMode !== '' && MODES.indexOf(wantedMode) < 0) {",
    to: '          if (false) {',
  },
  {
    name: 'reorder crosses directories (queues the user never offered)',
    suite: 'tools/smoke.mjs',
    from: '          if (dirs.length > 1) {',
    to: '          if (false) {',
  },
  {
    name: 'dispatch re-sends a row that is already out there',
    suite: 'tools/smoke.mjs',
    from: "          if (state !== 'pending') {",
    to: '          if (false) {',
  },
  {
    // The bug that corrupted a real session: `user/message` content must be
    // `ContentBlock[]`, and a bare string makes the WHOLE log unopenable.
    name: 'newSession dispatch hands the agent a bare string as content',
    suite: 'tools/check-session-format.mjs',
    from: "noticeMessage(todoContent(todo), 'TODO 接续（新会话）：' + todo.title)",
    to: "noticeMessage(todoPrompt(todo), 'TODO 接续（新会话）：' + todo.title)",
  },
  {
    // v0.11.0 planning. Each mutant deletes one of the promises the feature
    // makes: the batch is all-or-nothing, the dialog shows the plan, the offer
    // fires on staged work (and only on staged work), and the command injects a
    // real user message rather than a string.
    // The real all-or-nothing risk: skip the offending item instead of refusing
    // the batch. The good items then land, and the user gets a DIFFERENT plan
    // from the one they approved.
    name: 'a bad item is skipped instead of refusing the whole plan',
    suite: 'tools/smoke.mjs',
    from: "              return { message: where + 'add 需要提供 title，整批未创建（一条都没落库）。', todos: [] }",
    to: '              continue',
  },
  {
    name: 'the approval dialog only says "add" (the plan is approved unread)',
    suite: 'tools/smoke.mjs',
    from: "      if (Array.isArray(input.items) && input.items.length > 0) {\n        const titles = input.items.map((entry, at) => {",
    to: "      if (false) {\n        const titles = input.items.map((entry, at) => {",
  },
  {
    // 0.13.3 made these thresholds board settings, so the anchors read
    // `settings.*` now. The two mutants below are unchanged in INTENT — "dead
    // code" and "fires on anything" — only their anchor moved.
    name: 'the planning offer never fires (the nudge is dead code)',
    suite: 'tools/smoke.mjs',
    from: '    return hits >= settings.minEntries',
    to: '    return false',
  },
  {
    name: 'the planning offer fires on anything long (it becomes noise)',
    suite: 'tools/smoke.mjs',
    from: '    if (body.length < settings.minChars) return false',
    to: '    if (false) return false',
  },
  {
    name: 'the offer repeats every step (the user is nagged)',
    suite: 'tools/smoke.mjs',
    from: '      if (planningNudged.has(agent)) return next()',
    to: '      if (false) return next()',
  },
  {
    name: '/todo injects a bare string as message content',
    suite: 'tools/check-live.mjs',
    from: "                [{ type: 'text', text }, ...attachments],",
    to: '                text,',
  },
  {
    // A rejected parameter schema means the tool SILENTLY does not exist — the
    // exact failure mode the ctx.inject rewrite was about. `format` is outside the
    // supported subset, so this is a schema the harness refuses.
    name: 'the tool schema uses a keyword the harness does not support',
    suite: 'tools/check-live.mjs',
    from: "          title: { type: 'string', description: '这一条待办的内容（一句话，可独立验收）。' },",
    to: "          title: { type: 'string', format: 'uri', description: '这一条待办的内容（一句话，可独立验收）。' },",
  },
  {
    // v0.13.1: ownership follows the run. The spawned session's panel must own
    // the container that opened it — reverting to the plain container walk
    // resolves the row back to the planning session, and the spawned session's
    // tab loses the row it is standing in (problem 2's exact symptom).
    name: 'a spawned container is owned by the planner again (the spawned tab goes blind)',
    suite: 'tools/smoke.mjs',
    from: '      ownerSessionId: target !== \'\' ? target : effectiveTarget(todo),',
    to: '      ownerSessionId: effectiveTarget(todo),',
  },
  {
    // v0.13.1, same feature: an explicit run binding is the strongest ownership
    // claim there is. Dropping the runSessionId arm makes a dispatched row keep
    // reporting its pre-dispatch owner, so the panel never shows 已派发 where
    // it actually runs.
    name: 'a dispatched row keeps reporting its pre-dispatch owner',
    suite: 'tools/smoke.mjs',
    from: '    if (todo.runSessionId !== \'\') return todo.runSessionId',
    to: '    if (false) return todo.runSessionId',
  },
]

/** `true` when the named suite passes. Output is discarded on purpose. */
function suitePasses(suite) {
  const result = spawnSync(process.execPath, [join(ROOT, ...suite.split('/'))], {
    cwd: ROOT,
    stdio: 'ignore',
  })
  // A signal (sandbox kill, crash) is not a pass; require a clean exit 0.
  return result.status === 0
}

let allCaught = true
try {
  for (const mutant of mutants) {
    if (!original.includes(mutant.from)) {
      console.error('SKIP (pattern not found): ' + mutant.name)
      allCaught = false
      continue
    }
    write(original.replace(mutant.from, mutant.to))
    const passed = suitePasses(mutant.suite)
    restore()
    if (passed) {
      console.error('NOT CAUGHT by ' + mutant.suite + ': ' + mutant.name)
      allCaught = false
    } else {
      console.log('caught: ' + mutant.name + ' (' + mutant.suite + ')')
    }
  }
} finally {
  restore()
}

// The file must be exactly as it was, whatever happened above.
if (fs.readFileSync(p, 'utf8') !== raw) {
  console.error('RESTORE FAILED — lib/index.js differs from the original!')
  process.exit(2)
}

for (const suite of [...new Set(mutants.map((mutant) => mutant.suite))]) {
  if (!suitePasses(suite)) {
    console.error('the unmutated ' + suite + ' does not pass — the check above is meaningless')
    process.exit(2)
  }
}

if (!allCaught) process.exit(1)
console.log('\nall ' + mutants.length + ' host-side mutations caught; original restored and passing')
