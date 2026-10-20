const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { setTimeout: pause } = require('node:timers/promises');
const { startMockOllama } = require('./mock-ollama.cjs');
const { createLocalMode } = require('../main/local/ipc.cjs');
const { createOllamaClient, makeNDJSON } = require('../main/local/ollama-client.cjs');
const { createOllamaService } = require('../main/local/ollama-service.cjs');
const { boundMessages, createLocalChat } = require('../main/local/local-chat.cjs');
const results = [];
const pass = name => { results.push({ name, passed: true }); console.log(`通过：${name}`); };
async function until(fn, ms = 6000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await pause(15); } throw new Error('等待本地任务超时'); }
const root = path.join(__dirname, '../work', `local-integration-${Date.now()}`);
fs.mkdirSync(root, { recursive: true });
function storage(directory) {
  fs.mkdirSync(directory, { recursive: true });
  return {
    readJSON: (name, fallback) => { try { return JSON.parse(fs.readFileSync(path.join(directory, `${name}.json`), 'utf8')); } catch { return structuredClone(fallback); } },
    writeJSON: (name, value) => { const target = path.join(directory, `${name}.json`); fs.writeFileSync(`${target}.tmp`, JSON.stringify(value)); fs.renameSync(`${target}.tmp`, target); }
  };
}
(async () => {
  const packets = []; const parser = makeNDJSON(value => packets.push(value));
  for (const char of '\r\n{"message":{"content":"中文"}}\r\n{"done":true}') parser.push(char);
  parser.push('', true); assert.equal(packets[0].message.content, '中文'); assert.equal(packets[1].done, true);
  assert.throws(() => makeNDJSON(() => {}).push('{bad}\n'), /无效/);
  assert.throws(() => makeNDJSON(() => {}).push('{"error":"out of memory"}\n'), /内存或显存不足/);
  assert.throws(() => createOllamaClient({ origin: 'http://example.com:11434' }), /回环/);
  pass('NDJSON 跨行分片、中文、尾行、错误包与回环地址限制');

  const mock = await startMockOllama();
  const saved = storage(path.join(root, 'profile'));
  let lowHardware = false;
  const progress = [];
  const options = {
    ...saved, client: createOllamaClient({ origin: mock.origin }), emit: (_snapshot, event) => { if (event) progress.push(event.progress); },
    detectorOptions: { si: { mem: async () => ({ total: (lowHardware ? 4 : 64) * 1024 ** 3, available: 3 * 1024 ** 3 }), graphics: async () => ({ controllers: [{ model: '测试显卡', vram: lowHardware ? 1024 : 24576 }] }) } }
  };
  let mode = createLocalMode(options);
  try {
    await mode.connect(); assert.equal(mode.snapshot().service.owner, 'external');
    assert.deepEqual(mode.snapshot().installedModels, []);
    pass('真实回环 HTTP 探活，复用已有服务并刷新安装列表');
    mock.state.stallTags = true;
    await assert.rejects(() => options.client.json('/api/tags', { headerTimeout: 40, idleTimeout: 40 }), error => error.name === 'TimeoutError');
    mock.state.stallTags = false;
    pass('本机 HTTP 无响应时由连接超时退出，并关闭请求');

    lowHardware = true; await mode.detect({ force: true });
    const warning = await mode.manager.download({ id: 'qwen25-14b' });
    assert.equal(warning.requiresConfirmation, true); assert.match(warning.warning, /硬件配置低于推荐要求/);
    assert.equal(mock.state.requests.filter(item => item.route === '/api/pull').length, 0);
    assert.equal(mode.snapshot().config.downloading_models.length, 0);
    await mode.manager.download({ id: 'qwen25-14b', confirmationToken: warning.confirmationToken });
    await until(() => mode.snapshot().catalog.find(item => item.id === 'qwen25-14b').installed);
    await until(() => !mode.manager.hasDownloads());
    assert(!mode.snapshot().config.downloading_models.includes('qwen25-14b'));
    pass('硬件不足先返回确认，取消不下载，确认令牌才能强制部署');

    lowHardware = false; await mode.detect({ force: true });
    mock.state.stallPull = true;
    await mode.manager.download({ id: 'qwen25-3b' });
    await until(() => mode.snapshot().catalog.find(item => item.id === 'qwen25-3b').progress >= 50);
    await mode.manager.pause('qwen25-3b');
    const previous = mode.snapshot().catalog.find(item => item.id === 'qwen25-3b').progress;
    assert(mode.snapshot().config.downloading_models.includes('qwen25-3b'));
    assert.match(mode.snapshot().catalog.find(item => item.id === 'qwen25-3b').error, /下载失败，已保存进度/);
    mode = createLocalMode(options); await mode.connect();
    assert.equal(mode.snapshot().catalog.find(item => item.id === 'qwen25-3b').status, 'interrupted');
    assert.equal(mode.snapshot().catalog.find(item => item.id === 'qwen25-3b').progress, previous);
    mock.state.stallPull = false;
    const from = progress.length; await mode.manager.download({ id: 'qwen25-3b' });
    await until(() => !mode.manager.hasDownloads());
    const resumed = progress.slice(from);
    assert(resumed.every(value => value >= previous));
    assert(resumed.every((value, index) => index === 0 || value >= resumed[index - 1]));
    assert.equal(mode.snapshot().catalog.find(item => item.id === 'qwen25-3b').progress, 100);
    pass('中断保存磁盘记录，重建后显示继续下载；从零返回的续传进度不倒退');

    mock.state.failPull = true; await mode.manager.download({ id: 'llama3-8b' });
    await until(() => !mode.manager.hasDownloads());
    assert.match(mode.snapshot().catalog.find(item => item.id === 'llama3-8b').error, /磁盘读写失败/);
    mock.state.failPull = false;
    pass('HTTP 200 内的下载错误包被识别并保留续传记录');

    await mode.manager.select('qwen25-3b');
    let reply = '';
    const history = Array.from({ length: 15 }, (_, index) => [{ role: 'user', content: `问题${index}` }, { role: 'assistant', content: `答案${index}`, status: 'done' }]).flat();
    history.push({ role: 'user', content: '你好' });
    await mode.chat({ ...mode.prepareChat(), systemPrompt: '简洁回答', temperature: 0.7 }, history, new AbortController(), text => { reply += text; });
    assert.match(reply, /本机接口测试/); assert.equal(mock.state.lastChat.options.num_ctx, 4096);
    assert.equal(mock.state.lastChat.stream, true); assert(mock.state.lastChat.messages.length <= 22);
    assert.equal(mock.state.lastChat.messages[1].content, '问题5');
    assert(mock.state.requests.every(item => !item.authorization));
    assert.throws(() => boundMessages([{ role: 'user', content: '长'.repeat(3000) }]), /输入过长/);
    assert.throws(() => boundMessages([{ role: 'user', content: '你好' }], '长'.repeat(1500)), /提示词过长/);
    pass('本地聊天 NDJSON、num_ctx 4096、最多十轮、长输入限制且不携带 API 密钥');

    const controller = new AbortController(); let received = false;
    await assert.rejects(() => mode.chat({ ...mode.prepareChat(), temperature: 0.7, systemPrompt: '' }, [{ role: 'user', content: '停止测试' }], controller, () => { received = true; controller.abort(); }), error => error.name === 'AbortError');
    assert(received); await until(() => mock.state.chatCloses >= 2);
    pass('本地流式聊天中止，HTTP 服务实际观察到连接关闭');

    mock.state.remote = true;
    const before = mock.state.requests.filter(item => item.route === '/api/chat').length;
    await assert.rejects(() => mode.chat({ ...mode.prepareChat(), systemPrompt: '' }, [{ role: 'user', content: '隐私消息' }], new AbortController(), () => {}), /本地权重/);
    assert.equal(mock.state.requests.filter(item => item.route === '/api/chat').length, before);
    mock.state.remote = false;
    pass('检测到远程模型别名时，在发送聊天正文前拒绝请求');

    await mode.manager.remove('qwen25-3b');
    assert.equal(mode.snapshot().catalog.find(item => item.id === 'qwen25-3b').installed, false);
    assert(!mode.snapshot().config.downloading_models.includes('qwen25-3b'));
    assert.equal(mode.snapshot().catalog.find(item => item.id === 'qwen25-3b').progress, 0);
    pass('卸载立即清除安装状态、下载记录与最高进度，不残留已安装卡片');
  } finally { await mode.manager.pauseAll(); await mock.close(); }

  let value = { modelDirectory: path.join(root, 'models'), pendingModelDirectory: null };
  const store = { snapshot: () => structuredClone(value), update: patch => { Object.assign(value, patch); } };
  let live = false, launches = 0, child; const commands = [];
  const service = createOllamaService({ store, emit: () => {}, client: { json: async () => { if (!live) throw new Error('无法连接本机 Ollama'); return { models: [] }; } }, findExecutable: () => '测试运行库.exe', platform: 'win32', isPortBusy: async () => false,
    launch: (_exe, args, options) => {
      launches++; assert.deepEqual(args, ['serve']); assert.equal(options.windowsHide, true); assert.equal(options.env.OLLAMA_NO_CLOUD, '1');
      child = new EventEmitter(); Object.assign(child, { pid: 987654, exitCode: null, signalCode: null, stdout: new EventEmitter(), stderr: new EventEmitter() }); live = true; return child;
    },
    runFile: async (exe, args, options) => {
      commands.push({ exe, args, options });
      if (exe === 'taskkill.exe') { assert.deepEqual(args, ['/PID', '987654', '/T', '/F']); child.exitCode = 0; live = false; child.emit('exit', 0); }
      return {};
    }
  });
  const oldEnvironment = process.env.OLLAMA_MODELS;
  try {
    await Promise.all([service.ensure(), service.ensure(), service.ensure()]);
    assert.equal(launches, 1); assert.equal(service.snapshot().owner, 'vesper');
    const directory = path.join(root, '中文 模型目录'); await service.applyDirectory(directory);
    assert.equal(launches, 2); assert.equal(service.snapshot().activeDirectory, directory);
    assert(commands.some(item => item.exe === 'powershell.exe' && item.options.env.VESPER_MODELS_TARGET === directory));
    await service.stop(); assert.equal(service.owned(), false);
    pass('并发启动仅创建一个静默进程；中文目录通过环境传参，重启只结束所持有 PID');

    live = true; await service.inspect(); const count = commands.length;
    const externalDirectory = path.join(root, '另一个模型目录');
    assert.equal((await service.applyDirectory(externalDirectory)).pending, true);
    assert.equal(service.snapshot().owner, 'external');
    assert.equal(commands.slice(count).filter(item => item.exe === 'taskkill.exe').length, 0);
    await assert.rejects(() => service.ensure(), /目录尚未生效/);
    pass('复用外部服务不结束其进程，目录保持待生效并拦截错误路径下载');
  } finally { if (oldEnvironment === undefined) delete process.env.OLLAMA_MODELS; else process.env.OLLAMA_MODELS = oldEnvironment; }
  let unexpectedLaunches = 0;
  const occupied = createOllamaService({ store: { snapshot: () => ({}) }, emit: () => {}, client: { json: async () => ({ unrelated: true }) }, findExecutable: () => '测试.exe', launch: () => { unexpectedLaunches++; throw new Error('不应启动'); } });
  await assert.rejects(() => occupied.ensure(), /并非可识别/); assert.equal(unexpectedLaunches, 0);
  const missing = createOllamaService({ store: { snapshot: () => ({}) }, emit: () => {}, client: { json: async () => { throw new Error('无法连接本机 Ollama'); } }, findExecutable: () => null, isPortBusy: async () => false });
  await assert.rejects(() => missing.ensure(), /未找到 Ollama/);
  assert.equal(missing.snapshot().status, 'missing');
  pass('端口返回其他应用时拒绝重复启动，运行库缺失时返回明确安装提示');
  const slowOccupied = createOllamaService({ store: { snapshot: () => ({}) }, emit: () => {}, client: { json: async () => { throw new Error('本机 Ollama 响应超时'); } }, isPortBusy: async () => true, launch: () => { throw new Error('不应启动'); } });
  await assert.rejects(() => slowOccupied.ensure(), /没有启动第二个服务/);
  pass('端口已监听但 HTTP 探活超时时仍拒绝重复启动');
  const waitingController = new AbortController();
  const waitingChat = createLocalChat({ service: { ensure: async () => {} }, manager: { modelById: () => ({ ollamaTag: 'qwen2.5:3b' }), verifyLocal: async () => {} }, detector: { detect: () => new Promise(() => {}) }, client: { stream: async () => { throw new Error('不应发起聊天'); } } });
  const waitingStart = Date.now();
  const waiting = waitingChat({ localModelId: 'qwen25-3b', systemPrompt: '' }, [{ role: 'user', content: '你好' }], waitingController, () => {});
  setTimeout(() => waitingController.abort(), 20);
  await assert.rejects(() => waiting, error => error.name === 'AbortError');
  assert(Date.now() - waitingStart < 500);
  pass('硬件探测尚未结束时也可立即停止聊天，不等待检测超时');
  let cpuPayload;
  const cpuChat = createLocalChat({ service: { ensure: async () => {} }, manager: { modelById: () => ({ ollamaTag: 'qwen2.5:3b' }), verifyLocal: async () => {} }, detector: { detect: async () => ({ cpuFallback: true }) }, client: { stream: async (_route, payload, packet) => { cpuPayload = payload; packet({ message: { content: 'CPU 测试' }, done: true }); } } });
  await cpuChat({ localModelId: 'qwen25-3b', systemPrompt: '', temperature: 0.7 }, [{ role: 'user', content: '你好' }], new AbortController(), () => {});
  assert.equal(cpuPayload.options.num_gpu, 0); assert.equal(cpuPayload.options.num_ctx, 4096);
  const bounded = boundMessages([...Array.from({ length: 10 }, () => [{ role: 'user', content: '问'.repeat(800) }, { role: 'assistant', content: '答'.repeat(1500), status: 'done' }]).flat(), { role: 'user', content: '你好' }], '系统提示');
  assert(bounded.reduce((sum, message) => sum + Buffer.byteLength(message.content) + 32, 0) <= 10000);
  pass('CPU 回退显式 num_gpu 为零，长历史还受字节预算限制');
  fs.writeFileSync(path.join(__dirname, '../work/local-integration-results.json'), JSON.stringify({ time: new Date().toISOString(), results, actualWeightsUsed: false, windowsRegistryChanged: false }, null, 2));
  console.log(`全部 ${results.length} 项本地集成检查通过。`);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
