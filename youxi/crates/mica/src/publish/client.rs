//! 云端大厅 HTTP 客户端（r2-sites Worker 的 /api/works 一族）。
//!
//! 令牌只从环境变量 `MICA_PUBLISH_TOKEN` 或 `<data_dir>/publish.json` 读，
//! 源码里一个字节都不留——仓库是要公开的，硬编码等于把桶交出去。

use crate::core::{MicaError, Result};
use crate::runtime::paths;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// 大厅默认地址（已部署上线）。可用 `MICA_PUBLISH_BASE_URL` 覆盖到本地 wrangler dev。
pub const DEFAULT_BASE_URL: &str = "https://r2t-9f3x.llmwiki.cloud";

/// 服务端字段上限，与 r2-sites/src/api.js 的 createWork 校验一一对齐。
pub const MAX_TITLE_CHARS: usize = 40;
pub const MAX_TAGLINE_CHARS: usize = 60;

/// `<data_dir>/publish.json` 的形状；两个字段都可选，缺了就回落环境变量/默认值。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct PublishFile {
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    base_url: Option<String>,
}

/// 发布请求体（POST /api/works）
#[derive(Debug, Clone, Serialize)]
pub struct CreateWorkReq {
    pub creator: String,
    pub title: String,
    pub tagline: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
}

/// 发布响应体。服务端是 camelCase，这里按 Rust 习惯改 snake_case。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedWork {
    pub id: String,
    pub slug: String,
    pub site_url: String,
    pub poster_url: String,
    #[serde(default)]
    pub poster_svg: String,
    pub hall_url: String,
}

pub struct HallClient {
    base_url: String,
    token: String,
    http: reqwest::Client,
}

fn config_path() -> std::path::PathBuf {
    paths::data_dir().join("publish.json")
}

fn read_config_file() -> PublishFile {
    // 配置文件读不动/格式坏都不算致命：退回环境变量路径，错误在取令牌时统一报
    match std::fs::read(config_path()) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => PublishFile::default(),
    }
}

fn trimmed_env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// 解析出 (base_url, token)：环境变量优先，其次 `<data_dir>/publish.json`，
/// 最后才是内置默认地址。uploader 的 Worker 通道也复用它，两边地址与令牌永远一致。
pub fn resolve_endpoint() -> Result<(String, String)> {
    let file = read_config_file();
    let token = trimmed_env("MICA_PUBLISH_TOKEN")
        .or_else(|| file.token.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()))
        .ok_or_else(|| {
            MicaError::Other(format!(
                "缺少发布令牌：请设置环境变量 MICA_PUBLISH_TOKEN，或在 {} 里写 {{\"token\":\"...\"}}",
                config_path().display()
            ))
        })?;
    let base_url = trimmed_env("MICA_PUBLISH_BASE_URL")
        .or_else(|| {
            file.base_url
                .map(|u| u.trim().to_string())
                .filter(|u| !u.is_empty())
        })
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string());
    Ok((base_url.trim_end_matches('/').to_string(), token))
}

impl HallClient {
    /// 环境变量优先，其次 `<data_dir>/publish.json`，最后才是内置默认地址。
    pub fn from_env() -> Result<Self> {
        let (base_url, token) = resolve_endpoint()?;
        Self::new(base_url, token)
    }

    pub fn new(base_url: String, token: String) -> Result<Self> {
        let http = reqwest::Client::builder()
            .user_agent("MicaBase-Publisher")
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| MicaError::Other(format!("创建 HTTP 客户端失败：{e}")))?;
        Ok(Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            token,
            http,
        })
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// 把服务端的错误 JSON（`{ok:false,error:"..."}`）翻成人话；拿不到就带状态码。
    async fn explain(&self, what: &str, resp: reqwest::Response) -> MicaError {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let detail = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
            .unwrap_or_else(|| body.chars().take(300).collect());
        let hint = match status.as_u16() {
            401 => "（发布令牌无效，检查 MICA_PUBLISH_TOKEN 是否与服务端 PUBLISH_TOKEN 一致）",
            409 => "（slug 已被占用，换一个再试）",
            404 => "（作品不存在，可能已被删除）",
            _ => "",
        };
        MicaError::Other(format!("{what}失败：HTTP {status}{hint} {detail}"))
    }

    /// POST /api/works —— 建作品记录，拿 id / slug / 各种 URL。
    pub async fn create_work(&self, req: &CreateWorkReq) -> Result<CreatedWork> {
        let url = format!("{}/api/works", self.base_url);
        let resp = self
            .http
            .post(&url)
            .header("x-publish-token", &self.token)
            .json(req)
            .send()
            .await
            .map_err(|e| MicaError::Other(format!("连接大厅失败（{url}）：{e}")))?;
        if !resp.status().is_success() {
            return Err(self.explain("发布作品", resp).await);
        }
        resp.json::<CreatedWork>()
            .await
            .map_err(|e| MicaError::Other(format!("大厅返回的发布结果无法解析：{e}")))
    }

    /// PATCH /api/works/<id> —— 回填封面 / 海报 / 状态。
    pub async fn patch_work(&self, id: &str, patch: &serde_json::Value) -> Result<()> {
        let url = format!("{}/api/works/{id}", self.base_url);
        let resp = self
            .http
            .patch(&url)
            .header("x-publish-token", &self.token)
            .json(patch)
            .send()
            .await
            .map_err(|e| MicaError::Other(format!("连接大厅失败（{url}）：{e}")))?;
        if !resp.status().is_success() {
            return Err(self.explain("回填作品资源", resp).await);
        }
        Ok(())
    }

    /// POST /api/works/<id>/finalize —— 服务端核对首页与真实封面后才公开。
    pub async fn finalize_work(&self, id: &str) -> Result<()> {
        let url = format!("{}/api/works/{id}/finalize", self.base_url);
        let resp = self
            .http
            .post(&url)
            .header("x-publish-token", &self.token)
            .send()
            .await
            .map_err(|e| MicaError::Other(format!("连接大厅失败（{url}）：{e}")))?;
        if !resp.status().is_success() {
            return Err(self.explain("公开作品", resp).await);
        }
        Ok(())
    }

    /// 回填封面 key。
    pub async fn set_cover(&self, id: &str, cover_key: &str) -> Result<()> {
        self.patch_work(id, &serde_json::json!({ "cover": cover_key }))
            .await
    }

    /// 回填桌面端生成的 PNG 海报 key。
    pub async fn set_poster(&self, id: &str, poster_key: &str) -> Result<()> {
        self.patch_work(id, &serde_json::json!({ "poster": poster_key }))
            .await
    }

    /// 把作品从大厅隐藏。发布中途翻车时的回滚手段——
    /// 记录已经建了删不掉，至少不能让它以「点开就 404」的样子挂在墙上。
    pub async fn hide_work(&self, id: &str) -> Result<()> {
        self.patch_work(id, &serde_json::json!({ "status": "hidden" }))
            .await
    }

    /// GET /api/health —— 发布前的连通性预检。
    pub async fn health(&self) -> Result<bool> {
        let url = format!("{}/api/health", self.base_url);
        let resp = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| MicaError::Other(format!("连接大厅失败（{url}）：{e}")))?;
        Ok(resp.status().is_success())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_trailing_slash_trimmed() {
        let c = HallClient::new("https://example.com/".into(), "t".into()).unwrap();
        assert_eq!(c.base_url(), "https://example.com");
    }

    #[test]
    fn create_req_omits_empty_optionals() {
        let req = CreateWorkReq {
            creator: "张三".into(),
            title: "我的作品".into(),
            tagline: "一句话亮点".into(),
            slug: None,
            cover: None,
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(
            !json.contains("slug"),
            "slug 为空必须不发，让服务端自己生成：{json}"
        );
        assert!(!json.contains("cover"));
        assert!(json.contains(r#""creator":"张三""#));
    }

    #[test]
    fn created_work_deserializes_camel_case() {
        let w: CreatedWork = serde_json::from_str(
            r#"{"ok":true,"id":"abc","slug":"zhang-x1","siteUrl":"https://h/u/zhang-x1/",
                "posterUrl":"https://h/p/abc","posterSvg":"https://h/p/abc.svg","hallUrl":"https://h/"}"#,
        )
        .unwrap();
        assert_eq!(w.id, "abc");
        assert_eq!(w.slug, "zhang-x1");
        assert_eq!(w.site_url, "https://h/u/zhang-x1/");
        assert_eq!(w.hall_url, "https://h/");
    }
}
