const { app, BrowserWindow, ipcMain, safeStorage, clipboard, screen, dialog, nativeTheme } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

const defaults = { mode: 'simulation', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini', temperature: 0.7, systemPrompt: '你是一个简洁友好的中文助手', theme: 'system', collapsed: false };
let settings, database, windowState, win, active = null, testController = null;
let recoveryNotice = '';
const dataFile = name => path.join(app.getPath('userData'), `${name}.json`);

function writeJSON(name, value) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  const target = dataFile(name);
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, target);
}

function readJSON(name, fallback) {
  try { return JSON.parse(fs.readFileSync(dataFile(name), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') {
      const backup = `${dataFile(name)}.damaged-${Date.now()}`;
      try { fs.copyFileSync(dataFile(name), backup); } catch {}
      recoveryNotice += `「${name}.json」无法读取，已尝试备份并恢复默认值。`;
    }
    return structuredClone(fallback);
  }
}

function initStorage() {
  settings = { ...defaults, ...readJSON('settings', {}) };
  database = readJSON('conversations', { currentId: null, chats: [] });
  if (!Array.isArray(database.chats)) database = { currentId: null, chats: [] };
  database.chats = database.chats.filter(c => typeof c.id === 'string' && Array.isArray(c.messages));
  // 意外退出留下的半条回复仍可阅读，同时明确标记中断。
  for (const c of database.chats) for (const m of c.messages) if (m.status === 'streaming') m.status = 'stopped';
  if (!database.chats.length) createChat();
  if (!database.chats.some(c => c.id === database.currentId)) database.currentId = database.chats[0].id;
  windowState = readJSON('window', {});
}

function keyPlain() {
  if (!settings.encryptedKey) return '';
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 本机密钥加密不可用，无法解密 API Key。');
  try { return safeStorage.decryptString(Buffer.from(settings.encryptedKey, 'base64')); }
  catch { throw new Error('API Key 无法在当前 Windows 账户解密，请重新填写。'); }
}

function publicSettings() {
  const { encryptedKey, ...visible } = settings;
  let keyLast4 = '', keyError = '';
  try { keyLast4 = keyPlain().slice(-4); } catch (e) { keyError = e.message; }
  return { ...visible, hasKey: Boolean(encryptedKey), keyLast4, keyError };
}
function state() { return { settings: publicSettings(), database, busy: active ? { chatId: active.chatId, requestId: active.id } : null, recoveryNotice }; }
function saveChats() { writeJSON('conversations', database); }
function findChat(id) {
  const c = database.chats.find(c => c.id === id);
  if (!c) throw new Error('会话不存在，请重新选择。');
  return c;
}
function createChat() {
  const c = { id: randomUUID(), title: '新的对话', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  database.chats.unshift(c); database.currentId = c.id; saveChats(); return c;
}

function validateSettings(input) {
  if (!input || typeof input !== 'object') throw new Error('设置格式不正确。');
  const next = { ...settings };
  if (input.mode !== undefined) {
    if (!['simulation', 'online'].includes(input.mode)) throw new Error('请选择有效模式。');
    next.mode = input.mode;
  }
  if (input.baseURL !== undefined) {
    let u;
    try { u = new URL(String(input.baseURL).trim()); } catch { throw new Error('Base URL 格式错误，请输入完整地址。'); }
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error('Base URL 仅支持不带凭据、查询参数或片段的 HTTP(S) 地址。');
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol === 'http:' && !local) throw new Error('远程接口请使用 HTTPS；HTTP 仅允许本机 Ollama 等服务。');
    next.baseURL = u.href.replace(/\/+$/, '');
  }
  if (input.model !== undefined) {
    next.model = String(input.model).trim();
    if (!next.model || next.model.length > 200) throw new Error('模型名不能为空，且不能超过 200 字。');
  }
  if (input.temperature !== undefined) {
    const t = Number(input.temperature);
    if (!Number.isFinite(t) || t < 0 || t > 1.5) throw new Error('Temperature 应在 0–1.5 之间。');
    next.temperature = t;
  }
  if (input.systemPrompt !== undefined) next.systemPrompt = String(input.systemPrompt).slice(0, 20000);
  if (input.theme !== undefined) {
    if (!['system', 'light', 'dark'].includes(input.theme)) throw new Error('主题选项无效。');
    next.theme = input.theme;
  }
  if (input.collapsed !== undefined) next.collapsed = Boolean(input.collapsed);
  return next;
}

function prepareConnection(input = {}) {
  const config = validateSettings(input);
  config.apiKey = input.removeKey ? '' : (typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim() : keyPlain());
  if (/[\r\n]/.test(config.apiKey)) throw new Error('API Key 不能包含换行。');
  return config;
}

function humanError(error, status) {
  if (error.name === 'AbortError') return '请求已停止。';
  const raw = String(error.message || error);
  if (status === 401 || /invalid.*key|incorrect.*key|unauthorized/i.test(raw)) return '密钥无效或已过期，请检查 API Key。';
  if (/insufficient|quota|balance|credit|余额|欠费/i.test(raw) || status === 402) return '余额不足或额度已用尽，请到接口提供方查看账户。';
  if (status === 404 || /model.*(not found|does not exist|not exist)/i.test(raw)) return '模型不存在或接口地址错误，请检查 Base URL 与模型名。';
  if (status === 403) return '接口拒绝访问，请检查模型权限或服务地区限制。';
  if (status === 429) return '请求过于频繁或额度受限，请稍后重试。';
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|network|Failed to fetch/i.test(raw)) return '网络连接失败，请检查网络、代理和 Base URL；本地模型请先启动服务。';
  return status ? `接口错误（${status}）：${raw.slice(0, 400)}` : raw.slice(0, 400);
}

// SSE 按行缓冲，兼容 CRLF、跨数据包 UTF-8、多个 data 行和结束标记。
function makeSSE(onDelta) {
  let buffer = '', lines = [], done = false;
  function dispatch() {
    if (!lines.length || done) { lines = []; return; }
    const raw = lines.join('\n'); lines = [];
    if (raw.trim() === '[DONE]') { done = true; return; }
    let packet;
    try { packet = JSON.parse(raw); } catch { throw new Error('服务返回了无法解析的流式数据，请确认接口兼容 Chat Completions。'); }
    if (packet.error) throw new Error(humanError(new Error(packet.error.message || '接口返回错误')));
    const value = packet.choices?.[0]?.delta?.content;
    if (typeof value === 'string') onDelta(value);
    else if (Array.isArray(value)) for (const p of value) if (p.text) onDelta(p.text);
  }
  return {
    push(text, final = false) {
      buffer += text;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).replace(/\r$/, ''); buffer = buffer.slice(i + 1);
        if (!line) dispatch(); else if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, ''));
      }
      if (final) { if (buffer.startsWith('data:')) lines.push(buffer.slice(5).trim()); buffer = ''; dispatch(); }
      return done;
    }
  };
}

async function online(config, messages, controller, onDelta, testing = false) {
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 60000);
  try {
    const response = await fetch(`${config.baseURL}/chat/completions`, {
      method: 'POST', signal: controller.signal, redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
      body: JSON.stringify({ model: config.model, temperature: config.temperature, stream: true,
        messages: [{ role: 'system', content: config.systemPrompt }, ...messages], ...(testing ? { max_tokens: 8 } : {}) })
    });
    if (!response.ok) {
      const body = await response.text();
      let detail; try { detail = JSON.parse(body).error?.message; } catch {}
      throw new Error(humanError(new Error(detail || body || response.statusText), response.status));
    }
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('接口未返回 SSE 流，请确认支持 stream: true。');
    const reader = response.body.getReader(), decoder = new TextDecoder();
    const parser = makeSSE(onDelta);
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { parser.push(decoder.decode(), true); break; }
        if (parser.push(decoder.decode(value, { stream: true }))) { await reader.cancel(); break; }
      }
    } finally { reader.releaseLock(); }
  } catch (e) {
    if (timedOut) { const timeoutError = new Error('网络超时：请求超过 60 秒，请检查网络或稍后重试。'); timeoutError.name = 'TimeoutError'; throw timeoutError; }
    if (controller.signal.aborted) { const err = new Error('请求已停止。'); err.name = 'AbortError'; throw err; }
    throw new Error(humanError(e));
  } finally { clearTimeout(timer); }
}

const choose = items => items[Math.floor(Math.random() * items.length)];
function simulate(messages) {
  const input = messages.at(-1)?.content || '';
  const previous = messages.slice(0, -1).filter(m => m.role === 'user').at(-1)?.content;
  const context = previous ? `延续刚才提到的「${previous.replace(/[\n\r`#*]/g, ' ').slice(0, 16)}」，` : '';
  let sentences;
  if (/代码|编程|函数|javascript|python|程序|算法/i.test(input)) {
    const python = /python/i.test(input);
    return `${context}${choose(['可以先写一个最小示例，确认思路后再扩展。', '我们把任务拆成输入、处理和输出三个部分。'])}\n\n` +
      (python ? '```python\ndef greet(name):\n    return f"你好，{name}！"\n\nprint(greet("Vesper"))\n```' : '```javascript\nfunction greet(name) {\n  return `你好，${name}！`;\n}\n\nconsole.log(greet("Vesper"));\n```') +
      '\n\n这段代码演示了函数定义与调用。你可以告诉我具体的输入和期望结果，我们再一起细化。';
  }
  if (/表格|对比|比较/.test(input)) return `${context}可以用下面的表格整理思路。\n\n| 方案 | 优点 | 适用场景 |\n| --- | --- | --- |\n| 先做小样 | 反馈快、容易修改 | 验证想法 |\n| 分步推进 | 节奏清晰、方便复盘 | 持续执行 |\n\n先选一个小目标试一试，再根据反馈调整。`;
  if (/翻译|translate/i.test(input)) {
    const source = input.replace(/^.*?(翻译[：:]?|translate[：:]?)\s*/i, '').trim();
    const dictionary = { '你好': 'Hello.', '早上好': 'Good morning.', '谢谢': 'Thank you.', 'hello': '你好。', 'good morning': '早上好。', 'thank you': '谢谢。' };
    const translated = dictionary[source.toLowerCase().replace(/[!！。.]$/, '')];
    return translated ? `可以译为：**${translated}**\n\n这是一个常见的日常表达。换个语境时，也可以调整语气。` : `我注意到你想翻译「${source.slice(0, 80) || '这段内容'}」。\n\n本地演示词库支持“你好”“早上好”“谢谢”等短语；更完整的翻译可以切换在线模式。你也可以补充使用场景，先确定正式或口语的表达风格。`;
  }
  if (/你好|嗨|您好|hello|早安|晚上好/i.test(input)) sentences = [choose(['你好呀，很高兴见到你！', '嗨，我是Vesper，随时可以陪你聊聊。']), '你可以带着一个问题来，也可以从今天的小事说起。', '我们慢慢聊，把想法逐步理清楚。', '想先聊工作、学习，还是生活里的新发现？', '如果没想好，可以试试下方输入框，随手写一句。'];
  else if (/心情|难过|开心|累|烦|聊天|无聊/.test(input)) sentences = [choose(['听起来，你现在有些感受想说出来。', '我在听，可以慢慢说。']), '可以先给自己一点喘息的时间，喝口水，放松一下肩膀。', '如果愿意，试着描述今天最影响你的一件小事。', '不用急着找到答案，先把事情说清楚也很有帮助。', '今天有没有一个小小的瞬间，让你觉得轻松一点？'];
  else if (/计划|安排|学习|效率|建议/.test(input)) sentences = [choose(['可以先把目标缩小到今天就能完成的一步。', '先确定你最想获得的结果，再安排时间。']), '把任务分成三个阶段：准备、执行和复盘。', '给第一步留出 20 分钟，结束后记录一个发现。', '如果觉得困难，就继续缩小任务，让开始变得容易。', '你可以告诉我可用的时间和目标，我们一起整理优先级。'];
  else sentences = [choose(['这是个值得拆开想一想的问题。', '可以从一个具体例子开始理解。', '我先给你一个简单的思考方向。']), '先确认目标，再列出已经知道的信息和还不确定的部分。', '试着找一个最小的行动，用结果来检验你的想法。', '如果存在多种选择，可以比较时间、成本和预期收益。', '你也可以补充背景或限制条件，让下一步更具体。'];
  return context + sentences.slice(0, 2 + Math.floor(Math.random() * 4)).join('\n\n');
}

function emit(value) { if (win && !win.isDestroyed()) win.webContents.send('chat:stream', value); }
async function generate(run, chat, response, config) {
  let saveTimer;
  const update = text => {
    if (run.controller.signal.aborted) return;
    response.content += text;
    emit({ requestId: run.id, chatId: chat.id, messageId: response.id, type: 'delta', text });
    if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; try { saveChats(); } catch {} }, 700);
  };
  try {
    const history = chat.messages.filter(m => m.id !== response.id && m.content && !m.error).map(({ role, content }) => ({ role, content }));
    if (config.mode === 'simulation') {
      await delay(300 + Math.floor(Math.random() * 501), null, { signal: run.controller.signal });
      for (const char of simulate(history)) {
        await delay(15 + Math.floor(Math.random() * 31), null, { signal: run.controller.signal });
        update(char);
      }
    } else {
      let received = false;
      await online(config, history, run.controller, text => { received = true; update(text); });
      if (!received) throw new Error('接口返回了空回复，请检查模型是否支持文本对话。');
    }
    response.status = run.controller.signal.aborted ? 'stopped' : 'done';
  } catch (e) {
    response.status = run.controller.signal.aborted && e.name !== 'TimeoutError' ? 'stopped' : 'error';
    if (response.status === 'error') response.error = humanError(e).replaceAll(config.apiKey || '\u0000', '〔密钥已隐藏〕');
  } finally {
    clearTimeout(saveTimer);
    chat.updatedAt = Date.now();
    try { saveChats(); } catch { response.error = '对话保存失败，请检查磁盘空间和目录权限。'; response.status = 'error'; }
    if (active === run) active = null;
    emit({ requestId: run.id, chatId: chat.id, messageId: response.id, type: 'end', message: response });
  }
}

function registerIPC() {
  const handle = (channel, fn) => ipcMain.handle(channel, async (event, value) => {
    if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame) return { ok: false, error: '调用来源无效。' };
    try { return { ok: true, value: await fn(value) }; } catch (e) { return { ok: false, error: humanError(e) }; }
  });
  handle('state:load', state);
  handle('settings:save', input => {
    const next = validateSettings(input);
    if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 本机密钥加密不可用，已拒绝明文保存。');
      if (/[\r\n]/.test(input.apiKey)) throw new Error('API Key 不能包含换行。');
      next.encryptedKey = safeStorage.encryptString(input.apiKey.trim()).toString('base64');
    }
    if (input.removeKey) delete next.encryptedKey;
    writeJSON('settings', next); settings = next; return publicSettings();
  });
  handle('settings:reveal', keyPlain);
  handle('connection:test', async input => {
    if (testController) throw new Error('连接测试正在进行。');
    const config = prepareConnection(input), controller = new AbortController();
    testController = controller;
    const start = Date.now(); let result = '';
    try {
      await online(config, [{ role: 'user', content: '请只回复：好' }], controller, text => { result += text; }, true);
      if (!result) throw new Error('接口返回空回复。');
      return { elapsed: Date.now() - start };
    } catch (e) { throw new Error(e.message.replaceAll(config.apiKey || '\u0000', '〔密钥已隐藏〕')); }
    finally { testController = null; }
  });
  handle('chat:new', () => { createChat(); return state(); });
  handle('chat:select', id => { findChat(id); database.currentId = id; saveChats(); return state(); });
  handle('chat:rename', ({ id, title }) => {
    if (typeof title !== 'string' || !title.trim()) throw new Error('标题不能为空。');
    findChat(id).title = title.trim().slice(0, 80); saveChats(); return state();
  });
  const requireIdle = id => { if (active?.chatId === id) throw new Error('请先停止当前回复。'); };
  handle('chat:delete', id => {
    requireIdle(id); findChat(id); database.chats = database.chats.filter(c => c.id !== id);
    if (!database.chats.length) createChat();
    if (database.currentId === id) database.currentId = database.chats[0].id;
    saveChats(); return state();
  });
  handle('chat:clear', id => { requireIdle(id); findChat(id).messages = []; saveChats(); return state(); });
  handle('chat:send', ({ chatId, content, requestId }) => {
    if (active) throw new Error('另一条回复正在生成，请先停止。');
    if (typeof content !== 'string' || !content.trim() || content.length > 32000) throw new Error('请输入 1–32000 字的消息。');
    if (typeof requestId !== 'string' || requestId.length > 100) throw new Error('请求标识无效。');
    const config = settings.mode === 'online' ? prepareConnection() : { ...settings };
    const chat = findChat(chatId);
    const user = { id: randomUUID(), role: 'user', content: content.trim(), createdAt: Date.now() };
    const response = { id: randomUUID(), role: 'assistant', mode: config.mode, content: '', status: 'streaming', createdAt: Date.now() };
    chat.messages.push(user, response);
    if (chat.messages.length === 2 && chat.title === '新的对话') chat.title = content.trim().replace(/\s+/g, ' ').slice(0, 22);
    chat.updatedAt = Date.now(); saveChats();
    const run = { id: requestId, chatId, controller: new AbortController() }; active = run;
    // 先把消息对象返回页面，再开始推送，避免首段流丢失。
    setTimeout(() => generate(run, chat, response, config), 40);
    return { user, response, title: chat.title };
  });
  handle('chat:stop', id => { if (active?.id === id) active.controller.abort(); return true; });
  handle('clipboard:write', text => { if (typeof text !== 'string' || text.length > 2000000) throw new Error('复制内容过长。'); clipboard.writeText(text); return true; });
}

function createWindow() {
  // 直接读取主题变量供原生窗口首帧使用，避免在 JS 中复制色值。
  const palette = fs.readFileSync(path.join(__dirname, 'renderer/styles.css'), 'utf8');
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && nativeTheme.shouldUseDarkColors);
  const section = dark ? palette.split('[data-theme="dark"]')[1] : palette;
  const initialBackground = section.match(/--bg-app:\s*([^;]+);/)[1].trim();
  const saved = windowState.bounds || {}, bounds = { width: Math.max(820, saved.width || 1100), height: Math.max(560, saved.height || 760) };
  if (Number.isFinite(saved.x) && Number.isFinite(saved.y) && screen.getAllDisplays().some(d => saved.x < d.workArea.x + d.workArea.width - 80 && saved.x + bounds.width > d.workArea.x + 80 && saved.y >= d.workArea.y && saved.y < d.workArea.y + d.workArea.height - 80)) Object.assign(bounds, { x: saved.x, y: saved.y });
  win = new BrowserWindow({ ...bounds, minWidth: 820, minHeight: 560, title: 'Vesper', backgroundColor: initialBackground, icon: path.join(__dirname, 'build/icon.ico'), show: false, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false } });
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_w, _p, cb) => cb(false));
  // 页面完全离线：在线模型请求由主进程 fetch 转发。
  win.webContents.session.webRequest.onBeforeRequest((details, cb) => cb({ cancel: /^https?:|^wss?:/.test(details.url) }));
  win.loadFile(path.join(__dirname, 'renderer/index.html'));
  const created = win;
  const show = event => {
    if(event.sender !== created.webContents) return;
    ipcMain.removeListener('theme:ready', show);
    if(!created.isDestroyed()) { if(windowState.maximized) created.maximize(); created.show(); }
  };
  ipcMain.on('theme:ready', show);
  created.once('closed', () => ipcMain.removeListener('theme:ready', show));
  win.on('close', () => {
    active?.controller.abort(); testController?.abort();
    if (active) { for (const m of findChat(active.chatId).messages) if (m.status === 'streaming') m.status = 'stopped'; }
    try { writeJSON('window', { bounds: win.getNormalBounds(), maximized: win.isMaximized() }); saveChats(); } catch {}
  });
  return win;
}

async function bootstrap() {
  app.setName('Vesper');
  if (process.env.VESPER_TEST_DATA && !app.isPackaged) {
    fs.mkdirSync(process.env.VESPER_TEST_DATA, { recursive: true });
    app.setPath('userData', process.env.VESPER_TEST_DATA);
  }
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  await app.whenReady();
  initStorage(); registerIPC(); createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  app.on('window-all-closed', () => app.quit());
}
if (require.main === module) bootstrap().catch(e => { dialog.showErrorBox('Vesper启动失败', humanError(e)); app.quit(); });
module.exports = { bootstrap, initStorage, createWindow, makeSSE, simulate, online, humanError, getWindow: () => win };
