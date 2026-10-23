// 隔离窗口验证下载目录入口；系统目录对话框、注册表写入及 Ollama 进程使用受控替身。
const { app, ipcMain, dialog } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setTimeout: pause } = require('node:timers/promises');
const { startMockOllama } = require('./mock-ollama.cjs');
const serviceModule = require('../main/local/ollama-service.cjs');
const si = require('systeminformation');
si.mem = async () => ({ total: 64 * 1024 ** 3, available: 48 * 1024 ** 3 });
si.graphics = async () => ({controllers:[{model:'受控显卡',vram:24576}]});
const originalFactory = serviceModule.createOllamaService;
let live=false, child, mock, chosen=null, rejectWrite=false, win;
const launches=[],commands=[],results=[];
const previousEnvironment=process.env.OLLAMA_MODELS;
const testRoot=path.join(process.env.VESPER_TEST_DATA,'directory-fixtures');
const originalDirectory=path.join(testRoot,'原有模型');
fs.mkdirSync(originalDirectory,{recursive:true});fs.writeFileSync(path.join(originalDirectory,'保留模型.bin'),'原有权重不迁移');
process.env.OLLAMA_MODELS=originalDirectory;
serviceModule.createOllamaService = options => originalFactory({...options,
 client:{...options.client,json:async(...args)=>{if(!live)throw Error('无法连接本机 Ollama');return options.client.json(...args);}},
 findExecutable:()=> '受控-Ollama.exe', isPortBusy:async()=>false,
 launch:(executable,args,options)=>{
  launches.push({executable,args,options});live=true;mock.state.installed=new Set();
  child=new EventEmitter();Object.assign(child,{pid:987654,exitCode:null,signalCode:null,stdout:new EventEmitter(),stderr:new EventEmitter()});return child;
 },
 runFile:async(executable,args,options)=>{
  commands.push({executable,args,options});
  if(executable==='taskkill.exe'){assert.deepEqual(args,['/PID','987654','/T','/F']);live=false;child.exitCode=0;child.emit('exit',0);}
  else {assert.equal(executable,'powershell.exe');if(rejectWrite)throw Error('受控权限不足，下载目录未保存');}
  return {};
 }
});
const core=require('../main');
const js=script=>win.webContents.executeJavaScript(`(async()=>{${script}})()`);
const pass=name=>{results.push({name,passed:true});console.log('通过：'+name);};
async function until(fn,ms=15000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await pause(35);}throw Error('等待目录测试条件超时');}
async function ready(){ipcMain.removeAllListeners('theme:ready');win.webContents.setBackgroundThrottling(false);if(win.webContents.isLoading())await new Promise(resolve=>win.webContents.once('did-finish-load',resolve));await until(()=>js('return Boolean(data?.settings && document.querySelector(".chat-item"))'));}
async function choose(target){chosen=target;await js('document.getElementById("settingsChooseDirectory").click()');await until(()=>js('return !localPanel.operations.has("directory")'));}
(async()=>{
 mock=await startMockOllama();const http=require('node:http');const request=http.request;
 http.request=(options,callback)=>request.call(http,options.hostname==='127.0.0.1'&&options.port===11434?{...options,port:mock.port}:options,callback);
 let networkRequests=0;global.fetch=async()=>{networkRequests++;throw Error('测试禁止外网');};
 const dialogs=[];dialog.showOpenDialog=async(_owner,options)=>{dialogs.push(options);return chosen?{canceled:false,filePaths:[chosen]}:{canceled:true,filePaths:[]};};
 await core.bootstrap();win=core.getWindow();await ready();
 await js('document.getElementById("settingsOpen").click()');await until(()=>js('return !document.getElementById("settingsChooseDirectory").disabled'));
 assert.equal(await js('return document.getElementById("settingsModelDirectory").value'),originalDirectory);
 assert.equal(await js('return data.settings.mode'),'simulation');assert.equal(mock.state.requests.length,0);
 pass('设置直接显示默认下载位置，打开入口不切换模式、不启动服务或下载');
 await choose(null);assert.equal(commands.length,0);assert.equal(launches.length,0);
 assert.equal(await js('return document.getElementById("settingsModelDirectory").value'),originalDirectory);
 pass('取消文件夹选择后目录、服务和配置保持不变');
 const target=path.join(testRoot,'新下载位置 中文 & 空格');
 await choose(target);
 assert.equal(launches.at(-1).options.env.OLLAMA_MODELS,target);assert.equal(launches.at(-1).options.windowsHide,true);
 assert.equal(commands.find(item=>item.executable==='powershell.exe').options.env.VESPER_MODELS_TARGET,target);
 assert.equal(await js('return document.getElementById("settingsModelDirectory").value'),target);
 assert.match(await js('return document.getElementById("settingsDirectoryStatus").textContent'),/已生效/);
 assert.equal(await js('return data.settings.mode'),'simulation');
 const profile=app.getPath('userData');assert.equal(JSON.parse(fs.readFileSync(path.join(profile,'local-deployment.json'),'utf8')).modelDirectory,target);
 assert.equal(fs.readFileSync(path.join(originalDirectory,'保留模型.bin'),'utf8'),'原有权重不迁移');
 assert.deepEqual(dialogs.at(-1).properties,['openDirectory','createDirectory']);
 pass('中文和特殊字符目录经原生选择 IPC 保存，服务启动参数指向新位置，旧文件保持完整');
 mock.state.stallPull=true;
 const download=await js('return await window.vesper.local.download({id:"qwen25-3b"})');assert(download.ok);
 await until(()=>js('return localState.catalog[0].progress >= 50'));
 const target2=path.join(testRoot,'第二个下载位置');await choose(target2);
 assert.equal(launches.at(-1).options.env.OLLAMA_MODELS,target2);
 assert.equal(await js('return localState.catalog[0].status'),'available');
 assert.equal(await js('return localState.config.downloading_models.length'),0);
 assert(commands.some(item=>item.executable==='taskkill.exe'));
 await choose(target);
 assert.equal(await js('return localState.catalog[0].status'),'interrupted');
 assert((await js('return localState.catalog[0].progress'))>=50);
 pass('更改目录暂停当前下载，只重启持有的服务；切回原目录可恢复原下载记录');
 child.exitCode=0;child.emit('exit',0);live=true;
 await js('localPanel.accept((await window.vesper.local.refresh()).value)');
 const kills=commands.filter(item=>item.executable==='taskkill.exe').length;
 const externalTarget=path.join(testRoot,'外部服务的新位置');await choose(externalTarget);
 assert.equal(await js('return localState.config.pendingModelDirectory'),externalTarget);
 assert.equal(await js('return document.getElementById("settingsApplyDirectory").hidden'),false);
 assert.match(await js('return document.getElementById("settingsDirectoryStatus").textContent'),/待生效/);
 assert.equal(commands.filter(item=>item.executable==='taskkill.exe').length,kills);
 const pulls=mock.state.requests.filter(item=>item.route==='/api/pull').length;
 const blocked=await js('return await window.vesper.local.download({id:"qwen25-3b"})');assert.equal(blocked.ok,false);
 assert.equal(mock.state.requests.filter(item=>item.route==='/api/pull').length,pulls);
 pass('外部 Ollama 不被强杀，新目录显示待生效且阻止下载落入旧位置');
 live=false;await js('document.getElementById("settingsApplyDirectory").click()');
 await until(()=>js('return !localPanel.operations.has("directory") && !localState.config.pendingModelDirectory'));
 assert.equal(launches.at(-1).options.env.OLLAMA_MODELS,externalTarget);
 assert.equal(await js('return document.getElementById("settingsApplyDirectory").hidden'),true);
 assert.match(await js('return document.getElementById("settingsDirectoryStatus").textContent'),/已生效/);
 pass('外部服务退出后可在设置一键应用目录，受控新服务确实使用新下载位置');
 rejectWrite=true;await choose(path.join(testRoot,'权限失败目标'));rejectWrite=false;
 assert.equal(await js('return localState.config.modelDirectory'),externalTarget);
 assert.equal(await js('return document.getElementById("settingsModelDirectory").value'),externalTarget);
 assert.match(await js('return document.getElementById("toast").textContent'),/权限不足/);
 pass('环境变量写入失败时显示具体错误，保留原目录配置');
 await js('document.getElementById("language").value="en";document.getElementById("settingsForm").requestSubmit()');
 await until(()=>js('return document.documentElement.lang==="en" && document.getElementById("settingsOverlay").hidden'));
 await js('document.getElementById("settingsOpen").click()');
 assert.equal(await js('return document.querySelector("label[for=settingsModelDirectory]").textContent'),'Model download location');
 assert.equal(await js('return document.getElementById("settingsChooseDirectory").textContent'),'Change download location');
 win.setSize(820,560);await js('document.getElementById("settingsModelDirectory").scrollIntoView({block:"center"})');
 await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});await js('await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
 assert.equal(await js('const panel=document.getElementById("settingsPanel");return panel.scrollWidth <= panel.clientWidth'),true);
 fs.writeFileSync(path.join(__dirname,'../work/directory-settings.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
 child.exitCode=0;child.emit('exit',0);live=false;
 app.removeAllListeners('window-all-closed');win.close();await pause(120);core.initStorage();win=core.createWindow();await ready();
 await js('document.getElementById("settingsOpen").click()');await until(()=>js('return !document.getElementById("settingsChooseDirectory").disabled'));
 assert.equal(await js('return document.getElementById("settingsModelDirectory").value'),externalTarget);
 assert.equal(await js('return data.settings.mode'),'simulation');assert.equal(networkRequests,0);
 pass('中英文及最小窗口显示正确，关闭重建恢复下载目录且不改变聊天模式');
 await mock.close();fs.writeFileSync(path.join(__dirname,'../work/directory-results.json'),JSON.stringify({time:new Date().toISOString(),results,profile,nativeDialogMocked:true,environmentWritesMocked:true,ollamaProcessMocked:true,realWeightsDownloaded:false,externalRequests:networkRequests},null,2));
 console.log(`全部 ${results.length} 项下载位置检查通过。`);app.exit(0);
})().catch(async error=>{console.error(error.stack);fs.writeFileSync(path.join(__dirname,'../work/directory-results.json'),JSON.stringify({results,failed:error.stack},null,2));await mock?.close();app.exit(1);}).finally(()=>{if(previousEnvironment===undefined)delete process.env.OLLAMA_MODELS;else process.env.OLLAMA_MODELS=previousEnvironment;});
