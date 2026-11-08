/**
 * Mutation check for the viewport-clamp tests.
 *
 * A green suite proves nothing unless the tests can actually fail. This applies
 * each half of the bug in turn and asserts `client-smoke.mjs` catches it:
 *
 *   1. no resize listener   — the panel is cropped when the window narrows
 *   2. no clamp on load     — an off-screen stored layout stays off-screen
 *
 * The child's output is deliberately NOT piped: under a restricted sandbox a
 * piped stdio spawn fails with EPERM, which would look exactly like a caught
 * mutation. Only the exit status is inspected.
 *
 * This rewrites `client/client.js` for the duration of each mutant, so the
 * original is restored on every exit path — including Ctrl-C — and verified
 * byte-for-byte before the run is reported as successful. That matters here
 * because the dev install is a junction onto this very file.
 *
 *   node tools/check-clamp-guard.mjs
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolved from this file, never hard-coded: the repo can live anywhere, and
// this package is published.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const p = join(ROOT, 'client', 'client.js')
const original = fs.readFileSync(p, 'utf8')

function restore() {
  try {
    if (fs.readFileSync(p, 'utf8') !== original) fs.writeFileSync(p, original, 'utf8')
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
    name: 'no resize listener (cropped when the window narrows)',
    from: "    window.addEventListener('resize', reclamp)",
    to: '    // mutated: no resize listener',
  },
  {
    name: 'no clamp on load (off-screen layout stays off-screen)',
    from: 'return { preferred: stored, clamped: stored === null ? null : clampLayout(stored) }',
    to: 'return { preferred: stored, clamped: stored }',
  },
  {
    name: 'a parked re-clamp uses the card box (the line is bounded by the wrong shape)',
    from: '        const next = open ? clampLayout(source) : clampParked(source, pillBox(pillRef.current))',
    to: '        const next = clampLayout(source)',
  },
]

/** `true` when the suite passes. Output is discarded on purpose (see above). */
function suitePasses() {
  const result = spawnSync(process.execPath, [join(ROOT, 'tools', 'client-smoke.mjs')], {
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
    fs.writeFileSync(p, original.replace(mutant.from, mutant.to), 'utf8')
    const passed = suitePasses()
    restore()
    if (passed) {
      console.error('NOT CAUGHT: ' + mutant.name)
      allCaught = false
    } else {
      console.log('caught: ' + mutant.name)
    }
  }
} finally {
  restore()
}

// The file must be exactly as it was, whatever happened above.
if (fs.readFileSync(p, 'utf8') !== original) {
  console.error('RESTORE FAILED — client.js differs from the original!')
  process.exit(2)
}

if (!suitePasses()) {
  console.error('the unmutated suite does not pass — the check above is meaningless')
  process.exit(2)
}

if (!allCaught) process.exit(1)
console.log('\nevery mutation caught; original restored and passing')
