// 使用本机 HTTP 测试服务验证真正的 IPC、SSE 和渲染链路，不需要真实 API 密钥。
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { setTimeout: pause } = require('node:timers/promises');
const core = require('../main');
const reportRoot = app.isPackaged ? path.join(process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe')), 'test-results') : path.join(__dirname, '../work');
if (app.isPackaged) {
  const profile = path.join(reportRoot, `profile-${Date.now()}`);
  fs.mkdirSync(profile, { recursive: true }); app.setPath('userData', profile);
}
const results = [];
let win, server, port, lastBody, disconnects = 0;
let lastCheck = '';
const record = name => { results.push({ name, passed: true }); console.log(`通过：${name}`); };
const js = text => {
  lastCheck = text.replace(/"apiKey":"[^"]*"/g, '"apiKey":"〔已隐藏〕"').slice(0, 200);
  return win.webContents.executeJavaScript(text.includes('await ') ? `(async () => { ${text} })()` : text);
};
async function invoke(method, value) {
  const r = await js(`window.vesper.${method}(${value === undefined ? '' : JSON.stringify(value)})`);
  assert.equal(r.ok, true, r.error); return r.value;
}
async function until(fn, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await pause(60); }
  throw new Error('等待测试条件超时');
}
async function send(text) {
  const count = await js(`document.querySelectorAll('.assistant').length`);
  await js(`document.getElementById('messageInput').value=${JSON.stringify(text)};document.getElementById('messageInput').dispatchEvent(new Event('input'));document.getElementById('composer').requestSubmit();`);
  await until(() => js(`document.querySelectorAll('.assistant').length > ${count} && document.getElementById('sendButton').classList.contains('stopping')`));
}
async function idle() { await until(() => js(`!document.getElementById('sendButton').classList.contains('stopping') && !document.querySelector('.message.streaming')`), 30000); }
async function startServer() {
  server = http.createServer(async (req, res) => {
    let body = ''; for await (const b of req) body += b;
    lastBody = JSON.parse(body);
    const model = lastBody.model;
    const code = { 'error-key': 401, 'error-model': 404, 'error-balance': 429 }[model];
    if (code) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: model === 'error-balance' ? 'insufficient_quota' : model } })); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (model === 'timeout') return;
    const text = model === 'slow' ? '这是用于验证停止按钮的长回复。'.repeat(100) : '你好，流式连接成功！\n\n```javascript\nconst ok = true;\n```\n\n|项目|状态|\n|---|---|\n|本机接口|正常|';
    let closed = false;
    res.on('close', () => { closed = true; disconnects++; });
    for (const char of text) {
      if (closed) break;
      const packet = Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: char } }] })}\r\n\r\n`);
      // 刻意在任意字节处分包，验证中文 UTF-8 和 SSE 的增量解析。
      const split = packet.length - 12;
      res.write(packet.subarray(0, split)); await pause(2); res.write(packet.subarray(split));
      await pause(model === 'slow' ? 50 : 3);
    }
    if (!closed) res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); port = server.address().port;
}
async function readyWindow() { await until(() => js(`Boolean(window.vesper && document.querySelector('.chat-item'))`)); }
// 自检窗口在后台运行，避免把桌面用户正在输入的文字带进测试会话。
function backgroundTestWindow() {
  require('electron').ipcMain.removeAllListeners('theme:ready');
  win.webContents.setBackgroundThrottling(false);
}
(async () => {
  await core.bootstrap(); win = core.getWindow();
  backgroundTestWindow();
  if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  await readyWindow();
  const rendererErrors = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level === 3) rendererErrors.push(message); });
  assert.deepEqual(win.getSize(), [1100, 760]);
  assert.equal(await js(`typeof require`), 'undefined');
  assert.equal(win.webContents.getLastWebPreferences().contextIsolation, true);
  assert.equal(win.webContents.getLastWebPreferences().nodeIntegration, false);
  record('窗口启动、1100×760、上下文隔离与受限页面 API');

  const originalFetch = global.fetch;
  let simulationFetches = 0;
  global.fetch = async () => { simulationFetches++; throw new Error('测试断网'); };
  await send('你好');
  assert.match(await js(`document.querySelector('.assistant .markdown').innerText`), /思考中/);
  await until(async () => (await js(`document.querySelector('.assistant .markdown').innerText`)).length > 6);
  assert.equal(await js(`document.getElementById('sendButton').classList.contains('stopping')`), true);
  await idle();
  await send('请给我 JavaScript 代码'); await idle();
  const text = await js(`document.querySelectorAll('.assistant .markdown')[1].innerText`);
  assert.doesNotMatch(text, /延续刚才|提到的「你好」/);
  assert.equal(await js(`Boolean(document.querySelector('.code-block .hljs-keyword'))`), true);
  await js(`document.querySelector('.copy-code').click()`); await pause(100);
  assert.match(require('electron').clipboard.readText(), /function greet/);
  assert.equal(simulationFetches, 0); global.fetch = originalFetch;
  assert.equal(await js(`document.getElementById('composer').getBoundingClientRect().bottom <= innerHeight`), true);
  record('断网模拟连续对话、300–800ms 思考、逐字输出、无无关问候引用、代码高亮与复制');

  // 验证实际计算样式、外部 SVG 引用、两个已加载高亮样式和系统跟随。
  const themeResults=[];
  for(const theme of ['dark','light']) {
    const values=await js(`applyTheme('${theme}');(()=>{
      const style=getComputedStyle(document.documentElement), color=(name)=>{const el=document.createElement('i');el.style.color='var('+name+')';document.body.append(el);const v=getComputedStyle(el).color;el.remove();return v;};
      const actual=(selector,property)=>getComputedStyle(document.querySelector(selector))[property];
      const checks=[['body','backgroundColor','--bg-app'],['body','color','--text-primary'],['.sidebar','backgroundColor','--bg-panel'],['.settings-panel','backgroundColor','--bg-panel'],['.composer','backgroundColor','--bg-elevated'],['.user-bubble','backgroundColor','--bubble-user'],['.code-block','backgroundColor','--bg-code'],['.code-head','color','--text-secondary'],['.app-icon','color','--icon-color'],['.assistant-heading .app-icon','color','--icon-color'],['.badge','backgroundColor','--badge-neutral'],['.new-chat','backgroundColor','--accent-solid']];
      return {theme:'${theme}',checks:checks.map(([selector,property,key])=>({selector,property,actual:actual(selector,property),expected:color(key)})),keyword:actual('.hljs-keyword','color'),expectedKeyword:color('${theme==='dark'?'--syntax-ff7b72':'--syntax-d73a49'}'),styles:[...document.querySelectorAll('link[data-highlight]')].every(l=>Boolean(l.sheet)),svg:document.querySelector('.app-icon use').href.baseVal};
    })()`);
    for(const check of values.checks) assert.equal(check.actual,check.expected,JSON.stringify(check));
    assert.equal(values.keyword,values.expectedKeyword);assert(values.styles);assert.match(values.svg,/icon.svg#vesper-icon$/);
    assert.equal(await js(`['.section-label span','.new-chat kbd','.composer-caption'].every(s=>getComputedStyle(document.querySelector(s)).opacity==='1') && getComputedStyle(document.getElementById('messageInput'),'::placeholder').opacity==='1'`),true);
    themeResults.push(values);
    await pause(150);
    fs.mkdirSync(reportRoot,{recursive:true});
    fs.writeFileSync(path.join(reportRoot,'theme-'+theme+'.png'),(await win.webContents.capturePage()).toPNG());
    await js(`document.getElementById('settingsOpen').click()`);await pause(100);
    // 后台窗口没有系统键盘焦点；可见窗口版本已验证焦点环，此处只在有焦点时复测。
    if(await js('document.hasFocus()')) assert.equal(await js(`(()=>{const el=document.createElement('i');el.style.color='var(--accent)';document.body.append(el);const color=getComputedStyle(el).color;el.remove();const s=getComputedStyle(document.getElementById('settingsPanel'));return s.outlineColor===color && s.outlineWidth==='2px';})()`),true);
    fs.writeFileSync(path.join(reportRoot,'settings-'+theme+'.png'),(await win.webContents.capturePage()).toPNG());
    await js(`document.getElementById('settingsClose').click()`);
  }
  for(let i=0;i<20;i++) await js(`applyTheme('${i%2?'light':'dark'}')`);
  await js(`applyTheme('system')`);
  for(const theme of ['dark','light']) { require('electron').nativeTheme.themeSource=theme;await until(()=>js(`document.documentElement.dataset.theme === '${theme}'`)); }
  require('electron').nativeTheme.themeSource='system';
  fs.writeFileSync(path.join(reportRoot,'theme-results.json'),JSON.stringify(themeResults,null,2));
  record('双主题实际颜色、SVG 同步、GitHub 本地高亮、20 次切换与系统主题跟随');

  // 单独创建测试会话验证截图中的问题，再切回原会话，避免影响后续网络历史断言。
  const originalChat = (await invoke('load')).database.currentId;
  const scenarioChat = await invoke('newChat');
  const scenarioId = scenarioChat.database.currentId;
  await js(`setData(${JSON.stringify(scenarioChat)})`);
  await send('我想做过吃货地图的软件。你能帮我吗'); await idle();
  assert.match(await js(`document.querySelector('.assistant .markdown').innerText`), /店铺|店名|收藏/);
  assert.doesNotMatch(await js(`document.querySelector('.assistant .markdown').innerText`), /延续刚才|最小的行动|已经知道的信息/);
  await pause(100);
  fs.writeFileSync(path.join(reportRoot,'simulation-food-map.png'),(await win.webContents.capturePage()).toPNG());
  await send('先做网页版'); await idle();
  assert.match(await js(`document.querySelectorAll('.assistant .markdown')[1].innerText`), /网页版.*吃货地图/);
  await send('代码呢'); await idle();
  assert.match(await js(`document.querySelectorAll('.assistant .markdown')[2].innerText`), /filterShops/);
  assert.equal(await js(`document.querySelectorAll('.simulation-foot').length`),3);
  await pause(100);
  fs.writeFileSync(path.join(reportRoot,'simulation-food-map-followup.png'),(await win.webContents.capturePage()).toPNG());
  await invoke('deleteChat',scenarioId);
  await js(`setData((await window.vesper.selectChat(${JSON.stringify(originalChat)})).value)`);
  record('吃货地图真实问题、网页版追问、业务代码及模拟标识的完整渲染链路');

  // 直接渲染危险文本，确认 Markdown 不能执行 HTML 或加载远程图片。
  const xss = await js(`md.render('<img src=x onerror=alert(1)> ![远程](https://example.com/a.png)')`);
  assert(!xss.includes('<img')); assert(xss.includes('&lt;img'));
  record('Markdown 禁用原始 HTML，图片不触发远程加载');

  await startServer();
  const config = { mode: 'online', baseURL: `http://127.0.0.1:${port}/v1`, model: 'mock', apiKey: randomUUID(), temperature: 0.7, systemPrompt: '你是一个简洁友好的中文助手', theme: 'dark' };
  await invoke('saveSettings', config);
  const raw = fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8');
  assert(!raw.includes(config.apiKey)); assert(JSON.parse(raw).encryptedKey);
  const visible = await invoke('load'); assert.equal(visible.settings.keyLast4, config.apiKey.slice(-4)); assert(!JSON.stringify(visible).includes(config.apiKey));
  const ping = await invoke('testConnection', config); assert(ping.elapsed > 0); assert.equal(lastBody.max_tokens, 8);
  await js(`setData((await window.vesper.load()).value)`);
  await send('测试在线流'); await idle();
  assert.equal(await js(`document.querySelectorAll('.markdown table').length`), 1);
  assert.equal(await js(`document.querySelector('.badge').textContent`), '在线模式');
  assert.equal(lastBody.stream, true); assert.equal(lastBody.messages[0].role, 'system');
  assert(lastBody.messages.some(m => m.content === '你好'));
  record('本机兼容服务：在线 SSE、分包中文、[DONE]、Markdown 表格、上下文和连接测试');
  assert.equal(await js(`getComputedStyle(document.getElementById('modeBadge')).backgroundColor === getComputedStyle(document.getElementById('newChat')).backgroundColor`),true);
  record('safeStorage 加密落盘、默认仅显示密钥后四位');

  await invoke('saveSettings', { model: 'slow' }); await js(`setData((await window.vesper.load()).value)`);
  await send('停止测试'); await until(async () => (await js(`document.querySelectorAll('.assistant .markdown')[3].innerText`)).length > 4);
  const before = disconnects, stopAt = Date.now();
  await js(`document.getElementById('sendButton').click()`); await idle();
  assert(Date.now() - stopAt < 1500); await until(() => disconnects > before);
  assert.match(await js(`document.querySelectorAll('.status-foot')[0].innerText`), /已停止/);
  record('停止按钮触发 AbortController，1.5 秒内中断并关闭本机流');

  for (const [model, expected] of [['error-key','密钥无效'],['error-model','模型不存在'],['error-balance','余额不足']]) {
    const r = await js(`window.vesper.testConnection(${JSON.stringify({ ...config, model })})`); assert.equal(r.ok, false); assert(r.error.includes(expected), r.error);
  }
  const originalTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...args) => originalTimeout(fn, ms === 60000 ? 100 : ms, ...args);
  try {
    await assert.rejects(() => core.online({ ...config, model: 'timeout' }, [], new AbortController(), () => {}), /60 秒/);
    await invoke('saveSettings', { model: 'timeout' });
    await js(`setData((await window.vesper.load()).value)`);
    await send('超时测试'); await idle();
    assert.match(await js(`document.querySelector('.error-foot').innerText`), /60 秒/);
  } finally { global.setTimeout = originalTimeout; }
  record('401、404、额度不足中文错误与 60 秒超时逻辑（加速时钟验证）');

  const current = (await invoke('load')).database.currentId;
  const rename = await js(`window.vesper.renameChat(${JSON.stringify(current)},'持久化测试')`); assert(rename.ok);
  await invoke('saveSettings', { mode: 'simulation', theme: 'dark', collapsed: true, removeKey: true });
  win.setBounds({ x: 100, y: 100, width: 1020, height: 700 });
  const savedCount = (await invoke('load')).database.chats[0].messages.length;
  // 在同一测试进程中重建全部存储和窗口，验证关闭事件实际写入的数据。
  app.on('before-quit', e => e.preventDefault());
  win.close(); await pause(150); core.initStorage(); win = core.createWindow(); backgroundTestWindow();
  if(win.webContents.isLoading()) await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  await readyWindow();
  const restored = await invoke('load');
  assert.equal(restored.settings.theme, 'dark'); assert.equal(restored.settings.mode, 'simulation'); assert.equal(restored.settings.hasKey, false);
  assert.equal(restored.database.chats[0].messages.length, savedCount); assert.equal(restored.database.chats[0].title, '持久化测试');
  assert.deepEqual(win.getSize(), [1020, 700]); assert.deepEqual(win.getPosition(), [100, 100]);
  assert.equal(await js(`document.documentElement.dataset.theme`), 'dark'); assert.equal(await js(`document.getElementById('shell').classList.contains('collapsed')`), true);
  record('关闭重建：会话、重命名、模式、主题、侧栏和窗口大小/位置持久化');

  const created = await invoke('newChat'); const id = created.database.currentId;
  await js(`window.vesper.renameChat(${JSON.stringify(id)}, '临时测试')`);
  await invoke('clearChat', id); await invoke('deleteChat', id);
  assert.equal((await invoke('load')).database.chats.length, 1);
  await js(`setData((await window.vesper.load()).value);document.getElementById('settingsOpen').click()`);
  assert.equal(await js(`document.getElementById('settingsOverlay').hidden`), false);
  await js(`document.getElementById('settingsClose').click()`);
  win.setSize(820, 560); await pause(200);
  assert.equal(await js(`document.body.scrollWidth > innerWidth`), false);
  assert.equal(await js(`document.getElementById('composer').getBoundingClientRect().bottom <= innerHeight`), true);
  record('新建、重命名、清空、删除、设置抽屉和 820×560 最小窗口布局');
  assert.equal(rendererErrors.length, 0, rendererErrors.join('\n'));
  fs.mkdirSync(reportRoot, { recursive: true });
  fs.writeFileSync(path.join(reportRoot, 'test-results.json'), JSON.stringify({ time: new Date().toISOString(), profile: app.getPath('userData'), results, realProviderTested: false }, null, 2));
  console.log(`全部 ${results.length} 项自动检查通过；真实云端 API 未测试。`);
  app.exit(0);
})().catch(error => {
  console.error(error.stack);
  fs.mkdirSync(reportRoot, { recursive: true });
  fs.writeFileSync(path.join(reportRoot, 'test-results.json'), JSON.stringify({ time: new Date().toISOString(), results, failed: error.stack, failedCheck: lastCheck, realProviderTested: false }, null, 2));
  app.exit(1);
});
