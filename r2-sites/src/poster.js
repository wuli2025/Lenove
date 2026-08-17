/**
 * 分享海报 —— 作品生成后的最后一环。
 * 必含五要素：① 创作者姓名 ② 作品主题+一句话亮点 ③ 作品画面示意
 * ④ 体验二维码 ⑤ 主活动主题概念与元素。
 *
 * 两种形态：
 *   /p/<id>      HTML 分享页 —— 发给微信好友打开就是这个，手机上可直接长按保存
 *   /p/<id>.svg  自包含 SVG  —— 供打印 / 桌面端本地栅格化成 PNG
 */
import { BRAND, accentOf, esc, coverSvg } from './brand.js';
import { qrSvg, qrMatrix } from './qr.js';

const W = 1080;
const H = 1440;

/** CJK 按 1 个宽度、ASCII 按 0.55 估算，用于 SVG 里手动断行 */
function textWidth(s) {
  let w = 0;
  for (const ch of s) w += /[一-鿿　-〿＀-￯]/.test(ch) ? 1 : 0.55;
  return w;
}

function wrap(text, maxUnits, maxLines) {
  const out = [];
  let line = '';
  for (const ch of String(text || '')) {
    if (textWidth(line + ch) > maxUnits && line) {
      out.push(line);
      line = ch;
      if (out.length === maxLines) break;
    } else {
      line += ch;
    }
  }
  if (line && out.length < maxLines) out.push(line);
  if (out.length === maxLines && textWidth(line) > maxUnits) {
    out[maxLines - 1] = out[maxLines - 1].slice(0, -1) + '…';
  }
  return out;
}

/** 海报里的作品画面示意：有真实截图用截图，没有就用确定性生成图 */
function coverMarkup(work, coverDataUri, accent, x, y, w, h) {
  const clip = `<clipPath id="cvClip"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16"/></clipPath>`;
  if (coverDataUri) {
    return {
      defs: clip,
      body:
        `<image href="${coverDataUri}" x="${x}" y="${y}" width="${w}" height="${h}" ` +
        `preserveAspectRatio="xMidYMin slice" clip-path="url(#cvClip)"/>` +
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="none" stroke="${accent.a}" stroke-opacity=".35"/>`,
    };
  }
  // 生成式示意图：把 coverSvg 的内容嵌进来（去掉外层 <svg> 标签，换成 <svg> 子元素）
  const inner = coverSvg(work.id + work.title, accent, { w: 640, h: 400 });
  return {
    defs: clip,
    body:
      `<g clip-path="url(#cvClip)"><svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="0 0 640 400" preserveAspectRatio="xMidYMid slice">${inner.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '')}</svg></g>` +
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="none" stroke="${accent.a}" stroke-opacity=".35"/>`,
  };
}

/**
 * 自包含海报 SVG。coverDataUri 传 null 时用生成式示意图。
 */
export function posterSvg(work, siteUrl, coverDataUri = null) {
  const CX = 84; // 左右留白
  const accent = accentOf(work.accent || 0);
  const titleLines = wrap(work.title, 13, 2);
  const tagLines = wrap(work.tagline, 22, 2);

  // 姓名按可用宽度反推字号：正常 2–4 字的名字保持 52px，
  // 遇到很长的名字自动缩到能塞下为止，最小 30px。
  const nameSize = Math.max(30, Math.min(52, Math.floor((W - CX * 2) / Math.max(1, textWidth(work.creator || '')))));

  const cover = coverMarkup(work, coverDataUri, accent, CX, 296, W - CX * 2, 560);

  // 二维码：指向作品体验地址
  const qr = qrMatrix(siteUrl);
  const qrPx = 236;
  const quiet = 4;
  const unit = qrPx / (qr.size + quiet * 2);
  const qrX = W - CX - qrPx;
  const qrY = 1112;
  let qrPath = '';
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (qr.modules[r][c]) {
        qrPath += `M${((c + quiet) * unit).toFixed(2)} ${((r + quiet) * unit).toFixed(2)}h${unit.toFixed(2)}v${unit.toFixed(2)}h-${unit.toFixed(2)}z`;
      }
    }
  }

  // 标题最多 2 行、亮点最多 2 行；按最坏情况排下来底部要停在 1140 之上，
  // 否则会撞上下面的口号带（实测 2+2 时最容易出事）。
  const titleY = 920;
  const titleSvg = titleLines
    .map((l, i) => `<text x="${CX}" y="${titleY + i * 74}" class="tt">${esc(l)}</text>`)
    .join('');
  const tagY = titleY + titleLines.length * 74 + 8;
  const tagSvg = tagLines
    .map((l, i) => `<text x="${CX}" y="${tagY + i * 42}" class="tg">${esc(l)}</text>`)
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family='${BRAND.font}'>
<defs>
  ${cover.defs}
  <linearGradient id="bgG" x1="0" y1="0" x2="0.6" y2="1">
    <stop offset="0" stop-color="#0c1522"/><stop offset="0.55" stop-color="${BRAND.bg}"/><stop offset="1" stop-color="#05080e"/>
  </linearGradient>
  <radialGradient id="glow" cx="0.82" cy="0.06" r="0.55">
    <stop offset="0" stop-color="${accent.a}" stop-opacity=".22"/><stop offset="1" stop-color="${accent.a}" stop-opacity="0"/>
  </radialGradient>
  <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
    <path d="M48 0H0V48" fill="none" stroke="#d9e2ea" stroke-opacity=".035"/>
  </pattern>
  <linearGradient id="beam" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${accent.a}" stop-opacity="0"/>
    <stop offset="0.5" stop-color="${accent.a}" stop-opacity=".85"/>
    <stop offset="1" stop-color="${accent.a}" stop-opacity="0"/>
  </linearGradient>
  <style>
    .lb{font-size:23px;letter-spacing:.30em;fill:${BRAND.tx3};font-family:${BRAND.mono}}
    .bn{font-size:31px;font-weight:700;fill:${BRAND.tx};letter-spacing:.05em}
    .bs{font-size:20px;letter-spacing:.22em;fill:${accent.a};font-family:${BRAND.mono}}
    .tt{font-size:62px;font-weight:800;fill:#fff;letter-spacing:.01em}
    .tg{font-size:30px;fill:${BRAND.tx2};letter-spacing:.02em}
    .ck{font-size:21px;letter-spacing:.26em;fill:${BRAND.tx3};font-family:${BRAND.mono}}
    .cr{font-size:52px;font-weight:700;fill:${accent.a}}
    .sl{font-size:25px;fill:${BRAND.tx2};letter-spacing:.06em}
    .qc{font-size:19px;letter-spacing:.18em;fill:${BRAND.tx3};font-family:${BRAND.mono}}
  </style>
</defs>

<rect width="${W}" height="${H}" fill="url(#bgG)"/>
<rect width="${W}" height="${H}" fill="url(#grid)"/>
<rect width="${W}" height="${H}" fill="url(#glow)"/>
<rect x="${W - 300}" y="0" width="2" height="300" fill="url(#beam)"/>

<!-- ⑤ 主活动主题元素：名称 / 口号标识 / 日期 / 徽章 -->
<g>
  <rect x="${CX}" y="72" width="152" height="46" rx="6" fill="none" stroke="${accent.a}" stroke-opacity=".45"/>
  <text x="${CX + 22}" y="103" class="bs">${esc(BRAND.event)}</text>
  <text x="${CX + 176}" y="105" class="bn">${esc(BRAND.name)}</text>
  <text x="${W - CX}" y="104" class="lb" text-anchor="end">${esc(BRAND.date)}</text>
  <rect x="${CX}" y="146" width="${W - CX * 2}" height="1" fill="${accent.a}" fill-opacity=".22"/>
</g>

<!-- ① 创作者姓名（字号自适应：姓名上限 24 字，固定 52px 会直接冲出画布右缘） -->
<g>
  <text x="${CX}" y="212" class="ck">C R E A T O R</text>
  <text x="${CX}" y="272" class="cr" font-size="${nameSize}">${esc(work.creator)}</text>
</g>

<!-- ③ 作品画面示意 -->
${cover.body}

<!-- ② 作品主题 + 一句话亮点 -->
${titleSvg}
${tagSvg}

<!-- ④ 体验二维码 -->
<g transform="translate(${qrX} ${qrY})">
  <rect x="-14" y="-14" width="${qrPx + 28}" height="${qrPx + 28}" rx="14" fill="#ffffff"/>
  <path d="${qrPath}" fill="#04070d"/>
</g>
<!-- 说明文字用 text-anchor=end 贴住二维码右缘。
     早先写成 middle + 手工空格 + letter-spacing，字距会把整串推出画布右边缘。 -->
<text x="${qrX + qrPx}" y="${qrY + qrPx + 42}" class="qc" text-anchor="end">SCAN TO VISIT</text>

<!-- 口号 -->
<g>
  <rect x="${CX}" y="1150" width="66" height="4" rx="2" fill="${accent.a}"/>
  <text x="${CX}" y="1212" class="sl">${esc(BRAND.slogan)}</text>
  <text x="${CX}" y="1256" class="qc">${esc(BRAND.en)}</text>
  <text x="${CX}" y="1316" class="lb" font-size="19">扫右侧二维码，立刻打开</text>
</g>
</svg>`;
}

/** HTML 分享页：发给好友点开就是这个 */
export function posterHtml(work, origin) {
  const accent = accentOf(work.accent || 0);
  const siteUrl = `${origin}/u/${work.slug}/`;
  const posterImg = work.poster ? `${origin}/r2/${work.poster}` : `${origin}/p/${work.id}.svg`;
  const qr = qrSvg(siteUrl, { size: 180, quiet: 4, dark: '#04070d', light: '#ffffff' });

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
  min-height:100vh;display:flex;flex-direction:column;align-items:center;
  padding:26px 16px 60px;
  background-image:radial-gradient(700px 400px at 80% -5%,${accent.a}1f,transparent 62%)}
.card{width:100%;max-width:420px}
.poster{width:100%;border-radius:16px;overflow:hidden;display:block;
  box-shadow:0 24px 70px rgba(0,0,0,.6);border:1px solid ${BRAND.line}}
.hint{margin:18px 2px 0;font-size:13.5px;color:${BRAND.tx3};line-height:1.75;text-align:center}
.acts{display:flex;gap:10px;margin-top:20px}
.btn{flex:1;text-align:center;text-decoration:none;padding:14px 10px;border-radius:11px;
  font-size:15px;font-weight:650;border:1px solid ${accent.a}55;color:${accent.a};
  background:${accent.a}14}
.btn.solid{background:${accent.a};color:#04070d;border-color:${accent.a}}
.meta{margin-top:26px;padding-top:20px;border-top:1px solid rgba(217,226,234,.09);
  display:flex;align-items:center;gap:14px}
.meta .qr{width:74px;height:74px;border-radius:8px;overflow:hidden;flex:0 0 74px;background:#fff;padding:4px}
.meta .qr svg{width:100%;height:100%;display:block}
.meta .t{flex:1;min-width:0}
.meta .t b{display:block;font-size:14.5px;margin-bottom:4px}
.meta .t span{font-size:12px;color:${BRAND.tx3};word-break:break-all;font-family:${BRAND.mono}}
.foot{margin-top:30px;text-align:center;font-size:12px;color:${BRAND.tx3};
  font-family:${BRAND.mono};letter-spacing:.14em;line-height:2}
</style></head><body>
<div class="card">
  <img class="poster" src="${posterImg}" alt="${esc(work.title)} 分享海报">
  <p class="hint">长按图片保存 · 分享给好友<br>或直接点下面的按钮打开这个网站</p>
  <div class="acts">
    <a class="btn solid" href="${siteUrl}">打开作品</a>
    <a class="btn" href="${origin}/">去大厅看看</a>
  </div>
  <div class="meta">
    <div class="qr">${qr}</div>
    <div class="t"><b>扫码直达</b><span>${esc(siteUrl)}</span></div>
  </div>
  <div class="foot">${esc(BRAND.name)} · ${esc(BRAND.date)}<br>${esc(BRAND.slogan)}</div>
</div>
</body></html>`;
}
