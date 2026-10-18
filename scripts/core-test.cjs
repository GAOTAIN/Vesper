// 无图形窗口的补充测试，重点验证网络解析、取消和模拟模板边界。
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: pause } = require('node:timers/promises');
const { simulate, makeSSE, online, humanError } = require('../main');
const checks = [];
const pass = name => { checks.push(name); console.log(`通过：${name}`); };
(async () => {
  let combined = '';
  const parser = makeSSE(text => { combined += text; });
  const input = ': 心跳\r\ndata: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"，Vesper"}}]}\n\ndata: [DONE]\n\n';
  for (const c of input) parser.push(c);
  assert.equal(combined, '你好，Vesper');
  parser.push('data: {"choices":[{"delta":{"content":"不应输出"}}]}\n\n', true);
  assert.equal(combined, '你好，Vesper');
  assert.throws(() => makeSSE(() => {}).push('data: invalid\n\n'), /无法解析/);
  let tail = ''; makeSSE(x => { tail += x; }).push('data: {"choices":[{"delta":{"content":"尾行"}}]}', true);
  assert.equal(tail, '尾行');
  pass('SSE 逐字符分包、CRLF、注释、尾行、[DONE] 与畸形 JSON');
  for (let i = 0; i < 100; i++) {
    const s = simulate([{ role: 'user', content: '你好' }]);
    assert(s.split('\n\n').length >= 2 && s.split('\n\n').length <= 5);
  }
  for (const intent of ['你好', '心情不好', '制定计划', '这是为什么', '翻译你好']) assert(simulate([{role:'user',content:intent}]).length > 20);
  assert(simulate([{role:'user',content:'python代码'}]).includes('```python'));
  assert(simulate([{role:'user',content:'javascript代码'}]).includes('```javascript'));
  assert(simulate([{role:'user',content:'比较两种方案'}]).includes('| 方案 |'));
  assert(simulate([{role:'user',content:'上轮关键词'}, {role:'assistant',content:'你好'}, {role:'user',content:'再说说'}]).includes('上轮关键词'));
  pass('模拟问候、提问、代码、翻译、闲聊、计划、表格、2–5 句随机模板与上下文');
  let closed = false, requestBody;
  const server = http.createServer(async (req,res) => {
    let body = ''; for await(const b of req) body += b; requestBody = JSON.parse(body);
    if (requestBody.model.startsWith('error')) {
      const code = Number(requestBody.model.slice(5)); res.writeHead(code, {'Content-Type':'application/json'});
      res.end(JSON.stringify({error:{message:code===429?'insufficient_quota':'test error'}})); return;
    }
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    res.on('close',()=>{closed=true;});
    if(requestBody.model === 'timeout') return;
    const chunks = requestBody.model === 'slow' ? Array(1000).fill('还在生成') : ['你好','，Vesper','！'];
    for(const text of chunks) {
      if(res.destroyed) return;
      const b=Buffer.from(`data: ${JSON.stringify({choices:[{delta:{content:text}}]})}\r\n\r\n`);
      for(let i=0;i<b.length;i+=7) res.write(b.subarray(i,i+7));
      await pause(requestBody.model==='slow'?30:3);
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const config={baseURL:`http://127.0.0.1:${server.address().port}/v1`,model:'mock',temperature:0.7,systemPrompt:'你是一个简洁友好的中文助手',apiKey:''};
  try {
    let reply=''; await online(config,[{role:'user',content:'你好'}],new AbortController(),t=>{reply+=t;});
    assert.equal(reply,'你好，Vesper！'); assert.equal(requestBody.stream,true); assert.equal(requestBody.messages[0].role,'system');
    await online(config,[],new AbortController(),()=>{},true); assert.equal(requestBody.max_tokens,8);
    pass('真实本机 HTTP 请求、UTF-8 字节分包、流式拼接、请求体与极短连接测试');
    closed=false;
    const controller=new AbortController(); let chars=0;
    await assert.rejects(()=>online({...config,model:'slow'},[],controller,t=>{chars+=t.length;controller.abort();}),e=>e.name==='AbortError');
    await pause(100); assert(chars>0); assert(closed);
    pass('AbortController 立即停止，服务端实际观察到断开');
    for(const [code,word] of [[401,'密钥无效'],[403,'拒绝访问'],[404,'模型不存在'],[429,'余额不足'],[500,'接口错误']]) await assert.rejects(()=>online({...config,model:`error${code}`},[],new AbortController(),()=>{}),e=>e.message.includes(word));
    assert(humanError(new Error('fetch failed')).includes('网络连接失败'));
    pass('密钥无效、权限、模型不存在、余额、服务器和网络故障中文错误');
    const timer=global.setTimeout;
    global.setTimeout=(fn,ms,...args)=>timer(fn,ms===60000?80:ms,...args);
    try { await assert.rejects(()=>online({...config,model:'timeout'},[],new AbortController(),()=>{}),/60 秒/); }
    finally {global.setTimeout=timer;}
    pass('60 秒超时和中断逻辑（加速时钟）');
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
  const icon=fs.readFileSync(path.join(__dirname,'../build/icon.ico'));
  assert.equal(icon.readUInt16LE(2),1); assert.equal(icon.readUInt16LE(4),6);
  for(let i=0;i<6;i++){ const n=6+i*16, size=icon[n]||256, offset=icon.readUInt32LE(n+12);assert.equal(icon.subarray(offset,offset+8).toString('hex'),'89504e470d0a1a0a');assert.equal(icon.readUInt32BE(offset+16),size); }
  pass('ICO 格式正确，含 16/32/48/64/128/256 像素 PNG');
  fs.mkdirSync(path.join(__dirname,'../work'),{recursive:true});
  fs.writeFileSync(path.join(__dirname,'../work/core-results.json'),JSON.stringify({time:new Date().toISOString(),checks,realProviderTested:false},null,2));
  console.log(`共 ${checks.length} 项核心检查通过。`);
})().catch(e=>{console.error(e);process.exitCode=1;});
