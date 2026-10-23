const fs = require('node:fs');
const path = require('node:path');

function isLocalTag(tag) {
  if (typeof tag !== 'string' || tag.length > 240 || /cloud/i.test(tag)) return false;
  // 只允许明确的 Ollama 标签或 Hugging Face GGUF 标识，不接受任意 URL。
  return /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?:[a-z0-9][a-z0-9._-]*$/.test(tag)
    || /^hf\.co\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag);
}

// 目录只收录明确的本地权重标签，不接受任意地址或云端模型。
function validateCatalog(models) {
  if (!Array.isArray(models) || !models.length) throw new Error('本地模型目录为空或格式错误。');
  const ids = new Set(), tags = new Set();
  for (const model of models) {
    if (!model || typeof model !== 'object' || typeof model.id !== 'string' || !/^[a-z0-9-]{1,80}$/.test(model.id)) throw new Error('本地模型标识无效。');
    if (ids.has(model.id) || tags.has(model.ollamaTag)) throw new Error('本地模型目录包含重复标识或标签。');
    for (const field of ['name', 'params']) {
      if (typeof model[field] !== 'string' || !model[field].trim() || model[field].length > 100) throw new Error('本地模型名称或参数量无效。');
    }
    if (!isLocalTag(model.ollamaTag)) throw new Error('模型目录只能使用本地 Ollama 标签或明确的 Hugging Face GGUF 标识。');
    for (const field of ['family', 'description']) if (model[field] !== undefined && (typeof model[field] !== 'string' || !model[field].trim() || model[field].length > 300)) throw new Error('模型分类或说明无效。');
    if (model.reasoning !== undefined && typeof model.reasoning !== 'boolean') throw new Error('模型推理标记无效。');
    if (model.openness !== undefined && !['fully-open', 'open-weights'].includes(model.openness)) throw new Error('模型开放类型无效。');
    for (const field of ['recommendedVram', 'recommendedRam']) {
      if (typeof model[field] !== 'string' || !/^\d+(?:\.\d+)?GB$/.test(model[field]) || Number.parseFloat(model[field]) <= 0) throw new Error('模型推荐配置必须为正数 GB。');
    }
    if (typeof model.sizeGb !== 'number' || !Number.isFinite(model.sizeGb) || model.sizeGb <= 0) throw new Error('模型体积必须为正数。');
    ids.add(model.id); tags.add(model.ollamaTag);
  }
  return structuredClone(models);
}

function loadCatalog() {
  return validateCatalog(JSON.parse(fs.readFileSync(path.join(__dirname, '../../assets/models.json'), 'utf8')));
}

function assessHardware(model, hardware) {
  if (!hardware) return null;
  const reasons = [];
  const ram = Number.parseFloat(model.recommendedRam);
  const vram = Number.parseFloat(model.recommendedVram);
  // Windows 的系统保留内存会让标称容量略低；保留 4% 的比对余量。
  if (!Number.isFinite(hardware.ramGiB) || hardware.ramGiB <= 0 || hardware.ramGiB < ram * 0.96) reasons.push(`推荐内存 ${model.recommendedRam}`);
  // 驱动报告的专用显存也可能比标称值少几 MiB，允许 1% 报告余量。
  if (!Number.isFinite(hardware.vramGiB) || hardware.vramGiB < vram * 0.99) reasons.push(`推荐显存 ${model.recommendedVram}`);
  return { belowRecommended: reasons.length > 0, reasons, cpuFallback: hardware.cpuFallback === true };
}

module.exports = { loadCatalog, validateCatalog, assessHardware, isLocalTag };
