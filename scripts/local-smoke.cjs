// 使用真实 Electron 窗口和独立数据目录；不启动 Ollama、不访问云端、不改用户环境变量。
const { app, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: pause } = require('node:timers/promises');
const core = require('../main');
const http = require('node:http');
const si = require('systeminformation');
const { startMockOllama } = require('./mock-ollama.cjs');
const reportRoot = path.join(__dirname, '../work');
const results = [];
let win;
const errors = [];
const pass = name => { results.push({ name, passed: true }); console.log(`通过：${name}`); };
const js = script => win.webContents.executeJavaScript(script.includes('await ') ? `(async () => { ${script} })()` : script);
async function invoke(method, value) {
  const result = await js(`window.vesper.${method}(${value === undefined ? '' : JSON.stringify(value)})`);
  assert.equal(result.ok, true, result.error); return result.value;
}
async function until(task, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await task()) return; await pause(60); }
  throw new Error('等待本地面板状态超时');
}
async function setupWindow() {
  ipcMain.removeAllListeners('theme:ready');
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on('console-message', (_event, level, message) => { if (level === 3) errors.push(message); });
  if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  await until(() => js('Boolean(window.vesper?.local && document.querySelector(".chat-item"))'));
}

(async () => {
  const mock = await startMockOllama();
  const request = http.request;
  http.request = (options, callback) => request.call(http, options.hostname === '127.0.0.1' && options.port === 11434 ? { ...options, port: mock.port } : options, callback);
  let fetches = 0;
  global.fetch = async () => { fetches++; throw new Error('测试：禁止网络'); };
  await core.bootstrap(); win = core.getWindow(); await setupWindow();
  assert.equal((await invoke('local.state')).hardware.status, 'idle');
  assert.equal(await js('typeof window.vesper.local.execute'), 'undefined');
  pass('开发窗口启动；模拟模式启动不检测硬件，预加载层不暴露命令执行');

  await js('document.getElementById("localOpen").click()');
  await until(() => js('localState?.hardware.status === "ready"'));
  assert.equal(await js('document.getElementById("localOverlay").hidden'), false);
  assert.equal(await js('document.getElementById("modeBadge").textContent'), '本地部署模式');
  assert.equal(await js('document.getElementById("modeBadge").classList.contains("local")'), true);
  assert.equal(await js('document.querySelectorAll(".local-model-card").length'), 4);
  const state = await invoke('local.state');
  assert(state.hardware.result.checkedAt > 0); assert(Array.isArray(state.installedModels) || state.installedModels === null);
  assert.equal(state.features.chat, true); assert.equal(fetches, 0);
  pass('顶部按钮实际切换模式、显示四张模型卡、完成真实硬件检测且无云端请求');

  await js('document.querySelector(".local-requirements-button").click()');
  assert.equal(await js('document.getElementById("localRequirements").open'), true);
  assert.match(await js('document.getElementById("localRequirementsText").textContent'), /推荐显存 4GB、内存 8GB/);
  await js('document.getElementById("localRequirementsClose").click()');
  assert.equal(await js('document.getElementById("localRequirements").open'), false);
  pass('配置详情对话框可打开关闭，展示对应模型的推荐需求');

  const force = await js('window.vesper.local.detectHardware({ force: "错误参数" })');
  assert.equal(force.ok, false); assert.match(force.error, /参数/);
  assert.equal((await js('window.vesper.saveSettings({ mode: "错误模式" })')).ok, false);
  const count = (await invoke('load')).database.chats[0].messages.length;
  const denied = await js(`window.vesper.send(${JSON.stringify({ chatId: (await invoke('load')).database.currentId, content: '不能伪造回复', requestId: 'local-block-test' })})`);
  assert.equal(denied.ok, false); assert.match(denied.error, /下载并选择/);
  assert.equal((await invoke('load')).database.chats[0].messages.length, count);
  const connection = await js('window.vesper.testConnection({ mode: "local" })');
  assert.equal(connection.ok, false); assert.match(connection.error, /不会为本地模式调用在线接口/);
  assert.equal(fetches, 0);
  pass('IPC 拒绝无效参数；本地发送与连接测试受主进程拦截，无假消息和云端回退');

  fs.mkdirSync(reportRoot, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await invoke('saveSettings', { theme });
    await js('setData((await window.vesper.load()).value)'); await pause(120);
    assert.equal(await js('document.documentElement.dataset.theme'), theme);
    assert.equal(await js('getComputedStyle(document.getElementById("localPanel")).backgroundColor === getComputedStyle(document.querySelector(".sidebar")).backgroundColor'), true);
    assert.equal(await js('getComputedStyle(document.querySelector(".local-model-card")).backgroundColor === getComputedStyle(document.getElementById("composer")).backgroundColor'), true);
    // 隐藏窗口先唤醒合成帧，避免截图拿到刚关闭的对话框或上一主题。
    await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    await js('await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(reportRoot, `local-panel-${theme}.png`), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
  }
  pass('深浅主题同步切换；面板与卡片分别复用侧栏和输入框背景变量');

  win.setSize(820, 560); await pause(120);
  assert.equal(await js('document.body.scrollWidth > innerWidth'), false);
  assert.equal(await js('document.getElementById("localPanel").scrollWidth > document.getElementById("localPanel").clientWidth'), false);
  await js('document.getElementById("localPanel").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
  assert.equal(await js('document.getElementById("localOverlay").hidden'), true);
  assert.equal(await js('document.getElementById("shell").inert'), false);
  await js('document.getElementById("messageInput").value = "本地草稿"; document.getElementById("messageInput").dispatchEvent(new Event("input"))');
  assert.equal(await js('document.getElementById("sendButton").disabled'), true);
  await js('document.getElementById("messageInput").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))');
  assert.equal(await js('document.getElementById("messageInput").value'), '本地草稿');
  assert.equal((await invoke('load')).database.chats[0].messages.length, count);
  pass('820×560 面板无横向溢出，Escape 关闭恢复背景，未部署模型时保留输入草稿');

  await js('document.getElementById("settingsOpen").click()');
  assert.equal(await js('document.querySelector("input[name=mode][value=local]").checked'), true);
  assert.equal(await js('document.getElementById("testConnection").disabled'), true);
  await js('document.getElementById("settingsClose").click()');
  app.on('before-quit', event => event.preventDefault());
  win.close(); await pause(100);
  core.initStorage(); win = core.createWindow(); await setupWindow();
  assert.equal((await invoke('load')).settings.mode, 'local');
  assert.equal(await js('document.getElementById("modeBadge").textContent'), '本地部署模式');
  const stored = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'local-deployment.json'), 'utf8'));
  assert.equal(stored.schemaVersion, 1); assert.deepEqual(stored.downloading_models, []);
  assert.equal((await invoke('local.state')).hardware.status, 'idle');
  pass('设置面板识别第三种模式，关闭重建保留模式与本地 JSON，不伪造持久化硬件结果');

  win.setSize(1100, 760);
  await js('document.getElementById("localOpen").click()');
  await until(() => js('localState?.service.status === "ready" && localState?.hardware.status === "ready"'));
  mock.state.stallPull = true;
  await js('document.querySelector("[data-model-id=qwen25-3b] .model-download").click()');
  await until(() => js('localState.catalog.find(model => model.id === "qwen25-3b").progress >= 50'));
  await js('document.querySelector("[data-model-id=qwen25-3b] .model-download").click()');
  await until(() => js('localState.catalog.find(model => model.id === "qwen25-3b").status === "interrupted"'));
  assert.equal(await js('document.querySelector("[data-model-id=qwen25-3b] .model-download").textContent'), '继续下载');
  const priorProgress = (await invoke('local.state')).catalog.find(model => model.id === 'qwen25-3b').progress;
  mock.state.stallPull = false;
  await js('document.querySelector("[data-model-id=qwen25-3b] .model-download").click()');
  await until(() => js('localState.catalog.find(model => model.id === "qwen25-3b").status === "installed"'));
  assert(priorProgress > 0);
  assert.equal((await invoke('local.state')).config.downloading_models.length, 0);
  pass('真实 UI 下载、暂停、继续与完成，进度记录同步清理');

  const originalMemory = si.mem, originalGraphics = si.graphics;
  si.mem = async () => ({ total: 4 * 1024 ** 3, available: 2 * 1024 ** 3 });
  si.graphics = async () => ({ controllers: [{ model: '低配置测试显卡', vram: 1024 }] });
  try {
    await invoke('local.detectHardware', { force: true });
    const before = mock.state.requests.filter(item => item.route === '/api/pull').length;
    await js('document.querySelector("[data-model-id=qwen25-14b] .model-download").click()');
    await until(() => js('document.getElementById("localDecision").open'));
    assert.match(await js('document.getElementById("localDecisionText").textContent'), /硬件配置低于推荐要求/);
    assert.equal(await js('document.getElementById("localDecision").classList.contains("local-danger-dialog")'), true);
    await js('document.querySelector("#localDecision button[value=cancel]").click()');
    await until(() => js('!localPanel.operations.has("download:qwen25-14b")'));
    assert.equal(mock.state.requests.filter(item => item.route === '/api/pull').length, before);
    await js('document.querySelector("[data-model-id=qwen25-14b] .model-download").click()');
    await until(() => js('document.getElementById("localDecision").open'));
    await js('document.getElementById("localDecisionContinue").click()');
    await until(() => js('localState.catalog.find(model => model.id === "qwen25-14b").status === "installed"'));
  } finally { si.mem = originalMemory; si.graphics = originalGraphics; }
  await invoke('local.detectHardware', { force: true });
  pass('红色硬件警告包含取消与强制继续；取消不拉取，确认后才部署');

  await js('document.querySelector("[data-model-id=qwen25-3b]").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 700, clientY: 350 }))');
  assert.equal(await js('document.getElementById("localContextMenu").hidden'), false);
  await js('document.getElementById("localContextRequirements").click()');
  assert.equal(await js('document.getElementById("localRequirements").open'), true);
  await js('document.getElementById("localRequirementsClose").click()');
  await invoke('local.selectModel', 'qwen25-3b');
  await js('document.getElementById("localModels").scrollIntoView({ block: "start" })');
  await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
  fs.writeFileSync(path.join(reportRoot, 'local-models-dark.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
  await js('document.getElementById("localClose").click()');
  pass('已安装模型右键查看配置，选择模型同步到聊天模式');

  await js('document.getElementById("messageInput").value = "你好";document.getElementById("messageInput").dispatchEvent(new Event("input"));document.getElementById("composer").requestSubmit()');
  await until(() => js('document.querySelector(".assistant .markdown table") && !document.querySelector(".message.streaming")'));
  assert.equal(mock.state.lastChat.options.num_ctx, 4096);
  assert.match(await js('document.querySelector(".assistant .message-meta").textContent'), /本地模型/);
  assert.equal(await js('document.querySelectorAll(".simulation-foot").length'), 0);
  assert.equal(await js('document.querySelectorAll(".assistant .code-block").length'), 1);
  await js('document.getElementById("messageInput").value = "停止测试";document.getElementById("messageInput").dispatchEvent(new Event("input"));document.getElementById("composer").requestSubmit()');
  await until(() => js('document.querySelectorAll(".assistant").length === 2 && document.querySelectorAll(".assistant .markdown")[1].textContent.includes("这是")'));
  await js('document.getElementById("sendButton").click()');
  await until(() => js('!document.querySelector(".message.streaming")'));
  assert.match(await js('document.querySelector(".status-foot").textContent'), /已停止/);
  pass('本地聊天完整 UI 流式链路、Markdown 代码表格、模型身份和停止按钮');

  await js('document.getElementById("localOpen").click()');
  await until(() => js('!localPanel.opening'));
  await js('document.querySelector("[data-model-id=qwen25-3b] .model-remove").click()');
  await until(() => js('document.getElementById("localDecision").open'));
  await js('document.getElementById("localDecisionContinue").click()');
  await until(() => js('localState.catalog.find(model => model.id === "qwen25-3b").installed === false'));
  assert.equal(await js('document.querySelector("[data-model-id=qwen25-3b] .model-remove").hidden'), true);
  pass('卸载确认后立即刷新卡片与下载状态');
  await mock.close(); http.request = request;
  assert.equal(fetches, 0); assert.equal(errors.length, 0, errors.join('\n'));
  fs.writeFileSync(path.join(reportRoot, 'local-window-results.json'), JSON.stringify({ time: new Date().toISOString(), profile: app.getPath('userData'), results, hardware: state.hardware.result, cloudRequests: fetches, ollamaIntegrated: true, mockOllama: true, actualWeightsUsed: false }, null, 2));
  console.log(`全部 ${results.length} 项本地窗口检查通过。`);
  app.exit(0);
})().catch(error => {
  console.error(error.stack);
  fs.mkdirSync(reportRoot, { recursive: true });
  fs.writeFileSync(path.join(reportRoot, 'local-window-results.json'), JSON.stringify({ time: new Date().toISOString(), results, failed: error.stack }, null, 2));
  app.exit(1);
});
