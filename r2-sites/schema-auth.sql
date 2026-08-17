-- 认证数据层（Cloudflare D1 / SQLite）
-- 与 schema.sql 分开放：大厅那套是「作品」，这套是「人」，
-- 两者目前只靠 works.creator = users.name 松耦合（见 auth.js 里 myWorks 的注释）。
--
-- 建表：
--   本地  npx wrangler d1 execute hall --local  --file=schema-auth.sql
--   线上  npx wrangler d1 execute hall --remote --file=schema-auth.sql

-- ───────────────────────── 用户 ─────────────────────────
-- 免注册：验证码第一次通过就建号，所以这里没有密码列，永远也不该有。
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,          -- 短 id，与 works.id 同风格
  email         TEXT NOT NULL UNIQUE,      -- 已小写去空白；UNIQUE 自带索引，不用再建
  name          TEXT NOT NULL,             -- 昵称，1-24 字；默认取邮箱 @ 前那段
  avatar        TEXT,                      -- 头像在 R2 的 key，暂时都是 NULL（先用首字母渐变块）
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

-- 按昵称找用户（改名前要查重、以及以后按 creator 反查）
CREATE INDEX IF NOT EXISTS idx_users_name ON users (name);

-- ───────────────────────── 登录验证码 ─────────────────────────
-- 每请求一次插一行，不做 upsert。理由：
--   ① 同 IP 每小时上限要靠「这个 IP 一小时内插了几行」来算，upsert 会把历史抹掉；
--   ② 验证时只认同一邮箱 created_at 最大的那行，旧行等于自动作废，不必删。
-- code 只存 SHA-256，库被看到也换不出验证码。
CREATE TABLE IF NOT EXISTS login_codes (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,               -- sha256(email|code|secret)
  ip_hash     TEXT NOT NULL DEFAULT '',    -- 只存哈希，不落原始 IP
  expires_at  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,  -- 试错次数，满 5 次这行就废了
  created_at  INTEGER NOT NULL
);

-- 查询模式一：verify / 60 秒重发判断 → WHERE email=? ORDER BY created_at DESC LIMIT 1
CREATE INDEX IF NOT EXISTS idx_codes_email ON login_codes (email, created_at DESC);
-- 查询模式二：同 IP 每小时上限 → WHERE ip_hash=? AND created_at > ?
CREATE INDEX IF NOT EXISTS idx_codes_ip    ON login_codes (ip_hash, created_at);
-- 查询模式三：定期清理过期行
CREATE INDEX IF NOT EXISTS idx_codes_exp   ON login_codes (expires_at);

-- ───────────────────────── 会话 ─────────────────────────
-- Cookie 里放的是原始 token，库里只存哈希：
-- 拿到数据库快照的人无法伪造 Cookie 登录任何人。
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,             -- sha256(token)，主键即索引，鉴权是等值查询
  user_id    TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- 查询模式：踢掉某人全部会话（改邮箱 / 注销）；以及清理过期
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions (expires_at);
