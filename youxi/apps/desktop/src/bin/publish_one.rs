//! 单站发布器：把一个已生成好的站点目录推上大厅。
//!
//! 走的是**桌面端「推上线」按钮同一条** `mica::publish::publish`——
//! 姓名闸、建记录、R2 上传、失败回滚一个不少。另写一套 HTTP 脚本能更快出活，
//! 但那样压测就测不到真正会在现场跑的代码了，失去意义。
//!
//! 凭据一律走环境变量（源码零硬编码）：
//!   MICA_PUBLISH_TOKEN     发布令牌（必需）
//!   MICA_PUBLISH_BASE_URL  大厅地址，缺省用 client.rs 里的内置默认
//!
//! 用法：
//! ```powershell
//! yiju-publish --dir <站点目录> --title <主题> [--tagline <亮点>] [--cover <位图>] [--json-out r.json]
//! ```
//! stdout 最后一行是一整行 JSON 结果。

use std::path::PathBuf;

fn arg(name: &str) -> Option<String> {
    let a: Vec<String> = std::env::args().collect();
    a.iter()
        .position(|x| x == name)
        .and_then(|i| a.get(i + 1).cloned())
}

#[tokio::main]
async fn main() {
    let dir = match arg("--dir") {
        Some(d) => PathBuf::from(d),
        None => {
            eprintln!("用法：yiju-publish --dir <站点目录> --title <主题> [--tagline <亮点>] [--cover <位图>] [--json-out r.json]");
            std::process::exit(2);
        }
    };
    let title = arg("--title").unwrap_or_default();
    let tagline = arg("--tagline").unwrap_or_default();
    let cover_path = arg("--cover")
        .map(PathBuf::from)
        .unwrap_or_else(|| dir.join("assets/cover.jpg"));
    let cover_image = match std::fs::read(&cover_path) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("读取必需封面 {} 失败：{e}", cover_path.display());
            std::process::exit(3);
        }
    };

    // 上线前再扫一次密钥（规划书 R4）。生成时扫过，但产物可能被手改过。
    match yiju_desktop::generate::scan_for_secrets(&dir) {
        Ok(Some(hit)) => {
            eprintln!("产物疑似含密钥（{hit}），拒绝上线");
            std::process::exit(3);
        }
        Ok(None) => {}
        Err(e) => {
            eprintln!("密钥扫描失败：{e}");
            std::process::exit(3);
        }
    }

    let t0 = std::time::Instant::now();
    let r = mica::publish::publish(mica::publish::PublishInput {
        title: title.clone(),
        tagline,
        site_dir: dir.clone(),
        cover_image,
    })
    .await;

    let out = match r {
        Ok(o) => serde_json::json!({
            "ok": true,
            "dir": dir.display().to_string(),
            "id": o.id,
            "slug": o.slug,
            "siteUrl": o.site_url,
            "posterUrl": o.poster_url,
            "hallUrl": o.hall_url,
            "uploadedFiles": o.uploaded_files,
            "uploadMode": o.upload_mode,
            "elapsedMs": t0.elapsed().as_millis() as u64,
        }),
        Err(e) => serde_json::json!({
            "ok": false,
            "dir": dir.display().to_string(),
            "title": title,
            "error": e.to_string(),
            "elapsedMs": t0.elapsed().as_millis() as u64,
        }),
    };

    let line = serde_json::to_string(&out).unwrap_or_default();
    if let Some(p) = arg("--json-out") {
        let _ = std::fs::write(&p, &line);
    }
    println!("{line}");
    if !out["ok"].as_bool().unwrap_or(false) {
        std::process::exit(1);
    }
}
