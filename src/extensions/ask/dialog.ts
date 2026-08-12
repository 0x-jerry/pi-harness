/**
 * Interactive ask dialog.
 *
 * Walks through the questions one at a time. Each question renders its
 * options in a SelectList with a trailing "✎ Type a custom answer…" choice
 * that opens an inline Editor when none of the options fit. Arrow keys
 * navigate, number keys 1-9 jump to an option, Enter selects (and advances
 * in a batch), Ctrl+P goes back, Esc cancels (or leaves the editor back to
 * the options). Per-question selections are reported through `done`.
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
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui'
import type { AskItem } from './schema.ts'

/** Marker value for the trailing "type a custom answer" option. */
const CUSTOM_VALUE = 'custom'

/** Payload reported by the dialog when it completes or is cancelled. */
export interface AskDialogResult {
  /** Selected option index per question; null for custom/unanswered items. */
  selected: (number | null)[]
  /** Typed custom answer per question; null when an option was picked. */
  customAnswers: (string | null)[]
  cancelled: boolean
  cancelledAt?: number
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
    let selectList: SelectList

    const selectListTheme = {
      selectedPrefix: (t: string) => theme.fg('accent', t),
      selectedText: (t: string) => theme.fg('accent', t),
      description: (t: string) => theme.fg('muted', t),
      scrollInfo: (t: string) => theme.fg('dim', t),
      noMatch: (t: string) => theme.fg('warning', t),
    }

    const editorTheme: EditorTheme = {
      borderColor: (s) => theme.fg('accent', s),
      selectList: selectListTheme,
    }
    const editor = new Editor(tui, editorTheme)
    editor.onSubmit = (value) => {
      const trimmed = value.trim()
      if (!trimmed) {
        editor.setText('')
        refresh()
        return
      }
      customAnswers[index] = trimmed
      selected[index] = null
      if (index === total - 1) {
        done({ selected, customAnswers, cancelled: false })
        return
      }
      index++
      editMode = false
      makeSelectList()
      refresh()
    }

    /** (Re)build the option list for the current question. */
    function makeSelectList() {
      const item = items[index]!
      const numberedItems: SelectItem[] = [
        ...item.options.map((opt, i) => ({
          value: `${i}`,
          label: `${i + 1}. ${opt}`,
        })),
        { value: CUSTOM_VALUE, label: '✎ Type a custom answer…' },
      ]
      selectList = new SelectList(
        numberedItems,
        Math.min(numberedItems.length, 10),
        selectListTheme,
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
        if (index === total - 1) {
          done({ selected, customAnswers, cancelled: false })
          return
        }
        index++
        editMode = false
        makeSelectList()
        refresh()
      }
      selectList.onCancel = () =>
        done({ selected, customAnswers, cancelled: true, cancelledAt: index })
    }
    makeSelectList()

    function refresh() {
      cachedLines = undefined
      tui.requestRender()
    }

    function handleInput(data: string) {
      // Editor mode: type the custom answer; Esc returns to options.
      if (editMode) {
        if (matchesKey(data, Key.escape)) {
          editMode = false
          refresh()
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
          if (index === total - 1) {
            done({ selected, customAnswers, cancelled: false })
          } else {
            index++
            editMode = false
            makeSelectList()
            refresh()
          }
          return
        }
      }
      if (matchesKey(data, Key.ctrl('p')) && index > 0) {
        index--
        if (customAnswers[index] != null) {
          editMode = true
          editor.setText(customAnswers[index] ?? '')
        } else {
          editMode = false
          makeSelectList()
          selectList.setSelectedIndex(selected[index] ?? 0)
        }
        refresh()
        return
      }
      selectList.handleInput(data)
      refresh()
    }

    function render(width: number): string[] {
      if (cachedLines) return cachedLines

      const lines: string[] = []
      const renderWidth = Math.max(1, width)
      const current = items[index]!

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
            ...(isBatch && index > 0 ? ['Ctrl+P previous'] : []),
            'Esc cancel',
          ]
      addWrappedWithPrefix(' ', theme.fg('dim', hints.join(' • ')))
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
