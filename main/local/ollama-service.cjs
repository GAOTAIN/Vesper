const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: pause } = require('node:timers/promises');
const { randomUUID } = require('node:crypto');
const executeFile = promisify(execFile);
const { aborted } = require('./ollama-client.cjs');

function findOllama() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs/Ollama/ollama.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Ollama/ollama.exe'),
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(item => path.join(item.replace(/^"|"$/g, ''), 'ollama.exe'))
  ];
  return candidates.find(candidate => { try { return fs.statSync(candidate).isFile(); } catch { return false; } }) || null;
}

function waitFor(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const stop = () => reject(aborted());
    signal.addEventListener('abort', stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

function portIsListening() {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port: 11434 });
    let finished = false;
    const finish = value => { if (finished) return; finished = true; socket.destroy(); resolve(value); };
    socket.setTimeout(800, () => finish(true));
    socket.once('connect', () => finish(true));
    socket.once('error', error => finish(error.code !== 'ECONNREFUSED'));
  });
}

async function saveModelsEnvironment(target, runFile = executeFile) {
  // Electron 已用 windowsHide 隐藏进程；额外的窗口样式参数会使部分 Windows PowerShell 直接退出。
  const script = '$ErrorActionPreference="Stop"; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); try { [Environment]::SetEnvironmentVariable("OLLAMA_MODELS", $env:VESPER_MODELS_TARGET, "User") } catch { [Console]::Error.Write($_.Exception.Message); exit 1 }';
  try {
    await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, timeout: 10000, encoding: 'utf8', env: { ...process.env, VESPER_MODELS_TARGET: target }
    });
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('无法保存模型下载位置：未找到 Windows PowerShell。原下载位置保持不变。');
    if (error.killed || error.code === 'ETIMEDOUT') throw new Error('保存模型下载位置超时，请稍后重试。原下载位置保持不变。');
    const detail = String(error.stderr || (!String(error.message || '').startsWith('Command failed:') ? error.message : '') || '').trim().slice(0, 220);
    throw new Error(detail ? '无法保存模型下载位置：' + detail + '。原下载位置保持不变。' : '无法保存模型下载位置：Windows 环境变量写入进程异常退出，请重试。原下载位置保持不变。');
  }
}

function createOllamaService({ client, store, emit, findExecutable = findOllama, launch = spawn, runFile = executeFile, platform = process.platform, startupMs = 20000, isPortBusy = portIsListening }) {
  let child = null, pending = null, closing = false;
  let state = { status: 'idle', owner: null, activeDirectory: null, error: '', executable: null };
  let logTail = '';
  const update = value => { state = { ...state, ...value }; emit(); };
  const owned = () => Boolean(child && Number.isInteger(child.pid) && child.exitCode === null && child.signalCode === null);
  async function ping() {
    const response = await client.json('/api/tags', { headerTimeout: 1800, idleTimeout: 1800 });
    if (!response || !Array.isArray(response.models)) throw new Error('11434 端口并非可识别的 Ollama 服务。');
    return response;
  }
  async function inspect() {
    try {
      await ping(); update({ status: 'ready', owner: owned() ? 'vesper' : 'external', error: '', activeDirectory: owned() ? state.activeDirectory : null });
    } catch (error) {
      const executable = findExecutable();
      update({ status: executable ? 'stopped' : 'missing', owner: null, activeDirectory: null, executable, error: error.message });
    }
    return { ...state };
  }
  async function start() {
    if (closing) throw new Error('Ollama 正在关闭，请稍后重试。');
    if (store.snapshot().pendingModelDirectory) throw new Error('新模型目录尚未生效，请先点击“应用目录并重启”；外部服务需要先退出。');
    let connected = false;
    try {
      await ping(); connected = true;
    } catch (error) {
      // 确认端口不可连接之后才允许启动，非 Ollama 响应不抢占端口。
      if (!/无法连接本机|响应超时/.test(error.message)) { update({ status: 'error', error: error.message }); throw error; }
    }
    if (connected) {
      update({ status: 'ready', owner: owned() ? 'vesper' : 'external', error: '' });
      if (store.snapshot().pendingModelDirectory) throw new Error('新模型目录尚未生效，请先应用目录；外部服务需要退出后由 Vesper 重新启动。');
      return { ...state };
    }
    if (await isPortBusy()) {
      const message = '11434 端口已有监听，但未返回可用的 Ollama 响应。请等待服务就绪或检查占用程序；为避免冲突，没有启动第二个服务。';
      update({ status: 'error', error: message }); throw new Error(message);
    }
    const executable = findExecutable();
    if (!executable) { update({ status: 'missing', owner: null, executable: null, error: '未找到 Ollama。请先安装官方 Windows 运行库，再重新连接。' }); throw new Error(state.error); }
    if (owned()) throw new Error('已启动的 Ollama 尚未就绪，请稍后重新检测。');
    const directory = store.snapshot().modelDirectory || process.env.OLLAMA_MODELS || path.join(os.homedir(), '.ollama/models');
    fs.mkdirSync(directory, { recursive: true });
    update({ status: 'starting', executable, error: '', owner: 'vesper', activeDirectory: directory });
    logTail = '';
    let spawnError = null;
    const launched = launch(executable, ['serve'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, OLLAMA_HOST: '127.0.0.1:11434', OLLAMA_MODELS: directory,
      OLLAMA_NO_CLOUD: '1', OLLAMA_NUM_PARALLEL: '1', OLLAMA_MAX_LOADED_MODELS: '1'
    } });
    child = launched;
    const log = chunk => { logTail = (logTail + String(chunk)).slice(-6000); };
    launched.stdout?.on('data', log); launched.stderr?.on('data', log);
    launched.on('error', error => { spawnError = error; });
    launched.on('exit', () => {
      if (child === launched) { child = null; update({ status: 'stopped', owner: null, activeDirectory: null }); }
    });
    const deadline = Date.now() + startupMs;
    while (Date.now() < deadline) {
      try {
        await ping();
        await pause(80);
        const managed = child === launched && owned() && !/address.*in use|bind:/i.test(logTail);
        update({ status: 'ready', owner: managed ? 'vesper' : 'external', activeDirectory: managed ? directory : null, error: '' });
        if (managed) store.update({ modelDirectory: directory });
        return { ...state };
      } catch {}
      if (spawnError) break;
      await pause(250);
    }
    const message = spawnError ? 'Ollama 进程无法启动，请检查安装文件与执行权限。' : /address.*in use|bind:/i.test(logTail) ? '11434 端口被占用，且探活未确认可用的 Ollama，请关闭冲突程序后重试。' : 'Ollama 启动超时，请检查运行库、驱动或重新连接。';
    update({ status: 'error', error: message }); throw new Error(message);
  }
  function ensure({ signal } = {}) {
    if (!pending) pending = start().finally(() => { pending = null; });
    return waitFor(pending, signal);
  }
  async function stop() {
    if (!owned()) return;
    const target = child; closing = true;
    try {
      // 只终止仍由本进程持有的子进程树，不按名称结束外部 Ollama。
      if (platform === 'win32') await runFile('taskkill.exe', ['/PID', String(target.pid), '/T', '/F'], { windowsHide: true, timeout: 6000 });
      else target.kill('SIGTERM');
      const deadline = Date.now() + 6000;
      while (child === target && owned() && Date.now() < deadline) await pause(60);
      if (child === target && owned()) throw new Error('Ollama 尚未退出，目录没有切换，请重试。');
    } finally { closing = false; }
  }
  async function applyDirectory(directory) {
    if (pending) await pending.catch(() => {});
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('请选择有效的绝对目录。');
    const target = path.resolve(directory);
    fs.mkdirSync(target, { recursive: true });
    const probe = path.join(target, `.vesper-write-${randomUUID()}`);
    try { fs.writeFileSync(probe, ''); } catch { throw new Error('所选模型目录不可写，请更换目录或检查权限。'); }
    finally { try { fs.unlinkSync(probe); } catch {} }
    if (platform === 'win32') {
      await saveModelsEnvironment(target, runFile);
    }
    process.env.OLLAMA_MODELS = target;
    store.update({ pendingModelDirectory: target });
    let live = false; try { await ping(); live = true; } catch {}
    if (live && !owned()) {
      update({ status: 'ready', owner: 'external', activeDirectory: null, error: '目录已保存但尚未生效。请退出托盘 Ollama，再点击“应用目录并重启”。' });
      return { pending: true };
    }
    await stop();
    store.update({ modelDirectory: target, pendingModelDirectory: null });
    update({ status: 'stopped', owner: null, activeDirectory: null, error: '' });
    try { await ensure(); } catch (error) { update({ error: error.message }); }
    return { pending: false };
  }
  return { ensure, inspect, ping, stop, applyDirectory, owned, snapshot: () => ({ ...state }) };
}

module.exports = { createOllamaService, findOllama, waitFor, saveModelsEnvironment };
