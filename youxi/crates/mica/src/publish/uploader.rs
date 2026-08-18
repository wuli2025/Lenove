//! 产物上传：把本地生成好的站点目录推到 R2。
//!
//! 两条通道，键位完全一致，只是「怎么发出去」不同：
//!
//! * [`UploadTarget::Worker`]（**默认**）走 Worker 代理端点 `PUT /api/upload/...`，
//!   只带 `x-publish-token`。现场笔记本不必配 R2 密钥——少一份要管的凭据，
//!   泄了也只是「往约定前缀写」这一件事，不是整桶读写权限。
//! * [`UploadTarget::S3`] 直连 R2 的 S3 兼容接口 + 手写 SigV4。留着给批量迁移、
//!   或者 Worker 挂了要绕过去的场景；用 `MICA_UPLOAD_MODE=s3` 切过去。
//!
//! SigV4 那半刻意不引 aws-sdk 全家桶——那一套会给这个 crate 拖进几十个传递依赖。
//! 工程里已有 reqwest（rustls），签名用 hmac + sha2 手写，两个纯算法小 crate 而已。
//!
//! 桶里的键位约定（与 Worker 端 `src/index.js` 的路由一一对应）：
//! * `sites/<slug>/...`      → `/u/<slug>/...` 静态分发
//! * `covers/<id>.<ext>`     → `/r2/covers/...` 封面
//! * `posters/<id>.png`      → 海报

use crate::core::{MicaError, Result};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Semaphore;

type HmacSha256 = Hmac<Sha256>;

/// 并发上传上限。现场多半是家用带宽，开太大只会互相抢，6 路是实测甜点。
pub const MAX_CONCURRENCY: usize = 6;
/// 单文件重试次数（首次 + 2 次重试 = 最多 3 发）
pub const MAX_RETRIES: usize = 2;
/// R2 的 S3 兼容层要求 region 固定签成 auto
const REGION: &str = "auto";
const SERVICE: &str = "s3";
/// 默认桶名，与 r2-sites/wrangler.toml 的 `bucket_name` 一致
pub const DEFAULT_BUCKET: &str = "user-sites";
/// 单文件上限，与 Worker 端 `handleUpload` 的 25MB 闸一致。
/// 本地先拦一道，省得把几十兆推上去换个 413 回来。
pub const MAX_FILE_BYTES: usize = 25 * 1024 * 1024;

/// R2 凭据。一律从环境变量读，代码里不留任何令牌。
#[derive(Debug, Clone)]
pub struct R2Config {
    pub account_id: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub bucket: String,
}

fn require_env(key: &str) -> Result<String> {
    match std::env::var(key) {
        Ok(v) if !v.trim().is_empty() => Ok(v.trim().to_string()),
        _ => Err(MicaError::Other(format!(
            "缺少环境变量 {key}，无法上传站点产物到 R2"
        ))),
    }
}

impl R2Config {
    pub fn from_env() -> Result<Self> {
        Ok(Self {
            account_id: require_env("R2_ACCOUNT_ID")?,
            access_key_id: require_env("R2_ACCESS_KEY_ID")?,
            secret_access_key: require_env("R2_SECRET_ACCESS_KEY")?,
            bucket: std::env::var("R2_BUCKET")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| DEFAULT_BUCKET.to_string()),
        })
    }

    pub fn host(&self) -> String {
        format!("{}.r2.cloudflarestorage.com", self.account_id)
    }

    pub fn endpoint(&self) -> String {
        format!("https://{}", self.host())
    }
}

// ───────────────────────── 上传通道 ─────────────────────────

/// Worker 代理通道的配置：一个地址 + 一个发布令牌，没了。
#[derive(Debug, Clone)]
pub struct WorkerConfig {
    pub base_url: String,
    pub token: String,
}

impl WorkerConfig {
    /// 复用大厅那套 base_url / token 解析（环境变量 → publish.json → 默认地址）
    pub fn from_env() -> Result<Self> {
        let (base_url, token) = super::client::resolve_endpoint()?;
        Ok(Self { base_url, token })
    }
}

/// 上传通道。两条路的对外行为完全一样，调用方不用关心走的是哪条。
#[derive(Debug, Clone)]
pub enum UploadTarget {
    /// 走 Worker 代理端点，只要发布令牌（默认）
    Worker(WorkerConfig),
    /// 直连 R2 S3 兼容接口 + SigV4，要 R2 access key
    S3(R2Config),
}

impl UploadTarget {
    /// 按 `MICA_UPLOAD_MODE` 分流，默认 worker。
    /// 值写错不静默回落——回落到默认反而会让人对着「密钥明明配了却没用上」发懵。
    pub fn from_env() -> Result<Self> {
        match parse_mode(std::env::var("MICA_UPLOAD_MODE").unwrap_or_default().trim())? {
            UploadMode::Worker => Ok(UploadTarget::Worker(WorkerConfig::from_env()?)),
            UploadMode::S3 => Ok(UploadTarget::S3(R2Config::from_env()?)),
        }
    }

    /// 给日志/错误提示用的通道名
    pub fn mode_name(&self) -> &'static str {
        match self {
            UploadTarget::Worker(_) => "worker",
            UploadTarget::S3(_) => "s3",
        }
    }
}

/// `MICA_UPLOAD_MODE` 的取值
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UploadMode {
    Worker,
    S3,
}

fn parse_mode(raw: &str) -> Result<UploadMode> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "" | "worker" | "proxy" => Ok(UploadMode::Worker),
        "s3" | "r2" | "sigv4" => Ok(UploadMode::S3),
        other => Err(MicaError::Other(format!(
            "MICA_UPLOAD_MODE 取值非法：{other}（只支持 worker 或 s3）"
        ))),
    }
}

/// R2 对象键 → Worker 代理端点路径。
/// 只放行三个约定前缀，别的键一律拒——代理端点不是通用写桶口子。
fn worker_upload_path(key: &str) -> Result<String> {
    let (kind, rest) = match key.split_once('/') {
        Some(("sites", rest)) => ("site", rest),
        Some(("covers", rest)) => ("cover", rest),
        Some(("posters", rest)) => ("poster", rest),
        _ => {
            return Err(MicaError::Other(format!(
                "键 {key} 不在 sites/ covers/ posters/ 三个可代理前缀内"
            )))
        }
    };
    if rest.is_empty() || rest.contains("..") || rest.contains("//") || rest.starts_with('/') {
        return Err(MicaError::Other(format!(
            "键 {key} 路径不合法（含 .. 或 // 或空段）"
        )));
    }
    // Worker 侧会 decodeURIComponent，这里必须先转义，否则带空格/中文的文件名会挂
    Ok(format!("/api/upload/{kind}/{}", uri_encode(rest, true)))
}

// ───────────────────────── Content-Type ─────────────────────────

/// 扩展名 → Content-Type。Worker 端优先取 R2 对象上的 httpMetadata.contentType，
/// 这里签错了浏览器就会把 css 当纯文本渲染，所以映射必须准。
pub fn content_type_for(path: &str) -> &'static str {
    let ext = path
        .rsplit('/')
        .next()
        .unwrap_or(path)
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "map" => "application/json; charset=utf-8",
        "txt" => "text/plain; charset=utf-8",
        "md" => "text/markdown; charset=utf-8",
        "xml" => "application/xml; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "svg" => "image/svg+xml; charset=utf-8",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        // 认不出来就交给浏览器按 nosniff 处理，绝不瞎猜成 text/html
        _ => "application/octet-stream",
    }
}

// ───────────────────────── SigV4 ─────────────────────────

fn hex_sha256(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    hex::encode(h.finalize())
}

fn hmac(key: &[u8], msg: &[u8]) -> Vec<u8> {
    // new_from_slice 只有 key 长度非法才会失败，HMAC 接受任意长度，这里不可能 panic
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key).expect("hmac 接受任意长度密钥");
    mac.update(msg);
    mac.finalize().into_bytes().to_vec()
}

/// SigV4 四段派生签名密钥：kDate → kRegion → kService → kSigning
fn signing_key(secret: &str, date_stamp: &str, region: &str, service: &str) -> Vec<u8> {
    let k_date = hmac(format!("AWS4{secret}").as_bytes(), date_stamp.as_bytes());
    let k_region = hmac(&k_date, region.as_bytes());
    let k_service = hmac(&k_region, service.as_bytes());
    hmac(&k_service, b"aws4_request")
}

/// SigV4 的 URI 转义：只有 `A-Za-z0-9-_.~` 免转义，其余一律 %XX 大写。
/// `keep_slash` 为真时保留路径分隔符（用于 canonical URI）。
fn uri_encode(s: &str, keep_slash: bool) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            b'/' if keep_slash => out.push('/'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Howard Hinnant 的 civil_from_days：天数（自 1970-01-01）→ 年月日。
/// 只为拼 x-amz-date 就拉 chrono 不划算，二十行搞定。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 返回 (x-amz-date, datestamp)，例如 ("20260812T031415Z", "20260812")
fn amz_now() -> (String, String) {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, mo, d) = civil_from_days(days);
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    (
        format!("{y:04}{mo:02}{d:02}T{h:02}{mi:02}{s:02}Z"),
        format!("{y:04}{mo:02}{d:02}"),
    )
}

/// 为一次 PUT 生成签名头，返回 (x-amz-date, payload sha256, Authorization)。
/// 签名头集合固定为 content-type;host;x-amz-content-sha256;x-amz-date（已按字典序）。
fn sign_put(
    cfg: &R2Config,
    key: &str,
    content_type: &str,
    payload: &[u8],
) -> (String, String, String) {
    let (amz_date, date_stamp) = amz_now();
    let payload_hash = hex_sha256(payload);
    let host = cfg.host();

    let canonical_uri = format!(
        "/{}/{}",
        uri_encode(&cfg.bucket, false),
        uri_encode(key, true)
    );
    let canonical_headers = format!(
        "content-type:{content_type}\nhost:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n"
    );
    let signed_headers = "content-type;host;x-amz-content-sha256;x-amz-date";
    let canonical_request =
        format!("PUT\n{canonical_uri}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}");

    let scope = format!("{date_stamp}/{REGION}/{SERVICE}/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        hex_sha256(canonical_request.as_bytes())
    );
    let signature = hex::encode(hmac(
        &signing_key(&cfg.secret_access_key, &date_stamp, REGION, SERVICE),
        string_to_sign.as_bytes(),
    ));

    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
        cfg.access_key_id
    );
    (amz_date, payload_hash, authorization)
}

// ───────────────────────── 单对象 PUT ─────────────────────────

fn http_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent("MicaBase-Publisher")
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| MicaError::Other(format!("创建 HTTP 客户端失败：{e}")))
}

/// 把非 2xx 响应翻成带排查提示的中文错误。
async fn explain_failure(mode: &str, key: &str, resp: reqwest::Response) -> MicaError {
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    let hint = match (mode, status.as_u16()) {
        ("worker", 401) => {
            "（发布令牌无效，检查 MICA_PUBLISH_TOKEN 与服务端 PUBLISH_TOKEN 是否一致）"
        }
        ("worker", 413) => "（单文件超过 25MB，Worker 代理拒收）",
        ("worker", 404) => "（代理端点不存在，服务端可能还没部署 /api/upload/*）",
        ("s3", 401) | ("s3", 403) => {
            "（R2 凭据无效或没有该桶的写权限，检查 R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY）"
        }
        ("s3", 404) => "（桶不存在，检查 R2_BUCKET 与 R2_ACCOUNT_ID）",
        _ => "",
    };
    MicaError::Other(format!(
        "上传 {key} 失败（{mode} 通道）：HTTP {status}{hint} {}",
        text.chars().take(300).collect::<String>()
    ))
}

/// 上传单个对象（不含重试）。两条通道在这里分叉，往上都是同一套逻辑。
async fn put_once(
    client: &reqwest::Client,
    target: &UploadTarget,
    key: &str,
    body: &[u8],
    content_type: &str,
) -> Result<()> {
    let req = match target {
        // 代理通道：一个令牌头就够，不签名
        UploadTarget::Worker(cfg) => {
            let url = format!("{}{}", cfg.base_url, worker_upload_path(key)?);
            client
                .put(&url)
                .header("x-publish-token", &cfg.token)
                .header("content-type", content_type)
        }
        // 直连通道：SigV4
        UploadTarget::S3(cfg) => {
            let (amz_date, payload_hash, authorization) = sign_put(cfg, key, content_type, body);
            let url = format!(
                "{}/{}/{}",
                cfg.endpoint(),
                uri_encode(&cfg.bucket, false),
                uri_encode(key, true)
            );
            client
                .put(&url)
                .header("host", cfg.host())
                .header("content-type", content_type)
                .header("x-amz-content-sha256", payload_hash)
                .header("x-amz-date", amz_date)
                .header("authorization", authorization)
        }
    };

    let resp = req
        .body(body.to_vec())
        .send()
        .await
        .map_err(|e| MicaError::Other(format!("上传 {key} 网络失败：{e}")))?;

    if resp.status().is_success() {
        return Ok(());
    }
    Err(explain_failure(target.mode_name(), key, resp).await)
}

/// 上传单个对象，失败重试 MAX_RETRIES 次（指数退避 300ms / 900ms）。
pub async fn put_object(
    client: &reqwest::Client,
    target: &UploadTarget,
    key: &str,
    body: &[u8],
    content_type: &str,
) -> Result<()> {
    if body.is_empty() {
        return Err(MicaError::Other(format!("{key} 是空文件，服务端会拒收")));
    }
    if body.len() > MAX_FILE_BYTES {
        return Err(MicaError::Other(format!(
            "{key} 体积 {} 字节，超过单文件上限 {MAX_FILE_BYTES} 字节（25MB）",
            body.len()
        )));
    }
    let mut last = None;
    for attempt in 0..=MAX_RETRIES {
        match put_once(client, target, key, body, content_type).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = Some(e);
                if attempt < MAX_RETRIES {
                    tokio::time::sleep(Duration::from_millis(300 * 3u64.pow(attempt as u32))).await;
                }
            }
        }
    }
    Err(MicaError::Other(format!(
        "上传 {key} 连续失败 {} 次：{}",
        MAX_RETRIES + 1,
        last.map(|e| e.to_string()).unwrap_or_default()
    )))
}

// ───────────────────────── 目录递归 ─────────────────────────

/// 递归收集目录下所有普通文件，返回（相对路径 key，绝对路径）。
/// 用 `file_type()` 判类型而不是 `is_dir()`——前者不跟随符号链接，防目录环把上传卡死。
fn collect_files(root: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) -> Result<()> {
    let entries = std::fs::read_dir(dir)
        .map_err(|e| MicaError::Other(format!("读取目录 {} 失败：{e}", dir.display())))?;
    for entry in entries {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let path = entry.path();
        if file_type.is_dir() {
            collect_files(root, &path, out)?;
        } else if file_type.is_file() {
            let rel = path
                .strip_prefix(root)
                .map_err(|_| MicaError::Other(format!("路径越出站点目录：{}", path.display())))?;
            let key = rel
                .components()
                .filter_map(|c| c.as_os_str().to_str())
                .collect::<Vec<_>>()
                .join("/");
            if key.is_empty() {
                continue;
            }
            out.push((key, path));
        }
    }
    Ok(())
}

/// 把 `dir` 递归上传到 `sites/<slug>/`，返回成功上传的文件数。
///
/// 并发上限 MAX_CONCURRENCY，任一文件三发不中就整体失败——
/// 宁可让上层把作品记录藏起来，也不能留一个点开半截的站点。
pub async fn upload_site(target: &UploadTarget, slug: &str, dir: &Path) -> Result<usize> {
    if !dir.is_dir() {
        return Err(MicaError::Other(format!(
            "站点目录不存在或不是目录：{}",
            dir.display()
        )));
    }
    let mut files = Vec::new();
    collect_files(dir, dir, &mut files)?;
    if files.is_empty() {
        return Err(MicaError::Other(format!(
            "站点目录为空，没有可发布的产物：{}",
            dir.display()
        )));
    }
    // 排序只为让日志和失败复现顺序稳定
    files.sort();

    let client = Arc::new(http_client()?);
    let target = Arc::new(target.clone());
    let sem = Arc::new(Semaphore::new(MAX_CONCURRENCY));
    let prefix = format!("sites/{slug}");

    let mut tasks = tokio::task::JoinSet::new();
    for (rel, path) in files {
        let (client, target, sem) = (client.clone(), target.clone(), sem.clone());
        let key = format!("{prefix}/{rel}");
        tasks.spawn(async move {
            // permit 拿不到只可能是信号量被关闭，这里没人关它
            let _permit = sem
                .acquire_owned()
                .await
                .map_err(|e| MicaError::Other(e.to_string()))?;
            let body = tokio::fs::read(&path)
                .await
                .map_err(|e| MicaError::Other(format!("读取 {} 失败：{e}", path.display())))?;
            let ct = content_type_for(&key);
            put_object(&client, &target, &key, &body, ct).await
        });
    }

    let mut uploaded = 0usize;
    let mut first_err: Option<MicaError> = None;
    while let Some(joined) = tasks.join_next().await {
        match joined {
            Ok(Ok(())) => uploaded += 1,
            Ok(Err(e)) => {
                if first_err.is_none() {
                    first_err = Some(e);
                }
            }
            Err(e) => {
                if first_err.is_none() {
                    first_err = Some(MicaError::Other(format!("上传任务异常退出：{e}")));
                }
            }
        }
    }
    match first_err {
        Some(e) => Err(e),
        None => Ok(uploaded),
    }
}

/// 按魔数认图片类型，返回 (扩展名, Content-Type)。
/// 认字节比认调用方给的字段名准——Worker 端最终读的就是对象上的 httpMetadata.contentType。
fn sniff_image(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(("png", "image/png"))
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some(("jpg", "image/jpeg"))
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some(("webp", "image/webp"))
    } else {
        None
    }
}

fn png_ends_at_iend(bytes: &[u8]) -> bool {
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return false;
    }
    let mut pos = 8usize;
    while pos.checked_add(12).is_some_and(|end| end <= bytes.len()) {
        let length = u32::from_be_bytes(bytes[pos..pos + 4].try_into().unwrap()) as usize;
        let Some(end) = pos.checked_add(12).and_then(|n| n.checked_add(length)) else {
            return false;
        };
        if end > bytes.len() {
            return false;
        }
        if bytes.get(pos + 4..pos + 8) == Some(b"IEND") {
            return length == 0 && end == bytes.len();
        }
        pos = end;
    }
    false
}

/// 完整解码位图并要求容器正好结束，避免三字节 JPEG 或伪造 IHDR 被公开上传。
pub(crate) fn validate_raster_image(
    bytes: &[u8],
) -> Result<(&'static str, &'static str, u32, u32)> {
    if bytes.is_empty() || bytes.len() > 20 * 1024 * 1024 {
        return Err(MicaError::Other("图片为空或超过 20MB".into()));
    }
    let (ext, mime) =
        sniff_image(bytes).ok_or_else(|| MicaError::Other("图片不是 PNG/JPEG/WebP 位图".into()))?;

    let format = match ext {
        "png" if png_ends_at_iend(bytes) => image::ImageFormat::Png,
        "jpg" if bytes.ends_with(b"\xff\xd9") => image::ImageFormat::Jpeg,
        "webp" if bytes.len() >= 12 => {
            let declared = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
            if declared.checked_add(8) != Some(bytes.len()) {
                return Err(MicaError::Other("WebP 容器长度不完整".into()));
            }
            image::ImageFormat::WebP
        }
        _ => return Err(MicaError::Other("图片容器已截断或尾部含多余数据".into())),
    };

    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader
        .decode()
        .map_err(|_| MicaError::Other("图片像素数据损坏或尺寸异常".into()))?;
    let (width, height) = (decoded.width(), decoded.height());
    if width == 0 || height == 0 {
        return Err(MicaError::Other("图片像素尺寸为空".into()));
    }
    Ok((ext, mime, width, height))
}

/// 上传封面到 `covers/<id>.<ext>`，返回该 R2 key（供 PATCH 回填）。
/// 后缀取自真实字节：代理端点只放行 png/jpg/jpeg/webp，这三种都在里面。
pub async fn upload_cover(target: &UploadTarget, id: &str, bytes: &[u8]) -> Result<String> {
    let (ext, content_type, _, _) = validate_raster_image(bytes)
        .map_err(|_| MicaError::Other("封面不是有效的 PNG/JPEG/WebP 位图".into()))?;
    let key = format!("covers/{id}.{ext}");
    let client = http_client()?;
    put_object(&client, target, &key, bytes, content_type).await?;
    Ok(key)
}

/// 上传 1080×1440 PNG 分享海报，返回 R2 key（供 PATCH 回填）。
pub async fn upload_poster(target: &UploadTarget, id: &str, bytes: &[u8]) -> Result<String> {
    let (ext, _, width, height) = validate_raster_image(bytes)
        .map_err(|_| MicaError::Other("分享海报不是有效 PNG".into()))?;
    if ext != "png" {
        return Err(MicaError::Other("分享海报必须是 PNG".into()));
    }
    if (width, height) != (1080, 1440) {
        return Err(MicaError::Other(format!(
            "分享海报尺寸必须是 1080×1440，实际为 {width}×{height}"
        )));
    }
    if bytes.len() > 20 * 1024 * 1024 {
        return Err(MicaError::Other("分享海报超过 20MB".into()));
    }
    let key = format!("posters/{id}.png");
    let client = http_client()?;
    put_object(&client, target, &key, bytes, "image/png").await?;
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_type_mapping() {
        assert_eq!(
            content_type_for("sites/a/index.html"),
            "text/html; charset=utf-8"
        );
        assert_eq!(
            content_type_for("a/b/style.CSS"),
            "text/css; charset=utf-8",
            "扩展名大小写不敏感"
        );
        assert_eq!(content_type_for("app.js"), "text/javascript; charset=utf-8");
        assert_eq!(
            content_type_for("app.mjs"),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(
            content_type_for("data.json"),
            "application/json; charset=utf-8"
        );
        assert_eq!(content_type_for("logo.svg"), "image/svg+xml; charset=utf-8");
        assert_eq!(content_type_for("shot.PNG"), "image/png");
        assert_eq!(content_type_for("cover.jpeg"), "image/jpeg");
        assert_eq!(content_type_for("f.woff2"), "font/woff2");
        assert_eq!(content_type_for("m.wasm"), "application/wasm");
        // 无扩展名 / 未知扩展名 → 兜底，绝不猜成 text/html
        assert_eq!(content_type_for("LICENSE"), "application/octet-stream");
        assert_eq!(content_type_for("weird.qqq"), "application/octet-stream");
        // 目录里有点、文件名没点，不能被上级目录的后缀骗到
        assert_eq!(content_type_for("v1.2/README"), "application/octet-stream");
    }

    #[test]
    fn uri_encode_rules() {
        assert_eq!(uri_encode("a/b c.html", true), "a/b%20c.html");
        assert_eq!(uri_encode("a/b", false), "a%2Fb");
        assert_eq!(uri_encode("-_.~", true), "-_.~");
        assert_eq!(uri_encode("中", true), "%E4%B8%AD");
    }

    #[test]
    fn sigv4_signing_key_matches_aws_vector() {
        // AWS 官方文档给的派生密钥测试向量，能对上就说明 HMAC 链没写错
        let key = signing_key(
            "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
            "20120215",
            "us-east-1",
            "iam",
        );
        assert_eq!(
            hex::encode(key),
            "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d"
        );
    }

    #[test]
    fn amz_date_format_is_sane() {
        let (amz, stamp) = amz_now();
        assert_eq!(
            amz.len(),
            16,
            "x-amz-date 必须是 20060102T150405Z 形式：{amz}"
        );
        assert!(amz.ends_with('Z') && amz.as_bytes()[8] == b'T');
        assert_eq!(stamp.len(), 8);
        assert_eq!(
            &amz[..8],
            stamp,
            "两个时间戳必须同日，否则签名 scope 对不上"
        );
        // 1970-01-01 与 2026-08-12 的换算校验
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_677), (2026, 8, 12));
    }

    #[test]
    fn sign_put_produces_wellformed_authorization() {
        let cfg = R2Config {
            account_id: "acct".into(),
            access_key_id: "AKID".into(),
            secret_access_key: "SECRET".into(),
            bucket: "user-sites".into(),
        };
        let (amz_date, hash, auth) = sign_put(&cfg, "sites/a-b/index.html", "text/html", b"hi");
        assert_eq!(hash, hex_sha256(b"hi"));
        assert!(auth.starts_with("AWS4-HMAC-SHA256 Credential=AKID/"));
        assert!(auth.contains(&format!("/{REGION}/{SERVICE}/aws4_request")));
        assert!(auth.contains("SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date"));
        assert!(
            auth.contains(&amz_date[..8]),
            "scope 日期须与 x-amz-date 同日"
        );
    }

    #[test]
    fn upload_mode_parsing() {
        // 缺省与别名都归 worker（默认通道）
        assert_eq!(parse_mode("").unwrap(), UploadMode::Worker);
        assert_eq!(parse_mode("worker").unwrap(), UploadMode::Worker);
        assert_eq!(parse_mode(" WORKER ").unwrap(), UploadMode::Worker);
        assert_eq!(parse_mode("proxy").unwrap(), UploadMode::Worker);
        // SigV4 直连通道保留可用
        assert_eq!(parse_mode("s3").unwrap(), UploadMode::S3);
        assert_eq!(parse_mode("R2").unwrap(), UploadMode::S3);
        assert_eq!(parse_mode("sigv4").unwrap(), UploadMode::S3);
        // 写错不静默回落，否则「密钥配了却没用上」很难查
        assert!(parse_mode("worke").is_err());
        assert!(parse_mode("aws").is_err());
    }

    #[test]
    fn worker_upload_path_mapping() {
        assert_eq!(
            worker_upload_path("sites/zhang-x1/index.html").unwrap(),
            "/api/upload/site/zhang-x1/index.html"
        );
        assert_eq!(
            worker_upload_path("sites/a/assets/img/logo.png").unwrap(),
            "/api/upload/site/a/assets/img/logo.png"
        );
        assert_eq!(
            worker_upload_path("covers/abc123.png").unwrap(),
            "/api/upload/cover/abc123.png"
        );
        assert_eq!(
            worker_upload_path("posters/abc123.png").unwrap(),
            "/api/upload/poster/abc123.png"
        );
        // 带空格/中文的文件名必须转义，Worker 侧会 decodeURIComponent 还原
        assert_eq!(
            worker_upload_path("sites/a/my page.html").unwrap(),
            "/api/upload/site/a/my%20page.html"
        );
        // 非约定前缀 / 路径穿越一律拒
        assert!(worker_upload_path("secrets/key.txt").is_err());
        assert!(worker_upload_path("sites").is_err());
        assert!(worker_upload_path("sites/a/../../etc").is_err());
        assert!(worker_upload_path("sites/a//x").is_err());
        assert!(worker_upload_path("sites/").is_err());
    }

    #[test]
    fn image_sniffing_picks_extension_and_type() {
        assert_eq!(
            sniff_image(b"\x89PNG\r\n\x1a\n\x00\x00"),
            Some(("png", "image/png"))
        );
        assert_eq!(
            sniff_image(b"RIFF\x00\x00\x00\x00WEBPVP8 "),
            Some(("webp", "image/webp"))
        );
        assert_eq!(
            sniff_image(b"\xff\xd8\xff\xe0"),
            Some(("jpg", "image/jpeg"))
        );
        // 认不出来必须拒绝，不能把 HTML/SVG 等任意字节伪装成 JPEG。
        assert_eq!(sniff_image(b"whatever"), None);
    }

    #[test]
    fn collect_files_walks_recursively() {
        let root = std::env::temp_dir().join(format!("mica-site-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("assets/img")).unwrap();
        std::fs::write(root.join("index.html"), b"<html>").unwrap();
        std::fs::write(root.join("assets/app.js"), b"//").unwrap();
        std::fs::write(root.join("assets/img/logo.png"), b"\x89PNG").unwrap();

        let mut out = Vec::new();
        collect_files(&root, &root, &mut out).unwrap();
        out.sort();
        let keys: Vec<&str> = out.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, ["assets/app.js", "assets/img/logo.png", "index.html"]);
        let _ = std::fs::remove_dir_all(&root);
    }
}
