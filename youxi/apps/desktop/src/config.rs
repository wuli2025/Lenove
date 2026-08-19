//! 运行配置。
//!
//! 规划书第 03 节「密钥挪到配置文件」：本地场景下内嵌密钥不再是安全问题，
//! 但挪出来是为了换 key 不用改代码。这里沿用 mica publish 板块的规矩——
//! **源码零硬编码**，凭据只从环境变量或数据目录下的配置文件来。
//!
//! 优先级：环境变量 > 配置文件 > 内置默认值（默认值里绝不含密钥）。
//! 配置文件位置：`%MICA_DATA_DIR%\yiju.json`，默认 `~\MicaBase\yiju.json`。
//!
//! 受控安装包可由 build.rs 把**打包机**上的 yiju.json 嵌进二进制，收件人机器上
//! 首次 load 时发现没有配置文件就自动落盘。公开 GitHub 构建会强制嵌入空值，
//! 私密凭据改由安装者在首次启动设置页填写。
//!
//! 凭据混淆（见 obf.rs 顶部那段诚实话）：内嵌的这份、以及落到用户 home 的
//! yiju.json，都过一遍 obf::transform，让 `strings` 和记事本都拿不到明文 key。
//! 这是抬门槛不是上锁——真要密钥不外泄得走服务器代理。

use crate::obf;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// 打包机配置文件的编译期快照（见 build.rs），**已混淆**。
/// 打包机没配 key 时是空字节；混淆后空仍是空。
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
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("MicaBase")
}

pub fn config_path() -> PathBuf {
    data_dir().join("yiju.json")
}

/// 生成产物的落盘根目录：`<data_dir>/sites/<slug>/`
pub fn sites_dir() -> PathBuf {
    data_dir().join("sites")
}

/// 把进程工作目录固定到当前可执行文件所在目录。
///
/// NSIS 安装后的 Tauri 可执行文件如果被终端、第三方启动器或“运行”对话框从别的
/// working directory 拉起，WebView2 初始化可能只留下 13×13 的 Tao 辅助窗口，真正主窗
/// 口不会出现。Explorer 快捷方式通常碰不到，但换一台电脑不能依赖这个偶然条件。
/// Polaris 环境医生会在启动时先修正运行路径；这个桌面端不需要它那套 Node/Python PATH，
/// 但同样需要把自己的启动根目录自愈好。
pub fn normalize_working_directory() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法定位程序文件：{e}"))?;
    let dir = exe
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| "程序文件没有有效安装目录".to_string())?
        .to_path_buf();
    std::env::set_current_dir(&dir).map_err(|e| format!("无法切换到程序安装目录：{e}"))?;
    Ok(dir)
}

pub fn working_directory_is_normalized() -> Result<(), String> {
    let current = std::env::current_dir().map_err(|e| format!("无法读取程序工作目录：{e}"))?;
    let exe = std::env::current_exe().map_err(|e| format!("无法定位程序文件：{e}"))?;
    let expected = exe
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| "程序文件没有有效安装目录".to_string())?;
    if current != expected {
        return Err("程序没有从已归一化的安装目录运行，请重启应用".into());
    }
    Ok(())
}

/// 内嵌 bootstrap 的明文 JSON 字节（还原混淆）。空则返回空。
fn bootstrap_json() -> Vec<u8> {
    if BOOTSTRAP.is_empty() {
        Vec::new()
    } else {
        obf::transform(BOOTSTRAP)
    }
}

/// 混淆落盘：魔数前缀 + 混淆后的字节。让用户 home 里的 yiju.json 不是明文。
fn encode_for_disk(json: &str) -> Vec<u8> {
    let mut blob = obf::OBF_MAGIC.to_vec();
    blob.extend_from_slice(&obf::transform(json.as_bytes()));
    blob
}

/// 读盘还原成 JSON 文本。两种历史形态都要认：
/// - 带魔数的混淆文件（本版及以后写出的）；
/// - 早期版本 / 用户手改留下的**明文 JSON**——不能因为升级就读不出来。
fn decode_from_disk(bytes: &[u8]) -> Option<String> {
    if let Some(rest) = bytes.strip_prefix(obf::OBF_MAGIC) {
        String::from_utf8(obf::transform(rest)).ok()
    } else {
        String::from_utf8(bytes.to_vec()).ok()
    }
}

/// 收件人机器上没有配置文件时，把打包时嵌入的那份落盘（装完即用）。
/// 只在**文件不存在**时写：用户已有的配置（哪怕是坏 JSON）绝不被覆盖。
fn bootstrap_config_file() {
    if BOOTSTRAP.is_empty() || config_path().exists() {
        return;
    }
    let json = bootstrap_json();
    // 嵌入的必须真的是一份合法 Config，打包机上的文件坏了不该传染给收件人
    if serde_json::from_slice::<Config>(&json).is_err() {
        return;
    }
    let p = config_path();
    if let Some(parent) = p.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    // 落盘也混淆：明文 key 不进用户 home 目录
    let _ = std::fs::write(p, encode_for_disk(&String::from_utf8_lossy(&json)));
}

fn apply_api_env(cfg: &mut Config, key: Option<&str>, url: Option<&str>) {
    let key = key.map(str::trim).filter(|v| !v.is_empty());
    if let Some(v) = key {
        cfg.api_key = v.to_string();
    }
    // URL 只有和本轮新 key 成对出现才生效，不能拿磁盘里的预置 key 去新端点。
    if let Some(v) = url
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .filter(|_| key.is_some())
    {
        cfg.api_url = v.to_string();
    }
}

impl Config {
    pub fn load() -> Self {
        bootstrap_config_file();
        let loaded = std::fs::read(config_path()).ok().and_then(|bytes| {
            let legacy_plaintext = !bytes.starts_with(obf::OBF_MAGIC);
            let json = decode_from_disk(&bytes)?;
            let cfg = serde_json::from_str::<Config>(&json).ok()?;
            Some((cfg, legacy_plaintext.then_some(json)))
        });
        let (mut cfg, legacy_json) = loaded.unwrap_or_else(|| (Self::default(), None));

        // 升级迁移：老版本把 yiju.json 明文躺在 home 目录。只要它能成功解析，
        // 本次启动立刻原地改成 YJO1 混淆格式；坏 JSON 仍原样保留，绝不覆盖证据。
        // 必须在环境变量覆盖**之前**写，免得 CI 的临时 key 被意外固化到磁盘。
        if let Some(json) = legacy_json {
            let _ = std::fs::write(config_path(), encode_for_disk(&json));
        }

        // 环境变量最高优先级：CI / 现场临时换 key 不必动文件。
        // 端点和 key 必须成对覆盖：只给 YIJU_API_URL 会把预置 key 重定向到
        // 任意服务器，等价于主动外泄，所以那种组合直接忽略 URL。
        let env_key = std::env::var("YIJU_API_KEY").ok();
        let env_url = std::env::var("YIJU_API_URL").ok();
        apply_api_env(&mut cfg, env_key.as_deref(), env_url.as_deref());
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
        // 落盘混淆：设置面板保存的 key 也不能在 home 里躺成明文
        std::fs::write(p, encode_for_disk(&body))
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
    fn public_build_has_no_model_or_tts_bootstrap() {
        if option_env!("YIJU_PUBLIC_BUILD") == Some("1") {
            assert!(BOOTSTRAP.is_empty(), "公开安装包不得内嵌模型或语音密钥");
        }
    }

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
        // 坏文件会让收件人首启直接落到未配置状态还查不出原因。
        // 注意：BOOTSTRAP 现在是混淆过的，先还原再解析。
        if !BOOTSTRAP.is_empty() {
            let json = bootstrap_json();
            let c: Config = serde_json::from_slice(&json).expect("嵌入的 bootstrap 必须是合法配置");
            assert!(c.configured(), "嵌入了配置却没有 api_key，等于没嵌");
        }
    }

    #[test]
    fn embedded_bootstrap_is_not_plaintext() {
        // 混淆的意义：内嵌的这段字节里不能直接出现 key 前缀，
        // 否则 `strings app.exe | findstr sk-` 一把就抠走了
        if !BOOTSTRAP.is_empty() {
            let raw = String::from_utf8_lossy(BOOTSTRAP);
            for needle in ["sk-", "api_key", "\"model\""] {
                assert!(
                    !raw.contains(needle),
                    "内嵌 bootstrap 不该是明文（命中 {needle}）"
                );
            }
        }
    }

    #[test]
    fn disk_round_trip_survives_obfuscation() {
        // 写→读闭环：混淆落盘的配置必须能原样读回来
        let cfg = Config {
            api_key: "sk-kimi-secret".into(),
            model: "k3".into(),
            ..Config::default()
        };
        let json = serde_json::to_string_pretty(&cfg).unwrap();
        let blob = encode_for_disk(&json);
        // 落盘字节里不许出现明文 key
        assert!(!String::from_utf8_lossy(&blob).contains("sk-kimi-secret"));
        let back = decode_from_disk(&blob).expect("混淆文件要能读回");
        let parsed: Config = serde_json::from_str(&back).unwrap();
        assert_eq!(parsed.api_key, "sk-kimi-secret");
    }

    #[test]
    fn legacy_plaintext_config_still_loads() {
        // 老版本 / 用户手改留下的明文 JSON 不能因为升级就读不出来
        let json = r#"{"api_key":"mm-1","model":"glm-4.7"}"#;
        let back = decode_from_disk(json.as_bytes()).expect("明文也要能读");
        let c: Config = serde_json::from_str(&back).unwrap();
        assert_eq!(c.api_key, "mm-1");
        assert_eq!(c.model, "glm-4.7");
    }

    #[test]
    fn env_url_cannot_redirect_the_embedded_key_by_itself() {
        let mut c = Config {
            api_key: "embedded-secret".into(),
            api_url: "https://real.example".into(),
            ..Config::default()
        };
        apply_api_env(&mut c, None, Some("https://attacker.example"));
        assert_eq!(c.api_url, "https://real.example");
        assert_eq!(c.api_key, "embedded-secret");
    }

    #[test]
    fn env_endpoint_and_key_can_be_replaced_as_a_pair() {
        let mut c = Config {
            api_key: "embedded-secret".into(),
            api_url: "https://real.example".into(),
            ..Config::default()
        };
        apply_api_env(
            &mut c,
            Some("new-key"),
            Some("https://new-provider.example"),
        );
        assert_eq!(c.api_url, "https://new-provider.example");
        assert_eq!(c.api_key, "new-key");
    }

    #[test]
    fn gates_have_sane_values() {
        let d = Config::default();
        // 软截止必须早于硬截止，否则降级分支永远不会触发
        assert!(d.soft_deadline_secs < d.hard_deadline_secs);
        assert!(d.max_regen >= 2 && d.max_regen <= 3, "规划书闸 2：2–3 次");
    }
}
