/**
 * 分享海报页。
 *
 * 海报本体必须由桌面端 Canvas 直接生成 1080×1440 PNG 并上传 R2；这里仅展示
 * 已存在的位图，不再创建 SVG 海报，也不在缺图时画“生成式”占位卡。
 */
import { BRAND, accentOf, esc } from './brand.js';

export function posterHtml(work, origin) {
  if (!work.poster) throw new Error('posterHtml 需要已上传的 PNG 海报');
  const accent = accentOf(work.accent || 0);
  const siteUrl = `${origin}/u/${work.slug}/`;
  const posterImg = `${origin}/r2/${work.poster}`;

  return `<!DOCTYPE html><html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(work.title)} · ${esc(work.creator)} | ${esc(BRAND.name)}</title>
<meta name="description" content="${esc(work.tagline || BRAND.slogan)}">
<meta property="og:title" content="${esc(work.title)} — ${esc(work.creator)}">
<meta property="og:description" content="${esc(work.tagline || BRAND.slogan)}">
<meta property="og:image" content="${posterImg}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:${BRAND.bg};color:${BRAND.tx};font-family:${BRAND.font};
  min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:26px 16px 60px;
  background-image:radial-gradient(700px 400px at 80% -5%,${accent.a}1f,transparent 62%)}
.card{width:100%;max-width:420px}
.poster{width:100%;border-radius:16px;overflow:hidden;display:block;
  box-shadow:0 24px 70px rgba(0,0,0,.6);border:1px solid ${BRAND.line}}
.hint{margin:18px 2px 0;font-size:13.5px;color:${BRAND.tx3};line-height:1.75;text-align:center}
.acts{display:flex;gap:10px;margin-top:20px}
.btn{flex:1;text-align:center;text-decoration:none;padding:14px 10px;border-radius:11px;
  font-size:15px;font-weight:650;border:1px solid ${accent.a}55;color:${accent.a};background:${accent.a}14}
.btn.solid{background:${accent.a};color:#04070d;border-color:${accent.a}}
.meta{margin-top:26px;padding-top:20px;border-top:1px solid rgba(217,226,234,.09);color:${BRAND.tx3};
  font-size:12px;text-align:center;font-family:${BRAND.mono};letter-spacing:.10em;line-height:2}
</style></head><body>
<div class="card">
  <img class="poster" src="${posterImg}" alt="${esc(work.title)} 分享海报">
  <p class="hint">长按图片保存 · 分享给好友<br>海报内二维码可直接打开作品</p>
  <div class="acts">
    <a class="btn solid" href="${siteUrl}">打开作品</a>
    <a class="btn" href="${origin}/hall">去大厅看看</a>
  </div>
  <div class="meta">${esc(BRAND.name)} · ${esc(BRAND.date)}<br>${esc(BRAND.slogan)}</div>
</div>
</body></html>`;
}
