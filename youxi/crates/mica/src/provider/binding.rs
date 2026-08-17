//! per-spawn 绑定注入（PRD 5.3）：先清空受管键（防宿主环境渗透），再注入本次绑定完整键集。
//! 基座自身进程 env 永不改动。

use crate::core::{EnvMap, ProviderBinding, MANAGED_ENV_KEYS};

/// 绑定 → 子进程环境键集（CLI 引擎用）
pub fn binding_env(binding: &ProviderBinding) -> EnvMap {
    let mut env = EnvMap::new();
    env.insert("ANTHROPIC_BASE_URL".into(), binding.base_url.clone());
    env.insert(binding.auth_field.clone(), binding.secret.clone());
    env.insert("ANTHROPIC_MODEL".into(), binding.models.default.clone());
    if !binding.models.opus.is_empty() {
        env.insert("ANTHROPIC_DEFAULT_OPUS_MODEL".into(), binding.models.opus.clone());
    }
    if !binding.models.sonnet.is_empty() {
        env.insert("ANTHROPIC_DEFAULT_SONNET_MODEL".into(), binding.models.sonnet.clone());
    }
    if !binding.models.haiku.is_empty() {
        env.insert("ANTHROPIC_DEFAULT_HAIKU_MODEL".into(), binding.models.haiku.clone());
        // CLI 后台小任务（标题生成等）走 small/fast 档，同样钉死
        env.insert("ANTHROPIC_SMALL_FAST_MODEL".into(), binding.models.haiku.clone());
    }
    env
}

/// env_clear_managed + envs(binding)（PRD 5.3 伪码的实现）
pub fn apply_managed_env(cmd: &mut tokio::process::Command, env: &EnvMap) {
    for key in MANAGED_ENV_KEYS {
        cmd.env_remove(key);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::ModelMap;

    fn binding() -> ProviderBinding {
        ProviderBinding {
            id: "prov_zhipu".into(),
            name: "智谱".into(),
            base_url: "https://open.bigmodel.cn/api/anthropic".into(),
            auth_field: "ANTHROPIC_AUTH_TOKEN".into(),
            secret: "sk-xyz".into(),
            models: ModelMap {
                default: "glm-4.7".into(),
                opus: "glm-4.7".into(),
                sonnet: "glm-4.7".into(),
                haiku: "glm-4.5-air".into(),
            },
        }
    }

    #[test]
    fn env_contains_pinned_models_and_auth() {
        let env = binding_env(&binding());
        assert_eq!(env.get("ANTHROPIC_BASE_URL").unwrap(), "https://open.bigmodel.cn/api/anthropic");
        assert_eq!(env.get("ANTHROPIC_AUTH_TOKEN").unwrap(), "sk-xyz");
        assert!(!env.contains_key("ANTHROPIC_API_KEY"), "只注入本绑定的鉴权字段");
        assert_eq!(env.get("ANTHROPIC_MODEL").unwrap(), "glm-4.7");
        assert_eq!(env.get("ANTHROPIC_DEFAULT_HAIKU_MODEL").unwrap(), "glm-4.5-air");
        assert_eq!(env.get("ANTHROPIC_SMALL_FAST_MODEL").unwrap(), "glm-4.5-air");
    }

    #[test]
    fn every_injected_key_is_managed_or_auth_field() {
        // 受管键清单必须覆盖全部注入键——否则宿主渗透防线有洞
        let env = binding_env(&binding());
        for key in env.keys() {
            assert!(
                MANAGED_ENV_KEYS.contains(&key.as_str()),
                "注入键 {key} 不在受管清单，清空逻辑会漏掉它"
            );
        }
    }
}
