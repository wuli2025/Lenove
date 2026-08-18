//! ApiEngine（PRD 4.2.1）：纯 Rust 直连 Anthropic 兼容 /v1/messages，SSE 流式，零子进程。

use crate::core::AgentEvent;
use crate::core::{ErrorCode, TaskState};
use crate::engine::batcher::DeltaBatcher;
use crate::engine::{CtrlMsg, RunCtx, RunOutcome};
use futures_util::StreamExt;
use std::sync::OnceLock;
use std::time::Duration;

/// 首字节前的最长等待：建连后服务器迟迟不回响应头也必须报错而非卡死
const RESPONSE_HEADER_TIMEOUT: Duration = Duration::from_secs(60);

/// 进程级共享 HTTP 客户端：连接池 / TLS 会话复用，避免每任务重新握手
fn shared_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .pool_max_idle_per_host(64)
            .pool_idle_timeout(Duration::from_secs(90))
            .tcp_keepalive(Duration::from_secs(30))
            .build()
            .expect("reqwest client build")
    })
}

pub async fn run(mut ctx: RunCtx) -> RunOutcome {
    let client = shared_client();

    let url = format!("{}/v1/messages", ctx.binding.base_url.trim_end_matches('/'));
    let model = ctx
        .spec
        .model
        .clone()
        .unwrap_or_else(|| ctx.binding.models.default.clone());
    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": 8192,
        "stream": true,
        "messages": [{"role": "user", "content": ctx.spec.prompt}],
    });
    if let Some(system) = &ctx.spec.system_prompt {
        body["system"] = serde_json::json!(system);
    }

    let mut req = client
        .post(&url)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json");
    req = if ctx.binding.auth_field == "ANTHROPIC_API_KEY" {
        req.header("x-api-key", &ctx.binding.secret)
    } else {
        req.header("authorization", format!("Bearer {}", ctx.binding.secret))
    };

    // 响应头阶段：限时 + 可取消（此时看门狗循环尚未启动，不设限会卡死）
    let resp = tokio::select! {
        r = tokio::time::timeout(RESPONSE_HEADER_TIMEOUT, req.json(&body).send()) => match r {
            Ok(Ok(r)) => r,
            Ok(Err(e)) => return RunOutcome::error(ErrorCode::Network, e.to_string(), true, String::new()),
            Err(_) => return RunOutcome::error(
                ErrorCode::Timeout,
                format!("no response headers within {}s", RESPONSE_HEADER_TIMEOUT.as_secs()),
                true, String::new()),
        },
        msg = ctx.ctrl.recv() => {
            return match msg {
                Some(CtrlMsg::Pause) => RunOutcome::paused(String::new()),
                _ => RunOutcome::canceled(String::new()),
            };
        }
    };

    let status = resp.status();
    if !status.is_success() {
        // 错误体读取同样限时，防慢速服务器拖死任务
        let detail = tokio::time::timeout(Duration::from_secs(10), resp.text())
            .await
            .ok()
            .and_then(|r| r.ok())
            .unwrap_or_default();
        let (code, retryable) = classify_status(status.as_u16());
        return RunOutcome::error(
            code,
            format!("{status}: {detail}"),
            retryable,
            String::new(),
        );
    }

    ctx.bus
        .emit(&ctx.spec.id, AgentEvent::Started { pid: None });

    let mut stream = resp.bytes_stream();
    let mut line_buf = String::new();
    let mut batcher = DeltaBatcher::default();
    let mut full_text = String::new();
    let mut input_tokens = 0u64;
    let mut output_tokens = 0u64;
    let mut tick = tokio::time::interval(Duration::from_millis(30));
    let started = tokio::time::Instant::now();
    let mut last_activity = tokio::time::Instant::now();

    loop {
        tokio::select! {
            chunk = stream.next() => {
                match chunk {
                    Some(Ok(bytes)) => {
                        last_activity = tokio::time::Instant::now();
                        line_buf.push_str(&String::from_utf8_lossy(&bytes));
                        while let Some(pos) = line_buf.find('\n') {
                            let line: String = line_buf.drain(..=pos).collect();
                            let line = line.trim();
                            let Some(data) = line.strip_prefix("data:") else { continue };
                            let Ok(json) = serde_json::from_str::<serde_json::Value>(data.trim()) else { continue };
                            match json.get("type").and_then(|t| t.as_str()) {
                                Some("message_start") => {
                                    if let Some(n) = json.pointer("/message/usage/input_tokens").and_then(|v| v.as_u64()) {
                                        input_tokens = n;
                                    }
                                }
                                Some("content_block_delta") => {
                                    if let Some(text) = json.pointer("/delta/text").and_then(|v| v.as_str()) {
                                        full_text.push_str(text);
                                        if full_text.len() as u64 > ctx.spec.limits.max_output_bytes {
                                            return RunOutcome::error(
                                                ErrorCode::OutputLimit,
                                                format!("output exceeded {} bytes", ctx.spec.limits.max_output_bytes),
                                                false,
                                                full_text,
                                            );
                                        }
                                        if let Some(flush) = batcher.push(text) {
                                            ctx.bus.emit(&ctx.spec.id, AgentEvent::Delta { text: flush });
                                        }
                                    }
                                }
                                Some("message_delta") => {
                                    if let Some(n) = json.pointer("/usage/output_tokens").and_then(|v| v.as_u64()) {
                                        output_tokens = n;
                                    }
                                }
                                Some("message_stop") => {
                                    if let Some(flush) = batcher.take() {
                                        ctx.bus.emit(&ctx.spec.id, AgentEvent::Delta { text: flush });
                                    }
                                    let mut out = RunOutcome::done(full_text, input_tokens, output_tokens);
                                    out.input_tokens = input_tokens;
                                    out.output_tokens = output_tokens;
                                    return out;
                                }
                                Some("error") => {
                                    let detail = json.pointer("/error/message")
                                        .and_then(|v| v.as_str()).unwrap_or("provider error").to_string();
                                    return RunOutcome::error(ErrorCode::ProviderError, detail, true, full_text);
                                }
                                _ => {}
                            }
                        }
                    }
                    Some(Err(e)) => {
                        return RunOutcome::error(ErrorCode::Network, e.to_string(), true, full_text);
                    }
                    None => {
                        // 流自然结束但没收到 message_stop：按已收内容交付
                        if let Some(flush) = batcher.take() {
                            ctx.bus.emit(&ctx.spec.id, AgentEvent::Delta { text: flush });
                        }
                        return RunOutcome::done(full_text, input_tokens, output_tokens);
                    }
                }
            }
            msg = ctx.ctrl.recv() => {
                if let Some(flush) = batcher.take() {
                    ctx.bus.emit(&ctx.spec.id, AgentEvent::Delta { text: flush });
                }
                match msg {
                    // 取消 = 中断 HTTP 流（drop stream 即断连）
                    Some(CtrlMsg::Cancel) | None => return RunOutcome::canceled(full_text),
                    // 截停留稿（PRD 4.8）：abort + 已产出增量落盘
                    Some(CtrlMsg::Pause) => return RunOutcome::paused(full_text),
                }
            }
            _ = tick.tick() => {
                if let Some(flush) = batcher.take() {
                    ctx.bus.emit(&ctx.spec.id, AgentEvent::Delta { text: flush });
                }
                if last_activity.elapsed() > Duration::from_secs(ctx.spec.limits.idle_secs) {
                    return RunOutcome::error(ErrorCode::IdleKilled,
                        format!("no output for {}s", ctx.spec.limits.idle_secs), true, full_text);
                }
                if started.elapsed() > Duration::from_secs(ctx.spec.limits.timeout_secs) {
                    return RunOutcome::error(ErrorCode::Timeout,
                        format!("hard cap {}s reached", ctx.spec.limits.timeout_secs), false, full_text);
                }
            }
        }
    }
}

fn classify_status(status: u16) -> (ErrorCode, bool) {
    match status {
        401 | 403 => (ErrorCode::Auth, false),
        429 => (ErrorCode::RateLimit, true),
        500..=599 => (ErrorCode::ProviderError, true),
        _ => (ErrorCode::ProviderError, false),
    }
}

/// 供 scheduler 判断该错误是否计入供应商故障窗口（PRD 5.5 失败分类）
pub fn counts_toward_failover(code: ErrorCode) -> bool {
    matches!(
        code,
        ErrorCode::Auth | ErrorCode::Network | ErrorCode::Timeout | ErrorCode::ProviderError
    )
}

// 终态由调度器统一发 StateChanged / Done / Error（见 scheduler::run_one），
// 此处仅返回 RunOutcome —— 保证双引擎终态路径一字不差。
#[allow(unused)]
fn _state_doc(_: TaskState) {}
