import { describe, expect, test } from 'vitest'
import {
  buildReviewPrompt,
  buildSessionContext,
  extractMessageText,
  parseVerdict,
  redactAndTruncate,
} from '../../src/extensions/tool-gate/copilot.ts'
import { rule } from './fixtures.ts'

describe('parseVerdict', () => {
  test('parses JSON verdicts', () => {
    expect(parseVerdict('{"verdict": "pass", "reason": "safe"}')).toEqual({
      verdict: 'pass',
      reason: 'safe',
    })
    expect(parseVerdict('{"verdict": "reject", "reason": "destructive"}')).toEqual({
      verdict: 'reject',
      reason: 'destructive',
    })
    expect(parseVerdict('{"verdict": "ask", "reason": "unclear"}')).toEqual({
      verdict: 'ask',
      reason: 'unclear',
    })
  })

  test('parses JSON embedded in surrounding text (e.g. code fences)', () => {
    expect(
      parseVerdict('```json\n{"verdict": "pass", "reason": "ok"}\n```'),
    ).toEqual({ verdict: 'pass', reason: 'ok' })
  })

  test('parses line formats', () => {
    expect(parseVerdict('PASS: clearly fine')).toEqual({ verdict: 'pass', reason: 'clearly fine' })
    expect(parseVerdict('REJECT - nope')).toEqual({ verdict: 'reject', reason: 'nope' })
    expect(parseVerdict('ask: not sure')).toEqual({ verdict: 'ask', reason: 'not sure' })
  })

  test('unknown verdicts inside JSON fall back to ask', () => {
    expect(parseVerdict('{"verdict": "maybe", "reason": "?"}')).toEqual({
      verdict: 'ask',
      reason: 'Unparseable copilot response',
    })
  })

  test('garbage output is treated as ask (fail safe)', () => {
    expect(parseVerdict('I think you should maybe not do that.')).toEqual({
      verdict: 'ask',
      reason: 'Unparseable copilot response',
    })
    expect(parseVerdict('')).toEqual({ verdict: 'ask', reason: 'Unparseable copilot response' })
  })

  test('malformed JSON falls back to ask', () => {
    expect(parseVerdict('{"verdict": "pass"')).toEqual({
      verdict: 'ask',
      reason: 'Unparseable copilot response',
    })
  })
})

describe('redactAndTruncate', () => {
  test('redacts sensitive keys anywhere in the structure', () => {
    const out = redactAndTruncate({
      command: 'curl -H "Authorization: Bearer abc"',
      config: { api_key: 'sk-123', apiKey: 'sk-456' },
    })
    expect(out).not.toContain('sk-123')
    expect(out).not.toContain('sk-456')
    expect(out).toContain('[redacted]')
    expect(out).toContain('curl')
  })

  test('truncates long input', () => {
    const long = { command: 'x'.repeat(5000) }
    const out = redactAndTruncate(long, 200)
    expect(out.length).toBeLessThanOrEqual(201)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('extractMessageText', () => {
  test('extracts text parts and joins them', () => {
    expect(
      extractMessageText({
        role: 'assistant',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'text', text: 'world' },
        ],
      }),
    ).toBe('hello world')
  })

  test('handles plain strings and empty content', () => {
    expect(extractMessageText({ role: 'user', content: 'hi' })).toBe('hi')
    expect(extractMessageText({ role: 'user', content: [] })).toBe('')
  })
})

describe('buildSessionContext', () => {
  const entry = (role: string, text: string, type = 'message') => ({
    type,
    id: `id-${role}-${text}`,
    parentId: null,
    timestamp: '2024-01-01T00:00:00.000Z',
    message: { role, content: [{ type: 'text', text }] },
  })

  test('returns newest user/assistant messages first, skipping tool results', () => {
    const entries = [
      entry('user', 'first'),
      entry('assistant', 'middle'),
      entry('tool', 'tool result'),
      entry('user', 'last'),
    ] as never[]
    const ctx = buildSessionContext(entries, 5)
    expect(ctx).toContain('last')
    expect(ctx).toContain('first')
    expect(ctx).not.toContain('tool result')
  })

  test('respects maxEntries', () => {
    const entries = [
      entry('user', 'a'),
      entry('user', 'b'),
      entry('user', 'c'),
    ] as never[]
    expect(buildSessionContext(entries, 2)).not.toContain('a')
  })

  test('empty input produces empty context', () => {
    expect(buildSessionContext([], 5)).toBe('')
  })
})

describe('buildReviewPrompt', () => {
  test('includes the tool call, rule, and context', () => {
    const prompt = buildReviewPrompt({
      toolName: 'bash',
      input: { command: 'rm -rf /tmp/x' },
      rule: rule({}),
      context: 'user: delete the scratch dir',
    })
    expect(prompt).toContain('bash({')
    expect(prompt).toContain('rm -rf /tmp/x')
    expect(prompt).toContain('Test rule')
    expect(prompt).toContain('user: delete the scratch dir')
    expect(prompt).toContain('"verdict"')
  })

  test('works without context', () => {
    const prompt = buildReviewPrompt({
      toolName: 'bash',
      input: { command: 'ls' },
      rule: rule({}),
    })
    expect(prompt).toContain('Tool call:')
    expect(prompt).not.toContain('Recent conversation')
  })
})
