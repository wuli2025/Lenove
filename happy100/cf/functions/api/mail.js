/* 幸福小事 · 周报发信
   ─────────────────────────────────────────────────────────────────────
   Workers 没有邮件 SDK，这里用 cloudflare:sockets 直连 QQ 的 SMTP（465 隐式 TLS）。

   隐私边界：只有「周报正文」这一段文字会经过服务器 —— 因为它要变成邮件，
   而邮件本来就是明文的。你的完整数据依然只以密文形式躺在 R2 里，
   服务器读不到，也不参与生成周报（周报是客户端解密后自己拼好的）。

   防滥用：必须带一个真实存在的 dataId（证明确实有账号），
   同一账号每天最多 5 封，全站每天最多 60 封。
   ───────────────────────────────────────────────────────────────────── */
import { connect } from 'cloudflare:sockets';

const ID_RE = /^[0-9a-f]{64}$/;
const MAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_BODY = 64 * 1024;
const PER_ACCT_DAY = 5;
const GLOBAL_DAY = 60;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (o, s = 200) => new Response(JSON.stringify(o), {
  status: s, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
});

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

/* ── SMTP 客户端 ── */
class Smtp {
  constructor(socket) {
    this.w = socket.writable.getWriter();
    this.r = socket.readable.getReader();
    this.enc = new TextEncoder();
    this.dec = new TextDecoder();
    this.buf = '';
  }
  async send(line) { await this.w.write(this.enc.encode(line + '\r\n')); }

  /** 读到一条完整的 SMTP 应答（处理 "250-xxx" 多行） */
  async reply() {
    for (;;) {
      const lines = this.buf.split('\r\n');
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (/^\d{3} /.test(l)) {
          this.buf = lines.slice(i + 1).join('\r\n');
          return { code: Number(l.slice(0, 3)), text: l };
        }
      }
      const { value, done } = await this.r.read();
      if (done) throw new Error('SMTP 连接被对方关闭');
      this.buf += this.dec.decode(value, { stream: true });
    }
  }
  async expect(want) {
    const r = await this.reply();
    if (r.code !== want) throw new Error(`SMTP 期望 ${want}，实际 ${r.text}`);
    return r;
  }
  async close() { try { await this.w.close(); } catch {} }
}

const b64 = s => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const b64Header = s => '=?UTF-8?B?' + b64(s) + '?=';
const wrap76 = s => (s.match(/.{1,76}/g) || []).join('\r\n');

async function sendMail(env, { to, subject, text }) {
  const user = env.SMTP_USER;
  const pass = env.SMTP_PASS;
  if (!user || !pass) throw new Error('服务端还没配好发信账号');

  const socket = connect({ hostname: env.SMTP_HOST || 'smtp.qq.com', port: Number(env.SMTP_PORT || 465) },
                         { secureTransport: 'on', allowHalfOpen: false });
  const s = new Smtp(socket);
  try {
    await s.expect(220);
    await s.send('EHLO happy.llmwiki.cloud');   await s.expect(250);
    await s.send('AUTH LOGIN');                 await s.expect(334);
    await s.send(b64(user));                    await s.expect(334);
    await s.send(b64(pass));                    await s.expect(235);
    await s.send(`MAIL FROM:<${user}>`);        await s.expect(250);
    await s.send(`RCPT TO:<${to}>`);            await s.expect(250);
    await s.send('DATA');                       await s.expect(354);

    const headers = [
      `From: ${b64Header('幸福小事')} <${user}>`,
      `To: <${to}>`,
      `Subject: ${b64Header(subject)}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
    ].join('\r\n');

    await s.send(headers + '\r\n\r\n' + wrap76(b64(text)) + '\r\n.');
    await s.expect(250);
    await s.send('QUIT');
  } finally {
    await s.close();
    try { socket.close(); } catch {}
  }
}

/* ── 配额 ── */
async function bump(env, key, limit) {
  const day = new Date().toISOString().slice(0, 10);
  const k = `q/${day}/${key}`;
  const cur = await env.SYNC.get(k);
  const n = cur ? Number(await cur.text()) || 0 : 0;
  if (n >= limit) return false;
  await env.SYNC.put(k, String(n + 1));
  return true;
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad_json' }, 400); }

  const { dataId, to, subject, text } = body || {};
  if (!ID_RE.test(String(dataId || ''))) return json({ ok: false, error: 'bad_data_id' }, 400);
  if (!MAIL_RE.test(String(to || '')))   return json({ ok: false, error: 'bad_to' }, 400);
  if (typeof text !== 'string' || !text.trim()) return json({ ok: false, error: 'empty' }, 400);
  if (text.length > MAX_BODY) return json({ ok: false, error: 'too_large' }, 413);

  // 必须是真实存在的账号数据
  const exists = await env.SYNC.head(`s/${dataId}`);
  if (!exists) return json({ ok: false, error: 'no_account' }, 403);

  if (!await bump(env, 'g', GLOBAL_DAY))            return json({ ok: false, error: 'global_limit' }, 429);
  if (!await bump(env, `a-${dataId}`, PER_ACCT_DAY)) return json({ ok: false, error: 'rate_limit' }, 429);

  try {
    await sendMail(env, { to, subject: String(subject || '幸福小事 · 周报').slice(0, 120), text });
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: 'smtp_failed', detail: String(e.message || e).slice(0, 200) }, 502);
  }
}
