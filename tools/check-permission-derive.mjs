/**
 * Does the 0.13.5 approval rule hold against the REAL `dsh-permission-presets`?
 *
 * The rule lets a board write through WITHOUT approval when the session's
 * effective sandbox is `danger-full-access` and the approval policy is `never`.
 * The sandbox half is read from the resolved preset bundle:
 *
 *     specOf(current(session)).sandbox === 'danger-full-access'
 *
 * That is only sound if a derived preset's bundle really describes the session's
 * sandbox, for every table a deployment can configure. So this drives the
 * SHIPPED `derive()` over the whole knob grid and asserts the security property
 * itself:
 *
 *     the condition holds  ==>  the session really is
 *                              (sandbox danger-full-access, approval never)
 *
 * It also pins the API the gate reads (`current`, `resolve`, `specOf`), because
 * those silently disappearing would drop the plugin back to "always ask" — safe,
 * but it would look like a bug.
 *
 * `derive()` touches only `this.presets`, `this.specOf`, `this.autoAdmit` and
 * `this.ctx.{shell.sandboxMode, approval.config.policy}`, so the real prototype
 * runs against a fabricated receiver. That beats reading the source: this is the
 * shipped implementation.
 *
 *   node tools/check-permission-derive.mjs
 *
 * Requires the DSH install; skipped loudly if it is missing.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'

const DSH =
  process.env.DSHTB_DSH ??
  'C:/Users/XIAO/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/'
const PP = 'file:///' + DSH + 'dsh-permission-presets/lib/index.js'
const UA = 'file:///' + DSH + 'dsh-user-approval/lib/index.js'

if (!existsSync(DSH + 'dsh-permission-presets/lib/index.js')) {
  console.error('SKIP: the real dsh-permission-presets runtime is not reachable at ' + PP)
  console.error('      set DSHTB_DSH to its @deepseek-ai directory to run this check.')
  process.exit(0)
}

const pp = await import(PP)
const ua = await import(UA)
const proto = pp.PermissionPresetService.prototype
const approvalProto = ua.ApprovalService.prototype

// -- the API the gate reads --------------------------------------------------

for (const method of ['current', 'resolve', 'specOf', 'derive', 'permissionState']) {
  assert.equal(
    typeof proto[method],
    'function',
    'PermissionPresetService.' + method + ' is what the approval gate reads; it moved',
  )
}
assert.equal(
  typeof approvalProto.effectivePolicy,
  'function',
  'ApprovalService.effectivePolicy is what the approval gate reads; it moved',
)
assert.equal(pp.AUTO_PRESET, 'auto', 'the live-Auto name the derive() branch compares against')
assert.equal(pp.CUSTOM_PRESET, 'custom', 'the derived not-a-preset name')

console.log('derive  OK — the service API the approval gate reads is all present')

// -- the security property, over the whole grid ------------------------------

const DEFAULT_TABLE = {
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask', name: 'workspace-write' },
  'danger-full-access': {
    sandbox: 'danger-full-access',
    approval: 'never',
    name: 'danger-full-access',
  },
}
// `presets` is a Config field, so this is a deployment that is allowed to exist.
// The key keeps a reassuring name while granting a restricted sandbox.
const REDEFINED_TABLE = {
  'danger-full-access': {
    sandbox: 'workspace-write',
    approval: 'never',
    name: 'danger-full-access',
    description: 'redefined by a deployment',
  },
}
const TABLES = [
  ['default', DEFAULT_TABLE, undefined],
  ['default, auto live', DEFAULT_TABLE, { sandbox: 'danger-full-access', approval: 'ask' }],
  ['redefined', REDEFINED_TABLE, undefined],
]
const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access']
const APPROVALS = ['ask', 'never']
const LAST_SELECTED = [null, 'workspace-write', 'danger-full-access', 'auto', 'custom']

function receiver(table, autoAdmit) {
  const self = {
    presets: table,
    autoAdmit,
    ctx: { shell: { sandboxMode: 'read-only' }, approval: { config: { policy: 'ask' } } },
  }
  self.specOf = (name) => proto.specOf.call(self, name)
  return self
}

let allowed = 0
let refused = 0
const lyingNames = []

for (const [label, table, autoAdmit] of TABLES) {
  for (const sandbox of SANDBOXES) {
    for (const approval of APPROVALS) {
      for (const lastSelected of LAST_SELECTED) {
        const self = receiver(table, autoAdmit)
        const name = proto.derive.call(self, { preset: lastSelected, sandbox, approval })
        const spec = proto.specOf.call(self, name)

        // The plugin's condition, verbatim.
        const policyIsNever = approval === 'never'
        const sandboxIsFullAccess = spec !== undefined && spec !== null && spec.sandbox === 'danger-full-access'
        const gateWouldAllow = policyIsNever && sandboxIsFullAccess

        const where = `[${label}] knobs=(${sandbox}, ${approval}) lastSelected=${lastSelected} -> "${name}"`

        if (name === 'danger-full-access' && sandbox !== 'danger-full-access') {
          lyingNames.push(where)
        }

        if (gateWouldAllow) {
          allowed += 1
          assert.equal(sandbox, 'danger-full-access', 'the rule must never allow a restricted sandbox: ' + where)
          assert.equal(approval, 'never', 'the rule must never allow while prompts are possible: ' + where)
        } else {
          refused += 1
        }
      }
    }
  }
}

assert.ok(allowed > 0, 'the rule never fired in any probed state — the check would be vacuous')
assert.ok(refused > 0, 'every probed state allowed — the check would be vacuous')

console.log(
  `derive  OK — the rule held in all ${allowed + refused} probed states ` +
    `(${allowed} allowed, ${refused} refused) against the shipped derive()`,
)

// The probe's other finding, and the reason the gate compares knob VALUES rather
// than the preset's name. If a future DSH stops returning a misleading name here,
// this is informational rather than a failure — the security property above is
// what must hold, and it holds either way.
console.log(
  lyingNames.length === 0
    ? 'derive  note — a redefined table did NOT produce a misleading name in this build'
    : `derive  note — a redefined table DOES make the name lie (${lyingNames.length} state(s)), ` +
      'which is why the gate compares the resolved bundle, not the name:\n        ' +
      lyingNames[0],
)
