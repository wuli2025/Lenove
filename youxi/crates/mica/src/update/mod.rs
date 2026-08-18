//! 远程更新（模仿 Polaris 的自更新，但收敛到设置页触发）。
//! 数据源：GitHub 仓库 wuli2025/youxi 的 releases。纯 Rust reqwest 拉取，
//! 不走任何自建网关。本期只做「检查 + 给下载地址」，实际替换二进制为 P1。

use serde::Serialize;

/// 更新目标仓库（模拟上传/发布到此处，支持远程更新）。
pub const UPDATE_REPO: &str = "wuli2025/youxi";
const GITHUB_API: &str = "https://api.github.com/repos/wuli2025/youxi/releases/latest";

#[derive(Debug, Clone, Serialize)]
pub struct UpdateReport {
    /// 当前构建版本（Cargo 包版本）
    pub current: String,
    /// 远端最新版本 tag（取到时）
    pub latest: Option<String>,
    /// 是否有新版本可用
    pub update_available: bool,
    /// release 页面/下载地址
    pub download_url: Option<String>,
    /// release 说明
    pub notes: Option<String>,
    /// 检查是否成功；失败时 error 给原因（离线/限流等）
    pub ok: bool,
    pub error: Option<String>,
    pub repo: String,
}

impl UpdateReport {
    fn offline(current: &str, err: String) -> Self {
        UpdateReport {
            current: current.into(),
            latest: None,
            update_available: false,
            download_url: None,
            notes: None,
            ok: false,
            error: Some(err),
            repo: UPDATE_REPO.into(),
        }
    }
}

/// 检查远端最新版本。GitHub API 免鉴权即可读公开 releases（有限流）。
pub async fn check() -> UpdateReport {
    let current = env!("CARGO_PKG_VERSION").to_string();

    let client = match reqwest::Client::builder()
        .user_agent("MicaBase-Updater")
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => return UpdateReport::offline(&current, format!("client: {e}")),
    };

    let resp = match client.get(GITHUB_API).send().await {
        Ok(r) => r,
        Err(e) => return UpdateReport::offline(&current, format!("request: {e}")),
    };

    if !resp.status().is_success() {
        return UpdateReport::offline(&current, format!("github http {}", resp.status()));
    }

    let json: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => return UpdateReport::offline(&current, format!("parse: {e}")),
    };

    let latest = json
        .get("tag_name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let download_url = json
        .get("html_url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let notes = json
        .get("body")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let update_available = match &latest {
        Some(tag) => is_newer(&current, tag),
        None => false,
    };

    UpdateReport {
        current,
        latest,
        update_available,
        download_url,
        notes,
        ok: true,
        error: None,
        repo: UPDATE_REPO.into(),
    }
}

/// 朴素语义版本比较：去掉前导 v，按点分段数值比较；无法解析时退化为字符串不等。
fn is_newer(current: &str, latest: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        s.trim_start_matches(['v', 'V'])
            .split('.')
            .map(|p| {
                p.chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
            })
            .map(|p| p.parse::<u64>().unwrap_or(0))
            .collect()
    };
    let (c, l) = (parse(current), parse(latest));
    if c.is_empty() || l.is_empty() {
        return current != latest.trim_start_matches(['v', 'V']);
    }
    let n = c.len().max(l.len());
    for i in 0..n {
        let cv = c.get(i).copied().unwrap_or(0);
        let lv = l.get(i).copied().unwrap_or(0);
        if lv != cv {
            return lv > cv;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_compare() {
        assert!(is_newer("0.1.0", "0.2.0"));
        assert!(is_newer("0.1.0", "v0.1.1"));
        assert!(!is_newer("0.2.0", "0.1.9"));
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(is_newer("1.0.0", "1.0.1"));
    }
}
