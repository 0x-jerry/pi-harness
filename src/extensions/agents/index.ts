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
import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { discoverAgents, findNearestProjectAgentsDir } from './agents.ts'
import {
  emptyResult,
  getFinalOutput,
  getResultOutput,
  isFailedResult,
} from './result.ts'
import { createSubagentsModal } from './modal.ts'
import { renderSubagentCall, renderSubagentResult } from './render.ts'
import { runSingleAgent } from './run.ts'
import { ListAgentsParams, SubagentParams } from './schema.ts'
import {
  addTask,
  clearTasks,
  finishTask,
  getTask,
  getTasks,
  restoreTasks,
  TASK_ENTRY_TYPE,
  taskRecord,
  updateTask,
} from './store.ts'
import type { OnUpdateCallback, SubAgentResult } from './types.ts'

/**
 * Persist a finished task as a session custom entry (authoritative status;
 * the transcript stays in the tool-result message). Best-effort: a session
 * that refuses additional entries must not break the tool result.
 */
function recordTask(pi: ExtensionAPI, toolCallId: string): void {
  const task = getTask(toolCallId)
  if (!task) return
  try {
    pi.appendEntry(TASK_ENTRY_TYPE, taskRecord(task))
  } catch {
    // Session persistence is best-effort.
  }
}

export default function (pi: ExtensionAPI) {
  // Rebuild the task store from persisted history whenever a session starts
  // (startup, /resume, /new, fork, reload), so /subagents reflects previous
  // runs as soon as the session is back. Extension instances are rebuilt on
  // session switch, so cross-session state starts empty here; restoreTasks
  // also guards against a reused module (clearTasks + session-file check).
  pi.on('session_start', (_event, ctx) => {
    clearTasks()
    restoreTasks(
      ctx.sessionManager.getEntries(),
      ctx.sessionManager.getSessionFile() ?? undefined,
    )
  })
  pi.registerTool({
    name: 'subagent',
    label: 'Subagent',
    description:
      'Delegate a task to a specialized subagent with an isolated context window, its own system prompt and tools. Agents come from builtin, user, and project levels.',
    parameters: SubagentParams,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // Discover agents relative to the directory the subagent will run in,
      // so delegating into another project picks up that project's agents.
      const parentCwd = path.resolve(ctx.cwd)
      const subagentCwd = path.resolve(ctx.cwd, params.cwd ?? '.')
      // The parent's trust decision only applies to the parent's directory;
      // a different target directory has no decision, so its project
      // resources (extensions, skills, prompts) are treated as untrusted.
      const projectTrusted =
        subagentCwd === parentCwd ? ctx.isProjectTrusted() : false

      // Track the run for the /subagents modal from the moment it starts,
      // so in-progress tasks are visible alongside finished ones.
      addTask(
        toolCallId,
        emptyResult({
          agent: params.agent,
          task: params.task,
          cwd: subagentCwd,
        }),
      )
      const trackedUpdate: OnUpdateCallback | undefined = onUpdate
        ? (partial) => {
            if (partial.details) updateTask(toolCallId, partial.details)
            onUpdate(partial)
          }
        : undefined

      let result: SubAgentResult
      try {
        const agents = await discoverAgents(subagentCwd, projectTrusted)

        result = await runSingleAgent({
          agents,
          agentName: params.agent,
          task: params.task,
          cwd: subagentCwd,
          projectTrusted,
          signal,
          onUpdate: trackedUpdate,
          // Inherit the parent session's active model + thinking level so a
          // subagent without a pinned model behaves like the current session.
          parentModel: ctx.model,
          parentThinkingLevel: ctx.thinkingLevel,
        })
      } catch (error) {
        // Runs that throw (discovery failures, preflight errors, aborts)
        // still belong in the modal. A run cancelled via the parent signal
        // is classified as aborted rather than a plain failure, so
        // finishTask records the right status for the /subagents modal.
        const failed = emptyResult({
          agent: params.agent,
          task: params.task,
          cwd: subagentCwd,
          exitCode: 1,
          stopReason: signal?.aborted ? 'aborted' : undefined,
          errorMessage: error instanceof Error ? error.message : String(error),
          stderr: error instanceof Error ? error.message : String(error),
        })
        finishTask(toolCallId, failed)
        recordTask(pi, toolCallId)
        throw error
      }
      finishTask(toolCallId, result)
      recordTask(pi, toolCallId)

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

  pi.registerTool({
    name: 'list_agents',
    label: 'List Agents',
    description:
      'List all available agents (builtin, user, and project levels) with their name, description, source, model, and allowed tools.',
    parameters: ListAgentsParams,

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      // Only the current working directory is listed, mirroring exactly what
      // the subagent tool would load for this session.
      const cwd = path.resolve(ctx.cwd)
      const projectTrusted = ctx.isProjectTrusted()
      const agents = await discoverAgents(cwd, projectTrusted)

      const lines = agents.map((agent) => {
        const meta: string[] = [`source: ${agent.source}`]
        if (agent.model) meta.push(`model: ${agent.model}`)
        if (agent.tools) meta.push(`tools: ${agent.tools.join(', ')}`)
        return `- ${agent.name}: ${agent.description.replace(/\s+/g, ' ').trim()} (${meta.join(', ')})`
      })

      // A listing that silently misses a project's agents is misleading, so
      // call out when they exist but were skipped for trust.
      const projectAgentsDir = findNearestProjectAgentsDir(cwd)
      if (!projectTrusted && projectAgentsDir) {
        lines.push(
          `(project agents in ${projectAgentsDir} omitted: directory not trusted)`,
        )
      }

      return {
        content: [
          {
            type: 'text',
            text: lines.length > 0 ? lines.join('\n') : 'No agents found.',
          },
        ],
        // Keep systemPrompt/filePath out of the persisted transcript details.
        details: agents.map(({ name, description, source, model, tools }) => ({
          name,
          description,
          source,
          model,
          tools,
        })),
      }
    },
  })

  // Modals need an interactive terminal; other modes just notify.
  pi.registerCommand('subagents', {
    description:
      'Open a modal listing every subagent task (including running ones) with its full transcript',
    handler: async (_args, ctx) => {
      if (ctx.mode !== 'tui' || !ctx.hasUI) {
        ctx.ui.notify('The /subagents modal requires TUI mode')
        return
      }
      // Rebuild from persisted history so /subagents works after resuming
      // (or when the modal is opened before session_start has fired).
      restoreTasks(
        ctx.sessionManager.getEntries(),
        ctx.sessionManager.getSessionFile() ?? undefined,
      )
      const tasks = getTasks()
      if (tasks.length === 0) {
        ctx.ui.notify('No subagent tasks yet')
        return
      }
      void ctx.ui.custom<null>(createSubagentsModal(tasks), {
        overlay: true,
        overlayOptions: () => ({
          width: '90%',
          maxHeight: '90%',
          anchor: 'center',
        }),
      })
    },
  })
}
