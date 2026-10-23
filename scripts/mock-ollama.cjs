const http = require('node:http');
const { setTimeout: pause } = require('node:timers/promises');

// 只用于自检，监听随机回环端口；不提供真实推理、不下载任何权重。
async function startMockOllama() {
  const state = { installed: new Set(), requests: [], stallPull: false, failPull: false, remote: false, lastChat: null, chatCloses: 0 };
  const server = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      state.requests.push({ route: req.url, method: req.method, body, authorization: req.headers.authorization });
      const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
      if (req.url === '/api/tags') {
        if (state.stallTags) return;
        return json({ models: [...state.installed].map(name => ({ name, model: name, size: 12345, details: { parameter_size: '3B' } })) });
      }
      if (req.url === '/api/show') return json(state.remote ? { remote_host: 'https://ollama.com', remote_model: 'test-cloud', model_info: {} } : { model_info: { 'general.architecture': 'qwen2', 'general.parameter_count': 3000000000 } });
      if (req.url === '/api/delete') { state.installed.delete(body.model); return json({}); }
      if (req.url === '/api/pull') {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        let closed = false; res.on('close', () => { closed = true; });
        const write = value => res.write(`${JSON.stringify(value)}\r\n`);
        if (state.failPull) return res.end(JSON.stringify({ error: '磁盘读写失败' }));
        write({ status: 'pulling manifest' });
        for (const completed of [0, 500000000, 1000000000, 2000000000]) {
          if (closed) return;
          write({ status: 'pulling sha256:test', digest: 'sha256:test', total: 2000000000, completed }); await pause(45);
          if (state.stallPull && completed >= 1000000000) { while (!closed) await pause(20); return; }
        }
        if (closed) return;
        write({ status: 'verifying sha256 digest' }); state.installed.add(body.model);
        res.end(JSON.stringify({ status: 'success' })); return;
      }
      if (req.url === '/api/chat') {
        state.lastChat = body;
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        let closed = false;
        res.on('close', () => { closed = true; state.chatCloses++; });
        if (body.model?.startsWith('deepseek-r1:')) {
          res.write(`${JSON.stringify({ message: { role: 'assistant', thinking: '受控测试思考片段', content: '' }, done: false })}\n`);
          if (state.thinkingOnly) { res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'length' })); return; }
        }
        const text = body.messages.at(-1)?.content.includes('停止') ? '这是本地停止测试。'.repeat(300) : '你好，这是本机接口测试。\n\n```javascript\nconst local = true;\n```\n\n|方式|状态|\n|---|---|\n|本机|正常|';
        for (const char of text) {
          if (closed) return;
          const packet = Buffer.from(`${JSON.stringify({ message: { role: 'assistant', content: char }, done: false })}\n`);
          for (let i = 0; i < packet.length; i += 7) res.write(packet.subarray(i, i + 7));
          await pause(text.length > 1000 ? 15 : 1);
        }
        if (!closed) res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }));
        return;
      }
      res.statusCode = 404; json({ error: 'not found' });
    } catch (error) { if (!res.destroyed) res.destroy(error); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { state, origin: `http://127.0.0.1:${server.address().port}`, port: server.address().port,
    close: () => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); } };
}
module.exports = { startMockOllama };
