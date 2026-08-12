/**
 * Extensions entry point.
 */

import { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import registerSubAgentExtension from './agents/index.ts'

export default function (pi: ExtensionAPI) {
  registerSubAgentExtension(pi)
}
