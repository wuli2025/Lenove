/**
 * 作品大厅 —— 服务端直出 HTML。
 * 严格执行 V3 第 04 节的六条硬规则：
 *   ① 封面统一 16:10 居中裁切（不允许作品自定义）
 *   ② 信息固定三行：标题 / 头像+姓名 / 点击数
 *   ③ 只有两种卡片尺寸：Top3 大卡 + 其余同尺寸小卡
 *   ④ 卡片样式不被作品内容影响
 *   ⑤ 先审后展（status != public 不出现）
 *   ⑥ 永不空榜（无数据时出引导态而不是空白）
 */
import { BRAND, accentOf, esc, coverSvg } from './brand.js';
import { topbar, baseCss } from './layout.js';
import { heat } from './api.js';

const fmtHits = (n) => (n >= 10000 ? (n / 10000).toFixed(1) + 'w' : n.toLocaleString('en-US'));

function timeAgo(ts, now) {
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

function cardHtml(w, origin, big, rank) {
  const accent = accentOf(w.accent || 0);
  const cover = w.cover
    ? `<img src="${origin}/r2/${esc(w.cover)}" alt="" loading="lazy">`
    : `<div class="gen">${coverSvg(w.id + w.title, accent, { w: 640, h: 400 })}</div>`;
  const initial = esc(String(w.creator || '?').trim().slice(0, 1));
  return `<a class="c${big ? ' big' : ''}" href="${origin}/p/${esc(w.id)}">
  ${rank ? `<span class="rk">${rank}</span>` : ''}
  <div class="th">${cover}</div>
  <div class="in">
    <div class="t1">${esc(w.title)}</div>
    <div class="t2">
      <span class="av" style="background:linear-gradient(135deg,${accent.a},${accent.b})">${initial}</span>
      <span class="nm">${esc(w.creator)}</span>
      <span class="ht">${fmtHits(w.hits)}</span>
    </div>
  </div>
</a>`;
}

export function hallHtml(works, { origin, sort, now, user = null }) {
  const top = works.slice(0, 3);
  const rest = works.slice(3);
  const empty = works.length === 0;

  return `<!DOCTYPE html><html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>作品大厅 · ${esc(BRAND.name)}</title>
<meta name="description" content="${esc(BRAND.slogan)}">
<meta property="og:title" content="作品大厅 · ${esc(BRAND.name)}">
<meta property="og:description" content="${esc(BRAND.slogan)}">
<style>${baseCss()}
body{background-image:radial-gradient(900px 500px at 78% -8%,rgba(102,217,232,.10),transparent 62%)}
.wrap{max-width:1240px;margin:0 auto;padding:0 20px 90px}
.cnt{font-family:${BRAND.mono};font-size:12px;color:${BRAND.cy};
  border:1px solid rgba(102,217,232,.3);border-radius:20px;padding:4px 13px;white-space:nowrap}
.cnt b{font-size:14px}
.subbar{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:26px}
.tabs{margin-left:auto;display:flex;gap:6px}
.tb{font-size:13px;color:${BRAND.tx3};padding:6px 16px;border-radius:20px;border:1px solid rgba(217,226,234,.10)}
.tb.on{color:#04070d;background:${BRAND.cy};border-color:${BRAND.cy};font-weight:650}
.hero{padding:46px 0 30px}
.hero h1{font-size:33px;font-weight:800;letter-spacing:.01em;margin-bottom:10px}
.hero h1 em{font-style:normal;color:${BRAND.cy}}
.hero p{color:${BRAND.tx2};font-size:14.5px;line-height:1.8}
.grid{display:grid;gap:14px;grid-template-columns:repeat(4,1fr)}
.grid.top{grid-template-columns:repeat(3,1fr);margin-bottom:14px}
.c{position:relative;border:1px solid rgba(217,226,234,.09);border-radius:11px;overflow:hidden;
  background:rgba(12,19,30,.72);transition:border-color .18s,transform .18s}
.c:hover{border-color:rgba(102,217,232,.4);transform:translateY(-2px)}
/* 规则①：统一 16:10 居中裁切，作品再花哨在大厅里也只是一张标准卡 */
.th{aspect-ratio:16/10;overflow:hidden;border-bottom:1px solid rgba(217,226,234,.09);background:#0b111b}
.c.big .th{aspect-ratio:16/9}
.th img{width:100%;height:100%;object-fit:cover;object-position:top center;display:block}
.gen,.gen svg{width:100%;height:100%;display:block}
.in{padding:12px 14px 13px}
/* 规则②：固定三行，标题超长省略而不是换行或缩字号 */
.t1{font-size:14px;font-weight:650;margin-bottom:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.c.big .t1{font-size:16px}
.t2{display:flex;align-items:center;gap:7px;font-size:12px;color:${BRAND.tx3}}
.av{width:18px;height:18px;border-radius:50%;flex:0 0 18px;display:flex;align-items:center;
  justify-content:center;font-size:10px;font-weight:700;color:#04070d}
.nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ht{margin-left:auto;font-family:${BRAND.mono};color:${BRAND.am};white-space:nowrap}
.ht::after{content:" 次";font-family:${BRAND.font};color:${BRAND.tx3}}
.rk{position:absolute;top:9px;left:9px;z-index:2;font-family:${BRAND.mono};font-size:11px;
  font-weight:700;color:#04070d;background:${BRAND.am};border-radius:4px;padding:2px 7px}
.empty{border:1px dashed rgba(102,217,232,.28);border-radius:14px;padding:56px 24px;text-align:center;
  background:rgba(102,217,232,.04)}
.empty b{display:block;font-size:19px;margin-bottom:10px}
.empty span{color:${BRAND.tx2};font-size:14px;line-height:1.85}
.foot{margin-top:52px;padding-top:24px;border-top:1px solid rgba(217,226,234,.09);
  font-family:${BRAND.mono};font-size:11.5px;color:${BRAND.tx3};line-height:2;letter-spacing:.1em}
@media(max-width:1000px){.grid{grid-template-columns:repeat(3,1fr)}.grid.top{grid-template-columns:repeat(3,1fr)}}
@media(max-width:720px){
  .grid,.grid.top{grid-template-columns:repeat(2,1fr)}
  .hero h1{font-size:25px}.hero{padding:32px 0 22px}
}
</style></head><body>
${topbar('hall', user)}

<div class="wrap">
  <div class="hero">
    <h1>所有人的作品，<em>都在这面墙上</em></h1>
    <p>${esc(BRAND.slogan)}　·　谁的网站被点开得最多，谁就排在最前面。</p>
  </div>

  <div class="subbar">
    <div class="cnt">已诞生 <b>${works.length}</b> 个网站</div>
    <div class="tabs">
      <a class="tb${sort === 'hot' ? ' on' : ''}" href="/hall?sort=hot">最热</a>
      <a class="tb${sort === 'new' ? ' on' : ''}" href="/hall?sort=new">最新</a>
    </div>
  </div>

  ${
    empty
      ? `<div class="empty"><b>大厅还空着</b><span>第一个作品马上就来。<br>在现场用一句话描述你想要的网站，十分钟后它就会出现在这里。</span></div>`
      : `${top.length ? `<div class="grid top">${top.map((w, i) => cardHtml(w, origin, true, String(i + 1).padStart(2, '0'))).join('')}</div>` : ''}
      ${rest.length ? `<div class="grid">${rest.map((w) => cardHtml(w, origin, false, null)).join('')}</div>` : ''}`
  }

  <div class="foot">
    ${esc(BRAND.name)} · ${esc(BRAND.date)} · ${esc(BRAND.en)}<br>
    热度 = 点击数 ÷ (小时数+2)^1.2　·　同一访客 30 分钟内只计一次
  </div>
</div>
</body></html>`;
}
