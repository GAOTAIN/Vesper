const si = require('systeminformation');
const os = require('node:os');
const { exec } = require('node:child_process');
const { promisify } = require('node:util');

async function withTimeout(task, ms) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('硬件检测超时')), ms); })
    ]);
  } finally { clearTimeout(timer); }
}

// 依赖可注入，便于验证缺少驱动、命令不存在和检测超时的真实分支。
function createHardwareDetector(dependencies = {}) {
  const information = dependencies.si || si;
  const system = dependencies.os || os;
  const execute = dependencies.execAsync || promisify(exec);
  const timeoutMs = dependencies.timeoutMs ?? 5000;
  const cacheMs = dependencies.cacheMs ?? 30000;
  const changed = dependencies.onChange || (() => {});
  let snapshot = { status: 'idle', result: null, error: '' };
  let pending = null;
  const copy = () => structuredClone(snapshot);
  const publish = () => { try { changed(copy()); } catch {} };

  async function collect() {
    const warnings = [], diagnostics = [];
    const failed = (stage, error) => diagnostics.push({ stage, message: String(error?.message || error).slice(0, 180) });
    const memoryTask = (async () => {
      try {
        const value = await withTimeout(() => information.mem(), timeoutMs);
        if (!Number.isFinite(value?.total) || value.total <= 0) throw new Error('内存数据无效');
        return { value, source: 'systeminformation' };
      } catch (error) {
        failed('memory', error);
        warnings.push('内存信息使用系统备用接口，可用内存为保守估计。');
        try { return { value: { total: system.totalmem(), available: system.freemem() }, source: 'node:os' }; }
        catch (fallbackError) { failed('memory-fallback', fallbackError); return { value: {}, source: 'unknown' }; }
      }
    })();

    let vramMiB = 0, vramSource = 'cpu-fallback', gpuName = '';
    try {
      const graphics = await withTimeout(() => information.graphics(), timeoutMs);
      const controllers = Array.isArray(graphics?.controllers) ? graphics.controllers : [];
      const sizes = controllers.filter(gpu => gpu && gpu.vramDynamic !== true).map(gpu => ({
        name: String(gpu.model || gpu.name || '显卡').slice(0, 160),
        size: Number(gpu.memoryTotal) > 0 ? Number(gpu.memoryTotal) : Number(gpu.vram)
      })).filter(gpu => Number.isFinite(gpu.size) && gpu.size > 0).sort((a, b) => b.size - a.size);
      if (!sizes.length) throw new Error('未取得有效的专用显存数据');
      vramMiB = sizes[0].size; gpuName = sizes[0].name; vramSource = 'systeminformation';
    } catch (error) { failed('graphics', error); }

    // 命令为固定常量，绝不拼接模型名、路径或其他页面输入。
    const fallbacks = [
      ['nvidia-smi', 'nvidia-smi'],
      ['"C:\\Windows\\System32\\nvidia-smi.exe"', 'absolute-path']
    ];
    for (const [command, source] of fallbacks) {
      if (vramMiB > 0) break;
      try {
        const { stdout } = await execute(`${command} --query-gpu=memory.total --format=csv,noheader,nounits`, {
          windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024, encoding: 'utf8'
        });
        const sizes = String(stdout || '').trim().split(/\r?\n/)
          .filter(line => /^\s*\d+(?:\.\d+)?\s*$/.test(line)).map(Number)
          .filter(value => Number.isFinite(value) && value > 0);
        if (!sizes.length) throw new Error('命令未返回有效显存容量');
        vramMiB = Math.max(...sizes); vramSource = source; gpuName = 'NVIDIA 显卡';
      } catch (error) { failed(source, error); }
    }

    const memory = await memoryTask;
    const total = Number(memory.value.total);
    const available = Number(memory.value.available);
    if (!Number.isFinite(total) || total <= 0) warnings.push('内存容量无法确认，配置评估将按不达标处理。');
    if (!vramMiB) warnings.push('未能确认可用显存，按纯 CPU 模式评估，运行速度可能较慢。');
    else warnings.push('显存容量仅用于推荐配置评估，实际 GPU 支持情况由 Ollama 决定。');
    return {
      ramGiB: Number.isFinite(total) && total > 0 ? total / (1024 ** 3) : 0,
      availableRamGiB: Number.isFinite(available) && available >= 0 && total > 0 ? Math.min(available, total) / (1024 ** 3) : null,
      vramGiB: vramMiB / 1024, ramSource: memory.source, vramSource, gpuName,
      cpuFallback: vramMiB === 0, checkedAt: Date.now(), warnings, diagnostics
    };
  }

  async function detect({ force = false } = {}) {
    if (pending) return pending;
    if (!force && snapshot.result && Date.now() - snapshot.result.checkedAt < cacheMs) return structuredClone(snapshot.result);
    snapshot = { ...snapshot, status: 'detecting', error: '' }; publish();
    pending = collect().then(result => {
      snapshot = { status: 'ready', result, error: '' }; publish(); return structuredClone(result);
    }).catch(error => {
      snapshot = { ...snapshot, status: 'error', error: '硬件检测失败，请重新检测。' }; publish(); throw error;
    }).finally(() => { pending = null; });
    return pending;
  }
  return { detect, snapshot: copy };
}

module.exports = { createHardwareDetector, withTimeout };
