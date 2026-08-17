//! MicaBase 核心 crate。
//!
//! 模块依赖方向（check-boundaries 强制，只允许向下）：
//! `server → engine → provider → runtime → core`，`doctor → runtime → core`。

pub mod core;
pub mod doctor;
pub mod engine;
pub mod provider;
pub mod publish;
pub mod runtime;
pub mod update;
#[cfg(feature = "server")]
pub mod server;
