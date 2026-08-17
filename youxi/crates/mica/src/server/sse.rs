//! SSE 事件出口（PRD 4.7）：Last-Event-ID 续传（先回放 db 再接广播）+
//! 断连即取消兜底（PRD 4.8：5s 宽限，仅 cancel_on_disconnect 任务）。

use crate::core::{AgentEvent, ControlOp, TaskState};
use crate::server::AppState;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::sse::{Event, KeepAlive, Sse};
use std::convert::Infallible;
use std::time::Duration;
use tokio::sync::broadcast;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

const DISCONNECT_GRACE: Duration = Duration::from_secs(5);

pub async fn task_events(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> impl axum::response::IntoResponse {
    let after: i64 = headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    let (tx, rx) = mpsc::channel::<Result<Event, Infallible>>(64);
    let bus = state.scheduler.bus();

    tokio::spawn(async move {
        // 先订阅再回放：订阅点之后的新事件不丢，回放段之内的重复靠 seq 去重
        let mut live = bus.subscribe(&id);
        let replay = bus.replay(&id, after);
        let mut last_seq = after;

        for (seq, json) in replay {
            last_seq = seq;
            if tx.send(Ok(Event::default().id(seq.to_string()).data(json))).await.is_err() {
                on_disconnect(&state, &id).await;
                return;
            }
        }

        // 回放后任务已终态 → 直接收尾（bus 可能已 close）
        if state
            .scheduler
            .state_of(&id)
            .map(TaskState::is_terminal)
            .unwrap_or(false)
        {
            return;
        }

        loop {
            match live.recv().await {
                Ok((seq, event)) => {
                    if seq != 0 && seq <= last_seq {
                        continue; // 回放段与广播的重叠去重
                    }
                    last_seq = seq.max(last_seq);
                    let terminal = matches!(
                        &event,
                        AgentEvent::StateChanged { state } if state.is_terminal()
                    );
                    let json = match serde_json::to_string(&event) {
                        Ok(j) => j,
                        Err(_) => continue,
                    };
                    if tx.send(Ok(Event::default().id(seq.to_string()).data(json))).await.is_err() {
                        on_disconnect(&state, &id).await;
                        return;
                    }
                    if terminal {
                        return;
                    }
                }
                // 消费端掉速被环形缓冲挤掉：继续收新事件（历史可用 Last-Event-ID 重拉）
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return,
            }
        }
    });

    Sse::new(ReceiverStream::new(rx)).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}

/// 断连即取消（PRD 4.8）：宽限期内未重连且任务标记了 cancel_on_disconnect 才取消。
/// 交互对话任务关页面即停止计费；流水线任务绝不因断连作废。
async fn on_disconnect(state: &AppState, id: &String) {
    let Ok(Some(row)) = state.db.get_task(id) else { return };
    if !row.spec.cancel_on_disconnect {
        return;
    }
    tokio::time::sleep(DISCONNECT_GRACE).await;
    let bus = state.scheduler.bus();
    let still_gone = bus.subscriber_count(id) == 0;
    let not_terminal = state
        .scheduler
        .state_of(id)
        .map(|s| !s.is_terminal())
        .unwrap_or(false);
    if still_gone && not_terminal {
        tracing::info!(task = %id, "cancel_on_disconnect: grace elapsed, canceling");
        let _ = state.scheduler.control(id, ControlOp::Cancel);
    }
}
