import { afterEach, describe, expect, test } from 'vitest'
import { DEFAULT_CONFIG, loadToolGateConfig } from '../../src/extensions/tool-gate/config.ts'
import { makeTmpEnv, type TmpEnv } from './helpers.ts'

const envs: TmpEnv[] = []

function freshEnv(): TmpEnv {
  const env = makeTmpEnv()
  envs.push(env)
  return env
}

afterEach(() => {
  while (envs.length > 0) envs.pop()?.cleanup()
})

const load = (env: TmpEnv, projectTrusted = true, extraEnv: Record<string, string | undefined> = {}) =>
  loadToolGateConfig({ cwd: env.cwd, agentDir: env.agentDir, projectTrusted, env: extraEnv })

describe('loadToolGateConfig', () => {
  test('returns defaults when no config files exist', () => {
    const { config, warnings } = load(freshEnv())
    expect(warnings).toEqual([])
    expect(config).toEqual(DEFAULT_CONFIG)
    expect(config.mode).toBe('manual')
    expect(config.headless).toBe('block')
    expect(config.rules.length).toBeGreaterThan(0)
  })

  test('global config overrides defaults', () => {
    const env = freshEnv()
    env.writeGlobal(JSON.stringify({ mode: 'bypass', headless: 'allow' }))
    const { config, warnings } = load(env)
    expect(warnings).toEqual([])
    expect(config.mode).toBe('bypass')
    expect(config.headless).toBe('allow')
    expect(config.enabled).toBe(true) // untouched fields keep defaults
  })

  test('project config overrides global config', () => {
    const env = freshEnv()
    env.writeGlobal(JSON.stringify({ mode: 'bypass' }))
    env.writeProject(JSON.stringify({ mode: 'copilot' }))
    const { config } = load(env)
    expect(config.mode).toBe('copilot')
  })

  test('project config is ignored for untrusted projects', () => {
    const env = freshEnv()
    env.writeProject(JSON.stringify({ mode: 'copilot' }))
    const { config } = load(env, false)
    expect(config.mode).toBe(DEFAULT_CONFIG.mode)
  })

  test('copilot section merges field by field', () => {
    const env = freshEnv()
    env.writeGlobal(JSON.stringify({ copilot: { model: 'acme/guard', timeoutMs: 5000 } }))
    const { config } = load(env)
    expect(config.copilot.model).toBe('acme/guard')
    expect(config.copilot.timeoutMs).toBe(5000)
    expect(config.copilot.notify).toBe(true) // untouched subfield keeps default
  })

  test('rules are replaced (not merged) when provided', () => {
    const env = freshEnv()
    env.writeGlobal(
      JSON.stringify({
        rules: [{ id: 'mine', description: 'Mine', tools: ['bash'], patterns: ['mine'] }],
      }),
    )
    const { config } = load(env)
    expect(config.rules).toHaveLength(1)
    expect(config.rules[0]?.id).toBe('mine')
  })

  test('user rules are normalized (defaults for missing fields)', () => {
    const env = freshEnv()
    env.writeGlobal(
      JSON.stringify({
        rules: [{ description: 'Bare', patterns: ['x'] }],
      }),
    )
    const { config } = load(env)
    expect(config.rules[0]).toMatchObject({
      description: 'Bare',
      tools: ['*'],
      patterns: ['x'],
      terminate: false,
    })
    expect(config.rules[0]?.id).toBeTruthy()
  })

  test('env vars override file config', () => {
    const env = freshEnv()
    env.writeGlobal(JSON.stringify({ mode: 'bypass', headless: 'allow' }))
    const { config } = load(env, true, {
      PI_TOOL_GATE_MODE: 'copilot',
      PI_TOOL_GATE_HEADLESS: 'block',
      PI_TOOL_GATE_COPILOT_MODEL: 'env/guard',
    })
    expect(config.mode).toBe('copilot')
    expect(config.headless).toBe('block')
    expect(config.copilot.model).toBe('env/guard')
  })

  test('invalid env values are ignored', () => {
    const env = freshEnv()
    const { config } = load(env, true, {
      PI_TOOL_GATE_MODE: 'surprise',
      PI_TOOL_GATE_HEADLESS: 'maybe',
    })
    expect(config.mode).toBe(DEFAULT_CONFIG.mode)
    expect(config.headless).toBe(DEFAULT_CONFIG.headless)
  })

  test('malformed JSON warns and falls back to defaults', () => {
    const env = freshEnv()
    env.writeGlobal('{ not json')
    const { config, warnings } = load(env)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('invalid JSON')
    expect(config).toEqual(DEFAULT_CONFIG)
  })

  test('invalid field values warn and keep previous values', () => {
    const env = freshEnv()
    env.writeGlobal(JSON.stringify({ mode: 'sideways', headless: 'banana' }))
    const { config, warnings } = load(env)
    expect(warnings).toHaveLength(2)
    expect(config.mode).toBe(DEFAULT_CONFIG.mode)
    expect(config.headless).toBe(DEFAULT_CONFIG.headless)
  })

  test('non-object JSON root warns and is ignored', () => {
    const env = freshEnv()
    env.writeGlobal('[1, 2, 3]')
    const { config, warnings } = load(env)
    expect(warnings).toHaveLength(1)
    expect(config).toEqual(DEFAULT_CONFIG)
  })

  test('missing global file and trusted project file is not an error', () => {
    const env = freshEnv()
    const { warnings } = load(env)
    expect(warnings).toEqual([])
  })
})
