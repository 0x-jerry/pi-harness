import type { Message } from '@earendil-works/pi-ai'
import type { DisplayItem, SingleResult, UsageStats } from './types.ts'

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
  agent: string,
  task: string,
  overrides: Partial<SingleResult> = {},
): SingleResult {
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

export function isFailedResult(result: SingleResult): boolean {
  return (
    result.exitCode !== 0 ||
    result.stopReason === 'error' ||
    result.stopReason === 'aborted'
  )
}

/** Human-readable output of a result, preferring error diagnostics when it failed. */
export function getResultOutput(result: SingleResult): string {
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

/** Assistant text + tool-call parts, in order, for display. */
export function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = []
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      for (const part of msg.content) {
        if (typeof part !== 'object') continue
        if (part.type === 'text') items.push({ type: 'text', text: part.text })
        else if (part.type === 'toolCall')
          items.push({
            type: 'toolCall',
            name: part.name,
            args: part.arguments,
          })
      }
    }
  }
  return items
}
