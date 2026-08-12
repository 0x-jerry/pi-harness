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

  test('accepts a single valid question', () => {
    const input = {
      questions: [{ question: 'Which DB?', options: ['postgres', 'sqlite'] }],
    }
    expect(Value.Check(AskParams, input)).toBe(true)
  })

  test('accepts a batch with per-question options', () => {
    const input = {
      questions: [
        { question: 'q1', options: ['a'] },
        { question: 'q2', description: 'ctx', options: ['x', 'y'] },
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
    expect(Value.Check(AskParams, { questions: [{ options: ['a'] }] })).toBe(
      false,
    )
  })

  test('rejects options that are not strings', () => {
    expect(
      Value.Check(AskParams, { questions: [{ question: 'q', options: [1, 2] }] }),
    ).toBe(false)
  })

  test('rejects questions that is not an array', () => {
    expect(
      Value.Check(AskParams, { questions: { question: 'q', options: ['a'] } }),
    ).toBe(false)
  })

  test('accepts an empty questions array (execute() rejects it later)', () => {
    expect(Value.Check(AskParams, { questions: [] })).toBe(true)
  })
})
