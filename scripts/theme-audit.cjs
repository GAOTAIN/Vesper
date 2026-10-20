// 静态审计仅检查项目自有源码；依赖、构建产物、文档色表和测试数据不参与。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const files = ['main.js', 'preload.js', 'package.json', 'package-lock.json', 'assets/icon.svg'];
function walk(dir) { for(const item of fs.readdirSync(path.join(root,dir),{withFileTypes:true})) { const name=dir+'/'+item.name; if(item.isDirectory()) walk(name); else if(/\.(?:css|js|html|cjs)$/.test(name)) files.push(name); } }
walk('renderer'); walk('scripts'); walk('main');
const css = fs.readFileSync(path.join(root,'renderer/styles.css'),'utf8');
const blocks = [...css.matchAll(/(?:^:root|^\[data-theme="dark"\])\s*\{([^}]+)\}/gm)];
assert.equal(blocks.length,2);
const parse = block => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(m=>[m[1],m[2].trim()]));
const light = parse(blocks[0][1]), dark = {...light,...parse(blocks[1][1])};
const remaining = css.replace(/(?:^:root|^\[data-theme="dark"\])\s*\{[^}]+\}/gm,'');
const oldColors = ['1A3B3A','F7F5F0','2A5450'].map(c=>new RegExp('#'+c,'gi'));
const oldBrand = new RegExp(['dot'+'ling','点'+'点'].join('|'),'i');
for(const file of files) {
  const source=fs.readFileSync(path.join(root,file),'utf8');
  for(const oldColor of oldColors) assert(!oldColor.test(source),file+' 保留旧颜色');
  assert(!oldBrand.test(source),file+' 保留旧品牌');
  assert(!/#[\da-f]{3,8}\b/i.test(file==='renderer/styles.css'?remaining:source),file+' 存在变量块外的色值');
}
function resolve(vars,key) { const value=vars[key];const ref=value.match(/^var\(--([\w-]+)\)$/);return ref?resolve(vars,ref[1]):value; }
const luminance = color => {const channels=color.slice(1).match(/../g).map(v=>parseInt(v,16)/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4);return channels[0]*0.2126+channels[1]*0.7152+channels[2]*0.0722;};
const contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05);};
const contrasts={};
for(const [theme,vars] of Object.entries({dark,light})) {
  const values={};
  for(const background of ['bg-app','bg-panel','bg-elevated','bg-code','bubble-user']) {
    for(const text of ['text-primary','text-secondary']) values[text+'/'+background]=contrast(resolve(vars,text),resolve(vars,background));
  }
  for(const background of ['accent-solid','accent-solid-hover']) values['on-accent/'+background]=contrast(resolve(vars,'on-accent'),resolve(vars,background));
  values['danger/bg-app']=contrast(resolve(vars,'danger'),resolve(vars,'bg-app'));
  for(const [name,value] of Object.entries(values)) assert(value>=4.5,theme+' '+name+' '+value);
  contrasts[theme]=values;
}
const report={time:new Date().toISOString(),files,oldColorMatches:0,oldBrandMatches:0,hardcodedColorsOutsideVariables:0,contrasts,light,dark};
fs.mkdirSync(path.join(root,'work'),{recursive:true});
fs.writeFileSync(path.join(root,'work/theme-audit.json'),JSON.stringify(report,null,2));
console.log('主题静态审计通过：旧色/旧品牌零命中，色值集中定义；正文、辅助文字及实心按钮对比度全部达标。');
