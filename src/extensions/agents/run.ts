/**
 * Runs a subagent as a separate `pi` process in JSON mode and streams its
 * event stream (messages, usage, tool calls) back to the parent session.
 */

import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Message } from '@earendil-works/pi-ai'
import { emptyResult, getFinalOutput } from './result.ts'
import type { AgentConfig, OnUpdateCallback, SingleResult } from './types.ts'

/**
 * Figure out how to invoke pi from inside the current pi process.
 * Falls back to the `pi` executable on PATH when running from a bundled binary.
 */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1]
  const isBunVirtualScript = currentScript?.startsWith('/$bunfs/root/')
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] }
  }

  const execName = path.basename(process.execPath).toLowerCase()
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName)
  if (!isGenericRuntime) {
    return { command: process.execPath, args }
  }

  return { command: 'pi', args }
}

export interface RunSingleAgentOptions {
  agents: AgentConfig[]
  agentName: string
  task: string
  /** Directory used when no explicit `cwd` is given. */
  defaultCwd: string
  /** Working directory for the subagent process. */
  cwd?: string
  signal?: AbortSignal
  onUpdate?: OnUpdateCallback
  parentModel?: string
}

export async function runSingleAgent(
  options: RunSingleAgentOptions,
): Promise<SingleResult> {
  const {
    agents,
    agentName,
    task,
    defaultCwd,
    cwd,
    signal,
    onUpdate,
    parentModel,
  } = options
  const agent = agents.find((a) => a.name === agentName)

  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(', ') || 'none'
    return emptyResult({
      agent: agentName,
      task,
      exitCode: 1,
      stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
    })
  }

  const args: string[] = ['--mode', 'json', '-p', '--no-session']
  // Agent-specified model wins; otherwise inherit the parent's active model
  // so the subagent behaves like the current session instead of the default.
  if (agent.model) args.push('--model', agent.model)
  else if (parentModel) args.push('--model', parentModel)
  if (agent.tools && agent.tools.length > 0)
    args.push('--tools', agent.tools.join(','))

  const currentResult: SingleResult = emptyResult({
    agent: agentName,
    task,
    agentSource: agent.source,
    model: agent.model,
  })

  const emitUpdate = () => {
    if (onUpdate) {
      onUpdate({
        content: [
          {
            type: 'text',
            text: getFinalOutput(currentResult.messages) || '(running...)',
          },
        ],
        details: currentResult,
      })
    }
  }

  if (agent.systemPrompt.trim()) {
    // Override pi's default system prompt with the agent's own file
    // (frontmatter + body); tool definitions are still passed separately
    // so tools keep working.
    args.push('--system-prompt', agent.filePath)
  }

  args.push(`Task: ${task}`)
  let wasAborted = false

  const exitCode = await new Promise<number>((resolve) => {
    const invocation = getPiInvocation(args)
    const proc = spawn(invocation.command, invocation.args, {
      cwd: cwd ?? defaultCwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let buffer = ''

    const processLine = (line: string) => {
      if (!line.trim()) return
      let event: any
      try {
        event = JSON.parse(line)
      } catch {
        return
      }

      // In --mode json, every message (user, assistant, toolResult) is
      // delivered as a `message_end` event.
      if (event.type === 'message_end' && event.message) {
        const msg = event.message as Message
        currentResult.messages.push(msg)

        if (msg.role === 'assistant') {
          currentResult.usage.turns++
          const usage = msg.usage
          if (usage) {
            currentResult.usage.input += usage.input || 0
            currentResult.usage.output += usage.output || 0
            currentResult.usage.cacheRead += usage.cacheRead || 0
            currentResult.usage.cacheWrite += usage.cacheWrite || 0
            currentResult.usage.cost += usage.cost?.total || 0
            currentResult.usage.contextTokens = usage.totalTokens || 0
          }
          if (!currentResult.model && msg.model)
            currentResult.model = msg.model
          if (msg.stopReason) currentResult.stopReason = msg.stopReason
          if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage
        }
        emitUpdate()
      }
    }

    proc.stdout.on('data', (data) => {
      buffer += data.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) processLine(line)
    })

    proc.stderr.on('data', (data) => {
      currentResult.stderr += data.toString()
    })

    proc.on('close', (code) => {
      if (buffer.trim()) processLine(buffer)
      resolve(code ?? 0)
    })

    proc.on('error', () => {
      resolve(1)
    })

    if (signal) {
      const killProc = () => {
        wasAborted = true
        proc.kill('SIGTERM')
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL')
        }, 5000)
      }
      if (signal.aborted) killProc()
      else signal.addEventListener('abort', killProc, { once: true })
    }
  })

  currentResult.exitCode = exitCode
  if (wasAborted) throw new Error('Subagent was aborted')
  return currentResult
}
