/**
 * OptionList — custom select component for the ask dialog.
 *
 * Renders a scrollable, keyboard-navigable list of options where each
 * option is a label line followed by an indented, wrapped description
 * line (when the option has one). The selected option's label and
 * description are both highlighted. Unlike pi-tui's built-in SelectList,
 * which shows descriptions as a truncated right-hand column, this layout
 * keeps longer descriptions readable on narrow terminals.
 *
 * Keyboard: ↑/↓ move (with wrap-around), Enter selects, Esc cancels.
 * The dialog layer on top handles number-key jumps, ←/→ question
 * navigation, and the editor for custom answers.
 */

import {
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type SelectItem,
  type SelectListTheme,
} from '@earendil-works/pi-tui'

export interface OptionListOptions {
  /** Return true for items that should show a trailing ✓ mark (already picked). */
  isMarked?: (item: SelectItem) => boolean
}

/** Indent for the label prefix, i.e. width of "→ " / "  ". */
const PREFIX_WIDTH = 2

/** Extra indent of the description line below the label. */
const DESCRIPTION_INDENT = 2

/** Width reserved for the trailing " ✓" mark on picked options. */
const MARK_WIDTH = 2

/** Collapse embedded newlines so descriptions render on one wrapped block. */
function normalizeToSingleLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim()
}

export class OptionList {
  private items: SelectItem[]
  private maxVisible: number
  private theme: SelectListTheme
  private opts: OptionListOptions
  private selectedIndex = 0

  onSelect?: (item: SelectItem) => void
  onCancel?: () => void
  onSelectionChange?: (item: SelectItem) => void

  constructor(
    items: SelectItem[],
    maxVisible: number,
    theme: SelectListTheme,
    opts: OptionListOptions = {},
  ) {
    this.items = items
    this.maxVisible = maxVisible
    this.theme = theme
    this.opts = opts
  }

  setSelectedIndex(index: number) {
    this.selectedIndex = Math.max(
      0,
      Math.min(index, this.items.length - 1),
    )
  }

  invalidate() {
    // No cached state to invalidate currently.
  }

  getSelectedItem(): SelectItem | null {
    return this.items[this.selectedIndex] ?? null
  }

  handleInput(keyData: string) {
    // Up arrow — wrap to bottom when at top.
    if (matchesKey(keyData, Key.up)) {
      this.selectedIndex =
        this.selectedIndex === 0 ? this.items.length - 1 : this.selectedIndex - 1
      this.notifySelectionChange()
      return
    }
    // Down arrow — wrap to top when at bottom.
    if (matchesKey(keyData, Key.down)) {
      this.selectedIndex =
        this.selectedIndex === this.items.length - 1
          ? 0
          : this.selectedIndex + 1
      this.notifySelectionChange()
      return
    }
    // Enter.
    if (matchesKey(keyData, Key.enter)) {
      const item = this.items[this.selectedIndex]
      if (item && this.onSelect) this.onSelect(item)
      return
    }
    // Escape / cancel.
    if (matchesKey(keyData, Key.escape)) {
      if (this.onCancel) this.onCancel()
    }
  }

  render(width: number): string[] {
    const lines: string[] = []
    if (this.items.length === 0) {
      lines.push(this.theme.noMatch('  No options'))
      return lines
    }

    // Visible range, centered on the selection with scrolling.
    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(this.maxVisible / 2),
        this.items.length - this.maxVisible,
      ),
    )
    const endIndex = Math.min(
      startIndex + this.maxVisible,
      this.items.length,
    )

    for (let i = startIndex; i < endIndex; i++) {
      const item = this.items[i]!
      const isSelected = i === this.selectedIndex
      lines.push(...this.renderItem(item, isSelected, width))
    }

    // Scroll indicator when the list overflows the visible window.
    if (startIndex > 0 || endIndex < this.items.length) {
      const scrollText = `  (${this.selectedIndex + 1}/${this.items.length})`
      lines.push(
        this.theme.scrollInfo(truncateToWidth(scrollText, width - 2, '')),
      )
    }
    return lines
  }

  private renderItem(
    item: SelectItem,
    isSelected: boolean,
    width: number,
  ): string[] {
    const prefix = isSelected ? '→ ' : '  '
    const marked = this.opts.isMarked?.(item) ?? false
    const labelMax = Math.max(
      1,
      width - PREFIX_WIDTH - (marked ? MARK_WIDTH : 0),
    )
    const truncated = truncateToWidth(item.label, labelMax, '…')
    const label = marked ? `${truncated} ✓` : truncated

    const lines: string[] = []
    lines.push(
      isSelected ? this.theme.selectedText(`${prefix}${label}`) : prefix + label,
    )

    const description = item.description
      ? normalizeToSingleLine(item.description)
      : undefined
    if (description) {
      const indent = PREFIX_WIDTH + DESCRIPTION_INDENT
      const indentPad = ' '.repeat(indent)
      for (const line of wrapTextWithAnsi(
        description,
        Math.max(1, width - indent),
      )) {
        const styled = `${indentPad}${line}`
        // Highlight the description along with the label when selected.
        lines.push(
          isSelected
            ? this.theme.selectedText(styled)
            : this.theme.description(styled),
        )
      }
    }
    return lines
  }

  private notifySelectionChange() {
    const item = this.items[this.selectedIndex]
    if (item && this.onSelectionChange) this.onSelectionChange(item)
  }
}
