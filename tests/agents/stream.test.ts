import { describe, expect, test } from 'vitest'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { Message } from '@earendil-works/pi-ai'
import { applySessionEvent } from '../../src/extensions/agents/run.ts'
import { emptyResult } from '../../src/extensions/agents/result.ts'
import type { SubAgentResult } from '../../src/extensions/agents/types.ts'

function result(): SubAgentResult {
  return emptyResult({ agent: 'reviewer', task: 't' })
}

function usage(input = 10, output = 5) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
  }
}

function assistant(
  text: string,
  opts: Partial<{
    stopReason: string
    errorMessage: string
    usage: ReturnType<typeof usage>
  }> = {},
): Message {
  return {
    role: 'assistant',
    stopReason: opts.stopReason ?? 'stop',
    errorMessage: opts.errorMessage,
    usage: opts.usage,
    content: [{ type: 'text', text }],
  } as Message
}

function toolCallMessage(): Message {
  return {
    role: 'assistant',
    stopReason: 'toolUse',
    content: [
      { type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: 'x' } },
    ],
  } as unknown as Message
}

function stopReasonOf(message: Message | undefined): string | undefined {
  return message?.role === 'assistant' ? message.stopReason : undefined
}

function event(type: string, message: Message): AgentSessionEvent {
  return { type, message } as unknown as AgentSessionEvent
}

describe('applySessionEvent', () => {
  test('streams assistant messages through start/update/end', () => {
    const r = result()
    expect(
      applySessionEvent(
        r,
        event('message_start', assistant('', { stopReason: 'pending' })),
      ),
    ).toBe(true)
    expect(r.messages).toHaveLength(1)
    expect(stopReasonOf(r.messages[0])).toBe('pending')

    expect(
      applySessionEvent(
        r,
        event('message_update', assistant('hello', { stopReason: 'pending' })),
      ),
    ).toBe(true)
    expect(r.messages).toHaveLength(1)
    const streaming = r.messages[0] as any
    expect(streaming.content[0].text).toBe('hello')

    expect(
      applySessionEvent(
        r,
        event(
          'message_end',
          assistant('hello world', { stopReason: 'stop', usage: usage() }),
        ),
      ),
    ).toBe(true)
    expect(r.messages).toHaveLength(1)
    expect(stopReasonOf(r.messages[0])).toBe('stop')
    expect(r.turns).toBe(1)
    expect(r.usage.input).toBe(10)
    expect(r.usage.output).toBe(5)
    expect(r.usage.cost.total).toBeCloseTo(0.001)
  })

  test('orders user, assistant, and tool-result messages and counts one turn', () => {
    const r = result()
    const task = { role: 'user', content: [{ type: 'text', text: 'review' }] } as Message
    applySessionEvent(r, event('message_end', task))

    applySessionEvent(
      r,
      event('message_start', assistant('', { stopReason: 'pending' })),
    )
    applySessionEvent(r, event('message_end', toolCallMessage()))
    expect(r.turns).toBe(1)

    const toolResult = {
      role: 'toolResult',
      toolCallId: 'tc1',
      toolName: 'read',
      isError: false,
      content: [{ type: 'text', text: 'ok' }],
    } as Message
    // Tool results arrive whole at message_end; their message_start carries
    // the same final object and is skipped to avoid duplicates.
    expect(applySessionEvent(r, event('message_start', toolResult))).toBe(false)
    expect(r.messages).toHaveLength(2)
    applySessionEvent(r, event('message_end', toolResult))

    expect(r.messages).toHaveLength(3)
    expect(r.messages[0]?.role).toBe('user')
    expect(r.messages[1]?.role).toBe('assistant')
    expect(r.messages[2]?.role).toBe('toolResult')
    expect(r.messages.some((m) => m.role === 'toolResult')).toBe(true)
  })

  test('finalizes an aborted stream and records the error', () => {
    const r = result()
    applySessionEvent(
      r,
      event('message_start', assistant('', { stopReason: 'pending' })),
    )
    const aborted = assistant('partial', {
      stopReason: 'aborted',
      errorMessage: 'upstream died',
    })
    applySessionEvent(r, event('message_end', aborted))

    expect(r.messages).toHaveLength(1)
    expect(stopReasonOf(r.messages[0])).toBe('aborted')
    expect(r.stopReason).toBe('aborted')
    expect(r.errorMessage).toBe('upstream died')
    expect(r.turns).toBe(1)
  })

  test('collapses pi\'s synthetic failure pair over a live partial', () => {
    const r = result()
    applySessionEvent(
      r,
      event('message_start', assistant('half an answer', { stopReason: 'pending' })),
    )

    // pi-agent-core's handleRunFailure emits message_start + message_end
    // with the same empty failure message on abort.
    const failure = assistant('', { stopReason: 'aborted', errorMessage: 'cancelled' })
    applySessionEvent(r, event('message_start', failure))
    applySessionEvent(r, event('message_end', failure))

    expect(r.messages).toHaveLength(1)
    const tail = r.messages[0] as any
    expect(tail.content[0].text).toBe('half an answer')
    expect(tail.stopReason).toBe('aborted')
    expect(tail.errorMessage).toBe('cancelled')
    expect(r.stopReason).toBe('aborted')
    expect(r.turns).toBe(1)
  })

  test('ignores a synthetic failure with no preceding partial', () => {
    const r = result()
    const failure = assistant('', { stopReason: 'error', errorMessage: 'boom' })
    applySessionEvent(r, event('message_start', failure))
    applySessionEvent(r, event('message_end', failure))

    expect(r.messages).toHaveLength(0)
    expect(r.stopReason).toBe('error')
    expect(r.turns).toBe(0)
  })

  test('accumulates usage once per turn', () => {
    const r = result()
    for (const text of ['first', 'second']) {
      applySessionEvent(
        r,
        event('message_start', assistant('', { stopReason: 'pending' })),
      )
      applySessionEvent(
        r,
        event(
          'message_end',
          assistant(text, { stopReason: 'stop', usage: usage(10, 5) }),
        ),
      )
    }
    expect(r.messages).toHaveLength(2)
    expect(stopReasonOf(r.messages[0])).toBe('stop')
    expect(stopReasonOf(r.messages[1])).toBe('stop')
    expect(r.turns).toBe(2)
    expect(r.usage.input).toBe(20)
    expect(r.usage.output).toBe(10)
  })

  test('ignores unrelated session events', () => {
    const r = result()
    expect(applySessionEvent(r, { type: 'turn_start' } as any)).toBe(false)
    expect(
      applySessionEvent(r, {
        type: 'tool_execution_start',
        toolCallId: 'x',
        toolName: 'bash',
        args: {},
      } as any),
    ).toBe(false)
    expect(r.messages).toHaveLength(0)
  })
})