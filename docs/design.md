# Design notes

## The problem

Two agents (two Claude Code sessions, a Codex run plus a Cursor tab, a human and a bot…) edit the same checkout. Each one reads a file, thinks, and writes back the whole thing. The second write silently drops the first agent's changes. Worse, agent A runs the tests, sees agent B's half-finished work fail, and "fixes" it. Both burn tokens undoing each other, and the final tree is a coin flip.

Git worktrees avoid this but force a merge later and don't help when the tasks genuinely need the same files.

## The constraint

No heavy prompting. No supervising LLM. An agent working alone must pay nothing. An agent working with others should pay a few hundred tokens total, and only when something relevant happens.

## The design

| Failure mode | Mechanism |
|---|---|
| Both agents check a file and both see it as free | Check-and-claim is one atomic filesystem op: `open(O_EXCL)` on `.mediator/claims/<path>.json`. No lock files, no daemon. |
| An agent crashes while holding files | Each agent record stores the host process pid; a claim is dead the moment its owner's process is gone. Reservations also expire by TTL (15 min, renewed by every hook call). Claims with uncommitted edits never expire while the owner lives. Stealing a dead claim uses `rename()` so two reapers can't both win. |
| The up-front file list is wrong | Every Edit/Write passes through a PreToolUse hook that claims the file on the spot (or blocks). The plan is advisory; the hook is the truth. |
| Two files depend on a changing interface | `mediator note "<what changed>"` broadcasts; others receive it as `additionalContext` after their next tool call. |
| An agent read a file that another agent then changed | Releasing an edited file logs a *handoff*. Everyone else is told "re-read X before editing" exactly once. `mediator wait` says the same thing when it acquires a file that was handed off. |
| Shell commands bypass the Edit tool | PreToolUse on Bash blocks `sed -i`/`>`/`mv`… aimed at a file someone else holds, and blocks tree-wide git operations (`stash`, `checkout .`, `reset --hard`, `add -A`, `commit -a`) while others are present. Reads are never blocked. |
| Idle agents hog files | The Stop hook releases everything at the end of a turn. Claims come back automatically on the next edit. |

## Advisory vs strict (what the benchmark taught us)

v0.1 blocked every edit to a file another agent held. Three Sonnet 5.5 agents on overlapping tasks then took 2–3× longer than uncoordinated agents for identical results, and once deadlocked (A waiting for B's test file, B waiting for A's `store.js`; both timed out and re-waited). Uncoordinated agents were fine because they re-read before every surgical edit and Claude Code's `Edit` tool refuses edits against a stale read.

So the default became **advisory**: a surgical `Edit` to a held file is allowed, both agents get a one-line heads-up (once per file), and the holder is told to re-read. What stays blocked is what actually destroys work: whole-file `Write`, shell rewrites (`cat >`, `sed -i`, inline python/node), and tree-wide git operations. `wait` detects wait-for cycles and makes the later agent yield. Strict mode remains for whole-file writers.

## What it costs

- Alone in a repo: the SessionStart hook prints nothing. Zero tokens.
- With others: ~120 tokens of protocol brief + a status block at session start; one line per relevant event thereafter; a 2-line BLOCKED message per collision.
- Latency: one Node process start (~40 ms) per hooked tool call.

## Why not a shared Markdown "status board"?

Because two agents editing the same board is the exact race we're trying to fix. The board is derived (`mediator status`) rather than edited.

## Why not an MCP server?

A CLI is callable from any agent's shell tool without configuration, and hooks are shell commands anyway. An MCP wrapper is easy to add later if a client can't run shell commands.

## Why no supervising agent?

Overlap detection is a string comparison. The participating agents already have the context to decide who yields. If real traces show negotiation getting stuck, a mediator agent can be bolted on; the event log already has everything it would need.

## State layout

```
.mediator/
  agents/<id>.json     plan, pid, host, heartbeat, inbox cursor
  claims/<path>.json   owner, since, expires, modified, edits
  log.jsonl            join / plan / note / blocked / handoff / leave
```

Everything is plain JSON so you can `cat` it when something looks off. `.mediator/` is git-ignored by `mediator init`.
