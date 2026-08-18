//! 数据目录单一来源（PRD 7.1）。`MICA_DATA_DIR` 覆盖，默认 `~/MicaBase`。

use std::io;
use std::path::PathBuf;

pub fn data_root() -> PathBuf {
    if let Ok(dir) = std::env::var("MICA_DATA_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("MicaBase")
}

pub fn data_dir() -> PathBuf {
    data_root().join("data")
}

pub fn db_path() -> PathBuf {
    data_dir().join("mica.db")
}

pub fn providers_path() -> PathBuf {
    data_dir().join("providers.json")
}

pub fn runtimes_dir() -> PathBuf {
    data_root().join("runtimes")
}

/// 深隔离 CLAUDE_CONFIG_DIR（PRD 5.4）：与用户全局 ~/.claude 彻底分家
pub fn claude_home(tenant: &str) -> PathBuf {
    data_root().join("claude-home").join(tenant)
}

/// 按工人槽位隔离的 CODEX_HOME（PRD 4.2.3 的坑：并发共享会话/鉴权错配）
pub fn codex_home(slot: usize) -> PathBuf {
    data_root().join("codex-home").join(format!("slot-{slot}"))
}

pub fn workspace_dir(tenant: &str, task: &str) -> PathBuf {
    data_root().join("workspaces").join(tenant).join(task)
}

pub fn logs_dir() -> PathBuf {
    data_root().join("logs")
}

pub fn ensure_base_dirs() -> io::Result<()> {
    for d in [data_dir(), runtimes_dir(), logs_dir()] {
        std::fs::create_dir_all(d)?;
    }
    Ok(())
}
