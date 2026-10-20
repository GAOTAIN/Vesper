// 独立 Electron 窗口检查一键安装；下载与安装器受控替换，不改系统软件。
const {app,ipcMain}=require('electron');const fs=require('node:fs');const path=require('node:path');const http=require('node:http');const assert=require('node:assert/strict');const {createHash}=require('node:crypto');const {setTimeout:pause}=require('node:timers/promises');
let installed=false,installs=0,downloads=0,badSignature=false;
const installerModule=require('../main/local/ollama-installer.cjs');const createInstaller=installerModule.createOllamaInstaller;
const data=Buffer.from('安装器窗口受控文件');const asset={version:'v0.40.6',size:data.length,url:'https://github.com/ollama/ollama/releases/download/v0.40.6/OllamaSetup.exe',sha256:createHash('sha256').update(data).digest('hex')};
installerModule.createOllamaInstaller=options=>createInstaller({...options,findExecutable:()=>installed?'测试运行库.exe':null,getRelease:async()=>asset,disk:()=>{},
 download:async(a,file,signal,progress)=>{downloads++;for(const n of [10,35,60,90,100]){signal.throwIfAborted();progress(Math.floor(a.size*n/100),a.size);await pause(100,undefined,{signal})}fs.writeFileSync(file,data)},
 signature:async()=>{if(badSignature)throw Error('安装包数字签名无效，已拒绝运行。')},install:async()=>{installs++;await pause(200);installed=true}});
const serviceModule=require('../main/local/ollama-service.cjs');const createService=serviceModule.createOllamaService;
serviceModule.createOllamaService=options=>createService({...options,findExecutable:()=>installed?'测试运行库.exe':null,client:{...options.client,json:async(...args)=>{if(!installed)throw Error('无法连接本机 Ollama');return options.client.json(...args)}}});
const core=require('../main');const {startMockOllama}=require('./mock-ollama.cjs');const results=[];let win;const errors=[];
const js=s=>win.webContents.executeJavaScript(s);const pass=name=>{results.push({name,passed:true});console.log(`通过：${name}`)};
async function until(f,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(await f())return;await pause(35)}throw Error('安装窗口等待超时')}
(async()=>{
 const mock=await startMockOllama();const original=http.request;http.request=(options,cb)=>original.call(http,options.hostname==='127.0.0.1'&&options.port===11434?{...options,port:mock.port}:options,cb);
 await core.bootstrap();win=core.getWindow();ipcMain.removeAllListeners('theme:ready');win.webContents.setBackgroundThrottling(false);
 win.webContents.on('console-message',(_event,level,message)=>{if(level===3)errors.push(message)});
 if(win.webContents.isLoading())await new Promise(r=>win.webContents.once('did-finish-load',r));
 await until(()=>js('Boolean(window.vesper?.local && document.querySelector(".chat-item"))'));
 await js('localPanel.open();true');await until(()=>js('!localPanel.opening && localState?.hardware.status === "ready" && localState?.service.status === "missing"'));
 assert.equal(await js('document.getElementById("localInstall").textContent'),'本地安装 Ollama');assert.equal(downloads,0);assert.equal(await js('typeof window.vesper.local.installHelp'),'undefined');pass('未安装状态展示一键安装入口，打开面板不自动下载或跳转官网');
 await js('document.getElementById("localInstall").click();true');await until(()=>js('localState.installer.status === "downloading"'));
 assert.equal(await js('document.getElementById("localInstall").disabled'),true);assert.equal(await js('document.getElementById("localInstallCancel").hidden'),false);
 assert.equal(await js('document.getElementById("localChooseDirectory").disabled'),true);
 await js('document.getElementById("localInstallCancel").click();true');await until(()=>js('localState.installer.status === "cancelled" && !localPanel.operations.has("install")'));
 assert.equal(installs,0);assert.match(await js('document.getElementById("localInstallDetail").textContent'),/已取消/);pass('点击安装显示下载进度，禁用重复操作，取消按钮终止下载');
 badSignature=true;await js('document.getElementById("localInstall").click();true');await until(()=>js('localState.installer.status === "error" && !localPanel.operations.has("install")'));
 assert.equal(installs,0);assert.match(await js('document.getElementById("localInstallDetail").textContent'),/数字签名无效/);assert.equal(await js('document.getElementById("localInstall").textContent'),'重试本地安装');pass('校验失败在界面显示具体错误，阻止执行并可重试');
 badSignature=false;await js('document.getElementById("localInstall").click();true');await until(()=>js('localState.installer.status === "installing"'));
 assert.equal(await js('document.getElementById("localInstallCancel").hidden'),true);assert.equal(await js('document.getElementById("localInstallProgress").hasAttribute("value")'),false);
 await until(()=>js('localState.installer.status === "ready" && !localPanel.operations.has("install")'));
 assert.equal(installs,1);assert.equal(await js('localState.service.status'),'ready');assert.match(await js('document.getElementById("localInstallDetail").textContent'),/选择模型/);assert.equal(await js('document.getElementById("localInstall").textContent'),'Ollama 已就绪');assert.equal(mock.state.installed.size,0);pass('安装中使用不定进度，完成后自动连接并刷新模型列表，不擅自下载权重');
 const reused=await js('window.vesper.local.installRuntime()');assert.equal(reused.ok,true);assert.equal(installs,1);assert.equal(downloads,3);pass('已有运行库再次调用仅连接服务，不重新安装');
 await js('document.getElementById("localServiceTitle").scrollIntoView({block:"start"});true');
 await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
 await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
 fs.writeFileSync(path.join(__dirname,'../work/installer-window.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
 assert.equal(errors.length,0,errors.join('\n'));await mock.close();http.request=original;
 fs.writeFileSync(path.join(__dirname,'../work/installer-window-results.json'),JSON.stringify({time:new Date().toISOString(),results,realSystemSoftwareInstalled:false,realModelWeightsDownloaded:false},null,2));console.log(`全部 ${results.length} 项安装窗口检查通过。`);app.exit(0);
})().catch(error=>{console.error(error.stack);app.exit(1)});
