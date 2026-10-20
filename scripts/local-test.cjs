// 覆盖硬件探测失败分支和持久化边界，不需要安装 Ollama 或真实显卡。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: pause } = require('node:timers/promises');
const { createHardwareDetector } = require('../main/local/hardware.cjs');
const { loadCatalog, validateCatalog, assessHardware } = require('../main/local/catalog.cjs');
const { createLocalStore } = require('../main/local/local-store.cjs');
const results = [];
const pass = name => { results.push({ name, passed: true }); console.log(`通过：${name}`); };
const failure = async () => { throw new Error('测试：命令不存在'); };
function fixture(overrides = {}) {
  const calls = [];
  const detector = createHardwareDetector({
    si: { mem: async () => ({ total: 16 * 1024 ** 3, available: 8 * 1024 ** 3 }), graphics: failure },
    os: { totalmem: () => 8 * 1024 ** 3, freemem: () => 3 * 1024 ** 3 },
    execAsync: async (command, options) => { calls.push({ command, options }); return failure(); },
    ...overrides
  });
  return { detector, calls };
}

(async () => {
  const catalog = loadCatalog();
  assert.equal(catalog.length, 4);
  assert(catalog.some(model => model.ollamaTag === 'qwen2.5:14b'));
  assert(catalog.some(model => model.ollamaTag === 'llama3:8b'));
  assert.throws(() => validateCatalog([...catalog, catalog[0]]), /重复/);
  assert.throws(() => validateCatalog([{ ...catalog[0], id: 123 }]), /标识/);
  assert.throws(() => validateCatalog([{ ...catalog[0], ollamaTag: 'qwen:cloud' }]), /本地/);
  assert.throws(() => validateCatalog([{ ...catalog[0], sizeGb: '4.7' }]), /体积/);
  assert.throws(() => validateCatalog([{ ...catalog[0], recommendedRam: '未知' }]), /推荐配置/);
  pass('模型目录字段、唯一性、Qwen 14B、Llama 3 与本地标签约束');

  const success = fixture({ si: {
    mem: async () => ({ total: 16 * 1024 ** 3, available: 8 * 1024 ** 3 }),
    graphics: async () => ({ controllers: [
      { model: '测试显卡甲', vram: 8192 }, { model: '测试显卡乙', vram: 16384 },
      { model: '共享显存', vram: 32768, vramDynamic: true }
    ] })
  } });
  let hardware = await success.detector.detect();
  assert.equal(hardware.ramGiB, 16); assert.equal(hardware.availableRamGiB, 8);
  assert.equal(hardware.vramGiB, 16); assert.equal(hardware.gpuName, '测试显卡乙');
  assert.equal(hardware.vramSource, 'systeminformation'); assert.equal(success.calls.length, 0);
  pass('优先使用系统信息库；忽略动态共享显存，按最大单卡评估');

  const pathCalls = [];
  const pathFallback = fixture({ execAsync: async (command, options) => {
    pathCalls.push(command); assert.equal(options.windowsHide, true); assert.equal(options.timeout, 5000);
    return { stdout: '8192\r\n12288\r\n' };
  } });
  hardware = await pathFallback.detector.detect();
  assert.equal(hardware.vramGiB, 12); assert.equal(hardware.vramSource, 'nvidia-smi');
  assert.equal(pathCalls.length, 1); assert(pathCalls[0].startsWith('nvidia-smi '));
  pass('第二层 nvidia-smi 读取多卡容量，使用隐藏窗口和有限超时');

  const absoluteCalls = [];
  const absolute = fixture({ execAsync: async command => {
    absoluteCalls.push(command);
    if (command.startsWith('nvidia-smi ')) throw new Error('Command not found');
    assert(command.startsWith('"C:\\Windows\\System32\\nvidia-smi.exe" '));
    return { stdout: '6144\n' };
  } });
  hardware = await absolute.detector.detect();
  assert.equal(hardware.vramGiB, 6); assert.equal(hardware.vramSource, 'absolute-path'); assert.equal(absoluteCalls.length, 2);
  pass('PATH 命令缺失后，实际进入固定绝对路径的第三层分支');

  const invalid = fixture({ execAsync: async command => ({ stdout: command.startsWith('nvidia-smi ') ? 'N/A\n错误\n' : '4096\n' }) });
  hardware = await invalid.detector.detect();
  assert.equal(hardware.vramGiB, 4); assert.equal(hardware.vramSource, 'absolute-path');
  pass('命令成功但输出无效时继续回退，不把 N/A 误当有效显存');

  const cpu = fixture(); hardware = await cpu.detector.detect();
  assert.equal(hardware.vramGiB, 0); assert.equal(hardware.cpuFallback, true);
  assert.equal(cpu.calls.length, 2); assert(hardware.warnings.some(text => text.includes('纯 CPU')));
  assert.equal(hardware.diagnostics.length, 3);
  pass('三层检测均失败时显存为零，保留诊断并提示纯 CPU 评估');

  const memoryFallback = fixture({ si: { mem: async () => ({ total: 0 }), graphics: failure } });
  hardware = await memoryFallback.detector.detect();
  assert.equal(hardware.ramSource, 'node:os'); assert.equal(hardware.ramGiB, 8); assert.equal(hardware.availableRamGiB, 3);
  pass('系统信息库内存数据无效时使用系统备用接口');

  const unknownMemory = fixture({
    si: { mem: failure, graphics: failure },
    os: { totalmem: () => { throw new Error('测试：备用接口不可用'); }, freemem: () => 0 }
  });
  hardware = await unknownMemory.detector.detect();
  assert.equal(hardware.ramGiB, 0); assert.equal(hardware.availableRamGiB, null);
  assert.equal(assessHardware(catalog[0], hardware).belowRecommended, true);
  pass('内存两种接口均失败时保守拦截，不把未知容量当达标');

  const never = () => new Promise(() => {});
  const timeout = fixture({ timeoutMs: 15, si: { mem: never, graphics: never } });
  const start = Date.now(); hardware = await timeout.detector.detect();
  assert(Date.now() - start < 1000); assert.equal(hardware.ramSource, 'node:os'); assert.equal(hardware.cpuFallback, true);
  pass('内存与显卡探测挂起时由超时退出，页面不会无限等待');

  let graphicsCalls = 0;
  const states = [];
  const cached = fixture({ onChange: value => states.push(value.status), si: {
    mem: async () => ({ total: 16 * 1024 ** 3 }),
    graphics: async () => { graphicsCalls++; await pause(20); return { controllers: [{ vram: 8192 }] }; }
  } });
  await Promise.all([cached.detector.detect(), cached.detector.detect({ force: true })]);
  assert.equal(graphicsCalls, 1); await cached.detector.detect(); assert.equal(graphicsCalls, 1);
  await cached.detector.detect({ force: true }); assert.equal(graphicsCalls, 2);
  assert.deepEqual(states, ['detecting', 'ready', 'detecting', 'ready']);
  const snapshot = cached.detector.snapshot(); snapshot.result.vramGiB = 999;
  assert.equal(cached.detector.snapshot().result.vramGiB, 8);
  pass('并发检测合并、30 秒缓存、强制刷新、状态推送与快照隔离');

  assert.equal(assessHardware(catalog[1], { ramGiB: 15.8, vramGiB: 8 }).belowRecommended, false);
  assert.equal(assessHardware(catalog[1], { ramGiB: 15.8, vramGiB: 7.99 }).belowRecommended, false);
  assert.equal(assessHardware(catalog[1], { ramGiB: 16, vramGiB: 7.8 }).belowRecommended, true);
  assert.equal(assessHardware(catalog[1], { ramGiB: 8, vramGiB: 4 }).belowRecommended, true);
  assert.equal(assessHardware(catalog[1], { ramGiB: 16, vramGiB: 0, cpuFallback: true }).cpuFallback, true);
  assert.equal(assessHardware(catalog[0], null), null);
  pass('配置评估包含内存保留余量、显存不足、CPU 回退和未检测状态');

  const directory = path.join(__dirname, '../work', `local-store-${Date.now()}`);
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, 'local-deployment.json');
  fs.writeFileSync(target, JSON.stringify({ modelDirectory: 'E:\\模型仓库', selectedModelId: 'qwen25-7b', downloading_models: ['qwen25-7b', 'qwen25-7b', '非法模型'], downloadRecords: { 'qwen25-7b': { maxProgress: 45 } } }));
  const storeOptions = {
    catalog,
    readJSON: () => JSON.parse(fs.readFileSync(target, 'utf8')),
    writeJSON: (_name, value) => { const temp = `${target}.tmp`; fs.writeFileSync(temp, JSON.stringify(value)); fs.renameSync(temp, target); }
  };
  let store = createLocalStore(storeOptions);
  assert.deepEqual(store.snapshot().downloading_models, ['qwen25-7b']);
  assert.equal(store.snapshot().modelDirectory, 'E:\\模型仓库');
  store = createLocalStore(storeOptions);
  assert.equal(store.snapshot().selectedModelId, 'qwen25-7b');
  assert.equal(store.snapshot().downloadRecords['qwen25-7b'].maxProgress, 45);
  pass('本地 JSON 重读保留中文目录与下载记录，并去除未知和重复模型 ID');

  fs.mkdirSync(path.join(__dirname, '../work'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '../work/local-unit-results.json'), JSON.stringify({ time: new Date().toISOString(), results }, null, 2));
  console.log(`全部 ${results.length} 项本地基础检查通过。`);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
