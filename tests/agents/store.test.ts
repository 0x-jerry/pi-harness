import { beforeEach, describe, expect, test } from 'vitest'
import { emptyResult, emptyUsage, isFailedResult } from '../../src/extensions/agents/result.ts'
import {
  addTask,
  clearTasks,
  finishTask,
  getTasks,
  getTask,
  restoreTasks,
  TASK_ENTRY_TYPE,
  taskRecord,
  updateTask,
} from '../../src/extensions/agents/store.ts'
import type { SubagentTaskRecord } from '../../src/extensions/agents/store.ts'
import type { SubAgentResult } from '../../src/extensions/agents/types.ts'

/** Session entry fixtures for restoreTasks. */
function customRecordEntry(record: SubagentTaskRecord): any {
  return {
    type: 'custom',
    customType: TASK_ENTRY_TYPE,
    data: record,
    id: `c-${record.toolCallId}`,
    parentId: null,
    timestamp: '2024-01-01T00:00:00.000Z',
  }
}

function messageEntry(message: any): any {
  return {
    type: 'message',
    id: `m-${message.toolCallId ?? Math.random()}`,
    parentId: null,
    timestamp: '2024-01-01T00:00:00.000Z',
    message,
  }
}

function toolCallEntry(id: string, args: Record<string, any> = {}): any {
  return messageEntry({
    role: 'assistant',
    content: [{ type: 'toolCall', id, name: 'subagent', arguments: args }],
    timestamp: 0,
  })
}

function toolResultEntry(
  id: string,
  options: {
    details?: Partial<SubAgentResult>
    error?: string
  } = {},
): any {
  const { details, error } = options
  return messageEntry({
    role: 'toolResult',
    toolCallId: id,
    toolName: 'subagent',
    content: error ? [{ type: 'text', text: error }] : [],
    details: details ?? (error ? {} : undefined),
    isError: error != null || details?.exitCode !== undefined && details.exitCode !== 0,
    timestamp: 0,
  })
}

beforeEach(() => {
  clearTasks()
})

describe('subagent task store', () => {
  test('addTask records a running task', () => {
    const details = emptyResult({ agent: 'reviewer', task: 'Review the diff' })
    addTask('tc-1', details)
    const [task] = getTasks()
    expect(task?.toolCallId).toBe('tc-1')
    expect(task?.status).toBe('running')
    expect(task?.agent).toBe('reviewer')
    expect(task?.task).toBe('Review the diff')
  })

  test('updateTask replaces the streamed details', () => {
    const details = emptyResult({ agent: 'reviewer', task: 'Review the diff' })
    addTask('tc-1', details)
    const partial = emptyResult({
      agent: 'reviewer',
      task: 'Review the diff',
      agentSource: 'builtin',
    })
    updateTask('tc-1', partial)
    expect(getTasks()[0]?.details.agentSource).toBe('builtin')
  })

  test('finishTask marks done/error/aborted from the final result', () => {
    addTask('tc-ok', emptyResult({ agent: 'a', task: 't' }))
    finishTask('tc-ok', emptyResult({ agent: 'a', task: 't', exitCode: 0 }))

    addTask('tc-err', emptyResult({ agent: 'b', task: 't' }))
    finishTask(
      'tc-err',
      emptyResult({ agent: 'b', task: 't', exitCode: 1, stderr: 'boom' }),
    )

    addTask('tc-abo', emptyResult({ agent: 'c', task: 't' }))
    finishTask(
      'tc-abo',
      emptyResult({ agent: 'c', task: 't', stopReason: 'aborted' }),
    )

    const statuses = new Map(getTasks().map((t) => [t.toolCallId, t.status]))
    expect(statuses.get('tc-ok')).toBe('done')
    expect(statuses.get('tc-err')).toBe('error')
    expect(statuses.get('tc-abo')).toBe('aborted')
  })

  test('getTasks returns tasks oldest first', () => {
    addTask('first', emptyResult({ agent: 'a', task: '1' }))
    addTask('second', emptyResult({ agent: 'b', task: '2' }))
    const ids = getTasks().map((t) => t.toolCallId)
    expect(ids.indexOf('first')).toBeLessThan(ids.indexOf('second'))
  })

  test('failed results are detected by isFailedResult', () => {
    expect(
      isFailedResult(
        emptyResult({ agent: 'a', task: 't', exitCode: 1 }),
      ),
    ).toBe(true)
    expect(
      isFailedResult(
        emptyResult({ agent: 'a', task: 't', exitCode: 0 }),
      ),
    ).toBe(false)
  })

  test('usage is always present on results', () => {
    expect(emptyUsage()).toMatchObject({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    })
  })

  test('taskRecord round-trips a task into its compact record', () => {
    const details = emptyResult({ agent: 'reviewer', task: 'Review' })
    addTask('rr-1', details)
    finishTask('rr-1', emptyResult({ agent: 'reviewer', task: 'Review' }))
    const task = getTask('rr-1')
    expect(task).toBeDefined()
    const record = taskRecord(task!)
    expect(record).toMatchObject({
      toolCallId: 'rr-1',
      agent: 'reviewer',
      agentSource: 'unknown',
      task: 'Review',
      status: 'done',
    })
  })
})

describe('subagent task restore from session history', () => {
  test('rebuilds a done task from the tool-result details', () => {
    const details = emptyResult({
      agent: 'reviewer',
      task: 'Review the diff',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] as any,
    })
    restoreTasks([
      toolCallEntry('c-ok', { agent: 'reviewer', task: 'Review the diff' }),
      toolResultEntry('c-ok', { details }),
    ])
    const [task] = getTasks()
    expect(task?.status).toBe('done')
    expect(task?.agent).toBe('reviewer')
    expect(task?.details.messages?.length).toBe(1)
  })

  test('aborted status comes from the persisted record even when details are lost', () => {
    const record: SubagentTaskRecord = {
      toolCallId: 'c-abo',
      agent: 'scout',
      agentSource: 'user',
      task: 'Scan the repo',
      status: 'aborted',
      startedAt: 1,
    }
    // execute() threw, so the tool result carries only the error text.
    restoreTasks([
      toolCallEntry('c-abo', { agent: 'scout', task: 'Scan the repo' }),
      toolResultEntry('c-abo', { error: 'Agent aborted: Subagent was aborted' }),
      customRecordEntry(record),
    ])
    const task = getTask('c-abo')
    expect(task?.status).toBe('aborted')
    expect(task?.details.stopReason).toBe('aborted')
    expect(task?.details.errorMessage).toContain('Subagent was aborted')
    expect(task?.details.agentSource).toBe('user')
  })

  test('status record overrides the details-derived status', () => {
    const record: SubagentTaskRecord = {
      toolCallId: 'c-mix',
      agent: 'coder',
      agentSource: 'builtin',
      task: 'Bump',
      status: 'error',
      startedAt: 1,
    }
    const details = emptyResult({ agent: 'coder', task: 'Bump', exitCode: 0 })
    restoreTasks([
      toolCallEntry('c-mix', { agent: 'coder', task: 'Bump' }),
      toolResultEntry('c-mix', { details }),
      customRecordEntry(record),
    ])
    expect(getTask('c-mix')?.status).toBe('error')
    expect(getTask('c-mix')?.details.exitCode).toBe(1)
  })

  test('old failed run without a record is restored as error from the error text', () => {
    restoreTasks([
      toolCallEntry('c-old', { agent: 'coder', task: 'Bump' }),
      toolResultEntry('c-old', { error: 'Agent failed: boom' }),
    ])
    const task = getTask('c-old')
    expect(task?.status).toBe('error')
    expect(task?.details.errorMessage).toBe('Agent failed: boom')
  })

  test('interrupted call with no result is restored as aborted', () => {
    restoreTasks([toolCallEntry('c-cut', { agent: 'planner', task: 'Plan' })])
    const task = getTask('c-cut')
    expect(task?.status).toBe('aborted')
    expect(task?.details.errorMessage).toContain('interrupted')
  })

  test('does not clobber a task that is still running in this process', () => {
    const running = { agent: 'reviewer', task: 'Review' }
    addTask('c-live', emptyResult(running))
    // Session shows the call without a result yet - restore must skip it.
    restoreTasks([toolCallEntry('c-live', running)])
    expect(getTask('c-live')?.status).toBe('running')
  })

  test('restores in session order and is idempotent', () => {
    const entries = [
      toolCallEntry('c-1', { agent: 'a', task: '1' }),
      toolResultEntry('c-1', { details: emptyResult({ agent: 'a', task: '1' }) }),
      toolCallEntry('c-2', { agent: 'b', task: '2' }),
      toolResultEntry('c-2', { details: emptyResult({ agent: 'b', task: '2' }) }),
    ]
    restoreTasks(entries)
    restoreTasks(entries)
    const ids = getTasks().map((t) => t.toolCallId)
    expect(ids).toEqual(['c-1', 'c-2'])
    expect(getTasks().length).toBe(2)
  })
})
