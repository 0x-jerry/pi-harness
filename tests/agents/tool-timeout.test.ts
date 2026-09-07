import { describe, expect, test } from 'vitest'
import {
  createBashWithDefaultTimeout,
  DEFAULT_BASH_TIMEOUT_SECONDS,
  withBashDefaultTimeout,
} from '../../src/extensions/agents/toolTimeout.ts'

interface RecordedCall {
  toolCallId: string
  params: any
  signal: unknown
  onUpdate: unknown
  ctx: unknown
}

function recordedTool(): {
  tool: { execute: (...args: any[]) => Promise<any> }
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const tool = {
    name: 'bash',
    label: 'Bash',
    description: 'Run a shell command',
    parameters: { type: 'object', properties: {} },
    execute: (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => {
      calls.push({ toolCallId, params, signal, onUpdate, ctx })
      return Promise.resolve({
        content: [{ type: 'text', text: 'ok' }],
      })
    },
  }
  return { tool, calls }
}

describe('withBashDefaultTimeout', () => {
  test('injects the default timeout when the call omits one', async () => {
    const { tool, calls } = recordedTool()
    const wrapped = withBashDefaultTimeout(tool)
    await wrapped.execute(
      'tc-1',
      { command: 'git fetch' },
      undefined,
      undefined,
      {},
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]?.params.command).toBe('git fetch')
    expect(calls[0]?.params.timeout).toBe(DEFAULT_BASH_TIMEOUT_SECONDS)
  })

  test('preserves an explicit timeout', async () => {
    const { tool, calls } = recordedTool()
    const wrapped = withBashDefaultTimeout(tool)
    await wrapped.execute(
      'tc-2',
      { command: 'git clone', timeout: 5 },
      undefined,
      undefined,
      {},
    )
    expect(calls[0]?.params.timeout).toBe(5)
  })

  test('forwards toolCallId, signal, onUpdate, and ctx', async () => {
    const { tool, calls } = recordedTool()
    const wrapped = withBashDefaultTimeout(tool)
    const signal = new AbortController().signal
    const onUpdate = () => {}
    const ctx = { cwd: '/tmp' }
    await wrapped.execute('tc-9', { command: 'ls' }, signal, onUpdate, ctx)
    expect(calls[0]?.toolCallId).toBe('tc-9')
    expect(calls[0]?.signal).toBe(signal)
    expect(calls[0]?.onUpdate).toBe(onUpdate)
    expect(calls[0]?.ctx).toBe(ctx)
  })
})

describe('createBashWithDefaultTimeout', () => {
  test('builds a bash tool that still exposes the timeout parameter', () => {
    const tool = createBashWithDefaultTimeout(process.cwd())
    expect(tool.name).toBe('bash')
    const properties = (tool.parameters as any).properties ?? {}
    expect('timeout' in properties).toBe(true)
  })
})