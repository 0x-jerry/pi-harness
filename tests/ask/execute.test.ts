import { describe, expect, test } from 'vitest'
import type { Component } from '@earendil-works/pi-tui'
import registerAskExtension from '../../src/extensions/ask/index.ts'
import type { AskDetails } from '../../src/extensions/ask/render.ts'
import type { AskCallArgs } from '../../src/extensions/ask/schema.ts'

/* ------------------------------------------------------------------ */
/* Test harness                                                        */
/* ------------------------------------------------------------------ */

interface ToolDef {
  name: string
  label: string
  parameters: unknown
  execute: (
    toolCallId: string,
    params: AskCallArgs,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: any,
  ) => Promise<{ content: { type: string; text: string }[]; details: AskDetails }>
  renderCall: unknown
  renderResult: unknown
}

/** Load the extension and capture the registered ask tool definition. */
function captureAskTool(): ToolDef {
  let tool: ToolDef | undefined
  const fakePi = {
    registerTool: (def: ToolDef) => {
      tool = def
    },
  }
  registerAskExtension(fakePi as never)
  if (!tool) throw new Error('ask tool was not registered')
  expect(tool.name).toBe('ask')
  return tool
}

const tool = captureAskTool()

/** Minimal theme stub with <color> markers for assertion. */
function stubTheme() {
  return {
    fg: (color: string, s: string) => `<${color}>${s}</>`,
    bold: (s: string) => `*${s}*`,
  }
}

const stubTui = { requestRender: () => {}, terminal: { rows: 24 } }

/** ctx stub. `custom` receives a dialog driver when provided. */
function stubCtx(options: {
  mode?: string
  inputs?: string[]
} = {}): any {
  const ctx: any = {
    mode: options.mode ?? 'tui',
    ui: {},
  }
  if (options.inputs) {
    // Drive the dialog: run the factory, then feed raw key inputs.
    ctx.ui.custom = (factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void) => Component) =>
      new Promise((resolve) => {
        const comp = factory(stubTui, stubTheme(), {}, resolve)
        expect(typeof comp.render).toBe('function')
        expect(typeof comp.invalidate).toBe('function')
        expect(typeof comp.handleInput).toBe('function')
        for (const input of options.inputs!) comp.handleInput?.(input)
      })
  } else {
    ctx.ui.custom = () => {
      throw new Error('ui.custom should not be called')
    }
  }
  return ctx
}

async function run(
  params: AskCallArgs,
  opts: { mode?: string; inputs?: string[] } = {},
) {
  return tool.execute('call-1', params, undefined, undefined, stubCtx(opts))
}

/** Extract the first content text (content[0] is possibly undefined under strict). */
function textOf(result: {
  content: { type: string; text: string }[]
}): string {
  return result.content[0]!.text
}

const singleParams: AskCallArgs = {
  questions: [{ question: 'Which DB?', options: ['postgres', 'sqlite'] }],
}

const batchParams: AskCallArgs = {
  questions: [
    { question: 'q1', options: ['a', 'b'] },
    { question: 'q2', options: ['x', 'y', 'z'] },
  ],
}

/* ------------------------------------------------------------------ */
/* Validation / guard errors                                           */
/* ------------------------------------------------------------------ */

describe('ask validation and guards', () => {
  test('rejects an empty questions array', async () => {
    const result = await run({ questions: [] })
    expect(textOf(result)).toContain('must be a non-empty array')
    expect(result.details.cancelled).toBe(true)
    expect(result.details.items).toEqual([])
  })

  test('rejects a question with empty options', async () => {
    const result = await run({
      questions: [
        { question: 'q1', options: ['a'] },
        { question: 'q2', options: [] },
      ],
    })
    expect(textOf(result)).toContain('question 2')
    expect(textOf(result)).toContain('empty `options`')
    expect(result.details.cancelled).toBe(true)
    expect(result.details.cancelledAt).toBe(1)
  })

  test('rejects in non-interactive mode without touching the UI', async () => {
    const result = await run(singleParams, { mode: 'print' })
    expect(textOf(result)).toContain('interactive terminal')
    expect(result.details.cancelled).toBe(true)
    expect(result.details.items[0]?.answer).toBeNull()
  })
})

/* ------------------------------------------------------------------ */
/* Dialog interaction                                                  */
/* ------------------------------------------------------------------ */

describe('ask dialog interaction', () => {
  test('single question: arrow navigation + Enter selects', async () => {
    const result = await run(singleParams, { inputs: ['\x1b[B', '\r', '\r'] })

    expect(result.details.cancelled).toBe(false)
    expect(result.details.items).toHaveLength(1)
    const item = result.details.items[0]!
    expect(item.question).toBe('Which DB?')
    expect(item.answer).toBe('sqlite')
    expect(item.index).toBe(1)
    expect(textOf(result)).toBe('User selected: sqlite')
  })

  test('batch: digit shortcut, ← back, Enter re-select, digit finishes', async () => {
    const result = await run(batchParams, {
      inputs: ['2', '\x1b[D', '\r', '3', '\r'],
    })

    expect(result.details.cancelled).toBe(false)
    const [first, second] = result.details.items
    expect(first!.answer).toBe('b')
    expect(first!.index).toBe(1)
    expect(second!.answer).toBe('z')
    expect(second!.index).toBe(2)
    expect(textOf(result)).toBe(
      'User answered all 2 questions:\n1. q1 → b\n2. q2 → z',
    )
  })

  test('batch: ← goes back and restores the previous selection', async () => {
    // '2' picks q1 option 2 (b) and advances; ← returns to q1 with the
    // selection restored to option 2; Enter picks the restored option; '1'
    // finishes with q2 option 1 (x). If ← did not restore the selection,
    // Enter would pick option 1 (a) instead.
    const result = await run(batchParams, {
      inputs: ['2', '\x1b[D', '\r', '1', '\r'],
    })

    expect(result.details.cancelled).toBe(false)
    const [first, second] = result.details.items
    expect(first!.answer).toBe('b')
    expect(first!.index).toBe(1)
    expect(second!.answer).toBe('x')
    expect(second!.index).toBe(0)
  })

  test('escape cancels a single question and throws', async () => {
    await expect(run(singleParams, { inputs: ['\x1b'] })).rejects.toThrow(
      'User cancelled: Which DB?',
    )
  })

  test('escape cancels a batch and throws with the partial answers', async () => {
    await expect(run(batchParams, { inputs: ['1', '\x1b'] })).rejects.toThrow(
      'User cancelled at question 2 of 2.\n1. q1 → a\n2. q2 → (no answer)',
    )
  })

  test('description is preserved in the result details', async () => {
    const result = await run(
      {
        questions: [
          {
            question: 'q1',
            description: 'some context',
            options: ['a', 'b'],
          },
        ],
      },
      { inputs: ['\r', '\r'] },
    )
    expect(result.details.items[0]?.description).toBe('some context')
    expect(result.details.items[0]?.answer).toBe('a')
  })

  test('custom answer: selecting the ✎ option opens the editor and submits typed text', async () => {
    const result = await run(singleParams, {
      // down, down → move to the trailing custom option; Enter opens the editor;
      // type "cassandra"; Enter submits.
      inputs: ['\x1b[B', '\x1b[B', '\r', 'cassandra', '\r', '\r'],
    })

    expect(result.details.cancelled).toBe(false)
    const item = result.details.items[0]!
    expect(item.answer).toBe('cassandra')
    expect(item.index).toBeNull()
    expect(item.custom).toBe(true)
    expect(textOf(result)).toBe('User answered: cassandra')
  })

  test('custom answer: Esc leaves the editor back to options without losing the question', async () => {
    const result = await run(singleParams, {
      // open editor, type partial text, Esc back to options (custom item is
      // still selected), navigate up to an option and pick it
      inputs: ['\x1b[B', '\x1b[B', '\r', 'partial', '\x1b', '\x1b[A', '\r', '\r'],
    })

    expect(result.details.cancelled).toBe(false)
    const item = result.details.items[0]!
    expect(item.answer).toBe('sqlite')
    expect(item.index).toBe(1)
    expect(item.custom).toBe(false)
  })

  test('custom answer: empty submission stays in the editor', async () => {
    const result = await run(singleParams, {
      // open editor, submit empty (stays), then type a real answer
      inputs: ['\x1b[B', '\x1b[B', '\r', '\r', 'typed answer', '\r', '\r'],
    })

    expect(result.details.cancelled).toBe(false)
    expect(result.details.items[0]?.answer).toBe('typed answer')
    expect(result.details.items[0]?.custom).toBe(true)
  })

  test('batch: custom answer on one question and option on another', async () => {
    const result = await run(batchParams, {
      // q1: pick option 2 (b) via digit → advance; q2: custom answer
      inputs: ['2', '\x1b[B', '\x1b[B', '\x1b[B', '\r', 'custom text', '\r', '\r'],
    })

    expect(result.details.cancelled).toBe(false)
    const [first, second] = result.details.items
    expect(first!.answer).toBe('b')
    expect(first!.custom).toBe(false)
    expect(second!.answer).toBe('custom text')
    expect(second!.custom).toBe(true)
    expect(textOf(result)).toBe(
      'User answered all 2 questions:\n1. q1 → b\n2. q2 → custom: custom text',
    )
  })

  test('batch: ← back to a question answered with a custom answer restores the editor', async () => {
    const result = await run(batchParams, {
      // q1: custom answer "first draft"; advance; ← back; the editor is
      // restored with the previous text; submit it unchanged, then finish q2.
      inputs: [
        '\x1b[B',
        '\x1b[B',
        '\r',
        'first draft',
        '\r',
        '\x1b[D',
        '\r',
        '1',
        '\r',
      ],
    })

    expect(result.details.cancelled).toBe(false)
    const [first, second] = result.details.items
    expect(first!.answer).toBe('first draft')
    expect(first!.custom).toBe(true)
    expect(second!.answer).toBe('x')
    expect(second!.custom).toBe(false)
  })

  test('dialog exposes render/invalidate/handleInput and renders options', async () => {
    let capturedRender: ((w: number) => string[]) | undefined
    const ctx: any = {
      mode: 'tui',
      ui: {
        custom: (factory: any) =>
          new Promise((resolve) => {
            const comp = factory(stubTui, stubTheme(), {}, resolve)
            capturedRender = comp.render
            // snapshot the first question's dialog
            const lines = comp.render(80)
            expect(lines.join('')).toContain('Which DB?')
            expect(lines.join('')).toContain('1. postgres')
            expect(lines.join('')).toContain('2. sqlite')
            expect(typeof comp.invalidate).toBe('function')
            expect(typeof comp.handleInput).toBe('function')
            // answer the question, then confirm at the review step
            comp.handleInput('\r')
            comp.handleInput('\r')
          }),
      },
    }
    await tool.execute('call-2', singleParams, undefined, undefined, ctx)
    expect(typeof capturedRender).toBe('function')
  })

  test('left/right arrows move between questions', async () => {
    const result = await run(batchParams, {
      // → to q2, ← back to q1, answer q1 (option 1), answer q2 (option 1), confirm
      inputs: ['\x1b[C', '\x1b[D', '\r', '\r', '\r'],
    })

    expect(result.details.cancelled).toBe(false)
    const [first, second] = result.details.items
    expect(first!.answer).toBe('a')
    expect(first!.index).toBe(0)
    expect(second!.answer).toBe('x')
    expect(second!.index).toBe(0)
  })

  test('right arrow past the last question opens the review step', async () => {
    const result = await run(batchParams, {
      // → to q2, → past the last question → review; submit without answering
      inputs: ['\x1b[C', '\x1b[C', '\r'],
    })

    expect(result.details.cancelled).toBe(false)
    const [first, second] = result.details.items
    expect(first!.answer).toBeNull()
    expect(second!.answer).toBeNull()
    expect(textOf(result)).toBe(
      'User answered all 2 questions:\n1. q1 → (no answer)\n2. q2 → (no answer)',
    )
  })

  test('review step: Edit answers returns to the questions for revision', async () => {
    const result = await run(singleParams, {
      // answer option 1 → review; pick "Edit answers"; re-answer option 2;
      // confirm and submit
      inputs: ['\r', '\x1b[B', '\r', '\x1b[B', '\r', '\r'],
    })

    expect(result.details.cancelled).toBe(false)
    const item = result.details.items[0]!
    expect(item.answer).toBe('sqlite')
    expect(item.index).toBe(1)
    expect(item.custom).toBe(false)
  })

  test('review step: Esc cancels and throws with the collected answer', async () => {
    await expect(run(singleParams, { inputs: ['\r', '\x1b'] })).rejects.toThrow(
      'User cancelled: Which DB? (answer: postgres)',
    )
  })
})
