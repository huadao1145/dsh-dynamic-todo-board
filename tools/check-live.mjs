/**
 * Host-half integration check against the REAL cordis runtime.
 *
 * The other suites stub the context, which leaves four things unproven:
 *
 *   1. **`ctx.inject(['systemPrompt' | 'tools'], …)`.** The stub calls the
 *      callback directly, but real cordis waits until the service is *provided*
 *      through the reflection layer — and the plugin row is applied before those
 *      services exist. An eager `ctx.get` there lost the registration SILENTLY
 *      and permanently (the model had no tool at all while the panel kept
 *      working). This provides both services strictly AFTER the plugin row, so
 *      the ordering that used to break is the ordering under test.
 *   2. **`ctx.logger.exporter()`.** The stub's logger re-implements the `levels`
 *      gate from memory; this runs the real `LoggerService`, so the gate that
 *      decides what gets stored is the genuine article.
 *   3. **The approval gate.** `tools/pre-execute` is only a decision in the
 *      context of the real pipeline that consumes it, so the gate is exercised
 *      through a real `ToolRuntime`: read passes, write fails closed with no
 *      approval channel, a grant lets it through, and a rejection denies — the
 *      harness's own verdict wording, not a stub of it.
 *   4. **Channel convergence.** The route prefers the harness's `connection`
 *      gate and falls back to the local restatement only without it, so both
 *      branches are driven here against the really-injected route.
 *
 * Everything else (agents, attachments, …) is a stub, because those are harness
 * capabilities rather than the runtime under test.
 *
 *   node tools/check-live.mjs
 *
 * Requires the DSH install; skipped loudly if cordis or dsh-tools is missing.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const DSH = 'C:/Users/XIAO/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/'
const CORDIS = process.env.DSHTB_CORDIS ?? 'file:///' + DSH + 'cordis/lib/index.js'
const TOOLS = process.env.DSHTB_TOOLS ?? 'file:///' + DSH + 'dsh-tools/lib/index.js'

let Context
let ToolRuntime
let assertSupportedJsonSchema
try {
  ;({ Context } = await import(CORDIS))
  ;({ ToolRuntime, assertSupportedJsonSchema } = await import(TOOLS))
} catch (err) {
  console.error('SKIP: the real cordis / dsh-tools runtime is not reachable at ' + CORDIS)
  console.error('      set DSHTB_CORDIS / DSHTB_TOOLS to their lib/index.js to run this check.')
  process.exit(0)
}

const home = mkdtempSync(join(tmpdir(), 'dshtb-live-'))
process.env.DSH_HOME = home

const mod = await import('../lib/index.js')

const routes = []
const sections = []
const logged = []
const root = new Context()

// Watch what the PLUGIN's exporter admits, by observing alongside it.
root.logger.exporter({
  levels: { default: 3 },
  export: (m) => logged.push({ name: m.name, type: m.type, detail: m.args.map(String).join(' ') }),
})

const webServerStub = {
  register(route) {
    routes.push(route)
    return () => {}
  },
}

/** The two services ToolRuntime itself needs before it can be constructed. */
const promptStub = {
  section(s) {
    sections.push(s)
    return () => {}
  },
  tools() {
    return () => {}
  },
}

/**
 * The approval channel, as `dsh-user-approval` presents it: one `request()` per
 * gated call, answering with a verdict. Swapped per assertion below.
 */
const approvalCalls = []
let approvalVerdict = 'unavailable'

/**
 * The session's approval POLICY, which is a different question from the verdict
 * for one call. Under `never`, `dsh-user-approval` rejects before consulting any
 * answerer, so an `ask` is a guaranteed denial rather than a question. Kept
 * separately controllable because the gate must tell those apart.
 */
let approvalPolicy = 'ask'

const approvalStub = {
  async request(request) {
    approvalCalls.push({ toolName: request.toolName, reason: request.reason })
    return approvalVerdict
  },
  effectivePolicy() {
    if (approvalPolicy === 'THROWS') throw new Error('approval: policy unreadable')
    return approvalPolicy
  },
}

root.plugin({
  name: 'dsh-todo-board',
  apply(ctx) {
    // `agents` is a harness capability, not the runtime under test.
    const services = new Map([['agents', { list: () => [], get: () => undefined }]])
    const realGet = ctx.get.bind(ctx)
    ctx.get = (key) => (services.has(key) ? services.get(key) : realGet(key))
    ctx.reflect.provide('webServer', webServerStub, undefined)
    mod.apply(ctx)
  },
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
await sleep(150)

// -- activation -------------------------------------------------------------

assert.deepEqual(
  routes.map((r) => r.path).sort(),
  ['/dsh-todo-board/api', '/dsh-todo-board/image'],
  'both routes register through real service injection, not just a direct callback',
)
assert.equal(
  sections.length,
  0,
  'nothing model-facing is registered yet: systemPrompt/tools do not exist at apply time',
)
console.log('live    OK — plugin activates against real cordis')

// -- the late service, which is the whole point of the inject rewrite ---------

root.reflect.provide('systemPrompt', promptStub, undefined)
await sleep(80)
assert.equal(
  sections.length,
  1,
  'the prompt section registers when systemPrompt arrives AFTER the plugin row',
)

root.plugin({
  name: 'tools',
  apply(ctx) {
    // Constructing the runtime IS how `tools` is provided (Service base class).
    new ToolRuntime(ctx, {})
  },
})
await sleep(120)

const tools = root.get('tools')
assert.equal(typeof tools?.get, 'function', 'the real ToolRuntime is up')
assert.ok(
  tools.get('todo_board') !== undefined,
  'the model tool registers even though the tools service arrived after the plugin',
)
console.log('live    OK — late-arriving services still register (the ctx.inject race stays fixed)')

// -- the skill and the command -----------------------------------------------
//
// Both are `ctx.inject` + effect, exactly like the tool, so the same load-order
// trap applies: a stub that hands the service over at apply time would prove
// nothing. Here `skills` and `commands` are provided AFTER the plugin row — the
// order that used to break registration silently — and the registrations are
// then read back out.

const skillsRegistered = []
const commandsRegistered = []

root.reflect.provide(
  'skills',
  {
    register(skill) {
      skillsRegistered.push(skill)
      return () => {
        const at = skillsRegistered.indexOf(skill)
        if (at >= 0) skillsRegistered.splice(at, 1)
      }
    },
  },
  undefined,
)
root.reflect.provide(
  'commands',
  {
    register(command) {
      commandsRegistered.push(command)
      return () => {
        const at = commandsRegistered.indexOf(command)
        if (at >= 0) commandsRegistered.splice(at, 1)
      }
    },
  },
  undefined,
)
await sleep(80)

assert.equal(skillsRegistered.length, 1, 'the planning skill registers once the service appears')
assert.equal(skillsRegistered[0].name, 'todo-board-planning', 'under its documented name')
assert.ok(
  typeof skillsRegistered[0].content === 'string' && skillsRegistered[0].content.length > 200,
  'with a real body, so the manual is not an empty promise',
)
assert.equal(
  skillsRegistered[0].source,
  'dsh-todo-board',
  'and a source, which validateDefinition() requires of any loaded skill',
)

assert.equal(commandsRegistered.length, 1, 'the /todo command registers the same way')
assert.equal(commandsRegistered[0].name, 'todo', 'under the short name')
assert.equal(commandsRegistered[0].input.attachments, true, 'accepting the composer attachments')

// The handler must inject a ContentBlock[] user message: a bare string is the
// exact shape that made a dispatched session unopenable once already.
const injected = []
const commandResult = commandsRegistered[0].handler({
  agent: { followup: (message) => injected.push(message) },
  rawInput: '把日志模块拆开',
  attachments: [],
})
assert.equal(commandResult.kind, 'success', 'and its handler succeeds without a GUI')
assert.equal(injected.length, 1, 'injecting exactly one message')
assert.equal(injected[0].role, 'user', 'which is a user message')
assert.ok(
  Array.isArray(injected[0].content) && injected[0].content[0].type === 'text',
  'whose content is ContentBlock[], not a string',
)
console.log('live-plan OK — skill and command register against real cordis, after the plugin row')

// -- the tool's parameter schema, against the REAL validator -----------------
//
// The stub registry in smoke.mjs records a definition without validating it, so a
// schema the harness would reject looks fine there — while in production the tool
// simply never exists. `items` added a nested object/array tree, which is exactly
// the kind of thing the supported subset can refuse (`format`, `pattern`, a type
// array, `oneOf` beside `properties`…). So the real validator gets the real
// constant.

const hostSource = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')

/** Evaluate one `const NAME = {…}` object literal out of the plugin source. */
function schemaConstant(name) {
  const marker = 'const ' + name + ' = {'
  const start = hostSource.indexOf(marker)
  assert.ok(start >= 0, 'found ' + name + ' in lib/index.js')
  let depth = 0
  for (let i = hostSource.indexOf('{', start); i < hostSource.length; i++) {
    if (hostSource[i] === '{') depth += 1
    else if (hostSource[i] === '}') {
      depth -= 1
      if (depth === 0) {
        const text = hostSource.slice(hostSource.indexOf('{', start), i + 1)
        // The literals reference these four module constants and nothing else.
        return new Function(
          'MODES', 'MAX_IMAGES_PER_TODO', 'MAX_PLAN_ITEMS', 'TOOL_STATES',
          'return ' + text,
        )(
          ['remind', 'resume', 'newSession'],
          4,
          20,
          ['pending', 'dispatched', 'running', 'done', 'lost'],
        )
      }
    }
  }
  throw new Error('unbalanced braces in ' + name)
}

const parameters = schemaConstant('TOOL_PARAMETERS')
assertSupportedJsonSchema(parameters)
assertSupportedJsonSchema(schemaConstant('TOOL_OUTPUT_SCHEMA'))
assert.ok(
  parameters.properties.items !== undefined && parameters.properties.items.items.type === 'object',
  'the batch parameter is declared as a nested object array',
)

// Negative control: without this, the two lines above would also pass if the
// validator accepted anything at all.
assert.throws(
  () => assertSupportedJsonSchema({ type: 'object', properties: { a: { type: 'string', format: 'uri' } } }),
  'the validator really does reject an unsupported keyword',
)
console.log('live-schema OK — the tool parameters pass the harness validator (nested items included)')

// -- the log sink, gated by the REAL exporter levels ------------------------

const logPath = join(home, 'todo-board', 'log.ndjson')
root.logger('dsh-todo-board').warn('live probe %s', 'value')
root.logger('dsh-todo-board').debug('our debug line')
root.logger('some-other-plugin').debug('sibling debug')
root.logger('some-other-plugin').error('sibling error')
await sleep(80)

assert.ok(existsSync(logPath), 'mounting creates the log file')
const fileText = readFileSync(logPath, 'utf8')

assert.ok(fileText.includes('live probe value'), 'our own warn reaches the file')
assert.ok(
  fileText.includes('our debug line'),
  "our own debug reaches the file — the levels map keys on OUR logger name, which is the whole reason this works",
)
assert.ok(
  !fileText.includes('sibling debug'),
  "another plugin's debug is gated out (the default:error scope)",
)
assert.ok(
  fileText.includes('sibling error'),
  "another plugin's error still arrives — default:0 is a scope choice, not a safety boundary",
)
assert.ok(
  fileText.includes('live probe value') && !fileText.includes('%s'),
  'placeholders are resolved by our own formatter (Message.args arrives raw)',
)
assert.ok(
  fileText
    .trim()
    .split('\n')
    .every((line) => {
      try {
        JSON.parse(line)
        return true
      } catch (err) {
        return false
      }
    }),
  'every stored line is independently parseable NDJSON',
)
console.log('live-log OK — real logger gate honours our levels map, siblings scoped out')

// -- the approval gate, through the REAL tool pipeline ----------------------

const cancel = () => new AbortController().signal
const caller = {
  id: 'session-live',
  session: { header: { id: 'session-live', cwd: 'D:\\live\\project' } },
  followup() {},
  steer() {},
}

async function callTool(args) {
  return await root.get('tools').execute({
    name: 'todo_board',
    callId: 'call-' + Math.random().toString(36).slice(2),
    arguments: args,
    signal: cancel(),
    agent: caller,
  })
}

const read = await callTool({ action: 'list' })
assert.equal(read.isError, false, 'a read is not gated: ' + JSON.stringify(read).slice(0, 200))

const denied = await callTool({ action: 'add', title: '审批门的探针' })
assert.equal(
  denied.isError,
  true,
  'with no approval service the write FAILS CLOSED instead of landing',
)
assert.ok(
  String(denied.error?.message ?? '').includes('AI 要修改待办板'),
  'and the model sees OUR reason, naming what it tried to change: ' + denied.error?.message,
)
assert.ok(
  String(denied.error?.message ?? '').includes('新增待办'),
  'the reason carries the detail the approval dialog shows',
)

// A channel that grants: the write now goes through, so the gate is a gate and
// not a wall. This is the half a fail-closed-only test cannot tell apart.
root.reflect.provide('approval', approvalStub, undefined)
approvalVerdict = 'allowed-once'
const granted = await callTool({ action: 'add', title: '审批门的探针' })
assert.equal(
  granted.isError,
  false,
  'a grant lets the write through: ' + JSON.stringify(granted).slice(0, 200),
)
assert.equal(approvalCalls.length, 1, 'the channel was asked exactly once for it')
assert.equal(approvalCalls[0].toolName, 'todo_board', 'and the request names our tool')

// The model's own checkbox stays free: `done` is part of the auto-continue loop
// the user asked to keep automatic, and `ask` there would break it under a
// `danger-full-access` (policy `never`) deployment.
const listed = await callTool({ action: 'list' })
const firstId = listed.value.todos[0]?.id
assert.ok(typeof firstId === 'string' && firstId !== '', 'the granted row is on the board')
const done = await callTool({ action: 'done', id: firstId })
assert.equal(done.isError, false, 'action=done is NOT gated — the continue loop needs it')
assert.equal(approvalCalls.length, 1, 'and it did not ask')

// A rejection is the harness's own verdict wording, which is how the model can
// tell "the human said no" from "there is no approval channel at all".
//
// The write used here must be one that still ASKS. `note` was the obvious pick
// until 0.13.4 moved it into the approval-free set (a note is prose on a row
// the user already owns); `schedule` stayed gated precisely because it makes
// the row run later with nobody watching, so it is the honest probe.
approvalVerdict = 'rejected'
const rejected = await callTool({ action: 'schedule', id: firstId, schedule: '2099-01-01T00:00' })
assert.equal(rejected.isError, true, 'a rejection denies the write')
assert.ok(
  String(rejected.error?.message ?? '').includes('rejected'),
  'with the user-rejection wording, not ours: ' + rejected.error?.message,
)
console.log('live-gate OK — reads and the cheap marks pass, writes ask, deny/grant both honoured')

// -- `never`: precise, not blanket ------------------------------------------
//
// `never` is NOT a synonym for "full access". `sandbox` and `approval` are two
// of the three independent permission knobs, so `never` can sit beside a
// `read-only` or `workspace-write` sandbox (the derived preset then reads back
// as `custom`). That distinction is load-bearing here because this plugin
// writes `board.json` with HOST privileges — the write never passes through the
// sandbox — so under a restricted sandbox the gate is the only thing between
// the model and the file. Both halves are pinned below.
//
// `approvalVerdict` is still `rejected` here, which is what makes the first
// assertion strong: if the gate wrongly asked, the call would be DENIED.

let presetName = 'danger-full-access'
// Mirrors `permissionPresets`'s own table shape: a name resolves to a bundle of
// the two knob values. `presetSpec` lets a case redefine what a KEY means, which
// is a thing the real Config schema permits and the reason the gate compares
// knob values instead of the preset's name.
const PRESET_SPECS = {
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
  // `auto`'s bundle documents approval `ask` even after the policy moves to
  // `never` — see the "auto + never" case below.
  auto: { sandbox: 'danger-full-access', approval: 'ask' },
}
let presetSpec = null
const permissionPresetsStub = {
  current() {
    if (presetName === 'THROWS') {
      throw new Error('permission: permissions session projection is not registered')
    }
    return presetName
  },
  resolve(name) {
    const spec = presetSpec === null ? PRESET_SPECS[name] : presetSpec
    if (spec === undefined) throw new Error('permission: unknown preset "' + name + '"')
    return spec
  },
  specOf(name) {
    return presetSpec === null ? PRESET_SPECS[name] : presetSpec
  },
}
root.reflect.provide('permissionPresets', permissionPresetsStub, undefined)

approvalPolicy = 'never'
presetName = 'danger-full-access'
const beforeUnrestricted = approvalCalls.length
const unrestricted = await callTool({ action: 'add', title: '无人值守探针' })
assert.equal(
  unrestricted.isError,
  false,
  'full file access with prompts disabled lets the write through: ' +
    JSON.stringify(unrestricted).slice(0, 200),
)
assert.equal(
  approvalCalls.length,
  beforeUnrestricted,
  'and it opens no dialog, because that dialog could only ever be auto-rejected',
)

presetName = 'workspace-write'
const beforeRestricted = approvalCalls.length
const restricted = await callTool({ action: 'add', title: '不该落盘的探针' })
assert.equal(
  restricted.isError,
  true,
  'prompts disabled over a RESTRICTED sandbox still refuses the write',
)
assert.ok(
  String(restricted.error?.message ?? '').includes('审批策略是 `never`'),
  'and the reason names the policy: ' + restricted.error?.message,
)
assert.ok(
  !String(restricted.error?.message ?? '').includes('the user rejected'),
  'specifically NOT the wording for a dialog the user never saw',
)
assert.equal(approvalCalls.length, beforeRestricted, 'and no dead dialog was opened')

const afterRestricted = await callTool({ action: 'list' })
assert.ok(
  !afterRestricted.value.todos.some((todo) => todo.title === '不该落盘的探针'),
  'and nothing reached the board',
)

// A projection that is not registered is a real, observed failure mode (it is
// in the shipped logs). It must read as "cannot prove full access", not as one.
presetName = 'THROWS'
const unregisteredProjection = await callTool({ action: 'add', title: '投影未注册探针' })
assert.equal(
  unregisteredProjection.isError,
  true,
  'a throwing preset projection refuses rather than assuming full access',
)

// The mirror image: an unreadable POLICY must not read as `never` either.
approvalPolicy = 'THROWS'
presetName = 'danger-full-access'
approvalVerdict = 'allowed-once'
const beforeUnreadable = approvalCalls.length
const unreadablePolicy = await callTool({ action: 'add', title: '策略读不到探针' })
assert.equal(
  unreadablePolicy.isError,
  false,
  'an unreadable policy falls back to asking instead of deciding on its own',
)
assert.equal(
  approvalCalls.length,
  beforeUnreadable + 1,
  'and the channel really was asked — that is what fail-closed means here',
)

// Full access ALONE must not skip the ask: only full access AND `never` does.
// Without this, a redeployed preset table could silently widen the bypass.
approvalPolicy = 'ask'
presetName = 'danger-full-access'
const beforeAskFull = approvalCalls.length
const askWithFullAccess = await callTool({ action: 'add', title: 'ask 与完全访问探针' })
assert.equal(askWithFullAccess.isError, false, 'policy ask still works normally')
assert.equal(
  approvalCalls.length,
  beforeAskFull + 1,
  'and full access alone does NOT skip the ask',
)

// The `auto` branch. `derive()` deliberately keeps returning the live `auto`
// preset once the policy moves to `never` ("a still-selected Auto also matches
// the `never` approval policy"), while `auto`'s bundle goes on documenting
// approval `ask`. So the approval half MUST come from the policy service, not
// from the bundle — a gate that read it off the bundle would keep refusing a
// session that really is full-access + never. The sandbox half is still fine to
// read there: `derive()` only returns `auto` when the sandbox matches.
approvalPolicy = 'never'
presetName = 'auto'
const beforeAutoWithNever = approvalCalls.length
const autoWithNever = await callTool({ action: 'add', title: 'auto 与 never 探针' })
assert.equal(
  autoWithNever.isError,
  false,
  'auto over full access with the policy at never proceeds: ' + JSON.stringify(autoWithNever).slice(0, 200),
)
assert.equal(approvalCalls.length, beforeAutoWithNever, 'and without opening a dialog')

// The preset NAME is not the thing being trusted. `permissionPresets`'s Config
// schema declares `presets` as a table, so a deployment may point the key
// `danger-full-access` at any bundle it likes; the gate must read the knob
// values. Here the key keeps its reassuring name while granting only a
// `workspace-write` sandbox, which must NOT unlock the bypass.
approvalPolicy = 'never'
presetName = 'danger-full-access'
presetSpec = { sandbox: 'workspace-write', approval: 'never' }
const beforeRedefined = approvalCalls.length
const redefinedPreset = await callTool({ action: 'add', title: '被重定义的预设探针' })
assert.equal(
  redefinedPreset.isError,
  true,
  'a "danger-full-access" key that carries a restricted sandbox does NOT unlock the write',
)
assert.ok(
  String(redefinedPreset.error?.message ?? '').includes('审批策略是 `never`'),
  'and it is refused for the policy reason, like any other restricted sandbox',
)
assert.equal(approvalCalls.length, beforeRedefined, 'with no dialog opened')
presetSpec = null

// `resolve` and `specOf` are the same lookup with different error behaviour, so
// a build offering only the non-throwing one must still resolve. Without this
// the fallback is untested code that only a future DSH would ever reach.
const resolveBackup = permissionPresetsStub.resolve
delete permissionPresetsStub.resolve
approvalPolicy = 'never'
presetName = 'danger-full-access'
const viaSpecOf = await callTool({ action: 'add', title: 'specOf 回退探针' })
assert.equal(
  viaSpecOf.isError,
  false,
  'a build with only specOf still reads the knob values: ' + JSON.stringify(viaSpecOf).slice(0, 200),
)
permissionPresetsStub.resolve = resolveBackup

console.log(
  'live-never OK — full access + never proceeds, a restricted sandbox still refuses, unreadable knobs keep asking',
)

// -- the fence on a really-injected route ------------------------------------

const api = routes.find((r) => r.path === '/dsh-todo-board/api')
async function call(request) {
  const box = { status: 0, body: '' }
  await api.handler(request, {
    writeHead(status) {
      box.status = status
    },
    end(body) {
      box.body = body === undefined ? '' : String(body)
    },
  })
  return box
}

assert.equal((await call({ method: 'GET', headers: {} })).status, 403, 'no Host is refused')
assert.equal(
  (await call({ method: 'GET', headers: { host: '127.0.0.1:3080' } })).status,
  200,
  'a loopback Host is served',
)
assert.equal(
  (await call({ method: 'GET', headers: { host: 'evil.example' } })).status,
  403,
  'a rebound Host is refused',
)
console.log('live-fence OK — the local fence is live on the really-injected route')

// -- channel convergence: the harness gate wins once it exists ---------------

const sees = []
let gateStatus = 401
const connectionStub = {
  requestRejection(request) {
    sees.push(request.headers.host)
    return gateStatus
  },
}

// The local fence would serve this request; the harness gate refuses it. Which
// answer comes back is the difference between "the panel is authorized by a
// browser session" and "any local process may write the board".
root.reflect.provide('connection', connectionStub, undefined)
await sleep(60)

assert.equal(
  (await call({ method: 'GET', headers: { host: '127.0.0.1:3080' } })).status,
  401,
  'a request the local fence would allow is refused by the harness gate',
)
assert.equal(sees.length, 1, 'and the harness gate is the one that was asked')

gateStatus = undefined
assert.equal(
  (await call({ method: 'GET', headers: { host: '127.0.0.1:3080' } })).status,
  200,
  'the harness gate still decides when it allows (this is how the panel keeps working)',
)

// A gate that throws must refuse, not take the route down.
connectionStub.requestRejection = () => {
  throw new Error('gate exploded')
}
assert.equal(
  (await call({ method: 'GET', headers: { host: '127.0.0.1:3080' } })).status,
  403,
  'a throwing gate fails closed',
)
console.log('live-conn OK — the route borrows the harness connection gate, not a restatement')

rmSync(home, { recursive: true, force: true })
console.log('\nall live-runtime checks passed')
