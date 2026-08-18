import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createWork, finalizeWork, listWorks, rasterType } from '../src/api.js';

const token = 'unit-publish-token';
const ctx = { waitUntil() {} };
const auth = { 'x-publish-token': token };
const prompt = 'A cinematic editorial photograph of a handmade memory book, no text';

function request(path, init = {}) {
  return new Request(`https://unit.example${path}`, init);
}

function jpegBytes() {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 4]);
}

function pngHeader(width, height) {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

async function body(res) {
  return JSON.parse(await res.text());
}

// 位图魔数是唯一证据；SVG/HTML 即使声称 image/jpeg 也不能通过。
assert.equal(rasterType(jpegBytes()).mime, 'image/jpeg');
assert.equal(rasterType(pngHeader(1080, 1440)).mime, 'image/png');
assert.equal(rasterType(new TextEncoder().encode('<svg></svg>')), null);
assert.equal(rasterType(new TextEncoder().encode('<html>fake image</html>')), null);

// Workers AI 路由：认证、binding、JPEG 响应和伪装结果。
{
  let res = await worker.fetch(request('/api/images/generate', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt }),
  }), { PUBLISH_TOKEN: token }, ctx);
  assert.equal(res.status, 401);

  res = await worker.fetch(request('/api/images/generate', {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ prompt }),
  }), { PUBLISH_TOKEN: token }, ctx);
  assert.equal(res.status, 503);

  const env = {
    PUBLISH_TOKEN: token,
    AI: { run: async () => ({ image: Buffer.from(jpegBytes()).toString('base64') }) },
  };
  res = await worker.fetch(request('/api/images/generate', {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ prompt }),
  }), env, ctx);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^image\/jpeg/);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), jpegBytes());

  env.AI.run = async () => ({ image: Buffer.from('<svg></svg>').toString('base64') });
  res = await worker.fetch(request('/api/images/generate', {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ prompt }),
  }), env, ctx);
  assert.equal(res.status, 502);
}

// 新建记录必须是 draft，不能在上传前直接公开。
{
  let insertSql = '';
  let insertArgs = [];
  const env = {
    PUBLISH_TOKEN: token,
    DB: {
      prepare(sql) {
        insertSql = sql;
        return {
          bind: (...args) => {
            insertArgs = args;
            return { run: async () => ({ meta: { changes: 1 } }) };
          },
        };
      },
    },
  };
  const res = await createWork(request('/api/works', {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      creator: '测试者', title: '真实位图作品', tagline: '一句亮点',
      cover: 'covers/attacker-smuggled.jpg', status: 'public',
    }),
  }), env);
  assert.equal(res.status, 200);
  assert.match(insertSql, /NULL,\s*NULL,\s*\?/i);
  assert.match(insertSql, /'draft'/);
  assert.equal(insertArgs.includes('covers/attacker-smuggled.jpg'), false);
  assert.equal((await body(res)).ok, true);
}

function finalizeEnv(work, { index = true, cover = true, contentType = 'image/jpeg' } = {}) {
  let updated = false;
  return {
    PUBLISH_TOKEN: token,
    DB: {
      prepare(sql) {
        return {
          bind() {
            if (/^\s*SELECT/i.test(sql)) return { first: async () => work };
            return {
              run: async () => {
                updated = true;
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
    },
    SITES: {
      head: async () => index ? ({}) : null,
      get: async () => cover ? ({
        httpMetadata: { contentType },
        arrayBuffer: async () => jpegBytes().buffer,
      }) : null,
    },
    wasUpdated: () => updated,
  };
}

// finalize：缺封面拒绝；首页/对象/魔数齐全才原子公开。
{
  let env = finalizeEnv({ id: 'abc123', slug: 'tester-x', cover: null, status: 'draft' });
  let res = await finalizeWork(request('/api/works/abc123/finalize', { method: 'POST', headers: auth }), env, 'abc123');
  assert.equal(res.status, 409);
  assert.equal(env.wasUpdated(), false);

  env = finalizeEnv({ id: 'abc123', slug: 'tester-x', cover: 'covers/abc123.jpg', status: 'draft' });
  res = await finalizeWork(request('/api/works/abc123/finalize', { method: 'POST', headers: auth }), env, 'abc123');
  assert.equal(res.status, 200);
  assert.equal(env.wasUpdated(), true);
  assert.equal((await body(res)).siteUrl, 'https://unit.example/u/tester-x/');
}

// draft 静态站在 finalize 前必须 404，连 R2 读取都不发生。
{
  let r2Reads = 0;
  const env = {
    DB: { prepare: () => ({ bind: () => ({ first: async () => ({ id: 'd1', status: 'draft' }) }) }) },
    SITES: { get: async () => { r2Reads++; return null; } },
  };
  const res = await worker.fetch(request('/u/draft-work/'), env, ctx);
  assert.equal(res.status, 404);
  assert.equal(r2Reads, 0);
}

// HEAD 海报请求必须保留状态码但不返回 HTML body。
{
  const env = {
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ id: 'p1', status: 'public', poster: null }),
        }),
      }),
    },
  };
  const res = await worker.fetch(request('/p/p1', { method: 'HEAD' }), env, ctx);
  assert.equal(res.status, 409);
  assert.equal((await res.arrayBuffer()).byteLength, 0);
}

// 海报代理只接收 1080×1440 PNG；站点上传拒绝 SVG 内容。
{
  const puts = [];
  const env = { PUBLISH_TOKEN: token, SITES: { put: async (...args) => puts.push(args) } };
  let res = await worker.fetch(request('/api/upload/poster/abc123.png', {
    method: 'PUT', headers: auth, body: pngHeader(1080, 1440),
  }), env, ctx);
  assert.equal(res.status, 200);
  assert.equal(puts.length, 1);

  res = await worker.fetch(request('/api/upload/poster/abc123.png', {
    method: 'PUT', headers: auth, body: pngHeader(1080, 1080),
  }), env, ctx);
  assert.equal(res.status, 400);

  res = await worker.fetch(request('/api/upload/site/tester/index.html', {
    method: 'PUT', headers: auth, body: '<html><svg></svg></html>',
  }), env, ctx);
  assert.equal(res.status, 400);
}

// 大厅查询在 SQL 层就排除旧的无封面 public 记录。
{
  let sql = '';
  const env = {
    DB: { prepare(value) { sql = value; return { all: async () => ({ results: [] }) }; } },
  };
  const res = await listWorks(request('/api/works'), env);
  assert.equal(res.status, 200);
  assert.match(sql, /status\s*=\s*'public'\s+AND\s+cover\s+IS\s+NOT\s+NULL/i);
}

console.log('PASS cloud publish/image raster contract');
