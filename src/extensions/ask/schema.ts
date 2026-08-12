import { Type, type Static } from 'typebox'

/** A single question with its own answer choices. */
export const AskParam = Type.Object({
  question: Type.String({
    description: 'The question to ask the user',
  }),
  description: Type.Optional(
    Type.String({
      description:
        'Optional extra context or explanation shown with the question',
    }),
  ),
  options: Type.Array(Type.String(), {
    description: 'Answer choices for the user to pick from',
  }),
})

export type AskItem = Static<typeof AskParam>

export const AskParams = Type.Object({
  questions: Type.Array(AskParam, {
    description:
      'One or more questions to ask the user, answered one at a time in a single dialog',
  }),
})

export type AskCallArgs = Static<typeof AskParams>
