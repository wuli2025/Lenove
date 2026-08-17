//! 构建期把本机 `~\MicaBase\yiju.json` 嵌进二进制（OUT_DIR/bootstrap_yiju.json）。
//!
//! 为什么放在构建期而不是写进源码：红线是**源码零硬编码凭据**，key 只存在于
//! 打包这台机器的 home 目录和最终产物里，仓库里永远看不到它。
//! 首启时 config::bootstrap_config_file() 会把它落成目标机器的配置文件。
//!
//! 打包机上没有配置文件也能编译（嵌一段空字节，首启不写盘），
//! 只是打出来的包不带预置 key。

use std::path::PathBuf;

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
    std::fs::write(&out, body).expect("写 bootstrap_yiju.json 失败");
    // 换 key 重打包：key 文件变了要触发重编（绝对路径也支持）
    println!("cargo:rerun-if-changed={}", src.display());
    println!("cargo:rerun-if-env-changed=MICA_DATA_DIR");
}

fn home_config() -> PathBuf {
    // build.rs 里不用 dirs crate（它不是 build-dependency），自己拼 home
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join("MicaBase").join("yiju.json")
}
