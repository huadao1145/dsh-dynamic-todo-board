// Mutation check: the approval-`never` rules must actually fail when broken.
// Mutates lib/index.js in memory, runs check-live, then restores byte-for-byte.
//
// Driven by check-live rather than smoke: the whole point of these rules is how
// the REAL tool pipeline resolves a gate, and smoke's `inject` calls the
// listener directly.
//
// Every anchor is a SINGLE line on purpose — lib/index.js is CRLF throughout, so
// a multi-line anchor written with `\n` silently matches nothing, and a guard
// whose mutation never applies reports success while testing nothing.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const TARGET = 'D:/DSH/plugin/dsh-todo-board/lib/index.js';
const original = readFileSync(TARGET);

const MUTATIONS = [
  {
    // This is the shape the issue proposed. It reads well and is too broad:
    // it would hand out a host-privileged write channel under a sandbox the
    // user restricted, because our board write never passes through it.
    name: 'the bypass ignores the sandbox and fires on `never` alone (the original proposal)',
    from: '      const spec = presetSpecOf(presets, presets.current(session))',
    to: "      const spec = { sandbox: 'danger-full-access', approval: 'never' }",
  },
  {
    // The tempting simplification: `current()` already returned the name, so why
    // resolve it back to the bundle? Because `presets` is a configurable table
    // and a key is just a label — point it at a restricted sandbox and derive()
    // hands that name back for a restricted session.
    name: 'the sandbox half trusts the preset NAME instead of the bundle value',
    from: "      return spec.sandbox === 'danger-full-access'",
    to: "      return presets.current(session) === 'danger-full-access'",
  },
  {
    // The mirror-image mistake, and the subtler one: the bundle LOOKS like it
    // carries approval, but the live `auto` bundle documents `ask` forever while
    // the real policy is `never`, so this refuses a genuinely unrestricted
    // session.
    name: 'the approval half is re-read from the preset bundle instead of the policy service',
    from: "      return spec.sandbox === 'danger-full-access'",
    to: "      return spec.sandbox === 'danger-full-access' && spec.approval === 'never'",
  },
  {
    name: 'the bypass disappears, so full access + never asks and is auto-denied again',
    from: '    if (writeAlreadyUnrestricted(session)) return next()',
    to: '    if (false) return next()',
  },
  {
    name: 'the bypass drops the policy requirement (full access alone skips the ask)',
    from: "    if (approvalPolicyOf(session) !== 'never') return false",
    to: '    if (false) return false',
  },
  {
    name: 'an unreadable policy is read as `never` instead of as unknown',
    from: '      /* an unreadable policy must not be mistaken for a permissive one */',
    to: "      return 'never'; /* mutant */",
  },
  {
    name: 'the never-denial is replaced by a plain pass-through',
    from: "      return { kind: 'deny', reason: noPromptsReason(action, input) }",
    to: '      return next()',
  },
  {
    name: 'the policy is read from a service name that does not exist',
    from: "      const approval = serviceNamed('approval')",
    to: "      const approval = serviceNamed('userApproval')",
  },
  {
    name: 'the presets are read from a service name that does not exist',
    from: "      const presets = serviceNamed('permissionPresets')",
    to: "      const presets = serviceNamed('permissions')",
  },
  {
    name: 'the specOf fallback is dropped, so a resolve-less build cannot resolve at all',
    from: "    if (typeof presets.specOf !== 'function') return undefined",
    to: '    return undefined',
  },
];

// Refuse to run if any anchor is not present EXACTLY once: a duplicated anchor
// would mutate a different site than the one described.
const text = original.toString('utf8');
let anchorsOk = true;
for (const mutation of MUTATIONS) {
  const count = text.split(mutation.from).length - 1;
  if (count !== 1) {
    console.log('BAD ANCHOR (' + count + ' occurrences): ' + mutation.name);
    anchorsOk = false;
  }
}
if (!anchorsOk) {
  console.log('\nfixed the anchors above; nothing was mutated');
  process.exit(1);
}

let caughtCount = 0;
try {
  for (const mutation of MUTATIONS) {
    writeFileSync(TARGET, text.replace(mutation.from, mutation.to));
    let caught = false;
    try {
      execFileSync(process.execPath, ['tools/check-live.mjs'], {
        cwd: 'D:/DSH/plugin/dsh-todo-board',
        stdio: 'pipe',
      });
    } catch {
      caught = true;
    }
    console.log((caught ? 'caught: ' : 'MISSED: ') + mutation.name);
    if (caught) caughtCount += 1;
  }
} finally {
  writeFileSync(TARGET, original);
  console.log('original restored');
}

console.log(
  caughtCount === MUTATIONS.length
    ? '\nall ' + MUTATIONS.length + ' approval mutations caught; original restored and passing'
    : '\n' + (MUTATIONS.length - caughtCount) + ' mutation(s) NOT caught',
);
process.exit(caughtCount === MUTATIONS.length ? 0 : 1);
