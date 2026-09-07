import { createBashToolDefinition, defineTool } from '@earendil-works/pi-coding-agent'

export const DEFAULT_BASH_TIMEOUT_SECONDS = 120

/** Minimal structural view of a tool definition, so the wrapper stays usable
 * without importing the SDK's generic ToolDefinition types. */
type ToolWithExecute = { execute: (...args: any[]) => Promise<any> }

/**
 * The SDK bash tool only times out when the model passes an explicit
 * `timeout`; a default keeps a runaway command (e.g. the reviewer agent's
 * bash) from blocking the subagent — and the parent session — forever.
 */
export function withBashDefaultTimeout<T extends ToolWithExecute>(tool: T): T {
  const base = tool.execute
  return {
    ...tool,
    execute: (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) =>
      base(
        toolCallId,
        { ...params, timeout: params.timeout ?? DEFAULT_BASH_TIMEOUT_SECONDS },
        signal,
        onUpdate,
        ctx,
      ),
  }
}

export function createBashWithDefaultTimeout(cwd: string) {
  // defineTool widens the concrete bash schema to the SDK's ToolDefinition[]
  // slot without changing the tool at runtime (identity function).
  return defineTool(withBashDefaultTimeout(createBashToolDefinition(cwd)))
}