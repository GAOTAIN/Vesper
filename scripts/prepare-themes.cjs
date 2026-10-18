// 从本地 npm 依赖生成 GitHub 双主题，所有语法色引用集中变量。
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname,'..');
const palette = fs.readFileSync(path.join(root,'renderer/styles.css'),'utf8');
fs.mkdirSync(path.join(root,'renderer/themes'),{recursive:true});
for(const [theme,name] of [['light','github'],['dark','github-dark']]) {
  const source=fs.readFileSync(path.join(root,'node_modules/highlight.js/styles',name+'.css'),'utf8');
  let css=source.replace(/\/\*[\s\S]*?\*\//g,'').replace(/#[\da-f]{3,8}\b/gi,color=>{
    const key='syntax-'+color.slice(1).toLowerCase();
    if(!palette.includes('--'+key+':')) throw new Error('请先在主题变量中补充语法色：'+key);
    return 'var(--'+key+')';
  });
  css=css.replace(/([^{}]+)\{([^{}]*)\}/g,(_m,selectors,body)=>`${selectors.trim().split(',').map(s=>`[data-theme="${theme}"] .code-block ${s.trim()}`).join(',\n')}{${body}}\n`);
  fs.writeFileSync(path.join(root,'renderer/themes',name+'.css'),`/* 本地 highlight.js ${name}；保留上游语法规则，颜色集中在 styles.css。\n${source.match(/\/\*![\s\S]*?\*\//)?.[0].slice(3,-2)||''}*/\n${css}`,'utf8');
}
console.log('本地 GitHub 双主题资源已就绪。');
