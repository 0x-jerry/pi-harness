# @0x-jerry/pi-harness

My personalized [pi](https://pi.dev) package. Contains extensions (ask, subagents, tool gate), prompts, and more.

## Tool gate (dangerous tool calls)

Hooks pi's `tool_call` event and gates rule-matched calls. Mode decides how a matched call is judged:

- `bypass` - gate off
- `manual` - user confirm dialog (approve -> execute, reject -> blocked)
- `copilot` - a model reviews the call (pass/reject/ask; ask escalates to manual, blocked headless)

Configure via `~/.pi/agent/tool-gate.json` (global) or `.pi/tool-gate.json` (project, trusted projects only):

```json
{
  "mode": "copilot",
  "headless": "block",
  "copilot": { "model": "anthropic/claude-3-5-haiku" },
  "allowList": ["bash:^ls "],
  "rules": [
    { "id": "my-rule", "description": "...", "tools": ["bash"], "fields": ["command"], "patterns": ["..."] }
  ]
}
```

Env overrides: `PI_TOOL_GATE_MODE`, `PI_TOOL_GATE_HEADLESS`, `PI_TOOL_GATE_COPILOT_MODEL`.

Defaults: a single catch-all bash rule, so every shell command is reviewed and the mode decides how (manual prompt / copilot model / headless policy). write/edit and other tools are not gated by default — add rules to review them.

## Install/Update

```bash
pi install npm:@0x-jerry/pi-harness
pi update npm:@0x-jerry/pi-harness
```

## Development

```bash
bun install        # install dev deps
bun run check # type-check
bun run test  # run unit tests
```
