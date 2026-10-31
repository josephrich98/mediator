'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'mediator.js');
function mk() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator-test-'));
  fs.mkdirSync(path.join(dir, '.mediator', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.mediator', 'claims'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.js'), '1'); fs.writeFileSync(path.join(dir, 'b.js'), '2');
  return dir;
}
function run(dir, args, { as, stdin, env = {} } = {}) {
  const r = cp.spawnSync('node', [BIN, ...args], { cwd: dir, input: stdin, encoding: 'utf8', env: { ...process.env, MEDIATOR_AGENT: as || '', CLAUDE_CODE_SESSION_ID: '', CLAUDE_PID: '', ...env } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}
const hookIn = (sid, extra) => JSON.stringify({ session_id: sid, cwd: extra.cwd, hook_event_name: 'x', ...extra });

test('plan claims files; second agent is blocked on overlap, free elsewhere', () => {
  const d = mk();
  let r = run(d, ['plan', 'add priorities', 'a.js', 'b.js'], { as: 'A' });
  assert.equal(r.code, 0); assert.match(r.out, /claimed: a.js b.js/);
  r = run(d, ['claim', 'a.js'], { as: 'B' });
  assert.equal(r.code, 3); assert.match(r.out, /BLOCKED a.js/);
  r = run(d, ['claim', 'c.js'], { as: 'B' });
  assert.equal(r.code, 0); assert.match(r.out, /claimed c.js/);
  r = run(d, ['status'], { as: 'B' });
  assert.match(r.out, /2 agents active/); assert.match(r.out, /"add priorities"/);
});

test('release hands off; waiter sees stale-read warning only if modified', () => {
  const d = mk();
  run(d, ['claim', 'a.js'], { as: 'A' });
  run(d, ['status'], { as: 'B' }); run(d, ['claim', 'b.js'], { as: 'B' }); // B joins now, so it will see A's handoff
  // simulate an edit via hook (marks modified)
  let r = run(d, ['hook', 'pre-edit'], { stdin: hookIn('A', { cwd: d, tool_name: 'Edit', tool_input: { file_path: path.join(d, 'a.js') } }) });
  assert.equal(r.code, 0);
  r = run(d, ['release', 'a.js'], { as: 'A' });
  assert.match(r.out, /released a.js/);
  r = run(d, ['claim', 'a.js'], { as: 'B' });
  assert.equal(r.code, 0); assert.match(r.out, /re-read it before editing/);
  r = run(d, ['inbox'], { as: 'B' });
  assert.match(r.out, /released edited file: a.js/);
});

test('hook pre-edit blocks other agent with exit 2 and names the holder plan', () => {
  const d = mk();
  run(d, ['plan', 'rename Store.add', 'a.js'], { as: 'A' });
  const r = run(d, ['hook', 'pre-edit'], { stdin: hookIn('B', { cwd: d, tool_name: 'Write', tool_input: { file_path: 'a.js' } }) });
  assert.equal(r.code, 2);
  assert.match(r.err, /BLOCKED — a.js is currently held by agent \[A\] "rename Store.add"/);
  // B can edit b.js; it gets auto-claimed
  const r2 = run(d, ['hook', 'pre-edit'], { stdin: hookIn('B', { cwd: d, tool_name: 'Write', tool_input: { file_path: 'b.js' } }) });
  assert.equal(r2.code, 0);
  assert.match(run(d, ['who', 'b.js']).out, /held by \[B\]/);
});

test('pre-bash blocks tree-wide git ops and shell writes to held files only when others present', () => {
  const d = mk();
  // alone: allowed
  let r = run(d, ['hook', 'pre-bash'], { stdin: hookIn('A', { cwd: d, tool_name: 'Bash', tool_input: { command: 'git stash' } }) });
  assert.equal(r.code, 0);
  run(d, ['plan', 'x', 'a.js'], { as: 'B' });
  r = run(d, ['hook', 'pre-bash'], { stdin: hookIn('A', { cwd: d, tool_name: 'Bash', tool_input: { command: 'git stash' } }) });
  assert.equal(r.code, 2); assert.match(r.err, /git stash/);
  r = run(d, ['hook', 'pre-bash'], { stdin: hookIn('A', { cwd: d, tool_name: 'Bash', tool_input: { command: 'git add -A && git commit -m x' } }) });
  assert.equal(r.code, 2);
  r = run(d, ['hook', 'pre-bash'], { stdin: hookIn('A', { cwd: d, tool_name: 'Bash', tool_input: { command: "sed -i 's/x/y/' a.js" } }) });
  assert.equal(r.code, 2); assert.match(r.err, /writes a.js/);
  r = run(d, ['hook', 'pre-bash'], { stdin: hookIn('A', { cwd: d, tool_name: 'Bash', tool_input: { command: 'cat a.js && node --test' } }) });
  assert.equal(r.code, 0);
  r = run(d, ['hook', 'pre-bash'], { stdin: hookIn('A', { cwd: d, tool_name: 'Bash', tool_input: { command: 'git add b.js && git commit -m x' } }) });
  assert.equal(r.code, 0);
});

test('stop releases claims and post-tool delivers inbox once', () => {
  const d = mk();
  run(d, ['hook', 'pre-edit'], { stdin: hookIn('A', { cwd: d, tool_input: { file_path: 'a.js' } }) });
  run(d, ['hook', 'post-tool'], { stdin: hookIn('B', { cwd: d }) }); // registers B, sets cursor
  run(d, ['note', 'Store.add now takes an object'], { as: 'A' });
  run(d, ['hook', 'stop'], { stdin: hookIn('A', { cwd: d }) });
  assert.match(run(d, ['who', 'a.js']).out, /free/);
  let r = run(d, ['hook', 'post-tool'], { stdin: hookIn('B', { cwd: d }) });
  const j = JSON.parse(r.out);
  assert.equal(j.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(j.hookSpecificOutput.additionalContext, /note: Store.add now takes an object/);
  assert.match(j.hookSpecificOutput.additionalContext, /released edited file: a.js/);
  r = run(d, ['hook', 'post-tool'], { stdin: hookIn('B', { cwd: d }) });
  assert.equal(r.out, '', 'inbox delivered only once');
});

test('dead agent claims are reclaimable; concurrent claimers: exactly one wins', () => {
  const d = mk();
  // dead agent: fake pid that is not alive, old heartbeat
  fs.writeFileSync(path.join(d, '.mediator', 'agents', 'DEAD.json'), JSON.stringify({ id: 'DEAD', host: os.hostname(), pid: 999999, heartbeat: 0, started: 0 }));
  fs.writeFileSync(path.join(d, '.mediator', 'claims', 'a%2Ejs.json'), JSON.stringify({ path: 'a.js', agent: 'DEAD', since: 0, expires: Date.now() + 1e9, modified: true }));
  const r = run(d, ['claim', 'a.js'], { as: 'A' });
  assert.equal(r.code, 0);
  // race: 8 agents claim b.js simultaneously
  const procs = [];
  for (let i = 0; i < 8; i++) procs.push(cp.spawn('node', [BIN, 'claim', 'b.js'], { cwd: d, env: { ...process.env, MEDIATOR_AGENT: 'R' + i, CLAUDE_CODE_SESSION_ID: '', CLAUDE_PID: '' } }));
  return Promise.all(procs.map(p => new Promise(res => p.on('exit', res)))).then(codes => {
    assert.equal(codes.filter(c => c === 0).length, 1, 'exactly one winner');
    assert.equal(codes.filter(c => c === 3).length, 7);
  });
});

test('hook is a silent no-op when mediator is not initialized', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator-none-'));
  const r = run(d, ['hook', 'pre-edit'], { stdin: hookIn('A', { cwd: d, tool_input: { file_path: 'x.js' } }) });
  assert.equal(r.code, 0); assert.equal(r.out, '');
});

test('init installs hooks idempotently and gitignores state', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator-init-'));
  cp.execSync('git init -q', { cwd: d });
  let r = run(d, ['init', '--no-skill']);
  assert.equal(r.code, 0);
  const s = JSON.parse(fs.readFileSync(path.join(d, '.claude', 'settings.json'), 'utf8'));
  assert.equal(s.hooks.PreToolUse.length, 2);
  r = run(d, ['init', '--no-skill']);
  const s2 = JSON.parse(fs.readFileSync(path.join(d, '.claude', 'settings.json'), 'utf8'));
  assert.equal(s2.hooks.PreToolUse.length, 2, 'idempotent');
  assert.match(fs.readFileSync(path.join(d, '.gitignore'), 'utf8'), /\.mediator\//);
});
