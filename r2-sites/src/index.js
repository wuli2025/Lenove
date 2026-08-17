/**
 * 一句话生成 · 服务端
 *
 *   /                    作品大厅（服务端直出，最热 / 最新）
 *   /api/works           GET 列表 · POST 发布（需 x-publish-token）
 *   /api/works/<id>      GET 详情 · PATCH 回填封面/海报
 *   /api/works/<id>/hit  POST 记一次点击
 *   /p/<id>              分享海报页（发微信好友打开就是这个）
 *   /p/<id>.svg          自包含海报 SVG
 *   /qr?d=<url>          二维码 SVG
 *   /r2/<key>            封面 / 海报等媒体（限定前缀）
 *   /u/<slug>/<path...>  用户站点静态分发（R2 子路径方案）
 *
 * 静态分发部分的设计要点（每条都对应一个真实的坑）：
 *  1. 一律流式返回 R2 body，绝不 await obj.text()——后者会把整个文件读进 128MB 隔离区内存。
 *  2. 先查 Cache API，能省掉 R2 读取(Class B)和大部分 CPU，但【省不掉 Worker 请求计费】——
 *     Worker 跑在 Cloudflare 缓存之前，缓存是在 Worker 内部查的。实测 10 次请求 = 10 次调用。
 *  3. 处理 If-None-Match，命中直接 304。
 *  4. html 短缓存（改完就能看到），带内容哈希的资源长缓存 + immutable。
 */
import { hallHtml } from './hall.js';
import { homeHtml } from './home.js';
import { meHtml, currentUser } from './me.js';
import { authRoutes } from './auth.js';
import { posterHtml, posterSvg } from './poster.js';
import { qrSvg } from './qr.js';
import {
  json, bad, createWork, patchWork, listWorks, getWork, recordHit, workStatusBySlug, visitorHash, heat,
} from './api.js';

const IMMUTABLE = 'public, max-age=31536000, immutable';
const HTML_CACHE = 'public, max-age=60, stale-while-revalidate=86400';
const ASSET_CACHE = 'public, max-age=86400';

const MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', avif: 'image/avif', gif: 'image/gif', ico: 'image/x-icon',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg',
  woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf',
  txt: 'text/plain; charset=utf-8', xml: 'application/xml; charset=utf-8', pdf: 'application/pdf',
};

const extOf = (p) => {
  const i = p.lastIndexOf('.');
  return i < 0 ? '' : p.slice(i + 1).toLowerCase();
};
const isFingerprinted = (p) => /[.-][0-9a-f]{8,}\.[a-z0-9]+$/i.test(p);

function cacheControlFor(key) {
  const ext = extOf(key);
  if (ext === 'html' || ext === 'htm') return HTML_CACHE;
  if (isFingerprinted(key)) return IMMUTABLE;
  return ASSET_CACHE;
}

function resolveKey(pathname) {
  const m = pathname.match(/^\/u\/([a-z0-9][a-z0-9-]{0,62})(\/.*)?$/i);
  if (!m) return null;
  const site = m[1].toLowerCase();
  let rest = m[2] || '/';
  if (rest.includes('..') || rest.includes('//')) return null;
  if (rest.endsWith('/')) rest += 'index.html';
  else if (!extOf(rest)) rest += '/index.html';
  return { site, key: `sites/${site}${rest}` };
}

function buildHeaders(obj, key, extra = {}) {
  const h = new Headers();
  h.set('Content-Type', obj.httpMetadata?.contentType || MIME[extOf(key)] || 'application/octet-stream');
  h.set('Cache-Control', obj.httpMetadata?.cacheControl || cacheControlFor(key));
  if (obj.httpEtag) h.set('ETag', obj.httpEtag);
  if (obj.uploaded) h.set('Last-Modified', obj.uploaded.toUTCString());
  if (obj.size != null) h.set('Content-Length', String(obj.size));
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return h;
}

const html = (body, status = 200, cache = 'public, max-age=30') =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': cache } });

const svg = (body, cache = 'public, max-age=300') =>
  new Response(body, { status: 200, headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': cache } });

// ───────────────────────── 静态站分发 ─────────────────────────
async function serveSite(request, env, ctx, url, resolved) {
  const { site, key } = resolved;

  // 页面导航要先查在架状态，且必须查在读缓存之前。
  //
  // 「下架」原本只影响大厅列表，作品站本身照样 200 —— 现场真出内容事故时
  // 等于没有开关。而且如果放到缓存之后再判，已经进过边缘缓存的页面会一直
  // 绕过判断继续对外可见。代价是每次 HTML 请求多一次 D1 读，现场量级可以接受。
  //
  // 注意：只有在 works 表里登记过的 slug 才受管控，没登记的（比如冒烟用的
  // 测试站点）照常放行，不然会误伤非大厅作品。
  if (extOf(key) === 'html') {
    const w = await workStatusBySlug(env, site);
    if (w && w.status !== 'public') {
      return new Response('该作品已下架', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    if (w && request.method === 'GET') {
      ctx.waitUntil(recordHit(env, w.id, visitorHash(request)).catch(() => {}));
    }
  }

  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) {
    const r = new Response(cached.body, cached);
    r.headers.set('X-Edge-Cache', 'HIT');
    return r;
  }

  const inm = request.headers.get('If-None-Match');
  if (inm) {
    const head = await env.SITES.head(key);
    if (head && head.httpEtag === inm) {
      return new Response(null, { status: 304, headers: buildHeaders(head, key, { 'X-Edge-Cache': 'REVALIDATED' }) });
    }
  }

  const obj = await env.SITES.get(key);
  if (!obj) {
    const fallback = await env.SITES.get(`sites/${site}/404.html`);
    if (!fallback) return new Response('Not Found', { status: 404 });
    return new Response(fallback.body, {
      status: 404,
      headers: buildHeaders(fallback, '404.html', { 'Cache-Control': 'no-store', 'X-Edge-Cache': 'MISS' }),
    });
  }

  const headers = buildHeaders(obj, key, { 'X-Edge-Cache': 'MISS' });
  if (request.method === 'HEAD') {
    ctx.waitUntil(obj.body.cancel().catch(() => {}));
    return new Response(null, { status: 200, headers });
  }
  const response = new Response(obj.body, { status: 200, headers });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// ───────────────────────── 上传（走 Worker 代理，不发 S3 密钥）─────────────────────────
/**
 * 桌面端把产物 PUT 到这里，由 Worker 代写 R2。
 *
 * 为什么不让客户端直连 R2 的 S3 接口：那样每台现场笔记本都要配一套 access key，
 * 多一份要管的密钥，而且一旦泄露就是整桶读写权限。走这里只需要一个发布令牌，
 * 权限边界也只有「往约定前缀里写」这一件事。
 */
async function handleUpload(request, env, kind, rest) {
  if (!env.PUBLISH_TOKEN || request.headers.get('x-publish-token') !== env.PUBLISH_TOKEN) {
    return bad('发布令牌无效', 401);
  }
  if (!rest || rest.includes('..') || rest.includes('//') || rest.startsWith('/')) {
    return bad('路径不合法');
  }

  let key;
  if (kind === 'site') {
    const m = rest.match(/^([a-z0-9][a-z0-9-]{0,62})\/(.+)$/i);
    if (!m) return bad('路径应为 <slug>/<文件路径>');
    key = `sites/${m[1].toLowerCase()}/${m[2]}`;
  } else if (kind === 'cover') {
    if (!/^[a-z0-9]+\.(png|jpg|jpeg|webp)$/i.test(rest)) return bad('封面文件名不合法');
    key = `covers/${rest}`;
  } else if (kind === 'poster') {
    if (!/^[a-z0-9]+\.(png|jpg|jpeg)$/i.test(rest)) return bad('海报文件名不合法');
    key = `posters/${rest}`;
  } else {
    return bad('未知的上传类型');
  }

  const ct = request.headers.get('content-type') || MIME[extOf(key)] || 'application/octet-stream';
  const body = await request.arrayBuffer();
  if (body.byteLength === 0) return bad('空文件');
  if (body.byteLength > 25 * 1024 * 1024) return bad('单个文件超过 25MB', 413);

  await env.SITES.put(key, body, {
    httpMetadata: { contentType: ct, cacheControl: cacheControlFor(key) },
  });
  return json({ ok: true, key, size: body.byteLength });
}

// ───────────────────────── 媒体（封面 / 海报）─────────────────────────
async function serveMedia(request, env, ctx, key) {
  // 只开放这两个前缀，避免变成任意读取整个桶的口子
  if (!/^(covers|posters)\//.test(key) || key.includes('..')) {
    return new Response('Not Found', { status: 404 });
  }
  const obj = await env.SITES.get(key);
  if (!obj) return new Response('Not Found', { status: 404 });
  const headers = buildHeaders(obj, key, { 'Cache-Control': 'public, max-age=604800' });
  if (request.method === 'HEAD') {
    ctx.waitUntil(obj.body.cancel().catch(() => {}));
    return new Response(null, { status: 200, headers });
  }
  return new Response(obj.body, { status: 200, headers });
}

/** 把 R2 里的封面转成 data URI，供自包含 SVG 内嵌 */
async function coverDataUri(env, key) {
  if (!key) return null;
  const obj = await env.SITES.get(key);
  if (!obj) return null;
  const buf = await obj.arrayBuffer();
  if (buf.byteLength > 900_000) return null; // 太大就退回生成式示意图，别把海报撑爆
  let bin = '';
  const bytes = new Uint8Array(buf);
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  const mime = obj.httpMetadata?.contentType || MIME[extOf(key)] || 'image/jpeg';
  return `data:${mime};base64,${btoa(bin)}`;
}

// ───────────────────────── 入口 ─────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,PATCH,HEAD,OPTIONS',
          'access-control-allow-headers': 'content-type,x-publish-token',
          'access-control-max-age': '86400',
        },
      });
    }

    try {
      // ── 认证（命中就返回，没命中继续往下）──
      const authed = await authRoutes(request, env, ctx, url);
      if (authed) return authed;

      // ── API ──
      if (path === '/api/works') {
        if (method === 'POST') return await createWork(request, env);
        if (method === 'GET') return await listWorks(request, env);
        return bad('不支持的方法', 405);
      }

      let m = path.match(/^\/api\/works\/([a-z0-9]+)$/i);
      if (m) {
        if (method === 'GET') {
          const w = await getWork(env, m[1]);
          // 带令牌的运维调用要能看到下架作品，公开调用则一律当作不存在
          const isOps = env.PUBLISH_TOKEN && request.headers.get('x-publish-token') === env.PUBLISH_TOKEN;
          if (!w || (w.status !== 'public' && !isOps)) return bad('作品不存在', 404);
          return json({ ok: true, work: { ...w, heat: Number(heat(w).toFixed(4)) } });
        }
        if (method === 'PATCH') return await patchWork(request, env, m[1]);
        return bad('不支持的方法', 405);
      }

      m = path.match(/^\/api\/works\/([a-z0-9]+)\/hit$/i);
      if (m && method === 'POST') {
        const counted = await recordHit(env, m[1], visitorHash(request));
        return json({ ok: true, counted });
      }

      if (path === '/api/health') {
        return json({ ok: true, ts: Date.now() });
      }

      // ── 上传 ──
      m = path.match(/^\/api\/upload\/(site|cover|poster)\/(.+)$/);
      if (m && (method === 'PUT' || method === 'POST')) {
        return await handleUpload(request, env, m[1], decodeURIComponent(m[2]));
      }

      // ── 二维码 ──
      if (path === '/qr') {
        const d = url.searchParams.get('d');
        if (!d) return bad('缺少参数 d');
        if (d.length > 400) return bad('内容过长');
        const size = Math.min(1200, Math.max(80, Number(url.searchParams.get('s')) || 240));
        return svg(qrSvg(d, { size }), 'public, max-age=31536000, immutable');
      }

      // ── 海报 ──
      m = path.match(/^\/p\/([a-z0-9]+)(\.svg)?$/i);
      if (m && (method === 'GET' || method === 'HEAD')) {
        const w = await getWork(env, m[1]);
        // 下架的作品海报也要一起失效，否则分享链接还在外面转
        if (!w || w.status !== 'public') return new Response('Not Found', { status: 404 });
        const siteUrl = `${url.origin}/u/${w.slug}/`;
        if (m[2]) {
          const dataUri = await coverDataUri(env, w.cover);
          return svg(posterSvg(w, siteUrl, dataUri));
        }
        return html(posterHtml(w, url.origin));
      }

      // ── 媒体 ──
      if (path.startsWith('/r2/')) {
        return await serveMedia(request, env, ctx, decodeURIComponent(path.slice(4)));
      }

      // ── 用户站点 ──
      const resolved = resolveKey(path);
      if (resolved) {
        if (method !== 'GET' && method !== 'HEAD') {
          return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
        }
        return await serveSite(request, env, ctx, url, resolved);
      }

      // ── 首页（数字人需求访谈）──
      if (path === '/' && (method === 'GET' || method === 'HEAD')) {
        const user = await currentUser(request, env);
        return html(homeHtml({ user }), 200, 'no-store');
      }

      // ── 个人中心 ──
      if (path === '/me' && (method === 'GET' || method === 'HEAD')) {
        const user = await currentUser(request, env);
        return html(meHtml({ user }), 200, 'no-store');
      }

      // ── 大厅 ──
      if (path === '/hall' && (method === 'GET' || method === 'HEAD')) {
        const sort = url.searchParams.get('sort') === 'new' ? 'new' : 'hot';
        const { results } = await env.DB.prepare(
          `SELECT id, slug, creator, title, tagline, cover, poster, accent, hits, created_at
             FROM works WHERE status = 'public'
            ORDER BY created_at DESC LIMIT 200`
        ).all();
        const now = Date.now();
        const rows = results || [];
        if (sort === 'hot') rows.sort((a, b) => heat(b, now) - heat(a, now) || b.created_at - a.created_at);
        const user = await currentUser(request, env);
        // 顶栏要显示当前登录态，所以不能走公共缓存
        return html(hallHtml(rows, { origin: url.origin, sort, now, user }), 200, 'private, max-age=10');
      }

      return new Response('Not Found', { status: 404 });
    } catch (err) {
      // 现场不能白屏：任何未预期错误都返回可读信息，同时留日志
      console.error('unhandled', path, String(err && err.stack ? err.stack : err));
      return json({ ok: false, error: '服务端错误', detail: String(err && err.message ? err.message : err) }, 500);
    }
  },
};
