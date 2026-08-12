/**
 * Subagent Tool - Delegate a task to a specialized agent.
 *
 * Spawns a separate `pi` process per invocation, giving it an isolated
 * context window and its own agent-specific system prompt.
 *
 * Usage: { agent: "name", task: "..." }
 *
 * The subagent runs `pi --mode json -p --no-session` so its structured
 * event stream (messages, usage, tool calls) can be streamed back to the
 * parent session and rendered in the TUI.
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
      'The subagent runs in a separate pi process with its own system prompt.',
      `Agents are discovered from all levels pi supports: user agents in ${path.join(getAgentDir(), 'agents')} and project agents in ${CONFIG_DIR_NAME}/agents.`,
    ].join(' '),
    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const agents = discoverAgents(ctx.cwd)
      const parentModel = ctx.model
        ? `${ctx.model.provider}/${ctx.model.id}`
        : undefined

      const result = await runSingleAgent(
        ctx.cwd,
        agents,
        params.agent,
        params.task,
        params.cwd,
        signal,
        onUpdate,
        parentModel,
      )
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
