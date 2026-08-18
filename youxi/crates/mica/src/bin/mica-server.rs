//! mica-server：服务器形态入口（PRD 3.2 P0 主形态）。
//! `cargo run --features server --bin mica-server`
//! 环境变量：MICA_DATA_DIR（数据目录）/ MICA_PORT（默认 1440）/ MICA_CLI_SLOTS / MICA_QUEUE_CAP。

use mica::core::RuntimeResolver;
use mica::engine::{Scheduler, SchedulerCfg};
use mica::provider::ProviderStore;
use mica::runtime::db::Db;
use mica::runtime::paths;
use mica::server::{router, AppState};
use std::io::Write;
use std::sync::Arc;

#[tokio::main]
async fn main() {
    // Docker HEALTHCHECK 模式：探自身 /healthz 后退出
    if std::env::args().any(|a| a == "--healthcheck") {
        let port: u16 = std::env::var("MICA_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(1440);
        let ok = reqwest::get(format!("http://127.0.0.1:{port}/healthz"))
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false);
        std::process::exit(if ok { 0 } else { 1 });
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tower_http=warn".into()),
        )
        .init();

    // 全局 panic 钩子：写 logs/panic.log，进程不静默死亡（PRD 7.2）
    let panic_log = paths::logs_dir().join("panic.log");
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&panic_log)
        {
            let _ = writeln!(f, "[{:?}] panic: {info}", std::time::SystemTime::now());
        }
        default_hook(info);
    }));

    paths::ensure_base_dirs().expect("create MicaBase dirs");
    let db = Arc::new(Db::open(&paths::db_path()).expect("open mica.db"));
    let providers =
        Arc::new(ProviderStore::load(paths::providers_path()).expect("load providers.json"));

    let mut cfg = SchedulerCfg::default();
    if let Ok(n) = std::env::var("MICA_CLI_SLOTS") {
        if let Ok(n) = n.parse() {
            cfg.cli_slots = n;
        }
    }
    if let Ok(n) = std::env::var("MICA_QUEUE_CAP") {
        if let Ok(n) = n.parse() {
            cfg.queue_cap = n;
        }
    }

    // doctor 三级解析经闭包注入（engine 不依赖 doctor 的边界，PRD 3.1）
    let resolver: RuntimeResolver = Arc::new(mica::doctor::resolve);
    let scheduler = Scheduler::new(cfg.clone(), db.clone(), providers.clone(), resolver);
    scheduler.start();

    let state = AppState {
        scheduler: scheduler.clone(),
        providers,
        db,
    };
    let app = router(state);

    let port: u16 = std::env::var("MICA_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(1440);
    let addr = format!("127.0.0.1:{port}");
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind");
    tracing::info!(%addr, cli_slots = cfg.cli_slots, queue_cap = cfg.queue_cap, "mica-server ready");

    // 退出钩子：统一收割子进程（PRD 2.1 / 4.4）
    let registry = scheduler.registry();
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = tokio::signal::ctrl_c().await;
            tracing::info!("shutting down, killing all child process trees");
            registry.kill_all();
        })
        .await
        .expect("server");
}
