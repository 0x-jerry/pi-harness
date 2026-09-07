import { beforeAll, describe, expect, test, vi } from 'vitest'
import { initTheme } from '@earendil-works/pi-coding-agent'
import type { Component, TUI } from '@earendil-works/pi-tui'
import type { Message } from '@earendil-works/pi-ai'
import {
  firstLine,
  formatDuration,
  isStreamingMessage,
  renderFullResultContent,
  renderSubagentResult,
  splitTranscript,
  summarizeArgs,
} from '../../src/extensions/agents/render.ts'
import { createSubagentsModal } from '../../src/extensions/agents/modal.ts'
import { emptyUsage } from '../../src/extensions/agents/result.ts'
import type { SubagentTask } from '../../src/extensions/agents/store.ts'
import type { SubAgentResult } from '../../src/extensions/agents/types.ts'

beforeAll(() => {
  // The transcript renderer uses pi's global markdown theme.
  initTheme('dark')
})

/** Minimal theme stub: wraps colors/styles in markers for assertion. */
function stubTheme(): any {
  return {
    fg: (color: string, s: string) => `<${color}>${s}</>`,
    bold: (s: string) => `*${s}*`,
    italic: (s: string) => `/${s}/`,
  }
}

/** Render a component and return its text with padding stripped. */
function textOf(component: Component): string {
  return component
    .render(200)
    .map((line) => line.trimEnd())
    .join('\n')
}

const theme = stubTheme()

/** Minimal ToolRenderResultOptions for renderResult calls. */
const renderOptions = { expanded: false, isPartial: false }

function userMsg(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] } as Message
}

function assistantMsg(text: string, stopReason = 'stop'): Message {
  return {
    role: 'assistant',
    stopReason,
    content: [{ type: 'text', text }],
  } as Message
}

function thinkingPart(text: string) {
  return { type: 'thinking', thinking: text } as const
}

function textPart(text: string) {
  return { type: 'text', text } as const
}

function toolCallPart(id: string, name: string, args: object) {
  return { type: 'toolCall', id, name, arguments: args } as const
}

function toolCallMsg(
  id: string,
  name: string,
  args: object,
  timestamp = 1000,
): Message {
  return {
    role: 'assistant',
    stopReason: 'toolUse',
    timestamp,
    content: [toolCallPart(id, name, args)],
  } as Message
}

function toolResultMsg(
  id: string,
  opts: { isError?: boolean; text?: string; timestamp?: number } = {},
): Message {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'x',
    isError: opts.isError ?? false,
    timestamp: opts.timestamp ?? 5000,
    content: [{ type: 'text', text: opts.text ?? 'output' }],
  } as Message
}

function makeResult(
  messages: Message[],
  overrides: Partial<SubAgentResult> = {},
): SubAgentResult {
  return {
    agent: 'reviewer',
    agentSource: 'builtin',
    task: 'Review the diff',
    cwd: '/tmp',
    exitCode: 0,
    messages,
    stderr: '',
    usage: emptyUsage(),
    model: 'claude',
    ...overrides,
  }
}

/** Wrap a SubAgentResult in the AgentToolResult shape renderResult expects. */
function agentResult(result: SubAgentResult) {
  return { content: [], details: result }
}

type InputListener = (data: string) =>
  | { consume?: boolean; data?: string }
  | undefined

/** Stub TUI for the modal: record redraws, give a fixed terminal size. */
function stubTui() {
  const listeners: InputListener[] = []
  const tui = {
    requestRender: vi.fn(),
    terminal: { rows: 40, columns: 120 },
    addInputListener: (listener: InputListener) => {
      listeners.push(listener)
      return () => {
        const i = listeners.indexOf(listener)
        if (i !== -1) listeners.splice(i, 1)
      }
    },
  } as unknown as TUI & { __listeners: InputListener[] }
  tui.__listeners = listeners
  return tui
}

function makeTask(
  toolCallId: string,
  status: SubagentTask['status'],
  agent = 'reviewer',
  task = 'Review the diff',
): SubagentTask {
  return {
    toolCallId,
    agent,
    task,
    startedAt: Date.now() - 10_000,
    status,
    details: makeResult([], { agent, task }),
  }
}

describe('renderSubagentResult', () => {
  test('shows the card with the /subagents hint', () => {
    const out = textOf(
      renderSubagentResult(agentResult(makeResult([])), renderOptions, theme),
    )
    expect(out).toContain('reviewer')
    expect(out).toContain('run /subagents to browse agent tasks')
    expect(out).toContain('(no output)')
    expect(out).not.toContain('─── Transcript ───')
  })

  test('marks partial updates while the run is streaming', () => {
    const out = textOf(
      renderSubagentResult(
        agentResult(makeResult([])),
        { ...renderOptions, isPartial: true },
        theme,
      ),
    )
    expect(out).toContain('⏳')
  })

  test('windows long transcripts and reports skipped messages', () => {
    const messages: Message[] = []
    for (let i = 1; i <= 7; i++) {
      messages.push(userMsg(`m${i}u`))
      messages.push(assistantMsg(`m${i}a`))
    }
    const out = textOf(
      renderSubagentResult(agentResult(makeResult(messages)), renderOptions, theme),
    )
    expect(out).toContain('… 4 earlier messages')
    expect(out).toContain('m3u')
    expect(out).toContain('m7a')
    expect(out).not.toContain('m2a')
    expect(out).not.toContain('m1u')
  })

  test('shows error status for failed results', () => {
    const result = makeResult([], {
      exitCode: 1,
      stopReason: 'error',
      errorMessage: 'boom',
    })
    const out = textOf(
      renderSubagentResult(agentResult(result), renderOptions, theme),
    )
    expect(out).toContain('[error]')
    expect(out).toContain('Error: boom')
  })

  test('renders assistant text fully, without an icon', () => {
    const out = textOf(
      renderSubagentResult(
        agentResult(makeResult([assistantMsg('plain answer')])),
        renderOptions,
        theme,
      ),
    )
    expect(out).toContain('plain answer')
    expect(out).not.toContain('💭')
    expect(out).not.toContain('🔧')
  })
})

describe('reasoning rendering', () => {
  test('streams reasoning in full while it is being generated', () => {
    const streaming = {
      role: 'assistant',
      stopReason: 'pending',
      content: [thinkingPart('line one\nline two')],
    } as Message
    const out = textOf(
      renderSubagentResult(
        agentResult(makeResult([streaming])),
        { ...renderOptions, isPartial: true },
        theme,
      ),
    )
    expect(out).toContain('💭')
    expect(out).toContain('line one')
    expect(out).toContain('line two')
  })

  test('collapses completed reasoning to its first line', () => {
    const out = textOf(
      renderSubagentResult(
        agentResult(
          makeResult([
            {
              role: 'assistant',
              stopReason: 'stop',
              content: [thinkingPart('line one\nline two')],
            } as Message,
          ]),
        ),
        renderOptions,
        theme,
      ),
    )
    expect(out).toContain('💭')
    expect(out).toContain('line one')
    expect(out).not.toContain('line two')
  })

  test('collapses reasoning as soon as the answer starts streaming', () => {
    const midTurn = {
      role: 'assistant',
      stopReason: 'pending',
      content: [thinkingPart('reason line one\nreason line two'), textPart('the answer')],
    } as Message
    const out = textOf(
      renderSubagentResult(
        agentResult(makeResult([midTurn])),
        { ...renderOptions, isPartial: true },
        theme,
      ),
    )
    expect(out).toContain('reason line one')
    expect(out).not.toContain('reason line two')
    expect(out).toContain('the answer')
  })
})

describe('tool call rendering', () => {
  test('renders name, arguments, and execution time only', () => {
    const messages = [
      toolCallMsg('tc1', 'read', { path: '/tmp/x' }),
      toolResultMsg('tc1', { text: 'SECRET OUTPUT BODY' }),
    ]
    const out = textOf(
      renderSubagentResult(agentResult(makeResult(messages)), renderOptions, theme),
    )
    expect(out).toContain('🔧')
    expect(out).toContain('read')
    expect(out).toContain('path')
    expect(out).toContain('· 4.0s')
    expect(out).not.toContain('SECRET OUTPUT BODY')
  })

  test('shows an elapsed duration while the call is pending', () => {
    const out = textOf(
      renderSubagentResult(
        agentResult(makeResult([toolCallMsg('tc1', 'bash', {})])),
        { ...renderOptions, isPartial: true },
        theme,
      ),
    )
    expect(out).toContain('🔧')
    expect(out).toContain('bash')
    expect(out).toMatch(/· \d/)
  })

  test('tints failed tool calls and shows an error fragment', () => {
    const messages = [
      toolCallMsg('tc1', 'read', { path: '/tmp/x' }),
      toolResultMsg('tc1', { isError: true, text: 'boom: no such file' }),
    ]
    const out = textOf(
      renderSubagentResult(agentResult(makeResult(messages)), renderOptions, theme),
    )
    expect(out).toContain('✗ boom')
  })
})

describe('renderFullResultContent', () => {
  test('renders system prompt, windowed transcript, and usage', () => {
    const result = makeResult(
      [userMsg('hello world'), assistantMsg('hi back')],
      { systemPrompt: 'You are a reviewer.' },
    )
    const out = textOf(renderFullResultContent(result, theme))
    expect(out).toContain('─── System prompt ───')
    expect(out).toContain('You are a reviewer.')
    expect(out).toContain('─── Transcript ───')
    expect(out).toContain('hello world')
    expect(out).toContain('hi back')
  })

  test('windows the transcript to the last 10 messages', () => {
    const messages: Message[] = []
    for (let i = 1; i <= 6; i++) {
      messages.push(userMsg(`w${i}u`))
      messages.push(assistantMsg(`w${i}a`))
    }
    const out = textOf(renderFullResultContent(makeResult(messages), theme))
    expect(out).toContain('… 2 earlier messages')
    expect(out).toContain('w6a')
    expect(out).toContain('w2u')
    expect(out).not.toContain('w1u')
  })

  test('handles a running task with no output yet', () => {
    const result = makeResult([], { systemPrompt: undefined })
    const out = textOf(renderFullResultContent(result, theme))
    expect(out).toContain('─── Transcript ───')
    expect(out).toContain('(no output)')
  })
})

describe('transcript helpers', () => {
  test('firstLine returns the first non-empty line', () => {
    expect(firstLine('a\nb')).toBe('a')
    expect(firstLine('\n\nb')).toBe('b')
    expect(firstLine('x')).toBe('x')
  })

  test('formatDuration is human-readable and clamped', () => {
    expect(formatDuration(4000)).toBe('4.0s')
    expect(formatDuration(-500)).toBe('0.0s')
    expect(formatDuration(125_000)).toBe('2m5s')
  })

  test('isStreamingMessage only matches pending assistant messages', () => {
    expect(isStreamingMessage(assistantMsg('x', 'pending'))).toBe(true)
    expect(isStreamingMessage(assistantMsg('x', 'stop'))).toBe(false)
    expect(isStreamingMessage(userMsg('x'))).toBe(false)
  })

  test('summarizeArgs flattens and truncates arguments', () => {
    expect(summarizeArgs({ a: 1 })).toBe('{"a":1}')
    expect(summarizeArgs(undefined)).toBe('{}')
    const long = summarizeArgs({ a: 'x'.repeat(400) })
    expect(long.endsWith('…')).toBe(true)
    expect(long.length).toBeLessThan(170)
  })

  test('splitTranscript windows display messages and folds tool results', () => {
    const messages: Message[] = [
      userMsg('u1'),
      assistantMsg('a1'),
      toolResultMsg('tc1'),
    ]
    const { skipped, items } = splitTranscript(messages)
    expect(skipped).toBe(0)
    expect(items.map((item) => item.message.role)).toEqual(['user', 'assistant'])

    const many = [
      userMsg('u1'),
      assistantMsg('a1'),
      userMsg('u2'),
      assistantMsg('a2'),
      userMsg('u3'),
      assistantMsg('a3'),
      userMsg('u4'),
      assistantMsg('a4'),
      userMsg('u5'),
      assistantMsg('a5'),
      userMsg('u6'),
      assistantMsg('a6'),
      userMsg('u7'),
      assistantMsg('a7'),
    ]
    const tail = splitTranscript(many)
    expect(tail.skipped).toBe(4)
    expect(tail.items).toHaveLength(10)
    expect(tail.items[0]?.message.role).toBe('user')
    expect((tail.items[0]?.message as { content: { text: string }[] }).content[0]?.text).toBe('u3')
  })
})

describe('createSubagentsModal', () => {
  test('picker lists running, done, and failed tasks', () => {
    const tasks = [
      makeTask('tc-running', 'running'),
      makeTask('tc-done', 'done'),
      makeTask('tc-error', 'error', 'coder', 'Bump the version'),
    ]
    const comp = createSubagentsModal(tasks)(
      stubTui(),
      theme,
      undefined as any,
      () => {},
    ) as Component & { dispose?(): void }
    const lines = comp.render(100)
    const text = lines.join('\n')
    expect(text).toContain('Subagent tasks (3)')
    expect(text).toContain('⏳')
    expect(text).toContain('✓')
    expect(text).toContain('✗')
    expect(text).toContain('running')
    comp.dispose?.()
  })

  test('enter opens the transcript view, esc goes back, esc closes', () => {
    const tasks = [
      makeTask('tc-running', 'running', 'reviewer', 'Review the diff'),
      makeTask('tc-done', 'done', 'coder', 'Bump the version'),
    ]
    const done = vi.fn()
    const comp = createSubagentsModal(tasks)(
      stubTui(),
      theme,
      undefined as any,
      done,
    ) as Component & { dispose?(): void }

    // Picker -> enter selects the first (running) task.
    comp.handleInput?.('\r')
    const pickerLines = (comp as any).render(100).join('\n')
    expect(pickerLines).toContain('─── Transcript ───')

    // Esc returns to the picker.
    comp.handleInput?.('\x1b')
    const backLines = (comp as any).render(100).join('\n')
    expect(backLines).toContain('Subagent tasks (2)')

    // Esc on the picker closes the modal.
    comp.handleInput?.('\x1b')
    expect(done).toHaveBeenCalledWith(null)
    comp.dispose?.()
  })

  test('failed task transcript shows its error', () => {
    const tasks = [
      makeTask('tc-error', 'error', 'coder', 'Bump the version'),
    ]
    tasks[0]!.details = makeResult([], {
      agent: 'coder',
      exitCode: 1,
      stopReason: 'error',
      errorMessage: 'boom',
    })
    const comp = createSubagentsModal(tasks)(
      stubTui(),
      theme,
      undefined as any,
      () => {},
    ) as Component & { dispose?(): void }
    comp.handleInput?.('\r')
    const text = (comp as any).render(100).join('\n')
    expect(text).toContain('[error]')
    expect(text).toContain('Error: boom')
    comp.dispose?.()
  })

  test('diverts input back to the modal when focus was stolen', () => {
    const tasks = [
      makeTask('tc-running', 'running', 'reviewer', 'Review the diff'),
      makeTask('tc-done', 'done', 'coder', 'Bump the version'),
    ]
    const tui = stubTui()
    const comp = createSubagentsModal(tasks)(
      tui,
      theme,
      undefined as any,
      () => {},
    ) as Component & { dispose?(): void; focused: boolean }

    // Simulate pi-tui after a background UI (the ask dialog) stole focus:
    // the modal no longer owns keyboard input.
    comp.focused = false

    const listener = tui.__listeners[0]!
    const before = (comp as any).render(100).join('\n')
    const result = listener('\x1b[B') // Key.down
    const after = (comp as any).render(100).join('\n')

    // The key was consumed so the hidden dialog never sees it…
    expect(result).toEqual({ consume: true })
    // …and the visible modal actually moved its selection.
    expect(after).not.toBe(before)
    comp.dispose?.()
  })

  test('does not intercept input while the modal is focused', () => {
    const tasks = [makeTask('tc-done', 'done')]
    const tui = stubTui()
    const comp = createSubagentsModal(tasks)(
      tui,
      theme,
      undefined as any,
      () => {},
    ) as Component & { dispose?(): void; focused: boolean }

    comp.focused = true
    const listener = tui.__listeners[0]!
    const before = (comp as any).render(100).join('\n')
    expect(listener('\x1b[B')).toBeUndefined()
    expect((comp as any).render(100).join('\n')).toBe(before)
    comp.dispose?.()
  })

  test('stops intercepting after dispose and unregisters the listener', () => {
    const tasks = [makeTask('tc-done', 'done')]
    const tui = stubTui()
    const comp = createSubagentsModal(tasks)(
      tui,
      theme,
      undefined as any,
      () => {},
    ) as Component & { dispose?(): void; focused: boolean }

    comp.focused = false
    const listener = tui.__listeners[0]!
    comp.dispose?.()

    expect(listener('\x1b[B')).toBeUndefined()
    expect(tui.__listeners).toHaveLength(0)
  })
})