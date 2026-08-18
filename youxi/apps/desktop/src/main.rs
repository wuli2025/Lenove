//! 一句话生成 · 桌面端。
//!
//! 规划书 Layer 1（本地笔记本）的四件事：
//! 需求访谈 AI → 生成引擎 → 本地预览 → 触发上线。
//!
//! 本 crate 是**薄装配层**（apps/desktop/README.md 约定）：
//! 发布链路 100% 复用 `mica::publish`，一行都不重写。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use yiju_desktop::{cloud, config, doctor, generate, interview, llm, preview, tts};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use cloud::{Capabilities, CloudConfig};
use config::Config;
use generate::{Engine, GeneratedVisual, Progress, SiteDraft};
use interview::{Reply, Requirement};
use llm::{Llm, Msg};
use qrcode::{types::Color, QrCode};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone)]
struct CurrentWork {
    site_id: String,
    site_dir: PathBuf,
    title: String,
    tagline: String,
    cover_path: PathBuf,
    visuals: Vec<GeneratedVisual>,
    complete: bool,
}

#[derive(Clone)]
struct LastPublished {
    source_site_id: String,
    result: mica::publish::PublishResult,
}

#[derive(Clone)]
struct PendingPoster {
    source_site_id: String,
    publication_id: String,
    nonce: String,
}

struct AppState {
    cfg: Mutex<Config>,
    cloud: Result<CloudConfig, String>,
    preview: Mutex<Option<preview::Preview>>,
    /// 当前作品由 Rust 持有；前端不能改标题、封面路径或把旧发布结果接到新作品上。
    current: Mutex<Option<CurrentWork>>,
    last_published: Mutex<Option<LastPublished>>,
    pending_poster: Mutex<Option<PendingPoster>>,
    /// 发布或海报上传期间禁止开始新一轮生成，避免跨作品写入。
    cloud_busy: AtomicBool,
    /// 从联网预检开始一直持有到后台生成结束，IPC 也不能并发启动两份付费任务。
    generation_busy: Arc<AtomicBool>,
    /// 闸 2：同一份需求单已经重做了几次
    regen: Mutex<u32>,
}

struct CloudBusyGuard<'a>(&'a AtomicBool);

impl Drop for CloudBusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

struct GenerationBusyGuard(Arc<AtomicBool>);

impl Drop for GenerationBusyGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn begin_generation(state: &AppState) -> Result<GenerationBusyGuard, String> {
    state
        .generation_busy
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "上一份网站仍在生成，请等它完成或失败后再重试。".to_string())?;
    Ok(GenerationBusyGuard(Arc::clone(&state.generation_busy)))
}

fn begin_cloud_write(state: &AppState) -> Result<CloudBusyGuard<'_>, String> {
    state
        .cloud_busy
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "正在上线或上传海报，请等当前操作完成。".to_string())?;
    Ok(CloudBusyGuard(&state.cloud_busy))
}

fn configured_cloud(state: &AppState) -> Result<CloudConfig, String> {
    state
        .cloud
        .clone()
        .map_err(|e| format!("Cloudflare 发布/生图不可用：{e}"))
}

// 返回值的字段名不会被 Tauri 自动转驼峰（只有命令**入参名**会转），
// 前端按驼峰读，所以这里统一 rename_all。
// 例外是 Requirement：它同时要被模型按提示词里的 snake_case 生成，不能改。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Boot {
    configured: bool,
    opening: String,
    model: String,
    api_url: String,
    voice_id: String,
    hall_url: String,
    max_regen: u32,
    soft_deadline_secs: u64,
    hard_deadline_secs: u64,
    gen_token_budget: u64,
    tts_configured: bool,
    cloud_configured: bool,
    cloud_status: String,
    config_path: String,
}

#[tauri::command]
fn boot(state: State<'_, AppState>) -> Boot {
    let c = state.cfg.lock().unwrap().clone();
    Boot {
        configured: c.configured(),
        opening: interview::OPENING.to_string(),
        model: c.model.clone(),
        api_url: c.api_url.clone(),
        voice_id: c.voice_id.clone(),
        hall_url: c.hall_url.clone(),
        max_regen: c.max_regen,
        soft_deadline_secs: c.soft_deadline_secs,
        hard_deadline_secs: c.hard_deadline_secs,
        gen_token_budget: c.gen_token_budget,
        tts_configured: !c.effective_tts_key().is_empty(),
        cloud_configured: state.cloud.is_ok(),
        cloud_status: match &state.cloud {
            Ok(_) => "发布与生图凭据已装入，等待联网预检".into(),
            Err(e) => e.clone(),
        },
        config_path: config::config_path().display().to_string(),
    }
}

/// 联网确认 Worker 的发布、R2/D1 与 Workers AI 都可用；只返回非秘密能力和品牌信息。
#[tauri::command]
async fn cloud_capabilities(state: State<'_, AppState>) -> Result<Capabilities, String> {
    configured_cloud(&state)?.capabilities().await
}

/// 启动前环境医生。报告与进度事件只含枚举状态和脱敏文案；所有凭据仍在 Rust 内。
#[tauri::command]
async fn environment_doctor(
    app: AppHandle,
    state: State<'_, AppState>,
    force_deep: bool,
) -> Result<doctor::DoctorReport, String> {
    let cfg = state.cfg.lock().unwrap().clone();
    let cloud = state.cloud.clone();
    let preview_url = state
        .preview
        .lock()
        .unwrap()
        .as_ref()
        .map(preview::Preview::url);
    Ok(
        doctor::run(cfg, cloud, preview_url, force_deep, move |check| {
            let _ = app.emit("doctor:progress", check);
        })
        .await,
    )
}

/// MiniMax T2A 代理。
///
/// 老版本把 `{ url, key }` 直接回给 webview，再由 JavaScript 调 T2A——
/// 这等于在已经混淆的 exe 旁边又开了一扇明门：任何能调用 Tauri 命令、
/// 抓 webview 请求的人都能直接读到 TTS key。现在请求只在 Rust 进程内发，
/// 前端只拿最终的十六进制音频，凭据从头到尾不进 JavaScript。
///
/// 参数全做白名单 / 长度闸。这个命令毕竟是 webview 可调用的，不能让被注入的
/// 页面借它把我们的 TTS 账户变成一个任意请求代理。
#[tauri::command]
async fn tts_synth(
    state: State<'_, AppState>,
    text: String,
    voice_id: String,
    emotion: String,
    model: String,
) -> Result<String, String> {
    let config = state.cfg.lock().unwrap().clone();
    let audio = tts::synthesize(&config, &text, &voice_id, &emotion, &model).await?;
    Ok(tts::encode_hex(&audio))
}

#[derive(Deserialize)]
struct Turn {
    role: String,
    content: String,
}

#[tauri::command]
async fn interview_turn(state: State<'_, AppState>, history: Vec<Turn>) -> Result<Reply, String> {
    let c = state.cfg.lock().unwrap().clone();
    if !c.configured() {
        return Err("还没配模型密钥。点右上角「设置」填一下。".into());
    }
    let llm = Llm::new(&c.api_url, &c.api_key, &c.model);
    let msgs: Vec<Msg> = history
        .iter()
        .map(|t| {
            if t.role == "assistant" {
                Msg::assistant(t.content.clone())
            } else {
                Msg::user(t.content.clone())
            }
        })
        .collect();
    interview::turn(&llm, &msgs).await
}

/// 一句话直达：首屏那颗「一键生成」按的就是它。
///
/// 规划书把访谈当成必经之路，但现场跑下来 4–6 轮问答要三四分钟，
/// 排队的人只是想看见页面开始长。这条路径把「说清楚」压缩成一次调用，
/// 聊天入口照旧保留给愿意细说的人。
///
/// **它只在两种情况下报错：一句话是空的、模型密钥没配。**
/// 模型本身挂了、超时了、JSON 写坏了都不算失败——退本地拼装照样能开工。
/// 这颗按钮的契约是「点下去一定有反应」。
#[tauri::command]
async fn quick_requirement(
    state: State<'_, AppState>,
    sentence: String,
) -> Result<Requirement, String> {
    let s = sentence.trim().to_string();
    if s.is_empty() {
        return Err("先写一句话，说说你想做个什么网站。".into());
    }
    let c = state.cfg.lock().unwrap().clone();
    if !c.configured() {
        return Err("还没配模型密钥。点右上角「设置」填一下。".into());
    }
    let llm = Llm::new(&c.api_url, &c.api_key, &c.model);

    // 25 秒是「按下去多久必须有反应」的预算，不是模型的能力上限。
    // 超时不当失败处理：本地拼装的需求单一样能开工，后面骨架阶段还会覆盖标题；
    // 让人对着一颗转圈的按钮干等才是真的失败。
    Ok(tokio::time::timeout(
        std::time::Duration::from_secs(25),
        interview::quick(&llm, &s),
    )
    .await
    .unwrap_or_else(|_| interview::quick_fallback(&s)))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Started {
    site_id: String,
    preview_url: String,
    regen_used: u32,
}

/// 开工。立刻返回预览地址，生成在后台跑、按阶段 emit。
#[tauri::command]
async fn start_generation(
    app: AppHandle,
    state: State<'_, AppState>,
    mut requirement: Requirement,
    regenerate: bool,
) -> Result<Started, String> {
    let c = state.cfg.lock().unwrap().clone();
    if !c.configured() {
        return Err("还没配模型密钥。".into());
    }
    let generation_guard = begin_generation(&state)?;
    if state.cloud_busy.load(Ordering::Acquire) {
        return Err("正在上线或上传海报，请等当前操作完成。".into());
    }
    let cloud = configured_cloud(&state)?;
    // 开工前就把令牌、AI binding 与发布能力查清楚；不要等骨架画完才告诉用户不能生图。
    cloud.capabilities().await?;
    // 以前这里是「不完整就打回去，再聊两句」。那条闸是按"访谈必经"设计的，
    // 可它拦下的从来不是坏需求，而是**没聊够轮数的好需求**——用户看到的是
    // 按钮点了弹一句"再聊两句"，然后不知道还要聊几句。
    // 现在只补不拦：标题与内容互相回填，真的一个字都没有才报错。
    interview::backfill(&mut requirement, "");
    if !requirement.is_workable() {
        return Err("需求单是空的。在首屏写一句话，或者跟真昼说说你想做什么。".into());
    }

    // 闸 2（规划书第 07 节）：同一份需求单允许重做 2–3 次。
    // 现场排队本来也不允许一个人反复重做。
    {
        let mut r = state.regen.lock().unwrap();
        if regenerate {
            if *r >= c.max_regen {
                return Err(format!(
                    "这份需求单已经重做 {} 次了，到上限了。要不先看看现在这版？",
                    *r
                ));
            }
            *r += 1;
        } else {
            *r = 0;
        }
    }
    let regen_used = *state.regen.lock().unwrap();

    let root = config::sites_dir();
    std::fs::create_dir_all(&root).map_err(|e| format!("建产物根目录失败：{e}"))?;
    let site_dir = generate::new_site_dir(&root);
    let site_id = site_dir
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("site")
        .to_string();

    let port = {
        let p = state.preview.lock().unwrap();
        p.as_ref().map(|x| x.port).ok_or("本地预览服务没起来")?
    };
    {
        let _write = begin_cloud_write(&state)?;
        *state.current.lock().unwrap() = Some(CurrentWork {
            site_id: site_id.clone(),
            site_dir: site_dir.clone(),
            title: requirement.title.trim().to_string(),
            tagline: requirement.tagline.trim().to_string(),
            cover_path: site_dir.join("assets/cover.jpg"),
            visuals: Vec::new(),
            complete: false,
        });
        *state.last_published.lock().unwrap() = None;
        *state.pending_poster.lock().unwrap() = None;
    }
    let preview_url = format!("http://127.0.0.1:{port}/{site_id}/");

    let cfg = c.clone();
    let running_site_id = site_id.clone();
    tauri::async_runtime::spawn(async move {
        let _generation_guard = generation_guard;
        let engine = Engine::new(cfg, cloud);
        let app2 = app.clone();
        let progress_site_id = running_site_id.clone();
        let result = engine
            .run(&requirement, &site_dir, move |p: Progress| {
                let is_current = app2
                    .state::<AppState>()
                    .current
                    .lock()
                    .unwrap()
                    .as_ref()
                    .is_some_and(|w| w.site_id == progress_site_id);
                if is_current {
                    let _ = app2.emit("gen:progress", p);
                }
            })
            .await;
        match result {
            Ok(o) => {
                let is_current = {
                    let state = app.state::<AppState>();
                    let mut current = state.current.lock().unwrap();
                    if let Some(work) = current.as_mut().filter(|w| w.site_id == running_site_id) {
                        work.title = o.title.clone();
                        work.tagline = o.tagline.clone();
                        work.cover_path = work.site_dir.join(&o.cover_path);
                        work.visuals = o.visuals.clone();
                        work.complete = true;
                        true
                    } else {
                        false
                    }
                };
                if is_current {
                    let _ = app.emit("gen:done", o);
                }
            }
            Err(e) => {
                let is_current = app
                    .state::<AppState>()
                    .current
                    .lock()
                    .unwrap()
                    .as_ref()
                    .is_some_and(|w| w.site_id == running_site_id);
                if is_current {
                    let _ = app.emit("gen:error", e);
                }
            }
        }
    });

    Ok(Started {
        site_id,
        preview_url,
        regen_used,
    })
}

/// 前端自检落盘。桌面端没有 devtools，窗口标题又不会跟着 `document.title` 变，
/// 所以给前端留一条能被进程外读到的通道：直接写文件。
/// 出现白屏 / 布局错位时，先看 `<data_dir>/ui-diag.txt`。
///
/// **必须追加，不能覆写**：前端有两路自检——index.html 的布局自检在 DOMContentLoaded
/// 就发，app.js 的事件通道自检要等 emit 到达（起来 2 秒后）。原来用 `fs::write`
/// 整文件覆盖，布局那路先落盘、事件那路后落盘本该覆盖它，可一旦事件通道是坏的，
/// 后一路根本不会发，文件里就只剩布局自检——看上去"自检通过"，
/// 恰恰把唯一能暴露故障的那条信息给吞了。追加之后，缺哪一段就是哪一段坏了。
#[tauri::command]
fn ui_diag(payload: String) -> Result<(), String> {
    use std::io::Write;
    let p = config::data_dir().join("ui-diag.txt");
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    // 每次启动都从头记：留着上一轮的会让人对着旧证据排查这一轮的故障
    if RUN_STAMP
        .get_or_init(|| std::sync::atomic::AtomicBool::new(false))
        .swap(true, std::sync::atomic::Ordering::SeqCst)
        == false
    {
        std::fs::write(&p, format!("=== 本次启动 pid={} ===\n", std::process::id()))
            .map_err(|e| e.to_string())?;
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&p)
        .map_err(|e| e.to_string())?;
    writeln!(f, "{payload}\n").map_err(|e| e.to_string())
}

/// 本进程是否已经清过一次 ui-diag.txt
static RUN_STAMP: std::sync::OnceLock<std::sync::atomic::AtomicBool> = std::sync::OnceLock::new();

#[tauri::command]
fn preview_root(state: State<'_, AppState>) -> Result<String, String> {
    let p = state.preview.lock().unwrap();
    p.as_ref()
        .map(|x| x.url())
        .ok_or_else(|| "本地预览服务没起来".to_string())
}

/// 用系统默认浏览器全屏打开成品（规划书 9:00–10:00 那一段）
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    // 只放行本地预览与 http(s)，别让前端能拉起任意本地程序
    if !(url.starts_with("http://127.0.0.1:")
        || url.starts_with("https://")
        || url.starts_with("http://localhost:"))
    {
        return Err("拒绝打开这个地址".into());
    }
    #[cfg(windows)]
    {
        // 不经 cmd.exe：即使 URL 来自被篡改的 WebView，`&`、`|`、引号等字符也只会
        // 作为 explorer.exe 的一个参数，不可能被命令解释器当成第二条命令执行。
        std::process::Command::new("explorer.exe")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("打开浏览器失败：{e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("打开浏览器失败：{e}"))?;
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("打开浏览器失败：{e}"))?;
    }
    Ok(())
}

// 嵌套对象的键名 Tauri 不会转，所以入参结构体也要显式 camelCase
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CfgPatch {
    api_key: Option<String>,
    tts_key: Option<String>,
    api_url: Option<String>,
    model: Option<String>,
    voice_id: Option<String>,
    hall_url: Option<String>,
}

fn validate_api_change(
    current_url: &str,
    requested_url: Option<&str>,
    replacement_key: Option<&str>,
) -> Result<(), String> {
    let Some(url) = requested_url.map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(());
    };
    let has_new_key = replacement_key
        .map(str::trim)
        .is_some_and(|v| !v.is_empty());
    if url != current_url.trim() && !has_new_key {
        return Err("更换模型接口时必须同时填写这个接口的新密钥，不能沿用预置密钥。".into());
    }
    if !(url.starts_with("https://")
        || url.starts_with("http://127.0.0.1:")
        || url.starts_with("http://localhost:"))
    {
        return Err("模型接口必须是 HTTPS 地址（本机调试可用 localhost）。".into());
    }
    Ok(())
}

#[tauri::command]
fn save_config(state: State<'_, AppState>, patch: CfgPatch) -> Result<(), String> {
    let mut c = state.cfg.lock().unwrap();

    // 不能允许“只换端点、沿用预置 key”。否则安装者把 api_url 改成自己开的
    // HTTP 服务，再点一次访谈，就能在服务端日志里收走 Authorization / x-api-key。
    // 要换供应商可以，但必须在同一次保存里带一把新的 key——旧 key 先被替换，
    // 后续请求永远不会被重定向出去。
    validate_api_change(
        &c.api_url,
        patch.api_url.as_deref(),
        patch.api_key.as_deref(),
    )?;

    if let Some(v) = patch.api_key {
        c.api_key = v.trim().to_string();
    }
    if let Some(v) = patch.tts_key {
        c.tts_key = v.trim().to_string();
    }
    if let Some(v) = patch.api_url {
        if !v.trim().is_empty() {
            c.api_url = v.trim().to_string();
        }
    }
    if let Some(v) = patch.model {
        if !v.trim().is_empty() {
            c.model = v.trim().to_string();
        }
    }
    if let Some(v) = patch.voice_id {
        if !v.trim().is_empty() {
            c.voice_id = v.trim().to_string();
        }
    }
    if let Some(v) = patch.hall_url {
        c.hall_url = v.trim().to_string();
    }
    c.save().map_err(|e| format!("写配置失败：{e}"))?;
    drop(c);
    doctor::invalidate_cache()
}

/// 一键上线。标题、亮点、目录和封面都从 Rust 当前作品读取，WebView 不能改写。
#[tauri::command]
async fn publish_site(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let cloud = configured_cloud(&state)?;
    let _busy = begin_cloud_write(&state)?;
    let work = state
        .current
        .lock()
        .unwrap()
        .clone()
        .ok_or("还没有生成好的作品")?;
    if !work.complete {
        return Err("作品仍在生成中，完成后才能上线。".into());
    }

    if let Some(existing) = state
        .last_published
        .lock()
        .unwrap()
        .as_ref()
        .filter(|p| p.source_site_id == work.site_id)
        .cloned()
    {
        return serde_json::to_value(existing.result).map_err(|e| e.to_string());
    }

    // 上线前复验生图清单与密钥（生成后用户或其他进程可能改过文件）。
    generate::validate_site_assets(
        &work.site_dir,
        &SiteDraft {
            visuals: work.visuals.clone(),
            ..Default::default()
        },
    )?;
    if let Some(hit) = generate::scan_for_secrets(&work.site_dir)? {
        return Err(format!("产物疑似含密钥（{hit}），已拦下不予上线。"));
    }
    let cfg = state.cfg.lock().unwrap().clone();
    let tts_key = cfg.effective_tts_key().to_string();
    let exact = [cfg.api_key.as_str(), tts_key.as_str(), cloud.exact_secret()];
    if let Some(hit) = generate::scan_for_exact_values(&work.site_dir, &exact)? {
        return Err(format!("产物包含运行时凭据（{hit}），已拦下不予上线。"));
    }

    let expected_cover = work.site_dir.join("assets/cover.jpg");
    if work.cover_path != expected_cover {
        return Err("当前作品封面路径异常，已拒绝上线。".into());
    }
    let cover_image =
        std::fs::read(&work.cover_path).map_err(|e| format!("读取真实封面失败：{e}"))?;
    let out = mica::publish::publish_with(
        mica::publish::PublishInput {
            title: work.title,
            tagline: work.tagline,
            site_dir: work.site_dir,
            cover_image,
        },
        cloud.hall_client()?,
        cloud.upload_target(),
    )
    .await
    .map_err(|e| e.to_string())?;

    *state.last_published.lock().unwrap() = Some(LastPublished {
        source_site_id: work.site_id,
        result: out.clone(),
    });
    serde_json::to_value(out).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PosterSpec {
    nonce: String,
    creator: String,
    title: String,
    tagline: String,
    site_url: String,
    poster_url: String,
    cover_data_url: String,
    brand: cloud::BrandSpec,
    qr_matrix: Vec<Vec<u8>>,
}

/// 给 Canvas 的都是非秘密、当前作品绑定的数据；二维码矩阵在 Rust 里生成，不走 SVG。
#[tauri::command]
async fn prepare_share_poster(state: State<'_, AppState>) -> Result<PosterSpec, String> {
    if state.cloud_busy.load(Ordering::Acquire) {
        return Err("正在上线或上传海报，请稍后再生成分享卡。".into());
    }
    let cloud = configured_cloud(&state)?;
    let caps = cloud.capabilities().await?;
    let work = state
        .current
        .lock()
        .unwrap()
        .clone()
        .ok_or("还没有生成好的作品")?;
    let published = state
        .last_published
        .lock()
        .unwrap()
        .clone()
        .filter(|p| p.source_site_id == work.site_id)
        .ok_or("请先把当前作品上线，再生成分享卡/海报。")?;
    if !work.complete {
        return Err("作品仍在生成中。".into());
    }

    let cover =
        std::fs::read(&work.cover_path).map_err(|e| format!("读取海报作品画面失败：{e}"))?;
    generate::validate_generated_jpeg(&cover)
        .map_err(|e| format!("海报作品画面不是有效 JPEG：{e}"))?;
    let qr = QrCode::new(published.result.site_url.as_bytes())
        .map_err(|e| format!("生成体验二维码失败：{e}"))?;
    let width = qr.width();
    let colors = qr.to_colors();
    let qr_matrix = colors
        .chunks(width)
        .map(|row| row.iter().map(|c| u8::from(*c == Color::Dark)).collect())
        .collect();

    let nonce = uuid::Uuid::new_v4().to_string();
    *state.pending_poster.lock().unwrap() = Some(PendingPoster {
        source_site_id: work.site_id.clone(),
        publication_id: published.result.id.clone(),
        nonce: nonce.clone(),
    });

    Ok(PosterSpec {
        nonce,
        creator: published.result.creator.clone(),
        title: work.title,
        tagline: work.tagline,
        site_url: published.result.site_url,
        poster_url: published.result.poster_url,
        cover_data_url: format!("data:image/jpeg;base64,{}", BASE64.encode(cover)),
        brand: caps.brand,
        qr_matrix,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PosterUploaded {
    poster_url: String,
}

#[tauri::command]
async fn upload_share_poster(
    state: State<'_, AppState>,
    nonce: String,
    png_base64: String,
) -> Result<PosterUploaded, String> {
    let cloud = configured_cloud(&state)?;
    let _busy = begin_cloud_write(&state)?;
    let work = state
        .current
        .lock()
        .unwrap()
        .clone()
        .ok_or("还没有生成好的作品")?;
    let published = state
        .last_published
        .lock()
        .unwrap()
        .clone()
        .filter(|p| p.source_site_id == work.site_id)
        .ok_or("当前作品尚未上线，不能上传海报。")?;

    let pending = state
        .pending_poster
        .lock()
        .unwrap()
        .clone()
        .filter(|p| {
            p.nonce == nonce
                && p.source_site_id == work.site_id
                && p.publication_id == published.result.id
        })
        .ok_or("这张海报已过期或不属于当前上线作品，请重新生成。")?;

    let encoded = png_base64
        .strip_prefix("data:image/png;base64,")
        .unwrap_or(&png_base64);
    if encoded.len() > 28 * 1024 * 1024 {
        return Err("分享海报编码超过大小上限。".into());
    }
    let png = BASE64
        .decode(encoded)
        .map_err(|_| "分享海报不是合法 Base64。".to_string())?;
    validate_poster_png(&png)?;

    mica::publish::attach_poster(
        &cloud.hall_client()?,
        &cloud.upload_target(),
        &published.result.id,
        &png,
    )
    .await
    .map_err(|e| e.to_string())?;

    let mut slot = state.pending_poster.lock().unwrap();
    if slot.as_ref().is_some_and(|p| p.nonce == pending.nonce) {
        *slot = None;
    }

    Ok(PosterUploaded {
        poster_url: published.result.poster_url,
    })
}

fn validate_poster_png(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("分享海报超过 20MB。".into());
    }
    if !png_ends_at_iend(bytes) {
        return Err("分享海报不是结构完整的 PNG。".into());
    }

    let limits = png::Limits {
        bytes: 32 * 1024 * 1024,
    };
    let decoder = png::Decoder::new_with_limits(std::io::Cursor::new(bytes), limits);
    let mut reader = decoder
        .read_info()
        .map_err(|_| "分享海报 PNG 头或校验和损坏。".to_string())?;
    let info = reader.info();
    if (info.width, info.height) != (1080, 1440) {
        return Err(format!(
            "分享海报尺寸必须是 1080×1440，当前为 {}×{}。",
            info.width, info.height
        ));
    }

    let size = reader
        .output_buffer_size()
        .filter(|size| *size <= 16 * 1024 * 1024)
        .ok_or("分享海报解码后尺寸异常。")?;
    let mut decoded = vec![0; size];
    let output = reader
        .next_frame(&mut decoded)
        .map_err(|_| "分享海报 PNG 像素数据损坏。".to_string())?;
    if (output.width, output.height) != (1080, 1440) {
        return Err("分享海报 PNG 帧尺寸异常。".into());
    }
    reader
        .finish()
        .map_err(|_| "分享海报 PNG 尾部或校验和损坏。".to_string())?;
    Ok(())
}

fn png_ends_at_iend(bytes: &[u8]) -> bool {
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return false;
    }
    let mut pos = 8usize;
    while pos.checked_add(12).is_some_and(|end| end <= bytes.len()) {
        let length = u32::from_be_bytes(bytes[pos..pos + 4].try_into().unwrap()) as usize;
        let Some(end) = pos.checked_add(12).and_then(|n| n.checked_add(length)) else {
            return false;
        };
        if end > bytes.len() {
            return false;
        }
        if bytes.get(pos + 4..pos + 8) == Some(b"IEND") {
            return length == 0 && end == bytes.len();
        }
        pos = end;
    }
    false
}

/// 设备级创作者姓名（mica publish 的硬闸：没填不许开工）
#[tauri::command]
fn get_creator() -> String {
    mica::publish::creator::get()
        .ok()
        .flatten()
        .map(|p| p.name)
        .unwrap_or_default()
}

#[tauri::command]
fn set_creator(name: String) -> Result<String, String> {
    mica::publish::creator::set(&name)
        .map(|p| p.name)
        .map_err(|e| e.to_string())
}

#[cfg(windows)]
fn clear_legacy_webview_secret_stores() {
    let Some(local) = std::env::var_os("LOCALAPPDATA") else {
        return;
    };
    let profile = PathBuf::from(local)
        .join("com.migao.yiju")
        .join("EBWebView")
        .join("Default");

    // 旧版设置框是普通文本输入。WebView2 即使看到 autocomplete=off，仍可能把
    // API key 写进自身 Autofill SQLite。这个应用不需要浏览器表单历史或密码库，
    // 所以在 WebView 启动、数据库上锁前删掉这些 app 专属资料库及其日志。
    for name in ["Web Data", "Login Data", "Login Data For Account"] {
        for suffix in ["", "-journal", "-shm", "-wal"] {
            let _ = std::fs::remove_file(profile.join(format!("{name}{suffix}")));
        }
    }
}

#[cfg(windows)]
fn disable_webview_secret_persistence(app: &tauri::App) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "没有找到主 WebView".to_string())?;
    let diag = config::data_dir().join("webview-security-error.txt");
    let _ = std::fs::remove_file(&diag);

    window
        .with_webview(move |webview| {
            use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings4;
            use windows::core::Interface;

            let configured = unsafe {
                webview
                    .controller()
                    .CoreWebView2()
                    .and_then(|core| core.Settings())
                    .and_then(|settings| settings.cast::<ICoreWebView2Settings4>())
                    .and_then(|settings| {
                        settings.SetIsPasswordAutosaveEnabled(false)?;
                        settings.SetIsGeneralAutofillEnabled(false)
                    })
            };
            if let Err(error) = configured {
                let _ = std::fs::write(diag, format!("WebView2 自动填充禁用失败：{error}"));
            }
        })
        .map_err(|error| format!("WebView2 安全设置失败：{error}"))
}

fn main() {
    // 安装版可能被终端或第三方启动器从任意 working directory 拉起。先把运行根目录
    // 固定到 exe 所在位置，避免 WebView2 只创建 Tao 辅助窗而主窗口不出现。
    let _ = config::normalize_working_directory();

    #[cfg(windows)]
    clear_legacy_webview_secret_stores();

    tauri::Builder::default()
        .setup(|app| {
            let cfg = Config::load();
            let cloud = CloudConfig::load();
            let root = config::sites_dir();
            std::fs::create_dir_all(&root).ok();

            // 本地预览服务随 app 起，一个服务托管所有作品目录，
            // 每次生成只是换 URL 里的那一段。
            let preview = tauri::async_runtime::block_on(preview::serve(root))
                .map_err(|e| format!("本地预览服务启动失败：{e}"))?;

            app.manage(AppState {
                cfg: Mutex::new(cfg),
                cloud,
                preview: Mutex::new(Some(preview)),
                current: Mutex::new(None),
                last_published: Mutex::new(None),
                pending_poster: Mutex::new(None),
                cloud_busy: AtomicBool::new(false),
                generation_busy: Arc::new(AtomicBool::new(false)),
                regen: Mutex::new(0),
            });

            #[cfg(windows)]
            disable_webview_secret_persistence(app)?;

            // 事件通道自检：起来 2 秒后各发一次，前端收到谁就记到 ui-diag.txt。
            // 生成链路完全依赖 emit → listen，这条路一旦不通，界面会停在"生成中"
            // 而后台其实早就跑完了——必须能在不跑一次生成的前提下判定它通不通。
            let h = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                let a = h.emit("selftest:colon", "ping");
                let b = h.emit("selftest-dash", "ping");
                if a.is_err() || b.is_err() {
                    let p = config::data_dir().join("emit-diag.txt");
                    let _ = std::fs::write(p, format!("emit 失败\ncolon: {a:?}\ndash : {b:?}\n"));
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            boot,
            cloud_capabilities,
            environment_doctor,
            ui_diag,
            tts_synth,
            interview_turn,
            quick_requirement,
            start_generation,
            preview_root,
            open_external,
            save_config,
            publish_site,
            prepare_share_poster,
            upload_share_poster,
            get_creator,
            set_creator,
        ])
        .run(tauri::generate_context!())
        .expect("一句话生成 · 启动失败");
}

#[cfg(test)]
mod tests {
    use super::{validate_api_change, validate_poster_png};

    #[test]
    fn endpoint_cannot_redirect_the_embedded_key() {
        let current = "https://api.kimi.com/coding/v1/messages";
        assert!(
            validate_api_change(current, Some("https://attacker.example/messages"), None).is_err()
        );
        assert!(validate_api_change(
            current,
            Some("https://attacker.example/messages"),
            Some(" ")
        )
        .is_err());
    }

    #[test]
    fn endpoint_change_is_allowed_with_a_replacement_key() {
        let current = "https://api.kimi.com/coding/v1/messages";
        assert!(validate_api_change(
            current,
            Some("https://another-provider.example/messages"),
            Some("their-own-key")
        )
        .is_ok());
        // 没换地址时不该强迫用户重填 key
        assert!(validate_api_change(current, Some(current), None).is_ok());
    }

    fn poster_fixture(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, width, height);
            encoder.set_color(png::ColorType::Grayscale);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer
                .write_image_data(&vec![0; (width * height) as usize])
                .unwrap();
        }
        bytes
    }

    #[test]
    fn poster_png_requires_a_complete_exact_canvas_image() {
        let png = poster_fixture(1080, 1440);
        assert!(validate_poster_png(&png).is_ok());
        assert!(validate_poster_png(&poster_fixture(1080, 1080)).is_err());
        assert!(validate_poster_png(b"<svg></svg>").is_err());

        let mut truncated = png.clone();
        truncated.truncate(truncated.len() - 4);
        assert!(validate_poster_png(&truncated).is_err());

        let mut trailing = png.clone();
        trailing.push(0);
        assert!(validate_poster_png(&trailing).is_err());

        let mut broken_crc = png;
        broken_crc[29] ^= 1;
        assert!(validate_poster_png(&broken_crc).is_err());
    }

    #[test]
    fn remote_plain_http_endpoint_is_rejected() {
        let current = "https://api.kimi.com/coding/v1/messages";
        assert!(validate_api_change(
            current,
            Some("http://evil.example/messages"),
            Some("new-key")
        )
        .is_err());
        assert!(validate_api_change(
            current,
            Some("http://127.0.0.1:8080/messages"),
            Some("dev-key")
        )
        .is_ok());
    }
}
