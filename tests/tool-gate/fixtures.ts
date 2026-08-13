import type { ToolGateRule } from '../../src/extensions/tool-gate/rules.ts'

/** Shared minimal rule fixture for tool-gate tests. */
export const rule = (overrides: Partial<ToolGateRule>): ToolGateRule => ({
  id: 'test-rule',
  description: 'Test rule',
  tools: ['bash'],
  patterns: [String.raw`rm\s+-rf`],
  ...overrides,
})
