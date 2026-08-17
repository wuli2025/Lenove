-- 大厅数据层（Cloudflare D1 / SQLite）
-- 桌面端发布作品 → 写这里；大厅页 / 海报页 / 点击统计都读这里。

CREATE TABLE IF NOT EXISTS works (
  id          TEXT PRIMARY KEY,            -- 短 id，用于 /p/<id> 海报与 API
  slug        TEXT UNIQUE NOT NULL,        -- 站点子路径 /u/<slug>/
  creator     TEXT NOT NULL,               -- 创作者姓名（开始创作前输入）
  title       TEXT NOT NULL,               -- 作品主题
  tagline     TEXT NOT NULL DEFAULT '',    -- 一句话亮点描述
  cover       TEXT,                        -- 封面截图在 R2 的 key（没有则用生成式示意图）
  poster      TEXT,                        -- 海报 PNG 在 R2 的 key（桌面端渲染后回传）
  accent      INTEGER NOT NULL DEFAULT 0,  -- 配色档位 0-5，由标题哈希定，保证同一作品每次一致
  hits        INTEGER NOT NULL DEFAULT 0,  -- 被点开次数（30 分钟内同一访客只计 1 次）
  status      TEXT NOT NULL DEFAULT 'public', -- public | hidden（一键下架用）
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_works_created ON works (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_works_hits    ON works (hits DESC);
CREATE INDEX IF NOT EXISTS idx_works_status  ON works (status);

-- 点击去重：同一访客对同一作品，30 分钟内只计一次。
-- 不去重的话自己狂刷就能上榜首，热度榜立刻失去意义。
CREATE TABLE IF NOT EXISTS hits (
  work_id  TEXT NOT NULL,
  visitor  TEXT NOT NULL,   -- IP + UA 的哈希，不存原始信息
  at       INTEGER NOT NULL,
  PRIMARY KEY (work_id, visitor)
);

CREATE INDEX IF NOT EXISTS idx_hits_at ON hits (at);
