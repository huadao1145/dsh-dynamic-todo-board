/**
 * Parity check: the template a user copies out of the README vs. the one the
 * plugin actually injects.
 *
 * The template lives in exactly one place in code (`PLAN_TEMPLATE`), and it is
 * SHOWN in three: the `/todo` command, the runtime skill body, and the README.
 * The README copy is the one users paste, and it is also the one no test would
 * otherwise touch — so it is the copy that silently goes stale after an edit to
 * the constant. That failure is invisible: the documented prompt keeps "working",
 * it just stops matching what the plugin is built around.
 *
 * So this extracts the fenced block under the documented heading and compares it
 * to the constant, character for character.
 *
 *   node tools/check-template-parity.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Pull one template literal out of the host source by its constant name. */
function extractTemplate(source, name) {
  const marker = 'const ' + name + ' = ['
  const start = source.indexOf(marker)
  assert.ok(start >= 0, 'found ' + name + ' in lib/index.js')
  const end = source.indexOf("].join('\\n')", start)
  assert.ok(end > start, 'found the end of ' + name)

  // The array is a list of single-quoted strings; evaluate just that literal
  // rather than re-implementing JS parsing, so escapes behave exactly as at runtime.
  const literal = source.slice(start + ('const ' + name + ' = ').length, end + 1)
  // eslint-disable-next-line no-new-func -- the input is this repository's own source
  return new Function('return ' + literal + ".join('\\n')")()
}

const ours = extractTemplate(readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8'), 'PLAN_TEMPLATE')

const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
const heading = readme.indexOf('### 复制这段给模型')
assert.ok(heading >= 0, 'the README still has the "复制这段给模型" section')

const fence = readme.indexOf('```', heading)
assert.ok(fence > heading, 'and a fenced block under it')
const open = readme.indexOf('\n', fence)
const close = readme.indexOf('```', open)
assert.ok(close > open, 'and the block is closed')

const documented = readme.slice(open + 1, close).replace(/\n$/, '')
assert.equal(
  documented,
  ours,
  'the README template and PLAN_TEMPLATE are the same text, character for character.\n' +
    'If you changed the constant on purpose, paste the new text into README.md too.',
)

// The skill body embeds the same constant, so a user who finds the skill can copy
// it as well — and it must not be a stale second copy.
assert.ok(
  readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8').includes('PLAN_TEMPLATE,'),
  'the skill body interpolates PLAN_TEMPLATE rather than restating it',
)

console.log(
  'template OK — README and PLAN_TEMPLATE agree (' + ours.split('\n').length + ' lines)',
)
