const http = require('node:http');

const ORIGIN = 'http://127.0.0.1:11434';
const routes = new Set(['/api/tags', '/api/version', '/api/show', '/api/pull', '/api/delete', '/api/chat']);
function aborted() { const error = new Error('请求已停止。'); error.name = 'AbortError'; return error; }
function localError(error) {
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return error;
  const raw = String(error.message || error);
  if (/^(?:Ollama 返回错误：|内存或显存不足|模型存储磁盘空间不足|无法连接本机 Ollama)/.test(raw)) return error;
  let message;
  if (/ECONNREFUSED|ECONNRESET|socket hang up/i.test(raw)) message = '无法连接本机 Ollama，服务可能尚未启动或已退出。';
  else if (/memory|out of memory|cuda.*alloc|VRAM/i.test(raw)) message = '内存或显存不足，请关闭占用资源的程序，或选择更小的模型。';
  else if (/no space|disk.*full|ENOSPC|insufficient.*(?:space|storage)/i.test(raw)) message = '模型存储磁盘空间不足，请清理空间或更换目录。';
  else if (/not found|does not exist/i.test(raw)) message = '模型不存在，请先下载部署所选模型。';
  else message = `Ollama 返回错误：${raw.slice(0, 300)}`;
  const result = new Error(message); result.code = error.code; return result;
}

// 保留未完成的行；TextDecoder 负责跨字节中文，不把网络数据当代码执行。
function makeNDJSON(onPacket) {
  let buffer = '';
  return {
    push(text, final = false) {
      buffer += text;
      let index;
      const parse = line => {
        if (!line.trim()) return;
        let value;
        try { value = JSON.parse(line); } catch { throw new Error('本机服务返回了无效的 NDJSON 数据。'); }
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('本机服务返回的数据格式不正确。');
        if (value.error) throw localError(new Error(typeof value.error === 'string' ? value.error : value.error.message || '未知错误'));
        onPacket(value);
      };
      while ((index = buffer.indexOf('\n')) >= 0) {
        if (index > 1024 * 1024) throw new Error('本机服务返回的数据行过大。');
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); parse(line);
      }
      if (buffer.length > 1024 * 1024) throw new Error('本机服务返回的数据行过大。');
      if (final) { parse(buffer); buffer = ''; }
    }
  };
}

function createOllamaClient({ origin = ORIGIN } = {}) {
  const address = new URL(origin);
  if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || address.username || address.password || address.pathname !== '/' || address.search || address.hash) throw new Error('本地服务只允许 IPv4 回环地址。');
  async function request(route, { method = 'GET', body, signal, onPacket, headerTimeout = 5000, idleTimeout = 120000 } = {}) {
    if (!routes.has(route)) throw new Error('本地接口不在允许列表中。');
    if (signal?.aborted) throw aborted();
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    let req, response, timer, timeoutError;
    const stop = () => req?.destroy(aborted());
    const timedOut = () => {
      timeoutError = new Error('本机 Ollama 响应超时，请检查服务、模型加载和可用内存。');
      timeoutError.name = 'TimeoutError'; req.destroy(timeoutError);
    };
    try {
      response = await new Promise((resolve, reject) => {
        // 原生 HTTP 固定直连回环地址，不读取在线设置或代理凭据，也不跟随重定向。
        req = http.request({ hostname: '127.0.0.1', port: Number(address.port) || 80, path: route, method,
          headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}, agent: false }, resolve);
        req.on('error', reject);
        timer = setTimeout(timedOut, headerTimeout);
        req.setTimeout(idleTimeout, timedOut);
        signal?.addEventListener('abort', stop, { once: true });
        if (signal?.aborted) stop(); else req.end(payload);
      });
      clearTimeout(timer);
      const parser = onPacket && response.statusCode >= 200 && response.statusCode < 300 ? makeNDJSON(onPacket) : null;
      const decoder = new TextDecoder();
      let result = '', bytes = 0;
      for await (const chunk of response) {
        if (signal?.aborted) throw aborted();
        if (parser) parser.push(decoder.decode(chunk, { stream: true }));
        else {
          bytes += chunk.length;
          if (bytes > 4 * 1024 * 1024) throw new Error('本机服务响应过大。');
          result += decoder.decode(chunk, { stream: true });
        }
      }
      if (signal?.aborted) throw aborted();
      if (parser) { parser.push(decoder.decode(), true); return; }
      result += decoder.decode();
      let parsed;
      try { parsed = result.trim() ? JSON.parse(result) : {}; } catch { throw new Error('11434 端口没有返回有效的 Ollama JSON，请检查端口占用。'); }
      if (response.statusCode < 200 || response.statusCode >= 300 || parsed.error) throw localError(new Error(typeof parsed.error === 'string' ? parsed.error : parsed.error?.message || `接口状态 ${response.statusCode}`));
      return parsed;
    } catch (error) {
      if (signal?.aborted) throw aborted();
      if (timeoutError) throw timeoutError;
      throw localError(error);
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', stop);
      response?.destroy(); req?.destroy();
    }
  }
  return { request, json: request, stream: (route, body, onPacket, options) => request(route, { ...options, body, onPacket, method: 'POST' }) };
}

module.exports = { createOllamaClient, makeNDJSON, localError, aborted, ORIGIN };
