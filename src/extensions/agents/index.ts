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
      const agents = await discoverAgents(ctx.cwd)

      const result = await runSingleAgent({
        agents,
        agentName: params.agent,
        task: params.task,
        defaultCwd: ctx.cwd,
        cwd: params.cwd,
        signal,
        onUpdate,
        // Inherit the parent session's active model + thinking level so a
        // subagent without a pinned model behaves like the current session.
        parentModel: ctx.model,
        parentThinkingLevel: ctx.thinkingLevel,
      })
      const isError = isFailedResult(result)
      if (isError) {
        const errorMsg = getResultOutput(result)
        return {
          content: [
            {
              type: 'text',
              text: `Agent ${result.stopReason || 'failed'}: ${errorMsg}`,
            },
          ],
          details: result,
          isError: true,
        }
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
