import { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { default as ask } from '../src/agents/index.ts'
import { default as agents } from '../src/agents/index.ts'

export default (pi: ExtensionAPI) => {
  ask(pi)
  agents(pi)
}
