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

# 首屏「一键生成」的 headless 双胞胎：同一条 interview::quick
yiju-gen --sentence "给我家的橘猫做个纪念站" --req-only     # 只出需求单，约 8s
yiju-gen --sentence "…" --out D:\out\site1                  # 一句话直接跑到成品
```

## 配置

模型、TTS 与 Cloudflare 凭据只在 Rust 侧使用，不进入 WebView 或生成站点。开发环境可通过环境变量或数据目录配置；受控活动安装包会把构建期引导值混淆写入程序，首启后导入 Windows Credential Manager。这里的混淆只能提高静态提取门槛，不能把客户端里的长期凭据变成真正不可提取的服务端机密。

模型配置文件位于 `%MICA_DATA_DIR%\yiju.json`，默认 `~\MicaBase\yiju.json`：
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
| `src/config.rs` | 模型/TTS 配置、受控安装包引导值与本地混淆存储 |
| `src/cloud.rs` | Cloudflare 发布与 Workers AI 客户端；令牌只留在 Rust / Credential Manager |
| `ui/` | 前端。口型引擎与 T2A 流水线整段取自《真昼·口袋版》 |

## 两条入口，访谈不是必经之路

规划书把「需求访谈」写成必经的第一步，现场跑下来它是**唯一的瓶颈**：
4–6 轮问答三四分钟，而排队的人只想看见页面开始长。所以入口有两条：

| 入口 | 路径 | 耗时 |
|---|---|---|
| 一句话直达（默认） | `interview::quick` → `start_generation` | 补需求单实测 8–11s |
| 跟真昼聊 | `interview::turn` × N → `start_generation` | 3–4 分钟 |

两条都汇到同一个生成引擎，产物没有区别；说得越细，需求单越准，仅此而已。

**生成按钮全局只有一颗**，在侧栏最底下。它不再由模型的 `ready` 决定亮不亮——
`ready` 是模型说了算的，于是那颗按钮绝大多数时间是灰的，而灰按钮不会告诉人还差什么。
现在只要手上有任何一句话就亮，缺的部分在按下去**之后**补。

这条链路上有三道兜底，合起来保证「点下去一定能开工」：

1. `interview::quick` 契约是**永不因模型失败而失败**——超时、JSON 写坏、返回空对象，
   一律退到 `quick_fallback` 的本地拼装（标题从原话里切，内容就是原话）。
2. `quick_requirement` 命令给它包了 25 秒超时。超时不算失败，退本地拼装照样开工。
3. `start_generation` 里原来那道「需求单不完整就打回去，再聊两句」**改成只补不拦**
   （`interview::backfill`，标题与内容互相回填），真的一个字都没有才报错。

直达那一段能在命令行反复验证，不用点 GUI：`yiju-gen --sentence "…" --req-only`。

## 几个不能改的决定

**预览走 HTTP 不走 `file://`** —— `file://` 的跨域限制会让脚本、字体、fetch 静默失效，
造成「本地好好的、传上去就坏」。现场出现这种不一致很难当场解释。

**页脚两个入口写死在 Rust 里** —— 「← 回到大厅」「我也要做一个」是传播闭环兼品牌展示位，
不能这次有下次没有，所以不交给模型发挥。

**降级不越过真实视觉闸门** —— 文字精修可以在软截止后收尾，但骨架规划出的位图必须全部由生图模型生成并通过校验；生图失败就明确失败并允许重试，不能拿灰卡、CSS 图形或 SVG 冒充作品画面。
规划书原话：宁可简单但完整，不要精致但没做完。现场不允许临时人工判断。

**CSS 加固闸（`harden_css`）** —— 模型爱写 `opacity:0 + animation:fadeUp forwards` 的入场动效。
写对了好看，但只要关键帧名拼错、或 `prefers-reduced-motion` 分支只关动画忘了还原 opacity，
**整页就是永久空白**。加固闸不禁止动效，只堵死"永久藏起来"这个结局。

**产物必须自包含且只用真实位图** —— 禁止外链资源、内联 SVG、SVG data URI 和 `.svg` 文件。作品型视觉只能引用本次 Workers AI 生成并落盘的 `assets/*.jpg`；CSS 渐变只可做背景、光晕和分隔，不能替代作品画面。

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
