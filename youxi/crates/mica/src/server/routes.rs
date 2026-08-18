//! REST 路由：提交 / 查询 / 控制（PRD 4.8 上行）/ 供应商管理（PRD 5.6 对应的后端）。

use crate::core::{
    new_task_id, ControlOp, EngineId, MicaError, Priority, TaskKind, TaskLimits, TaskSpec,
};
use crate::provider::probe::probe;
use crate::provider::store::ProviderEntry;
use crate::server::AppState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;

fn err_response(e: MicaError) -> Response {
    let (status, msg) = match &e {
        MicaError::NotFound(_) => (StatusCode::NOT_FOUND, e.to_string()),
        MicaError::Terminal(state) => (
            StatusCode::GONE,
            format!("task already terminal: {state:?}"),
        ),
        MicaError::InvalidState(_) => (StatusCode::CONFLICT, e.to_string()),
        MicaError::QueueFull(_) => (StatusCode::TOO_MANY_REQUESTS, e.to_string()),
        MicaError::Provider(_) => (StatusCode::UNPROCESSABLE_ENTITY, e.to_string()),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let mut resp = (status, Json(json!({"error": msg}))).into_response();
    if status == StatusCode::TOO_MANY_REQUESTS {
        // 背压带预估等待（PRD 4.3）
        resp.headers_mut()
            .insert("retry-after", "5".parse().unwrap());
    }
    resp
}

pub async fn healthz() -> &'static str {
    "ok"
}

/// 环境医生（设置页）：逐项体检 claude / codex / node / git，给新用户引导。
pub async fn doctor_checkup() -> Response {
    let (components, ready) = crate::doctor::checkup();
    Json(json!({
        "ready": ready,
        "components": components,
    }))
    .into_response()
}

/// 远程更新检查（设置页）：查 GitHub wuli2025/youxi 最新发布。
pub async fn update_check() -> Response {
    let report = crate::update::check().await;
    Json(report).into_response()
}

pub async fn metrics(State(state): State<AppState>) -> String {
    state.scheduler.metrics()
}

#[derive(Deserialize)]
pub struct SubmitBody {
    pub prompt: String,
    #[serde(default = "default_engine")]
    pub engine: EngineId,
    #[serde(default = "default_tenant")]
    pub tenant: String,
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    /// text（默认，长文本永不落 codex）/ image（codex 主战场）/ tool
    #[serde(default)]
    pub kind: TaskKind,
    #[serde(default)]
    pub priority: Priority,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub cancel_on_disconnect: bool,
    #[serde(default)]
    pub limits: Option<TaskLimits>,
    /// 任务工作目录（编辑器传当前工程路径，CLI 直接读写工程文件）
    #[serde(default)]
    pub cwd: Option<std::path::PathBuf>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub resume: Option<String>,
}

fn default_engine() -> EngineId {
    EngineId::Api
}

fn default_tenant() -> String {
    "default".into()
}

pub async fn submit_task(State(state): State<AppState>, Json(body): Json<SubmitBody>) -> Response {
    let spec = TaskSpec {
        id: new_task_id(),
        tenant: body.tenant,
        engine: body.engine,
        prompt: body.prompt,
        system_prompt: body.system_prompt,
        cwd: body.cwd,
        model: body.model,
        kind: body.kind,
        priority: body.priority,
        limits: body.limits.unwrap_or_default(),
        provider_override: body.provider,
        cancel_on_disconnect: body.cancel_on_disconnect,
        session_id: body.session_id,
        resume: body.resume,
    };
    let id = spec.id.clone();
    let requested = spec.engine;
    match state.scheduler.submit(spec) {
        // engine 为路由后结果（PRD 4.2 分流：text 不落 codex，image 必走 codex）
        Ok((position, engine)) => (
            StatusCode::ACCEPTED,
            Json(json!({
                "task_id": id,
                "position": position,
                "engine": engine,
                "rerouted": engine != requested,
            })),
        )
            .into_response(),
        Err(e) => err_response(e),
    }
}

pub async fn get_task(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.db.get_task(&id) {
        Ok(Some(row)) => Json(json!({
            "id": id,
            "state": row.state,
            "engine": row.spec.engine,
            "tenant": row.spec.tenant,
            "result": row.result,
        }))
        .into_response(),
        Ok(None) => err_response(MicaError::NotFound(id)),
        Err(e) => err_response(e),
    }
}

fn control(state: &AppState, id: &str, op: ControlOp) -> Response {
    match state.scheduler.control(&id.to_string(), op) {
        // 受理即 202，实际生效以 SSE 的 ControlAck / StateChanged 为准（PRD 4.8 回执闭环）
        Ok(()) => (
            StatusCode::ACCEPTED,
            Json(json!({"accepted": true, "op": op})),
        )
            .into_response(),
        Err(e) => err_response(e),
    }
}

pub async fn cancel_task(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    control(&state, &id, ControlOp::Cancel)
}

pub async fn pause_task(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    control(&state, &id, ControlOp::Pause)
}

pub async fn resume_task(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    control(&state, &id, ControlOp::Resume)
}

#[derive(Deserialize)]
pub struct PatchBody {
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub priority: Option<Priority>,
    #[serde(default)]
    pub provider: Option<String>,
}

pub async fn patch_task(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<PatchBody>,
) -> Response {
    match state
        .scheduler
        .patch(&id, body.model, body.priority, body.provider)
    {
        Ok(()) => (StatusCode::ACCEPTED, Json(json!({"accepted": true}))).into_response(),
        Err(e) => err_response(e),
    }
}

pub async fn list_providers(State(state): State<AppState>) -> Response {
    let snapshot = state.providers.snapshot();
    let providers: Vec<_> = snapshot
        .providers
        .iter()
        .map(|p| {
            json!({
                "id": p.id,
                "name": p.name,
                "base_url": p.base_url,
                "models": p.models,
                "preset": p.preset,
                // 脱敏（PRD 5.6）
                "secret_set": !p.auth.secret.is_empty(),
            })
        })
        .collect();
    Json(json!({
        "active": snapshot.active,
        "fallback": snapshot.fallback,
        "providers": providers,
    }))
    .into_response()
}

#[derive(Deserialize)]
pub struct AddProviderBody {
    pub id: String,
    #[serde(default)]
    pub preset: Option<String>,
    pub secret: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub auth_field: Option<String>,
    #[serde(default)]
    pub models: Option<crate::core::ModelMap>,
}

pub async fn add_provider(
    State(state): State<AppState>,
    Json(body): Json<AddProviderBody>,
) -> Response {
    // 预设路径：选预设只填 key；自定义路径：全字段（PRD 5.6 两条新增路径）
    let entry = if let Some(preset) = &body.preset {
        match ProviderEntry::from_preset(&body.id, preset, &body.secret) {
            Some(mut e) => {
                if let Some(n) = body.name {
                    e.name = n;
                }
                e
            }
            None => return err_response(MicaError::Provider(format!("unknown preset: {preset}"))),
        }
    } else {
        let (Some(base_url), Some(models)) = (body.base_url, body.models) else {
            return err_response(MicaError::Provider(
                "custom provider requires base_url and models".into(),
            ));
        };
        ProviderEntry {
            id: body.id.clone(),
            name: body.name.unwrap_or_else(|| body.id.clone()),
            kind: "anthropic_compat".into(),
            base_url,
            auth: crate::provider::store::AuthCfg {
                field: body
                    .auth_field
                    .unwrap_or_else(|| "ANTHROPIC_AUTH_TOKEN".into()),
                secret: body.secret,
            },
            models,
            preset: None,
        }
    };
    match state.providers.upsert(entry) {
        Ok(()) => (StatusCode::CREATED, Json(json!({"ok": true}))).into_response(),
        Err(e) => err_response(e),
    }
}

pub async fn activate_provider(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    // 切换前预检：探测通过才允许设为激活（PRD 5.1-4）
    let Some(entry) = state.providers.get(&id) else {
        return err_response(MicaError::Provider(format!("unknown provider: {id}")));
    };
    match probe(&entry.binding()).await {
        Ok(result) if result.ok => match state.providers.set_active(&id) {
            Ok(()) => Json(json!({"ok": true, "probe": result})).into_response(),
            Err(e) => err_response(e),
        },
        Ok(result) => (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(
                json!({"ok": false, "error": "probe failed, activation refused", "probe": result}),
            ),
        )
            .into_response(),
        Err(e) => err_response(e),
    }
}

pub async fn probe_provider(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(entry) = state.providers.get(&id) else {
        return err_response(MicaError::Provider(format!("unknown provider: {id}")));
    };
    match probe(&entry.binding()).await {
        Ok(result) => Json(json!(result)).into_response(),
        Err(e) => err_response(e),
    }
}
