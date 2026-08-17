/**
 * PA1 断言签发/验证 —— 1:1 复现 polaris-collab/src/collab/authority.rs
 *
 * 格式： PA1.<b64url_nopad(claims JSON)>.<b64url_nopad(Ed25519 sig)>
 * 签名： Ed25519 对 "PA1.<payload>" 的 ASCII 字节
 * TTL： 300s（5 分钟）
 * iss：  sha256(pubkey)[:8] hex（kid）
 *
 * 与 Rust 实现逐字节一致，客户端（桌面端）无感知。
 */

// ── base64url 工具 ────────────────────────────────────────────────────────────

const B64_URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function b64urlEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64_URL[b0 >> 2];
    out += B64_URL[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64_URL[((b1 & 15) << 2) | (b2 >> 6)] : "";
    out += i + 2 < bytes.length ? B64_URL[b2 & 63] : "";
  }
  return out;
}

export function b64urlDecode(s: string): Uint8Array {
  s = s.replace(/=+$/, "");
  const len = s.length;
  const bytes: number[] = [];
  let acc = 0;
  let accBits = 0;
  for (let i = 0; i < len; i++) {
    const idx = B64_URL.indexOf(s[i]);
    if (idx === -1) throw new Error("base64url 解码失败：非法字符");
    acc = (acc << 6) | idx;
    accBits += 6;
    if (accBits >= 8) {
      accBits -= 8;
      bytes.push((acc >> accBits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

export function hexEncode(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const input = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const hash = await crypto.subtle.digest("SHA-256", input as BufferSource);
  return new Uint8Array(hash);
}

// ── Ed25519 密钥管理 ─────────────────────────────────────────────────────────

const SEED_KEY = "PA1_SIGNING_SEED";
const PUB_KEY = "PA1_SIGNING_PUB";

export interface SigningKeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeyBytes: Uint8Array;
}

/**
 * 从 KV 里读 Ed25519 签名密钥。
 *
 * KV 里存两样东西：
 *   PA1_SIGNING_SEED  —— 32 字节 seed（Raw）
 *   PA1_SIGNING_PUB   —— 32 字节公钥（Raw）
 *
 * 首次运行：生成密钥对，同时存 seed 和公钥到 KV。
 * 迁移时：把 Rust authority 的 seed 导出，手动预置到 KV，公钥会自动计算。
 *
 * 注意：此密钥必须与 Rust authority 的 signing_key() 保持**同一把**，
 * 否则所有已钉住公钥的客户端会验签失败。
 */
export async function getSigningKey(kv: KVNamespace): Promise<SigningKeyPair> {
  const seedRaw = await kv.get(SEED_KEY, "arrayBuffer");
  const pubRaw = await kv.get(PUB_KEY, "arrayBuffer");

  let seed: Uint8Array;
  let publicKeyBytes: Uint8Array;

  if (seedRaw && pubRaw) {
    // 已有密钥
    seed = new Uint8Array(seedRaw);
    publicKeyBytes = new Uint8Array(pubRaw);
    if (seed.length !== 32) throw new Error(`签名密钥损坏：seed 长度 ${seed.length} != 32`);
    if (publicKeyBytes.length !== 32) throw new Error(`签名密钥损坏：公钥长度 ${publicKeyBytes.length} != 32`);
  } else {
    // 首次运行：生成新密钥对
    const keyPair = await crypto.subtle.generateKey(
      { name: "Ed25519" },
      true, // 可导出
      ["sign", "verify"]
    ) as CryptoKeyPair;

    // 导出公钥
    const pubBuf = await crypto.subtle.exportKey("raw", keyPair.publicKey);
    publicKeyBytes = new Uint8Array(pubBuf);

    // 导出私钥 seed
    // WebCrypto 导出的 PKCS#8 包含前缀，需要剥掉
    const pkcs8Buf = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
    const pkcs8 = new Uint8Array(pkcs8Buf);
    // Ed25519 PKCS#8: 30 2e 02 01 00 30 05 06 03 2b 65 70 04 22 04 20 <32字节seed>
    const prefixLen = 16;
    if (pkcs8.length !== prefixLen + 32) {
      throw new Error(`导出的 PKCS#8 长度异常：${pkcs8.length}，预期 ${prefixLen + 32}`);
    }
    seed = pkcs8.slice(prefixLen);

    // 存入 KV
    await kv.put(SEED_KEY, seed.buffer);
    await kv.put(PUB_KEY, publicKeyBytes.buffer);
  }

  // 从 seed 重建私钥
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    wrapPkcs8Ed25519(seed),
    { name: "Ed25519" },
    false,
    ["sign"]
  );

  const publicKey = await crypto.subtle.importKey(
    "raw",
    publicKeyBytes as BufferSource,
    { name: "Ed25519" },
    false,
    ["verify"]
  );

  return { privateKey, publicKey, publicKeyBytes };
}

function wrapPkcs8Ed25519(seed: Uint8Array): ArrayBuffer {
  const prefix = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
  ]);
  const out = new Uint8Array(prefix.length + seed.length);
  out.set(prefix, 0);
  out.set(seed, prefix.length);
  return out.buffer;
}

// ── PA1 断言 ───────────────────────────────────────────────────────────────

export interface Claims {
  iss: string;
  uid: string;
  username: string;
  email: string;
  display_name: string;
  iat: number;
  exp: number;
}

export const ASSERTION_TTL = 300;

export async function signAssertion(
  kp: SigningKeyPair,
  kid: string,
  uid: string,
  username: string,
  email: string,
  displayName: string
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: Claims = {
    iss: kid,
    uid,
    username,
    email,
    display_name: displayName,
    iat: now,
    exp: now + ASSERTION_TTL,
  };

  const payload = new TextEncoder().encode(JSON.stringify(claims));
  const head = `PA1.${b64urlEncode(payload)}`;

  const sig = await crypto.subtle.sign(
    { name: "Ed25519" },
    kp.privateKey,
    new TextEncoder().encode(head) as BufferSource
  );

  return `${head}.${b64urlEncode(new Uint8Array(sig))}`;
}

export async function verifyAssertion(
  assertion: string,
  publicKeyBytes: Uint8Array
): Promise<Claims> {
  const parts = assertion.trim().split(".");
  if (parts.length !== 3) throw new Error("身份断言格式不对");

  const [p0, p1, p2] = parts;
  if (p0 !== "PA1") throw new Error("身份断言版本不认识(须 PA1)");

  if (publicKeyBytes.length !== 32) throw new Error("权威公钥长度不对");

  const sigBytes = b64urlDecode(p2);
  if (sigBytes.length !== 64) throw new Error("断言签名长度不对");

  const head = `${p0}.${p1}`;
  const headBytes = new TextEncoder().encode(head);

  const publicKey = await crypto.subtle.importKey(
    "raw",
    publicKeyBytes as BufferSource,
    { name: "Ed25519" },
    false,
    ["verify"]
  );

  const ok = await crypto.subtle.verify(
    { name: "Ed25519" },
    publicKey,
    sigBytes as BufferSource,
    headBytes as BufferSource
  );

  if (!ok) throw new Error("身份断言签名验证失败");

  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p1))) as Claims;

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) throw new Error("身份断言已过期");
  if (payload.iat > now + 60) throw new Error("身份断言签发时间在未来");

  return payload;
}

// ── 预计算 ──────────────────────────────────────────────────────────────────

export interface PrecomputedKey {
  keyPair: SigningKeyPair;
  kid: string;
  publicKeyB64: string;
}

export async function getSigningKeyWithKid(kv: KVNamespace): Promise<PrecomputedKey> {
  const keyPair = await getSigningKey(kv);
  const pubHash = await sha256(keyPair.publicKeyBytes);
  const kid = hexEncode(pubHash.slice(0, 8));
  const publicKeyB64 = b64urlEncode(keyPair.publicKeyBytes);
  return { keyPair, kid, publicKeyB64 };
}
