import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { Message } from '@earendil-works/pi-ai'

/** Where an agent definition lives. */
export type AgentSource = 'user' | 'project' | 'prompt'

export interface AgentConfig {
  name: string
  description: string
  tools?: string[]
  model?: string
  systemPrompt: string
  source: AgentSource
  filePath: string
}

export interface UsageStats {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  contextTokens: number
  turns: number
}

/** Result of one subagent run. */
export interface SingleResult {
  agent: string
  agentSource: AgentSource | 'unknown'
  task: string
  /** Working directory the subagent ran in (for rendering tool paths). */
  cwd?: string
  exitCode: number
  messages: Message[]
  stderr: string
  usage: UsageStats
  model?: string
  stopReason?: string
  errorMessage?: string
}

export type OnUpdateCallback = (
  partial: AgentToolResult<SingleResult>,
) => void
