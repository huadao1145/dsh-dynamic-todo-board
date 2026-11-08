// Mutation check: the new auto-review pins must actually fail when broken.
// Mutates lib/index.js in memory, runs smoke, then restores byte-for-byte.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const TARGET = 'D:/DSH/plugin/dsh-todo-board/lib/index.js';
const original = readFileSync(TARGET);

const MUTATIONS = [
  {
    name: 'the description stops saying what done actually does',
    from: 'done 只把该行标记为「AI 已完成」（翻转一个布尔）',
    to: 'done 标记完成',
  },
  {
    name: 'the description stops saying the checkbox deletes nothing',
    from: '两者都不删除任何行、不改写标题或备注、不新建会话、不派发任务。',
    to: '两者都是安全的。',
  },
  {
    name: 'done loses its approval exemption (the auto-continue loop dies)',
    from: "const APPROVAL_FREE_ACTIONS = ['list', 'done', 'reopen', 'note']",
    to: "const APPROVAL_FREE_ACTIONS = ['list', 'reopen', 'note']",
  },
];

let caughtCount = 0;
try {
  for (const mutation of MUTATIONS) {
    const text = original.toString('utf8');
    if (!text.includes(mutation.from)) {
      console.log('SKIP (anchor missing): ' + mutation.name);
      continue;
    }
    writeFileSync(TARGET, text.replace(mutation.from, mutation.to));
    let caught = false;
    try {
      execFileSync(process.execPath, ['tools/smoke.mjs'], {
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
    ? '\nall ' + MUTATIONS.length + ' auto-review mutations caught; original restored and passing'
    : '\n' + (MUTATIONS.length - caughtCount) + ' mutation(s) NOT caught',
);
process.exit(caughtCount === MUTATIONS.length ? 0 : 1);
