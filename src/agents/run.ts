/**
 * Runs a subagent in-process via the pi SDK (`createAgentSession`) instead
 * of spawning a separate `pi` process.
 *
 * Each invocation gets its own `AgentSession` with an isolated context window
 * (in-memory — nothing written to disk), its own agent-specific system
 * prompt, and the agent's tool allowlist. The session is backed by a full
 * `DefaultResourceLoader`, so the subagent sees exactly the environment a
 * spawned `pi` process would: extensions, skills, prompt templates, themes,
 * AGENTS.md context files, and APPEND_SYSTEM.md. Events (messages, usage,
 * tool calls) stream back to the parent session as a `SubAgentResult` for the
 * TUI to render.
 *
 * Trade-offs vs. spawning a `pi` process:
 * - Faster startup: no process spawn or CLI bootstrap; a single shared
 *   `ModelRuntime` is reused across calls and reads the same credentials
 *   (auth.json / models.json) as the parent.
 * - Typed `AgentSession` events instead of parsing JSON lines from stdout;
 *   cancellation is a clean `session.abort()` instead of SIGTERM/SIGKILL.
 * - No temp files for the system prompt.
 * - The subagent runs in the parent process: it shares the parent's runtime,
 *   so a fatal subagent bug is not process-isolated the way a child process
 *   would be.
 */

import type { AssistantMessage, Message, Model } from '@earendil-works/pi-ai'
import type { ThinkingLevel } from '@earendil-works/pi-agent-core'
import {
  AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
} from '@earendil-works/pi-coding-agent'
import { emptyResult, getFinalOutput } from './result.ts'
import { createBashWithDefaultTimeout } from './toolTimeout.ts'
import type { AgentConfig, OnUpdateCallback, SubAgentResult } from './types.ts'

/**
 * One shared ModelRuntime for all subagent runs. It reads the same
 * credentials as the parent session (~/.pi/agent/auth.json + models.json),
 * so subagents authenticate exactly like the interactive CLI. Created once
 * and reused; `refreshOnCreate` avoids a network catalog refresh on first
 * use (static + locally cached models remain available).
 */
let sharedRuntimePromise: Promise<ModelRuntime> | undefined

function getSharedModelRuntime(): Promise<ModelRuntime> {
  sharedRuntimePromise ??= ModelRuntime.create({
    refreshOnCreate: false,
  }).catch((error) => {
    // Don't cache a rejected promise: a transient failure (e.g. a malformed
    // auth.json) must not poison every later subagent call for the process
    // lifetime.
    sharedRuntimePromise = undefined
    throw error
  })
  return sharedRuntimePromise
}

/**
 * Mark a result as an aborted run.
 *
 * Returning the aborted result instead of throwing preserves the streamed
 * transcript the session produced up to the abort, and the `stopReason`
 * lets `finishTask` classify the task as `'aborted'` in the store (the
 * `/subagents` modal then shows the real status instead of a failure).
 */
function markAborted(result: SubAgentResult): SubAgentResult {
  result.stopReason = 'aborted'
  result.exitCode = 1
  result.errorMessage ||= 'Subagent was aborted'
  return result
}

/**
 * ResourceLoader for a subagent session.
 *
 * Wraps a `DefaultResourceLoader` so the subagent gets the full pi
 * environment (extensions, skills, prompt templates, themes, AGENTS.md
 * context files, APPEND_SYSTEM.md) with the agent's system prompt replacing
 * the base one; `buildSystemPrompt` still appends project context, skills,
 * and the cwd footer. The task is sent separately as the session's user
 * prompt.
 *
 * The parent's project-trust decision is threaded through: an untrusted
 * project's `.pi/extensions` (arbitrary code), packages, skills and prompt
 * templates must not be discovered and executed in-process. A directory the
 * parent has no decision about is treated as untrusted.
 */
function createSubagentResourceLoader(
  agent: AgentConfig,
  cwd: string,
  projectTrusted: boolean,
): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager: SettingsManager.create(cwd, getAgentDir(), {
      projectTrusted,
    }),
    systemPromptOverride: () => agent.systemPrompt,
  })
}

/** Accumulate per-turn usage/stats on the final assistant message only. */
function collectAssistantStats(
  result: SubAgentResult,
  msg: AssistantMessage,
): void {
  result.turns++
  const usage = msg.usage
  if (usage) {
    result.usage.input += usage.input || 0
    result.usage.output += usage.output || 0
    result.usage.cacheRead += usage.cacheRead || 0
    result.usage.cacheWrite += usage.cacheWrite || 0
    result.usage.totalTokens = usage.totalTokens || 0
    const cost = result.usage.cost
    cost.input += usage.cost?.input || 0
    cost.output += usage.cost?.output || 0
    cost.cacheRead += usage.cost?.cacheRead || 0
    cost.cacheWrite += usage.cost?.cacheWrite || 0
    cost.total += usage.cost?.total || 0
  }
  if (msg.stopReason) result.stopReason = msg.stopReason
  if (msg.errorMessage) result.errorMessage = msg.errorMessage
}

/**
 * Identity slot per streaming result: the assistant message object most
 * recently delivered, so `message_end` can tell a live continuation from
 * pi's synthetic failure pair (`handleRunFailure` emits `message_start` +
 * `message_end` with the same object on abort/error).
 */
const liveSlots = new WeakMap<SubAgentResult, { pending?: Message }>()

function liveSlot(result: SubAgentResult): { pending?: Message } {
  let slot = liveSlots.get(result)
  if (!slot) {
    slot = {}
    liveSlots.set(result, slot)
  }
  return slot
}

/** pi's synthetic failure message (handleRunFailure): an empty assistant turn. */
function isFailureMessage(msg: Message): boolean {
  if (msg.role !== 'assistant') return false
  if (msg.stopReason !== 'aborted' && msg.stopReason !== 'error') return false
  return msg.content.every(
    (part) =>
      (part.type === 'text' && !part.text) ||
      (part.type === 'thinking' && !part.thinking),
  )
}

/**
 * Apply one session event to the streaming result. Returns true when the
 * shared state changed and a parent update is worth emitting.
 *
 * Assistant messages stream through `message_start`/`message_update` as a
 * growing pending message (`stopReason: 'pending'`) held as the trailing
 * transcript entry and replaced by the authoritative message at
 * `message_end`. On abort/error, pi emits a synthetic empty failure turn
 * (same object for `message_start` and `message_end`) on top of whatever
 * streamed; a live partial is finalized in place — keeping the streamed
 * content and adopting the failure state — and a failure with nothing
 * streamed is dropped rather than duplicated. User and tool-result messages
 * only arrive whole at `message_end`; their `message_start` carries the
 * same final object and is skipped to avoid duplicates.
 */
export function applySessionEvent(
  result: SubAgentResult,
  event: AgentSessionEvent,
): boolean {
  if (event.type === 'message_start' || event.type === 'message_update') {
    const msg = event.message as Message
    if (msg.role !== 'assistant') return false
    const slot = liveSlot(result)
    const tail = result.messages[result.messages.length - 1]
    const tailPending =
      tail?.role === 'assistant' && tail.stopReason === 'pending'
    if (tailPending) {
      // Continuation of the streaming message, or the synthetic failure pair
      // layered on top of a live partial: keep the partial and finalize it
      // at message_end instead of replacing — a cancel must not discard what
      // already streamed.
      if (msg.stopReason === 'pending') {
        result.messages[result.messages.length - 1] = msg
        slot.pending = msg
        return true
      }
      slot.pending = msg
      return false
    }
    // Fresh message; synthetic failures carry no content worth rendering, so
    // skip them and let the paired message_end finalize without a duplicate.
    if (isFailureMessage(msg)) {
      slot.pending = msg
      return false
    }
    result.messages.push(msg)
    slot.pending = msg
    return true
  }
  if (event.type === 'message_end') {
    const msg = event.message as Message
    if (msg.role !== 'assistant') {
      const tail = result.messages[result.messages.length - 1]
      if (tail === msg) return false
      result.messages.push(msg)
      return true
    }
    const slot = liveSlot(result)
    const tail = result.messages[result.messages.length - 1]
    const tailPending =
      tail?.role === 'assistant' && tail.stopReason === 'pending'
    if (msg === slot.pending) {
      // Synthetic failure pair. Over a live partial, finalize it in place —
      // keep the streamed content, adopt the failure state — so the aborted
      // turn stays visible exactly once; without a partial there is nothing
      // to add (the failure surfaces in the run header).
      slot.pending = undefined
      if (tailPending) {
        const merged = {
          ...(tail as AssistantMessage),
          stopReason: msg.stopReason,
          errorMessage: msg.errorMessage,
        }
        result.messages[result.messages.length - 1] = merged
        collectAssistantStats(result, merged)
        return true
      }
      if (msg.stopReason) result.stopReason ??= msg.stopReason
      return false
    }
    slot.pending = undefined
    if (tailPending) {
      result.messages[result.messages.length - 1] = msg
    } else {
      result.messages.push(msg)
    }
    collectAssistantStats(result, msg)
    return true
  }
  return false
}

export interface RunSingleAgentOptions {
  agents: AgentConfig[]
  agentName: string
  task: string
  /** Working directory for the subagent session. */
  cwd: string
  /**
   * Whether the subagent's working directory is trusted: the parent's own
   * decision when running in the parent's directory, false otherwise.
   */
  projectTrusted: boolean
  signal?: AbortSignal
  onUpdate?: OnUpdateCallback
  /** Parent session's active model (inherited when the agent has none). */
  parentModel?: Model<any>
  /** Parent session's thinking level (inherited when the agent has none). */
  parentThinkingLevel?: ThinkingLevel
}

export async function runSingleAgent(
  options: RunSingleAgentOptions,
): Promise<SubAgentResult> {
  const {
    agents,
    agentName,
    task,
    cwd,
    projectTrusted,
    signal,
    onUpdate,
    parentModel,
    parentThinkingLevel,
  } = options
  const agent = agents.find((a) => a.name === agentName)

  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(', ') || 'none'
    return emptyResult({
      agent: agentName,
      task,
      exitCode: 1,
      stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
    })
  }

  const currentResult: SubAgentResult = emptyResult({
    agent: agentName,
    task,
    agentSource: agent.source,
    cwd,
  })

  const emitUpdate = () => {
    if (onUpdate) {
      onUpdate({
        content: [
          {
            type: 'text',
            text: getFinalOutput(currentResult.messages) || '(running...)',
          },
        ],
        details: currentResult,
      })
    }
  }

  // Delta updates are coalesced so a burst of stream events does not render
  // the transcript once per token; message boundaries flush immediately so
  // the transcript never sits in a stale partial state.
  let emitTimer: ReturnType<typeof setTimeout> | undefined
  let lastEmitAt = 0
  let runDone = false
  const MIN_EMIT_INTERVAL_MS = 50

  const emitNow = () => {
    lastEmitAt = Date.now()
    emitUpdate()
  }

  const scheduleEmit = (flush: boolean) => {
    if (runDone) return
    if (emitTimer) {
      clearTimeout(emitTimer)
      emitTimer = undefined
    }
    if (flush) {
      emitNow()
      return
    }
    const delay = MIN_EMIT_INTERVAL_MS - (Date.now() - lastEmitAt)
    if (delay <= 0) emitNow()
    else {
      emitTimer = setTimeout(() => {
        emitTimer = undefined
        if (!runDone) emitNow()
      }, delay)
    }
  }

  const stopEmitting = () => {
    runDone = true
    if (emitTimer) {
      clearTimeout(emitTimer)
      emitTimer = undefined
    }
  }

  const modelRuntime = await getSharedModelRuntime()

  // Resolve the model: agent-specified wins; otherwise inherit the parent
  // session's active model (and thinking level) so the subagent behaves
  // like the current session instead of the default.
  let model: Model<any> | undefined
  let thinkingLevel: ThinkingLevel | undefined
  if (agent.model) {
    const resolved = resolveCliModel({ cliModel: agent.model, modelRuntime })
    if (resolved.error || !resolved.model) {
      return emptyResult({
        agent: agentName,
        task,
        agentSource: agent.source,
        exitCode: 1,
        stderr:
          resolved.error ||
          `Unknown model: "${agent.model}" for agent "${agentName}".`,
      })
    }
    model = resolved.model
    thinkingLevel = resolved.thinkingLevel
  } else if (parentModel) {
    model = parentModel
    thinkingLevel = parentThinkingLevel
  }

  // Keep the resolved model on the result so the usage footer can render
  // provider/model from the start, before the first response streams.
  if (model) currentResult.model = model

  const resourceLoader = createSubagentResourceLoader(
    agent,
    cwd,
    projectTrusted,
  )
  // Full discovery (extensions, skills, prompts, packages, context files).
  await resourceLoader.reload()

  let session: AgentSession | undefined
  let removeAbortListener: (() => void) | undefined
  try {
    const created = await createAgentSession({
      cwd,
      agentDir: getAgentDir(),
      model,
      thinkingLevel,
      modelRuntime,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      // Allowlist from the agent file (e.g. "read, grep, find, ls"); when
      // omitted the default built-ins (read, bash, edit, write) are used.
      tools: agent.tools,
      // Custom tools override built-ins by name, so this replaces the bash
      // tool with one that injects a default timeout when the model gives
      // none. Only agents whose allowlist includes "bash" are affected.
      customTools: [createBashWithDefaultTimeout(cwd)],
    })
    session = created.session
    const runSession = session

    // Capture the exact system prompt the subagent runs with (context
    // files/skills/APPEND_SYSTEM.md appended) so the TUI can display it in
    // the result.
    currentResult.systemPrompt = session.systemPrompt

    // Stream subagent messages to the parent session so the tool result
    // transcript shows them as they are produced (token deltas included).
    runSession.subscribe((event) => {
      if (!applySessionEvent(currentResult, event)) return
      scheduleEmit(event.type === 'message_end')
    })
    // Show the transcript immediately, before the first model response.
    emitNow()

    // Cancel a running subagent cleanly when the parent tool call aborts.
    if (signal) {
      const abortRun = () => {
        void runSession.abort()
      }
      if (signal.aborted) abortRun()
      else {
        signal.addEventListener('abort', abortRun, { once: true })
        removeAbortListener = () =>
          signal.removeEventListener('abort', abortRun)
      }
    }

    if (signal?.aborted) return markAborted(currentResult)

    try {
      // The task is the session's user prompt — a fresh user message on top
      // of the static agent system prompt.
      // expandPromptTemplates: false keeps tasks that start with "/"
      // (e.g. absolute paths) literal instead of treating them as commands.
      await runSession.prompt(task, { expandPromptTemplates: false })
    } catch (error) {
      // Preflight failures (e.g. no API key for the resolved model) surface
      // as exceptions; the run itself reports errors via stopReason. When
      // the parent signal fired mid-run, prompt() itself is what threw, so
      // classify the result as aborted rather than a plain failure.
      currentResult.exitCode = 1
      currentResult.errorMessage =
        error instanceof Error ? error.message : String(error)
      currentResult.stderr = currentResult.errorMessage
      if (signal?.aborted) currentResult.stopReason = 'aborted'
      return currentResult
    }
  } finally {
    removeAbortListener?.()
    stopEmitting()
    session?.dispose()
  }

  currentResult.exitCode =
    currentResult.stopReason === 'error' ||
    currentResult.stopReason === 'aborted'
      ? 1
      : 0

  if (signal?.aborted) return markAborted(currentResult)
  return currentResult
}
