/**
 * 全站共享外壳 —— 顶栏 + 基础样式。
 * 顶栏结构照搬 FORMA 个人网站模板：左品牌 / 中主导航 / 右操作区（含头像入口）。
 * 首页、大厅、个人中心、作品页共用同一份，保证四个页面看起来是一个产品。
 */
import { BRAND, esc } from './brand.js';

/** 头像：有头像图用图，没有就用姓名首字 + 渐变底 */
function avatarMarkup(user) {
  if (!user) return `<span class="ava-anon">登录</span>`;
  if (user.avatar) {
    return `<img src="${esc(user.avatar)}" alt="${esc(user.name)}">`;
  }
  const initial = esc(String(user.name || '?').trim().slice(0, 1));
  return `<span>${initial}</span>`;
}

/**
 * @param {'home'|'hall'|'me'} active 当前页
 * @param {{name:string,avatar?:string}|null} user 已登录用户
 */
export function topbar(active, user) {
  const nav = [
    ['home', '/', '⌂', '创作'],
    ['hall', '/hall', '◇', '大厅'],
  ];
  return `<header class="topbar">
  <a class="brand" href="/" aria-label="${esc(BRAND.name)} 首页">
    <span class="brand-mark"><i></i><i></i><i></i></span>
    <span>${esc(BRAND.name)}</span><em>°</em>
  </a>
  <nav class="main-nav" aria-label="主导航">
    ${nav.map(([k, href, icon, label]) =>
      `<a class="${active === k ? 'active' : ''}" href="${href}"><span>${icon}</span> ${label}</a>`
    ).join('')}
  </nav>
  <div class="nav-actions">
    <span class="tagline desktop-only">${esc(BRAND.slogan)}</span>
    <a class="avatar-button${user ? '' : ' anon'}${active === 'me' ? ' active' : ''}"
       href="/me" aria-label="个人中心" title="${user ? esc(user.name) + ' · 个人中心' : '登录 / 个人中心'}">
      ${avatarMarkup(user)}
    </a>
  </div>
</header>`;
}

/** 全站基础样式（含顶栏）。各页面再各自补自己的部分。 */
export function baseCss() {
  return `
:root{
  --bg:${BRAND.bg}; --bg2:${BRAND.bg2};
  --text:${BRAND.tx}; --muted:${BRAND.tx2}; --muted-light:#a9bccb; --dim:${BRAND.tx3};
  --acid:${BRAND.cy}; --gold:${BRAND.am};
  --line:rgba(217,226,234,.10); --line-strong:rgba(102,217,232,.34);
  --sans:${BRAND.font}; --mono:${BRAND.mono};
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{background:var(--bg);color:var(--text);font-family:var(--sans);
  -webkit-font-smoothing:antialiased;line-height:1.7}
a{color:inherit;text-decoration:none}
button{font-family:inherit}

/* ── 顶栏（结构与尺寸沿用 FORMA） ── */
.topbar{position:sticky;top:0;z-index:50;display:grid;grid-template-columns:1fr auto 1fr;
  align-items:center;min-height:72px;padding:0 28px;border-bottom:1px solid var(--line);
  background:color-mix(in srgb, var(--bg) 86%, transparent);backdrop-filter:blur(24px)}
.brand{display:inline-flex;align-items:center;justify-self:start;gap:10px;width:fit-content;
  font-size:20px;font-weight:700;letter-spacing:-.05em}
.brand em{margin:-12px 0 0 -8px;color:var(--acid);font-style:normal}
.brand-mark{position:relative;display:inline-block;width:23px;height:23px}
.brand-mark i{position:absolute;width:14px;height:18px;border-radius:50% 52% 46% 50%;transform-origin:60% 65%}
.brand-mark i:nth-child(1){top:0;left:0;background:#66d9e8;transform:rotate(-24deg)}
.brand-mark i:nth-child(2){top:0;right:0;background:#b58ae0;transform:rotate(22deg)}
.brand-mark i:nth-child(3){right:4px;bottom:-1px;background:#f0d08a;transform:rotate(152deg);mix-blend-mode:screen}
.main-nav{display:flex;align-items:center;justify-self:center;gap:4px;padding:4px;
  border:1px solid var(--line);border-radius:14px;background:rgba(255,255,255,.025)}
.main-nav a{display:flex;align-items:center;gap:7px;min-height:38px;padding:0 15px;border-radius:10px;
  color:var(--muted);font-size:13px;font-weight:600;transition:180ms ease}
.main-nav a:hover,.main-nav a.active{color:var(--text);background:rgba(255,255,255,.08)}
.main-nav span{font-size:15px}
.nav-actions{display:flex;align-items:center;justify-self:end;gap:10px}
.tagline{font-size:12px;color:var(--dim);letter-spacing:.04em}
.avatar-button{display:flex;align-items:center;justify-content:center;width:40px;height:40px;
  border:1px solid transparent;border-radius:12px;overflow:hidden;
  color:#04070d;background:linear-gradient(135deg,#66d9e8,#b58ae0);
  font-size:13px;font-weight:800;letter-spacing:.04em;transition:180ms ease}
.avatar-button img{width:100%;height:100%;object-fit:cover}
.avatar-button.anon{background:rgba(255,255,255,.025);border-color:var(--line);color:var(--muted-light);
  width:auto;padding:0 14px;font-size:12px;font-weight:600;letter-spacing:0}
.avatar-button:hover{border-color:var(--line-strong);filter:brightness(1.06)}
.avatar-button.active{outline:2px solid var(--acid);outline-offset:2px}

@media(max-width:900px){
  .topbar{grid-template-columns:auto 1fr auto;min-height:64px;padding:0 16px}
  .brand{font-size:16px}
  .brand-mark{transform:scale(.85)}
  .main-nav{border:0;background:transparent}
  .main-nav a{padding:0 10px}
  .desktop-only{display:none}
}`;
}

/** 统一的页面骨架，避免每个页面各写一份 <head> */
export function page({ title, desc, active, user, css = '', body, script = '' }) {
  return `<!DOCTYPE html><html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc || BRAND.slogan)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc || BRAND.slogan)}">
<style>${baseCss()}${css}</style>
</head><body>
${topbar(active, user)}
${body}
${script ? `<script>${script}</script>` : ''}
</body></html>`;
}
