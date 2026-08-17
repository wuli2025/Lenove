//! 本地预览：127.0.0.1 静态服务。
//!
//! 规划书第 01 节点名要求走本地端口而不是 `file://`——
//! `file://` 的跨域限制会让部分脚本、字体、fetch 静默失效，
//! 导致「本地好好的、传上去就坏」。走 HTTP 则路由、fetch、
//! 相对路径都和线上一致，本地看到什么线上就是什么。
//!
//! 不引 axum：桌面壳里 tauri 与 axum 互不渗透（apps/desktop/README.md 约定），
//! 这里手写一个只读、只服务单目录的最小 HTTP/1.1 静态服务，够用且零新依赖。

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// 已启动的预览服务句柄
#[derive(Debug, Clone)]
pub struct Preview {
    pub port: u16,
}

impl Preview {
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/", self.port)
    }
}

/// 绑定 127.0.0.1 上的随机空闲端口并在后台开始服务 `root` 目录。
///
/// 只绑回环地址：产物在生成过程中是半成品，没有任何理由让同网段的人看到。
pub async fn serve(root: PathBuf) -> std::io::Result<Preview> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let root = Arc::new(root);
    let handle_root = root.clone();

    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else { continue };
            let root = handle_root.clone();
            tokio::spawn(async move {
                let _ = handle(stream, &root).await;
            });
        }
    });

    let _ = root;
    Ok(Preview { port })
}

async fn handle(mut stream: TcpStream, root: &Path) -> std::io::Result<()> {
    // 请求头读到 \r\n\r\n 为止。静态服务不收 body，8 KiB 顶天了。
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") || buf.len() > 8192 {
            break;
        }
    }

    let head = String::from_utf8_lossy(&buf);
    let mut parts = head.split_whitespace();
    let method = parts.next().unwrap_or("");
    let raw_path = parts.next().unwrap_or("/");

    if method != "GET" && method != "HEAD" {
        return respond(&mut stream, 405, "text/plain; charset=utf-8", b"405", false).await;
    }

    // 去掉 query/fragment，再做百分号解码
    let path = raw_path.split(['?', '#']).next().unwrap_or("/");
    let decoded = percent_decode(path);

    let Some(file) = resolve(root, &decoded) else {
        return respond(&mut stream, 404, "text/html; charset=utf-8", NOT_FOUND, method == "HEAD")
            .await;
    };

    match tokio::fs::read(&file).await {
        Ok(bytes) => {
            let ct = content_type(&file);
            respond(&mut stream, 200, ct, &bytes, method == "HEAD").await
        }
        Err(_) => {
            respond(&mut stream, 404, "text/html; charset=utf-8", NOT_FOUND, method == "HEAD").await
        }
    }
}

/// URL 路径 → 磁盘路径。目录自动补 index.html。
///
/// 路径穿越在这里挡死：解码后逐段检查，出现 `..` 或根组件一律拒绝。
/// 先解码再检查——只查原始串会被 `%2e%2e` 绕过。
fn resolve(root: &Path, url_path: &str) -> Option<PathBuf> {
    let mut out = root.to_path_buf();
    for seg in url_path.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            return None;
        }
        // Windows 上 `C:` 这类前缀会被 Path 当根组件吞掉，一并拒掉
        let p = Path::new(seg);
        if p.components().any(|c| !matches!(c, Component::Normal(_))) {
            return None;
        }
        out.push(seg);
    }
    if out.is_dir() {
        out.push("index.html");
    }
    if out.is_file() {
        Some(out)
    } else {
        None
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = |c: u8| -> Option<u8> {
                match c {
                    b'0'..=b'9' => Some(c - b'0'),
                    b'a'..=b'f' => Some(c - b'a' + 10),
                    b'A'..=b'F' => Some(c - b'A' + 10),
                    _ => None,
                }
            };
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn content_type(p: &Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "mp4" => "video/mp4",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

const NOT_FOUND: &[u8] = "<!doctype html><meta charset=utf-8><body style=\"background:#070b12;color:#8fa3b6;font:15px system-ui;padding:40px\">这个路径还没生成出来。".as_bytes();

async fn respond(
    stream: &mut TcpStream,
    status: u16,
    ct: &str,
    body: &[u8],
    head_only: bool,
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "OK",
    };
    // 预览必须每次拿最新的：生成过程中同一个 URL 内容一直在变，
    // 任何缓存都会让用户看到上一阶段的旧页面，演出效果直接毁掉。
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: {ct}\r\n\
         Content-Length: {}\r\n\
         Cache-Control: no-store, must-revalidate\r\n\
         Connection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    if !head_only {
        stream.write_all(body).await?;
    }
    stream.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_decoding() {
        assert_eq!(percent_decode("/a%20b"), "/a b");
        assert_eq!(percent_decode("/%e4%b8%ad"), "/中");
        // 残缺的百分号序列原样保留，不 panic
        assert_eq!(percent_decode("/a%zz"), "/a%zz");
        assert_eq!(percent_decode("/a%"), "/a%");
    }

    #[test]
    fn traversal_is_rejected() {
        let root = std::env::temp_dir();
        assert!(resolve(&root, "/../etc/passwd").is_none());
        assert!(resolve(&root, "/a/../../b").is_none());
        // 编码过的 .. 同样要拒——resolve 收到的已是解码后的串
        assert!(resolve(&root, &percent_decode("/%2e%2e/secret")).is_none());
    }

    #[test]
    fn content_types_cover_the_generated_set() {
        // 生成器产出的就这几种，错一个线上就是 text/plain 白页
        assert_eq!(content_type(Path::new("a/index.html")), "text/html; charset=utf-8");
        assert_eq!(content_type(Path::new("a/style.css")), "text/css; charset=utf-8");
        assert_eq!(content_type(Path::new("a/app.js")), "text/javascript; charset=utf-8");
        assert_eq!(content_type(Path::new("a/hero.svg")), "image/svg+xml");
        assert_eq!(content_type(Path::new("a/UPPER.PNG")), "image/png");
        assert_eq!(content_type(Path::new("a/noext")), "application/octet-stream");
    }
}
