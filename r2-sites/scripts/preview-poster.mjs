#!/usr/bin/env node
/**
 * 预览桌面端已经生成的 1080×1440 PNG 海报，不在 Node 侧伪造作品画面。
 *
 *   node scripts/preview-poster.mjs <PNG目录>
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const outDir = resolve(process.argv[2] || './_preview');
let files;
try {
  files = readdirSync(outDir)
    .filter((name) => name.toLowerCase().endsWith('.png'))
    .sort();
} catch {
  console.error(`目录不存在：${outDir}`);
  process.exit(2);
}

if (!files.length) {
  console.error(`目录里没有桌面端生成的 PNG 海报：${outDir}`);
  process.exit(2);
}

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
for (const file of files) {
  const bytes = readFileSync(resolve(outDir, file));
  const valid =
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(pngSignature) &&
    bytes.readUInt32BE(16) === 1080 &&
    bytes.readUInt32BE(20) === 1440;
  if (!valid) {
    console.error(`${file} 不是 1080×1440 PNG`);
    process.exit(1);
  }
  console.log(`${file}  ${(bytes.length / 1024).toFixed(1)} KB  1080×1440`);
}

const escapeHtml = (text) => String(text)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

const html = `<!doctype html>
<meta charset="utf-8">
<title>一句话生成 · PNG 海报预览</title>
<style>
  *{box-sizing:border-box}body{margin:0;padding:24px;background:#04070d;color:#dbe8f5;font:14px/1.6 system-ui,sans-serif}
  main{display:flex;flex-wrap:wrap;gap:24px}figure{width:min(540px,100%);margin:0}img{display:block;width:100%;aspect-ratio:3/4;object-fit:contain;border:1px solid #234;border-radius:10px;background:#020409}figcaption{text-align:center;padding:8px}
</style>
<h1>桌面端 Canvas PNG 海报</h1>
<main>${files.map((file) => `<figure><img src="${encodeURIComponent(file)}" alt="${escapeHtml(file)} 海报"><figcaption>${escapeHtml(file)}</figcaption></figure>`).join('')}</main>`;
writeFileSync(resolve(outDir, 'index.html'), html, 'utf8');
console.log(`\n对照页：${resolve(outDir, 'index.html')}`);
