# @0x-jerry/pi-package

My personalized [pi](https://pi.dev) package. Contains:

- **extensions/** — custom tools, lifecycle hooks, commands, keybindings
- **skills/** — capability folders (`SKILL.md`) loaded on demand
- **prompts/** — markdown prompt templates
- **themes/** — TUI color themes

## Setup

```bash
bun install        # install dev deps
bun run check # type-check extensions
```

## Subagent tool

`src/extensions/index.ts` is the package's extension entry (declared in
`package.json` → `pi.extensions`); it re-exports the `subagent` tool from
`src/extensions/agents/`. The tool delegates a task to a specialized agent
by creating an in-process agent session via the [pi SDK](https://pi.dev/docs/latest/sdk)
(`createAgentSession`): an isolated context window (in-memory session),
agent-specific system prompt, tool allowlist, and the full environment a
spawned `pi` process would have (extensions, skills, prompt templates,
AGENTS.md context). Its events (messages, usage, tool calls) stream back
to the parent session and render in the TUI.

```
subagent { agent: "scout", task: "Find all authentication code" }
```

The `agents/` extension is split into small modules:

- `index.ts` — tool registration (`execute`)
- `schema.ts` — TypeBox parameter schema
- `types.ts` — shared types
- `agents.ts` — agent discovery
- `result.ts` — result helpers (output, failure, usage)
- `run.ts` — in-process subagent runner (`createAgentSession` + full `DefaultResourceLoader`, typed events)
- `render.ts` — TUI rendering (subagent transcript rendered with pi's own message components, collapsed/expanded views)

Agents are markdown files with YAML frontmatter (`name`, `description`,
`tools`, optional `model`). Discovered from all levels pi supports (user +
project), project agents override user agents on name conflicts:

1. `~/.pi/agent/agents/*.md` — user-level (all projects)
2. `<project>/.pi/agents/*.md` — project-local (nearest ancestor dir)

An agent without a `model` inherits the parent session's active model (and
thinking level).
