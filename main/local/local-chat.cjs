const { waitFor } = require('./ollama-service.cjs');

function boundMessages(messages, systemPrompt = '') {
  const usable = messages.filter(message => ['user', 'assistant'].includes(message.role) && typeof message.content === 'string' && message.content && !message.error);
  const current = usable.at(-1);
  if (!current || current.role !== 'user') throw new Error('本地聊天缺少当前用户消息。');
  if (Buffer.byteLength(current.content) > 6000) throw new Error('本地模式的单条输入过长，请缩短到约 2000 个汉字以内。');
  if (Buffer.byteLength(systemPrompt) > 3000) throw new Error('本地模式的系统提示词过长，请缩短到约 1000 个汉字以内。');
  const pairs = []; let user = null;
  for (const message of usable.slice(0, -1)) {
    if (message.role === 'user') user = message;
    else if (user && (!message.status || message.status === 'done')) { pairs.push([user, message]); user = null; }
  }
  const recent = pairs.slice(-10);
  const serialize = () => [...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []), ...recent.flat(), current].map(({ role, content }) => ({ role, content }));
  let result = serialize();
  while (recent.length && result.reduce((sum, message) => sum + Buffer.byteLength(message.content) + 32, 0) > 10000) { recent.shift(); result = serialize(); }
  return result;
}

function createLocalChat({ service, manager, detector, client }) {
  return async function chat(config, messages, controller, onDelta) {
    const model = manager.modelById(config.localModelId);
    const bounded = boundMessages(messages, config.systemPrompt);
    await service.ensure({ signal: controller.signal });
    await manager.verifyLocal(model.ollamaTag, controller.signal);
    const hardware = await waitFor(detector.detect(), controller.signal);
    if (controller.signal.aborted) { const error = new Error('请求已停止。'); error.name = 'AbortError'; throw error; }
    let done = false, received = false;
    await client.stream('/api/chat', {
      model: model.ollamaTag, messages: bounded, stream: true, keep_alive: '2m',
      options: { num_ctx: 4096, num_predict: 1024, temperature: config.temperature, ...(hardware.cpuFallback ? { num_gpu: 0 } : {}) }
    }, packet => {
      if (packet.remote_host || packet.remote_model) throw new Error('服务返回了远程模型响应，本地模式已中止。');
      if (typeof packet.message?.content === 'string' && packet.message.content) { received = true; onDelta(packet.message.content); }
      if (packet.done === true) done = true;
    }, { signal: controller.signal, headerTimeout: 180000, idleTimeout: 180000 });
    if (!done) throw new Error('本地回复意外中断，未收到结束标记。');
    if (!received) throw new Error('本地模型返回空回复，请重新尝试或切换模型。');
  };
}

module.exports = { boundMessages, createLocalChat };
