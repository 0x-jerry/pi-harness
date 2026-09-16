/**
 * Execution logic for the ask tool: argument validation, the interactive
 * dialog, and result assembly.
 */

import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { createAskDialog, type AskDialogResult } from './dialog.ts'
import type { AskDetails, AskItemDetails } from './render.ts'
import type { AskItem } from './schema.ts'

/** Details entries with no answers (error and cancel paths). */
function blankItemDetails(items: AskItem[]): AskItemDetails[] {
  return items.map((it) => ({
    question: it.question,
    description: it.description,
    options: it.options.map((o) => o.label),
    answer: null,
    index: null,
    custom: false,
  }))
}

function result(
  text: string,
  details: AskDetails,
): AgentToolResult<AskDetails> {
  return { content: [{ type: 'text', text }], details }
}

/** Per-question answers assembled from the dialog result. */
function buildItemDetails(
  items: AskItem[],
  dialogResult: AskDialogResult,
): AskItemDetails[] {
  return items.map((it, i) => {
    const optIndex = dialogResult.selected[i] ?? null
    const custom = dialogResult.customAnswers[i] ?? null
    return {
      question: it.question,
      description: it.description,
      options: it.options.map((o) => o.label),
      answer:
        custom != null
          ? custom
          : optIndex == null
            ? null
            : (it.options[optIndex]?.label ?? null),
      index: optIndex,
      custom: custom != null,
    }
  })
}

/** Human-readable summary of the answers returned to the model. */
function buildResultContent(
  items: AskItem[],
  itemDetails: AskItemDetails[],
): string {
  const pairs = items
    .map((it, i) => {
      const d = itemDetails[i]!
      const ans = d.custom
        ? `custom: ${d.answer}`
        : (d.answer ?? '(no answer)')
      return `${i + 1}. ${it.question} → ${ans}`
    })
    .join('\n')

  if (items.length > 1) {
    return `User answered all ${items.length} questions:\n${pairs}`
  }
  const single = itemDetails[0]
  if (single?.custom) return `User answered: ${single.answer}`
  if (single?.answer != null) return `User selected: ${single.answer}`
  return `User answered: (no answer)`
}

/**
 * Validate the arguments and run the ask flow.
 *
 * Non-interactive modes and malformed input return an error result instead
 * of blocking; otherwise the interactive dialog runs. User cancellation
 * throws, which marks the tool call as failed. A completed dialog is
 * assembled into `AskDetails`.
 */
export async function executeAsk(
  items: AskItem[],
  ctx: ExtensionContext,
): Promise<AgentToolResult<AskDetails>> {
  if (items.length === 0) {
    return result(
      'Error: `questions` must be a non-empty array of { question, options } objects with options as { label, description? } entries.',
      { items: [], cancelled: true },
    )
  }

  const invalid = items.findIndex(
    (it) => !it.options || it.options.length === 0,
  )
  if (invalid >= 0) {
    return result(
      `Error: question ${invalid + 1} has an empty \`options\` array; each question needs at least one option.`,
      { items: blankItemDetails(items), cancelled: true, cancelledAt: invalid },
    )
  }

  if (ctx.mode !== 'tui') {
    return result(
      'Error: ask requires an interactive terminal (TUI mode).',
      { items: blankItemDetails(items), cancelled: true, cancelledAt: 0 },
    )
  }

  const dialogResult = await ctx.ui.custom<AskDialogResult | null>(
    createAskDialog(items),
  )

  // The dialog never reports null on its own, but a disposed/aborted custom
  // UI can resolve without a payload — treat that as a cancellation.
  if (!dialogResult || dialogResult.cancelled) {
    throw new Error('User cancelled the question.')
  }

  const itemDetails = buildItemDetails(items, dialogResult)
  return result(buildResultContent(items, itemDetails), {
    items: itemDetails,
    cancelled: false,
  })
}
