/**
 * 大厅 API —— 桌面端发布作品、大厅拉列表、作品页记点击。
 * 数据落 D1，静态产物落 R2，两边通过 slug 关联。
 */
import { hashStr } from './brand.js';
import { toPinyin } from './pinyin.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
};

export const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });

export const bad = (msg, status = 400) => json({ ok: false, error: msg }, status);

/** 只认真实位图魔数；扩展名、Content-Type 和调用方声明都不作为证据。 */
export function rasterType(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input || 0);
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return { ext: 'png', mime: 'image/png' };
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return { ext: 'webp', mime: 'image/webp' };
  }
  return null;
}

/** 22 位 base36 短 id，够用且不暴露顺序 */
export function shortId() {
  const b = crypto.getRandomValues(new Uint8Array(8));
  let s = '';
  for (const x of b) s += x.toString(36).padStart(2, '0');
  return s.slice(0, 12);
}

/**
 * 姓名 → 站点 slug。
 *
 * 老版本把中文整段丢掉，「张三」只剩 `w-tfrx9`，可我们对现场每个人承诺的是
 * 「专属网址」—— 一串乱码没法念也没法发出去，等于承诺没兑现。
 * 现在先走 src/pinyin.js 的内置小表转拼音：张三 → zhangsan-2f7a1、
 * 李小明 → lixiaoming-x8k2p、Anna 李 → anna-li-9dq3m。
 *
 * 几个必须守住的点：
 *   - 结果永远要满足 SLUG_RE（/^[a-z0-9][a-z0-9-]{0,62}$/），这是 D1 和路由的共同前提
 *   - 截断到 24 字符后可能把尾巴切在连字符上（如 `ouyang-` ），要再收一次边，
 *     否则会拼出 `ouyang--2f7a1` 这种双连字符，难看且容易和分隔符逻辑打架
 *   - 5 位哈希短码保持不变：同名同姓在现场不是小概率事件，靠它防 UNIQUE 冲突
 *   - 一个拼音都转不出来（纯 emoji / 纯符号）时，退回老的 `w-<hash>` 兜底
 */
export function makeSlug(creator, title) {
  const name = toPinyin(String(creator || ''))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, ''); // 截断可能正好切在连字符上，补一刀
  const tail = hashStr(`${creator}|${title}|${Date.now()}`).toString(36).slice(0, 5);
  return name ? `${name}-${tail}` : `w-${tail}`;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** 访客指纹：IP + UA 取哈希，不落原始信息 */
export function visitorHash(request) {
  const ip =
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for') ||
    '0.0.0.0';
  const ua = request.headers.get('user-agent') || '';
  return hashStr(`${ip}|${ua}`).toString(36);
}

// ───────────────────────── 发布作品 ─────────────────────────

export async function createWork(request, env) {
  const token = request.headers.get('x-publish-token') || '';
  if (!env.PUBLISH_TOKEN || token !== env.PUBLISH_TOKEN) {
    return bad('发布令牌无效', 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return bad('请求体不是合法 JSON');
  }

  const creator = String(body.creator || '').trim();
  const title = String(body.title || '').trim();
  const tagline = String(body.tagline || '').trim();

  // 姓名是硬性要求：现场每个人开始创作前必须先填
  if (!creator) return bad('缺少创作者姓名（creator）');
  if (creator.length > 24) return bad('姓名过长（最多 24 字）');
  if (!title) return bad('缺少作品主题（title）');
  if (title.length > 40) return bad('作品主题过长（最多 40 字）');
  if (tagline.length > 60) return bad('亮点描述过长（最多 60 字）');

  let slug = String(body.slug || '').trim().toLowerCase();
  if (slug) {
    if (!SLUG_RE.test(slug)) return bad('slug 不合法（只允许小写字母、数字、连字符）');
  } else {
    slug = makeSlug(creator, title);
  }

  const id = shortId();
  const accent = hashStr(title + creator) % 6;
  const now = Date.now();

  try {
    await env.DB.prepare(
      `INSERT INTO works (id, slug, creator, title, tagline, cover, poster, accent, hits, status, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, 0, 'draft', ?)`
    )
      .bind(id, slug, creator, title, tagline, accent, now)
      .run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) return bad('该 slug 已被占用，换一个', 409);
    throw e;
  }

  const origin = new URL(request.url).origin;
  return json({
    ok: true,
    id,
    slug,
    siteUrl: `${origin}/u/${slug}/`,
    posterUrl: `${origin}/p/${id}`,
    hallUrl: `${origin}/hall`,
  });
}

/** 补充资源：桌面端截完图 / 渲完海报后回填 */
export async function patchWork(request, env, id) {
  const token = request.headers.get('x-publish-token') || '';
  if (!env.PUBLISH_TOKEN || token !== env.PUBLISH_TOKEN) return bad('发布令牌无效', 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return bad('请求体不是合法 JSON');
  }

  // 普通 PATCH 只能隐藏，不能把 draft 直接改成 public 绕过 R2 完整性校验。
  if (body.status !== undefined && body.status !== 'hidden') {
    return bad('status 只能设为 hidden；公开作品必须调用 finalize');
  }
  // cover / poster 存的是 R2 key，必须限定前缀与字符，别让它变成任意写入口
  for (const k of ['cover', 'poster']) {
    if (body[k] !== undefined && body[k] !== null) {
      const v = String(body[k]);
      const prefix = k === 'cover' ? 'covers/' : 'posters/';
      if (!v.startsWith(prefix) || v.includes('..') || !/^[a-z0-9/_.-]+$/i.test(v)) {
        return bad(`${k} 必须是 ${prefix} 下的合法 key`);
      }
    }
  }

  const sets = [];
  const vals = [];
  for (const k of ['cover', 'poster', 'status']) {
    if (body[k] !== undefined) {
      sets.push(`${k} = ?`);
      vals.push(body[k]);
    }
  }
  if (!sets.length) return bad('没有可更新的字段');
  vals.push(id);

  const r = await env.DB.prepare(`UPDATE works SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  if (!r.meta.changes) return bad('作品不存在', 404);
  return json({ ok: true });
}

/**
 * 唯一允许 draft → public 的入口。
 * 公开前必须确认首页与真实位图封面都已经进入 R2，避免大厅出现 404 / SVG 假封面。
 */
export async function finalizeWork(request, env, id) {
  const token = request.headers.get('x-publish-token') || '';
  if (!env.PUBLISH_TOKEN || token !== env.PUBLISH_TOKEN) return bad('发布令牌无效', 401);

  const w = await env.DB.prepare(
    `SELECT id, slug, cover, status FROM works WHERE id = ?`,
  ).bind(id).first();
  if (!w) return bad('作品不存在', 404);
  if (w.status === 'public') return json({ ok: true, alreadyPublic: true });
  if (w.status !== 'draft') return bad('只有 draft 作品可以公开', 409);
  if (!w.cover || !String(w.cover).startsWith(`covers/${id}.`)) {
    return bad('缺少该作品的真实封面，不能公开', 409);
  }

  const indexKey = `sites/${w.slug}/index.html`;
  if (!(await env.SITES.head(indexKey))) return bad('站点首页尚未上传，不能公开', 409);

  const cover = await env.SITES.get(w.cover);
  if (!cover) return bad('封面对象尚未上传，不能公开', 409);
  const bytes = await cover.arrayBuffer();
  const raster = rasterType(bytes);
  if (!raster) return bad('封面不是有效的 PNG/JPEG/WebP 位图', 409);
  if (cover.httpMetadata?.contentType && cover.httpMetadata.contentType !== raster.mime) {
    return bad('封面 Content-Type 与真实字节不一致', 409);
  }

  const r = await env.DB.prepare(
    `UPDATE works SET status = 'public' WHERE id = ? AND status = 'draft'`,
  ).bind(id).run();
  if (!r.meta.changes) return bad('作品状态已变化，请刷新后重试', 409);

  const origin = new URL(request.url).origin;
  return json({
    ok: true,
    siteUrl: `${origin}/u/${w.slug}/`,
    posterUrl: `${origin}/p/${id}`,
    hallUrl: `${origin}/hall`,
  });
}

// ───────────────────────── 读取 ─────────────────────────

/** 热度 = 点击数 / (小时数+2)^1.2 —— 加时间衰减，新作品才有机会往上冒 */
export function heat(w, now = Date.now()) {
  const hours = Math.max(0, (now - w.created_at) / 3600000);
  return w.hits / Math.pow(hours + 2, 1.2);
}

export async function listWorks(request, env) {
  const url = new URL(request.url);
  const sort = url.searchParams.get('sort') === 'new' ? 'new' : 'hot';
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 60));

  // 现场量级（几百条）直接全取回来在 JS 里排，避免把衰减公式塞进 SQL
  const { results } = await env.DB.prepare(
    `SELECT id, slug, creator, title, tagline, cover, poster, accent, hits, created_at
       FROM works WHERE status = 'public' AND cover IS NOT NULL
      ORDER BY created_at DESC LIMIT 500`
  ).all();

  const now = Date.now();
  const rows = results || [];
  if (sort === 'hot') rows.sort((a, b) => heat(b, now) - heat(a, now) || b.created_at - a.created_at);

  return json({
    ok: true,
    sort,
    total: rows.length,
    works: rows.slice(0, limit).map((w) => ({ ...w, heat: Number(heat(w, now).toFixed(4)) })),
  });
}

export async function getWork(env, id) {
  return env.DB.prepare(
    `SELECT id, slug, creator, title, tagline, cover, poster, accent, hits, status, created_at
       FROM works WHERE id = ?`
  )
    .bind(id)
    .first();
}

export async function getWorkBySlug(env, slug) {
  return env.DB.prepare(
    `SELECT id, slug, creator, title, tagline, cover, poster, accent, hits, status, created_at
       FROM works WHERE slug = ?`
  )
    .bind(slug)
    .first();
}

// ───────────────────────── 点击计数 ─────────────────────────

const HIT_WINDOW_MS = 30 * 60 * 1000;

/**
 * 记一次点击。同一访客对同一作品 30 分钟内只计一次。
 * 用 INSERT ... ON CONFLICT DO UPDATE WHERE 的写法把「判重 + 续期」合成一条语句，
 * 靠 meta.changes 判断这次算不算数，避免 read-then-write 的竞态。
 */
export async function recordHit(env, workId, visitor) {
  // 先确认作品存在且在架。
  // hits 表没有外键，早先直接插行会给不存在的 id 留下孤儿行，
  // 而且接口照样返回 counted:true —— 既污染数据也让返回值不可信。
  const w = await env.DB.prepare(
    `SELECT id FROM works WHERE id = ? AND status = 'public'`
  )
    .bind(workId)
    .first();
  if (!w) return false;

  const now = Date.now();
  const r = await env.DB.prepare(
    `INSERT INTO hits (work_id, visitor, at) VALUES (?, ?, ?)
     ON CONFLICT(work_id, visitor) DO UPDATE SET at = excluded.at
       WHERE hits.at < ?`
  )
    .bind(workId, visitor, now, now - HIT_WINDOW_MS)
    .run();

  if (!r.meta.changes) return false; // 窗口内重复访问，不计
  await env.DB.prepare(`UPDATE works SET hits = hits + 1 WHERE id = ?`).bind(workId).run();
  return true;
}

/** 按 slug 取作品（含已下架的），供静态分发做在架判断 */
export async function workStatusBySlug(env, slug) {
  return env.DB.prepare(`SELECT id, status FROM works WHERE slug = ?`).bind(slug).first();
}
