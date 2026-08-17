/**
 * 主活动的主题概念与视觉元素 —— 大厅、海报、作品页共用同一套。
 * 分享海报第 5 项要求「主活动的主题概念+元素」，就是这里定义的东西：
 * 名字、口号、日期、深空底 + 青色光线 + 悬浮卡片 + 细网格。
 */

export const BRAND = {
  name: '一句话生成',
  en: 'ONE SENTENCE, ONE SITE',
  slogan: '说一句话，就有一个网站',
  date: '2026.08.18',
  event: '现场共创',
  bg: '#070b12',
  bg2: '#0b111b',
  cy: '#66d9e8',
  am: '#f0d08a',
  tx: '#e8f0f6',
  tx2: '#8fa3b6',
  tx3: '#5f7488',
  line: 'rgba(102,217,232,.18)',
  font: '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",-apple-system,"Segoe UI",sans-serif',
  mono: 'ui-monospace,"Cascadia Mono",Consolas,monospace',
};

/** 6 档配色。同一作品由标题哈希定档，保证每次渲染颜色一致，不会今天蓝明天紫。 */
export const ACCENTS = [
  { a: '#66d9e8', b: '#4a9fd4', name: 'cyan' },
  { a: '#b58ae0', b: '#7a6ad0', name: 'violet' },
  { a: '#6ad39a', b: '#3f9f8a', name: 'jade' },
  { a: '#f0d08a', b: '#d09a4e', name: 'gold' },
  { a: '#e8965a', b: '#d0603f', name: 'amber' },
  { a: '#e2789b', b: '#b8548a', name: 'rose' },
];

/** 稳定哈希（FNV-1a），用于定配色档与生成式示意图 */
export function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export const accentOf = (n) => ACCENTS[((n % ACCENTS.length) + ACCENTS.length) % ACCENTS.length];

/** HTML 转义 —— 作品标题与姓名都是用户输入，任何拼进 HTML 的地方必须过这个 */
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 作品画面示意（没有真实截图时的兜底）。
 * 由作品 id 派生的确定性生成图：网页版式的抽象轮廓 —— 导航条、标题块、
 * 正文行、卡片格。看上去就是"一个网页"，而不是一坨随机噪点。
 */
export function coverSvg(seedStr, accent, { w = 640, h = 400 } = {}) {
  let s = hashStr(seedStr);
  const rnd = () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 0xffffffff;
  };
  const p = [];

  // 导航条（四种版式都有，作为"这是个网页"的共同信号）
  p.push(`<rect x="34" y="30" width="86" height="10" rx="5" fill="${accent.a}" opacity=".85"/>`);
  for (let i = 0; i < 4; i++) {
    p.push(`<rect x="${430 + i * 44}" y="32" width="30" height="6" rx="3" fill="#8fa3b6" opacity=".38"/>`);
  }
  p.push(`<rect x="34" y="58" width="572" height="1" fill="#d9e2ea" opacity=".10"/>`);

  const bar = (x, y, wd, ht, fill, op, r) =>
    p.push(`<rect x="${x}" y="${y}" width="${wd}" height="${ht}" rx="${r ?? ht / 2}" fill="${fill}" opacity="${op}"/>`);
  const card = (x, y, wd, ht) =>
    p.push(`<rect x="${x}" y="${y}" width="${wd}" height="${ht}" rx="9" fill="#d9e2ea" opacity=".05" stroke="${accent.a}" stroke-opacity=".16"/>`);

  // 四种版式原型。只有一种的话，一整面墙的兜底图看着全是同一个东西，
  // 只有颜色在变——整齐是好事，重复不是。
  //
  // 优先按标题关键词挑版式（seedStr 里带着标题），挑不中再退回随机。
  // 「猫咪回忆录」配时间线、「摄影集」配图片墙，比纯随机像样得多。
  const KEYWORDS = [
    [/相册|摄影|图集|作品集|画展|照片|插画|绘|展/, 1],           // 图片墙
    [/回忆|时间线|日志|记录|行程|历程|年|旅行|足迹|笔记/, 2],     // 时间线
    [/打卡|统计|报价|数据|清单|账|榜|计划|进度|天/, 3],          // 数据面板
  ];
  let layout = -1;
  for (const [re, id] of KEYWORDS) {
    if (re.test(seedStr)) { layout = id; break; }
  }
  if (layout < 0) layout = Math.floor(rnd() * 4);

  if (layout === 0) {
    // ① 左文右图：最常见的落地页
    const tW = 250 + Math.floor(rnd() * 130);
    bar(34, 92, tW, 22, accent.a, '.9', 6);
    bar(34, 126, tW - 70, 22, '#e8f0f6', '.55', 6);
    for (let i = 0; i < 3; i++) bar(34, 170 + i * 15, 190 + Math.floor(rnd() * 150), 7, '#8fa3b6', '.30');
    p.push(`<rect x="34" y="228" width="104" height="28" rx="8" fill="${accent.a}" opacity=".22" stroke="${accent.a}" stroke-opacity=".5"/>`);
    p.push(`<rect x="392" y="86" width="214" height="140" rx="12" fill="url(#cvG)" opacity=".55"/>`);
    const cols = 3 + Math.floor(rnd() * 2);
    const cw = Math.floor((572 - (cols - 1) * 14) / cols);
    for (let i = 0; i < cols; i++) {
      const x = 34 + i * (cw + 14);
      card(x, 288, cw, 78);
      bar(x + 12, 304, Math.floor(cw * 0.5), 8, accent.a, '.55');
      bar(x + 12, 322, Math.floor(cw * 0.74), 6, '#8fa3b6', '.28');
      bar(x + 12, 336, Math.floor(cw * 0.58), 6, '#8fa3b6', '.22');
    }
  } else if (layout === 1) {
    // ② 居中大标题 + 图片墙：作品集 / 相册类
    const tW = 300 + Math.floor(rnd() * 120);
    bar(320 - tW / 2, 96, tW, 24, accent.a, '.9', 6);
    bar(320 - (tW - 120) / 2, 132, tW - 120, 14, '#8fa3b6', '.34');
    const gw = 138, gh = 96;
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 4; c++) {
        const x = 34 + c * (gw + 8), y = 178 + r * (gh + 8);
        p.push(`<rect x="${x}" y="${y}" width="${gw}" height="${gh}" rx="8" fill="url(#cvG)" opacity="${(0.22 + rnd() * 0.4).toFixed(2)}"/>`);
      }
    }
  } else if (layout === 2) {
    // ③ 时间线 / 列表：回忆录、日志、行程类
    bar(34, 92, 230, 22, accent.a, '.9', 6);
    bar(34, 126, 150, 12, '#8fa3b6', '.32');
    p.push(`<rect x="52" y="168" width="2" height="196" fill="${accent.a}" opacity=".28"/>`);
    for (let i = 0; i < 4; i++) {
      const y = 176 + i * 50;
      p.push(`<circle cx="53" cy="${y + 6}" r="6" fill="${accent.a}" opacity=".8"/>`);
      bar(80, y, 90, 9, accent.a, '.5');
      bar(80, y + 18, 240 + Math.floor(rnd() * 200), 7, '#8fa3b6', '.28');
      bar(80, y + 32, 160 + Math.floor(rnd() * 180), 7, '#8fa3b6', '.20');
    }
    p.push(`<rect x="440" y="168" width="166" height="196" rx="10" fill="url(#cvG)" opacity=".4"/>`);
  } else {
    // ④ 数据面板：打卡、统计、报价类
    bar(34, 92, 200, 20, accent.a, '.9', 6);
    for (let i = 0; i < 3; i++) {
      const x = 34 + i * 194;
      card(x, 132, 184, 82);
      bar(x + 16, 150, 52, 8, '#8fa3b6', '.30');
      bar(x + 16, 170, 84 + Math.floor(rnd() * 40), 20, accent.a, '.75', 4);
    }
    const bx = 34, by = 240, bw = 572, bh = 126;
    card(bx, by, bw, bh);
    for (let i = 0; i < 9; i++) {
      const bh2 = 20 + Math.floor(rnd() * 78);
      p.push(`<rect x="${bx + 20 + i * 60}" y="${by + bh - 14 - bh2}" width="34" height="${bh2}" rx="4" fill="${accent.a}" opacity="${(0.28 + rnd() * 0.5).toFixed(2)}"/>`);
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
    `<defs>` +
    `<linearGradient id="cvG" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${accent.a}" stop-opacity=".85"/>` +
    `<stop offset="1" stop-color="${accent.b}" stop-opacity=".25"/></linearGradient>` +
    `<pattern id="cvGrid" width="26" height="26" patternUnits="userSpaceOnUse">` +
    `<path d="M26 0H0V26" fill="none" stroke="#d9e2ea" stroke-opacity=".05"/></pattern>` +
    `</defs>` +
    `<rect width="${w}" height="${h}" fill="#0b111b"/>` +
    `<rect width="${w}" height="${h}" fill="url(#cvGrid)"/>` +
    `<circle cx="${w * 0.86}" cy="${h * 0.12}" r="150" fill="${accent.a}" opacity=".07"/>` +
    p.join('') +
    `</svg>`
  );
}
