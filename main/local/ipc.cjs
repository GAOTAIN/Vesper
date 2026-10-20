const { loadCatalog } = require('./catalog.cjs');
const { createHardwareDetector } = require('./hardware.cjs');
const { createLocalStore } = require('./local-store.cjs');
const { createOllamaClient } = require('./ollama-client.cjs');
const { createOllamaService } = require('./ollama-service.cjs');
const { createModelManager } = require('./model-manager.cjs');
const { createLocalChat } = require('./local-chat.cjs');
const { createOllamaInstaller } = require('./ollama-installer.cjs');

function createLocalMode({ readJSON, writeJSON, emit, client = createOllamaClient(), serviceOptions = {}, detectorOptions = {}, installerOptions = {} }) {
  const catalog = loadCatalog();
  const store = createLocalStore({ readJSON, writeJSON, catalog });
  let revision = 0;
  const changed = progress => {
    revision++; emit(snapshot(), progress);
  };
  const detector = createHardwareDetector({ ...detectorOptions, onChange: () => changed() });
  const service = createOllamaService({ ...serviceOptions, client, store, emit: () => changed() });
  const manager = createModelManager({ catalog, store, service, client, detector, emit: changed });
  const chat = createLocalChat({ service, manager, detector, client });
  const installer = createOllamaInstaller({ ...installerOptions, service, onInstalled: () => manager.refresh(), emit: () => changed() });
  function snapshot() {
    const hardware = detector.snapshot();
    const models = manager.snapshot();
    return {
      revision, catalog: models.models,
      config: store.snapshot(), hardware, service: service.snapshot(), installer: installer.snapshot(),
      ...models, features: { directory: true, service: true, downloads: true, chat: true, installation: true }
    };
  }
  return {
    snapshot, chat, service, manager, installer,
    prepareChat() {
      const id = store.snapshot().selectedModelId;
      if (!id) throw new Error('请先在本地部署面板下载并选择已安装模型。');
      const model = manager.modelById(id);
      return { localModelId: model.id, localModelName: model.name };
    },
    async connect() { await service.ensure(); await manager.refresh(); return snapshot(); },
    async refresh() {
      await service.inspect();
      if (service.snapshot().status === 'ready') await manager.refresh();
      return snapshot();
    },
    async detect(input = {}) {
      if (!input || typeof input !== 'object' || (input.force !== undefined && typeof input.force !== 'boolean')) throw new Error('硬件检测参数无效。');
      await detector.detect({ force: input.force === true }); return snapshot();
    }
  };
}

function registerLocalIPC(handle, getLocalMode, { chooseDirectory, stopChat }) {
  // 复用现有主进程的来源校验和统一错误封装，不暴露通用命令执行能力。
  handle('local:state', () => getLocalMode().snapshot());
  handle('local:hardware', input => getLocalMode().detect(input));
  handle('local:ensure-service', () => getLocalMode().connect());
  handle('local:refresh', () => getLocalMode().refresh());
  handle('local:choose-directory', async () => {
    const directory = await chooseDirectory();
    if (directory) await getLocalMode().manager.changeDirectory(directory, stopChat);
    return getLocalMode().snapshot();
  });
  handle('local:apply-directory', async () => {
    const mode = getLocalMode();
    const directory = mode.snapshot().config.pendingModelDirectory;
    if (!directory) throw new Error('没有待生效的模型目录。');
    await mode.manager.changeDirectory(directory, stopChat); return mode.snapshot();
  });
  handle('local:download', input => getLocalMode().manager.download(input));
  handle('local:pause', async id => { await getLocalMode().manager.pause(id); return getLocalMode().snapshot(); });
  handle('local:delete', async id => { await stopChat(id); await getLocalMode().manager.remove(id); return getLocalMode().snapshot(); });
  handle('local:select-model', async id => { await getLocalMode().manager.select(id); return getLocalMode().snapshot(); });
  handle('local:install-runtime', async () => { const mode = getLocalMode(); await mode.installer.start(); return mode.snapshot(); });
  handle('local:cancel-install', () => { const mode = getLocalMode(); mode.installer.cancel(); return mode.snapshot(); });
}

module.exports = { createLocalMode, registerLocalIPC };
