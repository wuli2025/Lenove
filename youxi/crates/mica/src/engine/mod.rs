//! 执行引擎（PRD 第 4 章）：ApiEngine + Claude/Codex CLI 引擎 + 调度器 + 事件总线。

pub mod api;
pub mod batcher;
pub mod bus;
pub mod cli;
pub mod scheduler;

pub use bus::EventBus;
pub use scheduler::{Scheduler, SchedulerCfg};

use crate::core::{ErrorCode, ProviderBinding, TaskSpec, TaskState};

/// 送达在飞任务的控制指令（PRD 4.8：每任务 ctrl 通道 + tokio::select）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CtrlMsg {
    Cancel,
    /// 单发生成中的 pause = 截停留稿：abort + 已产出增量落盘（PRD 4.8 表）
    Pause,
}

/// 引擎运行上下文（调度器构造，引擎消费）
pub struct RunCtx {
    pub spec: TaskSpec,
    pub binding: ProviderBinding,
    pub db: std::sync::Arc<crate::runtime::db::Db>,
    pub bus: std::sync::Arc<EventBus>,
    pub registry: std::sync::Arc<crate::runtime::registry::ProcessRegistry>,
    pub ctrl: tokio::sync::mpsc::Receiver<CtrlMsg>,
}

/// 引擎运行结果，由调度器统一落库 / 记账 / 发终态事件
pub struct RunOutcome {
    pub state: TaskState,
    pub result: String,
    pub error: Option<(ErrorCode, String, bool)>,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

impl RunOutcome {
    pub fn done(result: String, input: u64, output: u64) -> Self {
        Self { state: TaskState::Done, result, error: None, input_tokens: input, output_tokens: output }
    }

    pub fn canceled(partial: String) -> Self {
        Self {
            state: TaskState::Canceled,
            result: partial,
            error: None,
            input_tokens: 0,
            output_tokens: 0,
        }
    }

    pub fn paused(partial: String) -> Self {
        Self {
            state: TaskState::Paused,
            result: partial,
            error: None,
            input_tokens: 0,
            output_tokens: 0,
        }
    }

    pub fn error(code: ErrorCode, detail: String, retryable: bool, partial: String) -> Self {
        Self {
            state: TaskState::Error,
            result: partial,
            error: Some((code, detail, retryable)),
            input_tokens: 0,
            output_tokens: 0,
        }
    }
}
