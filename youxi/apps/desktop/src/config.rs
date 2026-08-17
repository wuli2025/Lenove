//! 运行配置。
//!
//! 规划书第 03 节「密钥挪到配置文件」：本地场景下内嵌密钥不再是安全问题，
//! 但挪出来是为了换 key 不用改代码。这里沿用 mica publish 板块的规矩——
//! **源码零硬编码**，凭据只从环境变量或数据目录下的配置文件来。
//!
//! 优先级：环境变量 > 配置文件 > 内置默认值（默认值里绝不含密钥）。
//! 配置文件位置：`%MICA_DATA_DIR%\yiju.json`，默认 `~\MicaBase\yiju.json`。
//!
//! 安装包分发（规划书外的新场景）：build.rs 会把**打包机**上的 yiju.json 嵌进
//! 二进制，收件人机器上首次 load 时发现没有配置文件就自动落盘——装完即用。
//! key 依旧不进源码树，只存在于打包机 home 目录和编译产物里。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// 打包机配置文件的编译期快照（见 build.rs）。打包机没配 key 时是空字节。
const BOOTSTRAP: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/bootstrap_yiju.json"));

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// Anthropic 兼容的 messages 端点全 URL
    pub api_url: String,
    /// 对话密钥。空字符串 = 未配置，UI 会顶出设置面板
    pub api_key: String,
    /// 对话模型名
    pub model: String,

    /// MiniMax T2A v2 端点（语音）。留空则前端直接退系统语音
    pub tts_url: String,
    /// 语音专用密钥。**必须和对话密钥分开**：对话可以换成任意 Anthropic 兼容网关
    /// （Kimi / 智谱 / DeepSeek…），但 T2A 只有 MiniMax 有，
    /// 两者共用一把 key 的话，一换对话供应商真昼就哑了。
    /// 留空时回落到 api_key，兼容"两边都是 MiniMax"的老配置。
    pub tts_key: String,
    /// 语音默认音色
    pub voice_id: String,

    /// 大厅地址。产物页脚的「← 回到大厅 / 我也要做一个」两个入口指向这里
    /// （规划书第 02 节的传播闭环）。公开 URL，不是凭据。
    pub hall_url: String,

    /// 闸 1（规划书第 07 节）：单次完整生成的 token 预算，触顶走简化收尾
    pub gen_token_budget: u64,
    /// 闸 2：同一份需求单允许重做几次
    pub max_regen: u32,
    /// 软截止秒数。到点仍未进「配图与细节」就跳过精修直接出成品
    /// （规划书第 01 节：8 分钟自动进简化收尾）
    pub soft_deadline_secs: u64,
    /// 现场硬上限，用于 UI 倒计时
    pub hard_deadline_secs: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            api_url: "https://api.minimaxi.com/anthropic/v1/messages".into(),
            api_key: String::new(),
            model: "MiniMax-M3".into(),
            tts_url: "https://api.minimaxi.com/v1/t2a_v2".into(),
            tts_key: String::new(),
            voice_id: "Chinese (Mandarin)_Gentle_Senior".into(),
            hall_url: "https://r2t-9f3x.llmwiki.cloud".into(),
            gen_token_budget: 150_000,
            max_regen: 3,
            soft_deadline_secs: 480,
            hard_deadline_secs: 600,
        }
    }
}

/// 数据目录，与 mica runtime 同一套约定（MICA_DATA_DIR 可覆盖）
pub fn data_dir() -> PathBuf {
    if let Ok(d) = std::env::var("MICA_DATA_DIR") {
        if !d.trim().is_empty() {
            return PathBuf::from(d);
        }
    }
    dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join("MicaBase")
}

pub fn config_path() -> PathBuf {
    data_dir().join("yiju.json")
}

/// 生成产物的落盘根目录：`<data_dir>/sites/<slug>/`
pub fn sites_dir() -> PathBuf {
    data_dir().join("sites")
}

/// 收件人机器上没有配置文件时，把打包时嵌入的那份落盘（装完即用）。
/// 只在**文件不存在**时写：用户已有的配置（哪怕是坏 JSON）绝不被覆盖。
fn bootstrap_config_file() {
    if BOOTSTRAP.is_empty() || config_path().exists() {
        return;
    }
    // 嵌入的必须真的是一份合法 Config，打包机上的文件坏了不该传染给收件人
    if serde_json::from_slice::<Config>(BOOTSTRAP).is_err() {
        return;
    }
    let p = config_path();
    if let Some(parent) = p.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    let _ = std::fs::write(p, BOOTSTRAP);
}

impl Config {
    pub fn load() -> Self {
        bootstrap_config_file();
        let mut cfg = std::fs::read_to_string(config_path())
            .ok()
            .and_then(|s| serde_json::from_str::<Config>(&s).ok())
            .unwrap_or_default();

        // 环境变量最高优先级：CI / 现场临时换 key 不必动文件
        if let Ok(v) = std::env::var("YIJU_API_KEY") {
            if !v.trim().is_empty() {
                cfg.api_key = v.trim().to_string();
            }
        }
        if let Ok(v) = std::env::var("YIJU_API_URL") {
            if !v.trim().is_empty() {
                cfg.api_url = v.trim().to_string();
            }
        }
        if let Ok(v) = std::env::var("YIJU_MODEL") {
            if !v.trim().is_empty() {
                cfg.model = v.trim().to_string();
            }
        }
        cfg
    }

    pub fn save(&self) -> std::io::Result<()> {
        let p = config_path();
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let body = serde_json::to_string_pretty(self).unwrap_or_default();
        std::fs::write(p, body)
    }

    pub fn configured(&self) -> bool {
        !self.api_key.trim().is_empty()
    }

    /// 语音实际使用的密钥。没单独配就沿用对话那把。
    pub fn effective_tts_key(&self) -> &str {
        if self.tts_key.trim().is_empty() {
            self.api_key.trim()
        } else {
            self.tts_key.trim()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_carry_no_secret() {
        // 这条是防回归：任何人往 Default 里塞 key 都会在这里红灯。
        // 规划书第 03 节的红线——源码零硬编码凭据。
        let d = Config::default();
        assert!(d.api_key.is_empty(), "默认配置里不允许出现密钥");
        assert!(!d.configured());
    }

    #[test]
    fn partial_json_falls_back_to_defaults() {
        // 用户手改配置文件只写了一半，不能让整个 app 起不来
        let c: Config = serde_json::from_str(r#"{"model":"glm-4.7"}"#).unwrap();
        assert_eq!(c.model, "glm-4.7");
        assert_eq!(c.api_url, Config::default().api_url);
        assert_eq!(c.gen_token_budget, 150_000);
    }

    #[test]
    fn tts_key_falls_back_to_api_key() {
        // 老配置里只有一把 MiniMax key，两边共用，不能因为新增字段就哑了
        let c: Config = serde_json::from_str(r#"{"api_key":"mm-1"}"#).unwrap();
        assert_eq!(c.effective_tts_key(), "mm-1");
    }

    #[test]
    fn tts_key_survives_switching_chat_provider() {
        // 换 Kimi 做对话之后，语音必须还走 MiniMax 那把——这是拆字段的全部理由
        let c: Config =
            serde_json::from_str(r#"{"api_key":"sk-kimi-x","tts_key":"mm-real"}"#).unwrap();
        assert_eq!(c.effective_tts_key(), "mm-real");
        assert_ne!(c.effective_tts_key(), c.api_key);
    }

    #[test]
    fn embedded_bootstrap_is_valid_or_empty() {
        // 打包机上 yiju.json 存在但写坏了的时候，宁可嵌空也不能嵌坏文件——
        // 坏文件会让收件人首启直接落到未配置状态还查不出原因
        if !BOOTSTRAP.is_empty() {
            let c: Config =
                serde_json::from_slice(BOOTSTRAP).expect("嵌入的 bootstrap 必须是合法配置");
            assert!(c.configured(), "嵌入了配置却没有 api_key，等于没嵌");
        }
    }

    #[test]
    fn gates_have_sane_values() {
        let d = Config::default();
        // 软截止必须早于硬截止，否则降级分支永远不会触发
        assert!(d.soft_deadline_secs < d.hard_deadline_secs);
        assert!(d.max_regen >= 2 && d.max_regen <= 3, "规划书闸 2：2–3 次");
    }
}
