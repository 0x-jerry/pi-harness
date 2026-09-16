/**
 * Tool Gate - configuration loading and merging.
 *
 * Precedence (low -> high):
 *   1. Built-in defaults
 *   2. <agentDir>/tool-gate.json (global, e.g. ~/.pi/agent/tool-gate.json)
 *   3. <cwd>/.pi/tool-gate.json (project; only when the project is trusted)
 *   4. Environment variables (PI_TOOL_GATE_MODE, PI_TOOL_GATE_HEADLESS,
 *      PI_TOOL_GATE_COPILOT_MODEL)
 *
 * Loading is fail-soft: a malformed or invalid config file produces a
 * warning and falls back to defaults instead of breaking the session.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR_NAME } from '@earendil-works/pi-coding-agent'
import {
  DEFAULT_RULES,
  type HeadlessPolicy,
  type ToolGateMode,
  type ToolGateRule,
} from './rules.ts'

export interface ToolGateConfig {
  /** Master switch; false disables the gate entirely. */
  enabled: boolean
  /** How a rule-matched call is judged. */
  mode: ToolGateMode
  /**
   * What to do when a human decision is needed but no UI exists (print/JSON
   * modes, RPC without UI). Only consulted for that case.
   */
  headless: HeadlessPolicy
  copilot: {
    /** Provider/model id (e.g. "anthropic/claude-3-5-haiku"). Required in copilot mode. */
    model: string
    /** Show each verdict via ctx.ui.notify when UI exists. */
    notify: boolean
    /** Recent session entries fed to the reviewer for intent context. */
    contextEntries: number
    /** Model call timeout; on timeout the call is escalated. */
    timeoutMs: number
  }
  /** Tool names (or "tool:regex") never gated. */
  allowList: string[]
  /** Trigger rules, in evaluation order (first match wins). */
  rules: ToolGateRule[]
}

export const DEFAULT_CONFIG: ToolGateConfig = {
  enabled: true,
  mode: 'manual',
  headless: 'block',
  copilot: {
    model: '',
    notify: true,
    contextEntries: 5,
    timeoutMs: 30_000,
  },
  allowList: [],
  rules: DEFAULT_RULES,
}

export interface ToolGateConfigLoadOptions {
  cwd: string
  /** Global pi config dir (getAgentDir()). */
  agentDir: string
  /** Project-local config is only honored for trusted projects. */
  projectTrusted: boolean
  env?: Record<string, string | undefined>
}

export interface ToolGateConfigResult {
  config: ToolGateConfig
  warnings: string[]
}

const MODES: readonly ToolGateMode[] = ['bypass', 'manual', 'copilot']
const HEADLESS: readonly HeadlessPolicy[] = ['block', 'allow']

function cloneDefaults(): ToolGateConfig {
  return {
    ...DEFAULT_CONFIG,
    copilot: { ...DEFAULT_CONFIG.copilot },
    allowList: [...DEFAULT_CONFIG.allowList],
    rules: [...DEFAULT_CONFIG.rules],
  }
}

function tryReadJson(path: string, warnings: string[]): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warnings.push(`${path}: expected a JSON object, ignoring`)
      return null
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    warnings.push(
      `${path}: invalid JSON (${error instanceof Error ? error.message : String(error)}), using defaults`,
    )
    return null
  }
}

function mergeConfig(
  base: ToolGateConfig,
  part: Record<string, unknown>,
  warnings: string[],
  source: string,
): ToolGateConfig {
  const next = cloneDefaults()
  next.enabled = base.enabled
  next.mode = base.mode
  next.headless = base.headless
  next.copilot = { ...base.copilot }
  next.allowList = [...base.allowList]
  next.rules = [...base.rules]

  if (typeof part.enabled === 'boolean') next.enabled = part.enabled
  if (typeof part.mode === 'string') {
    if (MODES.includes(part.mode as ToolGateMode)) {
      next.mode = part.mode as ToolGateMode
    } else {
      warnings.push(`${source}: invalid mode "${part.mode}", keeping "${next.mode}"`)
    }
  }
  if (typeof part.headless === 'string') {
    if (HEADLESS.includes(part.headless as HeadlessPolicy)) {
      next.headless = part.headless as HeadlessPolicy
    } else {
      warnings.push(`${source}: invalid headless "${part.headless}", keeping "${next.headless}"`)
    }
  }

  const copilot = part.copilot
  if (copilot !== null && typeof copilot === 'object' && !Array.isArray(copilot)) {
    const c = copilot as Record<string, unknown>
    if (typeof c.model === 'string') next.copilot.model = c.model
    if (typeof c.notify === 'boolean') next.copilot.notify = c.notify
    if (typeof c.contextEntries === 'number' && Number.isFinite(c.contextEntries)) {
      next.copilot.contextEntries = Math.max(0, Math.floor(c.contextEntries))
    }
    if (typeof c.timeoutMs === 'number' && Number.isFinite(c.timeoutMs)) {
      next.copilot.timeoutMs = Math.max(1, Math.floor(c.timeoutMs))
    }
  }

  if (Array.isArray(part.allowList)) {
    next.allowList = part.allowList.filter((e): e is string => typeof e === 'string')
  }
  if (Array.isArray(part.rules)) {
    next.rules = part.rules.filter(isRule).map(normalizeRule)
  }

  return next
}

function isRule(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeRule(raw: Record<string, unknown>): ToolGateRule {
  const tools = Array.isArray(raw.tools)
    ? raw.tools.filter((t): t is string => typeof t === 'string')
    : []
  const patterns = Array.isArray(raw.patterns)
    ? raw.patterns.filter((p): p is string => typeof p === 'string')
    : []
  const fields = Array.isArray(raw.fields)
    ? raw.fields.filter((f): f is string => typeof f === 'string')
    : undefined
  const headless = raw.headless === 'allow' || raw.headless === 'block' ? raw.headless : undefined
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `rule-${tools.join(',')}-${patterns[0] ?? 'all'}`,
    description: typeof raw.description === 'string' ? raw.description : 'Dangerous tool call',
    tools: tools.length > 0 ? tools : ['*'],
    patterns,
    fields: fields && fields.length > 0 ? fields : undefined,
    headless,
    terminate: raw.terminate === true,
  }
}

function applyEnv(config: ToolGateConfig, env: Record<string, string | undefined>): void {
  const mode = env.PI_TOOL_GATE_MODE
  if (mode && MODES.includes(mode as ToolGateMode)) config.mode = mode as ToolGateMode
  const headless = env.PI_TOOL_GATE_HEADLESS
  if (headless && HEADLESS.includes(headless as HeadlessPolicy)) {
    config.headless = headless as HeadlessPolicy
  }
  const model = env.PI_TOOL_GATE_COPILOT_MODEL
  if (model) config.copilot.model = model
}

export function loadToolGateConfig(
  options: ToolGateConfigLoadOptions,
): ToolGateConfigResult {
  const warnings: string[] = []
  const globalPath = join(options.agentDir, 'tool-gate.json')
  const projectPath = join(options.cwd, CONFIG_DIR_NAME, 'tool-gate.json')

  let config = cloneDefaults()
  const global = tryReadJson(globalPath, warnings)
  if (global) config = mergeConfig(config, global, warnings, globalPath)
  if (options.projectTrusted) {
    const project = tryReadJson(projectPath, warnings)
    if (project) config = mergeConfig(config, project, warnings, projectPath)
  }
  applyEnv(config, options.env ?? {})

  return { config, warnings }
}
