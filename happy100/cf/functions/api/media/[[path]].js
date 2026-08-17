/* 幸福小事 · 图片 / 视频端点
   ─────────────────────────────────────────────────────────────────────
   和 /api/sync 一样，服务端只是个仓库，看不懂里面装了什么。

     m/<dataId>/<mediaId>      一张照片或一段视频（客户端 AES-GCM 加密过）
     m/<dataId>/<mediaId>.t    它的小缩略图（同样是密文）

   dataId  是账号的数据地址（64 位十六进制），和 /api/sync 用的是同一个。
   mediaId 是客户端随机生成的 32 位十六进制，和内容、时间都无关。

   服务端没有密钥，拿到的永远是一坨看不懂的字节。
   路由：
     GET    /api/media/<dataId>              列出这个账号的全部文件（只有 id/大小/时间）
     DELETE /api/media/<dataId>              清空这个账号的全部文件
     GET    /api/media/<dataId>/<mediaId>    取一份密文
     PUT    /api/media/<dataId>/<mediaId>    存一份密文
     DELETE /api/media/<dataId>/<mediaId>    删一份密文

   防滥用：必须是真实存在的账号（s/<dataId> 得先有快照），
   同一账号每天最多传 200 个文件，全站每天最多 4000 个。
   ───────────────────────────────────────────────────────────────────── */

const ID_RE  = /^[0-9a-f]{64}$/;
const MID_RE = /^[0-9a-f]{32}(\.t)?$/;

const MAX_BYTES     = 30 * 1024 * 1024;   // 单个文件上限（含加密开销）
const PER_ACCT_DAY  = 200;
const GLOBAL_DAY    = 4000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
  });

/** /api/media/<dataId>[/<mediaId>] */
function route(params) {
  const parts = (Array.isArray(params.path) ? params.path : String(params.path || '').split('/'))
    .filter(Boolean);
  const dataId = String(parts[0] || '').toLowerCase();
  if (!ID_RE.test(dataId)) return null;

  if (parts.length === 1) return { dataId, prefix: `m/${dataId}/` };

  const mediaId = String(parts[1] || '').toLowerCase();
  if (parts.length !== 2 || !MID_RE.test(mediaId)) return null;
  return { dataId, mediaId, key: `m/${dataId}/${mediaId}` };
}

/* 每天的次数上限，和发信用的是同一套计数 */
async function bump(env, key, limit) {
  const day = new Date().toISOString().slice(0, 10);
  const k = `q/${day}/${key}`;
  const cur = await env.SYNC.get(k);
  const n = cur ? Number(await cur.text()) || 0 : 0;
  if (n >= limit) return false;
  await env.SYNC.put(k, String(n + 1));
  return true;
}

/* 把一个前缀下的对象全部列出来（R2 单次最多 1000，这里翻页翻到底） */
async function listAll(env, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await env.SYNC.list({ prefix, limit: 1000, cursor });
    page.objects.forEach(o => out.push({
      id: o.key.slice(prefix.length),
      size: o.size,
      ts: Number(o.customMetadata?.ts || 0) || Date.parse(o.uploaded) || 0,
    }));
    cursor = page.truncated ? page.cursor : null;
  } while (cursor);
  return out;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ params, env }) {
  const r = route(params);
  if (!r) return json({ ok: false, error: 'bad_request' }, 400);

  // 不带 mediaId：列清单，用来核对云端到底还剩哪些、占了多少
  if (!r.mediaId) {
    const items = listAllOnlyMain(await listAll(env, r.prefix));
    return json({
      ok: true,
      items,
      count: items.length,
      bytes: items.reduce((s, o) => s + o.size, 0),
    });
  }

  const obj = await env.SYNC.get(r.key);
  if (!obj) return json({ ok: true, found: false }, 404);

  return new Response(obj.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Media-Ts': obj.customMetadata?.ts || '0',
      ...CORS,
    },
  });
}

/* 清单里把缩略图折进主文件，省得客户端自己配对 */
function listAllOnlyMain(all) {
  const thumbs = new Set(all.filter(o => o.id.endsWith('.t')).map(o => o.id.slice(0, -2)));
  return all
    .filter(o => !o.id.endsWith('.t'))
    .map(o => ({ ...o, thumb: thumbs.has(o.id) }))
    .sort((a, b) => a.ts - b.ts);
}

export async function onRequestPut({ params, request, env }) {
  const r = route(params);
  if (!r || !r.mediaId) return json({ ok: false, error: 'bad_request' }, 400);

  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BYTES) return json({ ok: false, error: 'too_large' }, 413);

  // 必须是真实存在的账号：客户端拿到 no_account 会先推一次快照再重试
  const acct = await env.SYNC.head(`s/${r.dataId}`);
  if (!acct) return json({ ok: false, error: 'no_account' }, 403);

  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0) return json({ ok: false, error: 'empty' }, 400);
  if (buf.byteLength > MAX_BYTES) return json({ ok: false, error: 'too_large' }, 413);

  // 覆盖已有的同一个 id 不再重复计数（断线重传很常见）
  const already = await env.SYNC.head(r.key);
  if (!already) {
    if (!await bump(env, 'mg', GLOBAL_DAY))                  return json({ ok: false, error: 'global_limit' }, 429);
    if (!await bump(env, `m-${r.dataId}`, PER_ACCT_DAY))     return json({ ok: false, error: 'rate_limit' }, 429);
  }

  const ts = String(Date.now());
  await env.SYNC.put(r.key, buf, {
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: { ts },
  });
  return json({ ok: true, ts: Number(ts), bytes: buf.byteLength });
}

export async function onRequestDelete({ params, env }) {
  const r = route(params);
  if (!r) return json({ ok: false, error: 'bad_request' }, 400);

  if (!r.mediaId) {
    const all = await listAll(env, r.prefix);
    // R2 的批量删除一次最多 1000 个
    for (let i = 0; i < all.length; i += 1000) {
      await env.SYNC.delete(all.slice(i, i + 1000).map(o => r.prefix + o.id));
    }
    return json({ ok: true, deleted: all.length });
  }

  // 删主文件时把缩略图一起带走
  await env.SYNC.delete(r.mediaId.endsWith('.t') ? r.key : [r.key, r.key + '.t']);
  return json({ ok: true });
}
