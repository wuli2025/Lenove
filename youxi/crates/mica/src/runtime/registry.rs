//! 全局进程登记表（PRD 4.4）：DashMap 分片锁 + pending-cancel 窄窗口补杀 + 退出统一收割。

use crate::core::TaskId;
use crate::runtime::job::JobHandle;
use dashmap::DashMap;
use std::sync::Arc;

pub struct ProcHandle {
    pub pid: u32,
    pub job: Option<JobHandle>,
}

impl ProcHandle {
    pub fn kill(&self) {
        match &self.job {
            Some(job) => job.terminate(),
            // Job Object 创建失败时的 PID 兜底杀（借鉴 polaris procs.rs kill_tree）：
            // 没有这层，job: None 的进程 kill 就是空操作，看门狗形同虚设
            None if self.pid > 0 => kill_tree_by_pid(self.pid),
            None => {}
        }
    }
}

/// PID 级杀树兜底：Windows taskkill /T /F；Unix killpg（spawn 已 setsid，pgid==pid）
fn kill_tree_by_pid(pid: u32) {
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .output();
    }
    #[cfg(unix)]
    unsafe {
        if libc::killpg(pid as i32, libc::SIGKILL) != 0 {
            libc::kill(pid as i32, libc::SIGKILL);
        }
    }
}

#[derive(Default)]
pub struct ProcessRegistry {
    procs: DashMap<TaskId, Arc<ProcHandle>>,
    /// spawn 与登记之间到达的取消请求（PRD 4.4 窄窗口）
    pending_cancel: DashMap<TaskId, ()>,
}

impl ProcessRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// 登记；若此前已有 pending-cancel 标记则立即补杀并返回 false。
    pub fn register(&self, id: &TaskId, handle: ProcHandle) -> bool {
        let handle = Arc::new(handle);
        if self.pending_cancel.remove(id).is_some() {
            handle.kill();
            return false;
        }
        self.procs.insert(id.clone(), handle);
        true
    }

    pub fn remove(&self, id: &TaskId) {
        self.procs.remove(id);
        self.pending_cancel.remove(id);
    }

    /// 杀指定任务进程树；进程未登记时打 pending-cancel 标记（补杀窗口）。
    pub fn kill(&self, id: &TaskId) -> bool {
        if let Some(entry) = self.procs.get(id) {
            entry.kill();
            true
        } else {
            self.pending_cancel.insert(id.clone(), ());
            false
        }
    }

    pub fn pid_of(&self, id: &TaskId) -> Option<u32> {
        self.procs.get(id).map(|h| h.pid)
    }

    pub fn inflight(&self) -> usize {
        self.procs.len()
    }

    /// 退出钩子统一收割（PRD 2.1）
    pub fn kill_all(&self) {
        for entry in self.procs.iter() {
            entry.value().kill();
        }
        self.procs.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_cancel_narrow_window() {
        let reg = ProcessRegistry::new();
        let id: TaskId = "t1".into();
        // 未登记时 kill → 打标记
        assert!(!reg.kill(&id));
        // 随后登记 → 应被补杀（返回 false，不留在表内）
        let ok = reg.register(
            &id,
            ProcHandle {
                pid: 12345,
                job: None,
            },
        );
        assert!(!ok);
        assert_eq!(reg.inflight(), 0);

        // 正常路径：先登记后杀
        let id2: TaskId = "t2".into();
        assert!(reg.register(&id2, ProcHandle { pid: 1, job: None }));
        assert_eq!(reg.inflight(), 1);
        assert!(reg.kill(&id2));
        reg.remove(&id2);
        assert_eq!(reg.inflight(), 0);
    }
}
