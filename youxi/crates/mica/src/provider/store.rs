//! providers.json 读写（原子写 + 首改备份）+ active/fallback + 故障转移滑窗（PRD 5.2 / 5.5）。

use crate::core::{MicaError, ModelMap, ProviderBinding, Result};
use crate::provider::presets;
use crate::runtime::atomic::atomic_write;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, RwLock};
use std::time::{Duration, Instant};

/// 故障窗口：5 分钟内连续 3 次网络/鉴权类失败 → 切 fallback（PRD 5.5）
const FAILURE_WINDOW: Duration = Duration::from_secs(300);
const FAILURE_THRESHOLD: usize = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthCfg {
    pub field: String,
    pub secret: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderEntry {
    pub id: String,
    pub name: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    pub base_url: String,
    pub auth: AuthCfg,
    pub models: ModelMap,
    #[serde(default)]
    pub preset: Option<String>,
}

fn default_kind() -> String {
    "anthropic_compat".into()
}

impl ProviderEntry {
    pub fn from_preset(id: &str, preset_key: &str, secret: &str) -> Option<Self> {
        let p = presets::find(preset_key)?;
        Some(Self {
            id: id.to_string(),
            name: p.name.to_string(),
            kind: default_kind(),
            base_url: p.base_url.to_string(),
            auth: AuthCfg {
                field: p.auth_field.to_string(),
                secret: secret.to_string(),
            },
            models: ModelMap {
                default: p.models[0].into(),
                opus: p.models[1].into(),
                sonnet: p.models[2].into(),
                haiku: p.models[3].into(),
            },
            preset: Some(preset_key.to_string()),
        })
    }

    pub fn binding(&self) -> ProviderBinding {
        ProviderBinding {
            id: self.id.clone(),
            name: self.name.clone(),
            base_url: self.base_url.clone(),
            auth_field: self.auth.field.clone(),
            secret: self.auth.secret.clone(),
            models: self.models.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProvidersFile {
    #[serde(default)]
    pub active: Option<String>,
    #[serde(default)]
    pub fallback: Option<String>,
    #[serde(default)]
    pub providers: Vec<ProviderEntry>,
}

pub struct ProviderStore {
    path: PathBuf,
    inner: RwLock<ProvidersFile>,
    failures: Mutex<HashMap<String, Vec<Instant>>>,
}

impl ProviderStore {
    pub fn load(path: PathBuf) -> Result<Self> {
        let file = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => ProvidersFile::default(),
            Err(e) => return Err(e.into()),
        };
        Ok(Self {
            path,
            inner: RwLock::new(file),
            failures: Mutex::new(HashMap::new()),
        })
    }

    fn save_locked(&self, file: &ProvidersFile) -> Result<()> {
        atomic_write(&self.path, &serde_json::to_vec_pretty(file)?)?;
        Ok(())
    }

    pub fn snapshot(&self) -> ProvidersFile {
        self.inner.read().unwrap().clone()
    }

    pub fn get(&self, id: &str) -> Option<ProviderEntry> {
        self.inner
            .read()
            .unwrap()
            .providers
            .iter()
            .find(|p| p.id == id)
            .cloned()
    }

    pub fn upsert(&self, entry: ProviderEntry) -> Result<()> {
        let mut file = self.inner.write().unwrap();
        if let Some(slot) = file.providers.iter_mut().find(|p| p.id == entry.id) {
            *slot = entry;
        } else {
            file.providers.push(entry);
        }
        self.save_locked(&file)
    }

    pub fn remove(&self, id: &str) -> Result<()> {
        let mut file = self.inner.write().unwrap();
        file.providers.retain(|p| p.id != id);
        if file.active.as_deref() == Some(id) {
            file.active = None;
        }
        if file.fallback.as_deref() == Some(id) {
            file.fallback = None;
        }
        self.save_locked(&file)
    }

    /// 切换 = 改一条 JSON 记录，下一个 spawn 自动生效（PRD 5.1-1/2）。
    /// 预检（probe）由调用方（server 路由）先行，坏配置进不了生效路径（5.1-4）。
    pub fn set_active(&self, id: &str) -> Result<()> {
        let mut file = self.inner.write().unwrap();
        if !file.providers.iter().any(|p| p.id == id) {
            return Err(MicaError::Provider(format!("unknown provider: {id}")));
        }
        file.active = Some(id.to_string());
        self.save_locked(&file)
    }

    pub fn set_fallback(&self, id: Option<String>) -> Result<()> {
        let mut file = self.inner.write().unwrap();
        file.fallback = id;
        self.save_locked(&file)
    }

    /// 绑定解析（PRD 5.3 三级作用域的前两级）：任务级指定 > 全局 active。
    /// 入队时解析并快照进任务，排队期间切换不影响已入队任务。
    pub fn resolve_binding(&self, task_override: Option<&str>) -> Result<ProviderBinding> {
        let file = self.inner.read().unwrap();
        let id = task_override
            .map(str::to_string)
            .or_else(|| file.active.clone())
            .ok_or_else(|| MicaError::Provider("no active provider configured".into()))?;
        file.providers
            .iter()
            .find(|p| p.id == id)
            .map(|p| p.binding())
            .ok_or_else(|| MicaError::Provider(format!("provider not found: {id}")))
    }

    /// 记录一次网络/鉴权类失败；触发故障转移时返回新 active id（PRD 5.5）。
    /// 恢复后不自动切回（防抖动），由用户确认切回。
    pub fn record_failure(&self, id: &str) -> Option<String> {
        let mut failures = self.failures.lock().unwrap();
        let list = failures.entry(id.to_string()).or_default();
        let now = Instant::now();
        list.retain(|t| now.duration_since(*t) < FAILURE_WINDOW);
        list.push(now);
        if list.len() < FAILURE_THRESHOLD {
            return None;
        }
        list.clear();
        drop(failures);

        let mut file = self.inner.write().unwrap();
        let fallback = file.fallback.clone()?;
        if fallback == id || file.active.as_deref() != Some(id) {
            return None;
        }
        if !file.providers.iter().any(|p| p.id == fallback) {
            return None;
        }
        file.active = Some(fallback.clone());
        let _ = self.save_locked(&file);
        Some(fallback)
    }

    pub fn record_success(&self, id: &str) {
        self.failures.lock().unwrap().remove(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_store() -> ProviderStore {
        let dir = std::env::temp_dir().join(format!(
            "mica-prov-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        ProviderStore::load(dir.join("providers.json")).unwrap()
    }

    #[test]
    fn preset_and_binding_resolution() {
        let store = tmp_store();
        let entry = ProviderEntry::from_preset("prov_zhipu", "zhipu", "sk-test").unwrap();
        store.upsert(entry).unwrap();
        store.set_active("prov_zhipu").unwrap();

        let b = store.resolve_binding(None).unwrap();
        assert_eq!(b.base_url, "https://open.bigmodel.cn/api/anthropic");
        assert_eq!(b.auth_field, "ANTHROPIC_AUTH_TOKEN");
        assert_eq!(b.models.haiku, "glm-4.5-air", "四档模型钉死");

        // 任务级覆盖优先
        let other = ProviderEntry::from_preset("prov_ds", "deepseek", "sk2").unwrap();
        store.upsert(other).unwrap();
        let b = store.resolve_binding(Some("prov_ds")).unwrap();
        assert_eq!(b.id, "prov_ds");

        // 未知 active 拒绝
        assert!(store.set_active("nope").is_err());
    }

    #[test]
    fn failover_after_threshold() {
        let store = tmp_store();
        store
            .upsert(ProviderEntry::from_preset("a", "zhipu", "s").unwrap())
            .unwrap();
        store
            .upsert(ProviderEntry::from_preset("b", "deepseek", "s").unwrap())
            .unwrap();
        store.set_active("a").unwrap();
        store.set_fallback(Some("b".into())).unwrap();

        assert!(store.record_failure("a").is_none());
        assert!(store.record_failure("a").is_none());
        let switched = store.record_failure("a");
        assert_eq!(switched.as_deref(), Some("b"), "3 次失败触发故障转移");
        assert_eq!(store.snapshot().active.as_deref(), Some("b"));

        // 已不是 active 的供应商再失败不再切换
        assert!(store.record_failure("a").is_none());
        assert!(store.record_failure("a").is_none());
        assert!(store.record_failure("a").is_none());
    }
}
