use crate::cloud::{Capabilities, CloudConfig};
use crate::config::{self, Config};
use crate::llm::{Llm, Msg};
use crate::tts;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::task::JoinSet;

const CACHE_SCHEMA: u32 = 1;
const CACHE_MAX_AGE_SECS: u64 = 7 * 24 * 60 * 60;
const REMOTE_PROBE_ATTEMPTS: u32 = 3;
const REMOTE_PROBE_TIMEOUT: Duration = Duration::from_secs(28);
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DoctorStatus {
    Waiting,
    Running,
    Pass,
    Fail,
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorCheck {
    pub id: String,
    pub label: String,
    pub status: DoctorStatus,
    pub detail: String,
    pub required: bool,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub ready: bool,
    pub deep: bool,
    pub cached: bool,
    pub summary: String,
    pub checks: Vec<DoctorCheck>,
    pub capabilities: Option<Capabilities>,
    pub checked_at: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DoctorCache {
    schema: u32,
    app_version: String,
    fingerprint: String,
    verified_at: u64,
}

struct RemoteOutcome {
    check: DoctorCheck,
    capabilities: Option<Capabilities>,
}

pub async fn run<F>(
    cfg: Config,
    cloud: Result<CloudConfig, String>,
    preview_url: Option<String>,
    force_deep: bool,
    progress: F,
) -> DoctorReport
where
    F: Fn(DoctorCheck) + Send + Sync + 'static,
{
    let progress: Arc<dyn Fn(DoctorCheck) + Send + Sync> = Arc::new(progress);
    let checked_at = now_epoch_secs();
    let fingerprint = config_fingerprint(&cfg, cloud.as_ref().ok());
    let cache = read_cache();
    let cached = !force_deep
        && cache
            .as_ref()
            .is_some_and(|value| cache_is_valid(value, &fingerprint, checked_at));
    let deep = !cached;
    let mut checks = Vec::new();

    run_sync_check(
        &mut checks,
        &progress,
        "platform",
        "系统与架构",
        true,
        check_platform,
    );
    run_sync_check(
        &mut checks,
        &progress,
        "storage",
        "本地目录读写",
        true,
        check_storage,
    );
    run_sync_check(
        &mut checks,
        &progress,
        "config",
        "模型与语音配置",
        true,
        || check_config(&cfg),
    );
    run_sync_check(
        &mut checks,
        &progress,
        "webview",
        "系统 WebView 安全设置",
        true,
        check_webview_security,
    );

    emit_running(&progress, "preview", "本地预览服务", true);
    let preview_started = std::time::Instant::now();
    let preview_result = check_preview(preview_url.as_deref()).await;
    push_result(
        &mut checks,
        &progress,
        "preview",
        "本地预览服务",
        true,
        preview_started,
        preview_result,
    );

    let mut jobs = JoinSet::new();
    emit_running(&progress, "cloud", "Cloudflare 发布能力", true);
    let cloud_for_caps = cloud.clone();
    jobs.spawn(async move {
        let started = std::time::Instant::now();
        match cloud_for_caps {
            Ok(cloud) => {
                match tokio::time::timeout(Duration::from_secs(45), cloud.capabilities_probe())
                    .await
                {
                    Ok(Ok(capabilities)) => remote_outcome(
                        "cloud",
                        "Cloudflare 发布能力",
                        started,
                        Ok((
                            format!("发布、R2/D1 与 {} 已就绪", capabilities.image_model),
                            Some(capabilities),
                        )),
                    ),
                    Ok(Err(failure)) if cached && failure.is_transient() => cached_cloud_fallback(
                        started,
                        redact(failure.message(), &[cloud.exact_secret()]),
                    ),
                    Ok(Err(failure)) => remote_outcome(
                        "cloud",
                        "Cloudflare 发布能力",
                        started,
                        Err(redact(failure.message(), &[cloud.exact_secret()])),
                    ),
                    Err(_) if cached => {
                        cached_cloud_fallback(started, "Cloudflare 能力检查超过 45 秒".into())
                    }
                    Err(_) => remote_outcome(
                        "cloud",
                        "Cloudflare 发布能力",
                        started,
                        Err("Cloudflare 能力检查超过 45 秒".into()),
                    ),
                }
            }
            Err(error) => remote_outcome("cloud", "Cloudflare 发布能力", started, Err(error)),
        }
    });

    if deep {
        emit_running(&progress, "model", "模型 API 真实请求", true);
        let model_cfg = cfg.clone();
        jobs.spawn(async move {
            let started = std::time::Instant::now();
            let result = probe_model(&model_cfg).await;
            remote_outcome(
                "model",
                "模型 API 真实请求",
                started,
                result.map(|v| (v, None)),
            )
        });

        emit_running(&progress, "tts", "MiniMax 语音真实请求", true);
        let tts_cfg = cfg.clone();
        jobs.spawn(async move {
            let started = std::time::Instant::now();
            let result = probe_tts(&tts_cfg).await;
            remote_outcome(
                "tts",
                "MiniMax 语音真实请求",
                started,
                result.map(|v| (v, None)),
            )
        });

        emit_running(&progress, "image", "Workers AI 真实生图", true);
        let cloud_for_image = cloud.clone();
        jobs.spawn(async move {
            let started = std::time::Instant::now();
            let result = probe_image(cloud_for_image).await;
            remote_outcome(
                "image",
                "Workers AI 真实生图",
                started,
                result.map(|v| (v, None)),
            )
        });
    } else {
        for (id, label) in [
            ("model", "模型 API 真实请求"),
            ("tts", "MiniMax 语音真实请求"),
            ("image", "Workers AI 真实生图"),
        ] {
            let check = DoctorCheck {
                id: id.into(),
                label: label.into(),
                status: DoctorStatus::Pass,
                detail: "最近 7 天内已完成真实验证，本次不重复产生费用".into(),
                required: true,
                elapsed_ms: 0,
            };
            progress(check.clone());
            checks.push(check);
        }
    }

    let mut capabilities = None;
    while let Some(joined) = jobs.join_next().await {
        let outcome = match joined {
            Ok(outcome) => outcome,
            Err(_) => RemoteOutcome {
                check: DoctorCheck {
                    id: "runtime".into(),
                    label: "检查任务".into(),
                    status: DoctorStatus::Fail,
                    detail: "环境检查任务意外终止".into(),
                    required: true,
                    elapsed_ms: 0,
                },
                capabilities: None,
            },
        };
        if outcome.capabilities.is_some() {
            capabilities = outcome.capabilities;
        }
        progress(outcome.check.clone());
        checks.push(outcome.check);
    }

    checks.sort_by_key(|check| check_order(&check.id));
    let ready = checks
        .iter()
        .filter(|check| check.required)
        .all(|check| check.status == DoctorStatus::Pass);

    if ready && deep {
        let _ = write_cache(&DoctorCache {
            schema: CACHE_SCHEMA,
            app_version: APP_VERSION.into(),
            fingerprint,
            verified_at: checked_at,
        });
    }

    let failed = checks
        .iter()
        .filter(|check| check.required && check.status == DoctorStatus::Fail)
        .count();
    let cloud_deferred = checks
        .iter()
        .any(|check| check.id == "cloud" && check.status == DoctorStatus::Skipped);
    let summary = if ready && cached && cloud_deferred {
        "本机快速检查通过；云端暂时不可达，进入后可点击云端状态重试".into()
    } else if ready && cached {
        "快速检查通过；真实模型、语音和生图在最近 7 天内已验证".into()
    } else if ready {
        "全部检查通过，这台电脑可以使用所有功能".into()
    } else {
        format!("有 {failed} 项必需能力未通过，可重试、打开设置或受限进入")
    };

    DoctorReport {
        ready,
        deep,
        cached,
        summary,
        checks,
        capabilities,
        checked_at,
    }
}

pub fn invalidate_cache() -> Result<(), String> {
    let path = cache_path();
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("清理环境医生缓存失败：{error}")),
    }
}

fn run_sync_check<F>(
    checks: &mut Vec<DoctorCheck>,
    progress: &Arc<dyn Fn(DoctorCheck) + Send + Sync>,
    id: &str,
    label: &str,
    required: bool,
    task: F,
) where
    F: FnOnce() -> Result<String, String>,
{
    emit_running(progress, id, label, required);
    let started = std::time::Instant::now();
    push_result(checks, progress, id, label, required, started, task());
}

fn push_result(
    checks: &mut Vec<DoctorCheck>,
    progress: &Arc<dyn Fn(DoctorCheck) + Send + Sync>,
    id: &str,
    label: &str,
    required: bool,
    started: std::time::Instant,
    result: Result<String, String>,
) {
    let check = completed_check(id, label, required, started, result);
    progress(check.clone());
    checks.push(check);
}

fn emit_running(
    progress: &Arc<dyn Fn(DoctorCheck) + Send + Sync>,
    id: &str,
    label: &str,
    required: bool,
) {
    progress(DoctorCheck {
        id: id.into(),
        label: label.into(),
        status: DoctorStatus::Running,
        detail: "正在检查…".into(),
        required,
        elapsed_ms: 0,
    });
}

fn completed_check(
    id: &str,
    label: &str,
    required: bool,
    started: std::time::Instant,
    result: Result<String, String>,
) -> DoctorCheck {
    let (status, detail) = match result {
        Ok(detail) => (DoctorStatus::Pass, detail),
        Err(detail) => (DoctorStatus::Fail, detail),
    };
    DoctorCheck {
        id: id.into(),
        label: label.into(),
        status,
        detail,
        required,
        elapsed_ms: started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
    }
}

fn remote_outcome(
    id: &str,
    label: &str,
    started: std::time::Instant,
    result: Result<(String, Option<Capabilities>), String>,
) -> RemoteOutcome {
    match result {
        Ok((detail, capabilities)) => RemoteOutcome {
            check: completed_check(id, label, true, started, Ok(detail)),
            capabilities,
        },
        Err(error) => RemoteOutcome {
            check: completed_check(id, label, true, started, Err(error)),
            capabilities: None,
        },
    }
}

fn cached_cloud_fallback(started: std::time::Instant, error: String) -> RemoteOutcome {
    RemoteOutcome {
        check: DoctorCheck {
            id: "cloud".into(),
            label: "Cloudflare 发布能力".into(),
            status: DoctorStatus::Skipped,
            detail: format!("最近 7 天已验证；本次云端探测暂不可用，进入后可重试：{error}"),
            required: false,
            elapsed_ms: started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
        },
        capabilities: None,
    }
}

fn check_platform() -> Result<String, String> {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let supported = matches!(
        (os, arch),
        ("windows", "x86_64") | ("macos", "x86_64") | ("macos", "aarch64")
    );
    if supported {
        config::working_directory_is_normalized()?;
        Ok(format!(
            "{os} / {arch} 受支持；启动目录已自愈；无需 Node、Python 或其他 CLI"
        ))
    } else {
        Err(format!(
            "当前平台 {os} / {arch} 不在 {APP_VERSION} 支持范围"
        ))
    }
}

fn check_storage() -> Result<String, String> {
    let data = config::data_dir();
    let sites = config::sites_dir();
    std::fs::create_dir_all(&data).map_err(|e| format!("应用数据目录不可创建：{e}"))?;
    std::fs::create_dir_all(&sites).map_err(|e| format!("作品目录不可创建：{e}"))?;
    let probe = data.join(format!(".doctor-write-{}", uuid::Uuid::new_v4()));
    std::fs::write(&probe, b"yiju-doctor").map_err(|e| format!("应用数据目录不可写：{e}"))?;
    let read = std::fs::read(&probe).map_err(|e| format!("应用数据目录不可读：{e}"));
    let _ = std::fs::remove_file(&probe);
    if read? != b"yiju-doctor" {
        return Err("应用数据目录读写结果不一致".into());
    }
    Ok("应用数据与作品目录可创建、读取和写入".into())
}

fn check_config(cfg: &Config) -> Result<String, String> {
    if !cfg.configured() {
        return Err("安装包未装入模型密钥，请打开设置补充".into());
    }
    if cfg.effective_tts_key().is_empty() {
        return Err("安装包未装入 MiniMax 语音密钥".into());
    }
    if cfg.model.trim().is_empty() {
        return Err("模型名为空".into());
    }
    validate_https_endpoint(&cfg.api_url, "模型")?;
    validate_https_endpoint(&cfg.tts_url, "语音")?;
    Ok(format!("{} 与 MiniMax T2A 配置完整", cfg.model.trim()))
}

fn validate_https_endpoint(raw: &str, label: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(raw).map_err(|_| format!("{label}端点不是合法 URL"))?;
    let local = matches!(url.host_str(), Some("127.0.0.1" | "localhost"));
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || (url.scheme() != "https" && !(local && url.scheme() == "http"))
    {
        return Err(format!("{label}端点必须是 HTTPS（本机调试可用 localhost）"));
    }
    Ok(())
}

fn check_webview_security() -> Result<String, String> {
    #[cfg(windows)]
    {
        if config::data_dir()
            .join("webview-security-error.txt")
            .exists()
        {
            return Err("WebView2 自动填充安全设置未成功应用，请重启或修复 WebView2".into());
        }
        Ok("WebView2 可用，密码保存与通用自动填充已禁用".into())
    }
    #[cfg(target_os = "macos")]
    {
        Ok("系统 WKWebView 可用，应用不依赖外部浏览器运行时".into())
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        Err("当前系统 WebView 不在发布支持范围".into())
    }
}

async fn check_preview(preview_url: Option<&str>) -> Result<String, String> {
    let url = preview_url.ok_or("本地预览服务没有启动")?;
    if !url.starts_with("http://127.0.0.1:") {
        return Err("本地预览服务没有绑定到安全的回环地址".into());
    }
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(4))
        .build()
        .map_err(|e| format!("预览检查客户端启动失败：{e}"))?
        .get(url)
        .send()
        .await
        .map_err(|e| format!("本地预览服务不可访问：{e}"))?;
    if response.status().is_server_error() {
        return Err(format!("本地预览服务返回 {}", response.status()));
    }
    Ok("127.0.0.1 预览服务已响应".into())
}

async fn probe_model(cfg: &Config) -> Result<String, String> {
    if let Err(error) = check_config(cfg) {
        return Err(error);
    }
    let llm = Llm::new(&cfg.api_url, &cfg.api_key, &cfg.model);
    let messages = [Msg::user("请回复：正常")];
    let mut last_error = String::new();

    for attempt in 1..=REMOTE_PROBE_ATTEMPTS {
        let request = llm.complete(
            "这是启动环境检查。不要解释，只回复两个汉字：正常。",
            &messages,
            128,
        );
        match tokio::time::timeout(REMOTE_PROBE_TIMEOUT, request).await {
            Ok(Ok(completion)) => {
                if completion.text.trim().is_empty() {
                    return Err("模型请求成功但没有返回正文".into());
                }
                return Ok(format!("{} 已返回有效文本", cfg.model.trim()));
            }
            Ok(Err(error)) => {
                last_error = redact(&error, &[&cfg.api_key, cfg.effective_tts_key()]);
                if !retryable_model_probe_error(&error) {
                    return Err(last_error);
                }
            }
            Err(_) => {
                last_error = format!("模型单次真实请求超过 {} 秒", REMOTE_PROBE_TIMEOUT.as_secs());
            }
        }
        if attempt < REMOTE_PROBE_ATTEMPTS {
            wait_before_probe_retry(attempt).await;
        }
    }

    Err(format!(
        "{last_error}（已自动尝试 {REMOTE_PROBE_ATTEMPTS} 次）"
    ))
}

async fn probe_tts(cfg: &Config) -> Result<String, String> {
    if cfg.effective_tts_key().is_empty() {
        return Err("安装包未装入 MiniMax 语音密钥".into());
    }
    let mut last_error = String::new();

    for attempt in 1..=REMOTE_PROBE_ATTEMPTS {
        let request = tts::synthesize(cfg, "环境检查", &cfg.voice_id, "neutral", tts::MODELS[0]);
        match tokio::time::timeout(REMOTE_PROBE_TIMEOUT, request).await {
            Ok(Ok(bytes)) => {
                tts::validate_mp3(&bytes)?;
                return Ok(format!("MiniMax 已返回有效 MP3（{} 字节）", bytes.len()));
            }
            Ok(Err(error)) => {
                last_error = redact(&error, &[&cfg.api_key, cfg.effective_tts_key()]);
                if !retryable_tts_probe_error(&error) {
                    return Err(last_error);
                }
            }
            Err(_) => {
                last_error = format!(
                    "MiniMax 语音单次真实请求超过 {} 秒",
                    REMOTE_PROBE_TIMEOUT.as_secs()
                );
            }
        }
        if attempt < REMOTE_PROBE_ATTEMPTS {
            wait_before_probe_retry(attempt).await;
        }
    }

    Err(format!(
        "{last_error}（已自动尝试 {REMOTE_PROBE_ATTEMPTS} 次）"
    ))
}

fn retryable_model_probe_error(error: &str) -> bool {
    error.starts_with("模型请求失败：")
        || error.starts_with("读取模型响应失败：")
        || retryable_http_error(error, "模型返回 ")
}

fn retryable_tts_probe_error(error: &str) -> bool {
    error.starts_with("T2A 请求失败：")
        || error.starts_with("读取 T2A 响应失败：")
        || error.starts_with("T2A 1002 ")
        || retryable_http_error(error, "T2A HTTP ")
}

fn retryable_http_error(error: &str, prefix: &str) -> bool {
    let Some(code) = error
        .strip_prefix(prefix)
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|code| code.parse::<u16>().ok())
    else {
        return false;
    };
    code == 408 || code == 429 || (500..=599).contains(&code)
}

async fn wait_before_probe_retry(attempt: u32) {
    tokio::time::sleep(Duration::from_secs(u64::from(attempt))).await;
}

async fn probe_image(cloud: Result<CloudConfig, String>) -> Result<String, String> {
    let cloud = cloud.map_err(|error| format!("Workers AI 不可检查：{error}"))?;
    let prompt = "A single small cyan paper lantern glowing on a dark navy table, clean editorial photograph, no text, no logo";
    let bytes = tokio::time::timeout(Duration::from_secs(160), cloud.generate_image(prompt))
        .await
        .map_err(|_| "Workers AI 真实生图超过 160 秒".to_string())?
        .map_err(|error| redact(&error, &[cloud.exact_secret()]))?;
    crate::generate::validate_generated_jpeg(&bytes)
        .map_err(|error| format!("Workers AI 图片完整解码失败：{error}"))?;
    Ok(format!(
        "Workers AI 已返回并完整解码 JPEG（{} 字节）",
        bytes.len()
    ))
}

fn redact(value: &str, secrets: &[&str]) -> String {
    let mut safe = value.chars().take(240).collect::<String>();
    for secret in secrets {
        if secret.len() >= 8 {
            safe = safe.replace(secret, "[凭据已隐藏]");
        }
    }
    safe
}

fn config_fingerprint(cfg: &Config, cloud: Option<&CloudConfig>) -> String {
    let mut digest = Sha256::new();
    for part in [
        cfg.api_url.as_str(),
        cfg.api_key.as_str(),
        cfg.model.as_str(),
        cfg.tts_url.as_str(),
        cfg.effective_tts_key(),
        cfg.voice_id.as_str(),
        cloud
            .map(CloudConfig::exact_secret)
            .unwrap_or("cloud-missing"),
    ] {
        digest.update(part.len().to_le_bytes());
        digest.update(part.as_bytes());
    }
    format!("{:x}", digest.finalize())
}

fn cache_path() -> std::path::PathBuf {
    config::data_dir().join("doctor.json")
}

fn read_cache() -> Option<DoctorCache> {
    let bytes = std::fs::read(cache_path()).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_cache(cache: &DoctorCache) -> Result<(), String> {
    let path = cache_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建环境医生目录失败：{e}"))?;
    }
    let bytes = serde_json::to_vec(cache).map_err(|e| format!("序列化环境医生缓存失败：{e}"))?;
    std::fs::write(path, bytes).map_err(|e| format!("写环境医生缓存失败：{e}"))
}

fn cache_is_valid(cache: &DoctorCache, fingerprint: &str, now: u64) -> bool {
    cache.schema == CACHE_SCHEMA
        && cache.app_version == APP_VERSION
        && cache.fingerprint == fingerprint
        && now >= cache.verified_at
        && now - cache.verified_at <= CACHE_MAX_AGE_SECS
}

fn now_epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn check_order(id: &str) -> usize {
    [
        "platform", "storage", "config", "webview", "preview", "cloud", "model", "tts", "image",
        "runtime",
    ]
    .iter()
    .position(|candidate| *candidate == id)
    .unwrap_or(usize::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config_with_secrets() -> Config {
        Config {
            api_url: "https://model.example/messages".into(),
            api_key: "sk-model-super-secret".into(),
            model: "test-model".into(),
            tts_url: "https://tts.example/v1".into(),
            tts_key: "tts-super-secret".into(),
            ..Config::default()
        }
    }

    #[test]
    fn fingerprint_and_cache_never_store_plaintext_credentials() {
        let cfg = config_with_secrets();
        let fingerprint = config_fingerprint(&cfg, None);
        let cache = DoctorCache {
            schema: CACHE_SCHEMA,
            app_version: APP_VERSION.into(),
            fingerprint,
            verified_at: 123,
        };
        let json = serde_json::to_string(&cache).unwrap();
        assert!(!json.contains(&cfg.api_key));
        assert!(!json.contains(&cfg.tts_key));
    }

    #[test]
    fn cache_binds_version_fingerprint_and_ttl() {
        let cfg = config_with_secrets();
        let fingerprint = config_fingerprint(&cfg, None);
        let cache = DoctorCache {
            schema: CACHE_SCHEMA,
            app_version: APP_VERSION.into(),
            fingerprint: fingerprint.clone(),
            verified_at: 10_000,
        };
        assert!(cache_is_valid(&cache, &fingerprint, 10_001));
        assert!(!cache_is_valid(&cache, "different", 10_001));
        assert!(!cache_is_valid(
            &cache,
            &fingerprint,
            10_000 + CACHE_MAX_AGE_SECS + 1
        ));
        assert!(!cache_is_valid(&cache, &fingerprint, 9_999));
    }

    #[test]
    fn only_https_or_loopback_endpoints_pass() {
        assert!(validate_https_endpoint("https://api.example/v1", "模型").is_ok());
        assert!(validate_https_endpoint("http://127.0.0.1:8080/v1", "模型").is_ok());
        assert!(validate_https_endpoint("http://localhost:8080/v1", "模型").is_ok());
        assert!(validate_https_endpoint("http://evil.example/v1", "模型").is_err());
        assert!(validate_https_endpoint("https://user:pass@example.com/v1", "模型").is_err());
    }

    #[test]
    fn probe_retry_rules_only_accept_transient_failures() {
        assert!(retryable_model_probe_error(
            "模型请求失败：connection reset"
        ));
        assert!(retryable_model_probe_error(
            "模型返回 503 Service Unavailable：busy"
        ));
        assert!(!retryable_model_probe_error(
            "模型返回 401 Unauthorized：bad key"
        ));
        assert!(!retryable_model_probe_error("模型响应不是预期 JSON"));

        assert!(retryable_tts_probe_error("T2A 请求失败：timeout"));
        assert!(retryable_tts_probe_error(
            "T2A HTTP 429 Too Many Requests：busy"
        ));
        assert!(!retryable_tts_probe_error(
            "T2A HTTP 401 Unauthorized：bad key"
        ));
        assert!(!retryable_tts_probe_error("T2A 响应不是 JSON"));
    }

    #[test]
    fn cached_transient_cloud_failure_does_not_block_startup() {
        let outcome = cached_cloud_fallback(
            std::time::Instant::now(),
            "temporary connect failure".into(),
        );
        assert_eq!(outcome.check.status, DoctorStatus::Skipped);
        assert!(!outcome.check.required);
        assert!(outcome.capabilities.is_none());
        assert!(outcome.check.detail.contains("进入后可重试"));
    }

    #[test]
    fn report_serialization_is_secret_free() {
        let report = DoctorReport {
            ready: false,
            deep: true,
            cached: false,
            summary: "检查失败".into(),
            checks: vec![DoctorCheck {
                id: "model".into(),
                label: "模型".into(),
                status: DoctorStatus::Fail,
                detail: redact(
                    "provider echoed sk-model-super-secret",
                    &["sk-model-super-secret"],
                ),
                required: true,
                elapsed_ms: 1,
            }],
            capabilities: None,
            checked_at: 0,
        };
        let json = serde_json::to_string(&report).unwrap();
        assert!(!json.contains("sk-model-super-secret"));
    }
}
