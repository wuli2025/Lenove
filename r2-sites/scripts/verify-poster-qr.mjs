/**
 * 端到端验证：海报**渲染成图之后**，上面那个二维码还能不能扫出来。
 *
 * 新海报由桌面端 Canvas 逐格绘制二维码，并直接导出 1080×1440 PNG；
 * 这里从最终 PNG 像素解码，验证栅格化后的二维码仍等于公开作品 URL。
 *
 *   node scripts/verify-poster-qr.mjs <PNG目录> [期望的完整URL]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';

const dir = process.argv[2];
if (!dir) {
  console.error('用法: node scripts/verify-poster-qr.mjs <PNG目录> [期望的完整URL]');
  process.exit(2);
}

const expected = process.argv[3];
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
  if (got && got.data && (!expected || got.data === expected)) {
    pass++;
    console.log(`  PASS  ${f.padEnd(18)} ${png.width}x${png.height}  ->  ${got.data}`);
  } else {
    fail++;
    const detail = got?.data
      ? `解码为 ${got.data}，期望 ${expected}`
      : '扫不出';
    console.log(`  FAIL  ${f.padEnd(18)} ${png.width}x${png.height}  ->  ${detail}`);
  }
}
console.log(`\n海报二维码可扫性: ${pass} / ${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
