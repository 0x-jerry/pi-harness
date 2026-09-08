/**
 * TUI rendering for the subagent tool call and result.
 *
 * The transcript is rebuilt on every state update from the run's message
 * stream: assistant text always renders in full, reasoning (thinking blocks)
 * streams while it is being generated and collapses to a truncated preview as
 * soon as it completes, and every tool call renders as a single row with its
 * name, arguments, and its execution duration. The inline tool result
 * renders a windowed transcript: the first user prompt always pinned above
 * the last MAX_MESSAGES messages with what fell in between folded into a
 * "… N earlier messages" note, while the /subagents modal renders the full
 * transcript. Both usage footers identify the model as provider/model. Tool
 * results are matched to their calls by scanning the whole transcript, so
 * pairing also works across the window boundary. User messages reuse pi's
 * UserMessageComponent.
 */

import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type {
  AssistantMessage,
  Message,
  Model,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from '@earendil-works/pi-ai'
import {
  getMarkdownTheme,
  UserMessageComponent,
  type Theme,
  type ToolRenderResultOptions,
} from '@earendil-works/pi-coding-agent'
import {
  Container,
  Markdown,
  Spacer,
  Text,
  type Component,
  type MarkdownTheme,
} from '@earendil-works/pi-tui'
import { isFailedResult } from './result.ts'
import type { SubagentCallArgs } from './schema.ts'
import type { SubAgentResult } from './types.ts'

/** Tail window of transcript messages rendered in the inline tool result. */
export const MAX_MESSAGES = 5

/** Max length of a completed reasoning preview. */
const MESSAGE_PREVIEW_LENGTH = 200

/** Icon shown before reasoning (thinking) content. */
export const THINK_ICON = '💭 '

/** Icon shown before each tool call row. */
export const TOOL_ICON = '🔧 '

function formatTokens(count: number): string {
  if (count < 1000) return count.toString()
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1000000) return `${Math.round(count / 1000)}k`
  return `${(count / 1000000).toFixed(1)}M`
}

export function formatUsageStats(
  usage: Usage,
  model?: Model<any>,
): string {
  const parts: string[] = []
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`)
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`)
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`)
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`)
  if (usage.cost.total) parts.push(`$${usage.cost.total.toFixed(4)}`)
  if (usage.totalTokens > 0) parts.push(`ctx:${formatTokens(usage.totalTokens)}`)
  if (model)
    parts.push(model.provider ? `${model.provider}/${model.id}` : model.id)
  return parts.join(' ')
}

function userMessageText(message: UserMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content
    .filter((c): c is TextContent => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
}

/** Cut text to `max` chars, newlines preserved; ellipsis counts in the limit. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** Human-readable duration; non-finite or negative input renders as 0.0s. */
export function formatDuration(ms: number): string {
  const clamped = Number.isFinite(ms) ? Math.max(0, ms) : 0
  const seconds = clamped / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  return `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`
}

/** Tool call arguments as compact JSON. */
export function stringifyArgs(
  args: Record<string, any> | undefined,
): string {
  try {
    return JSON.stringify(args ?? {})
  } catch {
    return '{}'
  }
}

/** True while the assistant message is still being generated (deltas pending). */
export function isStreamingMessage(message: Message): boolean {
  return message.role === 'assistant' && message.stopReason === 'pending'
}

/** A thinking part is active while it is the still-growing tail of a live message. */
function thinkingIsActive(message: AssistantMessage, partIndex: number): boolean {
  return (
    isStreamingMessage(message) && partIndex === message.content.length - 1
  )
}

function isToolResultMessage(message: Message): message is ToolResultMessage {
  return message.role === 'toolResult'
}

/** The result matching a tool call, across the whole transcript. */
export function findToolResult(
  messages: Message[],
  toolCallId: string,
): ToolResultMessage | undefined {
  return messages.find(
    (
      message,
    ): message is ToolResultMessage =>
      isToolResultMessage(message) && message.toolCallId === toolCallId,
  )
}

export interface TranscriptItem {
  message: UserMessage | AssistantMessage
}

export interface TranscriptModel {
  /** Messages hidden between the pinned prompt and the tail window. */
  skipped: number
  /**
   * The first user prompt, always rendered once it scrolled out of the tail
   * window (inline tool result only).
   */
  pinned?: TranscriptItem
  /** The visible tail of user/assistant messages. */
  items: TranscriptItem[]
}

/** User/assistant messages in order; tool results stay folded into their call rows. */
function displayMessages(
  messages: Message[],
): (UserMessage | AssistantMessage)[] {
  return messages.filter(
    (message): message is UserMessage | AssistantMessage =>
      message.role === 'user' || message.role === 'assistant',
  )
}

/**
 * The inline tool result window: the first user prompt stays pinned above
 * the last MAX_MESSAGES user/assistant messages whenever the tail would
 * hide it, so the card always shows what the agent was asked to do. Tool
 * results are matched to their calls by scanning the whole transcript,
 * which also works across the window boundary.
 */
export function splitTranscript(messages: Message[]): TranscriptModel {
  const display = displayMessages(messages)
  const items = display.slice(-MAX_MESSAGES)
  const promptIndex = display.findIndex((message) => message.role === 'user')
  if (promptIndex !== -1 && promptIndex < display.length - items.length) {
    return {
      skipped: display.length - MAX_MESSAGES - 1,
      pinned: { message: display[promptIndex]! },
      items: items.map((message) => ({ message })),
    }
  }
  return {
    skipped: display.length - items.length,
    items: items.map((message) => ({ message })),
  }
}

/** Full transcript model for the /subagents modal: every message, nothing folded. */
function fullTranscript(messages: Message[]): TranscriptModel {
  const display = displayMessages(messages)
  return { skipped: 0, items: display.map((message) => ({ message })) }
}

/** Render one transcript message; returns [] when nothing should render. */
function renderTranscriptMessage(
  message: UserMessage | AssistantMessage,
  allMessages: Message[],
  theme: Theme,
  mdTheme: MarkdownTheme,
): Component[] {
  if (message.role === 'user') {
    const text = userMessageText(message)
    if (!text.trim()) return []
    return [new UserMessageComponent(text, mdTheme)]
  }
  return renderAssistantMessage(message, allMessages, theme, mdTheme)
}

/**
 * Render the transcript for one result view: 'windowed' pins the first user
 * prompt above the last MAX_MESSAGES messages (inline tool result), 'full'
 * renders every message (the /subagents modal).
 */
function renderTranscript(
  messages: Message[],
  theme: Theme,
  mode: 'windowed' | 'full',
): Component[] {
  const model =
    mode === 'windowed' ? splitTranscript(messages) : fullTranscript(messages)
  const mdTheme = getMarkdownTheme()
  const components: Component[] = []
  if (model.pinned) {
    components.push(
      ...renderTranscriptMessage(
        model.pinned.message,
        messages,
        theme,
        mdTheme,
      ),
    )
  }
  if (model.skipped > 0) {
    components.push(
      new Text(theme.fg('muted', `… ${model.skipped} earlier messages`), 0, 0),
    )
  }
  for (const { message } of model.items) {
    components.push(...renderTranscriptMessage(message, messages, theme, mdTheme))
  }
  return components
}

/**
 * Assistant message: reasoning streams while it is the growing tail of a
 * live message and otherwise collapses to its first line; text always
 * renders fully; each tool call becomes a single name/args/duration row.
 */
function renderAssistantMessage(
  message: AssistantMessage,
  allMessages: Message[],
  theme: Theme,
  mdTheme: MarkdownTheme,
): Component[] {
  const parts: Component[] = []
  for (let i = 0; i < message.content.length; i++) {
    const part = message.content[i]!
    if (part.type === 'thinking') {
      parts.push(...renderThinking(part, i, message, theme, mdTheme))
    } else if (part.type === 'text') {
      if (!part.text.trim()) continue
      parts.push(new Markdown(part.text.trim(), 1, 0, mdTheme))
    } else if (part.type === 'toolCall') {
      parts.push(renderToolCallRow(part, message, allMessages, theme))
    }
  }

  // Interrupted/failed turns get the same notice pi shows in the chat. Tool
  // calls surface their own error state, but the notice explains rows that
  // never received a result.
  if (
    message.stopReason === 'length' ||
    message.stopReason === 'aborted' ||
    message.stopReason === 'error'
  ) {
    const note =
      message.stopReason === 'length'
        ? 'Response was truncated before completion.'
        : message.stopReason === 'aborted'
          ? message.errorMessage && message.errorMessage !== 'Request was aborted'
            ? message.errorMessage
            : 'Operation aborted'
          : `Error: ${message.errorMessage || 'Unknown error'}`
    parts.push(new Text(theme.fg('error', note), 1, 0))
  }

  if (parts.length === 0) return parts
  parts.unshift(new Spacer(1))
  return parts
}

function renderThinking(
  part: ThinkingContent,
  index: number,
  message: AssistantMessage,
  theme: Theme,
  mdTheme: MarkdownTheme,
): Component[] {
  const text = part.thinking
  if (!text.trim()) return []
  const styled = (value: string) => theme.fg('thinkingText', theme.italic(value))
  if (thinkingIsActive(message, index)) {
    // Reasoning still being generated: stream the full content.
    return [
      new Markdown(THINK_ICON + text, 1, 0, mdTheme, {
        color: styled,
        italic: true,
      }),
    ]
  }
  // Reasoning complete: collapse to a truncated preview.
  return [new Text(styled(THINK_ICON + truncate(text, MESSAGE_PREVIEW_LENGTH)), 1, 0)]
}

function toolDuration(
  message: AssistantMessage,
  result: ToolResultMessage | undefined,
): string {
  // While a call is pending the duration reflects the last render time; no
  // timer is kept for the inline card (the modal re-renders every second).
  const end = result ? result.timestamp : Date.now()
  return formatDuration(end - message.timestamp)
}

function toolErrorText(result: ToolResultMessage): string {
  const text = result.content
    .filter((content): content is TextContent => content.type === 'text')
    .map((content) => content.text)
    .find((content) => content.trim())
  if (!text) return '(tool error)'
  return text
}

function renderToolCallRow(
  call: ToolCall,
  message: AssistantMessage,
  allMessages: Message[],
  theme: Theme,
): Component {
  const result = findToolResult(allMessages, call.id)
  let row = `${TOOL_ICON}${theme.fg('toolTitle', theme.bold(call.name))} `
  row += theme.fg('muted', stringifyArgs(call.arguments))
  row += ` ${theme.fg('dim', `· ${toolDuration(message, result)}`)}`
  if (result?.isError) {
    row += ` ${theme.fg('error', `✗ ${toolErrorText(result)}`)}`
  }
  return new Text(row, 1, 0)
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

/**
 * Result content for the /subagents modal: error/status header, system
 * prompt, the full transcript, and usage.
 */
export function renderFullResultContent(
  result: SubAgentResult,
  theme: Theme,
): Component {
  const isError = isFailedResult(result)
  const icon = isError ? theme.fg('error', '✗') : theme.fg('success', '✓')

  const container = new Container()
  let header = `${icon} ${theme.fg('toolTitle', theme.bold(result.agent))}${theme.fg('muted', ` (${result.agentSource})`)}`
  if (isError && result.stopReason)
    header += ` ${theme.fg('error', `[${result.stopReason}]`)}`
  container.addChild(new Text(header, 0, 0))
  if (isError && result.errorMessage)
    container.addChild(
      new Text(theme.fg('error', `Error: ${result.errorMessage}`), 0, 0),
    )

  if (result.systemPrompt) {
    container.addChild(new Spacer(1))
    container.addChild(
      new Text(theme.fg('muted', '─── System prompt ───'), 0, 0),
    )
    container.addChild(new Text(result.systemPrompt, 0, 0))
  }
  container.addChild(new Spacer(1))
  container.addChild(new Text(theme.fg('muted', '─── Transcript ───'), 0, 0))
  const transcript = renderTranscript(result.messages, theme, 'full')
  if (transcript.length === 0) {
    container.addChild(new Text(theme.fg('muted', '(no output)'), 0, 0))
  } else {
    for (const component of transcript) container.addChild(component)
  }

  const usageStr = formatUsageStats(result.usage, result.model)
  if (usageStr) {
    container.addChild(new Spacer(1))
    container.addChild(new Text(theme.fg('dim', usageStr), 0, 0))
  }
  return container
}

export function renderSubagentResult(
  result: AgentToolResult<SubAgentResult>,
  options: ToolRenderResultOptions,
  theme: Theme,
): Component {
  // Subagent rows always render the windowed transcript; the global expand
  // toggle is ignored.
  const r = result.details
  if (!r) {
    const text = result.content[0]
    return new Text(text?.type === 'text' ? text.text : '(no output)', 0, 0)
  }

  const isError = isFailedResult(r)
  const headerIcon = options.isPartial ? '⏳' : isError ? '✗' : '✓'
  const icon = theme.fg(isError ? 'error' : 'success', headerIcon)

  const container = new Container()
  let header = `${icon} ${theme.fg('toolTitle', theme.bold(r.agent))}${theme.fg('muted', ` (${r.agentSource})`)}`
  if (isError && r.stopReason)
    header += ` ${theme.fg('error', `[${r.stopReason}]`)}`
  container.addChild(new Text(header, 0, 0))
  if (isError && r.errorMessage)
    container.addChild(
      new Text(theme.fg('error', `Error: ${r.errorMessage}`), 0, 0),
    )

  const transcript = renderTranscript(r.messages, theme, 'windowed')
  if (transcript.length === 0) {
    container.addChild(new Text(theme.fg('muted', '(no output)'), 0, 0))
  } else {
    for (const component of transcript) container.addChild(component)
  }
  container.addChild(
    new Text(theme.fg('muted', 'run /subagents to browse agent tasks'), 0, 0),
  )

  const usageStr = formatUsageStats(r.usage, r.model)
  if (usageStr) {
    container.addChild(new Spacer(1))
    container.addChild(new Text(theme.fg('dim', usageStr), 0, 0))
  }
  return container
}
