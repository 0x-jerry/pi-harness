/**
 * Tool Gate - copilot mode.
 *
 * A dedicated model reviews a rule-matched tool call and returns a verdict:
 * pass (allow), reject (block), or ask (escalate to a human). The review is a
 * single in-process `AgentSession` with no tools and a hermetic resource
 * loader (no extensions, skills, prompts, themes, or context files), so it
 * has no side effects beyond the model call.
 *
 * Pure helpers (parseVerdict, redactAndTruncate, buildReviewPrompt,
 * buildSessionContext) are unit-tested; the model call itself is a thin
 * wrapper around the same `createAgentSession` pattern the subagent
 * extension uses.
 */

import type { Message } from '@earendil-works/pi-ai'
import {
  AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent'
import { truncate, type ToolGateRule } from './rules.ts'

export interface CopilotVerdict {
  verdict: 'pass' | 'reject' | 'ask'
  reason: string
}

const GATE_SYSTEM_PROMPT = [
  'You are a tool-call safety reviewer for a coding assistant.',
  'You will be given a tool call the assistant wants to execute, plus brief conversation context.',
  'Decide whether executing it is safe and consistent with the user intent.',
  '',
  'Rules of judgement:',
  '- PASS only when the call is clearly safe and matches the user intent.',
  '- REJECT when it is destructive, irreversible, affects unexpected scope, exfiltrates secrets, or looks malicious.',
  '- ASK when you cannot decide confidently.',
  '',
  'Respond with ONLY a single JSON object, no markdown, no commentary:',
  '{"verdict": "pass" | "reject" | "ask", "reason": "one short sentence"}',
].join('\n')

/** Keys whose values are redacted before anything reaches the model. */
const SENSITIVE_KEY = /(api[_-]?key|token|password|passwd|secret|credential|private[_-]?key|auth|authorization|cookie|session[_-]?id)/i

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Extract the plain text of an agent message (string or text parts). */
export function extractMessageText(message: {
  role?: string
  content?: unknown
}): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part !== null &&
        typeof part === 'object' &&
        'text' in part &&
        typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .filter(Boolean)
      .join(' ')
      .trim()
  }
  return ''
}

/**
 * Parse the reviewer's response into a verdict. Accepts a JSON object
 * {"verdict": ...}, or plain "PASS: reason" style lines. Anything else is
 * treated as "ask" so the gate escalates rather than guessing.
 */
export function parseVerdict(text: string): CopilotVerdict {
  const cleaned = text.trim()
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as unknown
      if (parsed !== null && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>
        const verdict = String(record.verdict ?? '').toLowerCase()
        if (verdict === 'pass' || verdict === 'reject' || verdict === 'ask') {
          return {
            verdict,
            reason: typeof record.reason === 'string' ? record.reason : '',
          }
        }
      }
    } catch {
      // fall through to line parsing
    }
  }
  for (const line of cleaned.split('\n')) {
    const match = line.match(/^\s*(PASS|REJECT|ASK)\b[\s:.,\-–—]*\s*(.*)$/i)
    if (match) {
      return {
        verdict: (match[1] ?? '').toLowerCase() as 'pass' | 'reject' | 'ask',
        reason: (match[2] ?? '').trim(),
      }
    }
  }
  return { verdict: 'ask', reason: 'Unparseable copilot response' }
}

/**
 * Serialize tool input for the model: redact sensitive values by key name
 * and truncate to keep the review cheap.
 */
export function redactAndTruncate(value: unknown, maxLen = 1200): string {
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') {
      if (key && SENSITIVE_KEY.test(key)) return '[redacted]'
      return v
    }
    if (Array.isArray(v)) return v.map((item) => walk(item))
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(val, k)
      }
      return out
    }
    return v
  }
  return truncate(JSON.stringify(walk(value)), maxLen)
}

export interface ReviewPromptInput {
  toolName: string
  input: Record<string, unknown>
  rule: ToolGateRule
  context?: string
}

export function buildReviewPrompt(input: ReviewPromptInput): string {
  const lines = [
    `Tool call: ${input.toolName}(${redactAndTruncate(input.input)})`,
    '',
    `Rule triggered: ${input.rule.description} (id: ${input.rule.id})`,
  ]
  if (input.context) {
    lines.push('', `Recent conversation (abbreviated):\n${truncate(input.context, 2000)}`)
  }
  lines.push(
    '',
    'Verdict: reply with a single JSON object: {"verdict": "pass"|"reject"|"ask", "reason": "one short sentence"}.',
  )
  return lines.join('\n')
}

/**
 * Build a short, newest-first excerpt of user/assistant messages for the
 * reviewer to judge intent. Tool results and custom entries are skipped.
 */
export function buildSessionContext(
  entries: readonly SessionEntry[],
  maxEntries = 5,
  maxChars = 2000,
): string {
  const parts: string[] = []
  for (const entry of [...entries].reverse()) {
    if (entry.type !== 'message') continue
    const role = entry.message.role
    if (role !== 'user' && role !== 'assistant') continue
    const text = extractMessageText(entry.message)
    if (!text) continue
    parts.push(`${role}: ${truncate(text, 300)}`)
    if (parts.length >= maxEntries) break
  }
  return truncate(parts.reverse().join('\n'), maxChars)
}

export interface ReviewWithCopilotOptions {
  cwd: string
  /** Provider/model id, e.g. "anthropic/claude-3-5-haiku". */
  model: string
  toolName: string
  input: Record<string, unknown>
  rule: ToolGateRule
  context?: string
  signal?: AbortSignal
  timeoutMs?: number
}

/**
 * One shared ModelRuntime for copilot reviews, mirroring the subagent
 * extension: reads the same credentials as the parent session.
 */
let sharedRuntimePromise: Promise<ModelRuntime> | undefined

function getSharedModelRuntime(): Promise<ModelRuntime> {
  sharedRuntimePromise ??= ModelRuntime.create({
    refreshOnCreate: false,
  }).catch((error) => {
    sharedRuntimePromise = undefined // don't cache a rejected promise
    throw error
  })
  return sharedRuntimePromise
}

/**
 * Review a tool call with the configured model. Never throws: every failure
 * (runtime, model resolution, model error, timeout, abort) becomes an
 * "ask" verdict so the caller escalates to a human / headless policy.
 */
export async function reviewWithCopilot(
  options: ReviewWithCopilotOptions,
): Promise<CopilotVerdict> {
  const { cwd, model: modelId, toolName, input, rule, context, signal } = options
  const timeoutMs = options.timeoutMs ?? 30_000
  const agentDir = getAgentDir()

  let modelRuntime: ModelRuntime
  try {
    modelRuntime = await getSharedModelRuntime()
  } catch (error) {
    return { verdict: 'ask', reason: `copilot runtime unavailable: ${errorMessage(error)}` }
  }

  const resolved = resolveCliModel({ cliModel: modelId, modelRuntime })
  if (resolved.error || !resolved.model) {
    return {
      verdict: 'ask',
      reason: resolved.error || `Unknown copilot model: ${modelId}`,
    }
  }

  // Hermetic loader: the reviewer needs only its system prompt, nothing from
  // the project (extensions/skills would be side effects on every tool call).
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => GATE_SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [],
  })
  await loader.reload()

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) controller.abort()

  let session: AgentSession | undefined
  let output = ''
  try {
    const created = await createAgentSession({
      cwd,
      agentDir,
      model: resolved.model,
      thinkingLevel: resolved.thinkingLevel ?? 'low',
      modelRuntime,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      tools: [], // the reviewer emits a verdict, never calls tools
    })
    session = created.session

    const abortSession = () => void session?.abort()
    controller.signal.addEventListener('abort', abortSession, { once: true })

    session.subscribe((event) => {
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        const text = extractMessageText(event.message as Message)
        if (text) output = text
      }
    })

    await session.prompt(
      buildReviewPrompt({ toolName, input, rule, context }),
      { expandPromptTemplates: false },
    )
  } catch (error) {
    if (controller.signal.aborted) {
      return {
        verdict: 'ask',
        reason: signal?.aborted
          ? 'copilot review aborted'
          : `copilot review timed out after ${Math.round(timeoutMs / 1000)}s`,
      }
    }
    return { verdict: 'ask', reason: `copilot review failed: ${errorMessage(error)}` }
  } finally {
    clearTimeout(timeoutId)
    signal?.removeEventListener('abort', onAbort)
    session?.dispose()
  }

  return parseVerdict(output)
}
