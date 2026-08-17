-- makestory.cloud 账号中心数据库 schema
-- 对应 polaris-collab/src/collab/db.rs 的相关表

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  uid TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT,  -- 可为空（纯验证码登录）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- 邮箱验证码表
CREATE TABLE IF NOT EXISTS email_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL,  -- login | signup | reset
  code_hash TEXT NOT NULL,
  ip TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_codes_email ON email_codes(email, purpose, expires_at);
CREATE INDEX IF NOT EXISTS idx_email_codes_ip ON email_codes(ip, created_at);

-- 设备网节点表
CREATE TABLE IF NOT EXISTS mesh_nodes (
  node_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  mesh_key TEXT NOT NULL,
  name TEXT NOT NULL,
  os TEXT NOT NULL,
  ver TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  last_ip_hint TEXT,  -- /24 前缀，用于异地提醒
  revoked INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (node_id, uid)
);

CREATE INDEX IF NOT EXISTS idx_mesh_nodes_uid ON mesh_nodes(uid, revoked);
CREATE INDEX IF NOT EXISTS idx_mesh_nodes_mesh_key ON mesh_nodes(mesh_key);

-- 登录尝试记录（频控）
CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT,
  ip TEXT NOT NULL,
  success INTEGER NOT NULL,  -- 0 = 失败, 1 = 成功
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_email ON login_attempts(email, created_at);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip, created_at);

-- 审计日志
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT,
  action TEXT NOT NULL,  -- login | enroll | revoke | grant | etc
  target TEXT,  -- 操作对象（如 node_id）
  ip TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_uid ON audit_log(uid, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
