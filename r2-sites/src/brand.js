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

/** 6 档配色。同一作品由标题哈希定档，保证每次渲染颜色一致。 */
export const ACCENTS = [
  { a: '#66d9e8', b: '#4a9fd4', name: 'cyan' },
  { a: '#b58ae0', b: '#7a6ad0', name: 'violet' },
  { a: '#6ad39a', b: '#3f9f8a', name: 'jade' },
  { a: '#f0d08a', b: '#d09a4e', name: 'gold' },
  { a: '#e8965a', b: '#d0603f', name: 'amber' },
  { a: '#e2789b', b: '#b8548a', name: 'rose' },
];

/** 稳定哈希（FNV-1a），用于 slug 后缀与配色档。 */
export function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export const accentOf = (n) => ACCENTS[((n % ACCENTS.length) + ACCENTS.length) % ACCENTS.length];

/** HTML 转义 —— 作品标题与姓名都是用户输入，任何拼进 HTML 的地方必须过这个。 */
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
