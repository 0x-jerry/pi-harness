/**
 * Tracks every subagent task in the process.
 *
 * A task enters the store the moment `execute()` starts (status "running",
 * with the partial/streamed result as `details`), receives updates on every
 * `onUpdate` callback, and is finalized when the run completes (status
 * "done" / "error" / "aborted" — including runs that threw).
 *
 * The `/subagents` command reads this store to render a picker of all tasks,
 * so in-progress subagents are visible alongside finished ones.
 *
 * Persistence across session reloads: `execute()` appends a compact
 * `TASK_ENTRY_TYPE` custom entry (see `taskRecord`) for each finished task,
 * and `restoreTasks` rebuilds the in-memory store from those entries plus
 * the tool-result messages the subagent tool left in the conversation, so
 * `/subagents` keeps working after a session is resumed.
 */

import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { emptyResult } from './result.ts'
import type { SubAgentResult } from './types.ts'

export type SubagentTaskStatus = 'running' | 'done' | 'error' | 'aborted'

export interface SubagentTask {
  toolCallId: string
  agent: string
  task: string
  cwd?: string
  startedAt: number
  status: SubagentTaskStatus
  /** Latest state: streaming partial while running, final result when done. */
  details: SubAgentResult
}

/**
 * Compact serializable record appended as a custom session entry for every
 * finished task (`pi.appendEntry(TASK_ENTRY_TYPE, ...)`). The full transcript
 * lives in the tool-result message's `details`; this record only pins down
 * the final status - which the harness drops from `details` when
 * `execute()` throws - plus the metadata needed to rebuild a picker entry
 * when the transcript is unavailable (older sessions, compaction).
 */
export interface SubagentTaskRecord {
  toolCallId: string
  agent: string
  agentSource: SubAgentResult['agentSource']
  task: string
  cwd?: string
  startedAt: number
  status: SubagentTaskStatus
}

/** Custom-entry type used to persist task status across session reloads. */
export const TASK_ENTRY_TYPE = 'subagent-task'

/** The tool name this extension registers (matches the conversation trace). */
const SUBAGENT_TOOL = 'subagent'

export function taskRecord(task: SubagentTask): SubagentTaskRecord {
  return {
    toolCallId: task.toolCallId,
    agent: task.agent,
    agentSource: task.details?.agentSource ?? 'unknown',
    task: task.task,
    cwd: task.cwd,
    startedAt: task.startedAt,
    status: task.status,
  }
}


/** Hard cap so long sessions can't grow the store unbounded. */
const MAX_TASKS = 50

const tasks = new Map<string, SubagentTask>()
const order: string[] = []

/** Session file the store was last restored from (cross-session guard). */
let restoredSessionFile: string | undefined

/** Clear all tracked tasks (tests, session switches). */
export function clearTasks(): void {
  tasks.clear()
  order.length = 0
}

/** Currently tracked task, if any. */
export function getTask(toolCallId: string): SubagentTask | undefined {
  return tasks.get(toolCallId)
}

/** Record a task when its execution starts. */
export function addTask(toolCallId: string, details: SubAgentResult): void {
  if (tasks.has(toolCallId)) return
  tasks.set(toolCallId, {
    toolCallId,
    agent: details.agent,
    task: details.task,
    cwd: details.cwd,
    startedAt: Date.now(),
    status: 'running',
    details,
  })
  order.push(toolCallId)
  if (order.length > MAX_TASKS) {
    const oldest = order.shift()
    if (oldest) tasks.delete(oldest)
  }
}

/** Refresh a task's state from a streamed partial result. */
export function updateTask(toolCallId: string, details: SubAgentResult): void {
  const task = tasks.get(toolCallId)
  if (!task) return
  task.agent = details.agent
  task.task = details.task
  task.cwd ||= details.cwd
  task.details = details
}

/** Mark a task finished with its final result (before failure throws). */
export function finishTask(toolCallId: string, details: SubAgentResult): void {
  updateTask(toolCallId, details)
  const task = tasks.get(toolCallId)
  if (!task) return
  if (details.stopReason === 'aborted') task.status = 'aborted'
  else if (details.exitCode !== 0 || details.stopReason === 'error') {
    task.status = 'error'
  } else {
    task.status = 'done'
  }
}

/** All tracked tasks, oldest first. */
export function getTasks(): SubagentTask[] {
  return order
    .map((id) => tasks.get(id))
    .filter((t): t is SubagentTask => t != null)
}

/** True when a persisted tool result carries this extension's details. */
function isSubagentResult(details: unknown): details is SubAgentResult {
  if (details == null || typeof details !== 'object') return false
  const d = details as { agent?: unknown; task?: unknown }
  return typeof d.agent === 'string' && typeof d.task === 'string'
}

/**
 * Rebuild tracked tasks from the session's persisted history so `/subagents`
 * keeps working when a session is resumed (or after new/fork/switch/reload).
 *
 * Sources, in order of precedence:
 * 1. `TASK_ENTRY_TYPE` custom entries - the authoritative final status,
 *    appended by `execute()` when a run finishes.
 * 2. The matching tool-result message, whose `details` carry the full
 *    `SubAgentResult` (transcript, usage, system prompt). When `execute()`
 *    threw, the harness keeps only the error text, which fills in the
 *    failure message.
 * 3. The assistant tool-call arguments (agent/task/cwd) for calls that
 *    never produced a result - restored as aborted (interrupted) runs.
 *
 * Idempotent: `addTask`/`finishTask` are keyed by toolCallId, tasks already
 * tracked (e.g. a run in flight in this process) are left untouched, and a
 * different session file clears the previous session's tasks first.
 */
export function restoreTasks(
  entries: Iterable<SessionEntry>,
  sessionFile?: string,
): void {
  if (sessionFile !== undefined && sessionFile !== restoredSessionFile) {
    tasks.clear()
    order.length = 0
    restoredSessionFile = sessionFile
  }

  const records = new Map<string, SubagentTaskRecord>()
  const detailsByCall = new Map<string, SubAgentResult>()
  const errorTextByCall = new Map<string, string>()
  const calls = new Map<
    string,
    { agent: string; task: string; cwd?: string }
  >()

  for (const entry of entries) {
    if (entry.type === 'custom') {
      if (entry.customType === TASK_ENTRY_TYPE) {
        const record = entry.data as SubagentTaskRecord | undefined
        if (
          record &&
          typeof record.toolCallId === 'string' &&
          typeof record.agent === 'string'
        ) {
          records.set(record.toolCallId, record)
        }
      }
      continue
    }
    if (entry.type !== 'message') continue
    const msg = entry.message
    if (msg.role === 'toolResult') {
      if (msg.toolName !== SUBAGENT_TOOL) continue
      if (isSubagentResult(msg.details)) {
        detailsByCall.set(msg.toolCallId, msg.details)
      } else if (msg.isError) {
        const text = msg.content
          .map((part) => (part.type === 'text' ? part.text : ''))
          .filter(Boolean)
          .join('\n')
        if (text) errorTextByCall.set(msg.toolCallId, text)
      }
    } else if (msg.role === 'assistant') {
      for (const content of msg.content) {
        if (content.type !== 'toolCall' || content.name !== SUBAGENT_TOOL) {
          continue
        }
        const args = content.arguments ?? {}
        calls.set(content.id, {
          agent:
            typeof args.agent === 'string' ? args.agent : '(unknown agent)',
          task:
            typeof args.task === 'string' ? args.task : '(unknown task)',
          cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
        })
      }
    }
  }

  // Rebuild tasks in the order their entries appear so `getTasks()` keeps a
  // chronological picker list. Tasks already tracked (running in this
  // process) and already-restored calls are skipped.
  const seen = new Set<string>()
  const maybeRestore = (callId: string) => {
    if (seen.has(callId) || tasks.has(callId)) return
    seen.add(callId)
    restoreOne(callId)
  }

  const restoreOne = (callId: string) => {
    const record = records.get(callId)
    const persisted = detailsByCall.get(callId)
    const error = errorTextByCall.get(callId)
    const call = calls.get(callId)

    const result: SubAgentResult =
      persisted ??
      emptyResult({
        agent: record?.agent ?? call?.agent ?? 'subagent',
        task: record?.task ?? call?.task ?? '(unknown task)',
        cwd: record?.cwd ?? call?.cwd,
      })

    if (record) {
      // The recorded status is authoritative: the harness drops `stopReason`
      // from persisted details when execute() throws.
      result.exitCode = record.status === 'done' ? 0 : 1
      result.stopReason =
        record.status === 'aborted'
          ? 'aborted'
          : record.status === 'error'
            ? 'error'
            : undefined
      if (!persisted && record.status !== 'done') {
        result.agentSource = record.agentSource
        result.errorMessage ??=
          error ??
          (record.status === 'aborted'
            ? 'Subagent was aborted'
            : 'Subagent failed')
        result.stderr ||= error ?? ''
      }
    } else if (error) {
      // Older failed run without a status record: the harness kept only the
      // error text on the tool result.
      result.exitCode = 1
      result.stopReason = 'error'
      result.errorMessage ??= error
      result.stderr ||= error
    } else if (persisted) {
      // Historical result: finishTask derives the status from its fields.
    } else {
      // Interrupted: the tool call never produced a result message.
      result.exitCode = 1
      result.stopReason = 'aborted'
      result.errorMessage ??= 'Subagent was interrupted before completing'
    }

    addTask(callId, result)
    finishTask(callId, result)
  }

  for (const entry of entries) {
    if (entry.type === 'custom') {
      if (entry.customType === TASK_ENTRY_TYPE) {
        const record = entry.data as SubagentTaskRecord | undefined
        if (record && typeof record.toolCallId === 'string') {
          maybeRestore(record.toolCallId)
        }
      }
    } else if (entry.type === 'message') {
      const msg = entry.message
      if (msg.role === 'toolResult') {
        if (msg.toolName === SUBAGENT_TOOL) maybeRestore(msg.toolCallId)
      } else if (msg.role === 'assistant') {
        for (const content of msg.content) {
          if (content.type === 'toolCall' && content.name === SUBAGENT_TOOL) {
            maybeRestore(content.id)
          }
        }
      }
    }
  }
}
