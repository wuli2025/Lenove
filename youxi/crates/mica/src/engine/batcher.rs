//! Delta 事件 30ms 合批（PRD 2.1 继承 polaris 参数）：token 级体验与事件频率的平衡点。

use std::time::Duration;
use tokio::time::Instant;

pub const BATCH_WINDOW: Duration = Duration::from_millis(30);

pub struct DeltaBatcher {
    buf: String,
    window: Duration,
    last_flush: Instant,
}

impl Default for DeltaBatcher {
    fn default() -> Self {
        Self::new(BATCH_WINDOW)
    }
}

impl DeltaBatcher {
    pub fn new(window: Duration) -> Self {
        Self { buf: String::new(), window, last_flush: Instant::now() }
    }

    /// 追加增量；距上次 flush 超过窗口则返回应发送的合批文本
    pub fn push(&mut self, text: &str) -> Option<String> {
        self.buf.push_str(text);
        if self.last_flush.elapsed() >= self.window {
            self.take()
        } else {
            None
        }
    }

    /// 取走当前缓冲（定时 tick / 收尾时调用）
    pub fn take(&mut self) -> Option<String> {
        self.last_flush = Instant::now();
        if self.buf.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.buf))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn batches_within_window() {
        let mut b = DeltaBatcher::default();
        // 初始 last_flush = now，窗口未到 → 缓冲
        assert!(b.push("a").is_none());
        assert!(b.push("b").is_none());
        tokio::time::advance(Duration::from_millis(31)).await;
        // 窗口已过 → 本次 push 触发合批
        assert_eq!(b.push("c").as_deref(), Some("abc"));
        // 缓冲已清
        assert!(b.take().is_none());
        assert!(b.push("d").is_none());
        assert_eq!(b.take().as_deref(), Some("d"), "收尾 take 拿到残留");
    }
}
