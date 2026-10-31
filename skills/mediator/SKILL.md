---
name: mediator
description: Coordinate with other AI agents editing the same repository at the same time. Use at the start of any coding task in a repo where another agent or session may be working (parallel sessions, worktree-less teams, CI bots), and whenever an edit is BLOCKED by mediator.
---

# mediator: don't step on other agents' toes

Hooks already enforce the hard rules. Your job is three cheap habits.

1. **Lead with a plan.** Before your first edit:
   `mediator plan "<one-line goal>" <files you expect to touch>`
   Others see it immediately and route around you. Update it if the scope changes.
2. **Announce interface changes.** If you rename, re-sign, or restructure anything another file depends on (function signature, schema, CLI flag, export, config key):
   `mediator note "<what changed> -> <what callers must do>"`
3. **Respect BLOCKED.** When an edit is blocked, the message names the holder and their plan. Do your other files first. If you must have the file: `mediator wait <file>` (blocks until released), then **Read it again** before editing; its contents changed.

What the hooks do for you (no action needed):
- Every Edit/Write auto-claims the file; claims are released when your turn ends or you exit.
- Shell commands that would clobber others (`git stash`, `git checkout .`, `git reset --hard`, `git add -A`, `sed -i` on a held file) are blocked while others are present.
- Updates from other agents (plans, notes, "I finished editing X, re-read it") arrive after your tool calls.

Useful: `mediator status` (who holds what), `mediator who <file>`, `mediator release <file>` (hand a file back early so a waiting agent can proceed).

Commit discipline: stage only your own files (`git add <files>`); never `-A`/`-a`.
