/**
 * Overlay modal for the `/subagents` command.
 *
 * Lists every subagent task tracked by the store — running, done, failed,
 * and aborted — and renders the selected task's full result (status header,
 * system prompt, complete transcript, usage) in a scrollable view. Running
 * tasks show their latest streamed partial state with a live elapsed timer.
 *
 * The factory matches pi's `ctx.ui.custom` contract: it receives the TUI,
 * theme, keybindings, and a `done` callback, and returns a renderable
 * component. Pi shows it as an overlay (`{ overlay: true }`) and hides the
 * overlay when `done` is called.
 */

import type { Theme } from '@earendil-works/pi-coding-agent'
import {
  Key,
  matchesKey,
  SelectList,
  type Component,
  type SelectItem,
  type TUI,
  type KeybindingsManager,
  visibleWidth,
} from '@earendil-works/pi-tui'
import { renderFullResultContent } from './render.ts'
import type { SubagentTask } from './store.ts'

/** Vertical fraction of the terminal the modal may occupy. */
const MODAL_HEIGHT_FRACTION = 0.9

/** Frame color used for the modal's box border. */
function frame(theme: Theme, text: string): string {
  return theme.fg('borderAccent', text)
}

/**
 * Wrap modal content in a full box border (┌ ─ ┐ / │ / └ ─ ┘). `innerWidth`
 * is the content column width; shorter lines are padded (ANSI-aware) so the
 * right border stays aligned.
 */
function boxed(
  lines: string[],
  innerWidth: number,
  frame: (text: string) => string,
): string[] {
  const out: string[] = [frame(`┌${'─'.repeat(innerWidth)}┐`)]
  for (const line of lines) {
    let body = line
    while (visibleWidth(body) < innerWidth) body += ' '
    out.push(`${frame('│')}${body}${frame('│')}`)
  }
  out.push(frame(`└${'─'.repeat(innerWidth)}┘`))
  return out
}

function formatElapsed(startedAt: number): string {
  const s = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${s % 60}s`
}

function statusLabel(task: SubagentTask): string {
  if (task.status === 'running') return `running ${formatElapsed(task.startedAt)}`
  if (task.status === 'done') return 'done'
  if (task.status === 'aborted') return 'aborted'
  return 'failed'
}

function taskPreview(task: string): string {
  const single = task.split('\n').find((line) => line.trim()) ?? task
  if (single.length <= 48) return single
  return `${single.slice(0, 45)}...`
}

/** SelectList theme consistent with the rest of pi's tool UIs. */
function selectListTheme(theme: Theme) {
  return {
    selectedPrefix: (t: string) => theme.fg('accent', t),
    selectedText: (t: string) => theme.fg('accent', t),
    description: (t: string) => theme.fg('dim', t),
    scrollInfo: (t: string) => theme.fg('dim', t),
    noMatch: (t: string) => theme.fg('warning', t),
  }
}

export function createSubagentsModal(tasks: SubagentTask[]) {
  return function modalFactory(
    tui: TUI,
    theme: Theme,
    _kb: KeybindingsManager,
    done: (result: null) => void,
  ): Component {
    let cachedLines: string[] | undefined

    /** Pick the viewport height from the real terminal (overlay = 90%). */
    function viewportHeight(): number {
      return Math.max(
        1,
        Math.floor((tui?.terminal.rows ?? 30) * MODAL_HEIGHT_FRACTION),
      )
    }

    const themeList = selectListTheme(theme)
    const items: SelectItem[] = tasks.map((task, i) => ({
      value: String(i),
      label: `${
        task.status === 'running'
          ? '⏳'
          : task.status === 'done'
            ? '✓'
            : '✗'
      } ${task.agent} — ${taskPreview(task.task)}`,
      description: statusLabel(task),
    }))
    const picker = new SelectList(
      items,
      Math.min(items.length, 10),
      themeList,
    )

    let selectedTask: SubagentTask | undefined
    let scrollTop = 0
    let contentLines: string[] = []
    let disposed = false
    // Set by pi-tui whenever keyboard focus moves: `true` while this modal
    // owns input, `false` after a background non-overlay custom UI (e.g. the
    // ask dialog) steals focus. Used to divert keys back to the visible
    // modal.
    let component: Component & { dispose?(): void; focused: boolean } | undefined
    let unsubscribe: (() => void) | undefined

    picker.onSelect = (item) => {
      const task = tasks[Number(item.value)]
      if (!task) return
      selectedTask = task
      scrollTop = 0
      refresh()
    }
    picker.onCancel = () => close()

    function close() {
      dispose()
      done(null)
    }

    function dispose() {
      if (disposed) return
      disposed = true
      unsubscribe?.()
      if (liveTimer) {
        clearInterval(liveTimer)
        liveTimer = undefined
      }
    }

    function refresh() {
      cachedLines = undefined
      tui.requestRender()
    }

    // Keep the elapsed timer and running-state view fresh once a second
    // while any task is still executing.
    let liveTimer: ReturnType<typeof setInterval> | undefined =
      setInterval(() => {
        if (disposed) return
        if (tasks.some((t) => t.status === 'running')) {
          refresh()
        }
      }, 1000)
    liveTimer.unref?.()

    function scrollBy(lines: number) {
      const max = Math.max(0, contentLines.length - viewportHeight())
      scrollTop = Math.max(0, Math.min(max, scrollTop + lines))
      refresh()
    }

    function handleInput(data: string) {
      // Transcript view: scrolling + navigation, Esc back to the picker.
      if (selectedTask) {
        if (matchesKey(data, Key.escape)) {
          selectedTask = undefined
          refresh()
          return
        }
        if (matchesKey(data, 'q') || matchesKey(data, Key.enter)) {
          close()
          return
        }
        if (matchesKey(data, Key.up)) return scrollBy(-1)
        if (matchesKey(data, Key.down)) return scrollBy(1)
        if (matchesKey(data, Key.pageUp))
          return scrollBy(-(viewportHeight() - 1))
        if (matchesKey(data, Key.pageDown))
          return scrollBy(viewportHeight() - 1)
        if (matchesKey(data, Key.home)) {
          scrollTop = 0
          refresh()
          return
        }
        if (matchesKey(data, Key.end)) {
          scrollBy(contentLines.length)
          return
        }
        return
      }

      // Picker view: let the list handle navigation; Esc cancels via its
      // onCancel handler.
      picker.handleInput(data)
      refresh()
    }

    function render(width: number): string[] {
      // `width` is the overlay width (pi passes the available columns).
      const renderWidth = Math.max(1, width)
      if (cachedLines) return cachedLines

      // Content lives inside the box with one column of padding on each
      // side: components render at innerWidth and get a leading space.
      const innerWidth = Math.max(1, renderWidth - 3)

      const lines: string[] = []

      if (selectedTask) {
        const full = renderFullResultContent(selectedTask.details, theme, tui)
        contentLines = full.render(innerWidth).map((line) => ` ${line}`)
        const max = Math.max(0, contentLines.length - viewportHeight())
        if (scrollTop > max) scrollTop = max

        if (selectedTask.status === 'running') {
          lines.push(
            ` ${theme.fg('warning', `⏳ ${selectedTask.agent} — ${statusLabel(selectedTask)}`)}`,
          )
        }
        const visible = contentLines.slice(
          scrollTop,
          scrollTop + viewportHeight(),
        )
        if (visible.length === 0) {
          lines.push(` ${theme.fg('muted', '(no output)')}`)
        } else {
          lines.push(...visible)
        }
        lines.push('')
        lines.push(
          ` ${theme.fg('dim', max > 0 ? '↑↓ scroll • Esc back • q close' : 'Esc back • q close')}`,
        )
      } else {
        lines.push(` ${theme.fg('text', `Subagent tasks (${tasks.length})`)}`)
        lines.push('')
        for (const line of picker.render(innerWidth)) {
          lines.push(` ${line}`)
        }
        lines.push('')
        lines.push(
          ` ${theme.fg('dim', '↑↓ navigate • Enter inspect • Esc close')}`,
        )
      }

      cachedLines = boxed(lines, renderWidth - 2, (text) => frame(theme, text))
      return cachedLines
    }

    component = {
      render,
      invalidate: () => {
        cachedLines = undefined
      },
      handleInput,
      dispose,
      focused: false,
    }

    // While this modal is open, divert keyboard input back to it whenever
    // pi-tui's focus was stolen by a background non-overlay UI — typically
    // the ask dialog, which opens underneath this overlay and is invisible.
    // pi-tui runs input listeners before dispatching to the focused
    // component, so consuming the event here keeps the hidden dialog from
    // ever seeing it and the modal stays fully navigable. When the modal
    // itself is focused the listener stays out of the way to avoid
    // double-handling.
    unsubscribe = tui.addInputListener((data) => {
      if (disposed || !component) return undefined
      if (component.focused) return undefined
      // Shift+Ctrl+D is pi's global debug key, checked after input
      // listeners; let it through instead of swallowing it.
      if (matchesKey(data, 'shift+ctrl+d')) return undefined
      handleInput(data)
      return { consume: true }
    })

    return component
  }
}
