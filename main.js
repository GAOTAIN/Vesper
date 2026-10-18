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
// 项目场景提供具体的业务内容，而不是把所有问题套进同一段建议。
const simulationProjects = [
  {
    id: 'food', name: '吃货地图', match: /(?:吃货|美食|探店|餐厅|餐馆|小吃).{0,12}(?:地图|软件|应用|小程序|网站|app)|地图.{0,12}(?:美食|餐厅|店铺)/i,
    goal: '把想去和吃过的店保存在地图上，按位置找到它们',
    features: [['地图找店', '在地图上显示店铺位置，点击标记查看详情'], ['收藏与标记', '区分“想去”和“去过”，按菜系或区域筛选'], ['记录体验', '自己填写评分、人均花费和一句评价']],
    fields: '店名、地址、经纬度、菜系、想去/去过、个人评分',
    flow: '找到一家店 → 收藏到地图 → 到店后补充评价',
    question: '你更想先做微信小程序，还是手机上能打开的网页？',
    example: '先手动添加三家店，检查收藏、筛选和地图标记能不能对应起来',
    boundary: '第一版先不做商家入驻、外卖下单和自动推荐，先把个人找店与记录的流程做顺。'
  },
  {
    id: 'expense', name: '记账工具', match: /记账|账本|收支管理|开销管理/,
    goal: '快速记下一笔收入或支出，再看清钱花在了哪些类别',
    features: [['快速记一笔', '输入金额、收入/支出和分类，可补备注'], ['账单列表', '按日期查看记录，支持修改和删除'], ['月度统计', '汇总当月收支，按类别查看支出']],
    fields: '金额、收入/支出、分类、日期、备注', flow: '记下一笔 → 查看账单 → 汇总当月收支',
    question: '你主要是自己记账，还是希望和家人一起记？', example: '先录入三笔不同分类的支出，核对列表和月度合计',
    boundary: '第一版先手动录入，不接银行账户，也不做复杂的多人结算。'
  },
  {
    id: 'todo', name: '待办清单', match: /待办|任务清单|任务管理|时间管理软件/,
    goal: '把要做的事记下来，并清楚看到今天还剩哪些任务',
    features: [['添加任务', '输入任务名称，可选截止时间'], ['完成与撤销', '勾选完成，也能恢复到未完成'], ['按状态查看', '区分今天要做、未完成和已完成']],
    fields: '任务名称、完成状态、截止时间、备注', flow: '添加任务 → 安排今天要做的事 → 勾选完成',
    question: '你更需要简单的个人清单，还是带截止提醒的任务管理？', example: '先添加三条任务，验证勾选、撤销和筛选',
    boundary: '第一版先做好个人清单，团队协作和复杂提醒可以后加。'
  },
  {
    id: 'notes', name: '笔记工具', match: /笔记软件|笔记应用|笔记工具|知识库|备忘录/,
    goal: '随手记下内容，再通过标题或标签找回来',
    features: [['创建笔记', '输入标题和正文，支持继续编辑'], ['笔记列表', '按更新时间排序，可搜索标题'], ['标签整理', '给笔记添加标签，按主题筛选']],
    fields: '标题、正文、标签、创建时间、更新时间', flow: '新建笔记 → 编辑保存 → 搜索找回',
    question: '你主要想记短备忘，还是整理较长的 Markdown 笔记？', example: '先保存三篇笔记，检查修改后能否重新打开和搜索',
    boundary: '第一版先做好本机保存与查找，多端同步和多人协作可以后加。'
  }
];
const isSimulationGreeting = text => /^(?:你好(?:呀|啊)?|您好|嗨|哈喽|hello|hi|早上好|早安|晚上好)[!！。，,.~～\s]*$/i.test(text);
const cleanSimulationTopic = text => text.replace(/[\r\n`#*<>\[\]|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 32);
function simulationProject(text) {
  const known = simulationProjects.find(project => project.match.test(text));
  if (known) return known;
  const match = text.match(/(?:做过|做|开发|制作|搭建|写)(?:一个|一款|个|款)?\s*(.{1,24}?)(?:的)?(?:软件|应用|小程序|网站|app|平台|工具)/i);
  if (!match) return null;
  const name = cleanSimulationTopic(match[1].replace(/^(?:一个|一款|个|款)/, ''));
  if (!name || /^(?:这个|那个|什么|微信|网页|安卓|桌面|web|h5|ios|android)$/i.test(name)) return null;
  return { id: 'custom', name, goal: `让用户顺利完成“${name}”这件事`,
    features: [['核心记录', `只录入与${name}直接相关的信息`], ['查找与编辑', '用列表查看、查找、修改和删除记录'], ['保存数据', '重新打开后仍能找到之前的记录']],
    fields: '记录名称、核心内容、创建时间', flow: '录入一条记录 → 找到它 → 修改后重新打开',
    question: '这款工具主要给谁用？', example: '先用一条示例记录走通新增、查找和修改',
    boundary: '等核心流程确定后再加账户、多人协作等功能，避免第一版做得太散。' };
}
function simulationFollowup(text) {
  if (/^(?:换个话题|不聊这个|另外问|我想学|什么是|解释|翻译|帮我翻译)/.test(text)) return false;
  return text.length <= 100 && /^(?:继续|再说|展开|具体|详细|然后|接着|那|这个|它|好[的啊呀吧]?|可以|行|开始吧|你能帮)|网页|小程序|安卓版|桌面版|技术栈|技术选型|怎么实现|怎么做|从哪|功能|第一版|最小版本|mvp|代码|数据库|后端|收藏|筛选|定位|地图|预算|成本|费用|不用|不要|先不|不做|不选|零基础|太假|有点假|套话|答非所问/i.test(text);
}
function simulationPreviousProject(users) {
  // 只沿着相关追问回溯；遇到明确的新话题就停止，不跨话题搬用关键词。
  for (const text of users.slice(-6).reverse()) {
    if (isSimulationGreeting(text)) continue;
    const project = simulationProject(text);
    if (project) return project;
    if (!simulationFollowup(text)) break;
  }
  return null;
}
function simulationPlatform(text) {
  if (/小程序/.test(text) && /网页|网站/.test(text) && /比较|对比|区别|还是|哪个好/.test(text)) return null;
  let selected = null;
  for (const match of text.matchAll(/微信小程序|小程序|安卓版|安卓|android|桌面版|桌面|网页版|网页|网站|h5|web/gi)) {
    if (/(?:不要|不用|不做|不选)(?:做)?(?:微信)?$/.test(text.slice(Math.max(0, match.index - 8), match.index))) continue;
    selected = /小程序/.test(match[0]) ? '微信小程序' : /安卓|android/i.test(match[0]) ? '安卓版' : /桌面/.test(match[0]) ? '桌面版' : '网页版';
  }
  return selected;
}
function simulationCode(input, project) {
  const python = /python/i.test(input);
  if (project?.id === 'food') return python
    ? '可以先实现吃货地图的“筛选想去的店”，地图展示后接上这份数据。\n\n```python\ndef filter_shops(shops, category=None):\n    return [shop for shop in shops\n            if shop["status"] == "想去"\n            and (category is None or shop["category"] == category)]\n\nshops = [{"name": "示例店铺", "category": "面食", "status": "想去"}]\nprint(filter_shops(shops, "面食"))\n```\n\n这里的店铺是演示数据，筛选结果为空时应显示“还没有收藏这类店”。'
    : '先把吃货地图的收藏筛选写成独立函数，后面地图和列表都能复用。\n\n```javascript\nfunction filterShops(shops, category) {\n  return shops.filter(shop =>\n    shop.status === "想去" && (!category || shop.category === category)\n  );\n}\n\nconst shops = [{ name: "示例店铺", category: "面食", status: "想去" }];\nconsole.log(filterShops(shops, "面食"));\n```\n\n这是演示数据；下一步给店铺补上经纬度，再把筛选结果交给地图页。';
  if (project?.id === 'expense') return python
    ? '先实现记账工具里“按分类汇总支出”的逻辑。\n\n```python\ndef total_expenses(records):\n    totals = {}\n    for record in records:\n        if record["type"] == "支出":\n            category = record["category"]\n            totals[category] = totals.get(category, 0) + record["cents"]\n    return totals\n```\n\n金额用整数分保存，显示时再换算成元，避免直接累加小数。'
    : '先实现记账工具里“按分类汇总支出”的逻辑。\n\n```javascript\nfunction totalExpenses(records) {\n  return records.filter(item => item.type === "支出").reduce((totals, item) => {\n    totals[item.category] = (totals[item.category] || 0) + item.cents;\n    return totals;\n  }, {});\n}\n```\n\n金额用整数分保存，显示时再换算成元，避免直接累加小数。';
  if (project) return python
    ? `先给${project.name}补上按名称查找记录的函数。\n\n\`\`\`python\ndef find_records(records, keyword):\n    return [item for item in records if keyword in item["name"]]\n\`\`\`\n\n这只是数据处理示例，还需要结合界面和保存逻辑。`
    : `先给${project.name}补上按名称查找记录的函数。\n\n\`\`\`javascript\nfunction findRecords(records, keyword) {\n  return records.filter(item => item.name.includes(keyword));\n}\n\`\`\`\n\n这只是数据处理示例，还需要结合界面和保存逻辑。`;
  if (/排序|去重/.test(input)) {
    const unique = /去重/.test(input);
    return python
      ? `可以用下面的 Python 函数${unique ? '去重并保留顺序' : '对数字从小到大排序'}。\n\n\`\`\`python\ndef transform(values):\n    return ${unique ? 'list(dict.fromkeys(values))' : 'sorted(values)'}\n\nprint(transform([3, 1, 3, 2]))\n\`\`\`\n\n它返回新列表，不会修改传入的数据。`
      : `可以用下面的 JavaScript 函数${unique ? '去重并保留顺序' : '对数字从小到大排序'}。\n\n\`\`\`javascript\nfunction transform(values) {\n  return ${unique ? '[...new Set(values)]' : '[...values].sort((a, b) => a - b)'};\n}\n\nconsole.log(transform([3, 1, 3, 2]));\n\`\`\`\n\n它返回新数组，不会修改传入的数据。`;
  }
  return python
    ? '可以，先给你一个带参数和返回值的 Python 函数示例。\n\n```python\ndef greet(name):\n    return f"你好，{name}！"\n\nprint(greet("Vesper"))\n```\n\n如果你有具体用途，比如排序、去重或筛选数据，直接告诉我输入和期望结果。'
    : '可以，先给你一个带参数和返回值的 JavaScript 函数示例。\n\n```javascript\nfunction greet(name) {\n  return `你好，${name}！`;\n}\n\nconsole.log(greet("Vesper"));\n```\n\n如果你有具体用途，比如排序、去重或筛选数据，直接告诉我输入和期望结果。';
}
function simulationProjectReply(project, input, history, fresh) {
  const name = project.name;
  const fields = `一条记录先保存：**${project.fields}**。`;
  const requestedPlatform = simulationPlatform(input);
  const previousUsers = history.filter(message => message.role === 'user').map(message => String(message.content || ''));
  // 平台选择只沿着当前项目回溯，不复用其他项目或 AI 自己提到的备选平台。
  const projectStart = previousUsers.findLastIndex(text => simulationProject(text));
  const chosenPlatform = requestedPlatform || previousUsers.slice(Math.max(0, projectStart)).reverse().map(simulationPlatform).find(Boolean);
  if (/不用地图|不要地图|先不做地图/.test(input) && project.id === 'food') return '那就先做“美食收藏清单”，把地图留到后面。\n\n先保留店名、地址、菜系、想去/去过和个人评价，用列表配合搜索筛选就能走通收藏流程。\n\n以后需要地图时，再给每家店补经纬度，不必重做收藏和评价。';
  if (/不用登录|不要登录|不做登录|不想注册/.test(input)) return `可以，${name}第一版不做登录。\n\n收藏和记录先保存在本机，增加导出、导入作为备份；清理应用数据或换设备时，本机记录不会自动跟过去。\n\n等你确实需要跨设备同步时，再决定是否加入账户。`;
  if (/不会.{0,4}(?:写|编)?代码|零基础|小白/.test(input)) return `可以先不急着选框架，我们把${name}第一屏做什么定清楚。\n\n先画出“列表／主页面 → 详情 → 新增记录”三张草图，再准备三条示例数据。\n\n等这三步顺了，再逐步把草图变成可运行的页面；你现在更想先看页面草图，还是操作步骤？`;
  const wantsCode = /代码|编程|函数|算法|写.{0,12}(?:python|javascript)/i.test(input) && !/(?:不要|不用|别|先不).{0,5}(?:写)?代码/.test(input);
  if (wantsCode) return simulationCode(input, project);
  if (/小程序.{0,8}(?:网页|网站)|(?:网页|网站).{0,8}小程序/.test(input) && /比较|对比|区别|哪个好|选哪个/.test(input)) return `做${name}，可以先按使用入口来选。\n\n| 方案 | 用户怎样打开 | 适合先验证什么 |\n| --- | --- | --- |\n| 网页版 | 在浏览器打开链接 | 页面、数据结构和主要操作流程 |\n| 微信小程序 | 在微信中打开 | 微信里找店、收藏和分享的体验 |\n\n如果你还没确定用户从哪里来，先做网页版原型更方便反复改；如果主要给微信好友用，就围绕小程序设计。`;
  if (/功能|第一版|最小版本|mvp|表格/i.test(input)) return `${name}第一版可以先收敛到下面这几个功能。\n\n| 功能 | 第一版做到什么程度 |\n| --- | --- |\n${project.features.map(([title, detail]) => `| ${title} | ${detail} |`).join('\n')}\n\n${project.boundary}\n\n${fields}`;
  if (/技术栈|技术选型|框架|数据库|后端|用什么|怎么实现/.test(input)) {
    const stack = chosenPlatform === '微信小程序' ? '按你选的微信小程序，先用原生 WXML、WXSS、JavaScript 做页面和交互' : chosenPlatform === '桌面版' ? '按你选的桌面版，可以用 Electron 配合 HTML、CSS、JavaScript 做原型' : chosenPlatform === '安卓版' ? '按你选的安卓版，先实现列表、详情和新增记录这几张 Android 页面' : `${chosenPlatform ? '按你选的网页版，' : '如果先做网页原型，'}可以用原生 HTML、CSS、JavaScript 把页面和操作跑通`;
    return `做${name}，${stack}。\n\n${project.id === 'food' ? '地图展示与店铺数据分开：地图负责标记和点击，店铺列表负责收藏、状态及筛选；接入哪家地图服务后再按它的文档处理搜索和定位。' : '界面、记录列表和数据保存分开写：先用本机数据验证交互，确实需要多设备使用时再增加后端和数据库。'}\n\n${fields}\n\n${chosenPlatform ? '先跑通新增、查看和修改，再考虑服务器与跨设备同步。' : '你准备先做网页版，还是已经确定了其他平台？'}`;
  }
  if (/预算|成本|费用|多少钱|收费/.test(input)) return `${name}现在还不能准确报价，先区分“自己试用的原型”和“多人长期使用的产品”。\n\n原型可以先用演示数据和本机保存验证流程；上线后再核对${project.id === 'food' ? '地图服务、图片存储和服务器' : '数据存储、服务器和同步'}的实际用量与服务报价。\n\n你计划自己开发，还是找人开发？这会影响费用的主要构成。`;
  if (requestedPlatform) return `那就先按${requestedPlatform}来做${name}。\n\n第一屏放${project.id === 'food' ? '地图／店铺列表和筛选入口，点击一家店打开详情，再提供“收藏”和“去过”两个操作' : '记录列表和新增入口，点击记录进入详情，支持编辑和删除'}。\n\n${fields}\n\n${project.example}；账户、同步和其他扩展功能等这条流程跑通后再加。`;
  if (/收藏|筛选|定位|搜索|地图/.test(input) && project.id === 'food' && !simulationProject(input)) return '吃货地图里，店铺列表和地图标记最好使用同一份店铺数据。\n\n点“收藏”时保存店铺记录；按菜系或“想去/去过”筛选后，同时更新列表和标记，避免两边显示不一致。\n\n定位只是帮用户移动到附近位置，不要把“是否允许定位”当成能否查看收藏的前提。';
  const priorAnswers = history.filter(message => message.role === 'assistant').slice(-5).map(message => message.content || '');
  if (/继续|开始|怎么做|从哪|具体|详细|然后|下一步|^好[的啊呀吧！!。]*$|^可以[！!。]*$/.test(input) || priorAnswers.some(text => text.includes(project.flow))) return `先把${name}的第一条完整流程做出来：**${project.flow}**。\n\n1. 准备数据：${project.fields}。\n2. 做出新增和查看页面，先用演示记录确认操作顺序。\n3. ${project.example}，重新打开后再检查记录是否保留。\n\n${project.boundary}`;
  const opening = fresh([`可以。${name}可以先围绕“${project.goal}”来做。`, `能帮你梳理。${name}先解决一个核心需求：${project.goal}。`, `可以先做一个能自己试用的${name}，核心是${project.goal}。`]);
  return `${opening}\n\n第一版保留三个功能：\n${project.features.map(([title, detail]) => `- **${title}**：${detail}。`).join('\n')}\n\n使用流程是：${project.flow}。\n\n${project.question}`;
}
function simulate(messages) {
  const users = messages.filter(message => message.role === 'user').map(message => String(message.content || '').trim());
  const input = users.at(-1) || '';
  const answers = messages.filter(message => message.role === 'assistant').slice(-6).map(message => String(message.content || ''));
  const fresh = pool => {
    const unused = pool.filter(part => !answers.some(answer => answer.includes(part)));
    const different = pool.filter(part => !answers.at(-1)?.includes(part));
    return choose(unused.length ? unused : different.length ? different : pool);
  };
  if (/翻译|translate/i.test(input)) {
    const source = input.replace(/^.*?(?:翻译[：:]?|translate[：:]?)\s*/i, '').trim();
    const dictionary = { '你好': 'Hello.', '早上好': 'Good morning.', '谢谢': 'Thank you.', hello: '你好。', 'good morning': '早上好。', 'thank you': '谢谢。' };
    const translated = dictionary[source.toLowerCase().replace(/[!！。.]$/, '')];
    return translated ? `可以译为：**${translated}**\n\n${fresh(['这是日常交流里的常见说法。', '如果用在邮件或比较正式的场合，可以再调整语气。'])}` : `这句话超出了本地翻译词库，不能可靠地给出完整译文。\n\n目前能演示“你好”“早上好”“谢谢”等短语；更完整的翻译需要真实模型或翻译工具。`;
  }
  const explanations = [
    [/python.{0,5}(?:是什么|能做什么)|什么是\s*python/i, 'Python 是一种编程语言，常用于脚本、数据处理和后端服务。\n\n例如，把一批表格里的数据整理成汇总结果，就可以用 Python 写成一个可重复运行的脚本。'],
    [/javascript.{0,5}(?:是什么|能做什么)|什么是\s*javascript/i, 'JavaScript 是一种编程语言，在网页里常用来响应点击、处理输入和更新页面。\n\n例如，点下“收藏”后把店铺加入列表，就是一段 JavaScript 可以负责的交互。'],
    [/api.{0,5}是什么|什么是\s*api/i, 'API 可以理解为程序之间约定好的调用入口。\n\n比如聊天客户端把消息按约定格式发送到接口，服务端返回结果；地址、认证方式和数据格式都要与接口约定一致。'],
    [/markdown.{0,5}是什么|什么是\s*markdown/i, 'Markdown 是一种用普通文本标记排版的写法。\n\n例如，`**重点**` 会显示成粗体，列表、表格和代码块也能用文本标记表达。']
  ];
  for (const [pattern, reply] of explanations) if (pattern.test(input)) return reply;
  const directProject = simulationProject(input);
  const project = directProject || (simulationFollowup(input) ? simulationPreviousProject(users.slice(0, -1)) : null);
  if (project) return simulationProjectReply(project, input, messages.slice(0, -1), fresh);
  if (isSimulationGreeting(input)) return [fresh(['你好，我是 Vesper。你现在想解决什么问题？', '嗨，在呢。今天想聊什么？', '你好，直接把你的想法告诉我就行。']), fresh(['可以说一个具体需求，比如想做什么软件，或者遇到了哪段代码。', '不用先整理得很完整，先说你想做成什么。', '给我一个具体的问题或例子，我们从那里开始。'])].join('\n\n');
  if (/计划|安排|学习|效率/.test(input) && !/写.{0,5}代码|代码示例/.test(input)) {
    const subject = /python/i.test(input) ? 'Python' : /javascript/i.test(input) ? 'JavaScript' : /英语/.test(input) ? '英语' : null;
    return subject ? `如果是学${subject}，可以先按“每天一小段练习，加一个能完成的作品”来安排。\n\n前两天熟悉基本用法，中间几天跟着做一个小例子，最后一天独立重做并记录卡住的地方；每天留一段时间回顾，而不是只看教程。\n\n你现在是零基础，还是已经接触过${subject}？` : '你想安排哪件事，准备留出多少时间？\n\n比如“每天半小时学英语”和“这周做一个网页原型”，需要的步骤不同；给我目标和可用时间后，可以把计划落到具体任务。';
  }
  if (/代码|编程|函数|算法|写.{0,12}(?:python|javascript)/i.test(input) && !/(?:不要|不用|别).{0,5}(?:写)?代码/.test(input)) return simulationCode(input, null);
  if (/表格|对比|比较/.test(input)) return '可以先用具体差异比较两种做事方法。\n\n| 方案 | 优点 | 适用场景 |\n| --- | --- | --- |\n| 先做小样 | 能尽早看到结果，修改范围较小 | 需求还不明确 |\n| 先列完整计划 | 更容易协调步骤和依赖 | 目标和约束已经明确 |\n\n你想比较的具体方案是什么？告诉我对象后，表格的维度才能更贴切。';
  if (/开心|高兴|好消息/.test(input)) return `${fresh(['听起来是件让你开心的事。', '有什么好消息？愿意的话说说。'])}\n\n${fresh(['最让你高兴的是哪个部分？', '是终于做成了某件事，还是遇到了意外的惊喜？'])}`;
  if (/难过|心情不好|很累|有点累|烦|无聊|聊天/.test(input)) return `${fresh(['听起来你现在不太轻松。', '我在听，不用急着把话说得很完整。'])}\n\n${fresh(['今天具体发生了什么，让你有这种感受？', '你想先把事情说出来，还是更想一起想个眼下能做的办法？'])}`;
  if (/天气|新闻|实时|今天.{0,12}(?:价格|汇率)|推荐.{0,12}(?:餐厅|餐馆|好吃的店)/.test(input)) return '本地模式没有实时数据，不能核实你问的最新情况。\n\n如果你提供已经看到的信息，我可以在已有规则范围内帮你整理问题；具体天气、价格或商家信息应以可核实的数据来源为准。';
  if (/谢谢|感谢/.test(input)) return '不客气。\n\n有下一步想做的事，直接接着说就行。';
  const previous = users.slice(0, -1).reverse().find(text => !isSimulationGreeting(text));
  if (/继续|再说|展开|具体|这个|它|刚才/.test(input) && previous) return `你想继续展开“${cleanSimulationTopic(previous)}”的哪一部分：含义、例子，还是具体做法？\n\n给一个方向，我可以先把这一部分说清楚，避免重复泛泛的建议。`;
  if (/有点假|太假|套话|答非所问|没回答/.test(input)) return '刚才的回答太泛了，没有真正接住你的问题。\n\n告诉我你希望先看到的一个具体结果，比如功能清单、操作步骤或一段代码；如果超出本地规则能处理的范围，我会直接说明。';
  const topic = cleanSimulationTopic(input);
  return `${topic ? `你提到“${topic}”，` : ''}我还缺少一个能具体回答的切入点。\n\n你希望得到解释、可执行的步骤，还是代码示例？本地模式对开放问题的理解有限，我不会把通用模板当成已经解答了你的问题。`;
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
