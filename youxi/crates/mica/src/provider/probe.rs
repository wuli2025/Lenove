//! 连通性探测（PRD 5.5）：最小任务（8 token、10s 超时），返回延迟 + 模型回显。
//! 设置页「测试」与切换前预检共用。

use crate::core::{MicaError, ProviderBinding, Result};
use serde::Serialize;
use std::time::{Duration, Instant};

#[derive(Debug, Serialize)]
pub struct ProbeResult {
    pub ok: bool,
    pub latency_ms: u64,
    pub model_echo: Option<String>,
    pub error: Option<String>,
}

pub async fn probe(binding: &ProviderBinding) -> Result<ProbeResult> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| MicaError::Provider(e.to_string()))?;

    let url = format!("{}/v1/messages", binding.base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": binding.models.default,
        "max_tokens": 8,
        "messages": [{"role": "user", "content": "ping"}],
    });

    let mut req = client
        .post(&url)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json");
    req = if binding.auth_field == "ANTHROPIC_API_KEY" {
        req.header("x-api-key", &binding.secret)
    } else {
        req.header("authorization", format!("Bearer {}", binding.secret))
    };

    let start = Instant::now();
    match req.json(&body).send().await {
        Ok(resp) => {
            let latency_ms = start.elapsed().as_millis() as u64;
            let status = resp.status();
            let json: serde_json::Value = resp.json().await.unwrap_or_default();
            if status.is_success() {
                Ok(ProbeResult {
                    ok: true,
                    latency_ms,
                    model_echo: json.get("model").and_then(|m| m.as_str()).map(String::from),
                    error: None,
                })
            } else {
                Ok(ProbeResult {
                    ok: false,
                    latency_ms,
                    model_echo: None,
                    error: Some(format!("{status}: {json}")),
                })
            }
        }
        Err(e) => Ok(ProbeResult {
            ok: false,
            latency_ms: start.elapsed().as_millis() as u64,
            model_echo: None,
            error: Some(e.to_string()),
        }),
    }
}
