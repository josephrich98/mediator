#!/usr/bin/env node
'use strict';
/*
 * Benchmark: two headless Claude Code agents (Sonnet) edit overlapping files in one checkout,
 * with and without mom. Usage:
 *   node bench/run.js --condition baseline|mom-strict|mom-advisory [--trials 3] [--model claude-sonnet-5-5] [--max-turns 60] [--stagger 5]
 *                     [--tasks bench/tasks-hard.json --check bench/check-hard.js --tag hard]
 * Results: bench/runs/<condition>/<trial>/ (per-agent stream logs, check.json, summary.json) and bench/results.jsonl
 */
const fs = require('fs'), path = require('path'), cp = require('child_process'), os = require('os');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : null).filter(Boolean));
const COND = args.condition || 'baseline';
const TRIALS = +(args.trials || 1);
const MODEL = args.model || 'claude-sonnet-5-5';
const MAX_TURNS = +(args['max-turns'] || 60);
const STAGGER = +(args.stagger || 5) * 1000;
const BUDGET = +(args.budget || 4); // USD per agent
const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'mom.js');
const FIXTURE = path.join(__dirname, 'fixture');
const TAG = args.tag || 'default';
const RUNS = path.join(__dirname, 'runs', TAG, COND);
const TASKS_FILE = path.resolve(args.tasks || path.join(__dirname, 'tasks.json'));
const CHECK = path.resolve(args.check || path.join(__dirname, 'check.js'));
const RESULTS = path.join(__dirname, TAG === 'default' ? 'results.jsonl' : `results-${TAG}.jsonl`);
const tasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
const CONFIG_DIR = path.join(os.tmpdir(), 'mom-bench-claude-config');
fs.mkdirSync(CONFIG_DIR, { recursive: true });

const env = { ...process.env, CLAUDE_CONFIG_DIR: CONFIG_DIR };
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_MESSAGING_SOCKET', 'MOM_AGENT', 'MOM_ROOT']) delete env[k];

function sh(cmd, cwd) { return cp.execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }

function setupWork(trialDir) {
  const work = path.join(trialDir, 'work');
  fs.mkdirSync(work, { recursive: true });
  fs.cpSync(FIXTURE, work, { recursive: true });
  sh('git init -q && git -c user.email=b@b -c user.name=bench add -A && git -c user.email=b@b -c user.name=bench commit -qm fixture', work);
  if (COND.startsWith('mom')) {
    const mode = COND.split('-')[1] || 'advisory'; // mom-strict | mom-advisory
    sh(`node ${JSON.stringify(BIN)} init --root ${JSON.stringify(work)} --command "node ${BIN}" --mode ${mode}`, work);
  }
  return work;
}

function runAgent(work, agent, outFile) {
  const prompt = agent.prompt + tasks.shared_suffix;
  const argv = ['-p', prompt, '--model', MODEL, '--output-format', 'stream-json', '--verbose', '--max-turns', String(MAX_TURNS),
    '--max-budget-usd', String(BUDGET), '--setting-sources', 'project', '--no-session-persistence',
    // acceptEdits (not bypass) so agents use the Edit/Write tools like interactive sessions do; Bash is allow-listed.
    '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'MultiEdit', 'Skill'];
  const t0 = Date.now();
  const outFd = fs.openSync(outFile, 'w');
  const child = cp.spawn('claude', argv, { cwd: work, env, stdio: ['ignore', outFd, fs.openSync(outFile + '.stderr', 'w')] });
  return new Promise(resolve => child.on('exit', code => { fs.closeSync(outFd); resolve({ code, wall_ms: Date.now() - t0 }); }));
}

function parseStream(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const s = { turns: 0, tool_uses: {}, tool_errors: 0, error_kinds: {}, mom_blocks: 0, mom_cmds: 0, test_failures_seen: 0, result: null, text_chars: 0 };
  const pending = {}; // tool_use_id -> name
  for (const l of lines) {
    let m; try { m = JSON.parse(l); } catch { continue; }
    if (m.type === 'assistant' && m.message && Array.isArray(m.message.content)) {
      s.turns++;
      for (const c of m.message.content) {
        if (c.type === 'tool_use') {
          s.tool_uses[c.name] = (s.tool_uses[c.name] || 0) + 1; pending[c.id] = c.name;
          if (c.name === 'Bash' && /\bmom\b/.test(c.input && c.input.command || '')) s.mom_cmds++;
        } else if (c.type === 'text') s.text_chars += (c.text || '').length;
      }
    } else if (m.type === 'user' && m.message && Array.isArray(m.message.content)) {
      for (const c of m.message.content) {
        if (c.type !== 'tool_result') continue;
        const txt = typeof c.content === 'string' ? c.content : JSON.stringify(c.content || '');
        if (/ℹ fail [1-9]/.test(txt) || /# fail [1-9]/.test(txt)) s.test_failures_seen++;
        if (c.is_error) {
          s.tool_errors++;
          const kind = /mom: BLOCKED/.test(txt) ? 'mom_blocked'
            : /modified since read|has been modified/i.test(txt) ? 'stale_read'
            : /has not been read yet|must read|Read it first/i.test(txt) ? 'read_first'
            : /String to replace not found|old_string/i.test(txt) ? 'edit_mismatch'
            : /exit code|Error:|failed|✖/i.test(txt) ? 'command_failed' : 'other';
          s.error_kinds[kind] = (s.error_kinds[kind] || 0) + 1;
          if (kind === 'mom_blocked') s.mom_blocks++;
        } else if (/mom: BLOCKED/.test(txt)) { s.mom_blocks++; }
      }
    } else if (m.type === 'result') {
      s.result = { cost_usd: m.total_cost_usd, duration_ms: m.duration_ms, duration_api_ms: m.duration_api_ms, num_turns: m.num_turns, usage: m.usage, subtype: m.subtype, is_error: m.is_error };
    }
  }
  return s;
}

(async () => {
  fs.mkdirSync(RUNS, { recursive: true });
  for (let t = 0; t < TRIALS; t++) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const trialDir = path.join(RUNS, stamp);
    const work = setupWork(trialDir);
    console.log(`[${COND}] trial ${t + 1}/${TRIALS} → ${path.relative(ROOT, trialDir)}`);
    const t0 = Date.now();
    const runs = [];
    for (let i = 0; i < tasks.agents.length; i++) {
      if (i) await new Promise(r => setTimeout(r, STAGGER));
      runs.push(runAgent(work, tasks.agents[i], path.join(trialDir, `${tasks.agents[i].name}.jsonl`)).then(r => ({ ...r, name: tasks.agents[i].name })));
    }
    const exits = await Promise.all(runs);
    const wall_ms = Date.now() - t0;
    let check; try { check = JSON.parse(sh(`node ${JSON.stringify(CHECK)} ${JSON.stringify(work)}`, ROOT)); } catch (e) { check = { score: 0, max: 18, error: String(e.stdout || e) }; }
    fs.writeFileSync(path.join(trialDir, 'check.json'), JSON.stringify(check, null, 2));
    const agents = {};
    for (const a of tasks.agents) agents[a.name] = { ...parseStream(path.join(trialDir, `${a.name}.jsonl`)), exit: exits.find(e => e.name === a.name) };
    if (COND.startsWith('mom')) { try { fs.copyFileSync(path.join(work, '.mom', 'log.jsonl'), path.join(trialDir, 'mom-log.jsonl')); } catch {} }
    const usage = Object.values(agents).map(a => a.result && a.result.usage || {});
    const sum = k => usage.reduce((n, u) => n + (u[k] || 0), 0);
    const summary = {
      condition: COND, tag: TAG, trial: stamp, model: MODEL, wall_ms,
      cost_usd: +Object.values(agents).reduce((n, a) => n + ((a.result && a.result.cost_usd) || 0), 0).toFixed(4),
      output_tokens: sum('output_tokens'), input_tokens: sum('input_tokens') + sum('cache_creation_input_tokens') + sum('cache_read_input_tokens'),
      cache_read_tokens: sum('cache_read_input_tokens'),
      turns: Object.values(agents).reduce((n, a) => n + ((a.result && a.result.num_turns) || 0), 0),
      tool_errors: Object.values(agents).reduce((n, a) => n + a.tool_errors, 0),
      error_kinds: Object.values(agents).reduce((acc, a) => { for (const [k, v] of Object.entries(a.error_kinds)) acc[k] = (acc[k] || 0) + v; return acc; }, {}),
      mom_blocks: Object.values(agents).reduce((n, a) => n + a.mom_blocks, 0),
      mom_cmds: Object.values(agents).reduce((n, a) => n + a.mom_cmds, 0),
      test_failures_seen: Object.values(agents).reduce((n, a) => n + a.test_failures_seen, 0),
      max_turns_hit: Object.values(agents).filter(a => a.result && a.result.subtype && a.result.subtype !== 'success').length,
      score: check.score, max: check.max, tests: check.note && check.note.tests, failed_checks: Object.entries(check.checks || {}).filter(([, v]) => !v).map(([k]) => k),
      agents,
    };
    fs.writeFileSync(path.join(trialDir, 'summary.json'), JSON.stringify(summary, null, 2));
    fs.appendFileSync(RESULTS, JSON.stringify({ ...summary, agents: undefined }) + '\n');
    console.log(`  wall ${(wall_ms / 1000).toFixed(0)}s  cost $${summary.cost_usd}  out_tokens ${summary.output_tokens}  turns ${summary.turns}  tool_errors ${summary.tool_errors} ${JSON.stringify(summary.error_kinds)}  red_tests_seen ${summary.test_failures_seen}  blocks ${summary.mom_blocks}  score ${summary.score}/${summary.max}  tests ${JSON.stringify(summary.tests)}`);
  }
})();
