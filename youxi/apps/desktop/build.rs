//! 构建期把本机 `~\MicaBase\yiju.json` 嵌进二进制（OUT_DIR/bootstrap_yiju.json）。
//!
//! 为什么放在构建期而不是写进源码：红线是**源码零硬编码凭据**，key 只存在于
//! 打包这台机器的 home 目录和最终产物里，仓库里永远看不到它。
//! 首启时 config::bootstrap_config_file() 会把它落成目标机器的配置文件。
//!
//! 打包机上没有配置文件也能编译（嵌一段空字节，首启不写盘），
//! 只是打出来的包不带预置 key。
//!
//! 嵌进去之前先过一遍 obf::transform——这样 `strings app.exe` 直接搜 `sk-`
//! 是搜不到明文的。混淆算法与运行时共用同一份 src/obf.rs（见下方 include!）。

use std::path::PathBuf;

// 与运行时共用同一套混淆，避免两处实现漂移；obf.rs 是纯函数、无依赖。
include!("src/obf.rs");

fn main() {
    tauri_build::build();

    let src = if let Ok(d) = std::env::var("MICA_DATA_DIR") {
        if !d.trim().is_empty() {
            PathBuf::from(d).join("yiju.json")
        } else {
            home_config()
        }
    } else {
        home_config()
    };

    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("bootstrap_yiju.json");
    let body = std::fs::read(&src).unwrap_or_default();
    // 1.0.1 运行后会把打包机自己的配置也迁移成 `YJO1 + 混淆字节`。
    // 后续重打包必须先认出并还原；否则这里再 transform 一次，收件端只解一层，
    // 拿到的仍是 YJO1 blob 而不是 JSON，首启会静默落到“未配置”。
    let plain = match body.strip_prefix(OBF_MAGIC) {
        Some(rest) => transform(rest),
        None => body,
    };
    // 空文件混淆后仍是空——首启的 BOOTSTRAP.is_empty() 判断照旧成立。
    let obfuscated = transform(&plain);
    std::fs::write(&out, obfuscated).expect("写 bootstrap_yiju.json 失败");
    // 换 key 重打包：key 文件变了要触发重编（绝对路径也支持）
    println!("cargo:rerun-if-changed={}", src.display());
    println!("cargo:rerun-if-env-changed=MICA_DATA_DIR");

    write_publish_bootstrap();
}

/// 受控现场版把 Worker 发布令牌装进独立引导包；源码和构建日志都不出现令牌值。
fn write_publish_bootstrap() {
    const DEFAULT_BASE: &str = "https://r2t-9f3x.llmwiki.cloud";
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let dev_vars = manifest.join("../../../r2-sites/.dev.vars");

    let token = env_nonempty("MICA_PUBLISH_TOKEN")
        .or_else(|| env_nonempty("PUBLISH_TOKEN"))
        .or_else(|| read_dev_var(&dev_vars, "PUBLISH_TOKEN"))
        .unwrap_or_default();
    let base = env_nonempty("MICA_PUBLISH_BASE_URL").unwrap_or_else(|| DEFAULT_BASE.into());

    let mut plain = Vec::with_capacity(base.len() + token.len() + 1);
    if !token.is_empty() {
        plain.extend_from_slice(base.trim_end_matches('/').as_bytes());
        plain.push(0);
        plain.extend_from_slice(token.as_bytes());
    }
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("bootstrap_publish.bin");
    std::fs::write(out, transform(&plain)).expect("写 bootstrap_publish.bin 失败");

    println!("cargo:rerun-if-env-changed=MICA_PUBLISH_TOKEN");
    println!("cargo:rerun-if-env-changed=PUBLISH_TOKEN");
    println!("cargo:rerun-if-env-changed=MICA_PUBLISH_BASE_URL");
    println!("cargo:rerun-if-changed={}", dev_vars.display());
}

fn env_nonempty(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn read_dev_var(path: &std::path::Path, name: &str) -> Option<String> {
    let body = std::fs::read_to_string(path).ok()?;
    for raw in body.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() == name {
            let value = value.trim().trim_matches(|c| c == '\'' || c == '"').trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn home_config() -> PathBuf {
    // build.rs 里不用 dirs crate（它不是 build-dependency），自己拼 home
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join("MicaBase").join("yiju.json")
}
