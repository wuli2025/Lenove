//! 任务事件总线：落库（可回放）+ 广播（SSE / Tauri emit 订阅）。
//! 事件先拿 per-task seq 再广播，SSE 以 Last-Event-ID 从 db 续传后接广播（PRD 4.7）。

use crate::core::{AgentEvent, TaskId};
use crate::runtime::db::Db;
use dashmap::DashMap;
use std::sync::Arc;
use tokio::sync::broadcast;

const CHANNEL_CAP: usize = 256;

pub struct EventBus {
    db: Arc<Db>,
    chans: DashMap<TaskId, broadcast::Sender<(i64, AgentEvent)>>,
}

impl EventBus {
    pub fn new(db: Arc<Db>) -> Self {
        Self {
            db,
            chans: DashMap::new(),
        }
    }

    /// 落库 + 广播，返回 seq。落库失败降级为只广播（日志告警，不断流）。
    pub fn emit(&self, id: &TaskId, event: AgentEvent) -> i64 {
        let seq = match self.db.append_event(id, &event) {
            Ok(seq) => seq,
            Err(e) => {
                tracing::warn!(task = %id, error = %e, "event persist failed");
                0
            }
        };
        if let Some(tx) = self.chans.get(id) {
            let _ = tx.send((seq, event));
        }
        seq
    }

    pub fn subscribe(&self, id: &TaskId) -> broadcast::Receiver<(i64, AgentEvent)> {
        self.chans
            .entry(id.clone())
            .or_insert_with(|| broadcast::channel(CHANNEL_CAP).0)
            .subscribe()
    }

    /// 当前订阅者数（断连即取消判据，PRD 4.8）
    pub fn subscriber_count(&self, id: &TaskId) -> usize {
        self.chans
            .get(id)
            .map(|tx| tx.receiver_count())
            .unwrap_or(0)
    }

    /// 终态后延迟清理通道（订阅者读完落库事件即可，无需常驻）
    pub fn close(&self, id: &TaskId) {
        self.chans.remove(id);
    }

    pub fn replay(&self, id: &TaskId, after: i64) -> Vec<(i64, String)> {
        self.db.events_after(id, after).unwrap_or_default()
    }
}
