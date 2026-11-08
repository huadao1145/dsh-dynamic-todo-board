// Mutation guard: the planning-nudge SETTINGS must actually be honoured.
//
// The thresholds used to be module constants, which made "this looks
// multi-stage" a question about whoever last edited the source. They are board
// settings now — and a setting nobody honours is worse than no setting: the UI
// would offer two numbers that change nothing.
//
// Each mutation below breaks ONE way the wiring can be faked. The `suite` field
// names the check that must catch it, because the failure surfaces differ:
// the threshold logic shows up through the hook (smoke), while the write path
// and the snapshot only exist over the route (check-http).
//
//   node tools/check-nudge-settings-guard.mjs
//
// Requires write access to lib/index.js — same as the other guards, which also
// mutate the source in place and restore it.

import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const TARGET = 'lib/index.js'
const original = readFileSync(TARGET)

const MUTATIONS = [
  {
    suite: 'tools/smoke.mjs',
    name: 'the off switch is ignored (turn it off, still get offered)',
    from: 'if (settings.nudge !== true) return next()',
    to: 'if (false) return next()',
  },
  {
    suite: 'tools/smoke.mjs',
    name: 'minChars is hardcoded (the 字数 box does nothing)',
    from: 'if (body.length < settings.minChars) return false',
    to: 'if (body.length < 200) return false',
  },
  {
    suite: 'tools/smoke.mjs',
    name: 'minEntries is hardcoded (the 条目数 box does nothing)',
    from: 'return hits >= settings.minEntries',
    to: 'return hits >= 2',
  },
  {
    // The "validate then write" rule, broken the way it is usually broken: the
    // new object is committed BEFORE the loop that can still reject it. The
    // user then gets an error AND a half-applied board.
    suite: 'tools/check-http.mjs',
    name: 'settings are applied before validation (a rejected write still lands)',
    from: "    const next = { ...board.settings }\n    if (Object.prototype.hasOwnProperty.call(raw, 'nudge')) {",
    to: "    const next = { ...board.settings }\n    board.settings = next\n    if (Object.prototype.hasOwnProperty.call(raw, 'nudge')) {",
  },
  {
    // The panel reads the values off the polled snapshot; if the host stops
    // shipping them the settings page silently falls back to its built-in
    // defaults, and SAVING from it would overwrite whatever the user had.
    suite: 'tools/check-http.mjs',
    name: 'the snapshot stops carrying settings (the form reads stale defaults)',
    from: 'settings: { ...board.settings },',
    to: 'settings: { ...DEFAULT_SETTINGS },',
  },
]

let failed = 0
try {
  for (const mutation of MUTATIONS) {
    const text = original.toString('utf8')
    // Anchors are written with `\n`, but a Windows checkout has the file on
    // disk as CRLF — so a multi-line anchor silently stops matching and the
    // guard reports "anchor missing" instead of catching anything. Match
    // against a normalized copy and apply the mutation to the current line
    // ending, so this guard behaves the same on either checkout.
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    const anchor = mutation.from.split('\n').join(eol)
    const replacement = mutation.to.split('\n').join(eol)
    if (!text.includes(anchor)) {
      console.log('SKIP (anchor missing): ' + mutation.name)
      failed += 1
      continue
    }
    writeFileSync(TARGET, text.replace(anchor, replacement))
    let caught = false
    try {
      execFileSync(process.execPath, [mutation.suite], { stdio: 'pipe' })
    } catch {
      caught = true
    }
    console.log((caught ? 'caught: ' : 'MISSED: ') + mutation.name + ' (' + mutation.suite + ')')
    if (!caught) failed += 1
  }
} finally {
  writeFileSync(TARGET, original)
}

// The restore has to be proven, not assumed: a guard that leaves the source
// mutated is worse than no guard at all.
try {
  execFileSync(process.execPath, ['tools/smoke.mjs'], { stdio: 'pipe' })
  console.log('original restored and passing')
} catch {
  console.log('FAILED: the original does not pass after restore')
  failed += 1
}

console.log(
  failed === 0
    ? '\nall ' + MUTATIONS.length + ' nudge-settings mutations caught'
    : '\n' + failed + ' problem(s)',
)
process.exit(failed === 0 ? 0 : 1)
