const { randomUUID, createHash } = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const { assessHardware } = require('./catalog.cjs');

function createModelManager({ catalog, store, service, client, detector, emit }) {
  let installed = null, lastError = '', epoch = 0, changingDirectory = false;
  const jobs = new Map(), confirmations = new Map(), deleting = new Set();
  const modelById = id => {
    const model = catalog.find(item => item.id === id);
    if (!model) throw new Error('模型不在本地目录中。'); return model;
  };
  const namespace = () => createHash('sha256').update(path.resolve(store.snapshot().modelDirectory || process.env.OLLAMA_MODELS || path.join(os.homedir(), '.ollama/models')).toLowerCase()).digest('hex').slice(0, 20);
  const records = () => store.snapshot().downloadRecords[namespace()] || {};
  const installedTag = tag => installed?.some(item => (item.name === tag || item.model === tag) && !item.remote_host && !item.remote_model);
  const updateRecord = (id, record, remember = true) => store.update(value => {
    const key = namespace();
    if (!value.downloadRecords[key]) value.downloadRecords[key] = {};
    value.downloadRecords[key][id] = record;
    if (remember && !value.downloading_models.includes(id)) value.downloading_models.push(id);
  });
  async function refresh() {
    const response = await service.ping();
    installed = response.models.filter(item => item && typeof item.name === 'string');
    lastError = '';
    store.update(value => {
      const key = namespace();
      const byId = value.downloadRecords[key] || {};
      value.downloading_models = value.downloading_models.filter(id => !installedTag(modelById(id).ollamaTag));
      for (const model of catalog) {
        if (installedTag(model.ollamaTag) && byId[model.id]) byId[model.id] = { ...byId[model.id], status: 'installed', maxProgress: 100 };
      }
      if (!value.selectedModelId || !installedTag(modelById(value.selectedModelId).ollamaTag)) value.selectedModelId = catalog.find(model => installedTag(model.ollamaTag))?.id || null;
    });
    emit(); return installed;
  }
  function snapshot() {
    const pending = store.snapshot().downloading_models;
    return {
      installedModels: installed && structuredClone(installed), lastError, changingDirectory,
      models: catalog.map(model => {
        const record = records()[model.id];
        const running = jobs.has(model.id);
        return { ...model, installed: installed ? Boolean(installedTag(model.ollamaTag)) : null,
          status: deleting.has(model.id) ? 'deleting' : running ? 'downloading' : installedTag(model.ollamaTag) ? 'installed' : pending.includes(model.id) ? 'interrupted' : 'available',
          progress: record?.maxProgress || 0, stage: record?.stage || '', error: record?.error || '',
          jobId: jobs.get(model.id)?.id || null, assessment: assessHardware(model, detector.snapshot().result) };
      })
    };
  }
  async function download(input) {
    const model = modelById(input?.id);
    if (changingDirectory || deleting.has(model.id)) throw new Error('模型目录或卸载操作正在进行，请稍后重试。');
    if (jobs.has(model.id)) return { started: true, jobId: jobs.get(model.id).id };
    if (jobs.size) throw new Error('已有模型正在下载，请先暂停或等待完成。');
    const before = epoch;
    const hardware = await detector.detect();
    const assessment = assessHardware(model, hardware);
    if (assessment.belowRecommended) {
      const confirmation = confirmations.get(input?.confirmationToken);
      if (!confirmation || confirmation.id !== model.id || confirmation.namespace !== namespace() || confirmation.checkedAt !== hardware.checkedAt || confirmation.expires < Date.now()) {
        const token = randomUUID();
        for (const [key, value] of confirmations) if (value.expires < Date.now()) confirmations.delete(key);
        confirmations.set(token, { id: model.id, namespace: namespace(), checkedAt: hardware.checkedAt, expires: Date.now() + 120000 });
        return { requiresConfirmation: true, confirmationToken: token, warning: '硬件配置低于推荐要求，可能卡顿或崩溃。', reasons: assessment.reasons, cpuFallback: assessment.cpuFallback };
      }
      confirmations.delete(input.confirmationToken);
    }
    await service.ensure();
    if (before !== epoch || changingDirectory || jobs.size || deleting.has(model.id)) throw new Error('部署状态已变化，请重新点击下载。');
    if (store.snapshot().pendingModelDirectory) throw new Error('模型目录尚未生效，请先完成目录切换。');
    if (installedTag(model.ollamaTag)) return { installed: true };
    const previous = records()[model.id] || {};
    const layers = Object.fromEntries(Object.entries(previous.layers && typeof previous.layers === 'object' ? previous.layers : {}).slice(0, 100)
      .filter(([key, layer]) => key !== '__proto__' && layer && Number.isFinite(layer.total) && layer.total > 0 && Number.isFinite(layer.completed))
      .map(([key, layer]) => [key, { total: layer.total, completed: Math.max(0, Math.min(layer.completed, layer.total)) }]));
    const record = { status: 'downloading', maxProgress: Math.max(0, Math.min(99, Number(previous.maxProgress) || 0)), layers, stage: '正在获取模型清单', error: '', updatedAt: Date.now() };
    const job = { id: randomUUID(), controller: new AbortController(), record, storage: namespace() };
    updateRecord(model.id, record);
    jobs.set(model.id, job); emit();
    job.finished = runDownload(model, job);
    return { started: true, jobId: job.id };
  }
  async function runDownload(model, job) {
    let successful = false, lastWritten = '';
    try {
      await client.stream('/api/pull', { model: model.ollamaTag, stream: true }, packet => {
        if (jobs.get(model.id) !== job || job.controller.signal.aborted || job.storage !== namespace()) return;
        const record = job.record;
        if (typeof packet.digest === 'string' && /^sha256:[a-zA-Z0-9_-]{1,180}$/.test(packet.digest) && Number.isFinite(packet.total) && packet.total > 0) {
          if (Object.keys(record.layers).length > 100) throw new Error('模型返回的分层数量异常。');
          const old = record.layers[packet.digest] || { total: 0, completed: 0 };
          record.layers[packet.digest] = { total: Math.max(old.total, packet.total), completed: Math.max(old.completed, Math.min(packet.total, Math.max(0, Number(packet.completed) || 0))) };
        }
        const layers = Object.values(record.layers);
        const total = Math.max(model.sizeGb * 1e9, layers.reduce((sum, layer) => sum + layer.total, 0));
        const completed = layers.reduce((sum, layer) => sum + layer.completed, 0);
        record.maxProgress = Math.max(record.maxProgress, Math.min(99, Math.floor(completed / total * 100)));
        const status = String(packet.status || '');
        record.stage = /verifying|writing|removing/.test(status) ? '下载完成，正在校验与安装' : /pulling manifest/.test(status) ? '正在获取模型清单' : /pulling/.test(status) ? '正在下载模型分层' : status === 'success' ? '正在确认安装状态' : '正在处理模型文件';
        if (status === 'success') successful = true;
        const stamp = `${record.maxProgress}:${record.stage}`;
        if (stamp !== lastWritten) {
          record.updatedAt = Date.now(); updateRecord(model.id, record); lastWritten = stamp;
          emit({ modelId: model.id, jobId: job.id, progress: record.maxProgress, stage: record.stage });
        }
      }, { signal: job.controller.signal, headerTimeout: 60000, idleTimeout: 120000 });
      if (!successful) throw new Error('下载流提前结束，尚未收到安装成功确认。');
      await refresh();
      if (!installedTag(model.ollamaTag)) throw new Error('模型下载已结束，但安装列表尚未确认，请继续下载以重新校验。');
      job.record = { ...job.record, status: 'installed', maxProgress: 100, stage: '已安装', error: '' };
      store.update(value => {
        value.downloading_models = value.downloading_models.filter(id => id !== model.id);
        value.downloadRecords[job.storage][model.id] = job.record;
      });
    } catch (error) {
      if (jobs.get(model.id) === job && job.storage === namespace()) {
        job.record = { ...job.record, status: 'interrupted', stage: '下载失败，已保存进度', error: job.controller.signal.aborted ? '下载失败，已保存进度。可点击“继续下载”。' : `下载失败，已保存进度。${error.message}`, updatedAt: Date.now() };
        try { updateRecord(model.id, job.record); } catch { lastError = '下载状态无法写入磁盘，请检查权限和剩余空间。'; }
      }
    } finally {
      if (jobs.get(model.id) === job) jobs.delete(model.id);
      emit();
    }
  }
  async function pause(id) {
    modelById(id); const job = jobs.get(id);
    if (job) { job.controller.abort(); await job.finished; }
  }
  async function pauseAll() { await Promise.all([...jobs.keys()].map(pause)); }
  async function remove(id) {
    const model = modelById(id);
    if (changingDirectory || deleting.has(id)) throw new Error('模型管理操作正在进行。');
    deleting.add(id); emit();
    try {
      await pause(id); await service.ensure();
      await client.json('/api/delete', { method: 'DELETE', body: { model: model.ollamaTag }, headerTimeout: 30000 });
      installed = (installed || []).filter(item => item.name !== model.ollamaTag && item.model !== model.ollamaTag);
      store.update(value => {
        value.downloading_models = value.downloading_models.filter(item => item !== id);
        if (value.downloadRecords[namespace()]) delete value.downloadRecords[namespace()][id];
        if (value.selectedModelId === id) value.selectedModelId = null;
      });
      emit();
      try { await refresh(); } catch { lastError = '模型已卸载，其他模型的状态刷新失败，请重新检测服务。'; }
    } finally { deleting.delete(id); emit(); }
  }
  async function select(id) {
    const model = modelById(id); await service.ensure(); await refresh();
    if (!installedTag(model.ollamaTag)) throw new Error('请选择已安装的本地模型。');
    await verifyLocal(model.ollamaTag);
    store.update({ selectedModelId: id }); emit();
  }
  async function verifyLocal(tag, signal) {
    const info = await client.json('/api/show', { method: 'POST', body: { model: tag }, signal, headerTimeout: 10000 });
    if (info.remote_host || info.remote_model || !info.model_info || !Object.keys(info.model_info).length) throw new Error('无法确认所选模型具有本地权重，已阻止发送。请选择本地模型，或关闭 Ollama 云功能并重启。');
  }
  async function changeDirectory(directory, stopChat) {
    if (changingDirectory || deleting.size) throw new Error('另一个模型管理操作正在进行。');
    changingDirectory = true; epoch++; emit();
    try {
      await stopChat(); await pauseAll();
      const result = await service.applyDirectory(directory);
      installed = null;
      if (!result.pending) store.update(value => {
        value.selectedModelId = null;
        value.downloading_models = Object.entries(value.downloadRecords[namespace()] || {}).filter(([, record]) => ['downloading', 'interrupted'].includes(record?.status)).map(([id]) => id).filter(id => catalog.some(model => model.id === id));
      });
      if (!result.pending && service.snapshot().status === 'ready') await refresh();
      else emit();
      return result;
    } finally { changingDirectory = false; emit(); }
  }
  return { snapshot, refresh, download, pause, pauseAll, remove, select, verifyLocal, changeDirectory, modelById, hasDownloads: () => jobs.size > 0 };
}

module.exports = { createModelManager };
