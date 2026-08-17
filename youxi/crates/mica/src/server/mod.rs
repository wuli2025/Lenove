//! 服务器形态（PRD 3.2 P0 主形态）：axum HTTP + SSE + 任务 REST + 控制通道。

pub mod routes;
pub mod sse;

use crate::engine::Scheduler;
use crate::provider::ProviderStore;
use crate::runtime::db::Db;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub scheduler: Arc<Scheduler>,
    pub providers: Arc<ProviderStore>,
    pub db: Arc<Db>,
}

pub fn router(state: AppState) -> axum::Router {
    use axum::routing::{get, patch, post};
    axum::Router::new()
        .route("/healthz", get(routes::healthz))
        .route("/metrics", get(routes::metrics))
        .route("/v1/doctor", get(routes::doctor_checkup))
        .route("/v1/update/check", get(routes::update_check))
        .route("/v1/tasks", post(routes::submit_task))
        .route("/v1/tasks/{id}", get(routes::get_task).merge(patch(routes::patch_task)))
        .route("/v1/tasks/{id}/events", get(sse::task_events))
        .route("/v1/tasks/{id}/cancel", post(routes::cancel_task))
        .route("/v1/tasks/{id}/pause", post(routes::pause_task))
        .route("/v1/tasks/{id}/resume", post(routes::resume_task))
        .route("/v1/providers", get(routes::list_providers).merge(post(routes::add_provider)))
        .route("/v1/providers/{id}/activate", post(routes::activate_provider))
        .route("/v1/providers/{id}/probe", post(routes::probe_provider))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        // 本机编辑器（VN Studio 等）从自身端口跨源调用基座；只服务 127.0.0.1，放开 CORS 安全
        .layer(
            tower_http::cors::CorsLayer::new()
                .allow_origin(tower_http::cors::Any)
                .allow_methods(tower_http::cors::Any)
                .allow_headers(tower_http::cors::Any),
        )
        .with_state(state)
}
