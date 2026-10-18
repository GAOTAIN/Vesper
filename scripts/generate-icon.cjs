// 所有导出颜色均从样式变量读取；ICO 同时包含常用小尺寸和 256 像素。
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
(async () => {
  const root = path.resolve(__dirname, '..');
  const color = fs.readFileSync(path.join(root, 'renderer/styles.css'),'utf8').match(/--icon-export:\s*([^;]+);/)[1].trim();
  const svg = fs.readFileSync(path.join(root,'assets/icon.svg'),'utf8').replace('<svg ', '<svg style="color:'+color+'" ');
  const sizes = [256, 128, 64, 48, 32, 16];
  const images = await Promise.all(sizes.map(size => sharp(Buffer.from(svg)).resize(size,size).png().toBuffer()));
  fs.mkdirSync(path.join(root,'build'),{recursive:true});
  const directory = Buffer.alloc(6+16*sizes.length); directory.writeUInt16LE(1,2); directory.writeUInt16LE(sizes.length,4);
  let offset=directory.length;
  images.forEach((png,i) => { const n=6+i*16; directory[n]=sizes[i]===256?0:sizes[i]; directory[n+1]=directory[n]; directory.writeUInt16LE(1,n+4);directory.writeUInt16LE(32,n+6);directory.writeUInt32LE(png.length,n+8);directory.writeUInt32LE(offset,n+12);offset+=png.length; });
  fs.writeFileSync(path.join(root,'build/icon.ico'),Buffer.concat([directory,...images]));
  fs.writeFileSync(path.join(root,'build/icon.png'),images[0]);
  console.log('已生成 Vesper 多尺寸 ICO 与 256×256 PNG。');
})().catch(e=>{console.error(e);process.exitCode=1;});
