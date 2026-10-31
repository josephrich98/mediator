#!/usr/bin/env node
'use strict';
// Acceptance checks for the todo fixture after two agents worked on it. Prints JSON.
const cp = require('child_process'), fs = require('fs'), path = require('path'), os = require('os');
const work = path.resolve(process.argv[2] || '.');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-check-'));
const file = path.join(tmp, 'todos.json');
function cli(args) {
  const r = cp.spawnSync('node', ['src/cli.js', ...args, '--file', file], { cwd: work, encoding: 'utf8', timeout: 20000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const checks = {};
const note = {};
// 1. tests
const t = cp.spawnSync('npm', ['test', '--silent'], { cwd: work, encoding: 'utf8', timeout: 120000 });
const tout = (t.stdout || '') + (t.stderr || '');
const m = k => { const mm = tout.match(new RegExp(`^ℹ ${k} (\\d+)`, 'm')); return mm ? +mm[1] : null; };
note.tests = { total: m('tests'), pass: m('pass'), fail: m('fail'), exit: t.status };
checks.tests_pass = t.status === 0 && (m('fail') === 0);
checks.tests_added = (m('tests') || 0) >= 8; // 6 original + at least one per feature
// 2. priority feature
let r = cli(['add', 'buy milk', '--priority', 'high']);
checks.prio_add = r.code === 0;
r = cli(['add', 'plain one']);
checks.plain_add = r.code === 0;
r = cli(['add', 'bad', '--priority', 'bogus']);
checks.prio_reject = r.code !== 0;
// 3. due feature
r = cli(['add', 'pay rent', '--due', '2026-11-01']);
checks.due_add = r.code === 0;
r = cli(['add', 'bad2', '--due', 'notadate']);
checks.due_reject = r.code !== 0;
// 4. both at once
r = cli(['add', 'both things', '--priority', 'high', '--due', '2026-12-01']);
checks.both_add = r.code === 0;
// 5. list shows them
r = cli(['list']);
const lines = r.out.split('\n');
const lineOf = s => lines.find(l => l.includes(s)) || '';
checks.list_ok = r.code === 0;
checks.prio_shown = /high/i.test(lineOf('buy milk'));
checks.due_shown = /2026-11-01/.test(lineOf('pay rent'));
checks.both_shown = /high/i.test(lineOf('both things')) && /2026-12-01/.test(lineOf('both things'));
// 6. stored defaults
try { const items = JSON.parse(fs.readFileSync(file, 'utf8')); const p = items.find(i => i.text === 'plain one'); checks.prio_default = !!p && p.priority === 'normal'; } catch { checks.prio_default = false; }
// 7. done / rm still work
r = cli(['done', '1']); checks.done_ok = r.code === 0 && /\[x\]/.test(r.out);
r = cli(['rm', '2']); checks.rm_ok = r.code === 0;
// 8. README
let readme = ''; try { readme = fs.readFileSync(path.join(work, 'README.md'), 'utf8'); } catch {}
checks.readme_prio = /--priority/.test(readme);
checks.readme_due = /--due/.test(readme);
// 9. nothing deleted
const st = cp.spawnSync('git', ['status', '--porcelain'], { cwd: work, encoding: 'utf8' }).stdout || '';
checks.no_deleted_files = !/^\s*D /m.test(st);
note.git_status = st.trim().split('\n').filter(Boolean);
const keys = Object.keys(checks);
const passed = keys.filter(k => checks[k]).length;
console.log(JSON.stringify({ score: passed, max: keys.length, checks, note }, null, 2));
