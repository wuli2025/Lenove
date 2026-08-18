//! SQLite 持久化（PRD 7.2）：tasks / events / usage 三表，WAL 模式。
//! 单连接 + Mutex 串行写（单写者语义）；事件带 per-task seq，支撑 SSE Last-Event-ID 续传回放。

use crate::core::{AgentEvent, EngineId, MicaError, Result, TaskId, TaskSpec, TaskState};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::Mutex;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS tasks(
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  engine TEXT NOT NULL,
  state TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  binding_id TEXT,
  result TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  json TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, seq);
CREATE TABLE IF NOT EXISTS usage(
  task_id TEXT NOT NULL,
  engine TEXT NOT NULL,
  provider TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  code TEXT NOT NULL,
  ts INTEGER NOT NULL
);
"#;

fn dbe(e: rusqlite::Error) -> MicaError {
    MicaError::Db(e.to_string())
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn state_str(s: TaskState) -> &'static str {
    match s {
        TaskState::Queued => "queued",
        TaskState::Held => "held",
        TaskState::Running => "running",
        TaskState::Paused => "paused",
        TaskState::Canceled => "canceled",
        TaskState::Done => "done",
        TaskState::Error => "error",
    }
}

fn parse_state(s: &str) -> TaskState {
    match s {
        "queued" => TaskState::Queued,
        "held" => TaskState::Held,
        "running" => TaskState::Running,
        "paused" => TaskState::Paused,
        "canceled" => TaskState::Canceled,
        "done" => TaskState::Done,
        _ => TaskState::Error,
    }
}

fn engine_str(e: EngineId) -> &'static str {
    match e {
        EngineId::Api => "api",
        EngineId::Codex => "codex",
        EngineId::Claude => "claude",
    }
}

pub struct TaskRow {
    pub spec: TaskSpec,
    pub state: TaskState,
    pub result: Option<String>,
}

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(p) = path.parent() {
            std::fs::create_dir_all(p)?;
        }
        let conn = Connection::open(path).map_err(dbe)?;
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        let _ = conn.pragma_update(None, "synchronous", "NORMAL");
        // 锁竞争等待而非立即报 SQLITE_BUSY（多进程/外部工具读库时不炸）
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(dbe)?;
        let _ = conn.pragma_update(None, "cache_size", -16384); // 16MB 页缓存
        conn.execute_batch(SCHEMA).map_err(dbe)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().map_err(dbe)?;
        conn.execute_batch(SCHEMA).map_err(dbe)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn insert_task(&self, spec: &TaskSpec, binding_id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO tasks(id,tenant,engine,state,spec_json,binding_id,created_at,updated_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?7)",
            params![
                spec.id,
                spec.tenant,
                engine_str(spec.engine),
                state_str(TaskState::Queued),
                serde_json::to_string(spec)?,
                binding_id,
                now()
            ],
        )
        .map_err(dbe)?;
        Ok(())
    }

    pub fn update_state(&self, id: &TaskId, state: TaskState) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.prepare_cached("UPDATE tasks SET state=?2, updated_at=?3 WHERE id=?1")
            .map_err(dbe)?
            .execute(params![id, state_str(state), now()])
            .map_err(dbe)?;
        Ok(())
    }

    /// PATCH 参数：排队中改 TaskSpec 快照（PRD 4.8）
    pub fn update_spec(&self, spec: &TaskSpec) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE tasks SET spec_json=?2, updated_at=?3 WHERE id=?1",
            params![spec.id, serde_json::to_string(spec)?, now()],
        )
        .map_err(dbe)?;
        Ok(())
    }

    pub fn set_result(&self, id: &TaskId, state: TaskState, result: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE tasks SET state=?2, result=?3, updated_at=?4 WHERE id=?1",
            params![id, state_str(state), result, now()],
        )
        .map_err(dbe)?;
        Ok(())
    }

    pub fn get_task(&self, id: &TaskId) -> Result<Option<TaskRow>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT spec_json, state, result FROM tasks WHERE id=?1",
            params![id],
            |row| {
                let spec_json: String = row.get(0)?;
                let state: String = row.get(1)?;
                let result: Option<String> = row.get(2)?;
                Ok((spec_json, state, result))
            },
        )
        .optional()
        .map_err(dbe)?
        .map(|(spec_json, state, result)| {
            Ok(TaskRow {
                spec: serde_json::from_str(&spec_json)?,
                state: parse_state(&state),
                result,
            })
        })
        .transpose()
    }

    /// 事件落库并返回 per-task 递增 seq（SSE 的 event id）。
    /// 最热路径（每 30ms 批量 flush × 在飞任务数），走 prepare_cached 免重编译。
    pub fn append_event(&self, id: &TaskId, event: &AgentEvent) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare_cached(
                "INSERT INTO events(task_id,seq,json,ts)
                 VALUES(?1,(SELECT COALESCE(MAX(seq),0)+1 FROM events WHERE task_id=?1),?2,?3)
                 RETURNING seq",
            )
            .map_err(dbe)?;
        stmt.query_row(params![id, serde_json::to_string(event)?, now()], |row| {
            row.get(0)
        })
        .map_err(dbe)
    }

    /// 回放：seq > after 的全部事件（Last-Event-ID 续传）
    pub fn events_after(&self, id: &TaskId, after: i64) -> Result<Vec<(i64, String)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare_cached("SELECT seq, json FROM events WHERE task_id=?1 AND seq>?2 ORDER BY seq")
            .map_err(dbe)?;
        let rows = stmt
            .query_map(params![id, after], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(dbe)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(dbe)?;
        Ok(rows)
    }

    /// 用量记账（PRD 4.7：灵感值计费数据源）
    #[allow(clippy::too_many_arguments)]
    pub fn record_usage(
        &self,
        id: &TaskId,
        engine: EngineId,
        provider: &str,
        input_tokens: u64,
        output_tokens: u64,
        duration_ms: u64,
        code: &str,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO usage(task_id,engine,provider,input_tokens,output_tokens,duration_ms,code,ts)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                id,
                engine_str(engine),
                provider,
                input_tokens as i64,
                output_tokens as i64,
                duration_ms as i64,
                code,
                now()
            ],
        )
        .map_err(dbe)?;
        Ok(())
    }

    pub fn counts_by_state(&self) -> Result<Vec<(String, i64)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT state, COUNT(*) FROM tasks GROUP BY state")
            .map_err(dbe)?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(dbe)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(dbe)?;
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{new_task_id, Priority, TaskKind, TaskLimits};

    fn spec(id: &str) -> TaskSpec {
        TaskSpec {
            id: id.into(),
            tenant: "t".into(),
            engine: EngineId::Api,
            prompt: "hi".into(),
            system_prompt: None,
            cwd: None,
            model: None,
            kind: TaskKind::Text,
            priority: Priority::Normal,
            limits: TaskLimits::default(),
            provider_override: None,
            cancel_on_disconnect: false,
            session_id: None,
            resume: None,
        }
    }

    #[test]
    fn task_lifecycle_roundtrip() {
        let db = Db::open_in_memory().unwrap();
        let s = spec("t1");
        db.insert_task(&s, "prov_x").unwrap();
        let row = db.get_task(&"t1".to_string()).unwrap().unwrap();
        assert_eq!(row.state, TaskState::Queued);
        assert_eq!(row.spec.prompt, "hi");

        db.set_result(&"t1".to_string(), TaskState::Done, "ok")
            .unwrap();
        let row = db.get_task(&"t1".to_string()).unwrap().unwrap();
        assert_eq!(row.state, TaskState::Done);
        assert_eq!(row.result.as_deref(), Some("ok"));
    }

    #[test]
    fn event_seq_and_replay() {
        let db = Db::open_in_memory().unwrap();
        let id = new_task_id();
        for i in 0..3u32 {
            let seq = db
                .append_event(
                    &id,
                    &AgentEvent::Delta {
                        text: format!("d{i}"),
                    },
                )
                .unwrap();
            assert_eq!(seq, i as i64 + 1, "seq 应从 1 递增");
        }
        let replay = db.events_after(&id, 1).unwrap();
        assert_eq!(replay.len(), 2, "after=1 应回放 seq 2/3");
        assert_eq!(replay[0].0, 2);
        assert!(replay[1].1.contains("d2"));
    }
}
