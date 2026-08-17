//! 调度器（PRD 4.3 / 4.8）：把无界需求压成有界供给。
//! 并发闸（api/cli 双信号量池）+ 三级优先级队列 + 租户在飞上限 + 背压 429，
//! 每任务 ctrl 通道承接 cancel / pause / resume / patch，终态统一落库发事件。

use crate::core::{
    AgentEvent, ControlOp, EngineId, MicaError, Priority, ProviderBinding, Result, RuntimeResolver,
    TaskId, TaskKind, TaskSpec, TaskState, MAX_PROMPT_BYTES,
};
use crate::engine::bus::EventBus;
use crate::engine::{api, cli, CtrlMsg, RunCtx, RunOutcome};
use crate::provider::ProviderStore;
use crate::runtime::db::Db;
use crate::runtime::registry::ProcessRegistry;
use dashmap::DashMap;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, Notify, Semaphore};

#[derive(Debug, Clone)]
pub struct SchedulerCfg {
    /// CLI 进程池上限（PRD：默认 min(32, 核×4)，真瓶颈是 CLI 进程内存）
    pub cli_slots: usize,
    /// API 任务池（纯 HTTP 连接，上限来自供应商限流）
    pub api_slots: usize,
    /// 排队容量，满载 429（PRD 4.3 背压）
    pub queue_cap: usize,
    /// 单租户在飞上限（PRD 4.3 公平性，默认 4）
    pub tenant_cap: usize,
}

impl Default for SchedulerCfg {
    fn default() -> Self {
        let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        Self { cli_slots: (cores * 4).min(32), api_slots: 512, queue_cap: 1000, tenant_cap: 4 }
    }
}

struct QueuedTask {
    spec: TaskSpec,
    binding: ProviderBinding,
}

#[derive(Default)]
struct QueueState {
    high: VecDeque<QueuedTask>,
    normal: VecDeque<QueuedTask>,
    low: VecDeque<QueuedTask>,
    /// 排队中被 pause 的任务（PRD 4.8：hold，不占槽不参与调度）
    held: HashMap<TaskId, QueuedTask>,
}

impl QueueState {
    fn len(&self) -> usize {
        self.high.len() + self.normal.len() + self.low.len()
    }

    fn deque(&mut self, p: Priority) -> &mut VecDeque<QueuedTask> {
        match p {
            Priority::High => &mut self.high,
            Priority::Normal => &mut self.normal,
            Priority::Low => &mut self.low,
        }
    }

    fn position_of_new(&self, p: Priority) -> u32 {
        (match p {
            Priority::High => self.high.len(),
            Priority::Normal => self.high.len() + self.normal.len(),
            Priority::Low => self.len(),
        }) as u32
    }

    fn take_by_id(&mut self, id: &TaskId) -> Option<QueuedTask> {
        for q in [&mut self.high, &mut self.normal, &mut self.low] {
            if let Some(pos) = q.iter().position(|t| t.spec.id == *id) {
                return q.remove(pos);
            }
        }
        None
    }
}

pub struct Scheduler {
    pub cfg: SchedulerCfg,
    db: Arc<Db>,
    bus: Arc<EventBus>,
    providers: Arc<ProviderStore>,
    registry: Arc<ProcessRegistry>,
    resolver: RuntimeResolver,
    queue: Mutex<QueueState>,
    ctrl: DashMap<TaskId, mpsc::Sender<CtrlMsg>>,
    states: DashMap<TaskId, TaskState>,
    tenant_inflight: DashMap<String, usize>,
    api_sem: Arc<Semaphore>,
    cli_sem: Arc<Semaphore>,
    inflight: AtomicUsize,
    notify: Notify,
}

impl Scheduler {
    pub fn new(
        cfg: SchedulerCfg,
        db: Arc<Db>,
        providers: Arc<ProviderStore>,
        resolver: RuntimeResolver,
    ) -> Arc<Self> {
        let bus = Arc::new(EventBus::new(db.clone()));
        Arc::new(Self {
            api_sem: Arc::new(Semaphore::new(cfg.api_slots)),
            cli_sem: Arc::new(Semaphore::new(cfg.cli_slots)),
            cfg,
            db,
            bus,
            providers,
            registry: Arc::new(ProcessRegistry::new()),
            resolver,
            queue: Mutex::new(QueueState::default()),
            ctrl: DashMap::new(),
            states: DashMap::new(),
            tenant_inflight: DashMap::new(),
            inflight: AtomicUsize::new(0),
            notify: Notify::new(),
        })
    }

    pub fn bus(&self) -> Arc<EventBus> {
        self.bus.clone()
    }

    pub fn registry(&self) -> Arc<ProcessRegistry> {
        self.registry.clone()
    }

    /// 提交任务：路由 → 校验 → 绑定快照 → 落库 → 入队 → Queued 事件（PRD 数据流）。
    /// 返回（队列位次, 路由后引擎）。
    pub fn submit(&self, mut spec: TaskSpec) -> Result<(u32, EngineId)> {
        if let Some(note) = route_engine(&mut spec) {
            tracing::info!(task = %spec.id, engine = ?spec.engine, "{note}");
        }
        let engine = spec.engine;
        if spec.prompt.len() > MAX_PROMPT_BYTES {
            return Err(MicaError::Other(format!("prompt exceeds {MAX_PROMPT_BYTES} bytes")));
        }
        // 绑定在入队时解析并快照（PRD 5.3）；未配置供应商时给「未配置」绑定，
        // CLI 冒烟（mock exe）不需要真实密钥，真实 API 任务会自然报 Auth。
        let binding = self
            .providers
            .resolve_binding(spec.provider_override.as_deref())
            .unwrap_or_else(|_| unconfigured_binding());

        let position = {
            let mut queue = self.queue.lock().unwrap();
            if queue.len() >= self.cfg.queue_cap {
                return Err(MicaError::QueueFull(self.cfg.queue_cap));
            }
            let position = queue.position_of_new(spec.priority);
            self.db.insert_task(&spec, &binding.id)?;
            self.states.insert(spec.id.clone(), TaskState::Queued);
            let id = spec.id.clone();
            queue.deque(spec.priority).push_back(QueuedTask { spec, binding });
            self.bus.emit(&id, AgentEvent::Queued { position });
            position
        };
        self.notify.notify_one();
        Ok((position, engine))
    }

    pub fn state_of(&self, id: &TaskId) -> Option<TaskState> {
        self.states
            .get(id)
            .map(|s| *s)
            .or_else(|| self.db.get_task(id).ok().flatten().map(|row| row.state))
    }

    /// 实时控制（PRD 4.8 指令语义表的实现）
    pub fn control(&self, id: &TaskId, op: ControlOp) -> Result<()> {
        let state = self.state_of(id).ok_or_else(|| MicaError::NotFound(id.clone()))?;
        if state.is_terminal() {
            return Err(MicaError::Terminal(state));
        }
        let outcome = match op {
            ControlOp::Cancel => self.do_cancel(id, state),
            ControlOp::Pause => self.do_pause(id, state),
            ControlOp::Resume => self.do_resume(id, state),
            ControlOp::Patch => Err(MicaError::Other("use patch() with body".into())),
        };
        let ok = outcome.is_ok();
        self.bus.emit(
            id,
            AgentEvent::ControlAck {
                op,
                ok,
                detail: outcome.as_ref().err().map(|e| e.to_string()),
            },
        );
        outcome
    }

    fn do_cancel(&self, id: &TaskId, state: TaskState) -> Result<()> {
        match state {
            TaskState::Queued | TaskState::Held => {
                let taken = {
                    let mut queue = self.queue.lock().unwrap();
                    queue.take_by_id(id).or_else(|| queue.held.remove(id))
                };
                if taken.is_some() {
                    self.finish_detached(id, TaskState::Canceled);
                    Ok(())
                } else {
                    // 竞态：刚被调度器取走 → 按 Running 处理
                    self.signal_running(id, CtrlMsg::Cancel)
                }
            }
            TaskState::Running => self.signal_running(id, CtrlMsg::Cancel),
            TaskState::Paused => {
                self.finish_detached(id, TaskState::Canceled);
                Ok(())
            }
            _ => Err(MicaError::InvalidState(state)),
        }
    }

    fn do_pause(&self, id: &TaskId, state: TaskState) -> Result<()> {
        match state {
            TaskState::Queued => {
                let taken = {
                    let mut queue = self.queue.lock().unwrap();
                    queue.take_by_id(id)
                };
                match taken {
                    Some(task) => {
                        self.set_state(id, TaskState::Held);
                        self.queue.lock().unwrap().held.insert(id.clone(), task);
                        Ok(())
                    }
                    None => self.signal_running(id, CtrlMsg::Pause),
                }
            }
            // 单发生成中：截停留稿（PRD 4.8）
            TaskState::Running => self.signal_running(id, CtrlMsg::Pause),
            TaskState::Held | TaskState::Paused => Ok(()), // 幂等
            _ => Err(MicaError::InvalidState(state)),
        }
    }

    fn do_resume(&self, id: &TaskId, state: TaskState) -> Result<()> {
        match state {
            TaskState::Held => {
                let task = self.queue.lock().unwrap().held.remove(id);
                match task {
                    Some(task) => {
                        self.set_state(id, TaskState::Queued);
                        let mut queue = self.queue.lock().unwrap();
                        let position = queue.position_of_new(task.spec.priority);
                        queue.deque(task.spec.priority).push_back(task);
                        drop(queue);
                        self.bus.emit(id, AgentEvent::Queued { position });
                        self.notify.notify_one();
                        Ok(())
                    }
                    None => Err(MicaError::InvalidState(state)),
                }
            }
            // Paused（截停留稿后）：MVP 整轮重跑——重新入队同一任务（PRD 4.8 表「续写或重跑按任务型」）
            TaskState::Paused => {
                let row = self
                    .db
                    .get_task(id)?
                    .ok_or_else(|| MicaError::NotFound(id.clone()))?;
                let binding = self
                    .providers
                    .resolve_binding(row.spec.provider_override.as_deref())
                    .unwrap_or_else(|_| unconfigured_binding());
                self.set_state(id, TaskState::Queued);
                let mut queue = self.queue.lock().unwrap();
                let position = queue.position_of_new(row.spec.priority);
                queue.deque(row.spec.priority).push_back(QueuedTask { spec: row.spec, binding });
                drop(queue);
                self.bus.emit(id, AgentEvent::Queued { position });
                self.notify.notify_one();
                Ok(())
            }
            _ => Err(MicaError::InvalidState(state)),
        }
    }

    /// PATCH 参数调整（PRD 4.8）：排队/挂起中改快照；在飞 409
    pub fn patch(
        &self,
        id: &TaskId,
        model: Option<String>,
        priority: Option<Priority>,
        provider: Option<String>,
    ) -> Result<()> {
        let state = self.state_of(id).ok_or_else(|| MicaError::NotFound(id.clone()))?;
        if state.is_terminal() {
            return Err(MicaError::Terminal(state));
        }
        let outcome = (|| -> Result<()> {
            let mut queue = self.queue.lock().unwrap();
            let mut task = queue
                .take_by_id(id)
                .or_else(|| queue.held.remove(id))
                .ok_or(MicaError::InvalidState(state))?; // Running：单发生成中不适用
            if let Some(m) = model {
                task.spec.model = Some(m);
            }
            if let Some(p) = priority {
                task.spec.priority = p;
            }
            if let Some(prov) = provider {
                task.binding = self
                    .providers
                    .resolve_binding(Some(&prov))
                    .unwrap_or_else(|_| unconfigured_binding());
                task.spec.provider_override = Some(prov);
            }
            self.db.update_spec(&task.spec)?;
            if state == TaskState::Held {
                queue.held.insert(id.clone(), task);
            } else {
                queue.deque(task.spec.priority).push_back(task);
            }
            Ok(())
        })();
        let ok = outcome.is_ok();
        self.bus.emit(
            id,
            AgentEvent::ControlAck {
                op: ControlOp::Patch,
                ok,
                detail: outcome.as_ref().err().map(|e| e.to_string()),
            },
        );
        outcome
    }

    fn signal_running(&self, id: &TaskId, msg: CtrlMsg) -> Result<()> {
        if let Some(tx) = self.ctrl.get(id) {
            let _ = tx.try_send(msg);
            if msg == CtrlMsg::Cancel {
                // 双保险：Job Object 直接杀树（CLI），api 引擎由 ctrl 消息中断
                self.registry.kill(id);
            }
            Ok(())
        } else {
            Err(MicaError::InvalidState(TaskState::Running))
        }
    }

    fn set_state(&self, id: &TaskId, state: TaskState) {
        self.states.insert(id.clone(), state);
        let _ = self.db.update_state(id, state);
        self.bus.emit(id, AgentEvent::StateChanged { state });
    }

    /// 队列内直接终态（未运行过，无 RunOutcome）
    fn finish_detached(&self, id: &TaskId, state: TaskState) {
        self.set_state(id, state);
    }

    /// 启动派发循环
    pub fn start(self: &Arc<Self>) {
        let sched = self.clone();
        tokio::spawn(async move {
            loop {
                let next = sched.pop_next();
                match next {
                    Some(task) => {
                        let sem = if task.spec.engine.is_cli() {
                            sched.cli_sem.clone()
                        } else {
                            sched.api_sem.clone()
                        };
                        // pop_next 已确认有空位，acquire 立即成功
                        let permit = sem.acquire_owned().await.expect("semaphore closed");
                        let sched2 = sched.clone();
                        tokio::spawn(async move {
                            sched2.run_one(task).await;
                            drop(permit);
                            sched2.notify.notify_one();
                        });
                    }
                    None => sched.notify.notified().await,
                }
            }
        });
    }

    /// 取下一个可跑任务：优先级序 + 池有空位 + 租户未超上限
    fn pop_next(&self) -> Option<QueuedTask> {
        let mut queue = self.queue.lock().unwrap();
        for priority in [Priority::High, Priority::Normal, Priority::Low] {
            let q = queue.deque(priority);
            let mut idx = 0;
            while idx < q.len() {
                let task = &q[idx];
                let pool_ok = if task.spec.engine.is_cli() {
                    self.cli_sem.available_permits() > 0
                } else {
                    self.api_sem.available_permits() > 0
                };
                let tenant_ok = self
                    .tenant_inflight
                    .get(&task.spec.tenant)
                    .map(|n| *n < self.cfg.tenant_cap)
                    .unwrap_or(true);
                if pool_ok && tenant_ok {
                    return q.remove(idx);
                }
                idx += 1;
            }
        }
        None
    }

    async fn run_one(&self, task: QueuedTask) {
        let id = task.spec.id.clone();
        let tenant = task.spec.tenant.clone();
        let engine = task.spec.engine;
        let binding_id = task.binding.id.clone();

        *self.tenant_inflight.entry(tenant.clone()).or_insert(0) += 1;
        self.inflight.fetch_add(1, Ordering::Relaxed);
        self.set_state(&id, TaskState::Running);

        let (ctrl_tx, ctrl_rx) = mpsc::channel(8);
        self.ctrl.insert(id.clone(), ctrl_tx);

        let ctx = RunCtx {
            spec: task.spec,
            binding: task.binding,
            db: self.db.clone(),
            bus: self.bus.clone(),
            registry: self.registry.clone(),
            ctrl: ctrl_rx,
        };

        let started = std::time::Instant::now();
        // panic 兜底：引擎崩了任务也必须报 Error 终态，绝不留在 Running 卡死
        let run = async {
            match engine {
                EngineId::Api => api::run(ctx).await,
                EngineId::Claude | EngineId::Codex => match (self.resolver)(engine) {
                    Ok(resolved) => cli::run(ctx, resolved).await,
                    Err(e) => RunOutcome::error(
                        crate::core::ErrorCode::EngineUnavailable,
                        e.to_string(),
                        false,
                        String::new(),
                    ),
                },
            }
        };
        let outcome = match futures_util::FutureExt::catch_unwind(std::panic::AssertUnwindSafe(run)).await {
            Ok(outcome) => outcome,
            Err(panic) => {
                let msg = panic
                    .downcast_ref::<&str>()
                    .map(|s| s.to_string())
                    .or_else(|| panic.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "unknown panic".into());
                tracing::error!(task = %id, panic = %msg, "engine panicked");
                self.registry.kill(&id);
                self.registry.remove(&id);
                RunOutcome::error(
                    crate::core::ErrorCode::Internal,
                    format!("engine panicked: {msg}"),
                    false,
                    String::new(),
                )
            }
        };

        // —— 终态统一路径：记账 → 落库 → 事件（双引擎一字不差）——
        let duration_ms = started.elapsed().as_millis() as u64;
        let code = outcome.error.as_ref().map(|(c, _, _)| format!("{c:?}")).unwrap_or_else(|| "ok".into());
        let _ = self.db.record_usage(
            &id, engine, &binding_id,
            outcome.input_tokens, outcome.output_tokens, duration_ms, &code,
        );
        if outcome.input_tokens > 0 || outcome.output_tokens > 0 {
            self.bus.emit(&id, AgentEvent::Usage {
                input_tokens: outcome.input_tokens,
                output_tokens: outcome.output_tokens,
            });
        }
        let _ = self.db.set_result(&id, outcome.state, &outcome.result);
        self.states.insert(id.clone(), outcome.state);

        match (&outcome.error, outcome.state) {
            (Some((code, detail, retryable)), _) => {
                // 供应商故障窗口（PRD 5.5）：网络/鉴权类失败计入，触发则切 fallback
                if api::counts_toward_failover(*code) {
                    if let Some(switched) = self.providers.record_failure(&binding_id) {
                        tracing::warn!(from = %binding_id, to = %switched, "provider failover triggered");
                    }
                }
                self.bus.emit(&id, AgentEvent::Error {
                    code: *code,
                    detail: detail.clone(),
                    retryable: *retryable,
                });
            }
            (None, TaskState::Done) => {
                self.providers.record_success(&binding_id);
                self.bus.emit(&id, AgentEvent::Done { result: outcome.result.clone() });
            }
            _ => {}
        }
        self.bus.emit(&id, AgentEvent::StateChanged { state: outcome.state });

        self.ctrl.remove(&id);
        if let Some(mut n) = self.tenant_inflight.get_mut(&tenant) {
            *n = n.saturating_sub(1);
        }
        self.inflight.fetch_sub(1, Ordering::Relaxed);
        // Paused 任务保留通道以便回放；终态延迟由订阅端读 db，直接关闭广播
        if outcome.state.is_terminal() {
            self.bus.close(&id);
        }
    }

    /// /metrics 快照（PRD 7.2）
    pub fn metrics(&self) -> String {
        let queue = self.queue.lock().unwrap();
        format!(
            "mica_queue_depth{{priority=\"high\"}} {}\n\
             mica_queue_depth{{priority=\"normal\"}} {}\n\
             mica_queue_depth{{priority=\"low\"}} {}\n\
             mica_held_tasks {}\n\
             mica_inflight_total {}\n\
             mica_cli_slots_free {}\n\
             mica_api_slots_free {}\n",
            queue.high.len(),
            queue.normal.len(),
            queue.low.len(),
            queue.held.len(),
            self.inflight.load(Ordering::Relaxed),
            self.cli_sem.available_permits(),
            self.api_sem.available_permits(),
        )
    }
}

/// 引擎分流（PRD 4.2 分流原则，强制版）：
/// **长文本任务永不落 codex**（codex 主战场是生图与工具循环）；生图任务必须走 codex。
/// claude 引擎保持按需可用（Text/Tool 均可显式指定）。
fn route_engine(spec: &mut TaskSpec) -> Option<&'static str> {
    match (spec.engine, spec.kind) {
        (EngineId::Codex, TaskKind::Text) => {
            spec.engine = EngineId::Api;
            Some("text task rerouted codex→api (codex is for image/tool tasks)")
        }
        (EngineId::Api | EngineId::Claude, TaskKind::Image) => {
            spec.engine = EngineId::Codex;
            Some("image task rerouted →codex (built-in GPT-image channel)")
        }
        _ => None,
    }
}

/// 未配置供应商时的兜底绑定（CLI 冒烟可用；真实 API 任务自然报 Auth）
fn unconfigured_binding() -> ProviderBinding {
    ProviderBinding {
        id: "unconfigured".into(),
        name: "未配置".into(),
        base_url: "https://api.anthropic.com".into(),
        auth_field: "ANTHROPIC_API_KEY".into(),
        secret: String::new(),
        models: crate::core::ModelMap {
            default: "claude-sonnet-5".into(),
            opus: String::new(),
            sonnet: String::new(),
            haiku: String::new(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{new_task_id, TaskLimits};

    fn test_sched(cfg: SchedulerCfg) -> Arc<Scheduler> {
        let db = Arc::new(Db::open_in_memory().unwrap());
        let dir = std::env::temp_dir()
            .join(format!("mica-sched-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&dir);
        let providers = Arc::new(ProviderStore::load(dir.join("providers.json")).unwrap());
        let resolver: RuntimeResolver =
            Arc::new(|_| Err(MicaError::Other("no runtime in tests".into())));
        Scheduler::new(cfg, db, providers, resolver)
    }

    fn spec(engine: EngineId, priority: Priority) -> TaskSpec {
        TaskSpec {
            id: new_task_id(),
            tenant: "t".into(),
            engine,
            prompt: "hi".into(),
            system_prompt: None,
            cwd: None,
            model: None,
            kind: TaskKind::default(),
            priority,
            limits: TaskLimits::default(),
            provider_override: None,
            cancel_on_disconnect: false,
            session_id: None,
            resume: None,
        }
    }

    #[tokio::test]
    async fn priority_pop_order_and_positions() {
        let sched = test_sched(SchedulerCfg::default());
        let low = spec(EngineId::Api, Priority::Low);
        let normal = spec(EngineId::Api, Priority::Normal);
        let high = spec(EngineId::Api, Priority::High);
        assert_eq!(sched.submit(low.clone()).unwrap().0, 0);
        assert_eq!(sched.submit(normal.clone()).unwrap().0, 0, "normal 排在 low 前");
        assert_eq!(sched.submit(high.clone()).unwrap().0, 0, "high 排最前");

        assert_eq!(sched.pop_next().unwrap().spec.id, high.id);
        assert_eq!(sched.pop_next().unwrap().spec.id, normal.id);
        assert_eq!(sched.pop_next().unwrap().spec.id, low.id);
        assert!(sched.pop_next().is_none());
    }

    #[tokio::test]
    async fn queue_full_backpressure() {
        let cfg = SchedulerCfg { queue_cap: 2, ..Default::default() };
        let sched = test_sched(cfg);
        sched.submit(spec(EngineId::Api, Priority::Normal)).unwrap();
        sched.submit(spec(EngineId::Api, Priority::Normal)).unwrap();
        let err = sched.submit(spec(EngineId::Api, Priority::Normal)).unwrap_err();
        assert!(matches!(err, MicaError::QueueFull(2)), "队列满必须 QueueFull 而非静默丢");
    }

    #[tokio::test]
    async fn queued_cancel_pause_resume_patch() {
        let sched = test_sched(SchedulerCfg::default());
        let s = spec(EngineId::Api, Priority::Normal);
        let id = s.id.clone();
        sched.submit(s).unwrap();

        // pause → held
        sched.control(&id, ControlOp::Pause).unwrap();
        assert_eq!(sched.state_of(&id), Some(TaskState::Held));
        assert!(sched.pop_next().is_none(), "held 不参与调度");

        // patch held 任务
        sched.patch(&id, Some("m2".into()), Some(Priority::High), None).unwrap();

        // resume → queued，且带上 patch 后的优先级
        sched.control(&id, ControlOp::Resume).unwrap();
        assert_eq!(sched.state_of(&id), Some(TaskState::Queued));
        let popped = sched.pop_next().unwrap();
        assert_eq!(popped.spec.model.as_deref(), Some("m2"));
        assert_eq!(popped.spec.priority, Priority::High);

        // 重新放回再取消
        sched.queue.lock().unwrap().deque(Priority::High).push_back(popped);
        sched.control(&id, ControlOp::Cancel).unwrap();
        assert_eq!(sched.state_of(&id), Some(TaskState::Canceled));

        // 终态后的控制指令 → Terminal 错误（HTTP 410）
        let err = sched.control(&id, ControlOp::Cancel).unwrap_err();
        assert!(matches!(err, MicaError::Terminal(TaskState::Canceled)));
    }

    #[tokio::test]
    async fn tenant_cap_respected() {
        let cfg = SchedulerCfg { tenant_cap: 1, ..Default::default() };
        let sched = test_sched(cfg);
        sched.tenant_inflight.insert("t".into(), 1);
        sched.submit(spec(EngineId::Api, Priority::Normal)).unwrap();
        assert!(sched.pop_next().is_none(), "租户已达在飞上限，不出队");
    }

    #[tokio::test]
    async fn engine_routing_policy() {
        let sched = test_sched(SchedulerCfg::default());

        // 长文本任务指定 codex → 强制改路 api（codex 只应付生图/工具）
        let mut text_on_codex = spec(EngineId::Codex, Priority::Normal);
        text_on_codex.kind = TaskKind::Text;
        let (_, engine) = sched.submit(text_on_codex).unwrap();
        assert_eq!(engine, EngineId::Api, "codex 上的 text 任务必须改路 api");

        // 生图任务指定 api → 强制改路 codex（生图须 CLI 通道）
        let mut image_on_api = spec(EngineId::Api, Priority::Normal);
        image_on_api.kind = TaskKind::Image;
        let (_, engine) = sched.submit(image_on_api).unwrap();
        assert_eq!(engine, EngineId::Codex, "image 任务必须走 codex");

        // 工具任务留在 codex，不改路
        let mut tool_on_codex = spec(EngineId::Codex, Priority::Normal);
        tool_on_codex.kind = TaskKind::Tool;
        let (_, engine) = sched.submit(tool_on_codex).unwrap();
        assert_eq!(engine, EngineId::Codex);

        // 默认 text 任务走 api，不受影响
        let (_, engine) = sched.submit(spec(EngineId::Api, Priority::Normal)).unwrap();
        assert_eq!(engine, EngineId::Api);
    }

    #[tokio::test]
    async fn prompt_size_rejected() {
        let sched = test_sched(SchedulerCfg::default());
        let mut s = spec(EngineId::Api, Priority::Normal);
        s.prompt = "x".repeat(MAX_PROMPT_BYTES + 1);
        assert!(sched.submit(s).is_err());
    }
}
