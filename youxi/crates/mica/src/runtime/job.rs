//! 杀树封装（PRD 4.4）：Windows Job Object（KILL_ON_JOB_CLOSE + 内存封顶 + 原子整树终止）；
//! Unix 用 process group + killpg。

use std::io;

/// 每任务进程树内存封顶，默认 2GB（PRD 4.4 / 9.1）
pub const DEFAULT_JOB_MEMORY_LIMIT: u64 = 2 * 1024 * 1024 * 1024;

#[cfg(windows)]
mod win {
    use super::*;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// Job Object 句柄。Drop 时 CloseHandle —— 因 KILL_ON_JOB_CLOSE，
    /// 基座退出（含 panic 展开）时残余进程树被 OS 自动收割。
    pub struct JobHandle(isize);

    // HANDLE 是内核对象句柄，跨线程使用安全
    unsafe impl Send for JobHandle {}
    unsafe impl Sync for JobHandle {}

    impl JobHandle {
        pub fn create(memory_limit: u64) -> io::Result<Self> {
            unsafe {
                let job: HANDLE = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags =
                    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_JOB_MEMORY;
                info.JobMemoryLimit = memory_limit as usize;
                let ok = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    CloseHandle(job);
                    return Err(io::Error::last_os_error());
                }
                Ok(Self(job as isize))
            }
        }

        /// spawn 后立刻调用：子进程与其全部子孙自动入 Job
        pub fn assign(&self, child: &tokio::process::Child) -> io::Result<()> {
            let raw = child
                .raw_handle()
                .ok_or_else(|| io::Error::other("child already reaped"))?;
            let ok = unsafe { AssignProcessToJobObject(self.0 as HANDLE, raw as HANDLE) };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        /// 取消 = 一击整树，毫秒级、原子、无残留
        pub fn terminate(&self) {
            unsafe {
                TerminateJobObject(self.0 as HANDLE, 1);
            }
        }
    }

    impl Drop for JobHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0 as HANDLE);
            }
        }
    }
}

#[cfg(windows)]
pub use win::JobHandle;

#[cfg(unix)]
mod nix {
    use super::*;
    use std::sync::atomic::{AtomicI32, Ordering};

    /// Unix 侧以 process group 承担同等职责（spawn 时 pre_exec setsid）
    pub struct JobHandle {
        pgid: AtomicI32,
    }

    impl JobHandle {
        pub fn create(_memory_limit: u64) -> io::Result<Self> {
            Ok(Self {
                pgid: AtomicI32::new(0),
            })
        }

        pub fn assign(&self, child: &tokio::process::Child) -> io::Result<()> {
            // pre_exec 已 setsid，pgid == 子进程 pid
            let pid = child.id().ok_or_else(|| io::Error::other("no pid"))?;
            self.pgid.store(pid as i32, Ordering::SeqCst);
            Ok(())
        }

        /// PRD 4.4：SIGTERM → SIGKILL；MVP 直接 SIGKILL 保证零残留
        pub fn terminate(&self) {
            let pgid = self.pgid.load(Ordering::SeqCst);
            if pgid > 0 {
                unsafe {
                    libc::killpg(pgid, libc::SIGKILL);
                }
            }
        }
    }
}

#[cfg(unix)]
pub use nix::JobHandle;
