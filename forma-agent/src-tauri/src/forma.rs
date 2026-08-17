//! FORMA 专属路由 —— 补齐 youxi/MicaBase 没有、但个人网站创作场景需要的那几个口。
//!
//! 刻意做成「外挂路由」而不是改 youxi：mica 的 router 原样 merge 进来，
//! 这里只加 forma 自己的 `/v1/app/info`、`/v1/presets`、`/v1/sites/*`
//! 以及 mica 没暴露但 store 里已实现的 provider 删除 / 兜底设置。

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use mica::provider::ProviderStore;
use serde::Deserialize;
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;

pub struct FormaCtx {
    pub port: u16,
    pub data_root: PathBuf,
    pub sites_dir: PathBuf,
    pub providers: Arc<ProviderStore>,
}

type Ctx = Arc<FormaCtx>;

fn bad(msg: impl std::fmt::Display) -> Response {
    (StatusCode::UNPROCESSABLE_ENTITY, Json(json!({"error": msg.to_string()}))).into_response()
}

pub fn routes(ctx: Ctx) -> Router {
    Router::new()
        .route("/v1/app/info", get(app_info))
        .route("/v1/presets", get(list_presets))
        .route("/v1/providers/{id}/delete", post(delete_provider))
        .route("/v1/providers/{id}/update", post(update_provider))
        .route("/v1/providers/{id}/fallback", post(set_fallback))
        .route("/v1/sites", get(list_sites).merge(post(save_site)))
        .route("/v1/sites/{slug}/delete", post(delete_site))
        .route("/v1/sites/{slug}/reveal", post(reveal_site))
        .route("/v1/reveal-data", post(reveal_data))
        .route("/v1/open", post(open_external))
        .with_state(ctx)
}

/// 设置页「运行环境」块的数据源：壳信息 + 隔离后的数据目录 + 实际端口。
async fn app_info(State(ctx): State<Ctx>) -> Response {
    Json(json!({
        "name": "FORMA Agent",
        "version": env!("CARGO_PKG_VERSION"),
        "shell": "tauri",
        "backend": "MicaBase (youxi)",
        "port": ctx.port,
        "dataRoot": ctx.data_root.display().to_string(),
        "sitesDir": ctx.sites_dir.display().to_string(),
        "providersFile": mica::runtime::paths::providers_path().display().to_string(),
        "dbFile": mica::runtime::paths::db_path().display().to_string(),
        "logsDir": mica::runtime::paths::logs_dir().display().to_string(),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    }))
    .into_response()
}

/// 内置供应商预设表（前端「新增供应商」下拉用，选预设只填 key）。
async fn list_presets() -> Response {
    let list: Vec<_> = mica::provider::presets::PRESETS
        .iter()
        .map(|p| {
            json!({
                "key": p.key,
                "name": p.name,
                "base_url": p.base_url,
                "auth_field": p.auth_field,
                "models": {
                    "default": p.models[0],
                    "opus": p.models[1],
                    "sonnet": p.models[2],
                    "haiku": p.models[3],
                },
            })
        })
        .collect();
    Json(json!({ "presets": list })).into_response()
}

async fn delete_provider(State(ctx): State<Ctx>, Path(id): Path<String>) -> Response {
    match ctx.providers.remove(&id) {
        Ok(()) => Json(json!({"ok": true})).into_response(),
        Err(e) => bad(e),
    }
}

#[derive(Deserialize)]
struct UpdateProviderBody {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default)]
    auth_field: Option<String>,
    /// 留空 / 缺省 = 保持原有 key 不变（mica 的 POST /v1/providers 是整条覆盖，
    /// 而列表接口出于脱敏不回传 secret，所以编辑必须走这条补丁路由）
    #[serde(default)]
    secret: Option<String>,
    #[serde(default)]
    models: Option<mica::core::ModelMap>,
}

async fn update_provider(
    State(ctx): State<Ctx>,
    Path(id): Path<String>,
    Json(body): Json<UpdateProviderBody>,
) -> Response {
    let Some(mut entry) = ctx.providers.get(&id) else {
        return bad(format!("unknown provider: {id}"));
    };
    if let Some(v) = body.name.filter(|s| !s.trim().is_empty()) {
        entry.name = v;
    }
    if let Some(v) = body.base_url.filter(|s| !s.trim().is_empty()) {
        entry.base_url = v;
    }
    if let Some(v) = body.auth_field.filter(|s| !s.trim().is_empty()) {
        entry.auth.field = v;
    }
    if let Some(v) = body.secret.filter(|s| !s.trim().is_empty()) {
        entry.auth.secret = v;
    }
    if let Some(v) = body.models {
        if !v.default.trim().is_empty() {
            entry.models = v;
        }
    }
    match ctx.providers.upsert(entry) {
        Ok(()) => Json(json!({"ok": true})).into_response(),
        Err(e) => bad(e),
    }
}

#[derive(Deserialize)]
struct FallbackBody {
    #[serde(default)]
    enable: bool,
}

/// 故障转移兜底：active 连续失败时自动切到它（youxi store 已实现滑窗判定）。
async fn set_fallback(
    State(ctx): State<Ctx>,
    Path(id): Path<String>,
    Json(body): Json<FallbackBody>,
) -> Response {
    let target = if body.enable { Some(id) } else { None };
    match ctx.providers.set_fallback(target) {
        Ok(()) => Json(json!({"ok": true})).into_response(),
        Err(e) => bad(e),
    }
}

// ── 站点工程：生成的个人网站落盘在 <数据目录>/sites/<slug>/ ──

fn safe_slug(raw: &str) -> String {
    let s: String = raw
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let s = s.trim_matches('-').to_string();
    if s.is_empty() {
        format!("site-{}", std::process::id())
    } else {
        s.chars().take(64).collect()
    }
}

#[derive(Deserialize)]
struct SaveSiteBody {
    slug: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    template: String,
    html: String,
    #[serde(default)]
    profile: serde_json::Value,
}

async fn save_site(State(ctx): State<Ctx>, Json(body): Json<SaveSiteBody>) -> Response {
    let slug = safe_slug(&body.slug);
    let dir = ctx.sites_dir.join(&slug);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return bad(e);
    }
    if let Err(e) = std::fs::write(dir.join("index.html"), body.html.as_bytes()) {
        return bad(e);
    }
    let meta = json!({
        "slug": slug,
        "name": body.name,
        "template": body.template,
        "profile": body.profile,
        "savedAt": now_millis(),
    });
    if let Err(e) = std::fs::write(
        dir.join("meta.json"),
        serde_json::to_vec_pretty(&meta).unwrap_or_default(),
    ) {
        return bad(e);
    }
    Json(json!({"ok": true, "slug": slug, "dir": dir.display().to_string()})).into_response()
}

async fn list_sites(State(ctx): State<Ctx>) -> Response {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&ctx.sites_dir) {
        for e in entries.flatten() {
            if !e.path().is_dir() {
                continue;
            }
            let meta_path = e.path().join("meta.json");
            let meta: serde_json::Value = std::fs::read(&meta_path)
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok())
                .unwrap_or_else(|| json!({}));
            out.push(json!({
                "slug": e.file_name().to_string_lossy(),
                "name": meta.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                "template": meta.get("template").and_then(|v| v.as_str()).unwrap_or(""),
                "savedAt": meta.get("savedAt").cloned().unwrap_or(json!(0)),
                "dir": e.path().display().to_string(),
            }));
        }
    }
    // 新的排前面
    out.sort_by(|a, b| {
        b["savedAt"].as_u64().unwrap_or(0).cmp(&a["savedAt"].as_u64().unwrap_or(0))
    });
    Json(json!({ "sites": out })).into_response()
}

async fn delete_site(State(ctx): State<Ctx>, Path(slug): Path<String>) -> Response {
    let dir = ctx.sites_dir.join(safe_slug(&slug));
    // 只允许删 sites 目录下的东西，防路径穿越
    if !dir.starts_with(&ctx.sites_dir) {
        return bad("illegal path");
    }
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => Json(json!({"ok": true})).into_response(),
        Err(e) => bad(e),
    }
}

async fn reveal_site(State(ctx): State<Ctx>, Path(slug): Path<String>) -> Response {
    let dir = ctx.sites_dir.join(safe_slug(&slug));
    match reveal(&dir) {
        Ok(()) => Json(json!({"ok": true})).into_response(),
        Err(e) => bad(e),
    }
}

/// 设置页「打开数据目录」：直接开 FORMA 自己的数据根目录。
async fn reveal_data(State(ctx): State<Ctx>) -> Response {
    match reveal(&ctx.data_root) {
        Ok(()) => Json(json!({"ok": true, "dir": ctx.data_root.display().to_string()})).into_response(),
        Err(e) => bad(e),
    }
}

#[derive(Deserialize)]
struct OpenBody {
    url: String,
}

/// 设置页「打开发布页 / 下载地址」用：交给系统默认浏览器。
async fn open_external(Json(body): Json<OpenBody>) -> Response {
    let url = body.url.trim();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return bad("only http(s) urls are allowed");
    }
    match open_path(url) {
        Ok(()) => Json(json!({"ok": true})).into_response(),
        Err(e) => bad(e),
    }
}

fn reveal(dir: &std::path::Path) -> std::io::Result<()> {
    if !dir.exists() {
        return Err(std::io::Error::new(std::io::ErrorKind::NotFound, "目录不存在"));
    }
    open_path(&dir.display().to_string())
}

fn open_path(target: &str) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        std::process::Command::new("explorer").arg(target).spawn().map(|_| ())
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(target).spawn().map(|_| ())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open").arg(target).spawn().map(|_| ())
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
