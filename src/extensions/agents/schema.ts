import { Type, type Static } from 'typebox'

export const SubagentParams = Type.Object({
  agent: Type.String({
    description:
      'Name of the agent or prompt template to invoke (agent files, or /-style prompt templates like "reviewer")',
  }),
  task: Type.String({ description: 'Task to delegate to the agent' }),
  cwd: Type.Optional(
    Type.String({ description: 'Working directory for the agent process' }),
  ),
})

export type SubagentCallArgs = Static<typeof SubagentParams>
