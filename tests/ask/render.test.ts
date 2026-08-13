import { describe, expect, test } from 'vitest'
import type { Component } from '@earendil-works/pi-tui'
import {
  renderAskCall,
  renderAskResult,
  resolveItems,
  type AskDetails,
} from '../../src/extensions/ask/render.ts'
import type { AskCallArgs } from '../../src/extensions/ask/schema.ts'

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

describe('resolveItems', () => {
  test('returns the questions array', () => {
    const args: AskCallArgs = {
      questions: [
        { question: 'a', options: [{ label: 'x' }] },
        { question: 'b', options: [{ label: 'y' }] },
      ],
    }
    expect(resolveItems(args)).toHaveLength(2)
    expect(resolveItems(args).map((it) => it.question)).toEqual(['a', 'b'])
  })

  test('returns [] when questions is missing', () => {
    expect(resolveItems({} as AskCallArgs)).toEqual([])
  })
})

describe('renderAskCall', () => {
  test('shows a single question with description and options', () => {
    const out = textOf(
      renderAskCall(
        {
          questions: [
            {
              question: 'Which DB?',
              description: 'For the new project',
              options: [{ label: 'postgres' }, { label: 'sqlite' }],
            },
          ],
        },
        theme,
      ),
    )
    expect(out).toContain('Which DB?')
    expect(out).toContain('For the new project')
    expect(out).toContain('1. postgres')
    expect(out).toContain('2. sqlite')
  })

  test('shows batch progress prefix and remaining count', () => {
    const out = textOf(
      renderAskCall(
        {
          questions: [
            { question: 'q1', options: [{ label: 'a' }] },
            { question: 'q2', options: [{ label: 'b' }] },
            { question: 'q3', options: [{ label: 'c' }] },
          ],
        },
        theme,
      ),
    )
    expect(out).toContain('1/3')
    expect(out).toContain('q1')
    expect(out).toContain('+2 more questions')
  })

  test('handles empty questions', () => {
    const out = textOf(
      renderAskCall({ questions: [] }, theme),
    )
    expect(out).toContain('(no questions)')
  })
})

describe('renderAskResult', () => {
  const single: AskDetails = {
    items: [
      {
        question: 'Which DB?',
        options: ['postgres', 'sqlite'],
        answer: 'sqlite',
        index: 1,
        custom: false,
      },
    ],
    cancelled: false,
  }

  const batch: AskDetails = {
    items: [
      {
        question: 'q1',
        options: ['a', 'b'],
        answer: 'a',
        index: 0,
        custom: false,
      },
      {
        question: 'q2',
        options: ['x', 'y', 'z'],
        answer: 'z',
        index: 2,
        custom: false,
      },
    ],
    cancelled: false,
  }

  test('renders a single answered question', () => {
    const out = textOf(renderAskResult({ content: [], details: single }, renderOptions, theme))
    expect(out).toContain('✓')
    expect(out).toContain('sqlite')
  })

  test('renders a completed batch as numbered answers', () => {
    const out = textOf(renderAskResult({ content: [], details: batch }, renderOptions, theme))
    expect(out).toContain('✓')
    expect(out).toContain('1. a')
    expect(out).toContain('2. z')
  })

  test('renders a custom answer with a ✎ marker', () => {
    const out = textOf(
      renderAskResult(
        {
          content: [],
          details: {
            items: [
              {
                question: 'q1',
                options: ['a', 'b'],
                answer: 'a',
                index: 0,
                custom: false,
              },
              {
                question: 'q2',
                options: ['x', 'y'],
                answer: 'something else',
                index: null,
                custom: true,
              },
            ],
            cancelled: false,
          },
        },
        renderOptions,
        theme,
      ),
    )
    expect(out).toContain('1. a')
    expect(out).toContain('✎ something else')
  })

  test('renders a cancelled single question', () => {
    const out = textOf(
      renderAskResult(
        {
          content: [],
          details: {
            items: [
              {
                question: 'q',
                options: ['a'],
                answer: null,
                index: null,
                custom: false,
              },
            ],
            cancelled: true,
            cancelledAt: 0,
          },
        },
        renderOptions,
        theme,
      ),
    )
    expect(out).toContain('✗ cancelled')
    expect(out).not.toContain('q1/')
  })

  test('renders a cancelled batch with the question index', () => {
    const out = textOf(
      renderAskResult(
        {
          content: [],
          details: {
            items: [
              {
                question: 'q1',
                options: ['a'],
                answer: 'a',
                index: 0,
                custom: false,
              },
              {
                question: 'q2',
                options: ['b'],
                answer: null,
                index: null,
                custom: false,
              },
            ],
            cancelled: true,
            cancelledAt: 1,
          },
        },
        renderOptions,
        theme,
      ),
    )
    expect(out).toContain('✗ cancelled (q2/2)')
  })

  test('falls back to content text when details are missing', () => {
    const result = {
      content: [{ type: 'text', text: 'fallback' }],
    } as unknown as Parameters<typeof renderAskResult>[0]
    const out = textOf(renderAskResult(result, renderOptions, theme))
    expect(out).toContain('fallback')
  })
})
