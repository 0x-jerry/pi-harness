/**
 * Prompt-template agents.
 *
 * Prompt templates (the `/name` slash commands pi expands in the editor) are
 * also usable as subagent system prompts, so the `subagent` tool accepts
 * template names in addition to agent files. This module discovers them from
 * every source pi itself loads, using pi's public APIs:
 *
 *   1. Global       ~/.pi/agent/prompts/
 *   2. Project      <project>/.pi/prompts/ (nearest ancestor)
 *   3. Settings     `prompts` entries in global/project settings.json
 *   4. Packages     `pi.prompts` manifest entries + conventional `prompts/` dirs
 *
 * Discovery delegates to pi's own `DefaultPackageManager` + `SettingsManager`,
 * so package prompts (npm/git/local), settings paths, and glob/filter rules
 * resolve exactly as they do for `/name` commands. `onMissing` returns "skip"
 * so no package is installed just to list templates.
 *
 * Note: pi does not expose a public loader for prompt templates — only the
 * `PromptTemplate` type and the manager classes. Template files are parsed
 * here with the same rules pi uses (name = filename, description from
 * frontmatter or first line, body = content).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { LRUCache } from 'lru-cache'
import { substituteArgs } from '@earendil-works/pi-agent-core'
import {
  CONFIG_DIR_NAME,
  DefaultPackageManager,
  getAgentDir,
  parseFrontmatter,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import type { AgentConfig } from './types.ts'

/** Minimal parsed view of a prompt template file. */
interface TemplateFile {
  name: string
  description: string
  content: string
  filePath: string
}

/**
 * LRU cache of discovered template agents, keyed by `${cwd}\0${agentDir}`.
 * Runs on every tool execution, so entries expire quickly; LRU eviction keeps
 * stale project dirs from accumulating.
 */
const templateCache = new LRUCache<string, AgentConfig[]>({
  max: 100,
  ttl: 10_000,
})

/** Parse a prompt-template .md file using pi's own rules. */
function parsePromptTemplateFile(filePath: string): TemplateFile | null {
  try {
    const rawContent = fs.readFileSync(filePath, 'utf-8')
    const { frontmatter, body } =
      parseFrontmatter<Record<string, string>>(rawContent)
    const name = path.basename(filePath).replace(/\.md$/, '')

    // Description from frontmatter or the first non-empty line (truncated),
    // matching pi's loadTemplateFromFile.
    let description = frontmatter.description || ''
    if (!description) {
      const firstLine = body.split('\n').find((line) => line.trim())
      if (firstLine) {
        description = firstLine.slice(0, 60)
        if (firstLine.length > 60) description += '...'
      }
    }

    return { name, description, content: body, filePath }
  } catch {
    return null
  }
}

/** Scan a directory for .md templates (non-recursive). */
function loadTemplatesFromDir(dir: string): TemplateFile[] {
  const templates: TemplateFile[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return templates
  }
  for (const entry of entries) {
    if (!entry.name.endsWith('.md')) continue
    if (!entry.isFile() && !entry.isSymbolicLink()) continue
    const template = parsePromptTemplateFile(path.join(dir, entry.name))
    if (template) templates.push(template)
  }
  return templates
}

/** Discover all prompt templates via pi's own package manager. */
async function discoverViaPackageManager(
  cwd: string,
  agentDir: string,
): Promise<TemplateFile[]> {
  const settingsManager = SettingsManager.create(cwd, agentDir)
  const packageManager = new DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager,
  })
  const resolved = await packageManager.resolve(async () => 'skip')
  const templates: TemplateFile[] = []
  for (const resource of resolved.prompts) {
    if (!resource.enabled) continue
    const template = parsePromptTemplateFile(resource.path)
    if (template) templates.push(template)
  }
  return templates
}

/**
 * Synchronous fallback (global + project prompt dirs) in case package-manager
 * resolution throws, e.g. on malformed settings.
 */
function discoverSynchronously(cwd: string, agentDir: string): TemplateFile[] {
  const templates: TemplateFile[] = []
  const globalPromptsDir = path.join(agentDir, 'prompts')
  templates.push(...loadTemplatesFromDir(globalPromptsDir))
  templates.push(...loadTemplatesFromDir(path.join(cwd, CONFIG_DIR_NAME, 'prompts')))
  return templates
}

/**
 * Fill prompt-template placeholders the way pi does for `/name arg` expansion.
 * The subagent's `task` is treated as the single argument ($1 / $@ / $ARGUMENTS),
 * so templates like `Review ${1:-the current changes}` expand deterministically.
 *
 * Reuses pi's exported `substituteArgs` (@earendil-works/pi-agent-core) for
 * `$N`, `$@`, `$ARGUMENTS`, and `${@:N}` slicing. That variant omits default
 * values, so `${N:-default}` / `${@:-default}` / `${ARGUMENTS:-default}` are
 * expanded to `$N` / `$@` / `$ARGUMENTS` (or the fallback) in a small pre-pass
 * first — mirroring the coding-agent's full substituteArgs semantics.
 */
export function substituteTemplateArgs(content: string, task: string): string {
  const args = [task]
  const expanded = content.replace(
    /\$\{(\d+|@|ARGUMENTS):-([^}]*)\}/g,
    (_match, target: string, fallback: string) => {
      const value =
        target === '@' || target === 'ARGUMENTS'
          ? args[0]
          : args[parseInt(target, 10) - 1]
      if (value) {
        return target === '@'
          ? '$@'
          : target === 'ARGUMENTS'
            ? '$ARGUMENTS'
            : `$${target}`
      }
      return fallback
    },
  )
  return substituteArgs(expanded, args)
}

/** Discover prompt templates as agent configs, from all sources pi supports:
 * global, project, settings, and installed packages (including this one).
 * Cached in an LRU with a short TTL since it runs on every tool execution.
 */
export function discoverPromptTemplateAgents(cwd: string): Promise<AgentConfig[]> {
  const agentDir = getAgentDir()
  const key = `${cwd}\0${agentDir}`
  const cached = templateCache.get(key)
  if (cached) return Promise.resolve(cached)

  return (async () => {
    let templates: TemplateFile[]
    try {
      templates = await discoverViaPackageManager(cwd, agentDir)
    } catch {
      templates = discoverSynchronously(cwd, agentDir)
    }

    const agents = templates
      .map((t) => ({
        name: t.name,
        description: t.description || '(prompt template)',
        systemPrompt: t.content,
        source: 'prompt' as const,
        filePath: t.filePath,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))

    templateCache.set(key, agents)
    return agents
  })()
}
