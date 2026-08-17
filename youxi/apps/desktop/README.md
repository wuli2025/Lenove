# apps/desktop —— 一句话生成 · 现场桌面端

按《一句话生成 · 现场活动规划书 V2》Layer 1（本地笔记本）实现：
**需求访谈 → 分段生成 → 本地预览 → 一键上线**。

沿用 PRD 3.2 的定位：桌面壳是薄装配层，发布链路 100% 复用 `mica::publish`，一行没重写。

## 跑起来

```powershell
# 开发
cargo tauri dev

# 出安装包（NSIS，当前用户安装，不需要管理员）
cargo tauri build

# 现场体检：不起窗口跑完整条生成链路，统计耗时分布
cargo run -p yiju-desktop --bin yiju-smoke -- 20
```

## 配置

凭据**不进源码**（沿用 publish 板块的规矩），只从环境变量或数据目录来：

`%MICA_DATA_DIR%\yiju.json`，默认 `~\MicaBase\yiju.json`

```json
{
  "api_url": "https://api.minimaxi.com/anthropic/v1/messages",
  "api_key": "",
  "model": "MiniMax-M3",
  "tts_url": "https://api.minimaxi.com/v1/t2a_v2",
  "voice_id": "Chinese (Mandarin)_Gentle_Senior",
  "hall_url": "https://r2t-9f3x.llmwiki.cloud",
  "gen_token_budget": 150000,
  "max_regen": 3,
  "soft_deadline_secs": 480,
  "hard_deadline_secs": 600
}
```

环境变量 `YIJU_API_KEY` / `YIJU_API_URL` / `YIJU_MODEL` 优先级最高。
app 内点右上角「设置」也能改。

## 模块

| 文件 | 职责 |
|---|---|
| `src/interview.rs` | 需求访谈（真昼改造版）。原人格的 `{spokenText,subtitleText,emotion}` 加 `requirement`/`ready` 两字段，协议没重写 |
| `src/generate.rs` | 分段生成引擎 + 两道闸 + CSS 加固 + R4 密钥扫描 |
| `src/preview.rs` | 127.0.0.1 静态服务（不是 `file://`，理由见下） |
| `src/llm.rs` | Anthropic Messages 兼容端点的最小客户端 |
| `src/config.rs` | 配置，源码零硬编码凭据 |
| `ui/` | 前端。口型引擎与 T2A 流水线整段取自《真昼·口袋版》 |

## 几个不能改的决定

**预览走 HTTP 不走 `file://`** —— `file://` 的跨域限制会让脚本、字体、fetch 静默失效，
造成「本地好好的、传上去就坏」。现场出现这种不一致很难当场解释。

**页脚两个入口写死在 Rust 里** —— 「← 回到大厅」「我也要做一个」是传播闭环兼品牌展示位，
不能这次有下次没有，所以不交给模型发挥。

**降级顺序内置在引擎里** —— 过软截止或 token 触顶就跳过配图精修直接收尾。
规划书原话：宁可简单但完整，不要精致但没做完。现场不允许临时人工判断。

**CSS 加固闸（`harden_css`）** —— 模型爱写 `opacity:0 + animation:fadeUp forwards` 的入场动效。
写对了好看，但只要关键帧名拼错、或 `prefers-reduced-motion` 分支只关动画忘了还原 opacity，
**整页就是永久空白**。加固闸不禁止动效，只堵死"永久藏起来"这个结局。

**产物必须自包含** —— 禁止任何外链资源，配图只能内联 SVG 或 CSS 渐变。断网也能演。

## 验证桌面端时的两个陷阱

这两条都是实测踩出来的，而且都会让你误判成"应用坏了"，实际应用是好的。

**一、别拿窗口标题当前端探针。**
Tauri **不会**把 `document.title` 同步到原生窗口标题。用 `MainWindowTitle` 去看前端跑没跑，
永远只能读到 `tauri.conf.json` 里那个静态标题，于是会一路误判成"前端没加载 / 嵌的是旧版本"。
（实测澄清：只改 `ui/` 下的文件、不做任何 `cargo clean`，`cargo tauri build` 会正常
重新嵌入新前端——前面那个"嵌了旧版"的结论是坏探针造成的假象。）

要从进程外看前端状态，用 `ui_diag` 命令：app 每次启动把视口尺寸、style.css 是否生效、
各面板实际几何写进 `~\MicaBase\ui-diag.txt`。

**二、截图脚本必须是 DPI 感知的。**
本机是 `dpr=2` 的高分屏。非 DPI 感知的进程调 `CopyFromScreen`，只会抓到物理像素的
左上角那一块并放大一倍——表现为"右侧面板整个不见了、立绘大得离谱"。
截图前先 `SetProcessDpiAwareness(2)`（见 `scripts/shot-window.ps1`）。
另外别用 `ShowWindow` / `MoveWindow` 摆窗口：WebView2 不跟着重排，同样会拍出假象。

## 排查

- **窗口白屏 / 布局错位**：先看 `~\MicaBase\ui-diag.txt`。app 每次启动会把视口尺寸、
  style.css 是否生效、各面板实际几何写进去。前端顶层异常会直接糊在页面底部，不再静默死掉。
- **截图看着不对**（右侧面板不见了、立绘特别大）：多半是截图工具不是 DPI 感知的。
  本机是 dpr=2 的高分屏，非 DPI 感知进程用 `CopyFromScreen` 只会抓到左上角那一块并放大。
  截图前先 `SetProcessDpiAwareness(2)`，见 `scripts/shot-window.ps1`。
  另外别用 `ShowWindow`/`MoveWindow` 去摆窗口——WebView2 不跟着重排，会拍出假象。
- **说「还没配模型密钥」**：`~\MicaBase\yiju.json` 里 `api_key` 是空的。
- **语音不出声**：AudioContext 需要一次用户手势，点一下画面。右上角「语音」chip 会显示实际通道。
- **headless 截图产物是空白**：不是产物坏了。headless 浏览器截图时不推进动画时间，
  入场动效停在第一帧。截图前注入 `animation-delay:-5s !important` 强制跳到终态再截。
