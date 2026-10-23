// 使用独立临时变量实测 Windows 用户环境变量读写，不修改 OLLAMA_MODELS。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { saveModelsEnvironment } = require('../main/local/ollama-service.cjs');
const run = promisify(execFile);
const results = [];
const pass = name => { results.push({ name, passed: true }); console.log('通过：' + name); };
async function powershell(script) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000, encoding: 'utf8' });
}
(async () => {
  const target = path.resolve(__dirname, '../work/中文目录 空格 & $() [测试]');
  let recorded;
  await saveModelsEnvironment(target, async (executable, args, options) => { recorded = { executable, args, options }; return {}; });
  assert.equal(recorded.options.windowsHide, true);
  assert.equal(recorded.args.includes('-WindowStyle'), false);
  assert.equal(recorded.options.env.VESPER_MODELS_TARGET, target);
  assert.equal(recorded.args.at(-1).includes(target), false);
  assert.match(recorded.args.at(-1), /ErrorActionPreference/);
  assert.match(recorded.args.at(-1), /Console.*Error/);
  pass('保留静默启动，移除导致退出的参数；中文及特殊字符路径仅通过环境传参');
  for (const [error, expected] of [
    [Object.assign(new Error('Command failed: powershell.exe'), { code: 4294967295, stderr: '' }), /异常退出/],
    [Object.assign(new Error('Command failed: powershell.exe'), { stderr: '注册表访问被拒绝' }), /注册表访问被拒绝/],
    [Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' }), /未找到 Windows PowerShell/],
    [Object.assign(new Error('Command failed: powershell.exe'), { killed: true }), /超时/]
  ]) {
    await assert.rejects(() => saveModelsEnvironment(target, async () => { throw error; }), value => expected.test(value.message) && !value.message.includes('Command failed:') && value.message.includes('原下载位置保持不变'));
  }
  pass('无输出异常退出、权限错误、缺少 PowerShell 与超时均返回可读原因');
  if (process.platform !== 'win32') throw new Error('原生环境变量回归测试需要 Windows。');
  const variable = 'VESPER_DIRECTORY_TEST_' + randomUUID().replaceAll('-', '');
  const readScript = name => '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); [Console]::Out.Write([Environment]::GetEnvironmentVariable("' + name + '", "User"))';
  const original = (await powershell(readScript('OLLAMA_MODELS'))).stdout;
  let cleaned = false;
  try {
    await saveModelsEnvironment(target, (executable, args, options) => {
      // 只替换测试变量名，其余参数、脚本和执行选项完全使用生产函数。
      const substituted = [...args]; substituted[substituted.length - 1] = substituted.at(-1).replaceAll('"OLLAMA_MODELS"', '"' + variable + '"');
      return run(executable, substituted, options);
    });
    assert.equal((await powershell(readScript(variable))).stdout, target);
    assert.equal((await powershell(readScript('OLLAMA_MODELS'))).stdout, original);
    pass('真实 Windows PowerShell 写入并读回中文和特殊字符路径，日常模型变量未改变');
  } finally {
    await powershell('[Environment]::SetEnvironmentVariable("' + variable + '", $null, "User")');
    assert.equal((await powershell(readScript(variable))).stdout, '');
    cleaned = true;
  }
  pass('临时用户环境变量已清理，实际 Ollama 模型目录未更改');
  fs.mkdirSync(path.resolve(__dirname, '../work'), { recursive: true });
  fs.writeFileSync(path.resolve(__dirname, '../work/directory-environment-results.json'), JSON.stringify({ time: new Date().toISOString(), results, nativeWindowsWriteTested: true, electronVersion: process.versions.electron || null, testVariableCleaned: cleaned, actualModelsVariableUnchanged: true }, null, 2));
  console.log('全部 ' + results.length + ' 项环境变量检查通过。');
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
