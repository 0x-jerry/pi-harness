import { Type, type Static } from 'typebox'

export const SubagentParams = Type.Object({
  agent: Type.String({
    description:
      'Name of the agent to invoke (builtin agents, or agent files from user/project levels)',
  }),
  task: Type.String({ description: 'Task to delegate to the agent' }),
  cwd: Type.Optional(
    Type.String({ description: 'Working directory for the agent process' }),
  ),
})

export type SubagentCallArgs = Static<typeof SubagentParams>
