/**
 * TUI rendering for the ask tool call and result.
 */

import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type {
  Theme,
  ToolRenderResultOptions,
} from '@earendil-works/pi-coding-agent'
import { Text, type Component } from '@earendil-works/pi-tui'
import type { AskCallArgs, AskItem } from './schema.ts'

/** Per-question outcome, aligned with the `items` array in AskDetails. */
export interface AskItemDetails {
  question: string
  description?: string
  options: string[]
  /** Selected answer, or null when cancelled. */
  answer: string | null
  /** 0-based index of the selected option, or null when cancelled/custom. */
  index: number | null
  /** True when the user typed a custom answer instead of picking an option. */
  custom: boolean
}

export interface AskDetails {
  /** One entry per question asked, in order. */
  items: AskItemDetails[]
  /** True when the user cancelled before answering everything. */
  cancelled: boolean
  /** 0-based index of the question the user was on when cancelling. */
  cancelledAt?: number
}

export function resolveItems(args: AskCallArgs): AskItem[] {
  return args.questions ?? []
}

export function renderAskCall(
  args: AskCallArgs,
  theme: Theme,
): Component {
  const items = resolveItems(args)

  if (items.length === 0) {
    return new Text(
      theme.fg('toolTitle', theme.bold('ask ')) +
        theme.fg('warning', '(no questions)'),
      0,
      0,
    )
  }

  const first = items[0]!
  const isBatch = items.length > 1
  const prefix = isBatch ? `1/${items.length} ` : ''
  let text =
    theme.fg('toolTitle', theme.bold('ask ')) +
    theme.fg('accent', `${prefix}${first.question}`)
  if (isBatch) {
    text += `\n  ${theme.fg('dim', `+${items.length - 1} more question${items.length > 2 ? 's' : ''}`)}`
  }
  if (first.description) {
    text += `\n  ${theme.fg('muted', first.description)}`
  }
  const numbered = first.options
    .map((o, i) => `${i + 1}. ${o.label}`)
    .join(', ')
  text += `\n${theme.fg('dim', `  Options: ${numbered}`)}`
  return new Text(text, 0, 0)
}

export function renderAskResult(
  result: AgentToolResult<AskDetails>,
  _options: ToolRenderResultOptions,
  theme: Theme,
): Component {
  const details = result.details
  if (!details) {
    const text = result.content[0]
    return new Text(text?.type === 'text' ? text.text : '', 0, 0)
  }

  if (details.cancelled) {
    const where =
      details.items.length > 1
        ? ` (q${(details.cancelledAt ?? 0) + 1}/${details.items.length})`
        : ''
    return new Text(theme.fg('warning', `✗ cancelled${where}`), 0, 0)
  }

  if (details.items.length <= 1) {
    const item = details.items[0]
    const prefix = item?.custom ? '✓ ✎ ' : '✓ '
    return new Text(
      theme.fg('success', prefix) +
        theme.fg('accent', item?.answer ?? '—'),
      0,
      0,
    )
  }

  const answered = details.items
    .map(
      (item, i) =>
        `${i + 1}. ${item.custom ? '✎ ' : ''}${item.answer ?? '—'}`,
    )
    .join(' • ')
  return new Text(theme.fg('success', '✓ ') + theme.fg('accent', answered), 0, 0)
}
