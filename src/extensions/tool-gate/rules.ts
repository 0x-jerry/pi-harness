/**
 * Tool Gate - rules, matching, and decision logic (pure, unit-tested).
 *
 * A rule is the trigger: it names the tools (or '*') and regex patterns that
 * make a tool call "dangerous". The configured mode (bypass | manual |
 * copilot) decides how a matched call is judged. This module has no I/O and
 * no side effects so the decision matrix is fully testable.
 */

import type { ToolGateConfig } from './config.ts'

export type ToolGateMode = 'bypass' | 'manual' | 'copilot'
export type HeadlessPolicy = 'block' | 'allow'

export interface ToolGateRule {
  id: string
  /** Human-readable reason shown in dialogs and block reasons. */
  description: string
  /** Tool names this rule applies to; '*' matches any tool. */
  tools: string[]
  /** Regex sources, matched case-insensitively. */
  patterns: string[]
  /** Input fields to test; default: all string values in the input. */
  fields?: string[]
  /** Per-rule override of the global headless policy. */
  headless?: HeadlessPolicy
  /**
   * Block and hint the agent to stop after the current batch. Only effective
   * when every finalized result in the batch is terminating.
   */
  terminate?: boolean
}

/**
 * Outcome of a tool_call gate check. The extension handler is a thin shell
 * over `decide()`: it only renders dialogs and runs the copilot model.
 */
export type GateDecision =
  | { action: 'allow' }
  | { action: 'block'; reason: string; terminate?: boolean }
  | { action: 'confirm'; rule: ToolGateRule; snippet: string }
  | { action: 'copilot'; rule: ToolGateRule; snippet: string }

export interface DecideContext {
  toolName: string
  input: Record<string, unknown>
  /** True when an interactive confirmation dialog is possible. */
  hasUI: boolean
  /** True when copilot mode is active and a copilot model is configured. */
  copilotAvailable: boolean
}

/**
 * Default rules.
 *
 * A single catch-all bash rule: every shell command is reviewed by the gate
 * and the mode decides how (manual dialog / copilot model / headless
 * policy). No pattern list is needed — bash is where destructive operations
 * happen, and patterns (rm -rf, sudo, ...) inevitably miss something. The
 * reviewer (human or model) judges context and intent instead.
 *
 * Other tools (write/edit on .env, node_modules, ...) are not gated by
 * default; add rules in tool-gate.json when you want them reviewed.
 */
export const DEFAULT_RULES: ToolGateRule[] = [
  {
    id: 'bash-all',
    description: 'Shell command execution',
    tools: ['bash'],
    // No patterns: matches every bash call.
    patterns: [],
  },
]

/**
 * Collect every string reachable from `value` (objects and arrays are
 * flattened depth-first) so rules can match against structured tool inputs.
 */
export function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value)
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out)
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectStrings(item, out)
    }
  }
  return out
}

function collectFieldStrings(
  input: Record<string, unknown>,
  fields?: string[],
): string[] {
  if (fields && fields.length > 0) {
    const out: string[] = []
    for (const field of fields) collectStrings(input[field], out)
    return out
  }
  return collectStrings(input)
}

function ruleMatches(rule: ToolGateRule, input: Record<string, unknown>): boolean {
  if (rule.patterns.length === 0) return true
  const strings = collectFieldStrings(input, rule.fields)
  if (strings.length === 0) return false
  return strings.some((s) =>
    rule.patterns.some((source) => {
      try {
        return new RegExp(source, 'i').test(s)
      } catch {
        return false // malformed user-supplied pattern: treat as non-matching
      }
    }),
  )
}

/** First matching rule wins; rules are evaluated in configured order. */
export function matchRule(
  rules: ToolGateRule[],
  toolName: string,
  input: Record<string, unknown>,
): ToolGateRule | undefined {
  for (const rule of rules) {
    if (!rule.tools.includes('*') && !rule.tools.includes(toolName)) continue
    if (ruleMatches(rule, input)) return rule
  }
  return undefined
}

/**
 * allowList entries are either a bare tool name, '*' for everything, or
 * "toolName:regex" to skip only matching calls of that tool.
 */
export function isAllowListed(
  allowList: string[],
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (allowList.includes('*') || allowList.includes(toolName)) return true
  const strings = collectStrings(input)
  return allowList.some((entry) => {
    const colon = entry.indexOf(':')
    if (colon <= 0 || entry.slice(0, colon) !== toolName) return false
    try {
      return strings.some((s) => new RegExp(entry.slice(colon + 1), 'i').test(s))
    } catch {
      return false
    }
  })
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

/** Short excerpt of the matched input for dialogs and prompts. */
export function buildSnippet(
  rule: ToolGateRule,
  input: Record<string, unknown>,
): string {
  const strings = collectFieldStrings(input, rule.fields)
  const matched = strings.filter((s) =>
    rule.patterns.some((source) => {
      try {
        return new RegExp(source, 'i').test(s)
      } catch {
        return false
      }
    }),
  )
  const text =
    matched.join(' | ') ||
    strings.join(' | ') ||
    JSON.stringify(input)
  return truncate(text, 200)
}

/**
 * The full gate decision. Pure: no dialogs, no model calls, no I/O.
 *
 * Decision matrix:
 * - disabled / allow-listed / bypass mode / no rule match  -> allow
 * - copilot mode with a configured model                   -> copilot review
 * - needs a human decision (manual mode, or copilot without a model):
 *     hasUI -> confirm dialog, else headless policy (block by default)
 */
export function decide(
  config: ToolGateConfig,
  ctx: DecideContext,
): GateDecision {
  if (!config.enabled) return { action: 'allow' }
  if (isAllowListed(config.allowList, ctx.toolName, ctx.input)) {
    return { action: 'allow' }
  }
  if (config.mode === 'bypass') return { action: 'allow' }

  const rule = matchRule(config.rules, ctx.toolName, ctx.input)
  if (!rule) return { action: 'allow' }
  const snippet = buildSnippet(rule, ctx.input)

  if (config.mode === 'copilot' && ctx.copilotAvailable) {
    return { action: 'copilot', rule, snippet }
  }

  // Manual mode, or copilot mode without a configured model: a human
  // decision is needed. No UI -> headless policy (per-rule override wins).
  if (ctx.hasUI) return { action: 'confirm', rule, snippet }
  const policy = rule.headless ?? config.headless
  if (policy === 'allow') return { action: 'allow' }
  return {
    action: 'block',
    reason: `Blocked by tool-gate (${rule.id}): ${rule.description} (no confirmation available in this mode)`,
    terminate: rule.terminate,
  }
}
