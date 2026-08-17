//! 一句话生成 · 桌面端。
//!
//! 规划书 Layer 1（本地笔记本）的四件事：
//! 需求访谈 AI → 生成引擎 → 本地预览 → 触发上线。
//!
//! 本 crate 是**薄装配层**（apps/desktop/README.md 约定）：
//! 发布链路 100% 复用 `mica::publish`，一行都不重写。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use yiju_desktop::{config, generate, interview, llm, preview};

use config::Config;
use generate::{Engine, Progress};
use interview::{Reply, Requirement};
use llm::{Llm, Msg};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

struct AppState {
    cfg: Mutex<Config>,
    preview: Mutex<Option<preview::Preview>>,
    /// 当前作品目录名（预览 URL 的那一段）
    current: Mutex<Option<String>>,
    /// 闸 2：同一份需求单已经重做了几次
    regen: Mutex<u32>,
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
        config_path: config::config_path().display().to_string(),
    }
}

/// 语音凭据。规划书第 03 节明确：本地客户端内嵌密钥可以接受（机器是你们的），
/// 红线只在**产物站**——那个必须走服务器代理。这里给的是本地 webview，
/// 复用真昼那套已经跑熟的 T2A 流水线（波形驱动口型需要在前端拿到音频流）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TtsCred {
    url: String,
    key: String,
    voice_id: String,
}

#[tauri::command]
fn tts_cred(state: State<'_, AppState>) -> TtsCred {
    let c = state.cfg.lock().unwrap();
    TtsCred {
        url: c.tts_url.clone(),
        key: c.effective_tts_key().to_string(),
        voice_id: c.voice_id.clone(),
    }
}

#[derive(Deserialize)]
struct Turn {
    role: String,
    content: String,
}

#[tauri::command]
async fn interview_turn(
    state: State<'_, AppState>,
    history: Vec<Turn>,
) -> Result<Reply, String> {
    let c = state.cfg.lock().unwrap().clone();
    if !c.configured() {
        return Err("还没配模型密钥。点右上角「设置」填一下，或改 yiju.json。".into());
    }
    let llm = Llm::new(&c.api_url, &c.api_key, &c.model);
    let msgs: Vec<Msg> = history
        .iter()
        .map(|t| if t.role == "assistant" { Msg::assistant(t.content.clone()) } else { Msg::user(t.content.clone()) })
        .collect();
    interview::turn(&llm, &msgs).await
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
    requirement: Requirement,
    regenerate: bool,
) -> Result<Started, String> {
    let c = state.cfg.lock().unwrap().clone();
    if !c.configured() {
        return Err("还没配模型密钥。".into());
    }
    if !requirement.is_workable() {
        return Err("需求单还不完整（标题和内容都得有），再聊两句。".into());
    }

    // 闸 2（规划书第 07 节）：同一份需求单允许重做 2–3 次。
    // 现场排队本来也不允许一个人反复重做。
    {
        let mut r = state.regen.lock().unwrap();
        if regenerate {
            if *r >= c.max_regen {
                return Err(format!("这份需求单已经重做 {} 次了，到上限了。要不先看看现在这版？", *r));
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
    *state.current.lock().unwrap() = Some(site_id.clone());
    let preview_url = format!("http://127.0.0.1:{port}/{site_id}/");

    let cfg = c.clone();
    tauri::async_runtime::spawn(async move {
        let engine = Engine::new(cfg);
        let app2 = app.clone();
        let result = engine
            .run(&requirement, &site_dir, move |p: Progress| {
                let _ = app2.emit("gen:progress", p);
            })
            .await;
        match result {
            Ok(o) => {
                let _ = app.emit("gen:done", o);
            }
            Err(e) => {
                let _ = app.emit("gen:error", e);
            }
        }
    });

    Ok(Started { site_id, preview_url, regen_used })
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
    if RUN_STAMP.get_or_init(|| std::sync::atomic::AtomicBool::new(false))
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
    p.as_ref().map(|x| x.url()).ok_or_else(|| "本地预览服务没起来".to_string())
}

/// 用系统默认浏览器全屏打开成品（规划书 9:00–10:00 那一段）
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    // 只放行本地预览与 http(s)，别让前端能拉起任意本地程序
    if !(url.starts_with("http://127.0.0.1:") || url.starts_with("https://") || url.starts_with("http://localhost:")) {
        return Err("拒绝打开这个地址".into());
    }
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|e| format!("打开浏览器失败：{e}"))?;
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("open")
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

#[tauri::command]
fn save_config(state: State<'_, AppState>, patch: CfgPatch) -> Result<(), String> {
    let mut c = state.cfg.lock().unwrap();
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
    c.save().map_err(|e| format!("写配置失败：{e}"))
}

/// 一键上线。100% 复用 mica::publish —— 姓名闸、R2 上传、大厅登记、
/// 失败回滚全都在那边，这里只做参数搬运。
#[tauri::command]
async fn publish_site(
    state: State<'_, AppState>,
    title: String,
    tagline: String,
) -> Result<serde_json::Value, String> {
    let site_id = state
        .current
        .lock()
        .unwrap()
        .clone()
        .ok_or("还没有生成好的作品")?;
    let site_dir: PathBuf = config::sites_dir().join(site_id);

    // 上线前再扫一次密钥（R4）。生成时扫过一次，但用户可能手改过产物。
    if let Some(hit) = generate::scan_for_secrets(&site_dir)? {
        return Err(format!("产物疑似含密钥（{hit}），已拦下不予上线。"));
    }

    let out = mica::publish::publish(mica::publish::PublishInput {
        title,
        tagline,
        site_dir,
        cover_png: None,
    })
    .await
    .map_err(|e| e.to_string())?;

    serde_json::to_value(out).map_err(|e| e.to_string())
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

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let cfg = Config::load();
            let root = config::sites_dir();
            std::fs::create_dir_all(&root).ok();

            // 本地预览服务随 app 起，一个服务托管所有作品目录，
            // 每次生成只是换 URL 里的那一段。
            let preview = tauri::async_runtime::block_on(preview::serve(root))
                .map_err(|e| format!("本地预览服务启动失败：{e}"))?;

            app.manage(AppState {
                cfg: Mutex::new(cfg),
                preview: Mutex::new(Some(preview)),
                current: Mutex::new(None),
                regen: Mutex::new(0),
            });

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
                    let _ = std::fs::write(
                        p,
                        format!("emit 失败\ncolon: {a:?}\ndash : {b:?}\n"),
                    );
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            boot,
            ui_diag,
            tts_cred,
            interview_turn,
            start_generation,
            preview_root,
            open_external,
            save_config,
            publish_site,
            get_creator,
            set_creator,
        ])
        .run(tauri::generate_context!())
        .expect("一句话生成 · 启动失败");
}
