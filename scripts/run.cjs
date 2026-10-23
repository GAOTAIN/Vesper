// 所有构建路径由项目位置计算，避免中文路径被 shell 二次转义。
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const env = { ...process.env, ELECTRON_BUILDER_CACHE: path.join(root, '.cache', 'builder'), electron_config_cache: path.join(root, '.cache', 'electron') };
delete env.ELECTRON_RUN_AS_NODE;
if (['test', 'local-test', 'installer-test', 'language-test'].includes(process.argv[2])) {
  env.VESPER_TEST_DATA = path.join(root, 'work', `test-profile-${Date.now()}`);
  fs.mkdirSync(env.VESPER_TEST_DATA, { recursive: true });
  const entry = process.argv[2] === 'language-test' ? 'language-smoke.cjs' : process.argv[2] === 'installer-test' ? 'installer-smoke.cjs' : process.argv[2] === 'local-test' ? 'local-smoke.cjs' : 'smoke.cjs';
  const r = spawnSync(require('electron'), [path.join(__dirname, entry)], { cwd: root, env, stdio: 'inherit' });
  process.exit(r.status ?? 1);
} else {
  process.env.electron_config_cache = env.electron_config_cache;
  const electronDist = path.dirname(require('electron'));
  const r = spawnSync(process.execPath, [require.resolve('electron-builder/cli.js'), '--win', 'portable', '--x64', `--config.electronDist=${electronDist}`], { cwd: root, env, stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
