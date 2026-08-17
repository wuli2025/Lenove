//! 单次生成器：吃一份需求单 JSON，跑**和桌面端完全同一条**生成链路，产出静态站。
//!
//! 和 `yiju-smoke` 的分工：smoke 是固定用例连跑 N 次看稳不稳，本工具是
//! **一次一份任意需求单**，给外部编排器（并发压测、子 agent 各跑各的）当执行单元。
//! 关键是它不起窗口、不依赖 Tauri，所以能同时开好几个互不干扰。
//!
//! 用法：
//! ```powershell
//! yiju-gen --req req.json --out D:\out\site1 [--label 番茄钟] [--json-out result.json]
//! ```
//! stdout 最后一行永远是一整行 JSON 结果，方便调用方直接解析；
//! 中间的阶段进度打到 stderr，不污染那一行。

use std::io::Write;
use std::path::PathBuf;
use std::time::Instant;
use yiju_desktop::config::Config;
use yiju_desktop::generate::{Engine, Progress};
use yiju_desktop::interview::Requirement;

fn arg(name: &str) -> Option<String> {
    let a: Vec<String> = std::env::args().collect();
    a.iter().position(|x| x == name).and_then(|i| a.get(i + 1).cloned())
}

#[tokio::main]
async fn main() {
    let req_path = match arg("--req") {
        Some(p) => p,
        None => {
            eprintln!("用法：yiju-gen --req <需求单.json> --out <产物目录> [--label 名字] [--json-out 结果.json]");
            std::process::exit(2);
        }
    };
    let out = PathBuf::from(arg("--out").unwrap_or_else(|| ".".into()));
    let label = arg("--label").unwrap_or_else(|| "未命名".into());

    let raw = match std::fs::read_to_string(&req_path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("读需求单失败 {req_path}：{e}");
            std::process::exit(2);
        }
    };
    let req: Requirement = match serde_json::from_str(&raw) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("需求单不是合法 JSON：{e}");
            std::process::exit(2);
        }
    };
    if !req.is_workable() {
        eprintln!("需求单不完整：title 和 content 都必须有");
        std::process::exit(2);
    }

    let cfg = Config::load();
    if !cfg.configured() {
        eprintln!("没有配模型密钥（YIJU_API_KEY 或 {}）", yiju_desktop::config::config_path().display());
        std::process::exit(2);
    }
    eprintln!("[{label}] 模型 {} @ {}", cfg.model, cfg.api_url);

    let t0 = Instant::now();
    let engine = Engine::new(cfg.clone());
    // 每个阶段的到达时刻单独记：现场卡在哪一段，只看总耗时是看不出来的
    let mut marks: Vec<(String, u64, u64)> = Vec::new();

    let r = engine
        .run(&req, &out, |p: Progress| {
            eprintln!("[{label}] {:>8} {:>3}%  {:>5.1}s  {} token", p.label, p.pct, p.elapsed_ms as f64 / 1000.0, p.tokens);
            let _ = std::io::stderr().flush();
            marks.push((format!("{:?}", p.stage), p.elapsed_ms, p.tokens));
        })
        .await;

    let index = out.join("index.html");
    let bytes = std::fs::metadata(&index).map(|m| m.len()).unwrap_or(0);

    let result = match r {
        Ok(o) => serde_json::json!({
            "label": label,
            "ok": true,
            "outDir": out.display().to_string(),
            "indexHtml": index.display().to_string(),
            "bytes": bytes,
            "elapsedMs": o.elapsed_ms,
            "tokens": o.tokens,
            "degraded": o.degraded,
            "degradeReason": o.degrade_reason,
            "title": o.title,
            "tagline": o.tagline,
            "stages": marks.iter().map(|(s, ms, tk)| serde_json::json!({"stage": s, "atMs": ms, "tokens": tk})).collect::<Vec<_>>(),
        }),
        Err(e) => serde_json::json!({
            "label": label,
            "ok": false,
            "outDir": out.display().to_string(),
            "bytes": bytes,
            "elapsedMs": t0.elapsed().as_millis() as u64,
            "error": e,
            "stages": marks.iter().map(|(s, ms, tk)| serde_json::json!({"stage": s, "atMs": ms, "tokens": tk})).collect::<Vec<_>>(),
        }),
    };

    let line = serde_json::to_string(&result).unwrap_or_default();
    if let Some(p) = arg("--json-out") {
        let _ = std::fs::write(&p, &line);
    }
    println!("{line}");
    if !result["ok"].as_bool().unwrap_or(false) {
        std::process::exit(1);
    }
}
