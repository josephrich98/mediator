#!/usr/bin/env node
'use strict';
/*
 * mediator — keep concurrent AI coding agents from stepping on each other.
 *
 * Zero dependencies. State lives in <repo>/.mediator/ as plain files:
 *   agents/<id>.json   one record per live agent (plan, pid, heartbeat, inbox cursor)
 *   claims/<path>.json one record per claimed file; created with O_EXCL so
 *                      "check and claim" is a single atomic filesystem operation
 *   log.jsonl          append-only event log (plans, notes, handoffs)
 *
 * Agents never need to read these files; they use `mediator <cmd>` and the
 * Claude Code hooks (`mediator hook <event>`) do the rest automatically.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const VERSION = '0.3.0';
const TTL_SEC = parseInt(process.env.MEDIATOR_TTL_SEC || '', 10) || 900; // reservation TTL
const TTL_MS = TTL_SEC * 1000;
const HOST = os.hostname();
const NOW = () => Date.now();

// ---------------------------------------------------------------- utilities
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSONAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file); // atomic replace on POSIX & modern Windows
}
function ago(ts) {
  const s = Math.max(0, Math.round((NOW() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${(s / 3600).toFixed(1)}h ago`;
}
function short(id) { return String(id || '').replace(/-/g, '').slice(0, 4); }
function encPath(rel) { return encodeURIComponent(rel).replace(/\./g, '%2E') + '.json'; }
function decPath(name) { return decodeURIComponent(name.replace(/\.json$/, '')); }
function pidAlive(pid) {
  if (!pid) return null;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM' ? true : false; }
}
function out(s) { if (s) process.stdout.write(s.endsWith('\n') ? s : s + '\n'); }
function die(msg, code = 1) { process.stderr.write(`mediator: ${msg}\n`); process.exit(code); }

// ---------------------------------------------------------------- root / state dir
function findRoot(start) {
  if (process.env.MEDIATOR_ROOT) return path.resolve(process.env.MEDIATOR_ROOT);
  let dir = path.resolve(start || process.cwd());
  // 1) nearest ancestor with .mediator/
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.mediator'))) return d;
    if (path.dirname(d) === d) break;
  }
  // 2) nearest ancestor with .git
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) break;
  }
  return dir;
}
class State {
  constructor(root) {
    this.root = root;
    this.dir = path.join(root, '.mediator');
    this.agentsDir = path.join(this.dir, 'agents');
    this.claimsDir = path.join(this.dir, 'claims');
    this.logFile = path.join(this.dir, 'log.jsonl');
    this._cfg = null;
  }
  get cfg() { if (!this._cfg) this._cfg = readJSON(path.join(this.dir, 'config.json'), {}); return this._cfg; }
  /** How agents should invoke mediator in this repo (same prefix the hooks use). */
  get cmd() { return this.cfg.cmd || 'mediator'; }
  /** 'advisory' (default): surgical Edits to a file someone else holds are allowed with a warning; only destructive
   *  operations are blocked (whole-file Write / shell rewrite of a held file, tree-wide git ops).
   *  'strict': any edit to a file another agent holds is blocked. */
  get mode() { return process.env.MEDIATOR_MODE || this.cfg.mode || 'advisory'; }
  get enabled() { return fs.existsSync(this.dir); }
  ensure() {
    fs.mkdirSync(this.agentsDir, { recursive: true });
    fs.mkdirSync(this.claimsDir, { recursive: true });
    if (!fs.existsSync(this.logFile)) fs.writeFileSync(this.logFile, '');
  }
  rel(p) {
    const abs = path.isAbsolute(p) ? p : path.resolve(this.root, p);
    const r = path.relative(this.root, abs);
    if (!r || r.startsWith('..') || path.isAbsolute(r)) return null; // outside repo
    return r.split(path.sep).join('/');
  }
  // ---- agents
  agentFile(id) { return path.join(this.agentsDir, `${id}.json`); }
  getAgent(id) { return readJSON(this.agentFile(id), null); }
  saveAgent(a) { writeJSONAtomic(this.agentFile(a.id), a); }
  removeAgent(id) { try { fs.unlinkSync(this.agentFile(id)); } catch {} }
  agents() {
    let names = [];
    try { names = fs.readdirSync(this.agentsDir); } catch {}
    return names.filter(n => n.endsWith('.json')).map(n => readJSON(path.join(this.agentsDir, n), null)).filter(Boolean);
  }
  isPresent(a) {
    if (!a) return false;
    if (a.host === HOST && a.pid) {
      const alive = pidAlive(a.pid);
      if (alive === false) return false;
      if (alive === true) return true;
    }
    return NOW() - (a.heartbeat || 0) < TTL_MS;
  }
  liveAgents() { return this.agents().filter(a => this.isPresent(a)); }
  // ---- claims
  claimFile(rel) { return path.join(this.claimsDir, encPath(rel)); }
  getClaim(rel) { return readJSON(this.claimFile(rel), null); }
  claims() {
    let names = [];
    try { names = fs.readdirSync(this.claimsDir); } catch {}
    return names.filter(n => n.endsWith('.json')).map(n => readJSON(path.join(this.claimsDir, n), null)).filter(Boolean);
  }
  /** A claim is valid if its owner is present and (it's dirty or not yet expired). */
  claimValid(c, agentsById) {
    if (!c) return false;
    const owner = agentsById ? agentsById[c.agent] : this.getAgent(c.agent);
    if (!this.isPresent(owner)) return false;
    if (c.modified) return true; // uncommitted edits: hold until release or owner death
    return (c.expires || 0) > NOW();
  }
  /**
   * Try to claim `rel` for `me`. Returns {ok:true, claim} or {ok:false, claim(holder), owner}.
   * Atomic: creation uses O_EXCL; stealing a stale claim uses rename() so only one stealer wins.
   */
  tryClaim(rel, me, { modified = false, steal = false } = {}) {
    const file = this.claimFile(rel);
    for (let attempt = 0; attempt < 5; attempt++) {
      const fresh = { path: rel, agent: me, since: NOW(), expires: NOW() + TTL_MS, modified, renewed: NOW() };
      try {
        const fd = fs.openSync(file, 'wx');
        fs.writeSync(fd, JSON.stringify(fresh));
        fs.closeSync(fd);
        return { ok: true, claim: fresh, fresh: true };
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      const existing = readJSON(file, null);
      if (!existing) continue; // vanished between open and read: retry
      if (existing.agent === me) {
        existing.expires = NOW() + TTL_MS; existing.renewed = NOW();
        if (modified) { existing.modified = true; existing.edits = (existing.edits || 0) + 1; }
        writeJSONAtomic(file, existing);
        return { ok: true, claim: existing, fresh: false };
      }
      if (this.claimValid(existing) && !steal) {
        return { ok: false, claim: existing, owner: this.getAgent(existing.agent) };
      }
      // stale (or forced): reap via rename so concurrent reapers can't both succeed
      const tomb = `${file}.reap.${process.pid}.${Math.random().toString(36).slice(2)}`;
      try { fs.renameSync(file, tomb); fs.unlinkSync(tomb); } catch { /* someone else reaped; loop */ }
    }
    return { ok: false, claim: this.getClaim(rel), owner: null };
  }
  release(rel, me) {
    const file = this.claimFile(rel);
    const c = readJSON(file, null);
    if (!c || c.agent !== me) return null;
    try { fs.unlinkSync(file); } catch {}
    return c;
  }
  renewAll(me) {
    for (const c of this.claims()) {
      if (c.agent === me && NOW() - (c.renewed || 0) > TTL_MS / 4) {
        c.expires = NOW() + TTL_MS; c.renewed = NOW();
        writeJSONAtomic(this.claimFile(c.path), c);
      }
    }
  }
  // ---- log
  log(ev) { fs.appendFileSync(this.logFile, JSON.stringify({ ts: NOW(), ...ev }) + '\n'); }
  logSize() { try { return fs.statSync(this.logFile).size; } catch { return 0; } }
  readLog(from = 0) {
    let buf;
    try { buf = fs.readFileSync(this.logFile); } catch { return { events: [], end: 0 }; }
    const slice = buf.subarray(Math.min(from, buf.length)).toString('utf8');
    const events = slice.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return { events, end: buf.length };
  }
  gc() {
    const agents = this.agents();
    const present = {};
    for (const a of agents) { if (this.isPresent(a)) present[a.id] = a; else this.removeAgent(a.id); }
    for (const c of this.claims()) {
      if (!this.claimValid(c, present)) { try { fs.unlinkSync(this.claimFile(c.path)); } catch {} }
    }
    return present;
  }
}

// ---------------------------------------------------------------- identity
function hostPidFromAncestors() {
  // Walk up the process tree looking for the agent host (claude, codex, cursor…).
  let pid = process.ppid, found = null, first = process.ppid;
  for (let i = 0; i < 12 && pid > 1; i++) {
    let cmd = '', ppid = 0;
    try {
      if (process.platform === 'linux') {
        cmd = fs.readFileSync(`/proc/${pid}/cmdline`).toString().replace(/\0/g, ' ');
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        ppid = parseInt(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1], 10);
      } else {
        const line = cp.execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
        ppid = parseInt(line, 10); cmd = line.replace(/^\s*\d+\s*/, '');
      }
    } catch { break; }
    if (/\b(claude|codex|cursor|aider|gemini|copilot|opencode)\b/i.test(cmd) && !/mediator/.test(cmd)) { found = pid; break; }
    pid = ppid;
  }
  return found || first;
}
function resolveSelf(st, hookInput, flags) {
  if (flags.as) return flags.as;
  if (hookInput && hookInput.session_id) {
    return hookInput.agent_id ? `${hookInput.session_id}.${hookInput.agent_id}` : hookInput.session_id;
  }
  if (process.env.MEDIATOR_AGENT) return process.env.MEDIATOR_AGENT;
  if (process.env.CLAUDE_CODE_SESSION_ID) return process.env.CLAUDE_CODE_SESSION_ID;
  // match an ancestor pid against registered agents
  const hostPid = hostPidFromAncestors();
  const byPid = st.agents().find(a => a.host === HOST && a.pid === hostPid);
  if (byPid) return byPid.id;
  return null;
}
function ensureAgent(st, id, extra = {}) {
  let a = st.getAgent(id);
  const fresh = !a;
  if (!a) {
    a = { id, host: HOST, pid: parseInt(process.env.CLAUDE_PID, 10) || hostPidFromAncestors(), started: NOW(), plan: null, cursor: st.logSize(), cwd: st.root };
  }
  a.heartbeat = NOW();
  Object.assign(a, extra);
  st.saveAgent(a);
  if (fresh) st.log({ agent: id, type: 'join' });
  return a;
}
function label(a, me) {
  const tag = `[${short(a.id)}]`;
  if (a.id === me) return `${tag} you`;
  return a.plan ? `${tag} "${a.plan}"` : tag;
}

/**
 * Wait-for cycle detection. Returns {holder, wants} if the holder of `claim` is (transitively)
 * waiting for a file that `me` holds. Deterministic tie-break: the agent that joined later yields.
 */
function detectDeadlock(st, me, claim) {
  let holderId = claim && claim.agent, seen = new Set();
  for (let depth = 0; holderId && depth < 8 && !seen.has(holderId); depth++) {
    seen.add(holderId);
    const holder = st.getAgent(holderId);
    if (!holder || !st.isPresent(holder) || !holder.waiting_for) return null;
    const wc = st.getClaim(holder.waiting_for);
    if (!wc || !st.claimValid(wc)) return null;
    if (wc.agent === me) return { holder: st.getAgent(claim.agent), wants: holder.waiting_for, direct: depth === 0 };
    holderId = wc.agent;
  }
  return null;
}
function iYield(me, other) {
  const a = (me && me.started) || 0, b = (other && other.started) || 0;
  return a !== b ? a > b : String(me.id) > String(other.id);
}

// ---------------------------------------------------------------- rendering
function renderStatus(st, me, { compact = false } = {}) {
  const present = st.gc();
  const others = Object.values(present).filter(a => a.id !== me);
  const claims = st.claims().filter(c => present[c.agent]);
  const byAgent = {};
  for (const c of claims) (byAgent[c.agent] = byAgent[c.agent] || []).push(c);
  const lines = [];
  const n = Object.keys(present).length;
  lines.push(`mediator (${st.mode}): ${n} agent${n === 1 ? '' : 's'} active in ${path.basename(st.root)}${others.length ? '' : ' (just you)'}`);
  const order = [...(present[me] ? [present[me]] : []), ...others];
  for (const a of order) {
    const cs = (byAgent[a.id] || []).sort((x, y) => x.path.localeCompare(y.path));
    const files = cs.map(c => c.path + (c.modified ? '*' : '')).join(' ');
    const idle = a.id === me ? '' : `, active ${ago(a.heartbeat)}`;
    const waiting = a.waiting_for ? ` — waiting for ${a.waiting_for}` : '';
    lines.push(`  ${label(a, me)}${idle}${cs.length ? ` — ${cs.length} file${cs.length === 1 ? '' : 's'}: ${files}` : ' — no files claimed'}${waiting}`);
  }
  if (claims.some(c => c.modified)) lines.push('  (* = has uncommitted edits by that agent; wait for release before touching)');
  // recent notes from others
  const { events } = st.readLog(0);
  const notes = events.filter(e => e.type === 'note' && present[e.agent] && e.agent !== me).slice(-5);
  if (notes.length && !compact) {
    lines.push('  Notes from other agents:');
    for (const e of notes) lines.push(`    ${label(present[e.agent], me)} ${ago(e.ts)}: ${e.text}`);
  }
  return lines.join('\n');
}
function renderInbox(st, me, { advance = true } = {}) {
  const meRec = st.getAgent(me);
  const from = meRec ? (meRec.cursor || 0) : 0;
  const { events, end } = st.readLog(from);
  if (meRec && advance && end !== from) { meRec.cursor = end; st.saveAgent(meRec); }
  const present = st.gc();
  const lines = [];
  for (const e of events) {
    if (e.agent === me) continue;
    const who = present[e.agent] ? label(present[e.agent], me) : `[${short(e.agent)}]`;
    switch (e.type) {
      case 'join': lines.push(`${who} started working in this repo.`); break;
      case 'leave': lines.push(`${who} finished and left.`); break;
      case 'plan': lines.push(`${who} plan: "${e.text}"${e.files && e.files.length ? ` (files: ${e.files.join(' ')})` : ''}`); break;
      case 'note': lines.push(`${who} note: ${e.text}`); break;
      case 'handoff':
        if (e.modified && e.modified.length) lines.push(`${who} released edited file${e.modified.length === 1 ? '' : 's'}: ${e.modified.join(' ')} — re-read before editing (your earlier read is stale).`);
        break;
      case 'overlap': {
        const mine = st.getClaim(e.path);
        if (e.holder === me && mine && mine.agent === me) lines.push(`${who} also edited ${e.path}, which you hold — re-Read it before your next edit to it.`);
        break;
      }
      case 'blocked': break;
      default: break;
    }
  }
  return lines.length ? `mediator — updates from other agents:\n- ${lines.join('\n- ')}` : '';
}

const BRIEF = (others, cmd, mode) => [
  `mediator is active: ${others} other agent${others === 1 ? ' is' : 's are'} working in this repo right now.`,
  mode === 'strict'
    ? 'Hooks enforce file ownership: a file you Edit/Write is claimed for you automatically; editing a file another agent holds is blocked (you will be told who has it). Edit files with the Edit/Write tools, not shell scripts, so ownership is tracked.'
    : 'Hooks track who is editing what. Use the Edit tool for changes (surgical edits to a file someone else is editing are allowed; you will be warned so you keep them small and re-read first). Rewriting a whole file that another agent is editing (Write tool, `cat >`, scripts) is blocked.',
  `Protocol (cheap, do it): 1) Before your first edit run \`${cmd} plan "<one-line goal>" <files you expect to touch>\`.`,
  `2) If you change a shared interface (signature, schema, CLI flag, export), run \`${cmd} note "<what changed>"\`.`,
  `3) If blocked: work on your other files first, or \`${cmd} wait <file>\` (blocks until free), then re-read the file before editing. When you are done with a file others may need, \`${cmd} release <file>\` early.`,
  `4) Never run git stash/reset/checkout/restore on the whole tree or \`git add -A\`: other agents have uncommitted work here. \`${cmd} status\` shows who holds what.`,
].join('\n');

// ---------------------------------------------------------------- commands
function parseArgs(argv) {
  const flags = {}, pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('-') && ['as', 'timeout', 'command', 'settings', 'root', 'n', 'mode'].includes(k)) flags[k] = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { flags, pos };
}

function needSelf(st, flags) {
  const me = resolveSelf(st, null, flags);
  if (!me) die('cannot tell which agent you are. Set MEDIATOR_AGENT=<id> or pass --as <id>.');
  ensureAgent(st, me);
  return me;
}

const commands = {
  init(st, { flags }) {
    const root = flags.root ? path.resolve(flags.root) : gitRootOrCwd();
    st = new State(root);
    st.ensure();
    const done = [`created ${path.relative(process.cwd(), st.dir) || '.mediator'}/`];
    // .gitignore
    const gi = path.join(root, '.gitignore');
    const cur = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
    if (!/^\.mediator\/?$/m.test(cur)) { fs.writeFileSync(gi, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + '.mediator/\n'); done.push('added .mediator/ to .gitignore'); }
    if (!flags['no-hooks']) {
      const settingsPath = flags.settings ? path.resolve(flags.settings) : path.join(root, '.claude', 'settings.json');
      const cmd = flags.command || hookCommand();
      const res = installHooks(settingsPath, cmd);
      writeJSONAtomic(path.join(st.dir, 'config.json'), { ...readJSON(path.join(st.dir, 'config.json'), {}), cmd, mode: flags.mode === 'strict' ? 'strict' : 'advisory' });
      done.push(`${res} hooks in ${path.relative(process.cwd(), settingsPath)} (command: ${cmd} hook <event>)`);
    }
    if (!flags['no-skill']) {
      const src = path.join(__dirname, '..', 'skills', 'mediator', 'SKILL.md');
      const dst = path.join(root, '.claude', 'skills', 'mediator', 'SKILL.md');
      if (fs.existsSync(src)) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); done.push(`installed skill at ${path.relative(process.cwd(), dst)}`); }
    }
    out('mediator: ' + done.join('; ') + `; mode: ${flags.mode === 'strict' ? 'strict' : 'advisory'}` + '\nStart two agents in this repo and run `mediator status` to watch them coordinate.');
  },
  status(st, { flags }) {
    if (!st.enabled) die('not initialized here. Run `mediator init` in the repo root.');
    const me = resolveSelf(st, null, flags);
    if (flags.json) {
      const present = st.gc();
      return out(JSON.stringify({ root: st.root, me, agents: Object.values(present), claims: st.claims().filter(c => present[c.agent]) }, null, 2));
    }
    out(renderStatus(st, me));
  },
  plan(st, { flags, pos }) {
    if (!st.enabled) die('not initialized here. Run `mediator init` in the repo root.');
    const me = needSelf(st, flags);
    const text = pos[0];
    if (!text) die('usage: mediator plan "<one-line goal>" [files...]');
    const files = pos.slice(1).map(f => st.rel(f)).filter(Boolean);
    ensureAgent(st, me, { plan: text });
    const got = [], held = [];
    for (const f of files) {
      const r = st.tryClaim(f, me);
      if (r.ok) got.push(f); else held.push({ f, owner: r.owner });
    }
    st.log({ agent: me, type: 'plan', text, files });
    const lines = [`plan recorded for [${short(me)}]: "${text}"`];
    if (got.length) lines.push(`claimed: ${got.join(' ')}`);
    for (const h of held) lines.push(`NOT claimed: ${h.f} is held by ${h.owner ? label(h.owner, me) : 'another agent'} — do that file last, or \`${st.cmd} wait ${h.f}\``);
    const others = st.liveAgents().filter(a => a.id !== me);
    if (others.length) lines.push(renderStatus(st, me, { compact: true }));
    out(lines.join('\n'));
  },
  claim(st, { flags, pos }) {
    if (!st.enabled) die('not initialized here. Run `mediator init` in the repo root.');
    const me = needSelf(st, flags);
    const files = pos.map(f => st.rel(f)).filter(Boolean);
    if (!files.length) die('usage: mediator claim <files...> [--wait] [--timeout SEC] [--steal]');
    const deadline = NOW() + (parseInt(flags.timeout, 10) || 180) * 1000;
    const lines = [];
    for (const f of files) {
      let r = st.tryClaim(f, me, { steal: !!flags.steal });
      if (!r.ok && flags.wait) {
        process.stderr.write(`mediator: waiting for ${f} (held by ${r.owner ? label(r.owner, me) : '?'})…\n`);
        const meRec = ensureAgent(st, me, { waiting_for: f });
        let deadlocked = null;
        while (!r.ok && NOW() < deadline) {
          const dl = detectDeadlock(st, me, r.claim);
          if (dl && iYield(meRec, dl.holder)) { deadlocked = dl; break; }
          sleepMs(1500); r = st.tryClaim(f, me);
        }
        ensureAgent(st, me, { waiting_for: null });
        if (deadlocked) {
          st.log({ agent: me, type: 'deadlock', path: f, wants: deadlocked.wants, holder: deadlocked.holder.id });
          lines.push([
            `DEADLOCK on ${f}: it is held by ${label(deadlocked.holder, me)}, who is waiting for ${deadlocked.wants}, which YOU hold. You joined later, so you yield.`,
            `Do now: finish any in-progress edit to ${deadlocked.wants}, run \`${st.cmd} release ${deadlocked.wants}\`, then run \`${st.cmd} wait ${f}\` again (they will release it when their turn ends).`,
          ].join('\n'));
          process.exitCode = 4;
          continue;
        }
      }
      if (r.ok) {
        const handed = st.readLog(0).events.some(e => e.type === 'handoff' && e.agent !== me && (e.modified || []).includes(f));
        lines.push(`claimed ${f}${handed ? ' — another agent edited this file earlier; re-read it before editing' : ''}`);
      } else {
        lines.push(`BLOCKED ${f}: held by ${r.owner ? label(r.owner, me) : 'another agent'}${r.claim && r.claim.modified ? ' (has uncommitted edits)' : ''}. Try \`${st.cmd} wait ${f}\` or work on other files first.`);
        process.exitCode = 3;
      }
    }
    out(lines.join('\n'));
  },
  wait(st, args) { args.flags.wait = true; return commands.claim(st, args); },
  release(st, { flags, pos }) {
    if (!st.enabled) die('not initialized here.');
    const me = needSelf(st, flags);
    const files = flags.all ? st.claims().filter(c => c.agent === me).map(c => c.path) : pos.map(f => st.rel(f)).filter(Boolean);
    if (!files.length) die('usage: mediator release <files...> | --all');
    const released = [], modified = [];
    for (const f of files) { const c = st.release(f, me); if (c) { released.push(f); if (c.modified) modified.push(f); } }
    if (released.length) st.log({ agent: me, type: 'handoff', released, modified });
    out(released.length ? `released ${released.join(' ')}` : 'nothing to release');
  },
  note(st, { flags, pos }) {
    if (!st.enabled) die('not initialized here.');
    const me = needSelf(st, flags);
    if (!pos[0]) die('usage: mediator note "<what changed and what others must do>"');
    st.log({ agent: me, type: 'note', text: pos[0] });
    const others = st.liveAgents().filter(a => a.id !== me).length;
    out(`note posted to ${others} other agent${others === 1 ? '' : 's'}.`);
  },
  who(st, { flags, pos }) {
    if (!st.enabled) die('not initialized here.');
    const me = resolveSelf(st, null, flags);
    for (const p of pos) {
      const rel = st.rel(p); const c = rel && st.getClaim(rel);
      if (c && st.claimValid(c)) out(`${rel}: held by ${label(st.getAgent(c.agent), me)} since ${ago(c.since)}${c.modified ? ' (uncommitted edits)' : ''}`);
      else out(`${rel || p}: free`);
    }
  },
  inbox(st, { flags }) {
    if (!st.enabled) die('not initialized here.');
    const me = needSelf(st, flags);
    out(renderInbox(st, me) || 'no updates from other agents.');
  },
  log(st, { flags }) {
    if (!st.enabled) die('not initialized here.');
    const n = parseInt(flags.n, 10) || 30;
    const { events } = st.readLog(0);
    for (const e of events.slice(-n)) out(`${new Date(e.ts).toISOString()} [${short(e.agent)}] ${e.type}${e.text ? ` ${JSON.stringify(e.text)}` : ''}${e.files ? ' ' + e.files.join(' ') : ''}${e.released ? ' ' + e.released.join(' ') : ''}${e.path ? ' ' + e.path : ''}`);
  },
  gc(st) { if (!st.enabled) die('not initialized here.'); const p = st.gc(); out(`ok: ${Object.keys(p).length} live agent(s), ${st.claims().length} claim(s)`); },
  leave(st, { flags }) {
    if (!st.enabled) die('not initialized here.');
    const me = needSelf(st, flags);
    leave(st, me); out(`[${short(me)}] left.`);
  },
  hook(st, { pos }) { return runHook(st, pos[0]); },
  version() { out(VERSION); },
  help() { out(HELP); },
};

function leave(st, me) {
  const mine = st.claims().filter(c => c.agent === me);
  const modified = mine.filter(c => c.modified).map(c => c.path);
  for (const c of mine) st.release(c.path, me);
  if (mine.length) st.log({ agent: me, type: 'handoff', released: mine.map(c => c.path), modified });
  st.log({ agent: me, type: 'leave' });
  st.removeAgent(me);
}
function sleepMs(ms) {
  // synchronous sleep without busy-waiting (Atomics.wait on a shared buffer)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function gitRootOrCwd() {
  try { return cp.execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return process.cwd(); }
}
function hookCommand() {
  // Prefer a PATH-resolvable `mediator`; otherwise call this file by absolute path.
  try {
    const w = cp.execFileSync(process.platform === 'win32' ? 'where' : 'which', ['mediator'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (w) return 'mediator';
  } catch {}
  return `node ${JSON.stringify(fs.realpathSync(__filename))}`.replace(/^node "([^ "]+)"$/, 'node $1');
}
const HOOK_EVENTS = [
  ['SessionStart', '', 'session-start', 15],
  ['UserPromptSubmit', '', 'prompt', 10],
  ['PreToolUse', 'Edit|Write|MultiEdit|NotebookEdit', 'pre-edit', 10],
  ['PreToolUse', 'Bash', 'pre-bash', 10],
  ['PostToolUse', 'Edit|Write|MultiEdit|NotebookEdit|Bash|Task|Agent', 'post-tool', 10],
  ['Stop', '', 'stop', 10],
  ['SessionEnd', '', 'session-end', 10],
];
function installHooks(settingsPath, cmd) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const settings = readJSON(settingsPath, {});
  settings.hooks = settings.hooks || {};
  let added = 0;
  for (const [event, matcher, sub, timeout] of HOOK_EVENTS) {
    const list = (settings.hooks[event] = settings.hooks[event] || []);
    const command = `${cmd} hook ${sub}`;
    const exists = list.some(e => (e.hooks || []).some(h => typeof h.command === 'string' && / hook (session-start|prompt|pre-edit|pre-bash|post-tool|stop|session-end)$/.test(h.command) && h.command.endsWith(` hook ${sub}`)));
    if (exists) continue;
    const entry = { hooks: [{ type: 'command', command, timeout }] };
    if (matcher) entry.matcher = matcher;
    list.push(entry); added++;
  }
  writeJSONAtomic(settingsPath, settings);
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return added ? `installed ${added}` : 'already had';
}

// ---------------------------------------------------------------- hooks
function readStdinJSON() {
  try { const s = fs.readFileSync(0, 'utf8'); return s.trim() ? JSON.parse(s) : {}; } catch { return {}; }
}
function hookOut(event, additionalContext) {
  if (!additionalContext) return;
  out(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } }));
}
const INLINE_WRITE = /(<<\s*['"]?\w+|\b(python3?|node|perl|ruby|php)\b[^|;&]*\s(-e|-c|-)\s|\bopen\([^)]*['"][wa]|writeFile|write_text|\.write\(|fs\.(promises\.)?writeFile)/;
const WRITEY = /(\bsed\s+(-[a-zA-Z]*i|--in-place)|\bperl\s+-[a-zA-Z]*i|>{1,2}\s*(?!&|\/dev\/null)|\btee\b|\bmv\b|\bcp\b|\brm\b|\btruncate\b|\bdd\b|\bpatch\b|\bgit\s+(apply|checkout|restore)\b|\bprettier\b.*--write|\beslint\b.*--fix|\bblack\b|\bruff\b.*(format|--fix)|\bgofmt\s+-w|\brustfmt\b)/;
const GIT_TREEWIDE = [
  [/\bgit\s+stash\b(?!\s+(list|show))/, 'git stash would hide other agents\' uncommitted edits'],
  [/\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/, 'tree-wide checkout/restore would discard other agents\' edits'],
  [/\bgit\s+checkout\s+(?!--|-b\b|\S+\s+--\s+)\S+\s*$/, 'switching branches would move other agents\' working tree under them'],
  [/\bgit\s+switch\b/, 'switching branches would move other agents\' working tree under them'],
  [/\bgit\s+reset\s+--(hard|merge)\b/, 'hard reset would discard other agents\' edits'],
  [/\bgit\s+clean\b/, 'git clean would delete other agents\' new files'],
  [/\bgit\s+(rebase|merge|pull)\b/, 'rewriting the working tree while other agents edit it causes conflicts'],
  [/\bgit\s+add\s+(-A|--all|\.|\*)(\s|$)/, 'stage only your own files: `git add <files>`; other agents\' half-done work is in this tree'],
  [/\bgit\s+commit\s+(-[a-zA-Z]*a|--all)\b/, 'commit only your own files: `git add <files> && git commit`; other agents\' half-done work is in this tree'],
];
function runHook(st, event) {
  const input = readStdinJSON();
  if (input.cwd) st = new State(findRoot(input.cwd));
  if (!st.enabled) return; // mediator not enabled in this repo: silent no-op (safe to install globally)
  const me = resolveSelf(st, input, {});
  if (!me) return;
  switch (event) {
    case 'session-start': {
      st.ensure();
      ensureAgent(st, me, { pid: hostPidFromAncestors(), cwd: input.cwd || st.root });
      if (process.env.CLAUDE_ENV_FILE) { try { fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export MEDIATOR_AGENT=${JSON.stringify(me)}\n`); } catch {} }
      const others = st.liveAgents().filter(a => a.id !== me);
      if (!others.length) return; // zero token cost when working alone
      out(BRIEF(others.length, st.cmd, st.mode) + '\n\n' + renderStatus(st, me));
      return;
    }
    case 'prompt': {
      ensureAgent(st, me); st.renewAll(me);
      const others = st.liveAgents().filter(a => a.id !== me);
      const inbox = renderInbox(st, me);
      if (!others.length && !inbox) return;
      const parts = [];
      if (inbox) parts.push(inbox);
      if (others.length) parts.push(renderStatus(st, me, { compact: true }));
      out(parts.join('\n'));
      return;
    }
    case 'pre-edit': {
      ensureAgent(st, me); st.renewAll(me);
      const ti = input.tool_input || {};
      const p = ti.file_path || ti.notebook_path || ti.path;
      if (!p) return;
      const rel = st.rel(p);
      if (!rel || rel.startsWith('.mediator/')) return;
      const r = st.tryClaim(rel, me, { modified: true });
      if (r.ok) return;
      const owner = r.owner;
      const c = r.claim || {};
      const wholeFile = input.tool_name === 'Write' && fs.existsSync(path.join(st.root, rel));
      if (st.mode !== 'strict' && !wholeFile) {
        // advisory: allow the surgical edit, warn once per file, and tell the holder afterwards.
        const a = st.getAgent(me) || {};
        a.overlaps = a.overlaps || {};
        const first = !a.overlaps[rel];
        a.overlaps[rel] = NOW(); st.saveAgent(a);
        st.log({ agent: me, type: 'overlap', path: rel, holder: c.agent });
        if (first) hookOut('PreToolUse', `mediator: heads-up — ${rel} is also being edited right now by ${owner ? label(owner, me) : '[' + short(c.agent) + ']'}. Keep this edit small and local, don't reformat or rewrite the file, and re-Read it before further edits (its contents may change under you).`);
        return;
      }
      st.log({ agent: me, type: 'blocked', path: rel, holder: c.agent });
      const msg = [
        `mediator: BLOCKED — ${rel} is currently held by agent ${owner ? label(owner, me) : '[' + short(c.agent) + ']'} (claimed ${ago(c.since)}${c.edits ? `, ${c.edits} edit${c.edits === 1 ? '' : 's'} so far` : ''}).${wholeFile ? ' Rewriting the whole file would discard their edits; use the Edit tool for a surgical change instead.' : ''}`,
        `Do not edit this file now. Options: (a) do your other files first and come back; (b) run \`${st.cmd} wait ${rel}\` to block until it is released, then Read it again before editing; (c) if that agent is clearly gone, \`${st.cmd} claim --steal ${rel}\`.`,
      ].join('\n');
      process.stderr.write(msg + '\n');
      process.exit(2);
    }
    case 'pre-bash': {
      ensureAgent(st, me); st.renewAll(me);
      const cmd = String((input.tool_input || {}).command || '');
      if (!cmd || /\bmediator\b/.test(cmd)) return;
      const others = st.liveAgents().filter(a => a.id !== me);
      if (!others.length) return;
      for (const [re, why] of GIT_TREEWIDE) {
        if (re.test(cmd)) {
          process.stderr.write(`mediator: BLOCKED — ${others.length} other agent${others.length === 1 ? ' is' : 's are'} working in this tree; ${why}.\n`);
          process.exit(2);
        }
      }
      if (WRITEY.test(cmd) || INLINE_WRITE.test(cmd)) {
        const present = st.gc();
        const theirs = st.claims().filter(c => c.agent !== me && present[c.agent]);
        const hit = theirs.find(c => cmd.includes(c.path) || cmd.includes(path.basename(c.path)));
        if (hit) {
          const owner = present[hit.agent];
          process.stderr.write(`mediator: BLOCKED — this command looks like it writes ${hit.path}, which is held by ${label(owner, me)}. Use the Edit tool (so ownership is tracked), do other work first, or \`${st.cmd} wait ${hit.path}\`.\n`);
          process.exit(2);
        }
      }
      return;
    }
    case 'post-tool': {
      ensureAgent(st, me);
      const inbox = renderInbox(st, me);
      if (inbox) hookOut('PostToolUse', inbox);
      return;
    }
    case 'stop': {
      // Turn finished: release everything so idle agents never block others. Claims are re-acquired automatically on the next edit.
      const a = st.getAgent(me); if (!a) return;
      const mine = st.claims().filter(c => c.agent === me);
      if (!mine.length) return;
      const modified = mine.filter(c => c.modified).map(c => c.path);
      for (const c of mine) st.release(c.path, me);
      st.log({ agent: me, type: 'handoff', released: mine.map(c => c.path), modified });
      return;
    }
    case 'session-end': {
      if (st.getAgent(me)) leave(st, me);
      return;
    }
    default:
      die(`unknown hook event ${event}`);
  }
}

const HELP = `mediator ${VERSION} — keep concurrent AI coding agents from stepping on each other.

Setup (once per repo):      mediator init            # .mediator/, Claude Code hooks, skill
Agent protocol:
  mediator plan "<goal>" [files...]   announce what you're doing; reserve files
  mediator status                     who is here, who holds what, recent notes
  mediator note "<interface change>"  broadcast something others must know
  mediator claim <files...>           reserve files (hooks do this for Edit/Write automatically)
  mediator wait <file> [--timeout S]  block until a file is free, then claim it
  mediator release <files...>|--all   hand files back (hooks do this at end of turn)
  mediator who <file>                 who holds a file
  mediator inbox                      updates from other agents since you last looked
  mediator log [--n N]                raw event log
  mediator gc                         drop dead agents / expired claims
  mediator leave                      deregister yourself
Hooks:                       mediator hook <session-start|prompt|pre-edit|pre-bash|post-tool|stop|session-end>
Modes:  mediator init --mode advisory (default) | strict      (or MEDIATOR_MODE=...)
Env: MEDIATOR_AGENT (identity), MEDIATOR_ROOT (repo root), MEDIATOR_TTL_SEC (reservation TTL, default 900)
`;

// ---------------------------------------------------------------- main
(function main() {
  const { flags, pos } = parseArgs(process.argv.slice(2));
  const cmd = pos.shift() || 'help';
  if (flags.version || cmd === '--version') return out(VERSION);
  const fn = commands[cmd];
  if (!fn) die(`unknown command "${cmd}"\n${HELP}`);
  const st = new State(findRoot(flags.root));
  try { fn(st, { flags, pos }); }
  catch (e) { die(e && e.stack || String(e)); }
})();
