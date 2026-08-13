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
  emptyResult,
  getFinalOutput,
  getResultOutput,
  isFailedResult,
} from './result.ts'
import { createSubagentsModal } from './modal.ts'
import { renderSubagentCall, renderSubagentResult } from './render.ts'
import { runSingleAgent } from './run.ts'
import { SubagentParams } from './schema.ts'
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
    description: [
      'Delegate a task to a specialized subagent with an isolated context window.',
      'The subagent runs in-process via the pi SDK with its own system prompt, tool allowlist, and the full environment (extensions, skills, prompt templates, AGENTS.md context).',
      `Agents are discovered from all levels: builtin agents shipped with this package, user agents in ${path.join(getAgentDir(), 'agents')}, and project agents in ${CONFIG_DIR_NAME}/agents.`,
    ].join(' '),
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
