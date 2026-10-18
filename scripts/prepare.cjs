// 本地打包 Markdown 和高亮库，运行时不访问 CDN。
require('esbuild').buildSync({
  stdin: { contents: "window.markdownit = require('markdown-it'); window.hljs = require('highlight.js/lib/common');", resolveDir: require('node:path').resolve(__dirname, '..') },
  outfile: require('node:path').resolve(__dirname, '../renderer/vendor.js'), bundle: true, minify: true, platform: 'browser', format: 'iife', legalComments: 'eof'
});
console.log('已生成本地 Markdown / 代码高亮依赖。');

require('./prepare-themes.cjs');
