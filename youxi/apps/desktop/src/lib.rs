//! 一句话生成 · 桌面端的业务模块。
//!
//! 拆成 lib 是为了让冒烟入口（`src/bin/smoke.rs`）能不起窗口就跑完整条生成链路——
//! 「十分钟」是本方案的头号风险（规划书 R1），而 R1 的处置里明确写着
//! 「8/17 连跑 20 次统计成功率与耗时分布」。连跑 20 次这件事必须能在命令行做，
//! 靠人手点 20 次 GUI 是统计不出分布的。

pub mod config;
pub mod generate;
pub mod interview;
pub mod llm;
pub mod preview;
