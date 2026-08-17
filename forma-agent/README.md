# FORMA Agent —— 个人网站创作 Agent

把 **FORMA 的 120 套高级个人网站模板** 当前端，接上 **youxi(MicaBase)** 的 AI 任务网关当后端，
装进一个 Tauri 桌面壳里。设置页（API 切换管理 + 环境医生）的信息架构搬自**有戏剧场**。

```
forma-agent/
  ui/                     前端（纯静态，Tauri 直接打包进去）
    index.html            FORMA 模板广场（原样，只多挂了两个文件）
    app.js  style.css     FORMA 原有实现 —— 一行没改
    assets/  独立模板/    图片与 120 套独立成品 HTML
    打开模板库.html
    forma-agent.js/.css   ★ 新增：AI 创作面板 + 设置页
  src-tauri/              桌面壳（Rust，自成 workspace）
    src/main.rs           数据目录隔离 → 起后端 → 开窗
    src/forma.rs          ★ FORMA 专属外挂路由
    tauri.conf.json  icons/  capabilities/
```

## 三个项目怎么拼的

| 来源 | 角色 | 处理方式 |
|---|---|---|
| `C:\Users\mi\Desktop\FORMA个人网站模板` | 前端 | **拷贝**进 `ui/`，原目录未动 |
| `个人网站创作平台\youxi`（MicaBase） | 后端 | **path 依赖引入**，源码一行未改 |
| `有戏剧场`（vn-studio） | 设置页设计 | 只搬**版式与信息架构**，接口换成 youxi 的 `/v1/*` |

## 项目隔离（重点）

| 隔离面 | FORMA Agent | MicaBase 服务器形态 | 有戏剧场 |
|---|---|---|---|
| 数据目录 | `%APPDATA%\FormaAgent`（`FORMA_DATA_DIR` 可覆盖） | `~\MicaBase` | 自己的 stateDir |
| 端口 | 1471（被占自动顺延，`FORMA_PORT` 可覆盖） | 1440 | 自己的端口 |
| providers.json | `%APPDATA%\FormaAgent\data\providers.json` | `~\MicaBase\data\` | 自己那份 |
| Cargo workspace | `src-tauri` 自成 workspace | youxi 自己的 | 自己的 |
| Tauri identifier | `com.forma.site-agent` | — | 另一个 |
| 构建产物 | `src-tauri/target/` | `youxi/target/` | 自己的 |

三个壳可以同时开，互不抢端口、不共用 key、不互相污染任务库。

## 跑起来

```powershell
cd src-tauri
cargo run                      # 开发
npx @tauri-apps/cli@2 build    # 出 Windows 安装包（nsis）
```

首次进来会看到「设置 → 环境医生」体检本机的 claude / codex / node / git。

## 怎么用

### 1. 配一条 AI 通道（二选一）

- **API 直连（推荐）**：设置 → API 切换 → 新增供应商 → 选预设（智谱 / DeepSeek / Kimi / MiniMax / 硅基流动 / OpenRouter / Anthropic 官方）→ 填 Key。
  保存后自动测连通，通了就设为「当前使用」。可以再指一家当**故障兜底**：主通道 5 分钟内连挂 3 次会自动切过去（恢复后不自动切回，防抖动）。
- **本机 Claude Code CLI**：环境医生里 `claude` 显示「已就绪」即可，创作时通道选「本机 Claude Code CLI」。

切换供应商会**先做连通预检，探测不通不允许生效**（youxi 的 `activate` 路由行为）。

### 2. 创作

顶栏「✦ AI 创作」→ 选版式 → 填自述 → 开始生成。两种模式按模板自动切换：

- **AI 填充**（36 套视觉系统）：模型产出结构化 profile（services / metrics / works / experience / journal / testimonial …），
  再交给 **FORMA 自己的 `renderTemplate`** 出页面 —— 渲染路径没变，所以出来的效果和模板广场里一致。
- **深度改写**（12 套独立成品）：模型改写模板内置的 `window.PORTFOLIO_CONFIG`，**键名 / 层级 / 数组长度一字不动**，
  只换值，然后原位换回 HTML。这正是这批模板官方说明里的改法，比整页重写稳得多。

生成过程走 SSE 实时流，右侧「生成日志」能看到模型在写什么，随时可停。
出稿后可以「下载 HTML」「新窗口打开」，或「保存到我的站点」落到 `%APPDATA%\FormaAgent\sites\<slug>\`。

## 后端接口

youxi 原生（`crates/mica`，未改）：

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/v1/tasks` | 提交生成任务 |
| GET | `/v1/tasks/{id}/events` | SSE 事件流（Last-Event-ID 续传） |
| POST | `/v1/tasks/{id}/cancel` | 停止生成 |
| GET/POST | `/v1/providers` | 供应商列表 / 新增 |
| POST | `/v1/providers/{id}/activate` · `probe` | 激活（带预检）/ 连通测试 |
| GET | `/v1/doctor` | 环境医生体检 |
| GET | `/v1/update/check` | 检查新版本 |
| GET | `/healthz` · `/metrics` | 健康 / 指标 |

FORMA 外挂（`src-tauri/src/forma.rs`，补 youxi 没有的口）：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/v1/app/info` | 壳信息 / 数据目录 / 端口（设置页「运行环境」） |
| GET | `/v1/presets` | 内置供应商预设表（新增供应商下拉） |
| POST | `/v1/providers/{id}/update` | 编辑供应商，**Key 留空即保持不变** |
| POST | `/v1/providers/{id}/delete` · `fallback` | 删除 / 设为故障兜底 |
| GET/POST | `/v1/sites` | 已保存站点列表 / 保存 |
| POST | `/v1/sites/{slug}/delete` · `reveal` | 删除 / 在资源管理器打开 |
| POST | `/v1/reveal-data` · `/v1/open` | 打开数据目录 / 用浏览器开链接 |

## 已验证

- `cargo build` 通过；壳启动后 `/healthz`、`/v1/app/info`、`/v1/doctor`、`/v1/providers`、`/v1/presets`、`/v1/sites` 全部 200。
- 无头 Chrome + CDP 走完真实交互：设置页四个板块渲染正常、环境医生四个组件体检到位、供应商浮层 7 个预设加载、
  创作面板 48 套模板分两组、独立成品的 `PORTFOLIO_CONFIG` 抠取成功、直接套模板渲染出 69KB 完整 HTML，**控制台零报错**。
- 站点保存 / 列表 / 删除三个口实测通过，文件确实落在 `%APPDATA%\FormaAgent\sites\`。
- **未验证**：真实 AI 生成链路（需要你自己的 API Key 或本机 claude 登录态）。配好通道后点一次「开始生成」即可跑通。
