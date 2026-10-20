// 下载源、命令和安装参数均由主进程固定，页面只能开始或取消下载。
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: pause } = require('node:timers/promises');
const { findOllama } = require('./ollama-service.cjs');
const executeFile = promisify(execFile);
const RELEASE_URL = 'https://api.github.com/repos/ollama/ollama/releases/latest';
const HOSTS = new Set(['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const BUSY = new Set(['checking', 'downloading', 'verifying', 'installing', 'connecting']);

function trustedURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) throw new Error('安装包下载地址不属于受信任的官方发布源。');
  return url;
}

function openHTTPS(value, signal, redirects = 0) {
  return new Promise((resolve, reject) => {
    const url = trustedURL(value);
    const request = https.get(url, { signal, headers: { 'User-Agent': 'Vesper-Ollama-Installer', Accept: 'application/vnd.github+json' } }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (redirects >= 5 || !response.headers.location) { reject(new Error('官方下载重定向次数过多。')); return; }
        try { openHTTPS(new URL(response.headers.location, url).href, signal, redirects + 1).then(resolve, reject); } catch (error) { reject(error); } return;
      }
      if (response.statusCode !== 200) {
        response.resume(); reject(new Error(response.statusCode === 403 || response.statusCode === 429 ? '官方发布服务限流或拒绝访问，请稍后重试。' : `官方下载失败（HTTP ${response.statusCode}）。`)); return;
      }
      response.on('error', () => {});
      resolve(response);
    });
    request.setTimeout(60000, () => request.destroy(new Error('下载超时，请检查网络后重试。')));
    request.once('error', reject);
  });
}

function releaseAsset(release) {
  const asset = release?.assets?.find(item => item.name === 'OllamaSetup.exe');
  if (release?.draft || release?.prerelease || !/^v\d+\.\d+\.\d+(?:[.-][\w.]+)?$/.test(release?.tag_name || '') || !asset || !/^sha256:[a-f\d]{64}$/i.test(asset.digest || '') || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 8 * 1024 ** 3) throw new Error('官方发布信息缺少有效的 Windows 安装包或 SHA-256 校验值，请稍后重试。');
  const expected = `https://github.com/ollama/ollama/releases/download/${release.tag_name}/OllamaSetup.exe`;
  if (asset.browser_download_url !== expected) throw new Error('官方安装包地址校验失败。');
  return { version: release.tag_name, url: expected, size: asset.size, sha256: asset.digest.slice(7).toLowerCase() };
}

async function latestRelease(signal) {
  const response = await openHTTPS(RELEASE_URL, AbortSignal.any([signal, AbortSignal.timeout(25000)]));
  let text = '';
  for await (const chunk of response) { text += chunk; if (Buffer.byteLength(text) > 2 * 1024 ** 2) { response.destroy(); throw new Error('官方发布信息体积异常。'); } }
  return releaseAsset(JSON.parse(text));
}

async function downloadAsset(asset, file, signal, progress, open = openHTTPS) {
  const response = await open(asset.url, signal);
  const length = Number(response.headers['content-length']);
  if (length && length !== asset.size) { response.destroy(); throw new Error('安装包长度与官方发布信息不一致，已拒绝安装。'); }
  const handle = await fs.promises.open(file, 'w', 0o600);
  let received = 0;
  try {
    for await (const chunk of response) {
      signal.throwIfAborted(); received += chunk.length;
      if (received > asset.size) throw new Error('安装包超过官方声明大小，已拒绝安装。');
      // FileHandle.writeFile 对单个缓冲区完整写入，不依赖一次 write 的返回长度。
      await handle.writeFile(chunk); progress(received, asset.size);
    }
    signal.throwIfAborted();
    if (received !== asset.size) throw new Error('安装包下载不完整，请重试。');
  } finally { response.destroy(); await handle.close(); }
}

async function verifyHash(file, expected, signal) {
  const stream = fs.createReadStream(file, { signal });
  const hash = createHash('sha256');
  for await (const chunk of stream) hash.update(chunk);
  if (hash.digest('hex') !== expected) throw new Error('安装包 SHA-256 校验失败，已拒绝运行，请重新下载。');
}

async function verifySignature(file, runFile = executeFile, signal) {
  // 显式加载 Windows 自带模块，避免父进程的 PowerShell 7 模块路径污染。
  const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop; $s=Get-AuthenticodeSignature -LiteralPath $env:VESPER_INSTALLER_FILE; [Console]::Out.Write($s.Status.ToString())";
  let stdout;
  try { ({ stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 60000, signal, env: { ...process.env, VESPER_INSTALLER_FILE: file } })); }
  catch (error) { if (signal?.aborted) throw error; throw new Error('无法完成 Windows 数字签名校验，请检查系统 PowerShell 安全模块与证书服务后重试。'); }
  if (stdout.trim() !== 'Valid') throw new Error(`Ollama 安装包数字签名无效（${stdout.trim() || '未知状态'}），已拒绝运行。`);
}

async function installPackage(file, runFile = executeFile) {
  // 官方安装器为当前账户安装；禁止自动重启，不要求管理员提权。
  const result = await runFile(file, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/NOCLOSEAPPLICATIONS', '/NORESTARTAPPLICATIONS'], { windowsHide: true, timeout: 30 * 60 * 1000, env: { ...process.env, OLLAMA_NO_CLOUD: '1' }, maxBuffer: 1024 * 1024 });
  return result;
}

function checkDisk(cacheDir, size) {
  const runtimeVolume = process.env.LOCALAPPDATA || cacheDir;
  const cache = fs.statfsSync(cacheDir), runtime = fs.statfsSync(runtimeVolume);
  const sameVolume = path.parse(cacheDir).root.toLowerCase() === path.parse(runtimeVolume).root.toLowerCase();
  if (cache.bavail * cache.bsize < size + (sameVolume ? 4 * 1024 ** 3 : 0) || runtime.bavail * runtime.bsize < 4 * 1024 ** 3) throw new Error('磁盘空间不足：运行库至少需要 4 GB，下载缓存还需要额外空间。请清理安装所在磁盘后重试。');
}

function readableError(error) {
  if (error.code === 'ENOSPC') return '磁盘空间不足，无法下载或安装 Ollama。';
  if (['ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN'].includes(error.code)) return '无法连接 Ollama 官方下载服务，请检查网络后重试。';
  if (error.code === 'EACCES' || error.code === 'EPERM') return '没有写入或执行权限，请检查 Windows 安全软件和文件权限。';
  if (error.killed || Number.isInteger(error.code)) return `Ollama 安装器未正常完成（${error.killed ? '等待超时' : `退出码 ${error.code}`}）。请重试；若已经装好，可点击“启动或重新连接”。`;
  return error.message || 'Ollama 安装失败，请重试。';
}

function createOllamaInstaller({ cacheDir, service, onInstalled, emit, platform = process.platform, findExecutable = findOllama, getRelease = latestRelease, download = downloadAsset, hash = verifyHash, signature = verifySignature, install = installPackage, disk = checkDisk }) {
  let state = { status: 'idle', progress: 0, received: 0, total: 0, version: '', error: '', message: '' };
  let pending = null, controller = null;
  const snapshot = () => ({ ...state, busy: BUSY.has(state.status), canCancel: !controller?.signal.aborted && ['checking', 'downloading', 'verifying'].includes(state.status) });
  const update = value => { state = { ...state, ...value }; emit(); };
  async function connect() {
    update({ status: 'connecting', message: '正在连接本机 Ollama 服务…' });
    await service.ensure(); await onInstalled();
    update({ status: 'ready', error: '', message: 'Ollama 已就绪，请在下方选择模型并下载部署。' });
  }
  async function run() {
    let partial;
    try {
      if (platform !== 'win32') throw new Error('一键安装目前仅支持 Windows。');
      const signal = controller.signal;
      await service.inspect(); signal.throwIfAborted();
      if (service.snapshot().status === 'ready' || findExecutable()) { await connect(); return; }
      if (!cacheDir || !path.isAbsolute(cacheDir)) throw new Error('运行库缓存目录无效。');
      const asset = await getRelease(signal); signal.throwIfAborted();
      fs.mkdirSync(cacheDir, { recursive: true }); disk(cacheDir, asset.size);
      const file = path.join(cacheDir, 'OllamaSetup.exe'); partial = path.join(cacheDir, 'OllamaSetup.part.exe');
      update({ status: 'downloading', version: asset.version, total: asset.size, message: '正在从 Ollama 官方发布源下载运行库…' });
      let lastPercent = -1;
      await download(asset, partial, signal, (received, total) => {
        const progress = Math.max(state.progress, Math.min(100, Math.floor(received / total * 100)));
        if (progress === lastPercent) return; lastPercent = progress;
        update({ progress, received, total });
      });
      signal.throwIfAborted();
      update({ status: 'verifying', progress: 100, received: asset.size, message: '正在校验 SHA-256 与 Windows 数字签名…' });
      await hash(partial, asset.sha256, signal); await signature(partial, undefined, signal); signal.throwIfAborted();
      fs.renameSync(partial, file); partial = null;
      // 下载期间若用户已自行安装或启动，立即复用，避免覆盖已有运行库。
      await service.inspect(); signal.throwIfAborted();
      if (service.snapshot().status !== 'ready' && !findExecutable()) {
        update({ status: 'installing', message: '正在自动安装 Ollama，请稍候；安装阶段无法取消。' });
        await install(file);
        for (let attempt = 0; !findExecutable() && attempt < 20; attempt++) await pause(250);
        if (!findExecutable()) throw new Error('安装器已结束，但未找到 Ollama 运行库。请检查安装日志或重试。');
      }
      await connect();
      try { fs.unlinkSync(file); } catch {}
    } catch (error) {
      const cancelled = controller.signal.aborted;
      update({ status: cancelled ? 'cancelled' : 'error', error: cancelled ? '' : readableError(error), message: cancelled ? '已取消运行库下载，可重新点击本地安装。' : '安装未完成，可以重试。' });
      if (!cancelled) throw new Error(state.error);
    } finally { if (partial) { try { fs.unlinkSync(partial); } catch {} } }
  }
  return {
    snapshot,
    start() {
      if (pending) return pending;
      controller = new AbortController();
      update({ status: 'checking', progress: 0, received: 0, total: 0, version: '', error: '', message: '正在检查本机 Ollama…' });
      pending = run().finally(() => { pending = null; }); return pending;
    },
    cancel() { if (snapshot().canCancel) { controller.abort(); update({ message: '正在取消下载…' }); } },
    async shutdown() { this.cancel(); if (pending) await pending.catch(() => {}); }
  };
}

module.exports = { createOllamaInstaller, releaseAsset, trustedURL, latestRelease, downloadAsset, verifyHash, verifySignature, installPackage };
