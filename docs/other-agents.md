# Using mom outside Claude Code

Claude Code gets enforcement for free through hooks. Other agents can participate cooperatively through the CLI; the claims they take are honoured by the Claude Code hooks, and vice versa.

## Codex CLI / Cursor / Aider / anything with a shell

Add this to `AGENTS.md` (or `.cursorrules`, or your system prompt):

```
This repo uses mom to coordinate concurrent agents.
- Before your first edit: `mom plan "<goal>" <files>`
- Before editing any file not in your plan: `mom claim <file>` (exit 3 = held by someone else; do other work or `mom wait <file>`)
- After changing a shared interface: `mom note "<what changed>"`
- When finished: `mom release --all`
- Never: git stash / checkout . / reset --hard / add -A while `mom status` shows other agents.
```

Set `MOM_AGENT=<unique id>` in that agent's environment so the CLI knows who it is. If unset, mom tries `CLAUDE_CODE_SESSION_ID`, then matches the parent process against registered agents.

## Codex hooks

Codex supports lifecycle hooks similar to Claude Code's; wire `mom hook pre-edit` / `pre-bash` / `stop` to the equivalent events. Contributions welcome: see `HOOK_EVENTS` in `bin/mom.js` for the stdin fields each handler reads (`session_id`, `cwd`, `tool_input.file_path` or `tool_input.command`).

## Humans

You are an agent too. `MOM_AGENT=me mom plan "fixing CI" .github/workflows/ci.yml` keeps the bots out of your file.
