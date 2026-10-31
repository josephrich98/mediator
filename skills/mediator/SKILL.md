---
name: mediator
description: Coordinate with other AI agents editing the same repository at the same time. Use at the start of any coding task in a repo where another agent or session may be working (parallel sessions, worktree-less teams, CI bots), and whenever mediator warns or blocks an edit.
---

# mediator: don't step on other agents' toes

Hooks already enforce the hard rules. Your job is three cheap habits.

1. **Lead with a plan.** Before your first edit:
   `mediator plan "<one-line goal>" <files you expect to touch>`
   Others see it immediately and route around you. Update it if the scope changes.
2. **Announce interface changes.** If you rename, re-sign, or restructure anything another file depends on (function signature, schema, CLI flag, export, config key):
   `mediator note "<what changed> -> <what callers must do>"`
3. **Respect warnings and blocks.**
   - *heads-up: X is also being edited by [a]* (advisory mode, the default): keep your edit small and local, don't reformat or rewrite the file, and Read it again before your next edit to it.
   - *BLOCKED*: you tried to rewrite a whole file someone else is editing, or the repo runs in strict mode. Do your other files first, or `mediator wait <file>` (returns when it is free, or tells you to yield if you are in a circular wait), then **Read it again** before editing.

What the hooks do for you (no action needed):
- Every Edit/Write claims the file for you; claims are released when your turn ends or you exit.
- Rewriting a file another agent is editing (Write tool, `cat >`, `sed -i`, inline scripts) is blocked. So are `git stash`, `git checkout .`, `git reset --hard`, `git add -A`, `git commit -a` while others are present.
- Updates from other agents (plans, notes, "I finished editing X, re-read it", "I also edited X") arrive after your tool calls.

Useful: `mediator status` (who holds what), `mediator who <file>`, `mediator release <file>` (hand a file back early so a waiting agent can proceed).

Commit discipline: stage only your own files (`git add <files>`); never `-A`/`-a`.
