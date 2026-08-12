/**
 * TUI rendering for the subagent tool call and result.
 *
 * The result transcript is rendered the same way pi's interactive chat
 * renders its own messages: user messages via `UserMessageComponent`,
 * assistant text/thinking via `AssistantMessageComponent` (with the same
 * thinking styling, truncation notices, and stop-reason handling), and tool
 * calls paired with their results via `ToolExecutionComponent` (which uses
 * pi's built-in per-tool renderers). Collapsed view shows the tail of the
 * transcript with thinking collapsed to a label; Ctrl+O expands everything.
 */

import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { Message, TextContent, UserMessage } from '@earendil-works/pi-ai'
import {
  AssistantMessageComponent,
  getMarkdownTheme,
  ToolExecutionComponent,
  UserMessageComponent,
  type Theme,
  type ToolRenderResultOptions,
} from '@earendil-works/pi-coding-agent'
import {
  Container,
  Spacer,
  Text,
  type Component,
  type TUI,
} from '@earendil-works/pi-tui'
import { isFailedResult } from './result.ts'
import type { SubagentCallArgs } from './schema.ts'
import type { SingleResult } from './types.ts'

/** Messages shown in the collapsed result (tail of the transcript). */
const COLLAPSED_MESSAGE_COUNT = 4

/**
 * ToolExecutionComponent only calls `requestRender()` on the TUI for
 * redraw scheduling; embedded in a static result it is a no-op.
 */
const STUB_TUI = { requestRender: () => {} } as unknown as TUI

function formatTokens(count: number): string {
  if (count < 1000) return count.toString()
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1000000) return `${Math.round(count / 1000)}k`
  return `${(count / 1000000).toFixed(1)}M`
}

function formatUsageStats(
  usage: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    cost: number
    contextTokens?: number
    turns?: number
  },
  model?: string,
): string {
  const parts: string[] = []
  if (usage.turns)
    parts.push(`${usage.turns} turn${usage.turns > 1 ? 's' : ''}`)
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`)
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`)
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`)
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`)
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`)
  if (usage.contextTokens && usage.contextTokens > 0) {
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`)
  }
  if (model) parts.push(model)
  return parts.join(' ')
}

function userMessageText(message: UserMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content
    .filter((c): c is TextContent => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
}

interface TranscriptOptions {
  messages: Message[]
  /** Working directory of the subagent (for built-in tool renderers). */
  cwd: string
  /** Expand tool executions (full output instead of truncated). */
  expanded: boolean
  /** Collapse thinking blocks to a single "Thinking…" label. */
  hideThinking: boolean
}

/**
 * Render subagent messages exactly like pi's interactive chat: user messages
 * in `UserMessageComponent`, assistant text/thinking in
 * `AssistantMessageComponent`, and each tool call in a `ToolExecutionComponent`
 * that receives its matching `toolResult` (same pairing logic as pi's
 * `renderSessionItems`).
 */
function renderTranscript(options: TranscriptOptions): Component[] {
  const { messages, cwd, expanded, hideThinking } = options
  const mdTheme = getMarkdownTheme()
  const pendingTools = new Map<string, ToolExecutionComponent>()
  const components: Component[] = []

  for (const message of messages) {
    if (message.role === 'assistant') {
      components.push(
        new AssistantMessageComponent(message, hideThinking, mdTheme),
      )
      for (const content of message.content) {
        if (content.type !== 'toolCall') continue
        const toolComp = new ToolExecutionComponent(
          content.name,
          content.id,
          content.arguments,
          { showImages: false },
          undefined,
          STUB_TUI,
          cwd,
        )
        toolComp.setExpanded(expanded)
        components.push(toolComp)

        if (
          message.stopReason === 'aborted' ||
          message.stopReason === 'error'
        ) {
          // Same error text pi shows for failed tool calls.
          const errorText =
            message.stopReason === 'aborted'
              ? message.errorMessage &&
                  message.errorMessage !== 'Request was aborted'
                ? message.errorMessage
                : 'Operation aborted'
              : message.errorMessage || 'Error'
          toolComp.updateResult({
            content: [{ type: 'text', text: errorText }],
            isError: true,
          })
        } else {
          pendingTools.set(content.id, toolComp)
        }
      }
    } else if (message.role === 'toolResult') {
      const toolComp = pendingTools.get(message.toolCallId)
      if (toolComp) {
        toolComp.updateResult(message)
        pendingTools.delete(message.toolCallId)
      }
    } else if (message.role === 'user') {
      const text = userMessageText(message)
      if (text.trim()) components.push(new UserMessageComponent(text, mdTheme))
    }
  }
  return components
}

export function renderSubagentCall(
  args: SubagentCallArgs,
  theme: Theme,
): Component {
  const agentName = args.agent || '...'
  const preview = args.task
    ? args.task.length > 60
      ? `${args.task.slice(0, 60)}...`
      : args.task
    : '...'
  let text =
    theme.fg('toolTitle', theme.bold('subagent ')) +
    theme.fg('accent', agentName)
  text += `\n  ${theme.fg('dim', preview)}`
  return new Text(text, 0, 0)
}

export function renderSubagentResult(
  result: AgentToolResult<SingleResult>,
  options: ToolRenderResultOptions,
  theme: Theme,
): Component {
  const { expanded } = options
  const r = result.details
  if (!r) {
    const text = result.content[0]
    return new Text(text?.type === 'text' ? text.text : '(no output)', 0, 0)
  }

  const isError = isFailedResult(r)
  const icon = isError ? theme.fg('error', '✗') : theme.fg('success', '✓')
  const cwd = r.cwd ?? process.cwd()

  const container = new Container()
  let header = `${icon} ${theme.fg('toolTitle', theme.bold(r.agent))}${theme.fg('muted', ` (${r.agentSource})`)}`
  if (isError && r.stopReason)
    header += ` ${theme.fg('error', `[${r.stopReason}]`)}`
  container.addChild(new Text(header, 0, 0))
  if (isError && r.errorMessage)
    container.addChild(
      new Text(theme.fg('error', `Error: ${r.errorMessage}`), 0, 0),
    )

  if (expanded) {
    container.addChild(new Spacer(1))
    container.addChild(new Text(theme.fg('muted', '─── Transcript ───'), 0, 0))
    const transcript = renderTranscript({
      messages: r.messages,
      cwd,
      expanded: true,
      hideThinking: false,
    })
    if (transcript.length === 0) {
      container.addChild(new Text(theme.fg('muted', '(no output)'), 0, 0))
    } else {
      for (const component of transcript) container.addChild(component)
    }
  } else {
    const skipped = Math.max(0, r.messages.length - COLLAPSED_MESSAGE_COUNT)
    if (skipped > 0)
      container.addChild(
        new Text(theme.fg('muted', `… ${skipped} earlier messages`), 0, 0),
      )
    const transcript = renderTranscript({
      messages: r.messages.slice(-COLLAPSED_MESSAGE_COUNT),
      cwd,
      expanded: false,
      hideThinking: true,
    })
    if (transcript.length === 0) {
      container.addChild(new Text(theme.fg('muted', '(no output)'), 0, 0))
    } else {
      for (const component of transcript) container.addChild(component)
    }
    if (skipped > 0)
      container.addChild(
        new Text(theme.fg('muted', '(Ctrl+O to expand)'), 0, 0),
      )
  }

  const usageStr = formatUsageStats(r.usage, r.model)
  if (usageStr) {
    container.addChild(new Spacer(1))
    container.addChild(new Text(theme.fg('dim', usageStr), 0, 0))
  }
  return container
}
