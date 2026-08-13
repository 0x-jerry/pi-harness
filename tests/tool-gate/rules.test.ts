import { describe, expect, test } from 'vitest'
import type { ToolGateConfig } from '../../src/extensions/tool-gate/config.ts'
import {
  DEFAULT_RULES,
  buildSnippet,
  decide,
  isAllowListed,
  matchRule,
  truncate,
} from '../../src/extensions/tool-gate/rules.ts'
import type { ToolGateRule } from '../../src/extensions/tool-gate/rules.ts'

const rule = (overrides: Partial<ToolGateRule>): ToolGateRule => ({
  id: 'test-rule',
  description: 'Test rule',
  tools: ['bash'],
  patterns: [String.raw`rm\s+-rf`],
  ...overrides,
})

const bashInput = (command: string): Record<string, unknown> => ({ command })

const baseConfig = (overrides: Partial<ToolGateConfig>): ToolGateConfig => ({
  enabled: true,
  mode: 'manual',
  headless: 'block',
  copilot: { model: '', notify: true, contextEntries: 5, timeoutMs: 30_000 },
  allowList: [],
  rules: [rule({})],
  ...overrides,
})

describe('DEFAULT_RULES', () => {
  test('is a single catch-all bash rule', () => {
    expect(DEFAULT_RULES).toHaveLength(1)
    const bashAll = DEFAULT_RULES[0]
    expect(bashAll?.tools).toEqual(['bash'])
    expect(bashAll?.patterns).toEqual([])
    expect(bashAll?.id).toBe('bash-all')
  })

  test('matches every bash command, including safe ones', () => {
    for (const command of ['ls -la', 'echo hi', 'rm -rf /tmp/x', 'sudo whoami']) {
      expect(matchRule(DEFAULT_RULES, 'bash', { command })).toBeDefined()
    }
  })

  test('does not gate non-bash tools', () => {
    expect(matchRule(DEFAULT_RULES, 'write', { path: '.env' })).toBeUndefined()
    expect(matchRule(DEFAULT_RULES, 'ask', { questions: [] })).toBeUndefined()
  })
})

describe('matchRule', () => {
  test('matches a dangerous command', () => {
    expect(matchRule([rule({})], 'bash', bashInput('rm -rf /tmp/x'))?.id).toBe('test-rule')
  })

  test('is case-insensitive', () => {
    expect(matchRule([rule({})], 'bash', bashInput('RM -RF /tmp/x'))).toBeDefined()
  })

  test('does not match a safe command', () => {
    expect(matchRule([rule({})], 'bash', bashInput('ls -la'))).toBeUndefined()
  })

  test('does not match another tool', () => {
    expect(matchRule([rule({})], 'write', { path: '/tmp/x' })).toBeUndefined()
  })

  test('"*" rule matches any tool', () => {
    const wildcard = rule({ tools: ['*'], patterns: [String.raw`dangerous`] })
    expect(matchRule([wildcard], 'my_custom_tool', { input: 'very dangerous' })).toBeDefined()
  })

  test('fields restrict which input values are tested', () => {
    const pathRule = rule({
      tools: ['write'],
      fields: ['path'],
      patterns: [String.raw`\.env`],
    })
    expect(matchRule([pathRule], 'write', { path: 'a/.env', content: 'x' })).toBeDefined()
    expect(matchRule([pathRule], 'write', { path: 'a/src', content: 'x.env' })).toBeUndefined()
  })

  test('first matching rule wins', () => {
    const first = rule({ id: 'first', tools: ['*'], patterns: [String.raw`rm`] })
    const second = rule({ id: 'second', tools: ['*'], patterns: [String.raw`rm -rf`] })
    expect(matchRule([first, second], 'bash', bashInput('rm -rf x'))?.id).toBe('first')
  })

  test('a rule with no patterns matches every call of its tools', () => {
    const all = rule({ id: 'all-bash', patterns: [] })
    expect(matchRule([all], 'bash', bashInput('echo hi'))).toBeDefined()
  })

  test('malformed regex does not throw and does not match', () => {
    const broken = rule({ patterns: ['('] })
    expect(() => matchRule([broken], 'bash', bashInput('rm -rf x'))).not.toThrow()
    expect(matchRule([broken], 'bash', bashInput('rm -rf x'))).toBeUndefined()
  })

  test('flattens arrays and objects in input', () => {
    const nestedRule = rule({ patterns: [String.raw`kill -9`] })
    const input = { edits: [{ oldString: 'a', newString: 'kill -9 all' }] }
    expect(matchRule([nestedRule], 'bash', input)).toBeDefined()
  })
})

describe('isAllowListed', () => {
  test('bare tool name allow-lists every call of that tool', () => {
    expect(isAllowListed(['bash'], 'bash', bashInput('rm -rf x'))).toBe(true)
    expect(isAllowListed(['bash'], 'write', { path: 'x' })).toBe(false)
  })

  test('"*" allow-lists everything', () => {
    expect(isAllowListed(['*'], 'any-tool', { x: 1 })).toBe(true)
  })

  test('"tool:regex" allow-lists only matching calls', () => {
    const list = [String.raw`bash:^ls `]
    expect(isAllowListed(list, 'bash', bashInput('ls -la'))).toBe(true)
    expect(isAllowListed(list, 'bash', bashInput('rm -rf x'))).toBe(false)
  })
})

describe('buildSnippet', () => {
  test('shows the matched value', () => {
    const snippet = buildSnippet(rule({}), bashInput('rm -rf /very/long/path'))
    expect(snippet).toContain('rm -rf /very/long/path')
  })

  test('falls back to the serialized input when nothing matches', () => {
    const snippet = buildSnippet(rule({}), bashInput('echo hi'))
    expect(snippet).toContain('echo hi')
  })
})

describe('truncate', () => {
  test('keeps short text and truncates long text', () => {
    expect(truncate('abc', 5)).toBe('abc')
    expect(truncate('abcdef', 3)).toBe('abc…')
  })
})

describe('decide', () => {
  const ctxFor = (
    overrides: Partial<Parameters<typeof decide>[1]> = {},
  ): Parameters<typeof decide>[1] => ({
    toolName: 'bash',
    input: bashInput('rm -rf /tmp/x'),
    hasUI: true,
    copilotAvailable: false,
    ...overrides,
  })

  test('disabled config always allows', () => {
    expect(decide(baseConfig({ enabled: false }), ctxFor()).action).toBe('allow')
  })

  test('bypass mode always allows', () => {
    expect(decide(baseConfig({ mode: 'bypass' }), ctxFor()).action).toBe('allow')
  })

  test('no rule match allows', () => {
    const ctx = ctxFor({ input: bashInput('ls -la') })
    expect(decide(baseConfig({}), ctx).action).toBe('allow')
  })

  test('manual + UI asks for confirmation', () => {
    const decision = decide(baseConfig({ mode: 'manual' }), ctxFor())
    expect(decision.action).toBe('confirm')
    if (decision.action === 'confirm') {
      expect(decision.rule.id).toBe('test-rule')
      expect(decision.snippet).toContain('rm -rf /tmp/x')
    }
  })

  test('manual + no UI blocks by default', () => {
    const decision = decide(
      baseConfig({ mode: 'manual', headless: 'block' }),
      ctxFor({ hasUI: false }),
    )
    expect(decision).toMatchObject({ action: 'block' })
    if (decision.action === 'block') expect(decision.reason).toContain('test-rule')
  })

  test('manual + no UI + headless allow permits', () => {
    const decision = decide(
      baseConfig({ mode: 'manual', headless: 'allow' }),
      ctxFor({ hasUI: false }),
    )
    expect(decision.action).toBe('allow')
  })

  test('per-rule headless override wins over global', () => {
    const allowRule = rule({ id: 'allow-rule', headless: 'allow' })
    const decision = decide(
      baseConfig({ headless: 'block', rules: [allowRule] }),
      ctxFor({ hasUI: false }),
    )
    expect(decision.action).toBe('allow')

    const blockRule = rule({ id: 'block-rule', headless: 'block' })
    const blocked = decide(
      baseConfig({ headless: 'allow', rules: [blockRule] }),
      ctxFor({ hasUI: false }),
    )
    expect(blocked.action).toBe('block')
  })

  test('copilot mode with a configured model routes to copilot', () => {
    const decision = decide(
      baseConfig({ mode: 'copilot', copilot: { model: 'acme/guard', notify: true, contextEntries: 5, timeoutMs: 30_000 } }),
      ctxFor({ copilotAvailable: true }),
    )
    expect(decision.action).toBe('copilot')
  })

  test('copilot mode without a configured model escalates like manual', () => {
    const decision = decide(
      baseConfig({ mode: 'copilot' }),
      ctxFor({ copilotAvailable: false, hasUI: true }),
    )
    expect(decision.action).toBe('confirm')

    const headless = decide(
      baseConfig({ mode: 'copilot', headless: 'block' }),
      ctxFor({ copilotAvailable: false, hasUI: false }),
    )
    expect(headless.action).toBe('block')
  })

  test('allowList bypasses the gate', () => {
    const decision = decide(
      baseConfig({ allowList: ['bash'] }),
      ctxFor(),
    )
    expect(decision.action).toBe('allow')
  })

  test('terminate is preserved on block decisions', () => {
    const decision = decide(
      baseConfig({ rules: [rule({ terminate: true })] }),
      ctxFor({ hasUI: false }),
    )
    expect(decision).toMatchObject({ action: 'block', terminate: true })
  })
})
