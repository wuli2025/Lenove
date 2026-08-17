/**
 * QR 编码器正确性验证：用 jsQR 真解码回来逐字比对。
 * 「看起来像二维码」不算数——现场扫不出来就全废了。
 *
 *   npm i && node scripts/verify-qr.mjs
 */
import jsQR from 'jsqr';
import { qrMatrix } from '../src/qr.js';

const SCALE = 6;   // 每模块像素数
const QUIET = 4;   // 静默区模块数（标准要求 4）

/** 矩阵 → RGBA 像素，直接喂给 jsQR，不经任何图片编解码 */
function toImageData(modules, n) {
  const total = (n + QUIET * 2) * SCALE;
  const data = new Uint8ClampedArray(total * total * 4).fill(255);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!modules[r][c]) continue;
      for (let dy = 0; dy < SCALE; dy++) {
        for (let dx = 0; dx < SCALE; dx++) {
          const y = (r + QUIET) * SCALE + dy;
          const x = (c + QUIET) * SCALE + dx;
          const i = (y * total + x) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  return { data, width: total, height: total };
}

const CASES = [
  'https://r2t-9f3x.llmwiki.cloud/u/site-a/',
  'https://r2t-9f3x.llmwiki.cloud/u/zhang-san-2f7a/',
  'https://hall.llmwiki.cloud/p/a1b2c3d4',
  'HELLO',
  'https://example.com/' + 'x'.repeat(80),
  'https://example.com/' + 'y'.repeat(200),
  '中文也要能扫：我的个人网站',
];

let pass = 0;
let fail = 0;
for (const text of CASES) {
  let line;
  try {
    const { size, version, modules } = qrMatrix(text);
    const img = toImageData(modules, size);
    const got = jsQR(img.data, img.width, img.height);
    if (got && got.data === text) {
      pass++;
      line = `  PASS  V${String(version).padStart(2)}  ${size}x${size}  ${JSON.stringify(text.slice(0, 46))}`;
    } else {
      fail++;
      line = `  FAIL  V${version}  解码=${got ? JSON.stringify(got.data.slice(0, 46)) : 'null(扫不出)'}  期望=${JSON.stringify(text.slice(0, 46))}`;
    }
  } catch (e) {
    fail++;
    line = `  FAIL  抛异常: ${e.message}`;
  }
  console.log(line);
}

// ── 随机 fuzz：覆盖各长度 / 各版本 / 各掩码分支 ──
const CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_./:中文测试站点';
let seed = 20260813;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
let fz = 0, fzFail = 0;
const seenVersions = new Set();
for (let t = 0; t < 120; t++) {
  const len = 1 + Math.floor(rnd() * 180);
  let s = '';
  for (let i = 0; i < len; i++) s += CHARS[Math.floor(rnd() * CHARS.length)];
  try {
    const { size, version, modules } = qrMatrix(s);
    seenVersions.add(version);
    const img = toImageData(modules, size);
    const got = jsQR(img.data, img.width, img.height);
    if (got && got.data === s) fz++;
    else { fzFail++; console.log(`  FUZZ FAIL  V${version} len=${s.length} ${JSON.stringify(s.slice(0, 30))}`); }
  } catch (e) {
    fzFail++;
    console.log(`  FUZZ FAIL  len=${len} ${e.message}`);
  }
}
console.log(`\nfuzz 通过 ${fz} / ${fz + fzFail}　覆盖版本: V${[...seenVersions].sort((a, b) => a - b).join(' V')}`);

console.log(`\n合计通过 ${pass + fz} / ${pass + fail + fz + fzFail}`);
process.exit(fail === 0 && fzFail === 0 ? 0 : 1);
