// 只展示主进程给出的目录和检测结果，不访问文件、命令行或网络。
window.VesperLocalPanel = class {
  constructor({ api, call, setMode, onState, toast }) {
    Object.assign(this, { api, call, setMode, onState, toast });
    this.get = id => document.getElementById(id);
    this.state = null;
    this.opening = false;
    this.detecting = false;
    this.operations = new Set();
    this.query = ''; this.family = '';
    this.get('localModelSearch').oninput = event => { this.query = event.target.value.trim().toLowerCase(); this.filterModels(); };
    this.get('localModelFamily').onchange = event => { this.family = event.target.value; this.filterModels(); };
    this.get('localModelClear').onclick = () => { this.query = ''; this.family = ''; this.get('localModelSearch').value = ''; this.get('localModelFamily').value = ''; this.filterModels(); this.get('localModelSearch').focus(); };
    this.get('localClose').onclick = () => this.close();
    this.get('localOverlay').onclick = event => { if (event.target === this.get('localOverlay')) this.close(); };
    this.get('localDetect').onclick = () => this.detect(true);
    this.get('localConnect').onclick = () => this.operation('connect', () => this.api.connect());
    this.get('localRefresh').onclick = () => this.operation('refresh', () => this.api.refresh());
    this.get('localChooseDirectory').onclick = () => this.operation('directory', () => this.api.chooseDirectory());
    this.get('localApplyDirectory').onclick = () => this.operation('directory', () => this.api.applyDirectory());
    this.get('localInstall').onclick = () => this.operation('install', () => this.api.installRuntime());
    this.get('localInstallCancel').onclick = () => this.operation('cancel-install', () => this.api.cancelInstall());
    this.get('localRequirementsClose').onclick = () => this.get('localRequirements').close();
    this.unsubscribe = api.onStateChanged(value => this.accept(value));
    window.addEventListener('beforeunload', () => this.unsubscribe(), { once: true });
    document.addEventListener('keydown', event => this.keydown(event));
    document.addEventListener('pointerdown', event => { if (!this.get('localContextMenu').contains(event.target)) this.get('localContextMenu').hidden = true; });
  }

  get visible() { return !this.get('localOverlay').hidden; }

  accept(value) {
    if (this.state && value.revision < this.state.revision) return;
    this.state = value; this.render(); this.onState(value);
  }

  async load() {
    try { this.accept(await this.call(this.api.state())); }
    catch (error) { this.showError(error.message); }
  }

  async open() {
    if (this.opening) return;
    this.opening = true;
    this.previousFocus = document.activeElement;
    this.get('localOverlay').hidden = false;
    this.get('localOpen').setAttribute('aria-expanded', 'true');
    this.get('shell').inert = true;
    this.get('localPanel').focus();
    this.get('localPanelError').hidden = true;
    try {
      await this.setMode('local');
      await this.load();
      if (this.visible) this.operation('refresh', () => this.api.refresh());
      // 检测独立进行；关闭面板后也可立即重新打开，不被长探测锁住。
      if (this.visible && (!this.state?.hardware.result || this.state.hardware.status === 'error')) this.detect(false);
    } catch (error) { this.showError(error.message); }
    finally { this.opening = false; }
  }

  close() {
    this.get('localRequirements').close();
    this.get('localDecision').close();
    this.get('localContextMenu').hidden = true;
    this.get('localOverlay').hidden = true;
    this.get('localOpen').setAttribute('aria-expanded', 'false');
    this.get('shell').inert = false;
    if (this.previousFocus?.getClientRects().length) this.previousFocus.focus();
    else this.get('localOpen').focus();
  }

  showError(message) {
    this.get('localPanelError').textContent = message;
    this.get('localPanelError').hidden = false;
    if (!this.visible) this.toast(message);
  }

  async operation(key, task) {
    if (this.operations.has(key)) return;
    this.operations.add(key); this.get('localPanelError').hidden = true; this.render();
    try { this.accept(await this.call(task())); }
    catch (error) { this.showError(error.message); }
    finally { this.operations.delete(key); this.render(); }
  }

  decision(title, message, { danger = false, label = '确认' } = {}) {
    const dialog = this.get('localDecision');
    if (dialog.open) return Promise.resolve(false);
    this.get('localDecisionTitle').textContent = title;
    this.get('localDecisionText').textContent = message;
    this.get('localDecisionContinue').textContent = label;
    dialog.classList.toggle('local-danger-dialog', danger); dialog.returnValue = 'cancel';
    return new Promise(resolve => { dialog.addEventListener('close', () => resolve(dialog.returnValue === 'continue'), { once: true }); dialog.showModal(); dialog.querySelector('button[value="cancel"]').focus(); });
  }

  async download(id) {
    const key = `download:${id}`;
    if (this.operations.has(key)) return;
    this.operations.add(key); this.render();
    try {
      let result = await this.call(this.api.download({ id }));
      if (result.requiresConfirmation) {
        const proceed = await this.decision('硬件配置警告', `${result.warning}\n${result.reasons.join('；')}。${result.cpuFallback ? '显存未检出，将按 CPU 回退运行。' : ''}`, { danger: true, label: '强制继续' });
        if (!proceed) return;
        result = await this.call(this.api.download({ id, confirmationToken: result.confirmationToken }));
        if (result.requiresConfirmation) throw new Error('硬件或目录状态已变化，请重新点击下载并确认。');
      }
      await this.load();
    } catch (error) { this.showError(error.message); }
    finally { this.operations.delete(key); this.render(); }
  }

  async remove(id) {
    const model = this.state.catalog.find(item => item.id === id);
    if (!await this.decision('卸载本地模型？', `将卸载 ${model.name}，并停止该模型的下载或当前本地回复。其他模型仍使用的共享权重由 Ollama 管理。`)) return;
    return this.operation(`remove:${id}`, () => this.api.remove(id));
  }

  async detect(force) {
    if (this.detecting) return;
    this.detecting = true;
    this.get('localPanelError').hidden = true;
    this.get('localDetect').disabled = true;
    this.get('localHardwareStatus').textContent = '正在检测内存与显存，可能需要约 20 秒…';
    try { this.accept(await this.call(this.api.detectHardware({ force }))); }
    catch (error) { this.showError(error.message); }
    finally { this.detecting = false; this.get('localDetect').disabled = this.state?.hardware.status === 'detecting'; }
  }

  render() {
    if (!this.state) return;
    const hardware = this.state.hardware, result = hardware.result;
    const service = this.state.service;
    const statuses = { idle: '尚未检测', ready: '已连接', stopped: '未启动', missing: '未安装', starting: '启动中', error: '连接异常' };
    this.get('localServiceStatus').textContent = statuses[service.status] || '未知状态';
    this.get('localServiceStatus').classList.toggle('local', service.status === 'ready');
    this.get('localServiceDetail').textContent = service.error || (service.owner === 'external' ? '已复用外部 Ollama；模型目录未确认。聊天只允许具有本地权重的模型。' : service.owner === 'vesper' ? '服务由 Vesper 管理，已禁用 Ollama 云功能。' : '固定连接本机 127.0.0.1:11434，不使用云端 API。');
    const installer = this.state.installer;
    const installing = Boolean(installer?.busy || this.operations.has('install'));
    this.get('localInstall').disabled = installing || service.status === 'ready' || this.state.changingDirectory || this.operations.has('directory');
    this.get('localInstall').textContent = installing ? '正在部署运行库…' : service.status === 'ready' ? 'Ollama 已就绪' : installer?.status === 'error' ? '重试本地安装' : '本地安装 Ollama';
    this.get('localInstallProgressWrap').hidden = !installer || installer.status === 'idle';
    const installProgress = this.get('localInstallProgress');
    if (installer?.status === 'downloading') installProgress.value = installer.progress;
    else installProgress.removeAttribute('value');
    installProgress.hidden = !installer?.busy;
    const size = bytes => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
    this.get('localInstallDetail').textContent = installer ? (installer.error || installer.message) + (installer.status === 'downloading' ? ` ${installer.progress}% · ${size(installer.received)} / ${size(installer.total)}` : '') : '';
    this.get('localInstallDetail').classList.toggle('local-warning', installer?.status === 'error');
    this.get('localInstallCancel').hidden = !installer?.canCancel;
    this.get('localInstallCancel').disabled = this.operations.has('cancel-install');
    this.get('localConnect').disabled = installing || this.operations.has('connect') || service.status === 'starting' || Boolean(this.state.config.pendingModelDirectory);
    this.get('localConnect').textContent = this.operations.has('connect') || service.status === 'starting' ? '正在连接…' : '启动或重新连接';
    this.get('localRefresh').disabled = this.operations.has('refresh');
    this.get('localChooseDirectory').disabled = installing || this.operations.has('directory') || this.state.changingDirectory;
    this.get('localApplyDirectory').disabled = installing || this.operations.has('directory') || this.state.changingDirectory;
    const gib = value => Number.isFinite(value) ? `${value.toFixed(1)} GiB` : '未知';
    this.get('localDetect').disabled = hardware.status === 'detecting';
    this.get('localDetect').textContent = hardware.status === 'detecting' ? '检测中…' : '重新检测';
    this.get('localHardwareStatus').textContent = hardware.status === 'detecting' ? '正在检测内存与显存，可能需要约 20 秒…'
      : hardware.status === 'error' ? hardware.error : result ? '检测完成 · 以下容量采用 GiB，显存按最大单卡保守评估' : '尚未检测';
    this.get('localRam').textContent = result ? (result.ramGiB > 0 ? gib(result.ramGiB) : '未知') : '—';
    this.get('localAvailableRam').textContent = result ? gib(result.availableRamGiB) : '—';
    this.get('localVram').textContent = result ? (result.cpuFallback ? '0 GiB · CPU 评估' : gib(result.vramGiB)) : '—';
    this.get('localGpu').textContent = result?.gpuName || '';
    const warnings = this.get('localHardwareWarnings'); warnings.replaceChildren();
    for (const warning of result?.warnings || []) {
      const li = document.createElement('li'); li.textContent = warning;
      if (result.cpuFallback || result.ramGiB <= 0) li.className = 'local-warning';
      warnings.append(li);
    }
    const sources = { systeminformation: '系统信息库', 'node:os': '系统备用接口', 'nvidia-smi': 'NVIDIA 命令', 'absolute-path': 'NVIDIA 绝对路径', 'cpu-fallback': 'CPU 保守回退', unknown: '未知', memory: '内存主接口', 'memory-fallback': '内存备用接口', graphics: '显卡主接口' };
    this.get('localHardwareSource').textContent = result ? `内存：${sources[result.ramSource]}；显存：${sources[result.vramSource]}` : '尚无检测数据';
    const diagnostics = this.get('localHardwareDiagnostics'); diagnostics.replaceChildren();
    for (const item of result?.diagnostics || []) {
      const li = document.createElement('li'); li.textContent = `${sources[item.stage] || item.stage}：${item.message}`; diagnostics.append(li);
    }
    this.get('localDirectory').textContent = service.activeDirectory || (service.owner === 'external' ? '外部服务的实际目录未确认' : this.state.config.modelDirectory || '默认 Ollama 模型目录（启动后确认）');
    const pending = this.state.config.pendingModelDirectory;
    this.get('localDirectoryPending').hidden = !pending;
    this.get('localDirectoryPending').textContent = pending ? `待生效：${pending}。请退出外部 Ollama 后应用。` : '';
    this.get('localApplyDirectory').hidden = !pending;
    const families = [...new Set(this.state.catalog.map(model => model.family || '其他'))];
    const familySelect = this.get('localModelFamily');
    if (familySelect.options.length !== families.length + 1) {
      familySelect.replaceChildren(new Option('全部系列', ''), ...families.map(family => new Option(family, family)));
      familySelect.value = this.family;
    }
    const list = this.get('localModels');
    for (const model of this.state.catalog) {
      let card = [...list.children].find(item => item.dataset.modelId === model.id);
      if (!card) { card = this.modelCard(model); list.append(card); }
      this.updateCard(card, model);
    }
    this.filterModels();
    if (this.state.lastError) this.showError(this.state.lastError);
  }

  filterModels() {
    if (!this.state) return;
    let visible = 0;
    const selected = this.family || this.query;
    const cards = new Map([...this.get('localModels').children].map(card => [card.dataset.modelId, card]));
    for (const model of this.state.catalog) {
      const family = model.family || '其他';
      const matches = (!this.family || family === this.family) && (!this.query || `${model.name} ${model.ollamaTag} ${family} ${model.description || ''}`.toLowerCase().includes(this.query));
      if (cards.has(model.id)) cards.get(model.id).hidden = !matches;
      if (matches) visible++;
    }
    this.get('localModelCount').textContent = selected ? `${visible} / ${this.state.catalog.length} 款本地模型` : `${this.state.catalog.length} 款本地模型`;
    this.get('localModelEmpty').hidden = visible > 0;
    this.get('localModelClear').hidden = !selected;
  }

  modelCard(model) {
    const card = document.createElement('article'); card.className = 'local-model-card'; card.dataset.modelId = model.id;
    // 固定结构中的所有模型内容均通过 textContent 写入。
    card.innerHTML = '<div class="local-section-heading"><h4></h4><span class="local-help local-model-size"></span></div><code class="local-model-tag"></code><p class="local-model-spec"></p><p class="local-model-assessment"></p><div class="local-progress-wrap" hidden><progress class="model-progress" max="100" value="0" aria-label="模型下载进度"></progress><p class="local-help model-progress-text" role="status"></p></div><p class="model-error local-warning" hidden></p><div class="local-model-actions"><button class="quiet-btn local-requirements-button">查看配置</button><div><button class="quiet-btn model-remove" hidden>卸载</button><button class="primary-button model-download">下载部署</button></div></div>';
    card.querySelector('h4').textContent = model.name;
    card.querySelector('.local-model-size').textContent = `约 ${model.sizeGb.toFixed(1)} GB · ${model.params}`;
    card.querySelector('.local-model-tag').textContent = model.ollamaTag;
    card.querySelector('.local-model-spec').textContent = `推荐显存 ${model.recommendedVram} · 内存 ${model.recommendedRam}`;
    const description = document.createElement('p'); description.className = 'local-model-description local-help';
    description.textContent = `${model.family || '其他'} · ${model.openness === 'fully-open' ? '训练过程开放' : '开放权重'}${model.description ? ' · ' + model.description : ''}`;
    card.querySelector('.local-model-spec').after(description);
    card.querySelector('.local-requirements-button').onclick = () => this.requirements(model);
    card.querySelector('.model-remove').onclick = () => this.remove(model.id);
    card.querySelector('.model-download').onclick = () => {
      const current = this.state.catalog.find(item => item.id === model.id);
      if (current.status === 'downloading') this.operation(`pause:${model.id}`, () => this.api.pause(model.id));
      else if (current.installed) this.operation(`select:${model.id}`, () => this.api.selectModel(model.id));
      else this.download(model.id);
    };
    card.oncontextmenu = event => {
      if (!this.state.catalog.find(item => item.id === model.id)?.installed) return;
      event.preventDefault();
      const menu = this.get('localContextMenu'); menu.hidden = false;
      const rect = card.getBoundingClientRect();
      menu.style.left = `${Math.max(0, Math.min(event.clientX || rect.left, innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${Math.max(0, Math.min(event.clientY || rect.top, innerHeight - menu.offsetHeight - 8))}px`;
      this.get('localContextRequirements').onclick = () => { menu.hidden = true; this.requirements(model); };
      this.get('localContextRequirements').focus();
    };
    return card;
  }

  updateCard(card, model) {
    card.tabIndex = model.installed ? 0 : -1;
    const assessment = card.querySelector('.local-model-assessment');
    assessment.textContent = !model.assessment ? '检测硬件后显示推荐配置评估。' : model.assessment.belowRecommended ? '硬件配置低于推荐要求，可能卡顿或崩溃。' : '总容量达到目录推荐值；实际运行还受可用资源与驱动影响。';
    assessment.classList.toggle('local-warning', model.assessment?.belowRecommended === true);
    const button = card.querySelector('.model-download');
    const selected = this.state.config.selectedModelId === model.id;
    button.textContent = model.status === 'downloading' ? '暂停下载' : model.status === 'deleting' ? '正在卸载…' : model.installed ? (selected ? '当前模型' : '用于聊天') : model.status === 'interrupted' ? '继续下载' : '下载部署';
    button.disabled = this.state.installer?.busy || ['download', 'pause', 'select', 'remove'].some(key => this.operations.has(`${key}:${model.id}`)) || model.status === 'deleting' || this.state.changingDirectory || Boolean(this.state.config.pendingModelDirectory) || (model.installed && selected);
    const remove = card.querySelector('.model-remove');
    remove.hidden = !model.installed; remove.disabled = model.status === 'deleting' || this.operations.has(`remove:${model.id}`);
    const progress = card.querySelector('.model-progress'); progress.value = model.progress;
    card.querySelector('.local-progress-wrap').hidden = !['downloading', 'interrupted'].includes(model.status);
    card.querySelector('.model-progress-text').textContent = `${model.progress}% · ${model.stage || '等待下载'}${model.status === 'interrupted' ? '；续传时复用 Ollama 缓存' : ''}`;
    const error = card.querySelector('.model-error'); error.hidden = !model.error; error.textContent = model.error;
  }

  requirements(model) {
    this.get('localRequirementsTitle').textContent = `${model.name} · 配置需求`;
    this.get('localRequirementsText').textContent = `模型体积约 ${model.sizeGb} GB，参数量 ${model.params}。推荐显存 ${model.recommendedVram}、内存 ${model.recommendedRam}，按 4096 上下文评估。推荐配置为本项目估算，显存不足时可能转为较慢的 CPU 运行。${model.description ? ' ' + model.description : ''}`;
    this.get('localRequirements').showModal(); this.get('localRequirementsClose').focus();
  }

  keydown(event) {
    if (!this.visible || this.get('localRequirements').open || this.get('localDecision').open) return;
    if (!this.get('localContextMenu').hidden && event.key === 'Escape') { event.preventDefault(); this.get('localContextMenu').hidden = true; this.get('localPanel').focus(); return; }
    if (event.key === 'Escape') { event.preventDefault(); this.close(); return; }
    if (event.key !== 'Tab') return;
    const nodes = [...this.get('localPanel').querySelectorAll('button,[href],input,select,textarea,summary,[tabindex="0"]')]
      .filter(node => !node.disabled && node.getClientRects().length && !node.closest('details:not([open]) > :not(summary)'));
    const first = nodes[0], last = nodes.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === this.get('localPanel'))) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === this.get('localPanel'))) { event.preventDefault(); first?.focus(); }
  }
};
