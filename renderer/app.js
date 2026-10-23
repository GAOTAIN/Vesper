/* 页面只负责展示和交互；文件、密钥和网络由主进程管理。 */
const $ = id => document.getElementById(id);
const api = window.vesper;
const { t } = window.VesperI18n;
let data, busy = null, followBottom = true, toastTimer, previousFocus, dialogAction, renderFrame;
let localState = null;
const drafts = new Map();
const md = window.markdownit({ html: false, linkify: true, breaks: true });
const escape = text => md.utils.escapeHtml(String(text));
md.renderer.rules.fence = (tokens, index) => {
  const token = tokens[index], lang = token.info.trim().split(/\s+/)[0] || t("纯文本");
  let highlighted = escape(token.content);
  if (window.hljs.getLanguage(lang)) {
    try { highlighted = window.hljs.highlight(token.content, { language: lang, ignoreIllegals: true }).value; } catch {}
  }
  return t("<div class=\"code-block\"><div class=\"code-head\"><span>{0}</span><button type=\"button\" class=\"copy-code\">复制代码</button></div><pre><code>{1}</code></pre></div>", [escape(lang), highlighted]);
};
// 远程图片不加载，避免消息中的资源地址在离线页面触发网络请求。
md.renderer.rules.image = (tokens, i) => t("<span class=\"image-description\">〔图片：{0}〕</span>", [escape(tokens[i].content || t("图片"))]);
md.renderer.rules.table_open = () => '<div class="table-wrap"><table>';
md.renderer.rules.table_close = () => '</table></div>';

async function call(promise) {
  const result = await promise;
  if (!result.ok) throw new Error(window.VesperI18n.message(result.error) || t("操作未完成，请重试。"));
  return result.value;
}
function toast(message) {
  $('toast').textContent = window.VesperI18n.message(message); $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4200);
}
let selectedTheme = 'system';
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
function applyTheme(theme) {
  selectedTheme = theme;
  // 两份本地高亮样式预先加载，作用域随同一个主题属性同步生效。
  document.documentElement.dataset.theme = theme === 'system' ? (systemTheme.matches ? 'dark' : 'light') : theme;
}
systemTheme.addEventListener('change', () => { if(selectedTheme === 'system') applyTheme('system'); });
function currentChat() { return data.database.chats.find(c => c.id === data.database.currentId); }
function setData(value) { data = value; busy = value.busy; applyTheme(data.settings.theme); window.VesperI18n.setLanguage(data.settings.language); render(); }
function renderMode() {
  const online = data.settings.mode === 'online';
  const local = data.settings.mode === 'local';
  $('modeBadge').textContent = local ? t("本地部署模式") : online ? t("在线模式") : t("模拟模式");
  $('modeBadge').classList.toggle('online', online);
  $('modeBadge').classList.toggle('local', local);
  const localModel = localState?.catalog.find(model => model.id === localState.config.selectedModelId);
  $('modeBadge').title = local ? t("本机 Ollama · {0}", [localModel?.name || t("请先部署并选择模型")]) : online ? t("接口：{0}\n模型：{1}", [data.settings.baseURL, data.settings.model]) : t("本地规则与模板生成，无需网络");
  $('sideMode').classList.toggle('online', online); $('sideMode').classList.toggle('local', local); $('sideMode').title = local ? t("本地部署模式") : online ? t("在线模式") : t("模拟模式");
  $('localOpen').setAttribute('aria-pressed', String(local));
  $('composerMode').textContent = local ? t("本地推理 · {0}", [localModel?.name || t("请先部署并选择模型")]) : online ? t("在线连接 · {0}", [data.settings.model]) : t("本地灵感，随时开始");
  $('emptyMode').replaceChildren();
  const dot = document.createElement('span'); dot.className = 'small-dot';
  $('emptyMode').append(dot, document.createTextNode(local ? t("本地部署 · {0}", [localModel?.name || t("请先下载并选择模型")]) : online ? t("在线模式 · {0}", [data.settings.model]) : t("模拟模式已就绪 · 无需网络或密钥")));
  $('disclaimer').textContent = local ? t("本地推理使用本机算力，不使用在线接口与密钥") : online ? t("模型回复可能有误，请核实重要信息") : t("模拟回复由本地模板生成，请勿作为事实依据");
  $('shell').classList.toggle('collapsed', data.settings.collapsed); $('expand').hidden = !data.settings.collapsed;
  for (const button of document.querySelectorAll('[data-preset]')) {
    const brand = {openai: 'OpenAI', deepseek: 'DeepSeek', moonshot: 'Moonshot', zhipu: t('智谱'), ollama: t('本地 Ollama')}[button.dataset.preset];
    button.textContent = brand + ' ' + (button.dataset.preset === 'ollama' ? '11434/v1' : presets[button.dataset.preset][1]);
  }
  syncComposer();
}
function chatLabel(chat) { return chat.title === '新的对话' && !chat.messages.length ? t('新的对话') : chat.title; }
function renderList() {
  $('chatList').replaceChildren();
  for (const chat of [...data.database.chats].sort((a,b) => b.updatedAt - a.updatedAt)) {
    const item = document.createElement('div'); item.className = 'chat-item' + (chat.id === data.database.currentId ? ' active' : '');
    const symbol = document.createElement('span'); symbol.className = 'chat-symbol'; symbol.textContent = '◌';
    const select = document.createElement('button'); select.className = 'chat-select'; select.textContent = chatLabel(chat); select.title = chatLabel(chat);
    select.addEventListener('click', () => selectChat(chat.id));
    const tools = document.createElement('div'); tools.className = 'chat-tools';
    const rename = document.createElement('button'); rename.textContent = '✎'; rename.title = t("重命名会话"); rename.setAttribute('aria-label', t("重命名：{0}", [chat.title]));
    rename.onclick = () => askAction(t("重命名会话"), t("给这段对话起一个容易找到的名字。"), chat.title, async title => setData(await call(api.renameChat(chat.id, title))));
    const remove = document.createElement('button'); remove.textContent = '×'; remove.title = t("删除会话"); remove.setAttribute('aria-label', t("删除：{0}", [chat.title]));
    remove.onclick = () => askAction(t("删除这段对话？"), t("删除后无法恢复。"), null, async () => setData(await call(api.deleteChat(chat.id))));
    tools.append(rename, remove); item.append(symbol, select, tools); $('chatList').append(item);
  }
}
function messageNode(message) {
  const node = document.createElement('article'); node.id = `message-${message.id}`; node.className = `message ${message.role}`;
  if (message.role === 'user') { const bubble = document.createElement('div'); bubble.className = 'user-bubble'; bubble.textContent = message.content; node.append(bubble); }
  else {
    node.innerHTML = '<div class="assistant-heading"><svg class="app-icon" viewBox="0 0 256 256" role="img" aria-label="Vesper"><use href="../assets/icon.svg#vesper-icon"></use></svg><span>Vesper</span><span class="message-meta"></span></div><div class="markdown"></div><div class="message-footer"></div>';
    updateMessage(node, message);
  }
  return node;
}
function updateMessage(node, message) {
  node.classList.toggle('streaming', message.status === 'streaming');
  node.querySelector('.message-meta').textContent = message.mode === 'local' ? t("本地模型{0}", [message.modelName ? ' · ' + message.modelName : '']) : message.mode === 'online' ? t("在线模型") : t("本地模拟");
  const body = node.querySelector('.markdown');
  if (!message.content && message.status === 'streaming') body.innerHTML = t("<div class=\"thinking\">思考中<span></span><span></span><span></span></div>");
  else body.innerHTML = message.content ? md.render(message.content) : t("<p>尚未生成内容。</p>");
  const footer = node.querySelector('.message-footer'); footer.replaceChildren();
  const foot = (text, cls) => { const p = document.createElement('div'); p.className = cls; p.textContent = text; footer.append(p); };
  if (message.error) foot(window.VesperI18n.message(message.error), 'error-foot');
  if (message.status === 'stopped') foot(t("已停止生成"), 'status-foot');
  if (message.mode === 'simulation') foot(t("（模拟模式 · 未连接真实模型）"), 'simulation-foot');
}
function renderMessages() {
  const chat = currentChat(); $('chatTitle').textContent = chatLabel(chat);
  $('emptyState').hidden = chat.messages.length > 0;
  $('messages').hidden = chat.messages.length === 0;
  $('messages').replaceChildren(...chat.messages.map(messageNode));
  syncComposer(); scrollBottom();
}
function render() { renderMode(); renderList(); renderMessages(); }
function syncComposer() {
  $('sendButton').textContent = busy ? t("■ 停止") : '↑';
  $('sendButton').setAttribute('aria-label', busy ? t("停止生成") : t("发送消息"));
  $('sendButton').classList.toggle('stopping', Boolean(busy));
  const localUnavailable = data?.settings.mode === 'local' && (!localState?.features.chat || !localState?.config.selectedModelId || Boolean(localState?.config.pendingModelDirectory));
  $('sendButton').disabled = !busy && (localUnavailable || !$('messageInput').value.trim());
  $('sendButton').title = localUnavailable && !busy ? t("请先在本地部署面板完成模型部署与选择") : '';
}
function scrollBottom() {
  if (followBottom) requestAnimationFrame(() => { $('chatScroll').scrollTop = $('chatScroll').scrollHeight; });
}
function resizeInput() {
  $('messageInput').style.height = 'auto'; $('messageInput').style.height = `${Math.min($('messageInput').scrollHeight, 150)}px`; syncComposer();
}
function storeDraft() { if (data) drafts.set(data.database.currentId, $('messageInput').value); }
function restoreDraft() { $('messageInput').value = drafts.get(data.database.currentId) || ''; resizeInput(); }
async function selectChat(id) {
  try { storeDraft(); followBottom = true; setData(await call(api.selectChat(id))); restoreDraft(); }
  catch(e) { toast(e.message); }
}
async function newChat() {
  try { storeDraft(); followBottom = true; setData(await call(api.newChat())); restoreDraft(); $('messageInput').focus(); }
  catch(e) { toast(e.message); }
}
async function sendMessage(event) {
  event?.preventDefault();
  if (busy) { try { await call(api.stop(busy.requestId)); } catch(e) { toast(e.message); } return; }
  if (data.settings.mode === 'local' && (!localState?.config.selectedModelId || localState?.config.pendingModelDirectory)) { toast(t("请先在本地部署面板完成模型部署与选择。")); return; }
  const content = $('messageInput').value.trim(); if (!content) return;
  const chat = currentChat(), requestId = crypto.randomUUID();
  busy = { chatId: chat.id, requestId }; syncComposer();
  try {
    const result = await call(api.send({ chatId: chat.id, content, requestId }));
    chat.messages.push(result.user, result.response); chat.title = result.title; chat.updatedAt = Date.now();
    $('messageInput').value = ''; drafts.delete(chat.id); resizeInput(); followBottom = true; renderList(); renderMessages();
  } catch(e) { busy = null; syncComposer(); toast(e.message); }
}
api.onStream(event => {
  if (!data) return;
  const chat = data.database.chats.find(c => c.id === event.chatId), message = chat?.messages.find(m => m.id === event.messageId);
  if (!message) return;
  if (event.type === 'delta') message.content += event.text;
  if (event.type === 'end') {
    Object.assign(message, event.message); chat.updatedAt = Date.now();
    if (busy?.requestId === event.requestId) busy = null;
    syncComposer(); renderList();
  }
  cancelAnimationFrame(renderFrame);
  renderFrame = requestAnimationFrame(() => {
    const node = $(`message-${message.id}`); if (node) updateMessage(node, message); scrollBottom();
  });
});

function askAction(title, description, initial, action) {
  $('actionTitle').textContent = title; $('actionDescription').textContent = description;
  $('actionInput').hidden = initial === null; $('actionInput').required = initial !== null; $('actionInput').value = initial || '';
  dialogAction = action; $('actionDialog').showModal();
  if (initial !== null) { $('actionInput').focus(); $('actionInput').select(); }
}
$('actionCancel').onclick = () => $('actionDialog').close();
$('actionForm').onsubmit = async event => {
  event.preventDefault(); const action = dialogAction; $('actionDialog').close();
  try { await action($('actionInput').value); } catch(e) { toast(e.message); }
};

function settingsValue() {
  return { mode: document.querySelector('input[name=mode]:checked').value, baseURL: $('baseURL').value.trim(), apiKey: $('apiKey').value,
    removeKey: $('removeKey').checked, model: $('model').value.trim(), temperature: Number($('temperature').value), systemPrompt: $('systemPrompt').value, theme: $('theme').value, language: $('language').value };
}
function openSettings() {
  previousFocus = document.activeElement; const s = data.settings;
  document.querySelector(`input[name=mode][value="${s.mode}"]`).checked = true;
  for (const id of ['baseURL','model','temperature','systemPrompt','theme','language']) $(id).value = s[id];
  $('temperatureValue').textContent = s.temperature.toFixed(1); $('apiKey').value = ''; $('apiKey').type = 'password'; $('showKey').textContent = t("显示"); $('removeKey').checked = false;
  $('apiKey').placeholder = s.hasKey ? t("已保存 · ••••{0}", [s.keyLast4]) : t("填写你的 API Key（本地 Ollama 可留空）");
  $('keyHint').textContent = s.hasKey ? t("已保存 · 尾号 {0}", [s.keyLast4 || t("未知")]) : t("未保存");
  $('connectionResult').textContent = window.VesperI18n.message(s.keyError || ''); $('connectionResult').className = 'connection-result' + (s.keyError ? ' error' : '');
  syncSettingsMode(); syncSettingsDirectory();
  localPanel.load();
  $('settingsOverlay').hidden = false; $('settingsPanel').focus();
}
function syncSettingsDirectory() {
  const state = localState;
  const pending = state?.config.pendingModelDirectory;
  $('settingsModelDirectory').value = pending || state?.config.modelDirectory || state?.storage?.defaultDirectory || '';
  const working = localPanel.operations.has('directory') || state?.changingDirectory;
  const locked = !state || working || state?.installer?.busy;
  $('settingsChooseDirectory').disabled = Boolean(locked);
  $('settingsChooseDirectory').textContent = working ? t('正在更改位置…') : t('更改下载位置');
  $('settingsApplyDirectory').hidden = !pending;
  $('settingsApplyDirectory').disabled = Boolean(locked);
  const status = $('settingsDirectoryStatus');
  status.classList.toggle('directory-pending', Boolean(pending));
  status.textContent = !state ? t('正在读取下载位置…') : working ? t('正在应用下载位置，请稍候…')
    : pending ? t('下载位置待生效：请先退出系统托盘中的 Ollama，再点击“应用目录并重启”。生效前暂停新下载。')
    : state.service.owner === 'external' ? t('已连接外部 Ollama，无法确认它的实际下载目录。更改位置后需退出外部服务并应用。')
    : state.service.activeDirectory ? t('此位置已生效，后续下载的模型保存在这里。')
    : t('此位置将在 Vesper 下次启动 Ollama 时用于模型下载。');
}
async function changeSettingsDirectory(applyPending = false) {
  if (localPanel.operations.has('directory')) return;
  localPanel.operations.add('directory'); syncSettingsDirectory(); localPanel.render();
  try {
    localPanel.accept(await call(applyPending ? api.local.applyDirectory() : api.local.chooseDirectory()));
  } catch (error) { toast(error.message); }
  finally { localPanel.operations.delete('directory'); syncSettingsDirectory(); localPanel.render(); }
}
$('settingsChooseDirectory').onclick = () => changeSettingsDirectory();
$('settingsApplyDirectory').onclick = () => changeSettingsDirectory(true);
function closeSettings() { $('settingsOverlay').hidden = true; $('apiKey').value = ''; $('apiKey').type = 'password'; applyTheme(data.settings.theme); previousFocus?.focus(); }
$('settingsOpen').onclick = openSettings; $('settingsClose').onclick = closeSettings;
$('settingsOverlay').onclick = event => { if (event.target === $('settingsOverlay')) closeSettings(); };
function syncSettingsMode() {
  const local = document.querySelector('input[name=mode]:checked')?.value === 'local';
  $('localSettingsNote').hidden = !local;
  $('testConnection').disabled = local;
  $('testConnection').title = local ? t("请在本地部署面板检测 Ollama 服务") : '';
}
for (const radio of document.querySelectorAll('input[name=mode]')) radio.addEventListener('change', syncSettingsMode);
$('showKey').onclick = async () => {
  try {
    if ($('apiKey').type === 'password') {
      if (!$('apiKey').value && data.settings.hasKey && !$('removeKey').checked) $('apiKey').value = await call(api.revealKey());
      $('apiKey').type = 'text'; $('showKey').textContent = t("隐藏");
    } else { $('apiKey').type = 'password'; $('showKey').textContent = t("显示"); }
  } catch(e) { toast(e.message); }
};
$('temperature').oninput = () => { $('temperatureValue').textContent = Number($('temperature').value).toFixed(1); };
$('theme').onchange = () => applyTheme($('theme').value);
const presets = {
  openai: ['https://api.openai.com/v1', 'gpt-4o-mini'], deepseek: ['https://api.deepseek.com/v1', 'deepseek-chat'], moonshot: ['https://api.moonshot.cn/v1', 'moonshot-v1-8k'], zhipu: ['https://open.bigmodel.cn/api/paas/v4', 'glm-4-flash'], ollama: ['http://localhost:11434/v1', 'qwen2.5:7b']
};
for (const button of document.querySelectorAll('[data-preset]')) {
  const [url, model] = presets[button.dataset.preset]; button.title = `${model} · ${url}`;
  button.textContent += ` ${button.dataset.preset === 'ollama' ? '11434/v1' : model}`;
  button.onclick = () => { $('baseURL').value = url; $('model').value = model; $('connectionResult').textContent = t("已填入预设。请确认模型可用，并使用该服务自己的密钥。"); };
}
$('settingsForm').onsubmit = async event => {
  event.preventDefault(); $('saveSettings').disabled = true;
  try {
    data.settings = await call(api.saveSettings(settingsValue())); window.VesperI18n.setLanguage(data.settings.language); render(); localPanel.render(); syncSettingsDirectory(); closeSettings();
    toast(busy ? t("设置已保存，将用于下一条消息。当前回复继续使用发送时的模式。") : t("设置已保存，立即生效。"));
  } catch(e) { toast(e.message); } finally { $('saveSettings').disabled = false; }
};
$('testConnection').onclick = async () => {
  $('testConnection').disabled = true; $('connectionResult').className = 'connection-result'; $('connectionResult').textContent = t("正在测试，最多等待 60 秒…");
  try { const result = await call(api.testConnection(settingsValue())); $('connectionResult').textContent = t("✓ 连接成功 · 耗时 {0} 毫秒", [result.elapsed]); $('connectionResult').className = 'connection-result success'; }
  catch(e) { $('connectionResult').textContent = window.VesperI18n.message(e.message); $('connectionResult').className = 'connection-result error'; }
  finally { $('testConnection').disabled = false; }
};
async function collapse(value) { try { data.settings = await call(api.saveSettings({ collapsed: value })); renderMode(); } catch(e) { toast(e.message); } }
$('collapse').onclick = () => collapse(true); $('expand').onclick = () => collapse(false);
$('newChat').onclick = newChat;
$('clearChat').onclick = () => askAction(t("清空当前对话？"), t("当前会话的消息将被移除，标题保留。"), null, async () => { followBottom = true; setData(await call(api.clearChat(data.database.currentId))); });
$('composer').onsubmit = sendMessage;
$('messageInput').addEventListener('input', resizeInput);
$('messageInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!busy) sendMessage(); } });
for (const button of document.querySelectorAll('[data-example]')) button.onclick = () => { $('messageInput').value = button.dataset.example; resizeInput(); sendMessage(); };
$('chatScroll').addEventListener('wheel', e => { if (e.deltaY < 0) followBottom = false; }, { passive: true });
$('chatScroll').addEventListener('scroll', () => {
  const el = $('chatScroll'); followBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 70; $('jumpBottom').hidden = followBottom;
}, { passive: true });
$('jumpBottom').onclick = () => { followBottom = true; $('jumpBottom').hidden = true; scrollBottom(); };
$('messages').onclick = async event => {
  const copy = event.target.closest('.copy-code');
  if (copy) {
    try { await call(api.copy(copy.closest('.code-block').querySelector('code').textContent)); copy.textContent = t("已复制"); setTimeout(() => { if(copy.isConnected) copy.textContent = t("复制代码"); }, 1500); } catch(e) { toast(e.message); }
  }
  const link = event.target.closest('a');
  if (link) { event.preventDefault(); try { await call(api.copy(link.href)); toast(t("链接已复制，可在浏览器中打开。")); } catch(e) { toast(e.message); } }
};
document.addEventListener('keydown', e => {
  if (!$('localOverlay').hidden) return;
  if (!$('settingsOverlay').hidden) {
    if (e.key === 'Escape') closeSettings();
    if (e.key === 'Tab') {
      const nodes = [...$('settingsPanel').querySelectorAll('button,input,textarea,select')].filter(el => !el.disabled && el.getClientRects().length);
      const first = nodes[0], last = nodes.at(-1);
      if (e.shiftKey && (document.activeElement === first || document.activeElement === $('settingsPanel'))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); newChat(); }
});
const localPanel = new window.VesperLocalPanel({
  api: api.local, call, toast,
  setMode: async mode => { data.settings = await call(api.saveSettings({ mode })); renderMode(); },
  onState: value => { localState = value; if (data) { renderMode(); syncSettingsDirectory(); } }
});
$('localOpen').onclick = () => localPanel.open();
$('settingsLocalOpen').onclick = () => { closeSettings(); localPanel.open(); };
(async () => { try { setData(await call(api.load())); if (data.settings.mode === 'local') await localPanel.load(); await Promise.all([...document.querySelectorAll('link[rel=stylesheet]')].map(link => link.sheet ? Promise.resolve() : new Promise(resolve => { link.onload = resolve; link.onerror = resolve; }))); api.themeReady(); if (data.recoveryNotice) toast(data.recoveryNotice); $('messageInput').focus(); } catch(e) { api.themeReady(); toast(t("启动失败：{0}", [e.message])); } })();
