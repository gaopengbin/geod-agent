// Standalone Codex command/exec. The native companion owns this connection.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
let child, started = false, stopped = false, ready = false, done = false, serial = 0, options;
const pending = new Map();
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const send = value => child.stdin.write(JSON.stringify(value) + '\n');
function rpc(method, params, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = timeout ? setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeout) : null;
    pending.set(id, { resolve, reject, timer }); send({ id, method, params });
  });
}
async function finish(value) {
  if (done) return; done = true;
  emit({ type: 'done', ...value });
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Command connection closed')); }
  pending.clear();
  if (child) { child.stdin.end(); child.kill(); }
  process.stdin.destroy();
}
async function start(value) {
  options = value;
  mkdirSync(value.home, { recursive: true });
  writeFileSync(join(value.home, 'config.toml'), `approval_policy = "never"\nsandbox_mode = "workspace-write"\nweb_search = "disabled"\n${process.platform === 'win32' ? '[windows]\nsandbox = "unelevated"\n' : ''}`);
  child = spawn(value.codex, ['app-server', '--stdio'], { cwd: value.workspace, env: { ...process.env, CODEX_HOME: value.home }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let diagnostics = '';
  child.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes.toString('utf8')).slice(-8192); });
  const failed = () => { if (!done) void finish({ error: diagnostics.includes('failed to initialize sqlite state runtime') ? { code: 'COMMAND_ENGINE_STORAGE', message: 'Codex 命令记录目录无法初始化，请检查目录可写性和路径长度' } : { code: 'COMMAND_ENGINE_EXITED', message: '后台命令引擎已退出' }, cancelled: stopped }); };
  child.on('error', failed); child.on('exit', failed);
  createInterface({ input: child.stdout }).on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if ('id' in message && !message.method) {
      const entry = pending.get(message.id); if (!entry) return; pending.delete(message.id); clearTimeout(entry.timer);
      message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result); return;
    }
    if ('id' in message) { send({ id: message.id, error: { code: -32601, message: 'Standalone command connection has no model or interactive tool callbacks' } }); return; }
    if (message.method === 'command/exec/outputDelta' && message.params.processId === value.id) emit({ type: 'output', ...message.params });
  });
  const info = await rpc('initialize', { clientInfo: { name: 'geod_background_commands', title: 'GeoD background commands', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  if (!info.userAgent?.includes('/0.159.2 ')) throw new Error('COMMAND_ENGINE_VERSION');
  send({ method: 'initialized' }); ready = true;
  if (stopped) { await finish({ cancelled: true }); return; }
  emit({ type: 'started', processId: value.id, engine: 'codex', version: '0.159.2' });
  try {
    const result = await rpc('command/exec', {
      processId: value.id, command: value.command, cwd: value.cwd,
      streamStdoutStderr: true, streamStdin: true, outputBytesCap: 262144,
      ...(value.timeoutMs ? { timeoutMs: value.timeoutMs } : { disableTimeout: true }),
      // Codex 0.159.2 rejects streaming command/exec in the Windows sandbox.
      // Native preparation exposes host-user execution; only fullAccess or an
      // explicit UI confirmation can start the captured argv and working path.
      sandboxPolicy: process.platform === 'win32' ? { type: 'dangerFullAccess' } : { type: 'workspaceWrite', writableRoots: [value.workspace], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
    }, 0);
    await finish({ result, cancelled: stopped });
  } catch (error) { await finish({ error: { code: 'COMMAND_EXEC_FAILED', message: '后台命令未能执行，请检查程序、参数和工作区权限', detail: String(error.message).slice(0, 2000) }, cancelled: stopped }); }
}
const input = createInterface({ input: process.stdin });
input.on('line', async line => {
  let value; try { value = JSON.parse(line); } catch { return; }
  try {
    if (value.type === 'start' && !started) { started = true; await start(value); }
    else if (value.type === 'stop') {
      stopped = true;
      if (ready && !done) {
        try { await rpc('command/exec/terminate', { processId: options.id }); }
        catch { await finish({ cancelled: true }); }
      }
    } else if (value.type === 'write' && ready && !done) {
      await rpc('command/exec/write', { processId: options.id, deltaBase64: value.deltaBase64 ?? null, closeStdin: value.closeStdin === true });
      emit({ type: 'writeResult', requestId: value.requestId, ok: true });
    }
  } catch { if (value.type === 'write') emit({ type: 'writeResult', requestId: value.requestId, ok: false }); else await finish({ error: { code: 'COMMAND_ENGINE_FAILED', message: '后台命令引擎连接失败，请检查本机运行环境' }, cancelled: stopped }); }
});
input.on('close', () => { if (!done) { stopped = true; void finish({ cancelled: true }); } });
