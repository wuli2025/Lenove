//! 契约层：DTO / 事件 / 错误码 —— 零板块依赖（只用 std / serde / uuid）。
//! 被所有模块依赖；本模块出现 `use crate::engine` 等即为边界违规（check-boundaries 红灯）。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

pub type TaskId = String;
pub type TenantId = String;

/// prompt 上限（PRD 4.1：≤ 2MB，超限拒绝）
pub const MAX_PROMPT_BYTES: usize = 2 * 1024 * 1024;
/// 单任务输出封顶（PRD 2.1：回复 8MiB 封顶）
pub const MAX_OUTPUT_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineId {
    /// 纯 Rust 直连 Anthropic 兼容 /v1/messages（零子进程）
    Api,
    /// Codex CLI（默认内置）
    Codex,
    /// Claude Code CLI（按需）
    Claude,
}

impl EngineId {
    /// 调度池归类：Api 走 api 池，其余走 cli 池（PRD 4.3 双池）
    pub fn is_cli(self) -> bool {
        !matches!(self, EngineId::Api)
    }
}

/// 任务形态（PRD 4.2 分流原则的路由键）：
/// 长文本/对话走 ApiEngine；生图与工具循环才落 CLI（codex）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    /// 长文本生成 / 改写 / 对话（默认）—— 永不落 codex
    #[default]
    Text,
    /// 生图任务 —— codex 主战场（内置 GPT-image）
    Image,
    /// 多步工具循环（跑命令 / 批量文件操作）—— CLI 引擎领地
    Tool,
}

/// 三级优先级（PRD 4.3），数值越小越优先
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Priority {
    High,
    #[default]
    Normal,
    Low,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskState {
    Queued,
    /// 排队中被 pause：退出调度不占槽（PRD 4.8）
    Held,
    Running,
    Paused,
    Canceled,
    Done,
    Error,
}

impl TaskState {
    pub fn is_terminal(self) -> bool {
        matches!(self, TaskState::Canceled | TaskState::Done | TaskState::Error)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlOp {
    Cancel,
    Pause,
    Resume,
    Patch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Auth,
    RateLimit,
    Network,
    Timeout,
    /// 看门狗：连续空闲判死（PRD 4.4）
    IdleKilled,
    MemoryLimit,
    OutputLimit,
    PromptTooLarge,
    EngineUnavailable,
    ProviderError,
    Canceled,
    Internal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskLimits {
    /// 绝对硬顶（PRD 4.4 MICA_TASK_HARD_CAP_SECS，默认 1800s）
    pub timeout_secs: u64,
    /// 看门狗连续空闲阈值（默认 300s）
    pub idle_secs: u64,
    pub max_output_bytes: u64,
}

impl Default for TaskLimits {
    fn default() -> Self {
        Self { timeout_secs: 1800, idle_secs: 300, max_output_bytes: MAX_OUTPUT_BYTES }
    }
}

/// 任务规格（PRD 4.1）。绑定在入队时解析并快照（PRD 5.3）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskSpec {
    pub id: TaskId,
    pub tenant: TenantId,
    pub engine: EngineId,
    pub prompt: String,
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub cwd: Option<PathBuf>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub kind: TaskKind,
    #[serde(default)]
    pub priority: Priority,
    #[serde(default)]
    pub limits: TaskLimits,
    /// 任务级供应商指定（优先于全局 active，PRD 5.3 三级作用域）
    #[serde(default)]
    pub provider_override: Option<String>,
    /// SSE 断连即取消（PRD 4.8：交互任务 on / 流水线 off）
    #[serde(default)]
    pub cancel_on_disconnect: bool,
    /// 新会话钉死 session id（claude CLI --session-id），供编辑器终端多轮续聊定位
    #[serde(default)]
    pub session_id: Option<String>,
    /// 续聊已有会话（claude CLI --resume <id>），与 session_id 互斥，resume 优先
    #[serde(default)]
    pub resume: Option<String>,
}

/// 统一事件模型（PRD 4.1 + 4.8），双引擎归一化；SSE / Tauri emit / 落库同构。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    Queued { position: u32 },
    Started { pid: Option<u32> },
    Delta { text: String },
    ToolUse { name: String, summary: String },
    /// 任务产物（PRD 4.1）：生图/多文件产出的落盘回传，path 为任务工作区内路径
    Artifact { path: String, kind: String },
    Usage { input_tokens: u64, output_tokens: u64 },
    /// 控制指令回执（PRD 4.8），随事件流下发
    ControlAck { op: ControlOp, ok: bool, detail: Option<String> },
    /// Paused / Resumed / Canceled 等状态转移（PRD 4.8）
    StateChanged { state: TaskState },
    Done { result: String },
    Error { code: ErrorCode, detail: String, retryable: bool },
}

/// 四档模型钉死（PRD 5.2：防 CLI 后台小任务回落官方默认名被网关拒）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelMap {
    pub default: String,
    #[serde(default)]
    pub opus: String,
    #[serde(default)]
    pub sonnet: String,
    #[serde(default)]
    pub haiku: String,
}

/// 传给每次 spawn 的一份不可变绑定（PRD 5 章设计纲领），不是全局状态。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderBinding {
    pub id: String,
    pub name: String,
    pub base_url: String,
    /// ANTHROPIC_AUTH_TOKEN（Bearer 网关）或 ANTHROPIC_API_KEY（x-api-key）
    pub auth_field: String,
    pub secret: String,
    pub models: ModelMap,
}

/// 受管环境键：构造子进程前先清空再注入，防宿主环境渗透（PRD 5.3）
pub const MANAGED_ENV_KEYS: &[&str] = &[
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "CLAUDE_CONFIG_DIR",
];

pub type EnvMap = BTreeMap<String, String>;

/// 运行时解析结果（doctor 产出，engine 消费——经调度器注入的闭包传递，
/// 维持 engine 不依赖 doctor 的模块方向）
#[derive(Debug, Clone)]
pub struct ResolvedRuntime {
    pub exe: PathBuf,
    /// 来源：env override / runtimes / path（设置页「运行时来源」展示用）
    pub via: String,
    /// Windows npm 装的是 .cmd，CreateProcessW 直接找不到——须经 cmd /c（PRD 2.1 血泪坑）
    pub needs_cmd_shim: bool,
}

/// 运行时解析器：由装配层（server/desktop）把 doctor::resolve 接进调度器
pub type RuntimeResolver =
    std::sync::Arc<dyn Fn(EngineId) -> Result<ResolvedRuntime> + Send + Sync>;

#[derive(Debug, thiserror::Error)]
pub enum MicaError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("db: {0}")]
    Db(String),
    #[error("queue full (capacity {0})")]
    QueueFull(usize),
    #[error("task not found: {0}")]
    NotFound(TaskId),
    #[error("task already terminal: {0:?}")]
    Terminal(TaskState),
    #[error("invalid op in state {0:?}")]
    InvalidState(TaskState),
    #[error("provider: {0}")]
    Provider(String),
    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, MicaError>;

pub fn new_task_id() -> TaskId {
    uuid::Uuid::new_v4().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_event_serde_roundtrip_and_tag() {
        let ev = AgentEvent::ControlAck { op: ControlOp::Cancel, ok: true, detail: None };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains(r#""type":"control_ack""#), "tag 格式应为 snake_case: {json}");
        assert!(json.contains(r#""op":"cancel""#));
        let back: AgentEvent = serde_json::from_str(&json).unwrap();
        assert!(matches!(back, AgentEvent::ControlAck { ok: true, .. }));

        let ev = AgentEvent::StateChanged { state: TaskState::Paused };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains(r#""state":"paused""#));
    }

    #[test]
    fn priority_orders_high_first() {
        assert!(Priority::High < Priority::Normal);
        assert!(Priority::Normal < Priority::Low);
    }

    #[test]
    fn task_state_terminal() {
        assert!(TaskState::Done.is_terminal());
        assert!(TaskState::Canceled.is_terminal());
        assert!(!TaskState::Paused.is_terminal());
        assert!(!TaskState::Held.is_terminal());
    }

    #[test]
    fn task_spec_deserialize_defaults() {
        let spec: TaskSpec = serde_json::from_str(
            r#"{"id":"t1","tenant":"u1","engine":"api","prompt":"hi"}"#,
        )
        .unwrap();
        assert_eq!(spec.priority, Priority::Normal);
        assert_eq!(spec.limits.timeout_secs, 1800);
        assert!(!spec.cancel_on_disconnect);
    }
}
