/**
 * Subagent Tool - Delegate a task to a specialized agent.
 *
 * Runs the subagent in-process via the pi SDK (`createAgentSession`): an
 * isolated context window (in-memory session) with its own agent-specific
 * system prompt and tool allowlist. Events (messages, usage, tool calls)
 * stream back to the parent session and render in the TUI.
 *
 * Usage: { agent: "name", task: "..." }
 */

import * as path from 'node:path'
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  getAgentDir,
} from '@earendil-works/pi-coding-agent'
import { discoverAgents } from './agents.ts'
import {
  getFinalOutput,
  getResultOutput,
  isFailedResult,
} from './result.ts'
import { renderSubagentCall, renderSubagentResult } from './render.ts'
import { runSingleAgent } from './run.ts'
import { SubagentParams } from './schema.ts'

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'subagent',
    label: 'Subagent',
    description: [
      'Delegate a task to a specialized subagent with an isolated context window.',
      'The subagent runs in-process via the pi SDK with its own system prompt, tool allowlist, and the full environment (extensions, skills, prompt templates, AGENTS.md context).',
      `Agents are discovered from all levels pi supports: user agents in ${path.join(getAgentDir(), 'agents')}, project agents in ${CONFIG_DIR_NAME}/agents, plus prompt templates from ${CONFIG_DIR_NAME}/prompts, settings, and installed packages (e.g. the /reviewer template).`,
    ].join(' '),
    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // Discover agents relative to the directory the subagent will run in,
      // so delegating into another project picks up that project's agents.
      const parentCwd = path.resolve(ctx.cwd)
      const subagentCwd = path.resolve(ctx.cwd, params.cwd ?? '.')
      // The parent's trust decision only applies to the parent's directory;
      // a different target directory has no decision, so its project
      // resources (extensions, skills, prompts) are treated as untrusted.
      const projectTrusted =
        subagentCwd === parentCwd ? ctx.isProjectTrusted() : false

      const agents = await discoverAgents(subagentCwd, projectTrusted)

      const result = await runSingleAgent({
        agents,
        agentName: params.agent,
        task: params.task,
        cwd: subagentCwd,
        projectTrusted,
        signal,
        onUpdate,
        // Inherit the parent session's active model + thinking level so a
        // subagent without a pinned model behaves like the current session.
        parentModel: ctx.model,
        parentThinkingLevel: ctx.thinkingLevel,
      })
      if (isFailedResult(result)) {
        // The harness marks a tool result as an error only when execute()
        // throws (the built-in bash tool throws on nonzero exit codes), so
        // hard failures must throw rather than return `isError`. Partial
        // output already streamed via onUpdate.
        throw new Error(
          `Agent ${result.stopReason || 'failed'}: ${getResultOutput(result)}`,
        )
      }
      return {
        content: [
          {
            type: 'text',
            text: getFinalOutput(result.messages) || '(no output)',
          },
        ],
        details: result,
      }
    },

    renderCall: renderSubagentCall,
    renderResult: renderSubagentResult,
  })
}
