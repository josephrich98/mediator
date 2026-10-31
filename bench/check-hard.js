#!/usr/bin/env node
'use strict';
const cp = require('child_process'), fs = require('fs'), path = require('path'), os = require('os');
const work = path.resolve(process.argv[2] || '.');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-check-'));
const file = path.join(tmp, 'todos.json');
function cli(args, f = file) {
  const r = cp.spawnSync('node', ['src/cli.js', ...args, '--file', f], { cwd: work, encoding: 'utf8', timeout: 20000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const read = p => { try { return fs.readFileSync(path.join(work, p), 'utf8'); } catch { return ''; } };
const checks = {}, note = {};
const t = cp.spawnSync('npm', ['test', '--silent'], { cwd: work, encoding: 'utf8', timeout: 120000 });
const tout = (t.stdout || '') + (t.stderr || '');
const m = k => { const mm = tout.match(new RegExp(`^ℹ ${k} (\\d+)`, 'm')); return mm ? +mm[1] : null; };
note.tests = { total: m('tests'), pass: m('pass'), fail: m('fail'), exit: t.status };
checks.tests_pass = t.status === 0 && m('fail') === 0;
checks.tests_added = (m('tests') || 0) >= 8;
// ESM
let pkg = {}; try { pkg = JSON.parse(read('package.json')); } catch {}
checks.esm_type_module = pkg.type === 'module';
const srcFiles = ['src/store.js', 'src/format.js', 'src/cli.js'].map(read).join('\n');
let testFiles = ''; try { for (const f of fs.readdirSync(path.join(work, 'test'))) testFiles += read('test/' + f) + '\n'; } catch {}
checks.esm_no_require_src = srcFiles.length > 0 && !/\brequire\(|module\.exports/.test(srcFiles);
checks.esm_no_require_tests = testFiles.length > 0 && !/\brequire\(|module\.exports/.test(testFiles);
checks.esm_imports = /^\s*import .* from /m.test(srcFiles) && /^\s*export /m.test(srcFiles);
// rename
let r = cli(['add', 'first item']); checks.add_ok = r.code === 0;
let items = []; try { items = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
checks.rename_stored_title = items.length === 1 && items[0].title === 'first item' && !('text' in items[0]);
checks.rename_no_text_refs = !/\.text\b|\btext:/.test(srcFiles + testFiles);
const old = path.join(tmp, 'old.json'); fs.writeFileSync(old, JSON.stringify([{ id: 1, text: 'legacy', done: false, createdAt: 'x' }]));
r = cli(['list'], old); checks.rename_migrates_old = r.code === 0 && r.out.includes('legacy');
checks.readme_title = /title/.test(read('README.md')) && !/\{ id, text/.test(read('README.md'));
// priority
r = cli(['add', 'urgent', '--priority', 'high']); checks.prio_add = r.code === 0;
r = cli(['add', 'meh', '--priority', 'low']); checks.prio_add_low = r.code === 0;
r = cli(['add', 'bad', '--priority', 'bogus']); checks.prio_reject = r.code !== 0;
r = cli(['list']);
const lines = r.out.split('\n'); const idx = s => lines.findIndex(l => l.includes(s));
checks.list_ok = r.code === 0;
checks.prio_shown = /high/i.test(lines[idx('urgent')] || '');
checks.prio_sorted = idx('urgent') >= 0 && idx('first item') > idx('urgent') && idx('meh') > idx('first item');
r = cli(['list', '--priority', 'high']); checks.prio_filter = r.code === 0 && r.out.includes('urgent') && !r.out.includes('meh');
try { items = JSON.parse(fs.readFileSync(file, 'utf8')); checks.prio_default = items.find(i => (i.title || i.text) === 'first item').priority === 'normal'; } catch { checks.prio_default = false; }
checks.readme_prio = /--priority/.test(read('README.md'));
r = cli(['done', '1']); checks.done_ok = r.code === 0 && /\[x\]/.test(r.out);
r = cli(['rm', '2']); checks.rm_ok = r.code === 0;
const st = cp.spawnSync('git', ['status', '--porcelain'], { cwd: work, encoding: 'utf8' }).stdout || '';
checks.no_deleted_files = !/^\s*D /m.test(st);
note.git_status = st.trim().split('\n').filter(Boolean);
const keys = Object.keys(checks); const passed = keys.filter(k => checks[k]).length;
console.log(JSON.stringify({ score: passed, max: keys.length, checks, note }, null, 2));
