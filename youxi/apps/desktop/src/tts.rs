use crate::config::Config;
use serde_json::Value;
use std::time::Duration;

pub const MODELS: [&str; 2] = ["speech-2.6-hd", "speech-02-hd"];
pub const VOICES: [&str; 7] = [
    "Chinese (Mandarin)_Gentle_Senior",
    "danya_xuejie",
    "Chinese (Mandarin)_Warm_Bestie",
    "Chinese (Mandarin)_Wise_Women",
    "Chinese (Mandarin)_Soft_Girl",
    "female-yujie-jingpin",
    "Chinese (Mandarin)_Sweet_Lady",
];

pub async fn synthesize(
    config: &Config,
    text: &str,
    voice_id: &str,
    emotion: &str,
    model: &str,
) -> Result<Vec<u8>, String> {
    let text = text.trim();
    if text.is_empty() || text.chars().count() > 90 {
        return Err("T2A 文本必须是 1–90 个字".into());
    }
    if !MODELS.contains(&model) {
        return Err("不支持这个 T2A 模型".into());
    }
    if !VOICES.contains(&voice_id) {
        return Err("不支持这个音色".into());
    }
    let (emotion, speed, pitch) = match emotion {
        "warm" => ("happy", 0.90, 0),
        "amused" => ("happy", 1.00, 1),
        "concerned" => ("sad", 0.88, -1),
        "curious" => ("surprised", 0.97, 1),
        "neutral" | "" => ("neutral", 0.93, 0),
        _ => return Err("不支持这个语气".into()),
    };

    let key = config.effective_tts_key();
    if key.is_empty() {
        return Err("还没配语音密钥".into());
    }
    let body = serde_json::json!({
        "model": model,
        "text": text,
        "stream": false,
        "language_boost": "Chinese",
        "voice_setting": {
            "voice_id": voice_id,
            "speed": speed,
            "vol": 1.0,
            "pitch": pitch,
            "emotion": emotion,
        },
        "audio_setting": {
            "sample_rate": 32000,
            "bitrate": 128000,
            "format": "mp3",
            "channel": 1,
        },
    });

    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|e| format!("T2A 客户端启动失败：{e}"))?
        .post(&config.tts_url)
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {key}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("T2A 请求失败：{e}"))?;

    let status = response.status();
    let raw = response
        .text()
        .await
        .map_err(|e| format!("读取 T2A 响应失败：{e}"))?;
    if !status.is_success() {
        return Err(format!(
            "T2A HTTP {status}：{}",
            safe_excerpt(&raw, key, 200)
        ));
    }

    let value: Value = serde_json::from_str(&raw).map_err(|e| format!("T2A 响应不是 JSON：{e}"))?;
    let code = value
        .pointer("/base_resp/status_code")
        .and_then(Value::as_i64)
        .unwrap_or(-1);
    if code != 0 {
        let message = value
            .pointer("/base_resp/status_msg")
            .and_then(Value::as_str)
            .unwrap_or("");
        return Err(format!("T2A {code} {}", safe_excerpt(message, key, 160)));
    }

    let audio = value
        .pointer("/data/audio")
        .and_then(Value::as_str)
        .ok_or("T2A 未返回音频")?;
    let bytes = decode_hex_audio(audio)?;
    validate_mp3(&bytes)?;
    Ok(bytes)
}

pub fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn decode_hex_audio(hex: &str) -> Result<Vec<u8>, String> {
    if hex.len() > 24 * 1024 * 1024 || hex.len() % 2 != 0 {
        return Err("T2A 音频响应尺寸异常".into());
    }
    let raw = hex.as_bytes();
    let mut bytes = Vec::with_capacity(raw.len() / 2);
    for pair in raw.chunks_exact(2) {
        let high = hex_digit(pair[0]).ok_or("T2A 音频不是十六进制")?;
        let low = hex_digit(pair[1]).ok_or("T2A 音频不是十六进制")?;
        bytes.push((high << 4) | low);
    }
    Ok(bytes)
}

fn hex_digit(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

pub fn validate_mp3(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < 4 || bytes.len() > 12 * 1024 * 1024 {
        return Err("T2A MP3 音频尺寸异常".into());
    }
    let id3 = bytes.starts_with(b"ID3");
    let frame = bytes[0] == 0xff && bytes[1] & 0xe0 == 0xe0;
    if !id3 && !frame {
        return Err("T2A 返回内容没有有效 MP3 文件头".into());
    }
    Ok(())
}

fn safe_excerpt(value: &str, secret: &str, limit: usize) -> String {
    let excerpt = value.chars().take(limit).collect::<String>();
    if secret.is_empty() {
        excerpt
    } else {
        excerpt.replace(secret, "[凭据已隐藏]")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_mp3_headers_are_accepted() {
        assert!(validate_mp3(b"ID3\x04\x00\x00\x00").is_ok());
        assert!(validate_mp3(&[0xff, 0xfb, 0x90, 0x64]).is_ok());
        assert!(validate_mp3(b"<html>bad gateway</html>").is_err());
    }

    #[test]
    fn hex_codec_rejects_malformed_audio() {
        assert_eq!(decode_hex_audio("49443304").unwrap(), b"ID3\x04");
        assert!(decode_hex_audio("xyz").is_err());
        assert!(decode_hex_audio("0g").is_err());
    }

    #[test]
    fn remote_errors_cannot_echo_the_key() {
        let out = safe_excerpt("bad key sk-private-value", "sk-private-value", 200);
        assert!(!out.contains("sk-private-value"));
        assert!(out.contains("凭据已隐藏"));
    }
}
