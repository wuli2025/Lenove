//! 供应商中心（PRD 第 5 章）：预设表 / providers.json / 绑定构造 / 连通性探测 / 故障转移。
//! 纲领：供应商是「传给每次 spawn 的一份不可变绑定」，不是「改到环境里的全局状态」。

pub mod binding;
pub mod presets;
pub mod probe;
pub mod store;

pub use store::{ProviderEntry, ProviderStore};
