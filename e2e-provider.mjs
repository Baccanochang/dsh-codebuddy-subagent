// End-to-end provider test: register the provider with a real subprocess stub
// and run one real CodeBuddy ACP task through start().
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const { apply } = await import('./lib/index.js')

// Minimal subprocess seam implementing the surface the provider uses:
// spawn(spec) -> { stdin, stdout, done, terminate, waitForExit }
function spawnManaged(spec) {
  const child = spawn(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: spec.env,
  })
  let exited = false
  let outcome
  const done = new Promise((resolve, reject) => {
    child.on('error', (err) => { exited = true; outcome = { exitCode: null, signal: null, error: err }; reject(err) })
    child.on('exit', (code, signal) => { exited = true; outcome = { exitCode: code, signal }; resolve(outcome) })
  })
  const terminated = new Promise((resolve) => { child.on('exit', () => resolve()) })
  child.stderr?.on('data', (d) => console.log('[child-stderr]', d.toString().slice(0, 300)))
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    done,
    outcome,
    get outcomeValue() { return outcome },
    terminate() { try { child.kill() } catch {} },
    async waitForExit() { if (!exited) await terminated },
  }
}

const registered = []
const ctx = {
  subagents: { registerProvider: (p) => registered.push(p) },
  subprocess: { spawn: (spec) => spawnManaged(spec) },
  logger: { warn: (...a) => console.log('[warn]', ...a), debug: (...a) => console.log('[debug]', ...a), info: () => {} },
}
apply(ctx, {})

const provider = registered[0]
const controller = new AbortController()
const request = {
  prompt: [{ type: 'text', text: 'Reply with exactly: E2E_OK_<a random 4-digit number>. Do not use any tools, do not read files, just reply.' }],
  cwd: process.cwd(),
  signal: controller.signal,
}

console.log('starting run...')
const t0 = Date.now()
try {
  const run = await provider.start(request)
  console.log('run id:', run.id)
  const result = await run.result
  console.log('result stopReason:', result.stopReason)
  console.log('result output:', JSON.stringify(result.output))
  console.log('result diagnostic:', result.diagnostic ?? '(none)')
  console.log('E2E_DONE in', Date.now() - t0, 'ms')
} catch (e) {
  console.log('E2E_FAIL', e.message)
  process.exitCode = 1
}
