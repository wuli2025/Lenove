/* 幸福小事 · 同步端点
   ─────────────────────────────────────────────────────────────
   这里只经手两样东西：
     id   —— 客户端把同步码做 SHA-256 之后的 64 位十六进制，反推不出原码
     body —— 客户端用同步码派生的密钥做过 AES-GCM 加密的密文
   服务端没有解密能力，R2 里躺的是一堆看不懂的字节。
   ───────────────────────────────────────────────────────────── */

const MAX_BYTES = 2 * 1024 * 1024;          // 单份快照上限 2MB
const ID_RE = /^[0-9a-f]{64}$/;

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

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ params, env }) {
  const id = String(params.id || '').toLowerCase();
  if (!ID_RE.test(id)) return json({ ok: false, error: 'bad_id' }, 400);

  const obj = await env.SYNC.get(`s/${id}`);
  if (!obj) return json({ ok: true, found: false });

  return new Response(obj.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Snapshot-Ts': obj.customMetadata?.ts || '0',
      ...CORS,
    },
  });
}

export async function onRequestPut({ params, request, env }) {
  const id = String(params.id || '').toLowerCase();
  if (!ID_RE.test(id)) return json({ ok: false, error: 'bad_id' }, 400);

  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BYTES) return json({ ok: false, error: 'too_large' }, 413);

  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0) return json({ ok: false, error: 'empty' }, 400);
  if (buf.byteLength > MAX_BYTES) return json({ ok: false, error: 'too_large' }, 413);

  const ts = String(Date.now());
  await env.SYNC.put(`s/${id}`, buf, {
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: { ts },
  });
  return json({ ok: true, ts: Number(ts), bytes: buf.byteLength });
}

export async function onRequestDelete({ params, env }) {
  const id = String(params.id || '').toLowerCase();
  if (!ID_RE.test(id)) return json({ ok: false, error: 'bad_id' }, 400);
  await env.SYNC.delete(`s/${id}`);
  return json({ ok: true });
}
