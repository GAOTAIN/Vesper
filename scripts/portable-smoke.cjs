// 用实际 portable EXE 和独立 Chromium 用户目录检查打包后的窗口；不注入生产代码。
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { setTimeout: pause } = require('node:timers/promises');
const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const executable = path.join(root, 'dist', `Vesper-${version}-portable.exe`);
const profile = path.join(root, 'work', `portable-profile-${Date.now()}`);
const catalog = require('../assets/models.json');
const results = [];
let child, socket;
const pass = name => { results.push({ name, passed: true }); console.log(`通过：${name}`); };
async function until(task, ms = 30000) { const end = Date.now() + ms; while (Date.now() < end) { try { const value = await task(); if (value) return value; } catch {} await pause(100); } throw new Error('等待 portable 自检条件超时'); }
(async () => {
  assert(fs.existsSync(executable)); fs.mkdirSync(profile, { recursive: true });
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.VESPER_TEST_DATA;
  const log = fs.openSync(path.join(root, 'work/portable-debug.log'), 'w');
  child = spawn(executable, [`--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`], { env, windowsHide: true, stdio: ['ignore', log, log] });
  child.on('error', error => console.error(error.message));
  console.log(`启动独立 EXE 自检，启动器 PID ${child.pid}，调试端口 ${port}`);
  const target = await until(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
    const pages = await response.json();
    return pages.find(item => item.type === 'page' && item.url.includes('index.html'));
  }, 45000);
  // 先确认原生应用确实使用隔离目录，再进行任何设置更改。
  await until(() => fs.existsSync(path.join(profile, 'local-deployment.json')) && fs.existsSync(path.join(profile, 'conversations.json')));
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0; const pending = new Map();
  socket.addEventListener('message', event => {
    const packet = JSON.parse(String(event.data));
    if (!packet.id || !pending.has(packet.id)) return;
    const entry = pending.get(packet.id); pending.delete(packet.id); clearTimeout(entry.timer);
    if (packet.error) entry.reject(new Error(packet.error.message)); else entry.resolve(packet.result);
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`调试命令超时：${method}`)); }, 15000);
    pending.set(requestId, { resolve, reject, timer }); socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  const js = async expression => {
    const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result?.value;
  };
  await until(() => js('Boolean(window.vesper?.local && document.querySelector(".chat-item"))'));
  assert.equal(await js('typeof require'), 'undefined');
  assert.equal(await js('document.title'), 'Vesper');
  pass('实际单文件 EXE 独立解压启动窗口，隔离用户目录和渲染进程 Node 权限');
  for (const theme of ['light', 'dark']) {
    const current = await js(`(async () => { const result = await window.vesper.saveSettings({theme:${JSON.stringify(theme)}}); if(!result.ok) throw new Error(result.error); setData((await window.vesper.load()).value); return document.documentElement.dataset.theme; })()`);
    assert.equal(current, theme);
  }
  pass('实际 EXE 的深浅主题均可切换，并在隔离目录写入设置');
  await js('localPanel.open(); true');
  await until(() => js('localState?.hardware.status === "ready"'));
  assert.equal(await js('document.querySelectorAll(".local-model-card").length'), catalog.length);
  assert.equal(await js('document.getElementById("localModelCount").textContent'), `${catalog.length} 款本地模型`);
  for (const model of catalog.filter(item => item.ollamaTag.startsWith('deepseek-r1:'))) {
    assert.equal(await js(`document.querySelector('[data-model-id="${model.id}"] h4').textContent`), model.name);
  }
  assert.deepEqual(await js('[...document.querySelectorAll(".local-model-card h4")].map(node => node.textContent)'), catalog.map(model => model.name));
  assert.equal(await js('document.getElementById("modeBadge").textContent'), '本地部署模式');
  assert.equal(await js('localState.features.chat'), true);
  pass('实际 EXE 逐项显示完整模型目录，模型数据、硬件检测及面板均正常');
  await js('document.getElementById("localModelFamily").value="OLMo";document.getElementById("localModelFamily").dispatchEvent(new Event("change"));true');
  assert.equal(await js('document.querySelectorAll(".local-model-card:not([hidden])").length'), 3);
  await js('document.getElementById("localModelSearch").value="不存在的型号";document.getElementById("localModelSearch").dispatchEvent(new Event("input"));true');
  assert.equal(await js('document.getElementById("localModelEmpty").hidden'), false);
  await js('document.getElementById("localModelClear").click();true');
  assert.equal(await js('document.querySelectorAll(".local-model-card:not([hidden])").length'), catalog.length);
  pass('实际 EXE 中搜索、系列筛选、空结果与清除操作正常');
  assert.equal(await js('typeof window.vesper.local.installRuntime'), 'function');
  assert.equal(await js('typeof window.vesper.local.cancelInstall'), 'function');
  assert.equal(await js('typeof window.vesper.local.installHelp'), 'undefined');
  assert.equal(await js('localState.features.installation'), true);
  assert.equal(await js('localState.installer.status'), 'idle');
  pass('实际 EXE 包含一键安装和取消 API，打开面板不会自动下载运行库');
  await js('document.getElementById("localServiceTitle").scrollIntoView({block:"start"});true');
  const screenshot = await command('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(root, 'work/portable-local-panel.png'), Buffer.from(screenshot.data, 'base64'));
  await js('document.querySelector("[data-model-id=deepseek-r1-1-5b]").scrollIntoView({block:"start"});true');
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const deepseekScreenshot = await command('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(root, 'work/portable-deepseek-models.png'), Buffer.from(deepseekScreenshot.data, 'base64'));
  await js('document.getElementById("localModelsTitle").scrollIntoView({block:"start"});true');
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const catalogScreenshot = await command('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(root, 'work/portable-catalog.png'), Buffer.from(catalogScreenshot.data, 'base64'));
  await js('document.getElementById("localModelFamily").value="OLMo";document.getElementById("localModelFamily").dispatchEvent(new Event("change"));true');
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const openScreenshot = await command('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(root, 'work/portable-fully-open.png'), Buffer.from(openScreenshot.data, 'base64'));
  await js('setTimeout(() => window.close(), 50); true').catch(() => {});
  await until(() => child.exitCode !== null, 15000);
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')).mode, 'local');
  pass('实际 EXE 正常关闭，模式和设置留存在独立用户目录');
  fs.writeFileSync(path.join(root, 'work/portable-results.json'), JSON.stringify({ time: new Date().toISOString(), executable, profile, results, realOllamaInferenceTested: false }, null, 2));
  console.log(`全部 ${results.length} 项 portable 检查通过。`);
})().catch(error => {
  console.error(error.stack);
  fs.mkdirSync(path.join(root, 'work'), { recursive: true });
  fs.writeFileSync(path.join(root, 'work/portable-results.json'), JSON.stringify({ time: new Date().toISOString(), results, failed: error.stack }, null, 2));
  // 仅清理由本脚本创建的启动器及其子进程，不影响用户已有的窗口。
  if (child && child.exitCode === null) spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  process.exitCode = 1;
}).finally(() => { socket?.close(); });
