import { beforeAll, describe, expect, test, vi } from 'vitest'
import { initTheme } from '@earendil-works/pi-coding-agent'
import type { Component, TUI } from '@earendil-works/pi-tui'
import type { Message } from '@earendil-works/pi-ai'
import {
  renderFullResultContent,
  renderSubagentResult,
} from '../../src/extensions/agents/render.ts'
import { createSubagentsModal } from '../../src/extensions/agents/modal.ts'
import { emptyUsage } from '../../src/extensions/agents/result.ts'
import type { SubagentTask } from '../../src/extensions/agents/store.ts'
import type { SubAgentResult } from '../../src/extensions/agents/types.ts'

beforeAll(() => {
  // The transcript renderer uses pi's global markdown theme.
  initTheme('dark')
})

/** Minimal theme stub: wraps colors in <color> markers for assertion. */
function stubTheme(): any {
  return {
    fg: (color: string, s: string) => `<${color}>${s}</>`,
    bold: (s: string) => `*${s}*`,
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
const renderOptionsExpanded = { expanded: true, isPartial: false }

function userMsg(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] } as Message
}

function assistantMsg(text: string): Message {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
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
  test('collapsed and expanded options produce identical output', () => {
    const result = makeResult([userMsg('m1'), assistantMsg('m2')])
    const collapsed = textOf(
      renderSubagentResult(agentResult(result), renderOptions, theme),
    )
    const expanded = textOf(
      renderSubagentResult(agentResult(result), renderOptionsExpanded, theme),
    )
    expect(expanded).toBe(collapsed)
  })

  test('shows the collapsed card with the /subagents hint', () => {
    const out = textOf(
      renderSubagentResult(agentResult(makeResult([])), renderOptions, theme),
    )
    expect(out).toContain('reviewer')
    expect(out).toContain('run /subagents for the full transcript')
    expect(out).toContain('(no output)')
    expect(out).not.toContain('─── Transcript ───')
  })

  test('tails long transcripts and reports skipped messages', () => {
    const messages = [
      userMsg('m1'),
      assistantMsg('m2'),
      userMsg('m3'),
      assistantMsg('m4'),
      userMsg('m5'),
      assistantMsg('m6'),
    ]
    const out = textOf(
      renderSubagentResult(agentResult(makeResult(messages)), renderOptions, theme),
    )
    expect(out).toContain('… 2 earlier messages')
    expect(out).toContain('m5')
    expect(out).toContain('m6')
    expect(out).not.toContain('m1')
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
})

describe('renderFullResultContent', () => {
  test('renders system prompt, full transcript, and usage', () => {
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

  test('handles a running task with no output yet', () => {
    const result = makeResult([], { systemPrompt: undefined })
    const out = textOf(renderFullResultContent(result, theme))
    expect(out).toContain('─── Transcript ───')
    expect(out).toContain('(no output)')
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