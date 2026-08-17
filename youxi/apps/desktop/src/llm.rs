//! Anthropic Messages 兼容端点的最小客户端。
//!
//! 只做一件事：发一轮、拿文本、报用量。流式留给前端的 TTS 去做——
//! 生成引擎本来就是按阶段吐产物的，阶段本身就是进度，不需要 token 级流式。
//!
//! 认证头同时带 `x-api-key` 与 `Authorization: Bearer`：
//! 各家兼容网关认的字段不一样（MiniMax 认 Bearer，Anthropic 官方认 x-api-key），
//! 两个都带能一套代码打通预设表里的全部供应商。这是本地进程直连，
//! 不存在浏览器 CORS 预检白名单那道限制。

use serde::Deserialize;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct Msg {
    pub role: &'static str,
    pub content: String,
}

impl Msg {
    pub fn user(c: impl Into<String>) -> Self {
        Self { role: "user", content: c.into() }
    }
    pub fn assistant(c: impl Into<String>) -> Self {
        Self { role: "assistant", content: c.into() }
    }
}

#[derive(Debug, Clone, Default)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

impl Usage {
    pub fn total(&self) -> u64 {
        self.input_tokens + self.output_tokens
    }
}

#[derive(Debug)]
pub struct Completion {
    pub text: String,
    pub usage: Usage,
    /// 网关回的 stop_reason 原文（有些兼容网关不回，那就是空）
    pub stop_reason: String,
}

impl Completion {
    /// 这一段是不是被 max_tokens 砍断的。
    /// 空 stop_reason 一律按“没截断”处理——不回这个字段的网关很多，
    /// 宁可漏报也不能把正常产物误判成残次品。
    pub fn truncated(&self) -> bool {
        self.stop_reason == "max_tokens"
    }
}

#[derive(Deserialize)]
struct RespBlock {
    /// 推理模型（如 Kimi k3）会先吐 `thinking` 块再吐 `text` 块，
    /// 必须按 type 挑，不能见 text 字段就拼——思维链混进产物是灾难。
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    text: String,
}

#[derive(Deserialize)]
struct RespUsage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
}

#[derive(Deserialize)]
struct Resp {
    #[serde(default)]
    content: Vec<RespBlock>,
    #[serde(default)]
    usage: Option<RespUsage>,
    /// `end_turn` = 模型自己说完了；`max_tokens` = **被我们的上限砍断了**。
    /// 不读这个字段的代价是实打实的：正文可能在半句话中间断掉、
    /// CSS 可能停在 `list-style` 后面没有值，而流水线全程以为一切正常，
    /// 最后报「成功、未降级」交付一个残页。截断必须能被上层看见。
    #[serde(default)]
    stop_reason: Option<String>,
}

pub struct Llm {
    http: reqwest::Client,
    url: String,
    key: String,
    model: String,
}

impl Llm {
    pub fn new(url: &str, key: &str, model: &str) -> Self {
        Self {
            // 单次生成阶段可能吐几千 token，给足超时；
            // 现场宁可等一会儿也不要半路掐断留个半截页面。
            // 180s 不够用：k3 慢的时候内容区（max_tokens 11000）实测要 180s+，
            // 恰好撞在总超时上被掐成 transport error（2026-08-15 两次复现，误差 <0.5s）。
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(420))
                .build()
                .unwrap_or_default(),
            url: url.to_string(),
            key: key.to_string(),
            model: model.to_string(),
        }
    }

    pub async fn complete(
        &self,
        system: &str,
        messages: &[Msg],
        max_tokens: u32,
    ) -> Result<Completion, String> {
        let msgs: Vec<serde_json::Value> = messages
            .iter()
            .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
            .collect();

        let body = serde_json::json!({
            "model": self.model,
            "max_tokens": max_tokens,
            "system": system,
            "messages": msgs,
        });

        let r = self
            .http
            .post(&self.url)
            .header("content-type", "application/json")
            .header("anthropic-version", "2023-06-01")
            .header("x-api-key", &self.key)
            .header("authorization", format!("Bearer {}", self.key))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("模型请求失败：{e}"))?;

        let status = r.status();
        let raw = r.text().await.map_err(|e| format!("读取模型响应失败：{e}"))?;
        if !status.is_success() {
            // 把网关原文带出来——现场排查全靠这段，截断到 300 字够定位又不刷屏
            return Err(format!("模型返回 {status}：{}", raw.chars().take(300).collect::<String>()));
        }

        let parsed: Resp =
            serde_json::from_str(&raw).map_err(|e| format!("模型响应不是预期 JSON：{e}"))?;
        // 只取 text 块。有些网关不回 type 字段，那就按"有 text 就算数"兜底。
        let text = parsed
            .content
            .iter()
            .filter(|b| b.kind == "text" || (b.kind.is_empty() && !b.text.is_empty()))
            .map(|b| b.text.as_str())
            .collect::<String>();
        let usage = parsed
            .usage
            .map(|u| Usage { input_tokens: u.input_tokens, output_tokens: u.output_tokens })
            .unwrap_or_default();

        Ok(Completion { text, usage, stop_reason: parsed.stop_reason.unwrap_or_default() })
    }
}

/// 从模型输出里抠出第一个 JSON 对象。
///
/// 模型经常在 JSON 前后带一句寒暄或包一层 ```json 围栏，
/// 直接 `serde_json::from_str` 会碎。按括号配对扫描，还要跳过字符串字面量里的括号
/// ——正文里出现 `{` `}` 是常事（比如 CSS 片段）。
pub fn extract_json(s: &str) -> Option<&str> {
    let b = s.as_bytes();
    let start = b.iter().position(|&c| c == b'{')?;
    let mut depth = 0i32;
    let mut in_str = false;
    let mut escaped = false;
    for i in start..b.len() {
        let c = b[i];
        if in_str {
            if escaped {
                escaped = false;
            } else if c == b'\\' {
                escaped = true;
            } else if c == b'"' {
                in_str = false;
            }
            continue;
        }
        match c {
            b'"' => in_str = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&s[start..=i]);
                }
            }
            _ => {}
        }
    }
    None
}

/// 从模型输出里抠出指定语言的围栏代码块；没有围栏就退回整段去空白。
pub fn extract_block<'a>(s: &'a str, lang: &str) -> &'a str {
    let fence = format!("```{lang}");
    if let Some(i) = s.find(&fence) {
        let rest = &s[i + fence.len()..];
        let rest = rest.strip_prefix('\n').unwrap_or(rest);
        if let Some(j) = rest.find("```") {
            return rest[..j].trim();
        }
        return rest.trim();
    }
    // 没标语言的裸围栏
    if let Some(i) = s.find("```") {
        let rest = &s[i + 3..];
        let rest = rest.split_once('\n').map(|(_, r)| r).unwrap_or(rest);
        if let Some(j) = rest.find("```") {
            return rest[..j].trim();
        }
    }
    s.trim()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_extraction_survives_chatter() {
        assert_eq!(extract_json(r#"好的：{"a":1} 就这样"#), Some(r#"{"a":1}"#));
        assert_eq!(extract_json("```json\n{\"a\":1}\n```"), Some("{\"a\":1}"));
        assert_eq!(extract_json("没有对象"), None);
    }

    #[test]
    fn json_extraction_handles_braces_inside_strings() {
        // 这是真会踩的：需求单里带 CSS 片段，字符串里的 } 会让朴素配对提前收口
        let s = r#"{"css":"body{margin:0}","ready":true}"#;
        assert_eq!(extract_json(&format!("前言 {s} 后记")), Some(s));
    }

    #[test]
    fn json_extraction_handles_escaped_quotes() {
        let s = r#"{"t":"他说\"好\"","n":2}"#;
        assert_eq!(extract_json(s), Some(s));
    }

    #[test]
    fn json_extraction_handles_nesting() {
        let s = r#"{"a":{"b":{"c":1}},"d":2}"#;
        assert_eq!(extract_json(s), Some(s));
    }

    #[test]
    fn block_extraction() {
        assert_eq!(extract_block("前言\n```html\n<p>x</p>\n```\n后记", "html"), "<p>x</p>");
        // 要的语言没有，但有裸围栏
        assert_eq!(extract_block("```\n<p>y</p>\n```", "html"), "<p>y</p>");
        // 完全没围栏就用整段
        assert_eq!(extract_block("  <p>z</p>  ", "html"), "<p>z</p>");
    }

    #[derive(serde::Deserialize)]
    struct T {
        #[serde(default)]
        content: Vec<RespBlock>,
    }
    fn join(json: &str) -> String {
        let t: T = serde_json::from_str(json).unwrap();
        t.content
            .iter()
            .filter(|b| b.kind == "text" || (b.kind.is_empty() && !b.text.is_empty()))
            .map(|b| b.text.as_str())
            .collect()
    }

    #[test]
    fn thinking_blocks_are_dropped() {
        // Kimi k3 这类推理模型的真实形状：先 thinking 再 text。
        // 思维链混进产物 HTML 是灾难，必须按 type 挑。
        let s = r#"{"content":[
            {"type":"thinking","thinking":"用户想要四个字…","signature":"x"},
            {"type":"text","text":"链路正常"}]}"#;
        assert_eq!(join(s), "链路正常");
    }

    #[test]
    fn multiple_text_blocks_concatenate() {
        let s = r#"{"content":[{"type":"text","text":"前"},{"type":"text","text":"后"}]}"#;
        assert_eq!(join(s), "前后");
    }

    #[test]
    fn gateways_without_type_field_still_work() {
        // 不是所有兼容网关都回 type，别把它们的正文丢了
        let s = r#"{"content":[{"text":"没有 type 字段"}]}"#;
        assert_eq!(join(s), "没有 type 字段");
    }

    #[test]
    fn usage_totals() {
        let u = Usage { input_tokens: 1200, output_tokens: 800 };
        assert_eq!(u.total(), 2000);
    }

    fn comp(reason: &str) -> Completion {
        Completion { text: String::new(), usage: Usage::default(), stop_reason: reason.into() }
    }

    #[test]
    fn truncation_is_detected() {
        // 这条是防回归：真实压测里 content 阶段撞了 max_tokens，
        // 正文停在半句话中间、5 个标签没闭合，而整条链路报「成功、未降级」。
        assert!(comp("max_tokens").truncated());
        assert!(!comp("end_turn").truncated());
        assert!(!comp("stop_sequence").truncated());
    }

    #[test]
    fn missing_stop_reason_is_not_truncated() {
        // 不回 stop_reason 的兼容网关不少，漏报好过把好产物误杀
        assert!(!comp("").truncated());
    }

    #[test]
    fn stop_reason_parsed_from_wire() {
        #[derive(serde::Deserialize)]
        struct W {
            #[serde(default)]
            stop_reason: Option<String>,
        }
        let w: W = serde_json::from_str(r#"{"content":[],"stop_reason":"max_tokens"}"#).unwrap();
        assert_eq!(w.stop_reason.as_deref(), Some("max_tokens"));
        let w2: W = serde_json::from_str(r#"{"content":[]}"#).unwrap();
        assert_eq!(w2.stop_reason, None);
    }
}
