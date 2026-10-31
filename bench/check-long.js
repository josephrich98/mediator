#!/usr/bin/env node
'use strict';
const cp = require('child_process'), fs = require('fs'), path = require('path'), os = require('os');
const work = path.resolve(process.argv[2] || '.');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-check-'));
const file = path.join(tmp, 'todos.json');
function cli(args, f = file) {
  const r = cp.spawnSync('node', ['src/cli.js', ...args, '--file', f], { cwd: work, encoding: 'utf8', timeout: 20000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '' };
}
const read = p => { try { return fs.readFileSync(path.join(work, p), 'utf8'); } catch { return ''; } };
const checks = {}, note = {};
const t = cp.spawnSync('npm', ['test', '--silent'], { cwd: work, encoding: 'utf8', timeout: 120000 });
const tout = (t.stdout || '') + (t.stderr || '');
const m = k => { const mm = tout.match(new RegExp(`^ℹ ${k} (\\d+)`, 'm')); return mm ? +mm[1] : null; };
note.tests = { total: m('tests'), pass: m('pass'), fail: m('fail'), exit: t.status };
checks.tests_pass = t.status === 0 && m('fail') === 0;
checks.tests_added = (m('tests') || 0) >= 10;
// ESM
let pkg = {}; try { pkg = JSON.parse(read('package.json')); } catch {}
checks.esm_type_module = pkg.type === 'module';
const srcFiles = ['src/store.js', 'src/format.js', 'src/cli.js'].map(read).join('\n');
let testFiles = ''; try { for (const f of fs.readdirSync(path.join(work, 'test'))) testFiles += read('test/' + f) + '\n'; } catch {}
checks.esm_no_require = srcFiles.length > 0 && !/\brequire\(|module\.exports/.test(srcFiles + testFiles);
// async (dynamic import so it works for CJS or ESM)
const a = cp.spawnSync('node', ['--input-type=module', '-e', `
  const { Store } = await import(process.cwd() + '/src/store.js');
  const f = process.argv[1];
  if (typeof Store.open !== 'function') throw new Error('no Store.open');
  const s = await Store.open(f);
  const p = s.add('async one');
  if (!(p && typeof p.then === 'function')) throw new Error('add is not async');
  await p;
  const s2 = await Store.open(f);
  const items = await s2.list();
  if (!items.find(i => (i.title || i.text) === 'async one')) throw new Error('not persisted');
  const fs = await import('fs'); const src = fs.readFileSync('./src/store.js', 'utf8');
  if (/readFileSync|writeFileSync/.test(src)) throw new Error('sync fs still used');
  console.log('ok');`, '--', path.join(tmp, 'async.json')], { cwd: work, encoding: 'utf8', timeout: 20000 });
checks.async_api = a.status === 0; note.async = (a.stderr || a.stdout || '').trim().slice(0, 200);
// rename
let r = cli(['add', 'first item']); checks.add_ok = r.code === 0;
let items = []; try { items = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
checks.rename_stored_title = items.length === 1 && items[0].title === 'first item' && !('text' in items[0]);
const old = path.join(tmp, 'old.json'); fs.writeFileSync(old, JSON.stringify([{ id: 1, text: 'legacy', done: false, createdAt: 'x' }]));
r = cli(['list'], old); checks.rename_migrates_old = r.code === 0 && r.out.includes('legacy');
// due
r = cli(['add', 'pay rent', '--due', '2026-11-01']); checks.due_add = r.code === 0;
r = cli(['add', 'old thing', '--due', '2020-01-01']); checks.due_add_past = r.code === 0;
r = cli(['add', 'bad2', '--due', 'notadate']); checks.due_reject = r.code !== 0;
// priority
r = cli(['add', 'urgent', '--priority', 'high']); checks.prio_add = r.code === 0;
r = cli(['add', 'meh', '--priority', 'low']); checks.prio_add_low = r.code === 0;
r = cli(['add', 'bad', '--priority', 'bogus']); checks.prio_reject = r.code !== 0;
r = cli(['add', 'both', '--priority', 'high', '--due', '2026-12-01']); checks.both_add = r.code === 0;
// list
r = cli(['list']);
const lines = r.out.split('\n'); const idx = s => lines.findIndex(l => l.includes(s)); const lineOf = s => lines[idx(s)] || '';
checks.list_ok = r.code === 0;
checks.prio_shown = /high/i.test(lineOf('urgent'));
checks.due_shown = /2026-11-01/.test(lineOf('pay rent'));
checks.both_shown = /high/i.test(lineOf('both')) && /2026-12-01/.test(lineOf('both'));
checks.prio_sorted = idx('urgent') >= 0 && idx('first item') > idx('urgent') && idx('meh') > idx('first item');
r = cli(['list', '--priority', 'high']); checks.prio_filter = r.code === 0 && r.out.includes('urgent') && !r.out.includes('meh');
r = cli(['list', '--overdue']); checks.overdue_filter = r.code === 0 && r.out.includes('old thing') && !r.out.includes('pay rent');
r = cli(['list', '--json']); try { const j = JSON.parse(r.stdout); checks.json_list = Array.isArray(j) && j.length >= 5; } catch { checks.json_list = false; }
r = cli(['edit', '1', 'renamed item']); checks.edit_cmd = r.code === 0 && cli(['list']).out.includes('renamed item');
try { items = JSON.parse(fs.readFileSync(file, 'utf8')); checks.prio_default = items.find(i => (i.title || i.text) === 'renamed item').priority === 'normal'; } catch { checks.prio_default = false; }
r = cli(['done', '1']); checks.done_ok = r.code === 0 && /\[x\]/.test(r.out);
r = cli(['rm', '2']); checks.rm_ok = r.code === 0;
const readme = read('README.md');
checks.readme_prio = /--priority/.test(readme); checks.readme_due = /--due/.test(readme); checks.readme_async = /Store\.open|await/.test(readme); checks.readme_title = /title/.test(readme);
const st = cp.spawnSync('git', ['status', '--porcelain'], { cwd: work, encoding: 'utf8' }).stdout || '';
checks.no_deleted_files = !/^\s*D /m.test(st);
note.git_status = st.trim().split('\n').filter(Boolean);
const keys = Object.keys(checks); const passed = keys.filter(k => checks[k]).length;
console.log(JSON.stringify({ score: passed, max: keys.length, checks, note }, null, 2));
