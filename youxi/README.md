# MicaBase（米糕基座）

米糕游的 AI Agent 执行基座 —— 纯 Rust 任务网关：提交任务 → 流式事件 → 结果落库。
按 `PRD-米糕基座-v0.2.html`（单仓收敛版）实现。

## 布局

```
crates/mica          唯一核心 crate（core/runtime/provider/engine/doctor/server 六模块）
  src/bin/mica-server.rs   服务器形态入口（--features server）
  src/bin/mock-claude.rs   冒烟用 mock CLI（回放 stream-json）
apps/desktop         Tauri 壳占位（P0 服务器形态先行）
deploy/              Dockerfile / compose
scripts/             check-boundaries / fetch-runtimes / smoke
runtimes.lock.json   CLI 运行时版本锁
```

模块依赖方向（check-boundaries 强制）：`server → engine → provider → runtime → core`，`doctor → runtime → core`。

## 快速开始

```powershell
# 构建并测试
cargo build --features server
cargo test

# 起服（默认 127.0.0.1:1440，数据目录 ~/MicaBase，可用 MICA_DATA_DIR / MICA_PORT 覆盖）
cargo run --features server --bin mica-server

# 端到端冒烟（mock CLI，无需真实 API key）；脚本须用 pwsh 7（UTF-8 编码）
pwsh -NoProfile -File scripts/smoke.ps1
pwsh -NoProfile -File scripts/check-boundaries.ps1
# 真 CLI 冒烟（发版前）：本机 codex 已登录即可
pwsh -NoProfile -File scripts/smoke-codex.ps1
```

## 引擎分流（提交时强制路由）

任务带 `kind` 字段（text 默认 / image / tool），调度器按 PRD 4.2 分流原则强制路由，
**长文本任务永不落 codex**——codex 主战场是生图（内置 GPT-image）与工具循环：

| kind \ engine | api | codex | claude |
|---|---|---|---|
| text（长文本/对话） | ✓ | **→ 改路 api** | ✓（按需） |
| image（生图） | → 改路 codex | ✓ 主通道 | → 改路 codex |
| tool（工具循环） | ✓ | ✓ | ✓ |

响应里的 `engine` / `rerouted` 字段反映路由结果。

```powershell
```

## API 速览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /v1/tasks | 提交任务（202；队列满 429+Retry-After） |
| GET | /v1/tasks/{id} | 任务状态 |
| GET | /v1/tasks/{id}/events | SSE 事件流（Last-Event-ID 续传） |
| POST | /v1/tasks/{id}/cancel · pause · resume | 实时控制（回执走 SSE） |
| PATCH | /v1/tasks/{id} | 参数调整（排队中生效） |
| GET/POST | /v1/providers | 供应商列表 / 新增 |
| POST | /v1/providers/{id}/activate · probe | 激活（预检通过才生效）/ 连通性探测 |
| GET | /healthz · /metrics | 健康检查 · Prometheus 文本指标 |
