/**
 * 邮箱验证码登录 —— 无密码、免注册。
 *
 *   POST /api/auth/request-code   {email}         发验证码
 *   POST /api/auth/verify         {email,code}    验证 + 下发会话 Cookie
 *   POST /api/auth/logout                         清会话
 *   GET  /api/auth/me                             当前用户 JSON
 *   POST /api/auth/profile        {name}          改昵称（个人中心用）
 *   GET  /api/me/works                            我的作品（个人中心用）
 *
 * 约定：authRoutes 命中自己的路径就返回 Response，没命中返回 null，
 * 由 index.js 继续往下匹配。这样认证相关的路由全部收在本文件里。
 *
 * 三条必须守住的安全线（每条都对应一类真实事故）：
 *  1. 验证码只存 SHA-256。明文存库 = 任何能读库的人都能登任何人的号。
 *  2. 会话 token 只存 SHA-256，原始 token 只出现在 Set-Cookie 里，且不落日志。
 *  3. 限流写在最前面。/request-code 不限流就是一台对外开放的免费短信炮台：
 *     同邮箱 60 秒一次、同 IP 每小时上限、验证码最多试 5 次。
 *
 * 本文件里的纯函数（normalizeEmail / evaluateCode / resendState / ipQuotaState …）
 * 刻意不碰 env 和 Response，好在 Node 里直接单测：node scripts/verify-auth.mjs
 */
import { json, bad, shortId } from './api.js';
import { hashStr } from './brand.js';

// ───────────────────────── 策略常量 ─────────────────────────
export const CODE_TTL_MS = 10 * 60 * 1000;        // 验证码 10 分钟有效
export const MAX_ATTEMPTS = 5;                     // 同一验证码最多试 5 次
export const RESEND_COOLDOWN_MS = 60 * 1000;       // 同邮箱 60 秒才能再要一次
export const IP_HOURLY_LIMIT = 20;                 // 同 IP 每小时最多 20 次
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 会话 30 天
export const COOKIE_NAME = 'osid';
export const NAME_MAX = 24;

// ───────────────────────── 纯函数（可单测） ─────────────────────────

/** 邮箱统一小写去空白。大小写不统一会让同一个人建出两个号。 */
export function normalizeEmail(raw) {
  return String(raw ?? '').trim().toLowerCase();
}

/**
 * 邮箱格式校验。
 * 不追求 RFC 5322 全量正确（那个正则没人维护得动），只挡住明显不是邮箱的输入：
 * 有且仅有一个 @、两侧非空且不含空白、域名里至少一个点、总长不超过 254。
 */
export function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  if (email.length < 6 || email.length > 254) return false;
  if ((email.match(/@/g) || []).length !== 1) return false;
  return /^[^\s@,;:<>"'\\]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(email);
}

/**
 * 昵称规则：1–24 字，去掉首尾空白并把连续空白压成一个。
 * 上限 24 与 works.creator 保持一致——因为「我的作品」现在就是按姓名匹配的。
 */
export function validateName(raw) {
  const value = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!value) return { ok: false, value: '', error: '昵称不能为空' };
  if ([...value].length > NAME_MAX) return { ok: false, value, error: `昵称最多 ${NAME_MAX} 字` };
  if (/[<>]/.test(value)) return { ok: false, value, error: '昵称不能包含尖括号' };
  return { ok: true, value, error: '' };
}

/** 邮箱 @ 前那段当默认昵称，超长就截断，实在取不出就叫「创作者」 */
export function defaultNameFromEmail(email) {
  const local = String(email || '').split('@')[0].replace(/[^a-zA-Z0-9._-]/g, '').slice(0, NAME_MAX);
  return local || '创作者';
}

/**
 * 6 位数字验证码。
 * 用 crypto.getRandomValues 而不是 Math.random —— 后者可预测，
 * 知道种子就能算出别人的验证码。这里取 32 位随机数对 1e6 取模，
 * 2^32 不是 1e6 的整数倍会有极微偏置（<0.03%），对 6 位码可以忽略。
 */
export function genCode() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1000000).padStart(6, '0');
}

/** 定长比较，别用 === 比哈希：字符串比较会在第一个不同字符处提前返回 */
export function timingEqual(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/**
 * 60 秒重发闸门。传入该邮箱最近一次验证码的 created_at（没有就传 null）。
 * @returns {{ok:boolean, waitMs:number}} waitMs 用来填 Retry-After
 */
export function resendState(lastCreatedAt, now = Date.now()) {
  if (!lastCreatedAt) return { ok: true, waitMs: 0 };
  const passed = now - lastCreatedAt;
  if (passed >= RESEND_COOLDOWN_MS) return { ok: true, waitMs: 0 };
  return { ok: false, waitMs: RESEND_COOLDOWN_MS - passed };
}

/** 同 IP 每小时上限。传入该 IP 最近一小时的请求条数。 */
export function ipQuotaState(countLastHour) {
  const n = Number(countLastHour) || 0;
  return { ok: n < IP_HOURLY_LIMIT, used: n, limit: IP_HOURLY_LIMIT };
}

/**
 * 验证码判定 —— 整个登录流程里最容易写错的一段，所以抽成纯函数单独测。
 * 判定顺序是有讲究的：先过期、再次数、最后才比哈希。
 * 反过来的话，一个过期验证码还能把 attempts 耗光，用户看到的错误也会驴唇不对马嘴。
 *
 * @param {{code_hash:string,expires_at:number,attempts:number}|null} row 该邮箱最新一条验证码
 * @param {string} inputHash 用户输入的验证码算出来的哈希
 * @returns {{ok:boolean, reason:string, error:string, status:number, left:number}}
 */
export function evaluateCode(row, inputHash, now = Date.now()) {
  if (!row) {
    return { ok: false, reason: 'none', error: '请先获取验证码', status: 400, left: 0 };
  }
  if (now > row.expires_at) {
    return { ok: false, reason: 'expired', error: '验证码已过期，请重新获取', status: 400, left: 0 };
  }
  if ((row.attempts || 0) >= MAX_ATTEMPTS) {
    return { ok: false, reason: 'too_many', error: '错误次数过多，请重新获取验证码', status: 429, left: 0 };
  }
  if (!timingEqual(row.code_hash, inputHash)) {
    const left = MAX_ATTEMPTS - (row.attempts || 0) - 1;
    return { ok: false, reason: 'mismatch', error: `验证码不正确，还可以试 ${left} 次`, status: 400, left };
  }
  return { ok: true, reason: 'ok', error: '', status: 200, left: MAX_ATTEMPTS - (row.attempts || 0) };
}

/** Cookie 头 → 对象。注意 value 里可能有 =，只在第一个 = 处切。 */
export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const s = part.trim();
    if (!s) continue;
    const i = s.indexOf('=');
    if (i < 0) continue;
    out[s.slice(0, i).trim()] = decodeURIComponent(s.slice(i + 1).trim());
  }
  return out;
}

/**
 * 会话 Cookie。
 * HttpOnly  → JS 读不到，XSS 也偷不走
 * Secure    → 只走 HTTPS（线上是自定义域名 HTTPS，没问题）
 * SameSite=Lax → 挡住绝大多数 CSRF，同时不影响从外部链接点进来还是登录态
 */
export function sessionCookie(token, maxAgeSec = SESSION_TTL_MS / 1000) {
  return `${COOKIE_NAME}=${token}; Max-Age=${Math.floor(maxAgeSec)}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}
export function clearCookie() {
  return `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

// ───────────────────────── 哈希 ─────────────────────────

/** SHA-256 → hex。Worker 原生有 Web Crypto，Node 18+ 也有，所以同一份代码两边都能跑。 */
export async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 验证码哈希带邮箱和一个 secret 一起算：
 *  - 带邮箱：同一时刻两个人的 000000 哈希不同，防彩虹表/撞库比对
 *  - 带 secret：库泄露也没法离线爆破 6 位码（一百万种，不带盐几秒钟就跑完）
 * AUTH_SECRET 没配也能跑，但线上应当配：wrangler secret put AUTH_SECRET
 */
const hashCode = (env, email, code) => sha256Hex(`${email}|${code}|${env.AUTH_SECRET || 'r2-sites-default'}`);

/** 32 字节随机 token（hex 64 位）。Cookie 里放它，库里只放它的哈希。 */
function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** 请求方 IP 的哈希 —— 用来限流，但不落原始 IP。与 api.js 的 visitorHash 区别是不掺 UA：
 *  掺了 UA 的话，换个浏览器 UA 就绕过了 IP 上限。 */
function ipHash(request) {
  const ip =
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for') ||
    '0.0.0.0';
  return hashStr(`ip|${ip}`).toString(36);
}

// ───────────────────────── 发信通道（可插拔） ─────────────────────────
/**
 * 发验证码。做成分发结构，加一家服务商只要多一个分支。
 *
 * 背景（别再走回头路）：
 *  - Outlook 个人账号的 SMTP 基础认证已被微软停用，outlool.com 更不是微软的域。
 *  - Worker 的 fetch 只能走 HTTPS，但 cloudflare:sockets 可以开 TCP/TLS 连接，
 *    所以「QQ 邮箱 + SMTP 授权码」这条路是通的（Worker 跑在 CF 边缘机房，
 *    不受国内运营商封 465/587 影响）。当前默认就走这个：MAIL_PROVIDER=qq。
 *  - Resend / Brevo 这类 HTTPS API 服务商留作备用通道。
 *
 * @returns {Promise<{ok:boolean, provider:string, error?:string, debugCode?:string}>}
 */
export async function sendCode(env, email, code) {
  const provider = String(env.MAIL_PROVIDER || 'console').toLowerCase();

  if (provider === 'console') {
    // 联调模式：不真发，打日志。MAIL_DEBUG=1 时还会把码放进接口返回值。
    // 这两个开关都只在 dev 环境配，线上配了等于把验证码直接送给攻击者。
    console.log(`[auth] 验证码 ${code} -> ${email}（MAIL_PROVIDER=console，未真实发送）`);
    return { ok: true, provider, debugCode: env.MAIL_DEBUG === '1' ? code : undefined };
  }

  if (provider === 'resend') {
    if (!env.RESEND_API_KEY) return { ok: false, provider, error: '缺少 RESEND_API_KEY（wrangler secret put RESEND_API_KEY）' };
    if (!env.MAIL_FROM) return { ok: false, provider, error: '缺少 MAIL_FROM（发件地址，需在 Resend 验证过域名）' };
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [email], subject: mailSubject(code), html: mailHtml(code), text: mailText(code) }),
    });
    if (!r.ok) return { ok: false, provider, error: `Resend 返回 ${r.status}：${(await r.text()).slice(0, 200)}` };
    return { ok: true, provider };
  }

  if (provider === 'brevo') {
    if (!env.BREVO_API_KEY) return { ok: false, provider, error: '缺少 BREVO_API_KEY（wrangler secret put BREVO_API_KEY）' };
    if (!env.MAIL_FROM) return { ok: false, provider, error: '缺少 MAIL_FROM（发件地址，需在 Brevo 验证过发件人）' };
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { email: env.MAIL_FROM, name: env.MAIL_FROM_NAME || '一句话生成' },
        to: [{ email }],
        subject: mailSubject(code),
        htmlContent: mailHtml(code),
        textContent: mailText(code),
      }),
    });
    if (!r.ok) return { ok: false, provider, error: `Brevo 返回 ${r.status}：${(await r.text()).slice(0, 200)}` };
    return { ok: true, provider };
  }

  if (provider === 'qq') {
    // QQ 邮箱 SMTP：465 直连 TLS。需要的是「授权码」而不是 QQ 密码
    // （设置 → 账号与安全 → POP3/IMAP/SMTP 服务 → 生成授权码）。
    if (!env.QQ_MAIL_USER) return { ok: false, provider, error: '缺少 QQ_MAIL_USER（发件 QQ 邮箱）' };
    if (!env.QQ_MAIL_PASS) return { ok: false, provider, error: '缺少 QQ_MAIL_PASS（SMTP 授权码，wrangler secret put QQ_MAIL_PASS）' };
    try {
      await smtpSend({
        host: env.QQ_MAIL_HOST || 'smtp.qq.com',
        port: Number(env.QQ_MAIL_PORT || 465),
        user: env.QQ_MAIL_USER,
        pass: env.QQ_MAIL_PASS,
        from: env.QQ_MAIL_USER,
        fromName: env.MAIL_FROM_NAME || '一句话生成',
        to: email,
        subject: mailSubject(code),
        text: mailText(code),
      });
      return { ok: true, provider };
    } catch (e) {
      return { ok: false, provider, error: `QQ SMTP：${String(e && e.message ? e.message : e).slice(0, 200)}` };
    }
  }

  // ↓ 将来加 postmark / mailersend / 腾讯云 SES 等，照上面的样子加分支即可
  return { ok: false, provider, error: `未知的 MAIL_PROVIDER：${provider}（可选 console / qq / resend / brevo）` };
}

// ───────────────────────── SMTP（cloudflare:sockets）─────────────────────────
/**
 * 极简 SMTP 客户端，只够发验证码这一件事：EHLO → AUTH LOGIN → 一封文本信 → QUIT。
 *
 * 为什么自己写而不是找库：Worker 没有 nodemailer 的运行环境（net/tls 模块），
 * 但有 cloudflare:sockets 的 connect()，465 端口可以 secureTransport:'on' 直接
 * 起 TLS，于是 SMTP 协议本身只剩「发一行、等一个三位数回码」的循环，自己写
 * 反而比移植库小得多。
 *
 * 几个刻意省掉的东西（这是发验证码，不是通用邮件网关）：
 *  - 不 STARTTLS：465 隐式 TLS 一步到位，587 那套先明文再升级的流程没必要支持；
 *  - 不发 HTML：纯文本 base64 编码后天然没有 dot-stuffing 问题（base64 字母表
 *    里没有 '.'），也不用处理 multipart；
 *  - 不管多行回包的内容：只认最后一行「code SP text」，前面的「250-...」丢弃。
 */

/** ASCII base64（SMTP AUTH 的用户名/授权码都是 ASCII） */
const b64 = (s) => btoa(s);

/** UTF-8 字符串 → base64。btoa 只吃 Latin-1，所以先过 TextEncoder。 */
function b64utf8(s) {
  const bytes = new TextEncoder().encode(String(s));
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

/** base64 按 76 列折行（RFC 2045），行尾 \r\n */
function b64wrap(s) {
  const out = [];
  for (let i = 0; i < s.length; i += 76) out.push(s.slice(i, i + 76));
  return out.join('\r\n');
}

/** RFC 2047 encoded-word，给 Subject / 发件人昵称里的中文用 */
const encWord = (s) => `=?UTF-8?B?${b64utf8(s)}?=`;

async function smtpSend({ host, port, user, pass, from, fromName, to, subject, text }) {
  // 动态引入而不是顶层 import：auth.js 里的纯函数要在 Node 里跑单测，
  // 顶层 import 'cloudflare:sockets' 会让 Node 整个模块加载失败。
  const { connect } = await import('cloudflare:sockets');
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const socket = connect({ hostname: host, port }, { secureTransport: 'on', allowHalfOpen: false });

  // 每一步都限时：SMTP 对端沉默不能拖住整个请求（Worker 有 wall-clock 上限）
  const deadline = Date.now() + 20000;
  const remain = (what) => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error(`${what} 超时`);
    return ms;
  };
  const race = (p, what) =>
    Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} 超时`)), remain(what)))]);

  await race(socket.opened, 'connect');
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  let buf = '';

  /** 读到一个完整回包：最后一行形如 "250 OK\r\n"（多行回包前面的 "250-..." 忽略） */
  const reply = async () => {
    for (;;) {
      const m = /(^|\r\n)(\d{3}) [^\r\n]*\r\n/.exec(buf);
      if (m) {
        buf = buf.slice(m.index + m[0].length);
        return { code: m[2], line: m[0].trim() };
      }
      const { value, done } = await race(reader.read(), 'read');
      if (done) throw new Error('连接被对端关闭');
      buf += dec.decode(value, { stream: true });
      if (buf.length > 16384) throw new Error('回包异常过大');
    }
  };

  const cmd = async (line, okCodes, what) => {
    await race(writer.write(enc.encode(line + '\r\n')), 'write');
    const r = await reply();
    if (!okCodes.includes(r.code)) throw new Error(`${what} 被拒：${r.line}`);
    return r;
  };

  try {
    const greet = await reply();
    if (greet.code !== '220') throw new Error(`问候异常：${greet.line}`);
    await cmd('EHLO mail.yjhsc.local', ['250'], 'EHLO');
    await cmd('AUTH LOGIN', ['334'], 'AUTH');
    await cmd(b64(user), ['334'], '用户名');
    await cmd(b64(pass), ['235'], '授权码'); // 535 = 授权码错/被风控
    await cmd(`MAIL FROM:<${from}>`, ['250'], 'MAIL FROM');
    await cmd(`RCPT TO:<${to}>`, ['250', '251'], 'RCPT TO');
    await cmd('DATA', ['354'], 'DATA');

    const msg =
      `From: ${encWord(fromName)} <${from}>\r\n` +
      `To: <${to}>\r\n` +
      `Subject: ${encWord(subject)}\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: text/plain; charset=UTF-8\r\n` +
      `Content-Transfer-Encoding: base64\r\n` +
      `\r\n` +
      b64wrap(b64utf8(text)) +
      `\r\n.\r\n`;
    await cmd(msg, ['250'], '送信正文');

    await cmd('QUIT', ['221'], 'QUIT').catch(() => {}); // QUIT 被拒无所谓，信已发出
  } finally {
    try { socket.close(); } catch { /* 已在关闭流程里 */ }
  }
}

const mailSubject = (code) => `${code} 是你的登录验证码 · 一句话生成`;
const mailText = (code) => `你的登录验证码是 ${code}，10 分钟内有效。如果不是你本人操作，忽略这封邮件即可。`;
const mailHtml = (code) =>
  `<div style="font-family:-apple-system,'Segoe UI','PingFang SC',sans-serif;max-width:420px;margin:0 auto;padding:32px 24px;color:#1b2430">
  <p style="margin:0 0 18px;font-size:15px">你正在登录「一句话生成」。验证码：</p>
  <p style="margin:0 0 18px;font:700 34px/1.2 ui-monospace,Consolas,monospace;letter-spacing:.18em;color:#0d6c7c">${code}</p>
  <p style="margin:0;font-size:13px;color:#66788a">10 分钟内有效。如果不是你本人操作，忽略这封邮件即可。</p>
</div>`;

// ───────────────────────── 会话 ─────────────────────────

/**
 * 从 Cookie 取当前登录用户。没登录 / 会话过期 / 用户被删都返回 null，绝不抛。
 * 这个函数在每个页面路由上都会被调一次，所以只做一次 D1 等值查询（token_hash 是主键）。
 */
export async function currentUser(request, env) {
  try {
    const token = parseCookies(request.headers.get('cookie'))[COOKIE_NAME];
    if (!token || token.length < 32) return null;
    const th = await sha256Hex(token);
    const row = await env.DB.prepare(
      `SELECT u.id, u.email, u.name, u.avatar, u.created_at, u.last_login_at, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`
    ).bind(th).first();
    if (!row) return null;
    if (Date.now() > row.expires_at) return null; // 过期行留给清理任务删，这里只管不认
    return { id: row.id, email: row.email, name: row.name, avatar: row.avatar, created_at: row.created_at, last_login_at: row.last_login_at };
  } catch (e) {
    // 认证挂了不能把整页带崩：最差就是显示成未登录
    console.error('currentUser', String(e && e.message ? e.message : e));
    return null;
  }
}

/** 顺手清掉过期数据。放 waitUntil 里跑，失败也不影响主流程。 */
async function sweep(env, now) {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM login_codes WHERE expires_at < ?`).bind(now - 60 * 60 * 1000),
    env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(now),
  ]);
}

// ───────────────────────── 路由 ─────────────────────────

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** POST /api/auth/request-code */
async function requestCode(request, env, ctx) {
  const body = await readJson(request);
  if (!body) return bad('请求体不是合法 JSON');

  const email = normalizeEmail(body.email);
  if (!isValidEmail(email)) return bad('邮箱格式不正确');

  const now = Date.now();
  const iph = ipHash(request);

  // 限流放在写库和发信之前：先挡住，再谈其他
  const [last, ipRow] = await Promise.all([
    env.DB.prepare(`SELECT created_at FROM login_codes WHERE email = ? ORDER BY created_at DESC LIMIT 1`).bind(email).first(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM login_codes WHERE ip_hash = ? AND created_at > ?`).bind(iph, now - 60 * 60 * 1000).first(),
  ]);

  const resend = resendState(last ? last.created_at : null, now);
  if (!resend.ok) {
    const sec = Math.ceil(resend.waitMs / 1000);
    return json({ ok: false, error: `请求太频繁，请 ${sec} 秒后再试`, retryAfter: sec }, 429, { 'retry-after': String(sec) });
  }

  const quota = ipQuotaState(ipRow ? ipRow.n : 0);
  if (!quota.ok) {
    return json({ ok: false, error: `当前网络请求验证码次数过多（每小时上限 ${quota.limit} 次），请稍后再试` }, 429, { 'retry-after': '3600' });
  }

  const code = genCode();
  const codeHash = await hashCode(env, email, code);
  await env.DB.prepare(
    `INSERT INTO login_codes (id, email, code_hash, ip_hash, expires_at, attempts, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`
  ).bind(shortId(), email, codeHash, iph, now + CODE_TTL_MS, now).run();

  const sent = await sendCode(env, email, code);
  if (!sent.ok) {
    // 发信失败要说清是哪家、缺什么，不然线上只能看到「发送失败」四个字
    console.error('[auth] 发信失败', sent.provider, sent.error);
    return json({ ok: false, error: `验证码发送失败：${sent.error}` }, 502);
  }

  if (ctx && ctx.waitUntil) ctx.waitUntil(sweep(env, now).catch(() => {}));

  return json({
    ok: true,
    email,
    expiresIn: CODE_TTL_MS / 1000,
    provider: sent.provider,
    // 联调开关：MAIL_DEBUG=1 时把码放进返回值，任何 provider 都生效。
    // 只在线上联调阶段临时开，活动现场必须关掉——开着等于把验证码送给任何人。
    ...(env.MAIL_DEBUG === '1' ? { debugCode: code } : {}),
  });
}

/** POST /api/auth/verify */
async function verify(request, env) {
  const body = await readJson(request);
  if (!body) return bad('请求体不是合法 JSON');

  const email = normalizeEmail(body.email);
  if (!isValidEmail(email)) return bad('邮箱格式不正确');
  const code = String(body.code ?? '').trim();
  if (!/^\d{6}$/.test(code)) return bad('验证码应为 6 位数字');

  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT id, code_hash, expires_at, attempts FROM login_codes
      WHERE email = ? ORDER BY created_at DESC LIMIT 1`
  ).bind(email).first();

  const inputHash = await hashCode(env, email, code);
  const verdict = evaluateCode(row, inputHash, now);

  if (!verdict.ok) {
    // 只有「码不对」才记一次错。过期 / 已超限再累加没有意义，
    // 还会让用户重新获取后立刻又被判超限。
    if (verdict.reason === 'mismatch') {
      await env.DB.prepare(`UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?`).bind(row.id).run();
    }
    return json({ ok: false, error: verdict.error, reason: verdict.reason }, verdict.status);
  }

  // 一次性：用过就作废，防止同一个码被重放
  await env.DB.prepare(`UPDATE login_codes SET attempts = ? WHERE id = ?`).bind(MAX_ATTEMPTS, row.id).run();

  // 首次验证成功即建号（免注册）
  let user = await env.DB.prepare(`SELECT id, email, name, avatar, created_at FROM users WHERE email = ?`).bind(email).first();
  let isNew = false;
  if (!user) {
    const id = shortId();
    const name = defaultNameFromEmail(email);
    await env.DB.prepare(
      `INSERT INTO users (id, email, name, avatar, created_at, last_login_at) VALUES (?, ?, ?, NULL, ?, ?)`
    ).bind(id, email, name, now, now).run();
    user = { id, email, name, avatar: null, created_at: now };
    isNew = true;
  } else {
    await env.DB.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).bind(now, user.id).run();
  }

  const token = newToken();
  await env.DB.prepare(
    `INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`
  ).bind(await sha256Hex(token), user.id, now + SESSION_TTL_MS, now).run();

  return json(
    { ok: true, isNew, user: { id: user.id, email: user.email, name: user.name, avatar: user.avatar } },
    200,
    { 'set-cookie': sessionCookie(token) }
  );
}

/** POST /api/auth/logout —— 只删当前这一条会话，别的设备不受影响 */
async function logout(request, env) {
  const token = parseCookies(request.headers.get('cookie'))[COOKIE_NAME];
  if (token) {
    await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(await sha256Hex(token)).run();
  }
  return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
}

/** POST /api/auth/profile —— 目前只有昵称可改 */
async function updateProfile(request, env) {
  const user = await currentUser(request, env);
  if (!user) return bad('请先登录', 401);

  const body = await readJson(request);
  if (!body) return bad('请求体不是合法 JSON');

  const v = validateName(body.name);
  if (!v.ok) return bad(v.error);

  await env.DB.prepare(`UPDATE users SET name = ? WHERE id = ?`).bind(v.value, user.id).run();
  // 提醒：作品是按姓名匹配的（见 myWorks），改名会让旧作品从「我的作品」里消失。
  // 等 works 表加上 user_id 之后这个副作用才会消失。
  return json({ ok: true, user: { ...user, name: v.value }, notice: '已保存。注意：作品目前按姓名关联，改名后旧作品可能不再显示' });
}

/**
 * GET /api/me/works —— 个人中心的作品列表。
 *
 * 【临时方案】works 表现在没有 user_id 列，只有 creator（现场手填的姓名），
 * 所以这里只能按 creator = 用户昵称 精确匹配。已知缺陷：
 *   - 同名的人会互相看到对方的作品；
 *   - 用户改了昵称，旧作品就对不上了。
 * 正式做法是给 works 加 user_id 并在发布时写入，那需要改 api.js / schema.sql，
 * 不在本次改动范围内。等两边都能动的时候，把这里换成 WHERE user_id = ?。
 */
async function myWorks(request, env, url) {
  const user = await currentUser(request, env);
  if (!user) return bad('请先登录', 401);

  const { results } = await env.DB.prepare(
    `SELECT id, slug, creator, title, tagline, cover, poster, accent, hits, status, created_at
       FROM works WHERE creator = ? ORDER BY created_at DESC LIMIT 100`
  ).bind(user.name).all();

  const rows = results || [];
  const origin = url.origin;
  return json({
    ok: true,
    matchedBy: 'creator-name', // 前端据此提示「按姓名匹配」，别让人以为丢作品了
    user: { id: user.id, name: user.name, email: user.email, avatar: user.avatar, created_at: user.created_at },
    stats: {
      works: rows.length,
      hits: rows.reduce((s, w) => s + (w.hits || 0), 0),
      days: Math.max(1, Math.ceil((Date.now() - user.created_at) / 86400000)),
    },
    works: rows.map((w) => ({
      ...w,
      siteUrl: `${origin}/u/${w.slug}/`,
      posterUrl: `${origin}/p/${w.id}`,
      coverUrl: w.cover ? `${origin}/r2/${w.cover}` : null,
    })),
  });
}

/**
 * 认证路由入口。命中返回 Response，没命中返回 null。
 * 方法不匹配时返回 405 而不是 null —— 否则 POST /api/auth/verify 打错成 GET
 * 会一路掉到最后变成 404，排查时看不出是方法写错了。
 */
export async function authRoutes(request, env, ctx, url) {
  const path = url.pathname;
  if (!path.startsWith('/api/auth/') && path !== '/api/me/works') return null;

  const method = request.method;
  const only = (m) => (method === m ? null : bad(`不支持的方法，应为 ${m}`, 405));

  switch (path) {
    case '/api/auth/request-code':
      return only('POST') || (await requestCode(request, env, ctx));
    case '/api/auth/verify':
      return only('POST') || (await verify(request, env));
    case '/api/auth/logout':
      return only('POST') || (await logout(request, env));
    case '/api/auth/profile':
      return only('POST') || (await updateProfile(request, env));
    case '/api/auth/me': {
      if (method !== 'GET' && method !== 'HEAD') return bad('不支持的方法，应为 GET', 405);
      const user = await currentUser(request, env);
      return json({ ok: true, user: user ? { id: user.id, email: user.email, name: user.name, avatar: user.avatar, created_at: user.created_at } : null });
    }
    case '/api/me/works': {
      if (method !== 'GET') return bad('不支持的方法，应为 GET', 405);
      return await myWorks(request, env, url);
    }
    default:
      return bad('认证接口不存在', 404);
  }
}
