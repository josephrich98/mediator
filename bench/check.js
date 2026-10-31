#!/usr/bin/env node
'use strict';
// Acceptance checks for the todo fixture after the agents worked on it. Prints JSON.
const cp = require('child_process'), fs = require('fs'), path = require('path'), os = require('os');
const work = path.resolve(process.argv[2] || '.');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-check-'));
const file = path.join(tmp, 'todos.json');
function cli(args) {
  const r = cp.spawnSync('node', ['src/cli.js', ...args, '--file', file], { cwd: work, encoding: 'utf8', timeout: 20000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const checks = {}, note = {};
// tests
const t = cp.spawnSync('npm', ['test', '--silent'], { cwd: work, encoding: 'utf8', timeout: 120000 });
const tout = (t.stdout || '') + (t.stderr || '');
const m = k => { const mm = tout.match(new RegExp(`^ℹ ${k} (\\d+)`, 'm')); return mm ? +mm[1] : null; };
note.tests = { total: m('tests'), pass: m('pass'), fail: m('fail'), exit: t.status };
checks.tests_pass = t.status === 0 && m('fail') === 0;
checks.tests_added = (m('tests') || 0) >= 9; // 6 original + at least one per feature
// async refactor
const a = cp.spawnSync('node', ['-e', `
  const { Store } = require('./src/store');
  (async () => {
    const f = process.argv[1];
    if (typeof Store.open !== 'function') throw new Error('no Store.open');
    const s = await Store.open(f);
    const p = s.add('async one');
    if (!(p && typeof p.then === 'function')) throw new Error('add is not async');
    await p;
    const s2 = await Store.open(f);
    const items = await s2.list();
    if (!items.find(i => i.text === 'async one')) throw new Error('not persisted');
    const fs = require('fs'); const src = fs.readFileSync('./src/store.js', 'utf8');
    if (/readFileSync|writeFileSync/.test(src)) throw new Error('sync fs still used');
    console.log('ok');
  })().catch(e => { console.error(e.message); process.exit(1); });`, path.join(tmp, 'async.json')], { cwd: work, encoding: 'utf8', timeout: 20000 });
checks.async_api = a.status === 0;
note.async = (a.stderr || a.stdout || '').trim().slice(0, 200);
// priority
let r = cli(['add', 'buy milk', '--priority', 'high']); checks.prio_add = r.code === 0;
r = cli(['add', 'plain one']); checks.plain_add = r.code === 0;
r = cli(['add', 'bad', '--priority', 'bogus']); checks.prio_reject = r.code !== 0;
// due
r = cli(['add', 'pay rent', '--due', '2026-11-01']); checks.due_add = r.code === 0;
r = cli(['add', 'old thing', '--due', '2020-01-01']); checks.due_add_past = r.code === 0;
r = cli(['add', 'bad2', '--due', 'notadate']); checks.due_reject = r.code !== 0;
// both
r = cli(['add', 'both things', '--priority', 'high', '--due', '2026-12-01']); checks.both_add = r.code === 0;
// list
r = cli(['list']);
const lines = r.out.split('\n'); const lineOf = s => lines.find(l => l.includes(s)) || '';
checks.list_ok = r.code === 0;
checks.prio_shown = /high/i.test(lineOf('buy milk'));
checks.due_shown = /2026-11-01/.test(lineOf('pay rent'));
checks.both_shown = /high/i.test(lineOf('both things')) && /2026-12-01/.test(lineOf('both things'));
r = cli(['list', '--priority', 'high']); checks.prio_filter = r.code === 0 && r.out.includes('buy milk') && !r.out.includes('plain one');
r = cli(['list', '--overdue']); checks.overdue_filter = r.code === 0 && r.out.includes('old thing') && !r.out.includes('pay rent');
try { const items = JSON.parse(fs.readFileSync(file, 'utf8')); const p = items.find(i => i.text === 'plain one'); checks.prio_default = !!p && p.priority === 'normal'; } catch { checks.prio_default = false; }
r = cli(['done', '1']); checks.done_ok = r.code === 0 && /\[x\]/.test(r.out);
r = cli(['rm', '2']); checks.rm_ok = r.code === 0;
let readme = ''; try { readme = fs.readFileSync(path.join(work, 'README.md'), 'utf8'); } catch {}
checks.readme_prio = /--priority/.test(readme); checks.readme_due = /--due/.test(readme); checks.readme_async = /Store\.open|await/.test(readme);
const st = cp.spawnSync('git', ['status', '--porcelain'], { cwd: work, encoding: 'utf8' }).stdout || '';
checks.no_deleted_files = !/^\s*D /m.test(st);
note.git_status = st.trim().split('\n').filter(Boolean);
const keys = Object.keys(checks); const passed = keys.filter(k => checks[k]).length;
console.log(JSON.stringify({ score: passed, max: keys.length, checks, note }, null, 2));
