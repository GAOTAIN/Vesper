// 使用受控下载和安装器验证真实业务状态机，不安装系统软件或改注册表。
const assert=require('node:assert/strict');
const fs=require('node:fs'); const path=require('node:path');
const {createHash}=require('node:crypto'); const {Readable}=require('node:stream');
const {setTimeout:pause}=require('node:timers/promises');
const {createOllamaInstaller,releaseAsset,trustedURL,downloadAsset,verifyHash,verifySignature,installPackage}=require('../main/local/ollama-installer.cjs');
const root=path.join(__dirname,'../work'); fs.mkdirSync(root,{recursive:true});
const folder=fs.mkdtempSync(path.join(root,'installer-unit-'));
const data=Buffer.from('受控测试安装包');const digest=createHash('sha256').update(data).digest('hex');
const metadata={tag_name:'v0.40.6',assets:[{name:'OllamaSetup.exe',size:data.length,digest:`sha256:${digest}`,browser_download_url:'https://github.com/ollama/ollama/releases/download/v0.40.6/OllamaSetup.exe'}]};
const asset=releaseAsset(metadata);const results=[];
const pass=name=>{results.push({name,passed:true});console.log(`通过：${name}`)};
let serial=0;
function fixture(overrides={}) {
 let installed=false; let status='stopped'; let installer;
 const calls=[],states=[];
 const service={inspect:async()=>{},snapshot:()=>({status}),ensure:async()=>{calls.push('connect');status='ready'}};
 const options={cacheDir:path.join(folder,`${++serial}`),platform:'win32',service,
  onInstalled:async()=>calls.push('refresh'),emit:()=>{if(installer)states.push(installer.snapshot())},findExecutable:()=>installed?'测试运行库.exe':null,
  getRelease:async()=>{calls.push('release');return asset},disk:()=>{},
  download:async(a,file,signal,progress)=>{calls.push('download');fs.writeFileSync(file,data);progress(data.length,data.length)},hash:verifyHash,
  signature:async()=>calls.push('signature'),install:async()=>{calls.push('install');installed=true},...overrides};
 installer=createOllamaInstaller(options);
 return {installer,states,calls,setInstalled:()=>{installed=true},options};
}
(async()=>{
 assert.equal(asset.sha256,digest);
 for(const bad of [{...metadata,prerelease:true},{...metadata,assets:[]},{...metadata,assets:[{...metadata.assets[0],digest:null}]},{...metadata,assets:[{...metadata.assets[0],browser_download_url:'https://example.com/setup.exe'}]}])assert.throws(()=>releaseAsset(bad));
 for(const url of ['http://github.com/ollama/ollama','https://github.com.evil.test/x','https://user:pass@github.com/x','https://github.com:444/x','file:///C:/test.exe'])assert.throws(()=>trustedURL(url));
 assert.equal(trustedURL('https://release-assets.githubusercontent.com/a').protocol,'https:');
 pass('官方稳定发布、资产大小、SHA-256 和 HTTPS 主机白名单校验');
 let f=fixture(); await f.installer.start();assert.deepEqual(f.calls,['release','download','signature','install','connect','refresh']);
 assert.equal(f.installer.snapshot().status,'ready');assert(!fs.existsSync(path.join(f.options.cacheDir,'OllamaSetup.exe')));
 assert(f.states.some(s=>s.status==='installing'&&!s.canCancel));
 pass('下载、真实哈希校验、签名校验、安装、自动连接与清理完整链路');
 let releaseResolve;f=fixture({getRelease:()=>new Promise(resolve=>{releaseResolve=resolve})});
 const first=f.installer.start();const second=f.installer.start();assert.equal(first,second);await pause(0);releaseResolve(asset);await first;
 assert.equal(f.calls.filter(x=>x==='install').length,1);pass('连续点击共用单个安装任务，不重复下载安装');
 f=fixture({findExecutable:()=> '已有.exe'});await f.installer.start();assert.deepEqual(f.calls,['connect','refresh']);
 f=fixture({service:{inspect:async()=>{},snapshot:()=>({status:'ready'}),ensure:async()=>{}}});await f.installer.start();assert.deepEqual(f.calls,['refresh']);
 pass('已安装运行库或已有本机服务时跳过下载，直接复用');
 f=fixture({download:async(a,file)=>fs.writeFileSync(file,'被篡改')});await assert.rejects(()=>f.installer.start(),/SHA-256/);assert(!f.calls.includes('install'));assert.equal(f.installer.snapshot().status,'error');
 assert(!fs.existsSync(path.join(f.options.cacheDir,'OllamaSetup.part.exe')));pass('哈希不符时阻止执行，失败状态可见且清理临时包');
 f=fixture({signature:async()=>{throw Error('签名无效')}});await assert.rejects(()=>f.installer.start(),/签名无效/);assert(!f.calls.includes('install'));pass('数字签名失败时绝不运行安装器');
 let began; const started=new Promise(r=>began=r);
 f=fixture({download:async(a,file,signal)=>{fs.writeFileSync(file,'一部分');began();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))}});
 const download=f.installer.start();await started;f.installer.cancel();await download;assert.equal(f.installer.snapshot().status,'cancelled');assert(!f.calls.includes('install'));assert(!fs.existsSync(path.join(f.options.cacheDir,'OllamaSetup.part.exe')));
 pass('取消下载关闭当前任务并清理临时文件，不执行安装');
 let attempts=0;f=fixture({getRelease:async()=>{if(++attempts===1)throw Object.assign(Error('断网'),{code:'ENOTFOUND'});return asset}});
 await assert.rejects(()=>f.installer.start(),/检查网络/);await f.installer.start();assert.equal(f.installer.snapshot().status,'ready');pass('断网错误为中文，失败后重试可完成安装');
 f=fixture({disk:()=>{throw Error('磁盘空间不足')}});await assert.rejects(()=>f.installer.start(),/磁盘/);assert(!f.calls.includes('download'));pass('磁盘容量不足在下载前拦截');
 f=fixture({install:async()=>{throw Object.assign(Error('失败'),{code:2})}});await assert.rejects(()=>f.installer.start(),/退出码 2/);assert(!f.calls.includes('connect'));pass('安装器退出失败不会伪报成功或继续连接');
 let releaseInstall,entered;const entering=new Promise(r=>entered=r);
 f=fixture({install:async()=>{entered();await new Promise(r=>releaseInstall=r);f.setInstalled()}});const installing=f.installer.start();await entering;assert.equal(f.installer.snapshot().canCancel,false);f.installer.cancel();let ended=false;const shutdown=f.installer.shutdown().then(()=>ended=true);await pause(10);assert(!ended);releaseInstall();await Promise.all([installing,shutdown]);assert.equal(f.installer.snapshot().status,'ready');pass('安装阶段不能取消，关闭等待安装结束而不强杀进程');
 const sample=path.join(folder,'流式包.part.exe');const stream=()=>{const r=Readable.from([data.subarray(0,5),data.subarray(5)]);r.headers={'content-length':String(data.length)};return r};
 let transferred=0;await downloadAsset(asset,sample,new AbortController().signal,n=>transferred=n,async()=>stream());assert.deepEqual(fs.readFileSync(sample),data);assert.equal(transferred,data.length);await verifyHash(sample,digest,new AbortController().signal);
 const wrong=stream();wrong.headers['content-length']='1';await assert.rejects(()=>downloadAsset(asset,sample,new AbortController().signal,()=>{},async()=>wrong),/长度/);
 pass('流式写入不丢字节，检查声明大小并逐块计算真实哈希');
 let signatureOptions;await verifySignature(sample,async(exe,args,options)=>{assert.equal(exe,'powershell.exe');assert(!args.join(' ').includes(sample));signatureOptions=options;return{stdout:'Valid\r\n'}});
 assert.equal(signatureOptions.windowsHide,true);assert.equal(signatureOptions.env.VESPER_INSTALLER_FILE,sample);
 await assert.rejects(()=>verifySignature(sample,async()=>({stdout:'HashMismatch'})),/数字签名无效/);
 let installOptions;await installPackage(sample,async(exe,args,options)=>{assert.equal(exe,sample);assert(args.includes('/VERYSILENT'));assert(args.includes('/NORESTART'));assert(!args.includes('/FORCECLOSEAPPLICATIONS'));installOptions=options});assert.equal(installOptions.windowsHide,true);assert.equal(installOptions.env.OLLAMA_NO_CLOUD,'1');
 pass('签名验证路径通过环境变量传递，静默安装无 shell 拼接、禁用云功能和自动重启');
 fs.writeFileSync(path.join(root,'installer-unit-results.json'),JSON.stringify({time:new Date().toISOString(),results,realSystemSoftwareInstalled:false},null,2));
 console.log(`全部 ${results.length} 项安装检查通过。`);
})().catch(error=>{console.error(error.stack);process.exitCode=1});
