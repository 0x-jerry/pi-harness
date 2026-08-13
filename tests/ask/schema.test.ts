import { describe, expect, test } from 'vitest'
import { Value } from 'typebox/value'
import { AskParams } from '../../src/extensions/ask/schema.ts'

describe('AskParams schema', () => {
  test('is an object with a single `questions` array property', () => {
    expect(AskParams.type).toBe('object')
    expect(Object.keys(AskParams.properties)).toEqual(['questions'])
    expect(AskParams.properties.questions.type).toBe('array')
  })

  test('each question item has question, optional description, and options', () => {
    const item = AskParams.properties.questions.items
    expect(item.type).toBe('object')
    expect(Object.keys(item.properties)).toEqual([
      'question',
      'description',
      'options',
    ])
    expect(item.required).toEqual(['question', 'options'])
    expect(item.properties.options.type).toBe('array')
  })

  test('each option has a required label and an optional description', () => {
    const option =
      AskParams.properties.questions.items.properties.options.items
    expect(option.type).toBe('object')
    expect(Object.keys(option.properties)).toEqual(['label', 'description'])
    expect(option.required).toEqual(['label'])
  })

  test('accepts a single valid question with label-only options', () => {
    const input = {
      questions: [
        {
          question: 'Which DB?',
          options: [{ label: 'postgres' }, { label: 'sqlite' }],
        },
      ],
    }
    expect(Value.Check(AskParams, input)).toBe(true)
  })

  test('accepts options with optional descriptions', () => {
    const input = {
      questions: [
        {
          question: 'q',
          options: [
            { label: 'a', description: 'first choice' },
            { label: 'b' },
          ],
        },
      ],
    }
    expect(Value.Check(AskParams, input)).toBe(true)
  })

  test('accepts a batch with per-question options', () => {
    const input = {
      questions: [
        { question: 'q1', options: [{ label: 'a' }] },
        {
          question: 'q2',
          description: 'ctx',
          options: [{ label: 'x' }, { label: 'y' }],
        },
      ],
    }
    expect(Value.Check(AskParams, input)).toBe(true)
  })

  test('rejects a question without options', () => {
    expect(Value.Check(AskParams, { questions: [{ question: 'q' }] })).toBe(
      false,
    )
  })

  test('rejects a question without question text', () => {
    expect(
      Value.Check(AskParams, {
        questions: [{ options: [{ label: 'a' }] }],
      }),
    ).toBe(false)
  })

  test('rejects options that are plain strings', () => {
    expect(
      Value.Check(AskParams, {
        questions: [{ question: 'q', options: ['a', 'b'] }],
      }),
    ).toBe(false)
  })

  test('rejects options without a label', () => {
    expect(
      Value.Check(AskParams, {
        questions: [{ question: 'q', options: [{ description: 'x' }] }],
      }),
    ).toBe(false)
  })

  test('rejects options whose label is not a string', () => {
    expect(
      Value.Check(AskParams, {
        questions: [{ question: 'q', options: [{ label: 1 }, { label: 2 }] }],
      }),
    ).toBe(false)
  })

  test('rejects questions that is not an array', () => {
    expect(
      Value.Check(AskParams, {
        questions: { question: 'q', options: [{ label: 'a' }] },
      }),
    ).toBe(false)
  })

  test('accepts an empty questions array (execute() rejects it later)', () => {
    expect(Value.Check(AskParams, { questions: [] })).toBe(true)
  })
})
