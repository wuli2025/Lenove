//! 配置原子写 + 首改备份（PRD 2.1 数据安全基线）。

use std::fs;
use std::io;
use std::path::Path;

/// tmp 写入 + rename 落位；目标已存在且无 .bak 时先做一次性备份。
pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "bad path"))?;

    if path.exists() {
        let bak = path.with_file_name(format!("{file_name}.bak"));
        if !bak.exists() {
            fs::copy(path, &bak)?;
        }
    }

    let tmp = path.with_file_name(format!("{file_name}.tmp"));
    fs::write(&tmp, bytes)?;
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(_) => {
            // Windows：rename 不能覆盖既有文件，先移除再落位
            fs::remove_file(path)?;
            fs::rename(&tmp, path)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_creates_and_overwrites_with_backup() {
        let dir = std::env::temp_dir().join(format!("mica-atomic-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let target = dir.join("providers.json");

        atomic_write(&target, b"v1").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"v1");
        assert!(!dir.join("providers.json.bak").exists(), "首次写入不产生备份");

        atomic_write(&target, b"v2").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"v2");
        assert_eq!(fs::read(dir.join("providers.json.bak")).unwrap(), b"v1", "首改备份保留原值");

        atomic_write(&target, b"v3").unwrap();
        assert_eq!(fs::read(dir.join("providers.json.bak")).unwrap(), b"v1", "备份只做一次");
        let _ = fs::remove_dir_all(&dir);
    }
}
