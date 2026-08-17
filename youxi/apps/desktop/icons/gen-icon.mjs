// 生成 1024×1024 应用图标源图，交给 `cargo tauri icon` 派生全套尺寸。
// 视觉取真昼的配色：深底 #070b12 + 青 #66d9e8，图形是「一」+ 光标块，
// 对应产品名「一句话生成」。纯算法绘制，不依赖字体（装机字体不可控）。
import { PNG } from 'pngjs';
import { writeFileSync } from 'node:fs';

const S = 1024;
const png = new PNG({ width: S, height: S });

const BG = [7, 11, 18];
const CY = [102, 217, 232];
const DIM = [30, 48, 66];

const put = (x, y, [r, g, b], a = 1) => {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (S * y + x) << 2;
  const d = png.data;
  d[i] = d[i] * (1 - a) + r * a;
  d[i + 1] = d[i + 1] * (1 - a) + g * a;
  d[i + 2] = d[i + 2] * (1 - a) + b * a;
  d[i + 3] = 255;
};

// 圆角方底
const R = 190;
const inRounded = (x, y) => {
  const cx = Math.min(Math.max(x, R), S - R);
  const cy = Math.min(Math.max(y, R), S - R);
  return (x - cx) ** 2 + (y - cy) ** 2 <= R * R;
};
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    if (!inRounded(x, y)) { const i = (S * y + x) << 2; png.data[i + 3] = 0; continue; }
    // 顶部微微提亮，避免大色块死板
    const t = 1 - y / S;
    put(x, y, [BG[0] + t * 10, BG[1] + t * 14, BG[2] + t * 20]);
  }
}

// 抗锯齿矩形
const rect = (x0, y0, w, h, col, r = 0) => {
  for (let y = Math.floor(y0) - 2; y < y0 + h + 2; y++) {
    for (let x = Math.floor(x0) - 2; x < x0 + w + 2; x++) {
      if (!inRounded(x, y)) continue;
      // 到矩形的有符号距离（带圆角）
      const dx = Math.max(x0 + r - x, 0, x - (x0 + w - r));
      const dy = Math.max(y0 + r - y, 0, y - (y0 + h - r));
      const d = Math.hypot(dx, dy) - r;
      const a = Math.min(1, Math.max(0, 0.5 - d));
      if (a > 0) put(x, y, col, a);
    }
  }
};

// 三条横线：中间那条是亮青的「一」，上下两条是暗的——
// 读作「从一句话里长出一整页」
rect(276, 372, 300, 26, DIM, 13);
rect(276, 486, 472, 44, CY, 22);
rect(276, 620, 380, 26, DIM, 13);

// 右侧光标块（正在生成中）
rect(700, 596, 48, 74, CY, 8);

writeFileSync(new URL('./icon-src.png', import.meta.url), PNG.sync.write(png));
console.log('icon-src.png 1024x1024 written');
