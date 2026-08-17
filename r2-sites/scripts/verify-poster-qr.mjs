/**
 * 端到端验证：海报**渲染成图之后**，上面那个二维码还能不能扫出来。
 *
 * qr.js 本身已经用 jsQR 验过，但海报里是手工把模块画成 <path>，
 * 单元格尺寸是浮点、还经过 SVG→PNG 栅格化，取整误差完全可能把它毁掉。
 * 所以这里从真实渲染出来的 PNG 像素里解码，才算数。
 *
 *   node scripts/verify-poster-qr.mjs <PNG目录> <期望URL的前缀>
 */
import { readdirSync, readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';

const dir = process.argv[2];
if (!dir) {
  console.error('用法: node scripts/verify-poster-qr.mjs <PNG目录>');
  process.exit(2);
}

const files = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
if (!files.length) {
  console.error('目录里没有 PNG');
  process.exit(2);
}

let pass = 0;
let fail = 0;
for (const f of files) {
  const png = PNG.sync.read(readFileSync(`${dir}/${f}`));
  const got = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  if (got && got.data) {
    pass++;
    console.log(`  PASS  ${f.padEnd(18)} ${png.width}x${png.height}  ->  ${got.data}`);
  } else {
    fail++;
    console.log(`  FAIL  ${f.padEnd(18)} ${png.width}x${png.height}  ->  扫不出`);
  }
}
console.log(`\n海报二维码可扫性: ${pass} / ${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
