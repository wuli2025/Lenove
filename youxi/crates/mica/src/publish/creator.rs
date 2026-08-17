//! 创作者身份（现场硬性流程：没填姓名不许开工）。
//! 落 `<data_dir>/creator.json`，复用 runtime::atomic 的原子写 + 首改备份，
//! 与 providers.json 一个套路——配置只有一份，写坏了还能从 .bak 捞回来。

use crate::core::{MicaError, Result};
use crate::runtime::atomic::atomic_write;
use crate::runtime::paths;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 姓名长度上限：与大厅服务端 `creator.length > 24` 对齐。
/// 服务端是 JS，`length` 数的是 UTF-16 码元；这里数字符（char），
/// 对纯中文/ASCII 两边一致，够用且不会出现「本地放行、服务端 400」。
pub const MAX_NAME_CHARS: usize = 24;

/// 创作者档案。目前只有姓名一个字段，留结构体是为了后续加头像/联系方式不改签名。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreatorProfile {
    pub name: String,
}

/// 档案落盘位置：跟 providers.json / mica.db 同在 data 目录下。
pub fn profile_path() -> PathBuf {
    paths::data_dir().join("creator.json")
}

/// 姓名清洗 + 校验：去首尾空白 → 非空 → 无控制字符 → 长度 1–24 字符。
/// 纯空白会被 trim 成空串，直接落进「不能为空」分支。
pub fn normalize_name(raw: &str) -> Result<String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(MicaError::Other("创作者姓名不能为空，请先填写姓名再开始创作".into()));
    }
    // 控制字符（\n \t \0 等）混进姓名会把海报和 slug 一起搞坏，直接拒
    if name.chars().any(|c| c.is_control()) {
        return Err(MicaError::Other("创作者姓名不能包含换行、制表符等控制字符".into()));
    }
    let len = name.chars().count();
    if len > MAX_NAME_CHARS {
        return Err(MicaError::Other(format!(
            "创作者姓名过长（{len} 字，最多 {MAX_NAME_CHARS} 字）"
        )));
    }
    Ok(name.to_string())
}

/// 读指定路径的档案；文件不存在返回 None（首次开机的正常状态，不算错误）。
pub fn get_at(path: &Path) -> Result<Option<CreatorProfile>> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let profile: CreatorProfile = serde_json::from_slice(&bytes)?;
    // 文件可能被手改坏（空姓名 / 超长），读出来也要过一遍闸
    match normalize_name(&profile.name) {
        Ok(name) => Ok(Some(CreatorProfile { name })),
        Err(_) => Ok(None),
    }
}

/// 写指定路径的档案，返回清洗后的档案（调用方直接拿去展示，不必再读一次）。
pub fn set_at(path: &Path, name: &str) -> Result<CreatorProfile> {
    let profile = CreatorProfile { name: normalize_name(name)? };
    atomic_write(path, &serde_json::to_vec_pretty(&profile)?)?;
    Ok(profile)
}

/// 读当前档案（默认路径）。
pub fn get() -> Result<Option<CreatorProfile>> {
    get_at(&profile_path())
}

/// 设置姓名（默认路径）。
pub fn set(name: &str) -> Result<CreatorProfile> {
    set_at(&profile_path(), name)
}

/// 开工闸：拿到姓名才放行，没设置就报明确错误让上层弹输入框。
/// 发布流程第一步调它——姓名是大厅记录的主键之一，缺了后面全白干。
pub fn require_name() -> Result<String> {
    require_name_at(&profile_path())
}

/// `require_name` 的可注入路径版本（测试与多租户场景用）。
pub fn require_name_at(path: &Path) -> Result<String> {
    match get_at(path)? {
        Some(p) => Ok(p.name),
        None => Err(MicaError::Other(
            "尚未设置创作者姓名，请先填写姓名（1–24 字）再开始创作".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_path(tag: &str) -> PathBuf {
        std::env::temp_dir()
            .join(format!("mica-creator-{}-{tag}", std::process::id()))
            .join("creator.json")
    }

    #[test]
    fn name_validation_rules() {
        // 正常：去首尾空白后落库
        assert_eq!(normalize_name("  张三  ").unwrap(), "张三");
        assert_eq!(normalize_name("Ada Lovelace").unwrap(), "Ada Lovelace");

        // 空 / 纯空白（含全角空格与制表符）一律拒
        assert!(normalize_name("").is_err());
        assert!(normalize_name("   ").is_err());
        assert!(normalize_name("\t\n ").is_err());
        assert!(normalize_name("\u{3000}").is_err(), "全角空格也算纯空白");

        // 控制字符拒
        assert!(normalize_name("张\n三").is_err());
        assert!(normalize_name("张\u{0}三").is_err());

        // 边界：24 字符放行，25 字符拒
        let ok = "张".repeat(MAX_NAME_CHARS);
        assert_eq!(normalize_name(&ok).unwrap().chars().count(), MAX_NAME_CHARS);
        assert!(ok.len() > MAX_NAME_CHARS, "24 个汉字远超 24 字节，证明必须按字符数校验");
        assert!(normalize_name(&"张".repeat(MAX_NAME_CHARS + 1)).is_err());
        assert!(normalize_name(&"a".repeat(MAX_NAME_CHARS + 1)).is_err());
    }

    #[test]
    fn profile_roundtrip_and_require_gate() {
        let path = tmp_path("roundtrip");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());

        // 没设置时：get 返回 None，require_name 报错（上层据此弹输入框）
        assert!(get_at(&path).unwrap().is_none());
        assert!(require_name_at(&path).is_err());

        let p = set_at(&path, "  李四 ").unwrap();
        assert_eq!(p.name, "李四");
        assert_eq!(get_at(&path).unwrap().unwrap().name, "李四");
        assert_eq!(require_name_at(&path).unwrap(), "李四");

        // 非法姓名不写盘，旧值保持不变
        assert!(set_at(&path, "  ").is_err());
        assert_eq!(require_name_at(&path).unwrap(), "李四");

        // 文件被手改坏 → 当作未设置，重新逼用户填
        std::fs::write(&path, br#"{"name":"   "}"#).unwrap();
        assert!(get_at(&path).unwrap().is_none());
        assert!(require_name_at(&path).is_err());

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
