/**
 * Interactive ask dialog.
 *
 * Walks through the questions one at a time. Each question renders its
 * options in a SelectList with a trailing "✎ Type a custom answer…" choice
 * that opens an inline Editor when none of the options fit.
 *
 * Navigation: arrow keys move within the options, number keys 1-9 jump to an
 * option, Enter selects, ← goes to the previous question, → goes to the
 * next question (past the last one opens the review step), and Esc cancels
 * (or leaves the editor back to the options).
 *
 * Already-picked options are marked with a check mark; a typed custom answer
 * replaces the "✎ Type a custom answer…" entry and Enter re-opens it for
 * editing.
 *
 * After the last question is answered the dialog moves to a review step that
 * lists every question with its answer and offers Submit / Edit answers
 * (Esc there cancels the whole flow). Selections are reported through `done`.
 */

import type { Theme } from '@earendil-works/pi-coding-agent'
import {
  decodeKittyPrintable,
  Editor,
  type EditorTheme,
  isKittyProtocolActive,
  Key,
  type KeybindingsManager,
  matchesKey,
  type SelectItem,
  SelectList,
  type TUI,
  type Component,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui'
import type { AskItem } from './schema.ts'

/** Marker value for the trailing "type a custom answer" option. */
const CUSTOM_VALUE = 'custom'

/** Marker values for the review step's action list. */
const ACTION_SUBMIT = 'submit'
const ACTION_EDIT = 'edit'

/** Indent for the answer line in the review step. */
const ANSWER_INDENT = '    '

/** Maximum questions listed in the review step before collapsing. */
const MAX_REVIEW_QUESTIONS = 10

/** Payload reported by the dialog when it completes or is cancelled. */
export interface AskDialogResult {
  /** Selected option index per question; null for custom/unanswered items. */
  selected: (number | null)[]
  /** Typed custom answer per question; null when an option was picked. */
  customAnswers: (string | null)[]
  cancelled: boolean
  cancelledAt?: number
}

/** Shared SelectList theme for both the options and the review action list. */
function selectListTheme(theme: Theme) {
  return {
    selectedPrefix: (t: string) => theme.fg('accent', t),
    selectedText: (t: string) => theme.fg('accent', t),
    description: (t: string) => theme.fg('muted', t),
    scrollInfo: (t: string) => theme.fg('dim', t),
    noMatch: (t: string) => theme.fg('warning', t),
  }
}

/** One-line answer summary for the review step. */
function answerSummary(
  item: AskItem,
  optIndex: number | null,
  custom: string | null,
): string {
  if (custom != null) return `✎ ${custom}`
  if (optIndex != null) return (item.options[optIndex] ?? '(no answer)')
  return '(no answer)'
}

/**
 * Build the `ctx.ui.custom` factory for the ask dialog.
 *
 * The returned factory matches pi's custom-component signature: it receives
 * the TUI, theme, keybindings, and a `done` callback, and returns a
 * renderable component.
 */
export function createAskDialog(items: AskItem[]) {
  return function dialogFactory(
    tui: TUI,
    theme: Theme,
    _kb: KeybindingsManager,
    done: (result: AskDialogResult | null) => void,
  ): Component {
    let cachedLines: string[] | undefined

    const total = items.length
    const isBatch = total > 1
    const selected: (number | null)[] = items.map(() => null)
    const customAnswers: (string | null)[] = items.map(() => null)
    let index = 0
    let editMode = false
    let confirmMode = false
    let selectList: SelectList
    let confirmList: SelectList

    const themeList = selectListTheme(theme)
    const editorTheme: EditorTheme = {
      borderColor: (s) => theme.fg('accent', s),
      selectList: themeList,
    }
    const editor = new Editor(tui, editorTheme)

    /** Record the current question's answer, then advance or open the review. */
    function afterAnswer() {
      if (index === total - 1) {
        openConfirm()
        return
      }
      index++
      editMode = false
      makeSelectList()
      refresh()
    }

    /** Open the review step with the Submit action pre-selected. */
    function openConfirm() {
      confirmMode = true
      confirmList.setSelectedIndex(0)
      refresh()
    }

    /** Move to a question, showing its option list (custom entry selected when answered). */
    function goToQuestion(newIndex: number) {
      index = newIndex
      showOptions()
    }

    /** Leave the editor and show the current question's (rebuilt) options. */
    function showOptions(landOnCustom = false) {
      editMode = false
      makeSelectList()
      // Land on the custom entry when leaving the editor or when an answer
      // was typed there (so Enter re-opens the editor), otherwise restore
      // the picked option.
      const current = items[index]!
      selectList.setSelectedIndex(
        landOnCustom || customAnswers[index] != null
          ? current.options.length
          : (selected[index] ?? 0),
      )
      refresh()
    }

    editor.onSubmit = (value) => {
      const trimmed = value.trim()
      if (!trimmed) {
        editor.setText('')
        refresh()
        return
      }
      customAnswers[index] = trimmed
      selected[index] = null
      afterAnswer()
    }

    /** (Re)build the option list for the current question. */
    function makeSelectList() {
      const item = items[index]!
      const chosen = selected[index]
      const custom = customAnswers[index]
      const numberedItems: SelectItem[] = [
        // The picked option is marked with a check mark at the end via
        // truncatePrimary (see layout below) so it survives truncation.
        ...item.options.map((opt, i) => ({
          value: `${i}`,
          label: `${i + 1}. ${opt}`,
        })),
        // Once a custom answer exists, it replaces the prompt label; Enter
        // on it re-opens the editor to edit it.
        {
          value: CUSTOM_VALUE,
          label:
            custom != null ? `✎ ${custom}` : '✎ Type a custom answer…',
        },
      ]
      selectList = new SelectList(
        numberedItems,
        Math.min(numberedItems.length, 10),
        themeList,
        {
          // SelectList truncates labels from the end, which would cut off a
          // trailing check mark; reserve room for it when the option is the
          // one that was picked.
          truncatePrimary: ({ text, maxWidth, item }) => {
            const marked =
              item.value !== CUSTOM_VALUE && chosen === Number(item.value)
            const base = truncateToWidth(
              text,
              Math.max(1, maxWidth - (marked ? 2 : 0)),
              '…',
            )
            return marked ? `${base} ✓` : base
          },
        },
      )
      selectList.onSelect = (it) => {
        if (it.value === CUSTOM_VALUE) {
          editMode = true
          editor.setText(customAnswers[index] ?? '')
          refresh()
          return
        }
        selected[index] = Number(it.value)
        customAnswers[index] = null
        afterAnswer()
      }
      selectList.onCancel = () =>
        done({ selected, customAnswers, cancelled: true, cancelledAt: index })
    }
    makeSelectList()

    /** (Re)build the review step's action list. */
    function makeConfirmList() {
      confirmList = new SelectList(
        [
          { value: ACTION_SUBMIT, label: '✓ Submit answers' },
          { value: ACTION_EDIT, label: '← Edit answers' },
        ],
        2,
        themeList,
      )
      confirmList.onSelect = (it) => {
        if (it.value === ACTION_SUBMIT) {
          done({ selected, customAnswers, cancelled: false })
          return
        }
        confirmMode = false
        goToQuestion(total - 1)
      }
      confirmList.onCancel = () =>
        done({ selected, customAnswers, cancelled: true, cancelledAt: total - 1 })
    }
    makeConfirmList()

    function refresh() {
      cachedLines = undefined
      tui.requestRender()
    }

    function handleInput(data: string) {
      // Review step: submit, edit answers, or cancel.
      if (confirmMode) {
        confirmList.handleInput(data)
        refresh()
        return
      }

      // Editor mode: type the custom answer; Esc returns to options.
      if (editMode) {
        if (matchesKey(data, Key.escape)) {
          showOptions(true)
          return
        }
        editor.handleInput(data)
        refresh()
        return
      }

      const current = items[index]!
      // Number keys 1-9 jump straight to an option.
      const ch = isKittyProtocolActive()
        ? (decodeKittyPrintable(data) ?? data)
        : data
      if (/^[1-9]$/.test(ch)) {
        const n = Number(ch)
        if (n <= current.options.length) {
          selected[index] = n - 1
          customAnswers[index] = null
          afterAnswer()
          return
        }
      }

      // ←: previous question (only before the first).
      if (matchesKey(data, Key.left)) {
        if (index > 0) goToQuestion(index - 1)
        return
      }
      // →: next question; past the last one opens the review step.
      if (matchesKey(data, Key.right)) {
        if (index === total - 1) {
          openConfirm()
        } else {
          goToQuestion(index + 1)
        }
        return
      }

      selectList.handleInput(data)
      refresh()
    }

    function render(width: number): string[] {
      if (cachedLines) return cachedLines

      const lines: string[] = []
      const renderWidth = Math.max(1, width)

      function addWrapped(text: string) {
        lines.push(...wrapTextWithAnsi(text, renderWidth))
      }

      function addWrappedWithPrefix(prefix: string, text: string) {
        const prefixWidth = visibleWidth(prefix)
        if (prefixWidth >= renderWidth) {
          addWrapped(prefix + text)
          return
        }
        const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth)
        const continuationPrefix = ' '.repeat(prefixWidth)
        for (let i = 0; i < wrapped.length; i++) {
          lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`)
        }
      }

      lines.push(theme.fg('accent', '─'.repeat(renderWidth)))

      if (confirmMode) {
        addWrappedWithPrefix(' ', theme.fg('text', 'Review your answers'))
        lines.push('')
        for (let i = 0; i < items.length; i++) {
          if (i === MAX_REVIEW_QUESTIONS) {
            const remaining = items.length - i
            addWrappedWithPrefix(
              ' ',
              theme.fg(
                'dim',
                `… and ${remaining} more question${remaining > 1 ? 's' : ''}`,
              ),
            )
            break
          }
          const item = items[i]!
          addWrappedWithPrefix(' ', theme.fg('text', `${i + 1}. ${item.question}`))
          const summary = answerSummary(
            item,
            selected[i] ?? null,
            customAnswers[i] ?? null,
          )
          const color = summary === '(no answer)' ? 'muted' : 'accent'
          addWrappedWithPrefix(ANSWER_INDENT, theme.fg(color, `A: ${summary}`))
        }
        lines.push('')
        for (const line of confirmList.render(Math.max(1, renderWidth - 2))) {
          lines.push(` ${line}`)
        }
        lines.push('')
        addWrappedWithPrefix(
          ' ',
          theme.fg('dim', '↑↓ navigate • Enter select • Esc cancel'),
        )
      } else {
        const current = items[index]!
        const header = isBatch
          ? `${index + 1}/${total}  ${current.question}`
          : current.question
        addWrappedWithPrefix(' ', theme.fg('text', header))
        if (current.description) {
          lines.push('')
          addWrappedWithPrefix(' ', theme.fg('muted', current.description))
        }
        lines.push('')

        if (editMode) {
          addWrappedWithPrefix(' ', theme.fg('dim', 'Your answer:'))
          for (const line of editor.render(Math.max(1, renderWidth - 2))) {
            lines.push(` ${line}`)
          }
        } else {
          for (const line of selectList.render(Math.max(1, renderWidth - 2))) {
            lines.push(` ${line}`)
          }
        }

        lines.push('')
        const hints = editMode
          ? ['Enter to submit', 'Esc back to options']
          : [
              '↑↓ navigate',
              '1-9 jump',
              'Enter select',
              '✎ custom answer',
              '← → questions',
              'Esc cancel',
            ]
        addWrappedWithPrefix(' ', theme.fg('dim', hints.join(' • ')))
      }

      lines.push(theme.fg('accent', '─'.repeat(renderWidth)))

      cachedLines = lines
      return lines
    }

    return {
      render,
      invalidate: () => {
        cachedLines = undefined
      },
      handleInput,
    }
  }
}
