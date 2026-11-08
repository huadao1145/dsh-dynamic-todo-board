/**
 * Parity check: our restated browser-trust fence vs. the harness's own.
 *
 * The plugin route is outside the harness's `/api` channel, so a fence had to be
 * restated here (see `docs/design-log-view.md` §5.3). A restatement can drift
 * from the original, and the drift is silent: the route would simply be laxer
 * than the channel it imitates, which no other test would notice.
 *
 * So this extracts BOTH predicates from their real sources and runs them over a
 * table of edge cases — loopback spellings, port forms, rebinding-style hosts,
 * origin and fetch-metadata combinations. A divergence names the exact case.
 *
 * Since v0.9.1 the restatement is only the FALLBACK (a deployment without
 * `dsh-client-connection`); the route prefers the harness' own
 * `connection.requestRejection`, which it borrows whole. That claim is pinned at
 * the bottom of this file, because a harness that quietly weakened that method
 * would take the route's authorization layer with it.
 *
 *   node tools/check-fence-parity.mjs
 *
 * Skips loudly when the harness is not installed (nothing to compare against).
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONNECTION =
  process.env.DSHTB_CONNECTION ??
  'C:/Users/XIAO/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js'

let harnessSource
try {
  harnessSource = readFileSync(CONNECTION, 'utf8')
} catch (err) {
  console.error('SKIP: the harness connection package is not reachable at ' + CONNECTION)
  console.error('      set DSHTB_CONNECTION to its lib/index.js to run this check.')
  process.exit(0)
}

/**
 * Pull one `function name(...) { ... }` body out of a source file.
 *
 * Matched by plain string search rather than a regex, so a name containing
 * regex metacharacters (`header$1`, as the bundler renames it) needs no
 * escaping and cannot silently fail to match.
 */
function extract(source, name) {
  const start = source.indexOf('function ' + name + '(')
  assert.ok(start >= 0, 'found ' + name + ' in the source')
  const end = source.indexOf('\n}', start)
  assert.ok(end > start, 'found the end of ' + name)
  return source.slice(start, end + 2)
}

// The harness's predicate is module-private, so its dependencies plus the
// predicate itself are re-evaluated here. `header$1` is the bundler's renamed
// header reader.
const harnessIsTrusted = new Function(
  extract(harnessSource, 'header$1') +
    extract(harnessSource, 'isLoopbackHostname') +
    extract(harnessSource, 'parseAuthority') +
    extract(harnessSource, 'canonicalAuthority') +
    extract(harnessSource, 'isTrustedAuthority') +
    extract(harnessSource, 'isTrustedApiRequest') +
    '; return isTrustedApiRequest',
)()

const oursSource = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
const oursRejection = new Function(
  extract(oursSource, 'isLoopbackHostname') +
    extract(oursSource, 'parseAuthority') +
    extract(oursSource, 'canonicalAuthority') +
    extract(oursSource, 'isTrustedAuthority') +
    extract(oursSource, 'headerValue') +
    extract(oursSource, 'requestRejection') +
    '; return requestRejection',
)()

/** Host spellings and marker combinations both fences must judge identically. */
const CASES = [
  { host: '127.0.0.1:3080' },
  { host: '127.0.0.1' },
  { host: 'localhost:3080' },
  { host: 'localhost' },
  { host: 'LOCALHOST:3080' },
  { host: '[::1]:3080' },
  { host: '127.0.0.2:3080' },
  { host: '127.255.255.255' },
  { host: '128.0.0.1' }, // not loopback: 128/8 is public
  { host: '127.0.0.1.example.com' },
  { host: 'evil.example' },
  { host: '0x7f.0.0.1' }, // hex spelling of loopback — must NOT be accepted
  { host: '127.1' },
  { host: '127.0.0.1:80' },
  { host: '127.0.0.1:080' },
  { host: 'not a host at all' },
  { host: '' },
  { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
  { host: '127.0.0.1:3080', origin: 'http://evil.example' },
  { host: '127.0.0.1:3080', origin: 'https://127.0.0.1:3080' },
  { host: '127.0.0.1:3080', origin: 'not a url' },
  { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' },
  { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' },
  { host: '127.0.0.1:3080', 'sec-fetch-site': 'none' },
]

const TRUSTED_SETS = [[], ['harness.internal'], ['harness.internal:9000']]

let compared = 0
for (const trusted of TRUSTED_SETS) {
  for (const testCase of CASES) {
    const headers = { host: testCase.host }
    if (testCase.origin !== undefined) headers.origin = testCase.origin
    if (testCase['sec-fetch-site'] !== undefined) headers['sec-fetch-site'] = testCase['sec-fetch-site']

    const harnessAllows = harnessIsTrusted({ headers }, trusted)
    // Our fence returns a refusal status instead of a boolean.
    const oursAllows = oursRejection({ headers }, trusted) === undefined
    compared += 1
    assert.equal(
      oursAllows,
      harnessAllows,
      'fence agrees for ' + JSON.stringify({ trusted, headers }) +
        ' (harness=' + harnessAllows + ', ours=' + oursAllows + ')',
    )
  }
}

console.log(
  'parity  OK — our fence agrees with the harness on all ' + compared +
    ' host/origin/fetch-metadata cases',
)

// -- the claim the route now rests on ----------------------------------------
//
// The parity above is about a deployment WITHOUT `dsh-client-connection`: the
// route prefers the harness' own `connection.requestRejection` whenever it
// exists, and only falls back to the restatement here. So what it borrows has
// to keep doing BOTH halves —
//
//   1. `isTrustedApiRequest` — the Host/Origin half (this restatement), and
//   2. `browserAuth.isAuthenticated` — is this a browser we gave a session to?
//
// The second half is the one that stops a local process, and therefore the one
// the approval gate on the tool depends on: without it an AI with a shell can
// POST the route directly and write the board behind the gate's back
// (`docs/design-ai-dispatch.md` §12). If DSH ever reduces `requestRejection` to
// the Host/Origin half, our route silently loses that protection and no other
// check in this repo would notice — so the composition is pinned here.

/** Pull one class method body out of the harness source. */
function extractMethod(source, signature) {
  const start = source.indexOf(signature)
  assert.ok(start >= 0, 'found ' + signature + ' in the harness source')
  const end = source.indexOf('\n\t}', start)
  assert.ok(end > start, 'found the end of ' + signature)
  return source.slice(start, end)
}

const borrowed = extractMethod(harnessSource, 'requestRejection(request) {')
assert.ok(
  borrowed.includes('isTrustedApiRequest'),
  'the harness gate still applies the Host/Origin fence — re-verify §12 if it does not:\n' + borrowed,
)
assert.ok(
  borrowed.includes('isAuthenticated'),
  'the harness gate still applies browser authentication. If DSH dropped it, the route would ' +
    'once again accept any local client and the approval gate would be bypassable by shell — ' +
    're-read docs/design-ai-dispatch.md §12 before relaxing this:\n' + borrowed,
)
console.log('borrow  OK — the harness gate we prefer still checks Host/Origin AND browser auth')
