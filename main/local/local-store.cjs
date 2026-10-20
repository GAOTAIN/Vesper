const defaults = { schemaVersion: 1, modelDirectory: '', pendingModelDirectory: null, selectedModelId: null, downloading_models: [], downloadRecords: {} };

function createLocalStore({ readJSON, writeJSON, catalog }) {
  const ids = new Set(catalog.map(model => model.id));
  const raw = readJSON('local-deployment', defaults);
  const saved = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  let value = {
    schemaVersion: 1,
    modelDirectory: typeof saved.modelDirectory === 'string' ? saved.modelDirectory : '',
    pendingModelDirectory: typeof saved.pendingModelDirectory === 'string' ? saved.pendingModelDirectory : null,
    selectedModelId: ids.has(saved.selectedModelId) ? saved.selectedModelId : null,
    downloading_models: Array.isArray(saved.downloading_models) ? [...new Set(saved.downloading_models.filter(id => ids.has(id)))] : [],
    downloadRecords: saved.downloadRecords && typeof saved.downloadRecords === 'object' && !Array.isArray(saved.downloadRecords) ? saved.downloadRecords : {}
  };
  // 此阶段只读取和建立配置；目录环境变量与下载状态由后续管理模块接入。
  writeJSON('local-deployment', value);
  return {
    snapshot: () => structuredClone(value),
    update(change) {
      const next = structuredClone(value);
      if (typeof change === 'function') change(next); else Object.assign(next, change);
      writeJSON('local-deployment', next); value = next;
      return structuredClone(value);
    }
  };
}

module.exports = { createLocalStore };
