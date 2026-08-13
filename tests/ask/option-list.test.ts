import { describe, expect, test } from 'vitest'
import type { SelectItem, SelectListTheme } from '@earendil-works/pi-tui'
import { OptionList } from '../../src/extensions/ask/option-list.ts'

/** Minimal theme stub with <color> markers for assertion. */
function stubTheme(): SelectListTheme {
  return {
    selectedPrefix: (t: string) => `<accent>${t}</>`,
    selectedText: (t: string) => `<accent>${t}</>`,
    description: (t: string) => `<muted>${t}</>`,
    scrollInfo: (t: string) => `<dim>${t}</>`,
    noMatch: (t: string) => `<warning>${t}</>`,
  }
}

const theme = stubTheme()

const items: SelectItem[] = [
  {
    value: '0',
    label: '1. postgres',
    description: 'ACID compliant relational DB',
  },
  { value: '1', label: '2. sqlite', description: 'Embedded, zero-config' },
  { value: '2', label: '3. mysql' },
]

describe('OptionList', () => {
  test('renders labels and indented descriptions below', () => {
    const out = new OptionList(items, 10, theme).render(80)
    expect(out.join('\n')).toContain('1. postgres')
    expect(out.join('\n')).toContain('ACID compliant relational DB')
    expect(out.join('\n')).toContain('2. sqlite')
    expect(out.join('\n')).toContain('3. mysql')
    // description lines are indented (label prefix + description indent);
    // the stub theme wraps the line in <muted> markers, so check the indent
    // after the markers.
    const descLine = out.find((l) => l.includes('ACID compliant'))!
    expect(descLine).toContain('    ACID compliant relational DB')
  })

  test('an option without a description renders no description lines', () => {
    const out = new OptionList(items, 10, theme).render(80)
    const mysqlLine = out.find((l) => l.includes('3. mysql'))!
    expect(mysqlLine.includes('description')).toBe(false)
  })

  test('highlights the description of the selected option', () => {
    const list = new OptionList(items, 10, theme)
    // default selection is index 0 → its description is highlighted
    const selectedDesc = list.render(80).find((l) =>
      l.includes('ACID compliant'),
    )!
    expect(selectedDesc).toContain('<accent>')
    // sqlite (index 1) is not selected → its description stays muted
    const unselectedDesc = list.render(80).find((l) =>
      l.includes('Embedded'),
    )!
    expect(unselectedDesc).toContain('<muted>')
    // moving the selection highlights the newly selected description
    list.handleInput('\x1b[B')
    const movedDesc = list.render(80).find((l) => l.includes('Embedded'))!
    expect(movedDesc).toContain('<accent>')
    const demotedDesc = list.render(80).find((l) =>
      l.includes('ACID compliant'),
    )!
    expect(demotedDesc).toContain('<muted>')
  })

  test('wraps long descriptions to the available width', () => {
    const out = new OptionList(
      [
        {
          value: '0',
          label: '1. a',
          description: 'word '.repeat(20).trim(),
        },
      ],
      10,
      theme,
    ).render(30)
    const descLines = out.filter((l) => l.includes('word'))
    expect(descLines.length).toBeGreaterThan(1)
    expect(descLines.every((l) => l.includes('    word'))).toBe(true)
  })

  test('marks picked options with a trailing ✓', () => {
    const list = new OptionList(items, 10, theme, {
      isMarked: (it) => it.value === '1',
    })
    const out = list.render(80)
    expect(out.find((l) => l.includes('2. sqlite'))).toContain('✓')
    expect(out.find((l) => l.includes('1. postgres'))).not.toContain('✓')
  })

  test('✓ survives label truncation at narrow widths', () => {
    const list = new OptionList(
      [
        {
          value: '0',
          label: '1. a very very long label that must be truncated',
        },
      ],
      10,
      theme,
      { isMarked: (it) => it.value === '0' },
    )
    const out = list.render(30).join('\n')
    expect(out).toContain('✓')
  })

  test('arrow navigation wraps around', () => {
    const list = new OptionList(items, 10, theme)
    const selections: (string | null)[] = []
    list.onSelectionChange = (it) => selections.push(it.value)
    // start at index 0; up wraps to the last
    list.handleInput('\x1b[A')
    expect(list.getSelectedItem()?.value).toBe('2')
    // down wraps back to the first
    list.handleInput('\x1b[B')
    expect(list.getSelectedItem()?.value).toBe('0')
    expect(selections).toEqual(['2', '0'])
  })

  test('Enter fires onSelect with the selected item', () => {
    const list = new OptionList(items, 10, theme)
    let selected: string | null = null
    list.onSelect = (it) => (selected = it.value)
    list.handleInput('\x1b[B') // move to sqlite
    list.handleInput('\r')
    expect(selected).toBe('1')
  })

  test('Esc fires onCancel', () => {
    const list = new OptionList(items, 10, theme)
    let cancelled = false
    list.onCancel = () => (cancelled = true)
    list.handleInput('\x1b')
    expect(cancelled).toBe(true)
  })

  test('setSelectedIndex clamps to bounds', () => {
    const list = new OptionList(items, 10, theme)
    list.setSelectedIndex(99)
    expect(list.getSelectedItem()?.value).toBe('2')
    list.setSelectedIndex(-5)
    expect(list.getSelectedItem()?.value).toBe('0')
  })

  test('shows a scroll indicator when the list overflows', () => {
    const many: SelectItem[] = Array.from({ length: 20 }, (_, i) => ({
      value: `${i}`,
      label: `${i + 1}. option ${i + 1}`,
    }))
    const list = new OptionList(many, 5, theme)
    expect(list.render(80).join('\n')).toContain('(1/20)')
    list.setSelectedIndex(15)
    expect(list.render(80).join('\n')).toContain('(16/20)')
  })

  test('renders a noMatch message for an empty list', () => {
    const out = new OptionList([], 5, theme).render(80)
    expect(out.join('\n')).toContain('No options')
  })
})
