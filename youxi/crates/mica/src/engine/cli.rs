//! CLI 引擎（PRD 4.2.3 / 4.2.4）：tokio::process 全异步 spawn claude / codex，
//! prompt 走 stdin（避 Windows argv 32767 上限），stream-json / JSONL 容错解析，
//! Job Object 杀树 + 看门狗 + stderr 64KB 尾环。

use crate::core::{AgentEvent, EngineId, ErrorCode, ResolvedRuntime, TaskState};
use crate::engine::batcher::DeltaBatcher;
use crate::engine::{CtrlMsg, RunCtx, RunOutcome};
use crate::provider::binding::{apply_managed_env, binding_env};
use crate::runtime::job::{JobHandle, DEFAULT_JOB_MEMORY_LIMIT};
use crate::runtime::paths;
use crate::runtime::registry::ProcHandle;
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

/// stderr 尾环缓冲：只留最后 64KB（PRD 4.5）
const STDERR_RING: usize = 64 * 1024;
/// 收尸上限：杀树后子进程仍不退（驱动挂死等）也不能拖住任务，超时即放行
/// （kill_on_drop + Job Object 兜底回收，任务本身照常报终态）
const REAP_TIMEOUT: Duration = Duration::from_secs(10);

/// 限时收割子进程：先补一刀 kill，再限时 wait，超时打日志放行，绝不卡死任务
async fn reap(child: &mut tokio::process::Child, task: &str) {
    let _ = child.start_kill();
    if tokio::time::timeout(REAP_TIMEOUT, child.wait()).await.is_err() {
        tracing::warn!(task, "child did not exit within {}s after kill; abandoning (kill_on_drop)", REAP_TIMEOUT.as_secs());
    }
}
/// codex 工人槽位轮转（每槽独立 CODEX_HOME，PRD 4.2.3 的坑）
static CODEX_SLOT: AtomicUsize = AtomicUsize::new(0);

/// 直通绑定：不注入任何供应商 env，沿用宿主机 CLI 自身登录态
fn is_passthrough(b: &crate::core::ProviderBinding) -> bool {
    b.base_url.is_empty() && b.secret.is_empty()
}

pub async fn run(mut ctx: RunCtx, resolved: ResolvedRuntime) -> RunOutcome {
    let engine = ctx.spec.engine;

    // 工作区（默认租户私有目录）
    let cwd = ctx
        .spec
        .cwd
        .clone()
        .unwrap_or_else(|| paths::workspace_dir(&ctx.spec.tenant, &ctx.spec.id));
    if let Err(e) = std::fs::create_dir_all(&cwd) {
        return RunOutcome::error(ErrorCode::Internal, format!("workspace: {e}"), false, String::new());
    }

    // —— Command 构造（argv 只放开关，prompt 走 stdin）——
    let mut cmd = if resolved.needs_cmd_shim {
        let mut c = Command::new("cmd");
        c.arg("/c").arg(&resolved.exe);
        c
    } else {
        Command::new(&resolved.exe)
    };
    match engine {
        EngineId::Claude => {
            cmd.args(["--print", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
            if let Some(model) = &ctx.spec.model {
                cmd.args(["--model", model]);
            }
            // 编辑器终端多轮续聊：resume 优先，其次新会话钉死 id
            if let Some(sid) = &ctx.spec.resume {
                cmd.args(["--resume", sid]);
            } else if let Some(sid) = &ctx.spec.session_id {
                cmd.args(["--session-id", sid]);
            }
            // 本机官方登录态直通（binding 全空）：保留用户 ~/.claude，不分家
            if !is_passthrough(&ctx.binding) {
                // 深隔离 CLAUDE_CONFIG_DIR（PRD 5.4）：与用户全局 ~/.claude 分家
                let home = paths::claude_home(&ctx.spec.tenant);
                let _ = std::fs::create_dir_all(&home);
                cmd.env("CLAUDE_CONFIG_DIR", &home);
            }
        }
        EngineId::Codex => {
            cmd.args(["exec", "--json", "--skip-git-repo-check"]);
            let slot = CODEX_SLOT.fetch_add(1, Ordering::Relaxed) % 64;
            let home = paths::codex_home(slot);
            let _ = std::fs::create_dir_all(&home);
            seed_codex_home(&home);
            cmd.env("CODEX_HOME", &home);
        }
        EngineId::Api => unreachable!("api engine handled by engine::api"),
    }
    cmd.current_dir(&cwd);

    // per-spawn 供应商绑定注入：先清受管键再注入（PRD 5.3）
    // 直通绑定（base_url 与 secret 全空）＝ 本机 CLI 官方登录态，env 一概不动
    if !is_passthrough(&ctx.binding) {
        apply_managed_env(&mut cmd, &binding_env(&ctx.binding));
    }

    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return RunOutcome::error(
                ErrorCode::EngineUnavailable,
                format!("spawn {}: {e}", resolved.exe.display()),
                false,
                String::new(),
            )
        }
    };
    let pid = child.id().unwrap_or(0);

    // Job Object：spawn 即入 Job（PRD 4.4）
    let job = match JobHandle::create(DEFAULT_JOB_MEMORY_LIMIT) {
        Ok(job) => {
            if let Err(e) = job.assign(&child) {
                tracing::warn!(task = %ctx.spec.id, error = %e, "job assign failed");
            }
            Some(job)
        }
        Err(e) => {
            tracing::warn!(task = %ctx.spec.id, error = %e, "job create failed");
            None
        }
    };

    // 登记；spawn 与登记间的取消窄窗口由 pending-cancel 补杀（PRD 4.4）
    if !ctx.registry.register(&ctx.spec.id, ProcHandle { pid, job }) {
        reap(&mut child, &ctx.spec.id).await;
        return RunOutcome::canceled(String::new());
    }
    ctx.bus.emit(&ctx.spec.id, AgentEvent::Started { pid: Some(pid) });

    // stdin：独立 task 写入，写完 drop 关管道给 EOF（PRD 4.2.4）
    if let Some(mut stdin) = child.stdin.take() {
        let prompt = ctx.spec.prompt.clone();
        tokio::spawn(async move {
            let _ = stdin.write_all(prompt.as_bytes()).await;
            let _ = stdin.shutdown().await;
        });
    }

    // stderr：尾环缓冲 task
    let stderr_ring: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    if let Some(mut stderr) = child.stderr.take() {
        let ring = stderr_ring.clone();
        tokio::spawn(async move {
            let mut buf = [0u8; 8192];
            while let Ok(n) = stderr.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                let mut ring = ring.lock().unwrap();
                ring.extend_from_slice(&buf[..n]);
                if ring.len() > STDERR_RING {
                    let cut = ring.len() - STDERR_RING;
                    ring.drain(..cut);
                }
            }
        });
    }

    let stdout = child.stdout.take().expect("stdout piped");
    let mut lines = BufReader::new(stdout).lines();

    let mut batcher = DeltaBatcher::default();
    let mut full_text = String::new();
    let mut final_result: Option<String> = None;
    let mut emitted_artifacts: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut input_tokens = 0u64;
    let mut output_tokens = 0u64;
    let mut tick = tokio::time::interval(Duration::from_millis(30));
    let started = tokio::time::Instant::now();
    let mut last_activity = tokio::time::Instant::now();

    let outcome = loop {
        tokio::select! {
            line = lines.next_line() => {
                match line {
                    Ok(Some(line)) => {
                        last_activity = tokio::time::Instant::now();
                        let parsed = match engine {
                            EngineId::Codex => parse_codex_line(&line),
                            _ => parse_claude_line(&line),
                        };
                        if let Some(text) = parsed.delta {
                            full_text.push_str(&text);
                            if full_text.len() as u64 > ctx.spec.limits.max_output_bytes {
                                ctx.registry.kill(&ctx.spec.id);
                                break RunOutcome::error(ErrorCode::OutputLimit,
                                    format!("output exceeded {} bytes", ctx.spec.limits.max_output_bytes),
                                    false, full_text);
                            }
                            if let Some(flush) = batcher.push(&text) {
                                ctx.bus.emit(&ctx.spec.id, AgentEvent::Delta { text: flush });
                            }
                        }
                        if let Some((name, summary)) = parsed.tool {
                            ctx.bus.emit(&ctx.spec.id, AgentEvent::ToolUse { name, summary });
                        }
                        for (path, kind) in parsed.artifacts {
                            emitted_artifacts.insert(path.clone());
                            ctx.bus.emit(&ctx.spec.id, AgentEvent::Artifact { path, kind });
                        }
                        if let Some(n) = parsed.usage_in { input_tokens = n; }
                        if let Some(n) = parsed.usage_out { output_tokens = n; }
                        if let Some(result) = parsed.result { final_result = Some(result); }
                        if parsed.is_error && final_result.is_none() {
                            final_result = Some(String::new());
                        }
                    }
                    Ok(None) => {
                        // stdout EOF：进程收尾
                        if let Some(flush) = batcher.take() {
                            ctx.bus.emit(&ctx.spec.id, AgentEvent::Delta { text: flush });
                        }
                        // 取消竞态：杀树导致的 EOF 可能先于 ctrl 消息被 select 命中，
                        // 先排空 ctrl 通道（control() 先送消息后杀树，消息必然已入队）
                        match ctx.ctrl.try_recv() {
                            Ok(CtrlMsg::Cancel) => {
                                reap(&mut child, &ctx.spec.id).await;
                                break RunOutcome::canceled(full_text);
                            }
                            Ok(CtrlMsg::Pause) => {
                                reap(&mut child, &ctx.spec.id).await;
                                break RunOutcome::paused(full_text);
                            }
                            _ => {}
                        }
                        // stdout 关闭 ≠ 进程退出：限时等待，僵住则杀树按已收内容结算
                        let status = match tokio::time::timeout(REAP_TIMEOUT, child.wait()).await {
                            Ok(s) => s,
                            Err(_) => {
                                tracing::warn!(task = %ctx.spec.id, "stdout closed but process lingered; killing");
                                ctx.registry.kill(&ctx.spec.id);
                                reap(&mut child, &ctx.spec.id).await;
                                Err(std::io::Error::other("lingered after stdout EOF"))
                            }
                        };
                        let ok = status.map(|s| s.success()).unwrap_or(false);
                        let result = final_result.clone().unwrap_or_else(|| full_text.clone());
                        if ok || final_result.is_some() {
                            break RunOutcome::done(result, input_tokens, output_tokens);
                        }
                        let tail = String::from_utf8_lossy(&stderr_ring.lock().unwrap()).into_owned();
                        break RunOutcome::error(ErrorCode::ProviderError,
                            format!("cli exited abnormally; stderr tail: {}", tail.chars().rev().take(2000).collect::<String>().chars().rev().collect::<String>()),
                            true, full_text);
                    }
                    Err(e) => {
                        match ctx.ctrl.try_recv() {
                            Ok(CtrlMsg::Cancel) => break RunOutcome::canceled(full_text),
                            Ok(CtrlMsg::Pause) => break RunOutcome::paused(full_text),
                            _ => {}
                        }
                        ctx.registry.kill(&ctx.spec.id);
                        break RunOutcome::error(ErrorCode::Internal, format!("stdout read: {e}"), false, full_text);
                    }
                }
            }
            msg = ctx.ctrl.recv() => {
                if let Some(flush) = batcher.take() {
                    ctx.bus.emit(&ctx.spec.id, AgentEvent::Delta { text: flush });
                }
                ctx.registry.kill(&ctx.spec.id);
                reap(&mut child, &ctx.spec.id).await;
                match msg {
                    Some(CtrlMsg::Cancel) | None => break RunOutcome::canceled(full_text),
                    Some(CtrlMsg::Pause) => break RunOutcome::paused(full_text),
                }
            }
            _ = tick.tick() => {
                if let Some(flush) = batcher.take() {
                    ctx.bus.emit(&ctx.spec.id, AgentEvent::Delta { text: flush });
                }
                // 看门狗（PRD 4.4：MVP 空闲判据；进程树深检为 P1）
                if last_activity.elapsed() > Duration::from_secs(ctx.spec.limits.idle_secs) {
                    ctx.registry.kill(&ctx.spec.id);
                    reap(&mut child, &ctx.spec.id).await;
                    break RunOutcome::error(ErrorCode::IdleKilled,
                        format!("no output for {}s", ctx.spec.limits.idle_secs), true, full_text);
                }
                if started.elapsed() > Duration::from_secs(ctx.spec.limits.timeout_secs) {
                    ctx.registry.kill(&ctx.spec.id);
                    reap(&mut child, &ctx.spec.id).await;
                    break RunOutcome::error(ErrorCode::Timeout,
                        format!("hard cap {}s reached", ctx.spec.limits.timeout_secs), false, full_text);
                }
            }
        }
    };

    // 产物兜底（PRD 4.2.1「基座负责落盘并发 Artifact 事件」）：
    // CLI 可能经命令执行落盘（如 codex 生图），不走 file_change 事件——
    // Done 时扫描任务工作区，补发流中未报告过的产物。
    if outcome.state == TaskState::Done {
        emit_workspace_artifacts(&ctx, &cwd, &emitted_artifacts);
    }

    ctx.registry.remove(&ctx.spec.id);
    outcome
}

/// 扫描工作区补发 Artifact（上限 100 个，防产物风暴）
fn emit_workspace_artifacts(
    ctx: &RunCtx,
    cwd: &std::path::Path,
    already: &std::collections::HashSet<String>,
) {
    let mut stack = vec![cwd.to_path_buf()];
    let mut count = 0usize;
    let mut visited = 0usize; // 遍历总量上限：大工作区不允许拖住 worker 线程
    while let Some(dir) = stack.pop() {
        let Ok(read_dir) = std::fs::read_dir(&dir) else { continue };
        for entry in read_dir.flatten() {
            visited += 1;
            if visited > 10_000 {
                tracing::warn!(task = %ctx.spec.id, "workspace scan truncated at 10k entries");
                return;
            }
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let s = path.to_string_lossy().to_string();
            if already.contains(&s) {
                continue;
            }
            ctx.bus.emit(
                &ctx.spec.id,
                AgentEvent::Artifact { kind: artifact_kind(&s).to_string(), path: s },
            );
            count += 1;
            if count >= 100 {
                return;
            }
        }
    }
}

/// 槽位 CODEX_HOME 鉴权播种：深隔离目录首次使用时从用户 `~/.codex` 复制
/// auth.json / config.toml（继承 polaris「审批预播种」思路，防 headless 首启卡登录）。
fn seed_codex_home(home: &std::path::Path) {
    let Some(user_codex) = dirs::home_dir().map(|h| h.join(".codex")) else { return };
    for file in ["auth.json", "config.toml"] {
        let dst = home.join(file);
        let src = user_codex.join(file);
        if !dst.exists() && src.is_file() {
            if let Err(e) = std::fs::copy(&src, &dst) {
                tracing::warn!(file, error = %e, "seed codex home failed");
            }
        }
    }
}

/// 单行解析产物（双 CLI 归一化）
#[derive(Default, Debug)]
pub struct ParsedLine {
    pub delta: Option<String>,
    pub tool: Option<(String, String)>,
    /// (path, kind)：file_change 等产物事件 → AgentEvent::Artifact
    pub artifacts: Vec<(String, String)>,
    pub result: Option<String>,
    pub usage_in: Option<u64>,
    pub usage_out: Option<u64>,
    pub is_error: bool,
}

fn artifact_kind(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    if [".png", ".jpg", ".jpeg", ".webp", ".gif"].iter().any(|ext| lower.ends_with(ext)) {
        "image"
    } else {
        "file"
    }
}

/// claude --print --output-format stream-json --include-partial-messages
pub fn parse_claude_line(line: &str) -> ParsedLine {
    let mut out = ParsedLine::default();
    let Ok(json) = serde_json::from_str::<serde_json::Value>(line.trim()) else { return out };
    match json.get("type").and_then(|t| t.as_str()) {
        Some("stream_event")
            if json.pointer("/event/type").and_then(|t| t.as_str())
                == Some("content_block_delta") =>
        {
            if let Some(text) = json.pointer("/event/delta/text").and_then(|v| v.as_str()) {
                out.delta = Some(text.to_string());
            }
        }
        Some("assistant") => {
            // 文本增量已由 stream_event 提供，这里只提取工具调用
            if let Some(blocks) = json.pointer("/message/content").and_then(|c| c.as_array()) {
                for block in blocks {
                    if block.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                        let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                        let summary = block.get("input").map(|i| i.to_string()).unwrap_or_default();
                        out.tool = Some((name.to_string(), truncate(&summary, 200)));
                    }
                }
            }
        }
        Some("result") => {
            out.usage_in = json.pointer("/usage/input_tokens").and_then(|v| v.as_u64());
            out.usage_out = json.pointer("/usage/output_tokens").and_then(|v| v.as_u64());
            if let Some(text) = json.get("result").and_then(|r| r.as_str()) {
                out.result = Some(text.to_string());
            } else if json.get("is_error").and_then(|e| e.as_bool()) == Some(true) {
                out.is_error = true;
            } else {
                out.result = Some(String::new());
            }
        }
        _ => {}
    }
    out
}

/// codex exec --json（JSONL 事件流）。兼容两代 schema：
/// 新版（0.14x 实测）`{"type":"item.completed","item":{...}}` / `{"type":"turn.completed","usage":{...}}`；
/// 旧版 `{"msg":{"type":"agent_message",...}}`。未知事件容忍（PRD 12.1-R2）。
pub fn parse_codex_line(line: &str) -> ParsedLine {
    let mut out = ParsedLine::default();
    let Ok(json) = serde_json::from_str::<serde_json::Value>(line.trim()) else { return out };

    // —— 新版 schema（顶层 type）——
    match json.get("type").and_then(|t| t.as_str()) {
        Some("item.completed") => {
            let item = json.get("item").cloned().unwrap_or_default();
            match item.get("type").and_then(|t| t.as_str()) {
                Some("agent_message") => {
                    if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                        out.delta = Some(text.to_string());
                        out.result = Some(text.to_string());
                    }
                }
                Some("command_execution") => {
                    let command = item.get("command").and_then(|c| c.as_str()).unwrap_or("");
                    out.tool = Some(("exec".into(), truncate(command, 200)));
                }
                // 生图/写文件产物（codex 0.14x file_change 事件）→ Artifact
                Some("file_change") => {
                    if let Some(changes) = item.get("changes").and_then(|c| c.as_array()) {
                        for change in changes {
                            if let Some(path) = change.get("path").and_then(|p| p.as_str()) {
                                out.artifacts.push((path.to_string(), artifact_kind(path).to_string()));
                            }
                        }
                    }
                }
                Some("error") => out.is_error = true,
                _ => {}
            }
            return out;
        }
        Some("turn.completed") => {
            out.usage_in = json.pointer("/usage/input_tokens").and_then(|v| v.as_u64());
            out.usage_out = json.pointer("/usage/output_tokens").and_then(|v| v.as_u64());
            return out;
        }
        Some("turn.failed") | Some("error") => {
            out.is_error = true;
            return out;
        }
        Some("thread.started") | Some("turn.started") => return out,
        _ => {}
    }

    // —— 旧版 schema（msg 包裹）——
    let msg = json.get("msg").unwrap_or(&json);
    match msg.get("type").and_then(|t| t.as_str()) {
        Some("agent_message_delta") => {
            if let Some(text) = msg.get("delta").and_then(|d| d.as_str()) {
                out.delta = Some(text.to_string());
            }
        }
        Some("agent_message") => {
            if let Some(text) = msg.get("message").and_then(|m| m.as_str()) {
                out.delta = Some(text.to_string());
                out.result = Some(text.to_string());
            }
        }
        Some("exec_command_begin") => {
            let command = msg
                .get("command")
                .map(|c| match c {
                    serde_json::Value::Array(parts) => parts
                        .iter()
                        .filter_map(|p| p.as_str())
                        .collect::<Vec<_>>()
                        .join(" "),
                    other => other.to_string(),
                })
                .unwrap_or_default();
            out.tool = Some(("exec".into(), truncate(&command, 200)));
        }
        Some("token_count") => {
            out.usage_in = msg.pointer("/info/total_token_usage/input_tokens")
                .or_else(|| msg.get("input_tokens"))
                .and_then(|v| v.as_u64());
            out.usage_out = msg.pointer("/info/total_token_usage/output_tokens")
                .or_else(|| msg.get("output_tokens"))
                .and_then(|v| v.as_u64());
        }
        Some("task_complete") if out.result.is_none() => {
            out.result = msg.get("last_agent_message")
                .and_then(|m| m.as_str())
                .map(String::from)
                .or(Some(String::new()));
        }
        Some("error") => {
            out.is_error = true;
        }
        _ => {}
    }
    out
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect::<String>() + "…"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_stream_event_delta() {
        let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}}"#;
        let p = parse_claude_line(line);
        assert_eq!(p.delta.as_deref(), Some("你好"));
    }

    #[test]
    fn claude_result_with_usage() {
        let line = r#"{"type":"result","subtype":"success","result":"最终答案","usage":{"input_tokens":12,"output_tokens":34}}"#;
        let p = parse_claude_line(line);
        assert_eq!(p.result.as_deref(), Some("最终答案"));
        assert_eq!(p.usage_in, Some(12));
        assert_eq!(p.usage_out, Some(34));
    }

    #[test]
    fn claude_tool_use_extracted() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}"#;
        let p = parse_claude_line(line);
        let (name, summary) = p.tool.unwrap();
        assert_eq!(name, "Bash");
        assert!(summary.contains("ls"));
    }

    #[test]
    fn codex_agent_message_and_complete() {
        let p = parse_codex_line(r#"{"id":"1","msg":{"type":"agent_message","message":"done text"}}"#);
        assert_eq!(p.delta.as_deref(), Some("done text"));
        assert_eq!(p.result.as_deref(), Some("done text"));

        let p = parse_codex_line(r#"{"id":"2","msg":{"type":"task_complete","last_agent_message":"final"}}"#);
        assert_eq!(p.result.as_deref(), Some("final"));

        let p = parse_codex_line(r#"{"msg":{"type":"exec_command_begin","command":["bash","-c","ls"]}}"#);
        let (name, summary) = p.tool.unwrap();
        assert_eq!(name, "exec");
        assert!(summary.contains("ls"));
    }

    #[test]
    fn codex_new_schema_0144() {
        // 真机 codex-cli 0.144.4 实测输出
        let p = parse_codex_line(r#"{"type":"thread.started","thread_id":"019f"}"#);
        assert!(p.delta.is_none() && !p.is_error);

        let p = parse_codex_line(
            r#"{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"好的"}}"#,
        );
        assert_eq!(p.delta.as_deref(), Some("好的"));
        assert_eq!(p.result.as_deref(), Some("好的"));

        let p = parse_codex_line(
            r#"{"type":"turn.completed","usage":{"input_tokens":14957,"cached_input_tokens":9984,"output_tokens":5}}"#,
        );
        assert_eq!(p.usage_in, Some(14957));
        assert_eq!(p.usage_out, Some(5));

        let p = parse_codex_line(r#"{"type":"turn.failed"}"#);
        assert!(p.is_error);

        let p = parse_codex_line(
            r#"{"type":"item.completed","item":{"type":"command_execution","command":"dir"}}"#,
        );
        assert_eq!(p.tool.unwrap().1, "dir");

        // file_change → Artifact（真机 0.144.4 实测样本）
        let p = parse_codex_line(
            r#"{"type":"item.completed","item":{"id":"item_1","type":"file_change","changes":[{"path":"C:\\ws\\shanshui.png","kind":"add"},{"path":"C:\\ws\\note.txt","kind":"add"}],"status":"completed"}}"#,
        );
        assert_eq!(p.artifacts.len(), 2);
        assert_eq!(p.artifacts[0].1, "image", "png 应识别为 image 产物");
        assert_eq!(p.artifacts[1].1, "file");
    }

    #[test]
    fn garbage_lines_tolerated() {
        assert!(parse_claude_line("not json").delta.is_none());
        assert!(parse_codex_line("{}").delta.is_none());
        assert!(parse_claude_line(r#"{"type":"unknown_future_event"}"#).result.is_none());
    }
}
