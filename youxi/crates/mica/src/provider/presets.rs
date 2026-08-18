//! 内置供应商预设表（PRD 5.2）：编译期内联，运行期可增自定义。
//! 选预设只需填 key；四档模型全部钉死（防 CLI 回落官方默认名被网关拒）。

pub struct Preset {
    pub key: &'static str,
    pub name: &'static str,
    pub base_url: &'static str,
    /// ANTHROPIC_AUTH_TOKEN（Bearer 网关）或 ANTHROPIC_API_KEY
    pub auth_field: &'static str,
    /// [default, opus, sonnet, haiku]
    pub models: [&'static str; 4],
}

pub const PRESETS: &[Preset] = &[
    Preset {
        key: "official",
        name: "Anthropic 官方",
        base_url: "https://api.anthropic.com",
        auth_field: "ANTHROPIC_API_KEY",
        models: [
            "claude-sonnet-5",
            "claude-opus-4-8",
            "claude-sonnet-5",
            "claude-haiku-4-5-20251001",
        ],
    },
    Preset {
        key: "zhipu",
        name: "智谱 GLM",
        base_url: "https://open.bigmodel.cn/api/anthropic",
        auth_field: "ANTHROPIC_AUTH_TOKEN",
        models: ["glm-4.7", "glm-4.7", "glm-4.7", "glm-4.5-air"],
    },
    Preset {
        key: "deepseek",
        name: "DeepSeek",
        base_url: "https://api.deepseek.com/anthropic",
        auth_field: "ANTHROPIC_AUTH_TOKEN",
        models: [
            "deepseek-chat",
            "deepseek-reasoner",
            "deepseek-chat",
            "deepseek-chat",
        ],
    },
    Preset {
        key: "kimi",
        name: "Kimi (Moonshot)",
        base_url: "https://api.moonshot.cn/anthropic",
        auth_field: "ANTHROPIC_AUTH_TOKEN",
        models: [
            "kimi-k2-turbo-preview",
            "kimi-k2-turbo-preview",
            "kimi-k2-turbo-preview",
            "kimi-k2-turbo-preview",
        ],
    },
    Preset {
        key: "minimax",
        name: "MiniMax",
        base_url: "https://api.minimaxi.com/anthropic",
        auth_field: "ANTHROPIC_AUTH_TOKEN",
        models: ["MiniMax-M3", "MiniMax-M3", "MiniMax-M3", "MiniMax-M3"],
    },
    Preset {
        key: "siliconflow",
        name: "硅基流动",
        base_url: "https://api.siliconflow.cn/anthropic",
        auth_field: "ANTHROPIC_AUTH_TOKEN",
        models: [
            "deepseek-ai/DeepSeek-V3.2",
            "deepseek-ai/DeepSeek-V3.2",
            "deepseek-ai/DeepSeek-V3.2",
            "Qwen/Qwen3-8B",
        ],
    },
    Preset {
        key: "openrouter",
        name: "OpenRouter",
        base_url: "https://openrouter.ai/api",
        auth_field: "ANTHROPIC_AUTH_TOKEN",
        models: [
            "anthropic/claude-sonnet-4.5",
            "anthropic/claude-opus-4.1",
            "anthropic/claude-sonnet-4.5",
            "anthropic/claude-3.5-haiku",
        ],
    },
];

pub fn find(key: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.key == key)
}
