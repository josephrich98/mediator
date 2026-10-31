#!/usr/bin/env node
'use strict';
// Aggregate bench/results.jsonl into a markdown table (mean ± sd per condition).
const fs = require('fs'), path = require('path');
const rows = fs.readFileSync(path.resolve(process.argv[2] || path.join(__dirname, 'results.jsonl')), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const by = {}; for (const r of rows) (by[r.condition] = by[r.condition] || []).push(r);
const stat = (xs) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1)); return { m, sd }; };
const fmt = (xs, d = 0, unit = '') => { const { m, sd } = stat(xs); return `${m.toFixed(d)}${unit} ± ${sd.toFixed(d)}`; };
const metrics = [
  ['Wall-clock (both agents)', r => r.wall_ms / 1000, 0, 's'],
  ['Cost (USD, both agents)', r => r.cost_usd, 2, ''],
  ['Output tokens', r => r.output_tokens, 0, ''],
  ['Input tokens (incl. cache)', r => r.input_tokens / 1000, 0, 'k'],
  ['Assistant turns', r => r.turns, 1, ''],
  ['Tool errors', r => r.tool_errors, 1, ''],
  ['  of which stale-read / edit-mismatch', r => (r.error_kinds.stale_read || 0) + (r.error_kinds.edit_mismatch || 0), 1, ''],
  ['  of which mediator BLOCKED', r => r.error_kinds.mediator_blocked || 0, 1, ''],
  ['Times an agent saw a red test run', r => r.test_failures_seen || 0, 1, ''],
  ['Acceptance score', r => r.score, 1, ''],
  ['Trials with all tests passing', r => r.tests && r.tests.fail === 0 && r.tests.exit === 0 ? 1 : 0, 0, ''],
  ['Trials with full score', r => r.score === r.max ? 1 : 0, 0, ''],
];
const conds = Object.keys(by);
let md = `| Metric | ${conds.map(c => `${c} (n=${by[c].length})`).join(' | ')} |\n|---|${conds.map(() => '---').join('|')}|\n`;
for (const [name, f, d, unit] of metrics) {
  md += `| ${name} | ${conds.map(c => name.startsWith('Trials') ? `${by[c].map(f).reduce((a, b) => a + b, 0)}/${by[c].length}` : fmt(by[c].map(f), d, unit)).join(' | ')} |\n`;
}
md += `\nFailed checks by condition:\n`;
for (const c of conds) { const counts = {}; for (const r of by[c]) for (const k of r.failed_checks || []) counts[k] = (counts[k] || 0) + 1; md += `- ${c}: ${Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(', ') || 'none'}\n`; }
console.log(md);
