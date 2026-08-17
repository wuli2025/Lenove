/**
 * 本地预览个人中心，不依赖部署、不依赖 D1。
 *
 *   node scripts/preview-me.mjs [输出目录]        只生成 HTML
 *   node scripts/preview-me.mjs [输出目录] --shot 顺便用无头 Edge 截图
 *
 * 为什么要有这个：/me 的两态（未登录登录卡 / 登录后作品陈列）在真实环境里
 * 要先收到验证码才能看到第二态，改一次版式验证一次太贵。这里直接把 meHtml
 * 的两种输入都渲出来，作品数据通过 preload 走的是页面里同一套 render()，
 * 所以截出来的图就是线上真实渲染。
 *
 * 无浏览器环境下的视觉验证走 headless Edge（Chrome 扩展常掉线，别用）。
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { meHtml } from '../src/me.js';

const outDir = resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : './_preview-me');
const doShot = process.argv.includes('--shot');
mkdirSync(outDir, { recursive: true });

const ORIGIN = 'https://r2t-9f3x.llmwiki.cloud';
const USER = {
  id: 'u7f3x9a2',
  email: 'zhangsan@example.com',
  name: '张三',
  avatar: null,
  created_at: Date.now() - 12 * 86400000,
};

/** 造一批作品，含边界情况：无封面、超长标题、已下架、点击数上万 */
const mk = (i, over = {}) => {
  const slug = over.slug || `zhangsan-${i}`;
  const id = over.id || `demo000${i}`;
  return {
    id, slug, creator: '张三',
    title: over.title || `作品标题 ${i}`,
    tagline: over.tagline ?? '一句话说清这个网站在做什么',
    cover: null, poster: null, accent: i % 6,
    hits: over.hits ?? i * 37,
    status: over.status || 'public',
    created_at: Date.now() - i * 3600000,
    siteUrl: `${ORIGIN}/u/${slug}/`,
    posterUrl: `${ORIGIN}/p/${id}`,
    coverUrl: null,
    ...over,
  };
};

const WORKS = [
  mk(1, { title: '我家猫的十八年回忆录', tagline: '用一句话给橘子做了个纪念馆', hits: 12840 }),
  mk(2, { title: '给女儿做的成长时间线，从出生一直排到上小学', tagline: '把六年里散落在各处的照片和小事按时间排好，一页看完' }),
  mk(3, { title: '摄影集', tagline: '' }),
  mk(4, { title: '这个作品被下架了', status: 'hidden', hits: 3 }),
];

const CASES = [
  {
    file: 'a-logged-out',
    label: '未登录 · 登录卡',
    html: meHtml({ user: null }),
  },
  {
    file: 'b-logged-in',
    label: '已登录 · 有作品',
    html: meHtml({
      user: USER,
      preload: {
        ok: true, matchedBy: 'creator-name', user: USER,
        stats: { works: WORKS.length, hits: WORKS.reduce((s, w) => s + w.hits, 0), days: 12 },
        works: WORKS,
      },
    }),
  },
  {
    file: 'c-logged-in-empty',
    label: '已登录 · 零作品（空态）',
    html: meHtml({
      user: { ...USER, name: '欧阳小明同学名字很长' },
      preload: { ok: true, matchedBy: 'creator-name', user: USER, stats: { works: 0, hits: 0, days: 1 }, works: [] },
    }),
  },
];

for (const c of CASES) {
  const p = join(outDir, `${c.file}.html`);
  writeFileSync(p, c.html, 'utf8');
  console.log(`${c.file}.html  ${(c.html.length / 1024).toFixed(1)} KB  ${c.label}`);
}

if (!doShot) {
  console.log(`\n生成完毕：${outDir}\n加 --shot 可顺便截图。`);
  process.exit(0);
}

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
if (!existsSync(EDGE)) {
  console.error(`找不到 Edge：${EDGE}\n没有它就只能手动开 HTML 看。`);
  process.exit(2);
}

for (const c of CASES) {
  const png = join(outDir, `${c.file}.png`);
  const url = pathToFileURL(join(outDir, `${c.file}.html`)).href;
  // --virtual-time-budget 让内联 JS（render / 事件绑定）跑完再截，
  // 否则「已登录」那张会截到还没填数据的骨架。
  execFileSync(EDGE, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--window-size=1440,1200', '--virtual-time-budget=5000',
    `--screenshot=${png}`, url,
  ], { stdio: 'ignore' });
  console.log(`截图 ${png}`);
}
console.log(`\n看一眼：${outDir}`);
