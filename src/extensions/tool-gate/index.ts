/**
 * Tool Gate - confirm or block dangerous tool calls.
 *
 * Hooks pi's `tool_call` event (fired before a tool executes) and applies a
 * configurable gate to rule-matched calls. The mode decides how a matched
 * call is judged:
 *
 * - bypass  - the gate is off; nothing is reviewed or prompted.
 * - manual  - the user confirms or rejects in a dialog (approve -> execute,
 *             reject -> the call is blocked and the reason goes back to the
 *             LLM). Esc cancels, which counts as reject.
 * - copilot - a dedicated model (copilot.model) reviews the call and returns
 *             pass/reject/ask. pass executes, reject blocks with the model's
 *             reason, ask (or any failure/timeout) escalates to a manual
 *             confirm when a UI exists, otherwise to the headless policy.
 *
 * Configuration: <agentDir>/tool-gate.json, <cwd>/.pi/tool-gate.json
 * (trusted projects only), plus env overrides PI_TOOL_GATE_MODE,
 * PI_TOOL_GATE_HEADLESS, PI_TOOL_GATE_COPILOT_MODEL. Reloaded on every
 * session_start, so /reload picks up changes.
 */

import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEvent,
  type ToolCallEventResult,
} from '@earendil-works/pi-coding-agent'
import { buildSessionContext, reviewWithCopilot } from './copilot.ts'
import {
  DEFAULT_CONFIG,
  loadToolGateConfig,
  type ToolGateConfig,
} from './config.ts'
import {
  decide,
  type GateDecision,
  type ToolGateRule,
} from './rules.ts'

type GateContext = ExtensionContext

export default function registerToolGateExtension(pi: ExtensionAPI) {
  // Module-level state lives for the extension instance (one per session);
  // session_start (re)loads the config, so /reload and session switches get
  // fresh rules without reinstalling the package.
  let config: ToolGateConfig = DEFAULT_CONFIG
  let warnedCopilotModel = false

  pi.on('session_start', (_event, ctx) => {
    const result = loadToolGateConfig({
      cwd: ctx.cwd,
      agentDir: getAgentDir(),
      projectTrusted: ctx.isProjectTrusted(),
      env: process.env,
    })
    config = result.config
    warnedCopilotModel = false

    for (const warning of result.warnings) {
      ctx.ui.notify(`tool-gate: ${warning}`, 'warning')
    }
    if (config.mode === 'copilot' && !config.copilot.model) {
      ctx.ui.notify(
        'tool-gate: copilot mode needs `copilot.model` in tool-gate.json (or PI_TOOL_GATE_COPILOT_MODEL) — falling back to manual confirmation / headless policy',
        'warning',
      )
      warnedCopilotModel = true
    }
  })

  pi.on('tool_call', async (event: ToolCallEvent, ctx: GateContext) => {
    const input = event.input as unknown as Record<string, unknown>
    const decision = decide(config, {
      toolName: event.toolName,
      input,
      hasUI: ctx.hasUI,
      copilotAvailable: config.mode === 'copilot' && config.copilot.model !== '',
    })

    switch (decision.action) {
      case 'allow':
        return undefined
      case 'block':
        return { block: true, reason: decision.reason, terminate: decision.terminate }
      case 'confirm':
        return confirmOrBlock(decision.rule, decision.snippet, event.toolName, ctx)
      case 'copilot':
        return runCopilot(decision, event.toolName, input, ctx)
    }
  })

  /** Manual confirmation; Esc/timeout counts as reject (safe default). */
  async function confirmOrBlock(
    rule: ToolGateRule,
    snippet: string,
    toolName: string,
    ctx: GateContext,
  ): Promise<ToolCallEventResult | undefined> {
    if (!ctx.hasUI) return headlessBlock(rule, ctx)
    const ok = await ctx.ui.confirm(
      'Dangerous tool call?',
      `${rule.description}\n\nTool: ${toolName}\n${snippet}`,
    )
    if (!ok) {
      return { block: true, reason: `Blocked by user (tool-gate: ${rule.id})` }
    }
    return undefined
  }

  /** Copilot review of a rule-matched call. */
  async function runCopilot(
    decision: Extract<GateDecision, { action: 'copilot' }>,
    toolName: string,
    input: Record<string, unknown>,
    ctx: GateContext,
  ): Promise<ToolCallEventResult | undefined> {
    const { rule, snippet } = decision

    // Defensive: decide() only routes here when a model is configured, but
    // config can change between decide() and this call in theory.
    if (!config.copilot.model) {
      if (!warnedCopilotModel && ctx.hasUI) {
        ctx.ui.notify(
          'tool-gate: copilot mode needs `copilot.model` in tool-gate.json (or PI_TOOL_GATE_COPILOT_MODEL)',
          'warning',
        )
        warnedCopilotModel = true
      }
      return ctx.hasUI ? confirmOrBlock(rule, snippet, toolName, ctx) : headlessBlock(rule, ctx)
    }

    if (ctx.signal?.aborted) {
      return { block: true, reason: 'tool-gate: aborted before copilot review' }
    }

    if (ctx.hasUI) ctx.ui.setStatus('tool-gate', `copilot: reviewing ${toolName}…`)
    let verdict
    try {
      verdict = await reviewWithCopilot({
        cwd: ctx.cwd,
        model: config.copilot.model,
        toolName,
        input,
        rule,
        context: buildSessionContext(
          ctx.sessionManager.getEntries(),
          config.copilot.contextEntries,
        ),
        signal: ctx.signal,
        timeoutMs: config.copilot.timeoutMs,
      })
    } finally {
      if (ctx.hasUI) ctx.ui.setStatus('tool-gate', undefined)
    }

    if (ctx.signal?.aborted) {
      return { block: true, reason: 'tool-gate: copilot review aborted' }
    }

    const notify = config.copilot.notify && ctx.hasUI
    switch (verdict.verdict) {
      case 'pass':
        if (notify) ctx.ui.notify(`copilot PASS (${rule.id}): ${verdict.reason}`, 'info')
        return undefined
      case 'reject':
        if (notify) ctx.ui.notify(`copilot REJECT (${rule.id}): ${verdict.reason}`, 'warning')
        return {
          block: true,
          reason: `Blocked by copilot review (tool-gate: ${rule.id}): ${verdict.reason}`,
        }
      case 'ask':
        if (notify) ctx.ui.notify(`copilot unsure (${rule.id}): ${verdict.reason}`, 'warning')
        return ctx.hasUI ? confirmOrBlock(rule, snippet, toolName, ctx) : headlessBlock(rule, ctx)
    }
  }

  /** Headless policy: block unless the (per-rule or global) policy allows. */
  function headlessBlock(
    rule: ToolGateRule,
    ctx: GateContext,
  ): ToolCallEventResult | undefined {
    const policy = rule.headless ?? config.headless
    if (policy === 'allow') return undefined
    return {
      block: true,
      reason: `Blocked by tool-gate (${rule.id}): ${rule.description} (no confirmation available in this mode)`,
      terminate: rule.terminate,
    }
  }
}
