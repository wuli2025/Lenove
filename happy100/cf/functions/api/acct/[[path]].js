/* 幸福小事 · 账号端点
   ─────────────────────────────────────────────────────────────────────
   服务端存三种东西，没有一样是明文：

     e/<sha256(邮箱)>        邮箱占位标记，只用来提示「这个邮箱注册过了」
     p/<sha256(邮箱+密码)>   密码指针：{ dataId, wrapped }
     r/<sha256(恢复码)>      恢复指针：{ dataId, wrapped, passPtr }

   wrapped 是被「密码派生密钥」或「恢复码派生密钥」加密过的数据主密钥。
   服务端拿不到密码、拿不到恢复码，也就永远解不开 wrapped，
   自然也读不到 d/<dataId> 里那坨密文。

   指针 id 是 email+password 一起哈希出来的 —— 只知道邮箱定位不到任何数据。
   ───────────────────────────────────────────────────────────────────── */

const ID_RE = /^[0-9a-f]{64}$/;
const MAX_BYTES = 8 * 1024;

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

/** /api/acct/<kind>/<id>  →  kind ∈ exists | ptr */
function route(params) {
  const parts = Array.isArray(params.path) ? params.path : String(params.path || '').split('/');
  const [kind, id] = parts;
  if (kind !== 'exists' && kind !== 'ptr') return null;
  if (!ID_RE.test(String(id || '').toLowerCase())) return null;
  return { kind, key: (kind === 'exists' ? 'e/' : 'p/') + String(id).toLowerCase() };
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ params, env }) {
  const r = route(params);
  if (!r) return json({ ok: false, error: 'bad_request' }, 400);

  const obj = await env.SYNC.get(r.key);
  if (r.kind === 'exists') return json({ ok: true, exists: !!obj });
  if (!obj) return json({ ok: true, found: false });
  return json({ ok: true, found: true, record: JSON.parse(await obj.text()) });
}

export async function onRequestPut({ params, request, env }) {
  const r = route(params);
  if (!r) return json({ ok: false, error: 'bad_request' }, 400);

  if (r.kind === 'exists') {
    const existing = await env.SYNC.get(r.key);
    if (existing) return json({ ok: true, exists: true, created: false });
    await env.SYNC.put(r.key, JSON.stringify({ at: Date.now() }));
    return json({ ok: true, exists: true, created: true });
  }

  const text = await request.text();
  if (!text || text.length > MAX_BYTES) return json({ ok: false, error: 'bad_size' }, 413);

  let rec;
  try { rec = JSON.parse(text); } catch { return json({ ok: false, error: 'bad_json' }, 400); }
  if (!ID_RE.test(String(rec.dataId || '')) || typeof rec.wrapped !== 'string') {
    return json({ ok: false, error: 'bad_record' }, 400);
  }

  await env.SYNC.put(r.key, JSON.stringify(rec), {
    httpMetadata: { contentType: 'application/json' },
  });
  return json({ ok: true });
}

export async function onRequestDelete({ params, env }) {
  const r = route(params);
  if (!r) return json({ ok: false, error: 'bad_request' }, 400);
  await env.SYNC.delete(r.key);
  return json({ ok: true });
}
