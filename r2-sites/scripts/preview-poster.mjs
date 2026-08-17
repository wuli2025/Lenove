/**
 * 本地预览海报，不依赖部署。
 * 会把几种边界情况（长标题 / 长亮点 / 长姓名）一起渲出来，
 * 用来检查有没有溢出画布或撞版。
 *
 *   node scripts/preview-poster.mjs <输出目录>
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { posterSvg } from '../src/poster.js';

const outDir = process.argv[2] || './_preview';
mkdirSync(outDir, { recursive: true });

const CASES = [
  {
    file: 'a-normal',
    w: { id: 'demo0001', slug: 'zhangsan-x1', creator: '张三', accent: 0,
         title: '我家猫的十八年回忆录', tagline: '用一句话给橘子做了个纪念馆' },
  },
  {
    file: 'b-long',   // 最坏情况：标题两行 + 亮点两行
    w: { id: 'demo0002', slug: 'ouyangxiaoming-x2', creator: '欧阳小明', accent: 2,
         title: '给女儿做的成长时间线从出生到上小学', tagline: '把六年里散落在各处的照片和小事按时间排好，一页看完' },
  },
  {
    file: 'c-short',  // 极短内容，检查有没有大片空档
    w: { id: 'demo0003', slug: 'lin-x3', creator: 'Lin', accent: 3, title: '摄影集', tagline: '十张照片' },
  },
  {
    file: 'd-maxname', // 姓名顶到 24 字上限
    w: { id: 'demo0004', slug: 'maxname-x4', creator: '司马相如司马相如司马相如司马相如', accent: 5,
         title: '一个很长很长的作品主题用来测试截断', tagline: '亮点描述也写满六十个字来看看排版会不会被撑破掉真的会吗' },
  },
];

for (const c of CASES) {
  const svg = posterSvg(c.w, `https://r2t-9f3x.llmwiki.cloud/u/${c.w.slug}/`, null);
  writeFileSync(`${outDir}/${c.file}.svg`, svg, 'utf8');
  console.log(`${c.file}.svg  ${(svg.length / 1024).toFixed(1)} KB`);
}

// 拼一张对照页，一次看完
const html =
  `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
   *{margin:0;padding:0}body{background:#04070d;display:flex;gap:20px;padding:20px}
   figure{width:540px}img{width:540px;display:block;border:1px solid #234}
   figcaption{color:#8fa3b6;font:12px/2 monospace;text-align:center}</style></head><body>` +
  CASES.map((c) => `<figure><img src="${c.file}.svg"><figcaption>${c.file}</figcaption></figure>`).join('') +
  `</body></html>`;
writeFileSync(`${outDir}/index.html`, html, 'utf8');
console.log(`\n对照页: ${outDir}/index.html`);
