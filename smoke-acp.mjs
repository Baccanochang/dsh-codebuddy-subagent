// Minimal ACP handshake smoke test: initialize -> session/new -> session/cancel -> exit.
// Proves `codebuddy --acp` still speaks the protocol on this machine before plugin install.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const EXE = process.env.CODEBUDDY_BIN ?? 'codebuddy'
const CWD = process.cwd()

const child = spawn(EXE, ['--acp'], {
  cwd: CWD,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
})

let nextId = 1
const pending = new Map()
const rl = createInterface({ input: child.stdout })
const erl = createInterface({ input: child.stderr })
erl.on('line', line => console.log('[stderr]', line.slice(0, 200)))

function send(obj) { child.stdin.write(JSON.stringify(obj) + '\n') }
function request(method, params, timeoutMs = 30000) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout ' + method)) }, timeoutMs)
    pending.set(id, { resolve, reject, timer, method })
    send({ jsonrpc: '2.0', id, method, params })
  })
}
function notify(method, params) { send({ jsonrpc: '2.0', method, params }) }

rl.on('line', line => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { console.log('[non-json]', line.slice(0, 120)); return }
  if (msg.method) { console.log('[notify]', msg.method); return }
  const p = pending.get(msg.id)
  if (!p) return
  pending.delete(msg.id)
  clearTimeout(p.timer)
  if (msg.error) p.reject(new Error(p.method + ': ' + JSON.stringify(msg.error)))
  else p.resolve(msg.result)
})

const t0 = Date.now()
try {
  const init = await request('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'dsh-smoke', version: '0.0.0' },
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
  })
  console.log('initialize ok in', Date.now() - t0, 'ms; agentCapabilities=', JSON.stringify(init.agentCapabilities))

  const sess = await request('session/new', { cwd: CWD, mcpServers: [] })
  console.log('session/new ok; sessionId=', sess.sessionId, 'models=', sess.models?.availableModels?.length)

  notify('session/cancel', { sessionId: sess.sessionId })
  console.log('SMOKE_OK')
} catch (e) {
  console.log('SMOKE_FAIL', e.message)
  process.exitCode = 1
} finally {
  setTimeout(() => { try { child.kill() } catch {} }, 300)
}
