// 只获取公开清单和文件元数据，不下载模型权重。
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const models = require('../assets/models.json');
const results = [];
let next = 0;
async function verify(model) {
  if (model.ollamaTag.startsWith('hf.co/')) {
    const [repo, quant] = model.ollamaTag.slice(6).split(':');
    const response = await fetch('https://huggingface.co/api/models/' + repo + '?blobs=true', { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('HF HTTP ' + response.status);
    const info = await response.json();
    const file = info.siblings?.find(item => item.rfilename.toLowerCase().endsWith(quant.toLowerCase() + '.gguf'));
    if (!file || info.gated) throw new Error('GGUF 文件缺失或需要额外授权');
    return { bytes: file.size, source: 'https://huggingface.co/' + repo, file: file.rfilename };
  }
  const [name, tag] = model.ollamaTag.split(':');
  const source = 'https://registry.ollama.ai/v2/' + (name.includes('/') ? name : 'library/' + name) + '/manifests/' + tag;
  const response = await fetch(source, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('Ollama HTTP ' + response.status);
  const info = await response.json();
  return { bytes: info.layers.reduce((sum, layer) => sum + layer.size, 0), manifest: response.headers.get('docker-content-digest'), source };
}
(async () => {
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < models.length) {
      const index = next++, model = models[index];
      try {
        const detail = await verify(model);
        if (Math.abs(detail.bytes / 1e9 - model.sizeGb) > 0.001) throw new Error('上游模型体积发生变化，请重新核对目录');
        results[index] = { tag: model.ollamaTag, passed: true, ...detail };
      } catch (error) { results[index] = { tag: model.ollamaTag, passed: false, error: error.message }; }
    }
  }));
  fs.mkdirSync(path.join(root, 'work'), { recursive: true });
  fs.writeFileSync(path.join(root, 'work/catalog-source-results.json'), JSON.stringify({ time: new Date().toISOString(), weightsDownloaded: false, results }, null, 2));
  const failed = results.filter(item => !item.passed);
  console.log(JSON.stringify({ verified: results.length - failed.length, total: models.length, failed }));
  if (failed.length) process.exitCode = 1;
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
