/**
 * Ask Tool - entry point.
 *
 * Registers the `ask` tool with pi. The interactive dialog lives in
 * ./dialog.ts, validation/result assembly in ./execute.ts, and the
 * TUI rendering in ./render.ts.
 *
 * Usage:
 *   { questions: [{ question: "...", options: ["a", "b", "c"] }] }
 *   { questions: [
 *       { question: "q1", description?: "...", options: ["yes", "no"] },
 *       { question: "q2", options: ["x", "y", "z"] },
 *     ]
 *   }
 *
 * Keyboard: ↑↓/1-9 pick options, Enter selects, ←/→ moves between questions,
 * Esc cancels. After the last question a review step asks for confirmation
 * before the answers are submitted.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { executeAsk } from './execute.ts'
import { renderAskCall, renderAskResult, resolveItems } from './render.ts'
import { AskParams } from './schema.ts'

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'ask',
    label: 'Ask',
    description: [
      'Ask the user one or more questions and let them pick from the provided options, or type a custom answer when none fit.',
      'Pass `questions` as an array of { question, description?, options } items; each question is answered one at a time in a single dialog with its own options list.',
      'If the user cancels the dialog, the tool fails with an error — treat that as "the user declined to answer".',
      'Use this when you need a decision, preference, or choice that only the user can make, instead of guessing or assuming.',
    ].join(' '),
    promptSnippet:
      'Ask the user to pick from options (or type a custom answer) for one or more questions',
    parameters: AskParams,
    executionMode: 'sequential',

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return executeAsk(resolveItems(params), ctx)
    },

    renderCall: renderAskCall,
    renderResult: renderAskResult,
  })
}
