import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface TmpEnv {
  cwd: string
  agentDir: string
  /** Write a global config file. */
  writeGlobal(contents: string): void
  /** Write a project config file under <cwd>/.pi/. */
  writeProject(contents: string): void
  cleanup(): void
}

export function makeTmpEnv(): TmpEnv {
  const root = mkdtempSync(join(tmpdir(), 'tool-gate-test-'))
  const cwd = join(root, 'project')
  const agentDir = join(root, 'agent')
  rmSync(cwd, { recursive: true, force: true })
  rmSync(agentDir, { recursive: true, force: true })
  mkdirSync(cwd, { recursive: true })
  mkdirSync(agentDir, { recursive: true })
  return {
    cwd,
    agentDir,
    writeGlobal(contents: string) {
      writeFileSync(join(agentDir, 'tool-gate.json'), contents)
    },
    writeProject(contents: string) {
      mkdirSync(join(cwd, '.pi'), { recursive: true })
      writeFileSync(join(cwd, '.pi', 'tool-gate.json'), contents)
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** True when the given path exists (for verifying writes landed). */
export function pathExists(p: string): boolean {
  return existsSync(p)
}
