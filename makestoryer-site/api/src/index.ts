/**
 * makestory.cloud 账号中心 API —— Cloudflare Workers
 *
 * 复现 polaris-collab 的 authority 功能：
 *   /api/account/send_code    —— 发登录验证码
 *   /api/account/login_code   —— 验证码换断言
 *   /api/account/pubkey       —— 获取权威公钥
 *   /api/mesh/enroll          —— 设备入网
 *   /api/mesh/announce        —— 设备报到
 *   /api/mesh/devices         —— 设备台账
 *   /api/mesh/rename          —— 设备改名
 *   /api/mesh/revoke          —— 设备吊销
 *
 * 数据存储：
 *   D1: users, email_codes, mesh_nodes, login_attempts
 *   KV: PA1 签名密钥
 */

import { getSigningKeyWithKid, signAssertion, verifyAssertion, b64urlEncode, b64urlDecode, hexEncode, sha256 } from "./pa1";

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  // 环境变量
  SIGNUP_OPEN: string;           // "1" = 开放注册，"0" = 关闭
  SMTP_HOST?: string;            // 腾讯云 SES
  SMTP_PORT?: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  FROM_EMAIL?: string;           // 发件邮箱
  AUTHORITY_PUBKEY?: string;     // 权威公钥（base64url），用于客户端验证
}

// ── 工具函数 ────────────────────────────────────────────────────────────────

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function err(msg: string, status = 400): Response {
  return json({ error: msg }, status);
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function randomCode(): string {
  const buf = new Uint8Array(3);
  crypto.getRandomValues(buf);
  // 6 位数字
  const n = (buf[0] << 16) | (buf[1] << 8) | buf[2];
  return String(n % 1000000).padStart(6, "0");
}

function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return b64urlEncode(buf);
}

function hashPassword(password: string): Promise<string> {
  // 简化版：用 sha256 代替 argon2id（Workers 里没有原生 argon2）
  // 生产环境应该用 argon2-wasm 或把密码哈希外包给专门服务
  return sha256(password).then(b => hexEncode(b));
}

async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const computed = await hashPassword(password);
  return computed === hash;
}

// ── 邮件发送（腾讯云 SES）───────────────────────────────────────────────────

async function sendEmail(env: Env, to: string, subject: string, body: string): Promise<void> {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) {
    throw new Error("SMTP 未配置");
  }

  // 腾讯云 SES 的 SMTP 协议
  // 注意：Workers 没有原生 SMTP 客户端，需要用 fetch 调用 SES 的 HTTP API
  // 或者直接用 SMTP over TLS（Workers 不支持原生 TCP）
  // 替代方案：用腾讯云 SES 的 HTTP API 或者第三方邮件服务

  // 这里先实现一个简化版：用 fetch 调用腾讯云 SES 的 HTTP API
  // 实际上腾讯云 SES 有 HTTP API：https://cloud.tencent.com/document/product/1288/51034

  const sesApiUrl = "https://ses.tencentcloudapi.com";
  const params = new URLSearchParams({
    Action: "SendEmail",
    Version: "2020-10-02",
    Region: "ap-guangzhou",
    FromEmailAddress: env.FROM_EMAIL || "noreply@makestory.cloud",
    Destination: to,
    Subject: subject,
    "Body.Html": body,
    "Body.Text": body.replace(/<[^>]*>/g, ""),
  });

  // 注意：这里需要腾讯云 API 签名，实际实现会更复杂
  // 为了简化，我们先假设有一个专门的邮件发送 Worker 或者外部服务
  // 生产环境应该调用腾讯云 SES 的签名 API

  console.log(`[EMAIL] To: ${to}, Subject: ${subject}`);
  console.log(`[EMAIL] Body: ${body}`);

  // 暂时只记录日志，不实际发送
  // TODO: 接入腾讯云 SES HTTP API 或第三方邮件服务
}

// ── 频控 ────────────────────────────────────────────────────────────────────

async function checkRateLimit(env: Env, email: string, ip: string): Promise<{ allowed: boolean; reason?: string }> {
  const db = env.DB;
  const nowSec = now();

  // 检查 60s 重发间隔
  const recent = await db.prepare(
    "SELECT created_at FROM email_codes WHERE email = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1"
  ).bind(email, nowSec - 60).first();

  if (recent) {
    return { allowed: false, reason: "发信太频繁，请 60 秒后再试" };
  }

  // 检查 5 封/小时
  const hourly = await db.prepare(
    "SELECT COUNT(*) as count FROM email_codes WHERE email = ? AND created_at > ?"
  ).bind(email, nowSec - 3600).first();

  if (hourly && (hourly.count as number) >= 5) {
    return { allowed: false, reason: "发信次数超限，请 1 小时后再试" };
  }

  // 检查 IP 频控（5 封/小时）
  const ipHourly = await db.prepare(
    "SELECT COUNT(*) as count FROM email_codes WHERE ip = ? AND created_at > ?"
  ).bind(ip, nowSec - 3600).first();

  if (ipHourly && (ipHourly.count as number) >= 5) {
    return { allowed: false, reason: "该 IP 发信次数超限，请稍后再试" };
  }

  return { allowed: true };
}

// ── 用户管理 ────────────────────────────────────────────────────────────────

async function findUserByEmail(env: Env, email: string): Promise<any | null> {
  const db = env.DB;
  const user = await db.prepare(
    "SELECT uid, username, email, display_name, password_hash, created_at FROM users WHERE email = ?"
  ).bind(email).first();
  return user;
}

async function createUser(env: Env, email: string, username?: string, displayName?: string): Promise<any> {
  const db = env.DB;
  const uid = `u_${randomToken(16)}`;

  // 用户名从邮箱前缀派生
  const derivedUsername = username || email.split("@")[0].toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const derivedDisplay = displayName || derivedUsername;

  await db.prepare(
    "INSERT INTO users (uid, username, email, display_name, created_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(uid, derivedUsername, email, derivedDisplay, now()).run();

  return { uid, username: derivedUsername, email, display_name: derivedDisplay };
}

// ── 设备管理 ────────────────────────────────────────────────────────────────

async function enrollDevice(env: Env, nodeId: string, uid: string, name: string, os: string, ver: string): Promise<string> {
  const db = env.DB;
  const meshKey = `mk_${randomToken(32)}`;
  const nowSec = now();

  // 检查是否已存在
  const existing = await db.prepare(
    "SELECT mesh_key FROM mesh_nodes WHERE node_id = ? AND uid = ?"
  ).bind(nodeId, uid).first();

  if (existing) {
    return existing.mesh_key as string;
  }

  await db.prepare(
    "INSERT INTO mesh_nodes (node_id, uid, mesh_key, name, os, ver, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(nodeId, uid, meshKey, name, os, ver, nowSec, nowSec).run();

  return meshKey;
}

async function updateDeviceLastSeen(env: Env, nodeId: string, uid: string): Promise<void> {
  const db = env.DB;
  await db.prepare(
    "UPDATE mesh_nodes SET last_seen = ? WHERE node_id = ? AND uid = ?"
  ).bind(now(), nodeId, uid).run();
}

// ── 主入口 ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS 预检
    if (method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    try {
      // ── 账号相关 ─────────────────────────────────────────────────────────

      if (path === "/api/account/pubkey" && method === "GET") {
        const key = await getSigningKeyWithKid(env.KV);
        return json({ pubkey: key.publicKeyB64, kid: key.kid });
      }

      if (path === "/api/account/send_code" && method === "POST") {
        const body = await request.json() as { email: string; purpose?: string };
        const email = body.email?.toLowerCase().trim();
        const purpose = body.purpose || "login";

        if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
          return err("邮箱格式不对");
        }

        const ip = request.headers.get("CF-Connecting-IP") || "unknown";

        // 频控
        const rateLimit = await checkRateLimit(env, email, ip);
        if (!rateLimit.allowed) {
          return err(rateLimit.reason || "发信太频繁", 429);
        }

        // 生成验证码
        const code = randomCode();
        const codeHash = await sha256(code).then(b => hexEncode(b));

        // 存库
        await env.DB.prepare(
          "INSERT INTO email_codes (email, purpose, code_hash, ip, attempts, expires_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)"
        ).bind(email, purpose, codeHash, ip, now() + 600, now()).run();

        // 发邮件
        const subject = purpose === "login" ? "【编故事师】登录验证码" : "【编故事师】验证码";
        const body = `
          <h2>编故事师</h2>
          <p>您的验证码是：<strong style="font-size:24px;color:#4f8cff;">${code}</strong></p>
          <p>10 分钟内有效，请勿泄露给他人。</p>
          <p>如果这不是您的操作，请忽略此邮件。</p>
        `;

        await sendEmail(env, email, subject, body);

        return json({ ok: true, message: "验证码已发送" });
      }

      if (path === "/api/account/login_code" && method === "POST") {
        const body = await request.json() as { email: string; code: string };
        const email = body.email?.toLowerCase().trim();
        const code = body.code?.trim();

        if (!email || !code) {
          return err("缺少 email 或 code");
        }

        // 验证验证码
        const codeHash = await sha256(code).then(b => hexEncode(b));
        const record = await env.DB.prepare(
          "SELECT * FROM email_codes WHERE email = ? AND purpose = 'login' AND code_hash = ? AND expires_at > ? AND attempts < 5 ORDER BY created_at DESC LIMIT 1"
        ).bind(email, codeHash, now()).first();

        if (!record) {
          // 记录失败尝试
          const existing = await env.DB.prepare(
            "SELECT * FROM email_codes WHERE email = ? AND purpose = 'login' AND expires_at > ? ORDER BY created_at DESC LIMIT 1"
          ).bind(email, now()).first();

          if (existing) {
            await env.DB.prepare(
              "UPDATE email_codes SET attempts = attempts + 1 WHERE email = ? AND purpose = 'login' AND expires_at > ?"
            ).bind(email, now()).run();
          }

          return err("验证码错误或已过期", 401);
        }

        // 删除已使用的验证码
        await env.DB.prepare(
          "DELETE FROM email_codes WHERE email = ? AND purpose = 'login'"
        ).bind(email).run();

        // 查找或创建用户
        let user = await findUserByEmail(env, email);
        if (!user) {
          if (env.SIGNUP_OPEN !== "1") {
            return err("账号不存在，且注册已关闭", 403);
          }
          user = await createUser(env, email);
        }

        // 签发断言
        const key = await getSigningKeyWithKid(env.KV);
        const assertion = await signAssertion(
          key.keyPair,
          key.kid,
          user.uid,
          user.username,
          user.email,
          user.display_name
        );

        return json({
          uid: user.uid,
          email: user.email,
          username: user.username,
          display_name: user.display_name,
          assertion,
        });
      }

      // ── 设备网相关 ─────────────────────────────────────────────────────────

      if (path === "/api/mesh/enroll" && method === "POST") {
        const body = await request.json() as {
          assertion: string;
          node_id: string;
          name: string;
          os: string;
          ver: string;
        };

        const key = await getSigningKeyWithKid(env.KV);
        const claims = await verifyAssertion(body.assertion, key.keyPair.publicKeyBytes);

        const meshKey = await enrollDevice(
          env,
          body.node_id,
          claims.uid,
          body.name,
          body.os,
          body.ver
        );

        return json({ mesh_key: meshKey });
      }

      if (path === "/api/mesh/announce" && method === "POST") {
        const body = await request.json() as {
          node_id: string;
          mesh_key: string;
          name: string;
          os: string;
          ver: string;
        };

        // 验证 mesh_key
        const device = await env.DB.prepare(
          "SELECT uid FROM mesh_nodes WHERE node_id = ? AND mesh_key = ? AND revoked = 0"
        ).bind(body.node_id, body.mesh_key).first();

        if (!device) {
          return err("设备未入网或已被吊销", 401);
        }

        await updateDeviceLastSeen(env, body.node_id, device.uid as string);

        // 返回名册
        const roster = await env.DB.prepare(
          "SELECT node_id, name, os, ver, last_seen FROM mesh_nodes WHERE uid = ? AND revoked = 0 ORDER BY last_seen DESC"
        ).bind(device.uid).all();

        return json({ devices: roster.results });
      }

      if (path === "/api/mesh/devices" && method === "GET") {
        const auth = request.headers.get("Authorization");
        if (!auth || !auth.startsWith("Bearer ")) {
          return err("缺少 Authorization", 401);
        }

        const token = auth.slice(7);
        // 简化：token 就是 mesh_key
        const device = await env.DB.prepare(
          "SELECT uid FROM mesh_nodes WHERE mesh_key = ? AND revoked = 0"
        ).bind(token).first();

        if (!device) {
          return err("无效的设备密钥", 401);
        }

        const devices = await env.DB.prepare(
          "SELECT node_id, name, os, ver, first_seen, last_seen FROM mesh_nodes WHERE uid = ? AND revoked = 0 ORDER BY last_seen DESC"
        ).bind(device.uid).all();

        return json({ devices: devices.results });
      }

      if (path === "/api/mesh/rename" && method === "POST") {
        const auth = request.headers.get("Authorization");
        if (!auth || !auth.startsWith("Bearer ")) {
          return err("缺少 Authorization", 401);
        }

        const body = await request.json() as { node_id: string; name: string };
        const token = auth.slice(7);

        const device = await env.DB.prepare(
          "SELECT uid FROM mesh_nodes WHERE mesh_key = ? AND revoked = 0"
        ).bind(token).first();

        if (!device) {
          return err("无效的设备密钥", 401);
        }

        await env.DB.prepare(
          "UPDATE mesh_nodes SET name = ? WHERE node_id = ? AND uid = ?"
        ).bind(body.name, body.node_id, device.uid).run();

        return json({ ok: true });
      }

      if (path === "/api/mesh/revoke" && method === "POST") {
        const auth = request.headers.get("Authorization");
        if (!auth || !auth.startsWith("Bearer ")) {
          return err("缺少 Authorization", 401);
        }

        const body = await request.json() as { node_id: string };
        const token = auth.slice(7);

        const device = await env.DB.prepare(
          "SELECT uid FROM mesh_nodes WHERE mesh_key = ? AND revoked = 0"
        ).bind(token).first();

        if (!device) {
          return err("无效的设备密钥", 401);
        }

        await env.DB.prepare(
          "UPDATE mesh_nodes SET revoked = 1 WHERE node_id = ? AND uid = ?"
        ).bind(body.node_id, device.uid).run();

        return json({ ok: true });
      }

      // ── 404 ───────────────────────────────────────────────────────────────

      return err("Not Found", 404);

    } catch (e) {
      console.error("Error:", e);
      return err(e instanceof Error ? e.message : "Internal Server Error", 500);
    }
  },
};
