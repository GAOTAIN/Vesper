// 可选的真实网络检查：只读取约 1 MiB，不安装运行库或下载模型。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { latestRelease, downloadAsset, verifySignature } = require('../main/local/ollama-installer.cjs');
(async () => {
 const root = path.join(__dirname, '../work'); fs.mkdirSync(root, {recursive:true});
 const controller = new AbortController(); const asset = await latestRelease(controller.signal);
 const file = path.join(root, 'official-download-probe.part.exe'); let received=0;
 try { await downloadAsset(asset, file, controller.signal, n => {received=n;if(n>=1024*1024)controller.abort();}); }
 catch(error) {if(!controller.signal.aborted)throw error;}
 finally {try{fs.unlinkSync(file);}catch{}}
 assert(received>=1024*1024);
 const signedControl=path.join(process.env.SystemRoot, 'System32', 'cmd.exe'); await verifySignature(signedControl);
 const report={time:new Date().toISOString(),asset,officialBytesReceived:received,officialDownloadReachable:true,windowsSignatureVerifierTestedWith:signedControl,officialInstallerFullyDownloaded:false,officialInstallerExecuted:false};
 fs.writeFileSync(path.join(root,'installer-network-results.json'), JSON.stringify(report,null,2));
 console.log('官方元数据、真实安装包下载链路、取消和 Windows 签名验证器检查通过；未执行官方安装器。');
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
