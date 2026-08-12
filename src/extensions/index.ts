/**
 * Extensions entry point.
 */

import { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import registerAskExtension from './ask/index.ts'
import registerSubAgentExtension from './agents/index.ts'

export default function (pi: ExtensionAPI) {
  registerSubAgentExtension(pi)
  registerAskExtension(pi)
}
