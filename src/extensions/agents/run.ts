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

import type { Message, Model } from '@earendil-works/pi-ai'
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
} from '@earendil-works/pi-coding-agent'
import { emptyResult, getFinalOutput } from './result.ts'
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
    model: agent.model,
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
        model: agent.model,
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
    })
    session = created.session
    const runSession = session

    // Capture the exact system prompt the subagent runs with (context
    // files/skills/APPEND_SYSTEM.md appended) so the TUI can display it in
    // the result.
    currentResult.systemPrompt = session.systemPrompt

    // Forward subagent messages to the parent session so they show up in
    // the tool result transcript.
    runSession.subscribe((event) => {
      if (event.type !== 'message_end' || !event.message) return
      // AgentMessage can include custom (non-LLM) message types; the
      // SubAgentResult surface only carries standard LLM messages.
      const msg = event.message as Message
      currentResult.messages.push(msg)

      if (msg.role === 'assistant') {
        currentResult.usage.turns++
        const usage = msg.usage
        if (usage) {
          currentResult.usage.input += usage.input || 0
          currentResult.usage.output += usage.output || 0
          currentResult.usage.cacheRead += usage.cacheRead || 0
          currentResult.usage.cacheWrite += usage.cacheWrite || 0
          currentResult.usage.cost += usage.cost?.total || 0
          currentResult.usage.contextTokens = usage.totalTokens || 0
        }
        if (!currentResult.model && msg.model) currentResult.model = msg.model
        if (msg.stopReason) currentResult.stopReason = msg.stopReason
        if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage
      }
      emitUpdate()
    })

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
