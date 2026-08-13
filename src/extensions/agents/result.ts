import type { Message } from '@earendil-works/pi-ai'
import type { SubAgentResult, UsageStats } from './types.ts'

export function emptyUsage(): UsageStats {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  }
}

export function emptyResult(
  options: { agent: string; task: string } & Partial<SubAgentResult>,
): SubAgentResult {
  const { agent, task, ...overrides } = options
  return {
    agent,
    agentSource: 'unknown',
    task,
    exitCode: 0,
    messages: [],
    stderr: '',
    usage: emptyUsage(),
    ...overrides,
  }
}

/** Last assistant text message, or '' if none. */
export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.role === 'assistant') {
      for (const part of msg.content) {
        if (typeof part === 'object' && part.type === 'text') return part.text
      }
    }
  }
  return ''
}

export function isFailedResult(result: SubAgentResult): boolean {
  return (
    result.exitCode !== 0 ||
    result.stopReason === 'error' ||
    result.stopReason === 'aborted'
  )
}

/** Human-readable output of a result, preferring error diagnostics when it failed. */
export function getResultOutput(result: SubAgentResult): string {
  if (isFailedResult(result)) {
    return (
      result.errorMessage ||
      result.stderr ||
      getFinalOutput(result.messages) ||
      '(no output)'
    )
  }
  return getFinalOutput(result.messages) || '(no output)'
}
