#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
//! FORMA 个人网站创作 Agent —— 桌面壳（薄装配层）。
//!
//! 三件事，仅此而已：
//!   1. 把数据目录钉死在 FORMA 自己的地盘（与 MicaBase / 有戏剧场彻底分家）；
//!   2. 在本机私有端口上起 youxi(MicaBase) 的 axum 服务，外挂 FORMA 专属路由；
//!   3. 开一个 WebView 装 ui/（FORMA 模板广场 + 创作面板 + 设置页）。
//!
//! 业务逻辑 100% 在 youxi 里，本 crate 不碰 youxi 一行源码。

mod forma;

use mica::core::RuntimeResolver;
use mica::engine::{Scheduler, SchedulerCfg};
use mica::provider::ProviderStore;
use mica::runtime::db::Db;
use mica::runtime::paths;
use mica::server::{router, AppState};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

/// 刻意避开 MicaBase 默认的 1440 与 vn-studio 的端口段，防两个壳同时开时抢口。
const DEFAULT_PORT: u16 = 1471;

/// 数据目录隔离：FORMA 的 providers.json / mica.db / claude-home 全在自己家里，
/// 绝不与 `~/MicaBase`（youxi 服务器形态）或有戏剧场共用一份。
fn forma_data_root() -> PathBuf {
    if let Ok(dir) = std::env::var("FORMA_DATA_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    dirs::data_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")))
        .join("FormaAgent")
}

/// 抢一个本机可用端口：先要 FORMA_PORT / 1471，被占就顺延，实在不行让系统分配。
fn pick_listener() -> std::io::Result<(std::net::TcpListener, u16)> {
    let want: u16 = std::env::var("FORMA_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT);
    let candidates = (want..want.saturating_add(24)).chain(std::iter::once(0));
    let mut last_err = None;
    for port in candidates {
        match std::net::TcpListener::bind(("127.0.0.1", port)) {
            Ok(l) => {
                let p = l.local_addr()?.port();
                return Ok((l, p));
            }
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap_or_else(|| std::io::Error::other("no free port")))
}

#[derive(serde::Serialize, Clone)]
struct BootInfo {
    port: u16,
    #[serde(rename = "apiBase")]
    api_base: String,
    #[serde(rename = "dataRoot")]
    data_root: String,
    version: String,
    shell: &'static str,
}

#[tauri::command]
fn forma_boot(boot: tauri::State<'_, BootInfo>) -> BootInfo {
    boot.inner().clone()
}

fn main() {
    // ── 隔离第一步：任何 mica::runtime::paths 调用之前把数据目录钉死 ──
    let data_root = forma_data_root();
    std::env::set_var("MICA_DATA_DIR", &data_root);
    let sites_dir = data_root.join("sites");

    if let Err(e) = paths::ensure_base_dirs() {
        eprintln!("[forma] 创建数据目录失败 {}: {e}", data_root.display());
    }
    if let Err(e) = std::fs::create_dir_all(&sites_dir) {
        eprintln!("[forma] 创建站点目录失败 {}: {e}", sites_dir.display());
    }

    let (port_tx, port_rx) = std::sync::mpsc::channel::<u16>();
    let server_root = data_root.clone();
    let server_sites = sites_dir.clone();

    // 后端跑在自己的线程 + 自己的 tokio 运行时里，与 Tauri 事件循环互不干扰
    std::thread::Builder::new()
        .name("forma-backend".into())
        .spawn(move || {
            let rt = match tokio::runtime::Runtime::new() {
                Ok(rt) => rt,
                Err(e) => {
                    eprintln!("[forma] tokio 运行时创建失败: {e}");
                    return;
                }
            };
            rt.block_on(async move {
                let db = match Db::open(&paths::db_path()) {
                    Ok(db) => Arc::new(db),
                    Err(e) => {
                        eprintln!("[forma] 打开 mica.db 失败: {e}");
                        return;
                    }
                };
                let providers = match ProviderStore::load(paths::providers_path()) {
                    Ok(p) => Arc::new(p),
                    Err(e) => {
                        eprintln!("[forma] 读取 providers.json 失败: {e}");
                        return;
                    }
                };

                let resolver: RuntimeResolver = Arc::new(mica::doctor::resolve);
                let scheduler =
                    Scheduler::new(SchedulerCfg::default(), db.clone(), providers.clone(), resolver);
                scheduler.start();

                let (std_listener, port) = match pick_listener() {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!("[forma] 端口绑定失败: {e}");
                        return;
                    }
                };
                let _ = port_tx.send(port);

                let ctx = Arc::new(forma::FormaCtx {
                    port,
                    data_root: server_root,
                    sites_dir: server_sites,
                    providers: providers.clone(),
                });

                // youxi 的路由原样用，FORMA 专属路由外挂 merge（mica 自带 CORS，
                // 这里只给自己的路由补一层，避免双层 CORS 头打架）
                let cors = tower_http::cors::CorsLayer::new()
                    .allow_origin(tower_http::cors::Any)
                    .allow_methods(tower_http::cors::Any)
                    .allow_headers(tower_http::cors::Any);
                let app = router(AppState { scheduler: scheduler.clone(), providers, db })
                    .merge(forma::routes(ctx).layer(cors));

                std_listener.set_nonblocking(true).ok();
                let listener = match tokio::net::TcpListener::from_std(std_listener) {
                    Ok(l) => l,
                    Err(e) => {
                        eprintln!("[forma] listener 转换失败: {e}");
                        return;
                    }
                };
                println!("[forma] backend ready on http://127.0.0.1:{port}");
                if let Err(e) = axum::serve(listener, app).await {
                    eprintln!("[forma] 服务退出: {e}");
                }
                scheduler.registry().kill_all();
            });
        })
        .expect("spawn forma-backend thread");

    let port = port_rx.recv_timeout(Duration::from_secs(15)).unwrap_or(DEFAULT_PORT);
    let boot = BootInfo {
        port,
        api_base: format!("http://127.0.0.1:{port}"),
        data_root: data_root.display().to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        shell: "tauri",
    };

    tauri::Builder::default()
        .manage(boot)
        .invoke_handler(tauri::generate_handler![forma_boot])
        .run(tauri::generate_context!())
        .expect("启动 FORMA Agent 失败");
}
