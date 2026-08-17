//! 冒烟用 mock CLI：模仿 `claude --print --output-format stream-json` 的行为——
//! 读完 stdin 的 prompt，按 50ms 间隔回放 stream-json 行。
//! MOCK_HANG=1 时读完 prompt 后静默挂起（测看门狗）；MOCK_FAIL=1 时非零退出（测错误路径）。
//! CI 冒烟以录制回放替代真 CLI（PRD 8.2），发版前再跑真 CLI。

use std::io::{Read, Write};
use std::time::Duration;

fn emit(value: serde_json::Value) {
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{value}");
    let _ = stdout.flush();
}

fn main() {
    // 模仿真 CLI：接受并忽略全部 flags（--print 等）
    let mut prompt = String::new();
    let _ = std::io::stdin().read_to_string(&mut prompt);
    let prompt_head: String = prompt.chars().take(20).collect();

    if std::env::var("MOCK_FAIL").is_ok() {
        eprintln!("mock-claude: simulated failure");
        std::process::exit(3);
    }

    emit(serde_json::json!({"type": "system", "subtype": "init", "model": "mock-model"}));

    // 挂起模式：MOCK_HANG=1 全局生效，或 prompt 含 MOCK_HANG（单任务级，冒烟取消用）
    if std::env::var("MOCK_HANG").is_ok() || prompt.contains("MOCK_HANG") {
        loop {
            std::thread::sleep(Duration::from_secs(60));
        }
    }

    let chunks = ["你好，", "这是 mock 回复：", &format!("收到「{prompt_head}」，"), "分段流式输出，", "完毕。"];
    let mut full = String::new();
    for chunk in chunks {
        full.push_str(chunk);
        emit(serde_json::json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": chunk}
            }
        }));
        std::thread::sleep(Duration::from_millis(50));
    }

    emit(serde_json::json!({
        "type": "result",
        "subtype": "success",
        "result": full,
        "usage": {"input_tokens": 7, "output_tokens": 21}
    }));
}
