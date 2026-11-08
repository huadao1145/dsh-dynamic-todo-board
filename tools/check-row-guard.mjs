/**
 * Mutation check for the row-facts, row-schedule, skin and paste tests.
 *
 * Confirms `client-smoke.mjs` really fails when each behaviour is reverted:
 *
 *   1. the directory chip comes back (a fact stated twice)
 *   2. the schedule is repeated in the facts line (same, other direction)
 *   3. an unscheduled row loses its way to add a time
 *   4. editing sends nothing (the picker is decorative)
 *   5. pending rows fall silent again (a state you must infer)
 *   6. done rows fall silent again (same, other state)
 *   7. the skin control stops remembering the choice
 *   8. the skin control stops reaching the DOM attribute the sheets hook onto
 *   9. a skin erases the section label instead of restyling it
 *  10. a skin's rules escape the panel and restyle the whole GUI
 *  11. one of the two optional skins is never injected
 *  12. a text paste is swallowed (the composer's main input breaks)
 *  13. an image paste is not intercepted (the image never attaches)
 *  14. a typeless clipboard image keeps its empty media type
 *  15. the per-todo image limit is not enforced on paste
 *  16. a non-image file paste is consumed by mistake
 *  17. the client build marker drifts from package.json (the footer lies)
 *  18. the removed standing hint comes back into the composer
 *  19. the attachment counter disappears once an image is attached
 *  20. the board view starts pulling log content (logs leak to every user)
 *  21. the log view stops fetching when it opens (the button looks dead)
 *  22. the log dot never clears (it stops meaning "something is wrong")
 *  23. every log level can be switched off (empty reads as "nothing logged")
 *  24. the log poll reads `logOpen` from a stale closure (the open view freezes)
 *  25. a refused poll reports a bare status code (nothing to act on)
 *  26. a note is not rendered (the context the model gets stays invisible)
 *  27. saving a note sends no patch (the edit is a no-op)
 *  28. a verified row stays in the open list (it never moves to 已完成)
 *  29. the status line is hidden again (build marker and open count disappear)
 *  30. the mode hint is not rendered (the mode chip goes unexplained)
 *  31. the mode hint is reworded (the text drifts from what was asked for)
 *  32. the current session is read from a store key that does not exist (both
 *      scope tabs go empty while the row labels stay right)
 *  33. any listed session counts as current (the retained flag is ignored)
 *  34. the scope tabs stop narrowing by session
 *  35. the scope tab groups by planner instead of owner
 *  36. a container's children drop off the tab that owns the container
 *  37. the scope tabs stop narrowing by directory
 *  38. an orphaned child is dropped from the list again (counted nowhere,
 *      rendered nowhere — promoted to a root is the fix)
 *  39. a style tag loses its data-plugin ownership mark (another plugin's HMR
 *      deletes our styles — the claimStyles adoption chain, problem 3)
 *
 * Patterns are matched against a normalized (LF) copy because the working tree
 * is checked out with CRLF on Windows, then the replacement is mapped back onto
 * the original text so line endings survive untouched.
 *
 * As with the clamp guard, the child's stdio is not piped — under a restricted
 * sandbox a piped spawn fails with EPERM, which would masquerade as a caught
 * mutation. `client/client.js` is restored on every exit path and verified
 * byte-for-byte, because the dev install is a junction onto this file.
 *
 *   node tools/check-row-guard.mjs
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

/**
 * The live build marker, read from the source instead of written out here.
 *
 * Hard-coding it made mutant 17 report "pattern not found" on every release
 * bump, which reads as a broken guard rather than a moved target — and a guard
 * that skips quietly is worse than no guard.
 */
const buildMarker = /const BUILD = '([^']+)'/.exec(original.replace(/\r\n/g, '\n'))
if (buildMarker === null) {
  console.error('cannot find the client build marker in client/client.js')
  process.exit(2)
}

function restore() {
  try {
    if (fs.readFileSync(p, 'utf8') !== original) fs.writeFileSync(p, original, 'utf8')
  } catch (err) {
    console.error('RESTORE FAILED: ' + err.message)
  }
}

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
    name: 'directory chip reinstated (fact stated twice)',
    from: "    const meta = [\n      h(\n        'button',\n        {\n          className: 'dshtb-chip',\n          key: 'm',",
    to: "    const meta = [\n      h('span', { className: 'dshtb-chip', key: 'd' }, todo.dirLabel),\n      h(\n        'button',\n        {\n          className: 'dshtb-chip',\n          key: 'm',",
  },
  {
    name: 'schedule repeated in the facts line',
    from: "    facts.push('目录 ' + (todo.dirPath || todo.dir || '(未指定)'))",
    to: "    facts.push('目录 ' + (todo.dirPath || todo.dir || '(未指定)'))\n    facts.push(todo.schedule ? '定时 ' + todo.schedule : '不定时')",
  },
  {
    name: 'unscheduled row cannot add a time',
    from: "    } else {\n      meta.push(\n        h(\n          'button',\n          {\n            className: 'dshtb-chip quiet',",
    to: "    } else if (false) {\n      meta.push(\n        h(\n          'button',\n          {\n            className: 'dshtb-chip quiet',",
  },
  {
    name: 'editing sends nothing (picker is decorative)',
    from: "  function commitWhen(id) {\n    const value = whenDraft\n    setWhenId('')\n    setWhenDraft('')\n    patch(id, { schedule: value })\n  }",
    to: "  function commitWhen(id) {\n    setWhenId('')\n    setWhenDraft('')\n    void id\n  }",
  },
  {
    name: 'pending rows go silent again (state must be inferred)',
    from: "      meta.push(h('span', { className: 'dshtb-chip ' + chip.cls, key: 's', title }, chip.label))",
    to: "      if (state !== 'pending') meta.push(h('span', { className: 'dshtb-chip ' + chip.cls, key: 's', title }, chip.label))",
  },
  {
    name: 'done rows go silent again (state must be inferred)',
    from: "      meta.push(h('span', { className: 'dshtb-chip ' + chip.cls, key: 's', title }, chip.label))",
    to: "      if (state !== 'done') meta.push(h('span', { className: 'dshtb-chip ' + chip.cls, key: 's', title }, chip.label))",
  },
  {
    name: 'the skin choice is not remembered',
    from: "      const next = SKINS[(at + 1) % SKINS.length].id\n      saveSkin(next)\n      return next",
    to: "      const next = SKINS[(at + 1) % SKINS.length].id\n      return next",
  },
  {
    name: 'the skin never reaches the stylesheets’ hook attribute',
    from: "    { className: 'dshtb-root', 'data-dshtb-skin': skin, style: rootStyle },",
    to: "    { className: 'dshtb-root', style: rootStyle },",
  },
  {
    name: 'a skin erases the section label instead of restyling it',
    from: '  letter-spacing:0;padding:11px 15px 5px;gap:6px;font:600 12px/1 inherit}',
    to: '  font-size:0;letter-spacing:0;padding:11px 15px 5px;gap:6px}',
  },
  {
    name: 'a skin rule escapes the panel onto the rest of the GUI',
    from: '.dshtb-root[data-dshtb-skin="dense"] .dshtb-ic{width:19px;height:19px;font-size:10px}',
    to: '.dshtb-ic{width:19px;height:19px;font-size:10px}',
  },
  {
    name: 'one of the optional skins is never injected',
    from: "  for (const id of Object.keys(SKIN_CSS)) {",
    to: "  for (const id of Object.keys(SKIN_CSS).slice(0, 1)) {",
  },
  {
    name: 'a text paste is swallowed (the composer’s main input is broken)',
    from: "    const files = clipboardImages(event.clipboardData)\n    if (files.length === 0) return",
    to: "    const files = clipboardImages(event.clipboardData)\n    if (files.length === 0) { event.preventDefault(); return }",
  },
  {
    name: 'an image paste is not intercepted (the image never attaches)',
    from: "    event.preventDefault()\n    if (pending.length >= MAX_IMAGES) {",
    to: "    if (pending.length >= MAX_IMAGES) {",
  },
  {
    name: 'a typeless clipboard image keeps its empty media type',
    from: "    if (typeof file.type === 'string' && file.type !== '') return file.type",
    to: "    if (typeof file.type === 'string') return file.type",
  },
  {
    name: 'the per-todo image limit is not enforced on paste',
    from: "    if (pending.length >= MAX_IMAGES) {\n      setErr('一条待办最多带 ' + MAX_IMAGES + ' 张图片，先移除一张再粘贴')\n      return\n    }",
    to: "    if (false) {\n      setErr('一条待办最多带 ' + MAX_IMAGES + ' 张图片，先移除一张再粘贴')\n      return\n    }",
  },
  {
    name: 'a non-image file paste is consumed by mistake',
    from: "    return typeof file.type === 'string' && file.type === '' && imageMediaType(file) !== ''",
    to: "    return true",
  },
  {
    name: 'the build marker drifts from the package version',
    from: `const BUILD = '${buildMarker[1]}'`,
    to: "const BUILD = '0.0.0-stale'",
  },
  {
    name: 'the removed standing hint comes back into the composer',
    from: "              pending.length === 0\n                ? null\n                : h(\n                    'div',\n                    { className: 'dshtb-attach' },",
    to: "              pending.length === 0\n                ? h('div', { className: 'dshtb-hint' }, '截图后在这里 Ctrl+V 直接粘贴成附图（最多 4 张，PNG/JPG/WebP/GIF）')\n                : h(\n                    'div',\n                    { className: 'dshtb-attach' },",
  },
  {
    name: 'the attachment counter disappears once an image is attached',
    from: "                  '已附 ' + pending.length + ' / ' + MAX_IMAGES + ' 张 · 点缩略图移除',",
    to: "                  '',",
  },
  {
    name: 'the board view starts pulling log content (logs leak to every user)',
    from: "    if (logOpen) refreshLogs()",
    to: "    refreshLogs()",
  },
  {
    name: 'the log view stops fetching when it opens (the button looks dead)',
    from: '    logOpenRef.current = logOpen\n    if (logOpen) refreshLogs()',
    to: '    logOpenRef.current = logOpen\n    if (false) refreshLogs()',
  },
  {
    name: 'the log dot never clears (it stops meaning \"something is wrong\")',
    from: "  const logAlert = !logOpen && alertSn > logSeenRef.current && alertSn > 0",
    to: "  const logAlert = alertSn > 0",
  },
  {
    name: 'every log level can be switched off (empty reads as \"nothing logged\")',
    from: "      if (!LOG_LEVELS.some((id) => next[id] === true)) return current",
    to: "      if (false) return current",
  },
  {
    // v0.13.4 rewrote the poll effect (it suspends while the page is hidden).
    // The stale-`logOpen` bug this mutant used to guard is now UNREACHABLE:
    // `refresh` is invoked through `refreshRef`, which is re-assigned on every
    // render, so the callback the interval runs always sees current state.
    // Keeping the old mutation would have produced a permanent "NOT CAUGHT"
    // entry — an assertion that can no longer fail reads like coverage while
    // providing none.
    //
    // The risk that REPLACED it is the interval not being armed at all once
    // the visibility logic exists: a page that starts visible must start
    // polling, and the new tests drive exactly that.
    name: 'polling is never armed on mount (the panel only fetches once)',
    from: '    if (visible()) start()',
    to: '    if (false) start()',
  },
  {
    // v0.9.1: the board route borrows the harness gate, so a missing browser
    // session is a refusal a user can actually hit. Reporting it as a bare
    // status code leaves the panel looking broken with nothing to act on.
    name: 'a refused poll reports a bare status code (nothing to act on)',
    from:
      "  if (status === 401) {\n" +
      "    return 'HTTP 401 —— 浏览器没有 DSH 会话凭据。请用 `dsh web` 打印的那条带 token 的地址重开页面'\n" +
      '  }\n' +
      "  return 'HTTP ' + status",
    to: "  return 'HTTP ' + status",
  },
  {
    // The note is the context a dispatched session is handed, so not rendering it
    // means the user approves work without seeing what the model was told.
    name: 'a note is not rendered (the context the model gets stays invisible)',
    from: "    const noteText = typeof todo.note === 'string' ? todo.note : ''",
    to: "    const noteText = ''",
  },
  {
    name: 'saving a note sends no patch (the edit is a no-op)',
    from: '    patch(id, { note: text })',
    to: '    void text',
  },
  {
    name: 'a verified row stays in the open list (it never moves to 已完成)',
    from: '  const visible = scope\n    .filter((t) => !t.verified)',
    to: '  const visible = scope\n    .filter(() => true)',
  },
  {
    // v0.10.1: the status line stopped being a foldable section precisely because
    // a folded-away build marker and open count are a lie by omission.
    name: 'the status line is hidden again (build marker and open count disappear)',
    from:
      '      logOpen || settingsOpen\n' +
      '        ? null\n' +
      '        : h(\n' +
      "            'div',\n" +
      "            { className: 'dshtb-foot', key: 'foot' },",
    to:
      '      true\n' +
      '        ? null\n' +
      '        : h(\n' +
      "            'div',\n" +
      "            { className: 'dshtb-foot', key: 'foot' },",
  },
  {
    // v0.11.1: the hint is the only place the panel says what the mode chip does,
    // so dropping it silently removes the explanation rather than the feature.
    name: 'the mode hint is not rendered (the mode chip goes unexplained)',
    from:
      "                    h(\n" +
      "                      'div',\n" +
      "                      { className: 'dshtb-listhint' },\n" +
      "                      '你可以通过点击更改任务执行模式，但不建议任务开始执行后更改',\n" +
      '                    ),',
    to: '                    null,',
  },
  {
    name: 'the mode hint is reworded (the text drifts from what was asked for)',
    from: "'你可以通过点击更改任务执行模式，但不建议任务开始执行后更改',",
    to: "'点模式标签可以改执行模式。',",
  },
  {
    // v0.11.4. The scope tabs read the current session off `s.current`, a key the
    // session-list store has never had, so `cwd` and `currentId` both collapsed to
    // `''`/`undefined`: 「当前目录」 compared every row against `''` and 「当前会话」
    // against `undefined`, listing nothing — while the row labels (host payload)
    // stayed correct, which is what made it look like a filter bug rather than a
    // dead read. This is the exact regression.
    name: 'the current session comes from a store key that does not exist (scope tabs go empty)',
    from:
      '    const byId = s === undefined || s === null ? undefined : s.byId\n' +
      '    if (byId === undefined || byId === null) return undefined\n' +
      '    for (const row of Object.values(byId)) {\n' +
      '      if (row !== null && typeof row === \'object\' && ((row.retainedBy ?? {}).mainView ?? 0) > 0) return row\n' +
      '    }\n' +
      '    return undefined',
    to:
      '    const byId = s === undefined || s === null ? undefined : s.byId\n' +
      '    if (byId === undefined || byId === null) return undefined\n' +
      '    return byId[s.current]',
  },
  {
    name: 'any listed session counts as current (the retained flag is ignored)',
    from:
      "      if (row !== null && typeof row === 'object' && ((row.retainedBy ?? {}).mainView ?? 0) > 0) return row",
    to: "      if (row !== null && typeof row === 'object') return row",
  },
  {
    // Ownership, not authorship. The tab narrows on the sessions that RUN a row,
    // so mutating this to take everything is the regression that matters: the
    // tab stops explaining what will actually run.
    name: 'the scope tabs stop narrowing by session',
    from: '  const bySession = todos.filter((t) => currentOwned.has(t.id))',
    to: '  const bySession = todos.filter(() => true)',
  },
  {
    // The inverse: grouping by the planner lists rows this session must not take,
    // and hides the ones it must.
    name: 'the scope tab groups by planner instead of owner',
    from: '    for (const row of list) if (row.ownerSessionId === sessionId) owned.add(row.id)',
    to: '    for (const row of list) if (row.sourceSessionId === sessionId) owned.add(row.id)',
  },
  {
    // A container's children are owned by a session that does not exist yet, so
    // filtering on `ownerSessionId` alone hides them from the very tab that shows
    // their container — and a row you cannot see is a row you cannot drag out.
    name: "a container's children drop off the tab that owns the container",
    from: '  const bySession = todos.filter((t) => currentOwned.has(t.id))',
    to: '  const bySession = todos.filter((t) => t.ownerSessionId === currentId)',
  },
  {
    name: 'the scope tabs stop narrowing by directory',
    from: '  const byDir = todos.filter((t) => t.dir === cwdKey)',
    to: '  const byDir = todos.filter(() => true)',
  },
  {
    name: 'the parked line loses its drag (folding away strands the panel)',
    from: '          onPointerDown: beginParkDrag,',
    to: '          onPointerDown: () => {},',
  },
  {
    name: 'the parked drag never passes the click slop (a press no longer unfolds)',
    from: '      if (Math.abs(dx) < PARK_SLOP && Math.abs(dy) < PARK_SLOP) return',
    to: '      if (false) return',
  },
  {
    name: 'the parked drag resizes the card (the line keeps its own size)',
    from: '    applyParkedLayout({ x: drag.origin.x + dx, y: drag.origin.y + dy, w: drag.origin.w, h: drag.origin.h }, drag.rect)',
    to: '    applyLayout({ x: drag.origin.x + dx, y: drag.origin.y + dy, w: drag.rect.width, h: drag.rect.height })',
  },
  {
    name: 'the click after a parked drag unfolds anyway (the move is undone)',
    from: '    if (drag !== null && drag.moved === true) {',
    to: '    if (false) {',
  },
  {
    name: 'a stored size is rounded up out of nothing (the line sizes the card)',
    from: "  return isFinite(size) && size > 0 ? size : null",
    to: '  return isFinite(size) && size > 0 ? size : MIN_W',
  },
  {
    // v0.13.1: orphan promotion. Reverting to the unconditional bucket drops any
    // child whose parent is missing from the scope — counted nowhere, rendered
    // nowhere. The orphan test above must catch exactly this.
    name: "an orphaned child is dropped from the list again (silently)",
    from: "        runIn.kind === 'after' &&\n        present.has(runIn.id)",
    to: "        runIn.kind === 'after'",
  },
  {
    // v0.13.1: style-tag ownership. Without `data-plugin`, dsh-client-modules'
    // claimStyles adopts this tag for whichever plugin materializes next, and
    // that plugin's HMR replace then deletes our styles. The main CSS tag is
    // the one that styles the whole panel — losing it is the visible failure.
    name: "the main style tag loses its data-plugin ownership mark",
    from: "      style.setAttribute('data-dsh-todo-board', '')\n      // Pre-tag with our module id: dsh-client-modules' claimStyles adopts any\n      // untagged <style> for whichever plugin materializes next, and the next\n      // HMR replace of THAT plugin would then delete ours. `data-plugin` keeps\n      // ownership where it belongs (same convention as the official packages).\n      style.setAttribute('data-plugin', 'dsh-todo-board')\n      style.textContent = CSS",
    to: "      style.setAttribute('data-dsh-todo-board', '')\n      style.textContent = CSS",
  },
]

/** Apply one mutant to CRLF text by matching and replacing on the LF form. */
function mutate(source, mutant) {
  const lf = source.replace(/\r\n/g, '\n')
  if (!lf.includes(mutant.from)) return null
  const patched = lf.replace(mutant.from, mutant.to)
  // Map back to the original line endings so the file stays CRLF.
  return original.includes('\r\n') ? patched.replace(/\n/g, '\r\n') : patched
}

function suitePasses() {
  const result = spawnSync(process.execPath, [join(ROOT, 'tools', 'client-smoke.mjs')], {
    cwd: ROOT,
    stdio: 'ignore',
  })
  return result.status === 0
}

if (!suitePasses()) {
  console.error('the unmutated suite does not pass — aborting before mutating anything')
  process.exit(2)
}

let allCaught = true
try {
  for (const mutant of mutants) {
    const mutated = mutate(original, mutant)
    if (mutated === null) {
      console.error('SKIP (pattern not found): ' + mutant.name)
      allCaught = false
      continue
    }
    fs.writeFileSync(p, mutated, 'utf8')
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

if (fs.readFileSync(p, 'utf8') !== original) {
  console.error('RESTORE FAILED — client.js differs from the original!')
  process.exit(2)
}
if (!suitePasses()) {
  console.error('the restored suite does not pass')
  process.exit(2)
}

if (!allCaught) process.exit(1)
console.log('\nall ' + mutants.length + ' mutations caught; original restored and passing')
