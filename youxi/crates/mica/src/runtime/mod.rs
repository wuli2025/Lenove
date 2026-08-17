//! 横切基建：paths / 原子写 / 进程登记表 / Job Object 封装 / SQLite 持久化。
//! 只依赖 core。

pub mod atomic;
pub mod db;
pub mod job;
pub mod paths;
pub mod registry;
