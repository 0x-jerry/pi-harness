import { describe, expect, test } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import extension from '../../src/extensions/agents/index.ts'

interface RegisteredTool {
  name: string
  parameters: { properties?: Record<string, unknown> }
  execute: (...args: any[]) => Promise<any>
}

/** Capture the tools the extension registers with a fake pi. */
function loadExtension(): { tools: RegisteredTool[] } {
  const tools: RegisteredTool[] = []
  const pi = {
    registerTool: (def: RegisteredTool) => tools.push(def),
    registerCommand: () => {},
    on: () => {},
  } as unknown as ExtensionAPI
  extension(pi)
  return { tools }
}

/** Create a temp project dir with the given `.pi/agents/*.md` files. */
function makeProject(agentFiles: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-harness-'))
  for (const [rel, content] of Object.entries(agentFiles)) {
    const file = path.join(dir, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  return dir
}

function agentMd(name: string, description: string): string {
  return `---
name: ${name}
description: ${description}
tools: read, grep, find
model: claude-haiku-4-5
---
Agent body for ${name}
`
}

function ctxFor(cwd: string, projectTrusted = true): any {
  return { cwd, isProjectTrusted: () => projectTrusted }
}

function listTool(): RegisteredTool {
  const { tools } = loadExtension()
  const tool = tools.find((t) => t.name === 'list_agents')
  expect(tool).toBeDefined()
  return tool!
}

describe('list_agents tool', () => {
  test('is registered with no parameters', () => {
    const tool = listTool()
    expect(Object.keys(tool.parameters.properties ?? {})).toHaveLength(0)
  })

  test('lists builtin and project agents with trimmed details', async () => {
    const cwd = makeProject({
      '.pi/agents/scout.md': agentMd('scout', 'Fast codebase recon'),
    })
    const tool = listTool()
    const result = await tool.execute(
      'tc-1',
      {},
      undefined,
      undefined,
      ctxFor(cwd, true),
    )

    const text = result.content[0].text
    expect(text).toContain('- reviewer:')
    expect(text).toContain(
      '- scout: Fast codebase recon (source: project, model: claude-haiku-4-5, tools: read, grep, find)',
    )

    const scout = result.details.find((d: any) => d.name === 'scout')
    expect(scout).toMatchObject({
      name: 'scout',
      description: 'Fast codebase recon',
      source: 'project',
      model: 'claude-haiku-4-5',
      tools: ['read', 'grep', 'find'],
    })
    // systemPrompt and filePath must not leak into the transcript.
    for (const d of result.details) {
      expect(d).not.toHaveProperty('systemPrompt')
      expect(d).not.toHaveProperty('filePath')
    }
  })

  test('notes project agents omitted from an untrusted directory', async () => {
    const cwd = makeProject({
      '.pi/agents/scout.md': agentMd('scout', 'Fast codebase recon'),
    })
    const tool = listTool()
    const result = await tool.execute(
      'tc-2',
      {},
      undefined,
      undefined,
      ctxFor(cwd, false),
    )

    const text = result.content[0].text
    expect(text).not.toContain('- scout:')
    expect(text).toContain('project agents')
    expect(text).toContain('not trusted')
  })

  test('collapses multiline descriptions into a single line', async () => {
    const cwd = makeProject({
      '.pi/agents/multi.md': `---
name: multi
description: |
  Line one
  line two
tools: bash
---
Body
`,
    })
    const tool = listTool()
    const result = await tool.execute(
      'tc-3',
      {},
      undefined,
      undefined,
      ctxFor(cwd, true),
    )
    expect(result.content[0].text).toContain(
      '- multi: Line one line two (source: project, tools: bash)',
    )
  })
})
