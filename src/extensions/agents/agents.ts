/**
 * Subagent discovery.
 *
 * Agents are markdown files with YAML frontmatter:
 *
 *   ---
 *   name: scout
 *   description: Fast codebase recon that returns compressed context
 *   tools: read, grep, find, ls, bash
 *   model: claude-haiku-4-5   # optional; omitting uses the active model
 *   ---
 *
 *   System prompt for the agent goes here.
 *
 * Agent levels (later levels override earlier ones on name conflicts):
 *   1. Builtin agents      <package>/src/extensions/agents/builtin/*.md
 *   2. User-level agents   ~/.pi/agent/agents/*.md     (all projects)
 *   3. Project-local agents <project>/.pi/agents/*.md   (nearest ancestor dir)
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LRUCache } from 'lru-cache'
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  parseFrontmatter,
} from '@earendil-works/pi-coding-agent'
import type { AgentConfig, AgentSource } from './types.ts'

/**
 * Builtin agents ship with this package in the `builtin/` folder next to
 * this module. Resolved from the module URL so it works whether the package
 * runs from a local checkout, a linked workspace, or an installed npm
 * dependency.
 */
const builtinAgentsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'builtin',
)

/**
 * LRU cache of discovered agents, keyed by `${cwd}\0${agentDir}\0${trust}`.
 * Discovery runs on every tool execution, so entries expire quickly; LRU
 * eviction keeps stale project dirs from accumulating.
 */
const agentCache = new LRUCache<string, AgentConfig[]>({
  max: 100,
  ttl: 10_000,
})

function loadAgentsFromDir(options: {
  dir: string
  source: AgentSource
}): AgentConfig[] {
  const { dir, source } = options
  const agents: AgentConfig[] = []

  if (!fs.existsSync(dir)) {
    return agents
  }

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return agents
  }

  for (const entry of entries) {
    if (!entry.name.endsWith('.md')) continue
    if (!entry.isFile() && !entry.isSymbolicLink()) continue

    const filePath = path.join(dir, entry.name)

    // One malformed agent file must not break discovery for every agent, so
    // read + frontmatter parse + field extraction are guarded per file and
    // bad files are skipped.
    let content: string
    try {
      content = fs.readFileSync(filePath, 'utf-8')
    } catch {
      continue
    }

    let frontmatter: Record<string, unknown>
    let body: string
    try {
      const parsed = parseFrontmatter<Record<string, unknown>>(content)
      frontmatter = parsed.frontmatter
      body = parsed.body
    } catch {
      // Malformed YAML frontmatter.
      continue
    }

    const name =
      typeof frontmatter.name === 'string' ? frontmatter.name.trim() : ''
    const description =
      typeof frontmatter.description === 'string'
        ? frontmatter.description.trim()
        : ''
    if (!name || !description) continue

    // `tools` must be a comma-separated string; YAML lists or numbers crash
    // `.split()`, so anything non-string is treated as "no allowlist".
    const tools =
      typeof frontmatter.tools === 'string'
        ? frontmatter.tools
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined

    agents.push({
      name,
      description,
      tools: tools && tools.length > 0 ? tools : undefined,
      model:
        typeof frontmatter.model === 'string' ? frontmatter.model : undefined,
      systemPrompt: body,
      source,
      filePath,
    })
  }

  return agents
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let currentDir = cwd
  while (true) {
    const candidate = path.join(currentDir, CONFIG_DIR_NAME, 'agents')
    if (isDirectory(candidate)) return candidate

    const parentDir = path.dirname(currentDir)
    if (parentDir === currentDir) return null
    currentDir = parentDir
  }
}

export async function discoverAgents(
  cwd: string,
  projectTrusted: boolean,
): Promise<AgentConfig[]> {
  const agentDir = getAgentDir()
  const key = `${cwd}\0${agentDir}\0${projectTrusted ? '1' : '0'}`
  const cached = agentCache.get(key)
  if (cached) return cached

  const userDir = path.join(agentDir, 'agents')
  const projectAgentsDir = findNearestProjectAgentsDir(cwd)

  // Builtin agents ship with this package; user agents override them and
  // project agents override both on name conflicts. Builtin agents are
  // trusted by definition — they are part of the package, not project files.
  const builtinAgents = loadAgentsFromDir({
    dir: builtinAgentsDir,
    source: 'builtin',
  })
  const userAgents = loadAgentsFromDir({ dir: userDir, source: 'user' })
  // An untrusted project's agent files are not loaded at all.
  const projectAgents =
    projectTrusted && projectAgentsDir
      ? loadAgentsFromDir({ dir: projectAgentsDir, source: 'project' })
      : []

  // Builtin agents first; user and project agent files override on name
  // conflicts.
  const agentMap = new Map<string, AgentConfig>()
  for (const agent of builtinAgents) agentMap.set(agent.name, agent)
  for (const agent of userAgents) agentMap.set(agent.name, agent)
  for (const agent of projectAgents) agentMap.set(agent.name, agent)

  const agents = Array.from(agentMap.values())
  agentCache.set(key, agents)
  return agents
}
