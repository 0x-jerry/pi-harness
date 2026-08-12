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
 *   1. User-level agents   ~/.pi/agent/agents/*.md     (all projects)
 *   2. Project-local agents <project>/.pi/agents/*.md   (nearest ancestor dir)
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  parseFrontmatter,
} from '@earendil-works/pi-coding-agent'
import type { AgentConfig, AgentSource } from './types.ts'

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
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
    let content: string
    try {
      content = fs.readFileSync(filePath, 'utf-8')
    } catch {
      continue
    }

    const { frontmatter, body } =
      parseFrontmatter<Record<string, string>>(content)

    if (!frontmatter.name || !frontmatter.description) {
      continue
    }

    const tools = frontmatter.tools
      ?.split(',')
      .map((t: string) => t.trim())
      .filter(Boolean)

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: tools && tools.length > 0 ? tools : undefined,
      model: frontmatter.model,
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

export function discoverAgents(cwd: string): AgentConfig[] {
  const userDir = path.join(getAgentDir(), 'agents')
  const projectAgentsDir = findNearestProjectAgentsDir(cwd)

  const userAgents = loadAgentsFromDir(userDir, 'user')
  const projectAgents = projectAgentsDir
    ? loadAgentsFromDir(projectAgentsDir, 'project')
    : []

  // User agents first; project agents override on name conflicts.
  const agentMap = new Map<string, AgentConfig>()
  for (const agent of userAgents) agentMap.set(agent.name, agent)
  for (const agent of projectAgents) agentMap.set(agent.name, agent)

  return Array.from(agentMap.values())
}
