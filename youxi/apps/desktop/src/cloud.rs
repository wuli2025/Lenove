//! Cloudflare 发布 / Workers AI 的 Rust 侧凭据与客户端。
//!
//! 令牌绝不序列化给 WebView。受控现场包首启会把构建期混淆引导值导入
//! Windows Credential Manager；内嵌值仍只是抬高逆向门槛，不能冒充服务端机密。

use crate::{config, obf};
use serde::{Deserialize, Serialize};
use std::time::Duration;

pub const DEFAULT_BASE_URL: &str = "https://r2t-9f3x.llmwiki.cloud";
const KEYRING_SERVICE: &str = "com.migao.yiju.cloudflare";
const KEYRING_USER: &str = "publisher-v1";
const BOOTSTRAP: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/bootstrap_publish.bin"));
const IMAGE_ATTEMPTS: u32 = 4;

#[derive(Clone)]
pub struct CloudConfig {
    base_url: String,
    token: String,
    http: reqwest::Client,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrandSpec {
    pub name: String,
    pub event: String,
    pub slogan: String,
    pub en: String,
    pub date: String,
    pub bg: String,
    pub accent: String,
    pub gold: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub ok: bool,
    pub publish: bool,
    pub image: bool,
    pub image_model: String,
    pub brand: BrandSpec,
}

#[derive(Serialize, Deserialize)]
struct StoredCloud {
    base_url: String,
    token: String,
}

#[derive(Default, Deserialize)]
struct LegacyPublish {
    token: Option<String>,
    base_url: Option<String>,
}

impl CloudConfig {
    pub fn load() -> Result<Self, String> {
        if let Some(token) = env_nonempty("MICA_PUBLISH_TOKEN") {
            let base =
                env_nonempty("MICA_PUBLISH_BASE_URL").unwrap_or_else(|| DEFAULT_BASE_URL.into());
            return Self::new(base, token, true);
        }
        if env_nonempty("MICA_PUBLISH_BASE_URL").is_some() {
            return Err("设置 MICA_PUBLISH_BASE_URL 时必须同时提供 MICA_PUBLISH_TOKEN".into());
        }

        // 受控安装包里的引导值代表本次版本的当前凭据，必须先于旧 Credential Manager
        // 记录读取。否则服务端轮换令牌后，即使安装了带新令牌的版本，旧值仍会永久遮住它。
        if let Some((base, token)) = decode_bootstrap() {
            let config = Self::new(base, token, false)?;
            config.persist();
            return Ok(config);
        }

        if let Some(stored) = load_keyring() {
            if let Ok(config) = Self::new(stored.base_url, stored.token, false) {
                return Ok(config);
            }
        }

        // 兼容没有内嵌引导值的开发构建：旧手工配置只读一次并导入系统凭据，
        // 不把值带进 UI。
        if let Some(stored) = load_legacy_file() {
            let config = Self::new(stored.base_url, stored.token, false)?;
            config.persist();
            return Ok(config);
        }

        Err("发布与生图凭据未装入当前安装包，请用受控打包配置重新构建".into())
    }

    fn new(base_url: String, token: String, allow_local: bool) -> Result<Self, String> {
        let base_url = validate_base(&base_url, allow_local)?;
        let token = token.trim().to_string();
        if token.is_empty() || token.len() > 4096 || token.chars().any(char::is_control) {
            return Err("发布令牌为空或格式异常".into());
        }
        let http = reqwest::Client::builder()
            .user_agent("Yiju-Desktop/1.0.1")
            .timeout(Duration::from_secs(150))
            .build()
            .map_err(|e| format!("Cloudflare 客户端启动失败：{e}"))?;
        Ok(Self {
            base_url,
            token,
            http,
        })
    }

    fn persist(&self) {
        let Some(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).ok() else {
            return;
        };
        let value = serde_json::to_string(&StoredCloud {
            base_url: self.base_url.clone(),
            token: self.token.clone(),
        });
        if let Ok(value) = value {
            let _ = entry.set_password(&value);
        }
    }

    pub fn hall_client(&self) -> Result<mica::publish::client::HallClient, String> {
        mica::publish::client::HallClient::new(self.base_url.clone(), self.token.clone())
            .map_err(|e| e.to_string())
    }

    pub fn upload_target(&self) -> mica::publish::uploader::UploadTarget {
        mica::publish::uploader::UploadTarget::Worker(mica::publish::uploader::WorkerConfig {
            base_url: self.base_url.clone(),
            token: self.token.clone(),
        })
    }

    pub async fn capabilities(&self) -> Result<Capabilities, String> {
        let url = format!("{}/api/capabilities", self.base_url);
        let response = self
            .http
            .get(&url)
            .timeout(Duration::from_secs(20))
            .header("x-publish-token", &self.token)
            .send()
            .await
            .map_err(|e| format!("连接 Cloudflare 能力预检失败：{e}"))?;
        if !response.status().is_success() {
            return Err(explain("Cloudflare 能力预检", response).await);
        }
        let caps = response
            .json::<Capabilities>()
            .await
            .map_err(|e| format!("Cloudflare 能力响应无法解析：{e}"))?;
        if !caps.ok || !caps.publish || !caps.image {
            return Err("Cloudflare 发布、R2/D1 或生图模型尚未完整启用".into());
        }
        Ok(caps)
    }

    pub async fn generate_image(&self, prompt: &str) -> Result<Vec<u8>, String> {
        let prompt = prompt.trim();
        if !(20..=1800).contains(&prompt.chars().count()) {
            return Err("生图提示必须是 20–1800 个字符".into());
        }
        let url = format!("{}/api/images/generate", self.base_url);
        let mut last_error = String::new();

        for attempt in 1..=IMAGE_ATTEMPTS {
            let response = self
                .http
                .post(&url)
                .header("x-publish-token", &self.token)
                .json(&serde_json::json!({ "prompt": prompt }))
                .send()
                .await;

            let response = match response {
                Ok(response) => response,
                Err(error) => {
                    last_error = format!("连接 Cloudflare 生图失败：{error}");
                    if attempt < IMAGE_ATTEMPTS {
                        wait_before_image_retry(attempt).await;
                        continue;
                    }
                    break;
                }
            };

            if !response.status().is_success() {
                let retryable = retryable_image_status(response.status());
                last_error = explain("Cloudflare 生图", response).await;
                if retryable && attempt < IMAGE_ATTEMPTS {
                    wait_before_image_retry(attempt).await;
                    continue;
                }
                return Err(last_error);
            }

            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_ascii_lowercase();
            let bytes = match response.bytes().await {
                Ok(bytes) => bytes.to_vec(),
                Err(error) => {
                    last_error = format!("读取 Cloudflare 生图结果失败：{error}");
                    if attempt < IMAGE_ATTEMPTS {
                        wait_before_image_retry(attempt).await;
                        continue;
                    }
                    break;
                }
            };
            if !content_type.starts_with("image/jpeg") {
                last_error = "Cloudflare 生图结果的 Content-Type 不是 JPEG".into();
                if attempt < IMAGE_ATTEMPTS {
                    wait_before_image_retry(attempt).await;
                    continue;
                }
                break;
            }
            match crate::generate::validate_generated_jpeg(&bytes) {
                Ok(_) => return Ok(bytes),
                Err(error) => {
                    last_error = format!("Cloudflare 生图结果不是有效 JPEG：{error}");
                    if attempt < IMAGE_ATTEMPTS {
                        wait_before_image_retry(attempt).await;
                    }
                }
            }
        }

        Err(format!("{last_error}（已自动尝试 {IMAGE_ATTEMPTS} 次）"))
    }

    /// 仅供 Rust 侧最终产物精确值扫描；此值不得出现在任何 IPC 返回类型中。
    pub fn exact_secret(&self) -> &str {
        &self.token
    }
}

fn retryable_image_status(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::REQUEST_TIMEOUT
        || status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
}

async fn wait_before_image_retry(attempt: u32) {
    // Workers AI 在瞬时拥塞时常返回 429/502；逐次拉开，避免几张图同时重撞网关。
    tokio::time::sleep(Duration::from_secs(u64::from(attempt) * 2)).await;
}

async fn explain(what: &str, response: reqwest::Response) -> String {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v.get("error").and_then(|v| v.as_str()).map(str::to_string))
        .unwrap_or_else(|| "服务端未返回可读原因".into());
    match status.as_u16() {
        401 => format!("{what}失败：发布令牌无效"),
        _ => format!("{what}失败：HTTP {status} {detail}"),
    }
}

fn env_nonempty(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn validate_base(raw: &str, allow_local: bool) -> Result<String, String> {
    let base = raw.trim().trim_end_matches('/');
    if base == DEFAULT_BASE_URL {
        return Ok(base.into());
    }
    if allow_local
        && (base.starts_with("http://127.0.0.1:") || base.starts_with("http://localhost:"))
    {
        return Ok(base.into());
    }
    Err(format!("拒绝未受信任的 Cloudflare 地址：{base}"))
}

fn load_keyring() -> Option<StoredCloud> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).ok()?;
    let value = entry.get_password().ok()?;
    serde_json::from_str(&value).ok()
}

fn load_legacy_file() -> Option<StoredCloud> {
    let candidates = [
        config::data_dir().join("data").join("publish.json"),
        config::data_dir().join("publish.json"),
    ];
    for path in candidates {
        let Ok(bytes) = std::fs::read(path) else {
            continue;
        };
        let Ok(file) = serde_json::from_slice::<LegacyPublish>(&bytes) else {
            continue;
        };
        let Some(token) = file
            .token
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
        else {
            continue;
        };
        let base_url = file
            .base_url
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| DEFAULT_BASE_URL.into());
        return Some(StoredCloud { base_url, token });
    }
    None
}

fn decode_bootstrap() -> Option<(String, String)> {
    if BOOTSTRAP.is_empty() {
        return None;
    }
    let plain = obf::transform(BOOTSTRAP);
    let split = plain.iter().position(|b| *b == 0)?;
    let base = std::str::from_utf8(&plain[..split])
        .ok()?
        .trim()
        .to_string();
    let token = std::str::from_utf8(&plain[split + 1..])
        .ok()?
        .trim()
        .to_string();
    if base.is_empty() || token.is_empty() {
        None
    } else {
        Some((base, token))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_base_is_pinned() {
        assert_eq!(
            validate_base(DEFAULT_BASE_URL, false).unwrap(),
            DEFAULT_BASE_URL
        );
        assert!(validate_base("https://attacker.example", false).is_err());
        assert!(validate_base("http://127.0.0.1:8787", false).is_err());
        assert!(validate_base("http://127.0.0.1:8787", true).is_ok());
    }

    #[test]
    fn only_transient_image_http_failures_are_retried() {
        assert!(retryable_image_status(reqwest::StatusCode::REQUEST_TIMEOUT));
        assert!(retryable_image_status(
            reqwest::StatusCode::TOO_MANY_REQUESTS
        ));
        assert!(retryable_image_status(reqwest::StatusCode::BAD_GATEWAY));
        assert!(retryable_image_status(
            reqwest::StatusCode::SERVICE_UNAVAILABLE
        ));
        assert!(!retryable_image_status(reqwest::StatusCode::BAD_REQUEST));
        assert!(!retryable_image_status(reqwest::StatusCode::UNAUTHORIZED));
    }

    #[test]
    fn embedded_blob_never_exposes_plaintext_without_transform() {
        if let Some((_, token)) = decode_bootstrap() {
            assert!(!String::from_utf8_lossy(BOOTSTRAP).contains(&token));
        }
    }
}
