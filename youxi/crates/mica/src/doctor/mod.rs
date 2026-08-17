//! 环境医生（PRD 6.2 三级解析）：env 覆盖 → 内置运行时目录 → 用户 PATH。
//! 在线安装兜底（npmmirror）为 P1，本期返回 EngineUnavailable 由业务层提示。

use crate::core::{EngineId, MicaError, ResolvedRuntime, Result};
use crate::runtime::paths;
use std::path::{Path, PathBuf};

pub fn resolve(engine: EngineId) -> Result<ResolvedRuntime> {
    let (env_key, name) = match engine {
        EngineId::Claude => ("MICA_CLAUDE_EXE", "claude"),
        EngineId::Codex => ("MICA_CODEX_EXE", "codex"),
        EngineId::Api => return Err(MicaError::Other("api engine needs no runtime".into())),
    };

    // 1. env 覆盖（测试 / 运维强制指定）
    if let Ok(p) = std::env::var(env_key) {
        let p = p.trim();
        if !p.is_empty() {
            let path = PathBuf::from(p);
            return Ok(ResolvedRuntime {
                needs_cmd_shim: is_cmd_shim(&path),
                exe: path,
                via: "env override".into(),
            });
        }
    }

    // 2. 内置运行时目录 runtimes/<name>/<version>/（多版本共存，取字典序最新）
    let dir = paths::runtimes_dir().join(name);
    if let Ok(entries) = std::fs::read_dir(&dir) {
        let mut versions: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
        versions.sort();
        for version_dir in versions.into_iter().rev() {
            for candidate in [format!("{name}.exe"), name.to_string()] {
                let exe = version_dir.join(candidate);
                if exe.is_file() {
                    return Ok(ResolvedRuntime {
                        needs_cmd_shim: false,
                        exe,
                        via: "runtimes".into(),
                    });
                }
            }
        }
    }

    // 3. 用户 PATH（含 .cmd 解析）
    if let Some(exe) = find_in_path(name) {
        return Ok(ResolvedRuntime { needs_cmd_shim: is_cmd_shim(&exe), exe, via: "path".into() });
    }

    Err(MicaError::Other(format!(
        "runtime `{name}` not found (set {env_key}, drop it under {}, or add to PATH)",
        dir.display()
    )))
}

/// 单项环境体检结果（设置页「环境医生」用）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct ComponentReport {
    /// 组件名（claude / codex / node / git）
    pub name: String,
    /// 是否检测到可用
    pub ok: bool,
    /// 解析到的可执行文件路径（若有）
    pub path: Option<String>,
    /// 解析来源：env override / runtimes / path
    pub via: Option<String>,
    /// 版本号（能取到时）
    pub version: Option<String>,
    /// 该组件是否为软件运行的硬性前置（缺了核心功能不可用）
    pub required: bool,
    /// 面向新用户的引导安装提示
    pub hint: String,
}

/// 整机环境体检：新用户即便没装 Claude 也能据此看到该装什么。
/// 返回 (组件列表, 是否全部就绪)。
pub fn checkup() -> (Vec<ComponentReport>, bool) {
    let mut reports = Vec::new();

    // Claude Code CLI —— 文本引擎首选（本机直调，不走网关）
    reports.push(component_via_resolver(
        "claude",
        EngineId::Claude,
        true,
        "未检测到 Claude Code CLI。新用户可执行 `npm i -g @anthropic-ai/claude-code` 安装，或在「API 接入」里改用 MiniMax 等供应商直连（无需本机 CLI）。",
    ));
    // Codex CLI —— 生图/工具主战场
    reports.push(component_via_resolver(
        "codex",
        EngineId::Codex,
        false,
        "未检测到 Codex CLI（生图/工具循环用）。可执行 `npm i -g @openai/codex` 安装；不装则生图走 MiniMax API 兜底。",
    ));
    // node —— 两个 CLI 的运行时依赖
    reports.push(component_plain(
        "node",
        false,
        "未检测到 Node.js。Claude / Codex CLI 均依赖它，建议装 Node 20+（https://nodejs.org）。",
    ));
    // git —— 更新与工程管理用
    reports.push(component_plain(
        "git",
        false,
        "未检测到 git。远程更新与工程版本管理需要它，建议安装。",
    ));

    // 就绪判定：所有 required 组件 ok，或至少文本可通过 API 直连兜底
    let all_ready = reports.iter().filter(|r| r.required).all(|r| r.ok);
    (reports, all_ready)
}

fn component_via_resolver(name: &str, engine: EngineId, required: bool, hint: &str) -> ComponentReport {
    match resolve(engine) {
        Ok(rt) => {
            let path = rt.exe.display().to_string();
            let version = probe_version(&rt.exe, rt.needs_cmd_shim);
            ComponentReport {
                name: name.into(),
                ok: true,
                path: Some(path),
                via: Some(rt.via),
                version,
                required,
                hint: String::new(),
            }
        }
        Err(_) => ComponentReport {
            name: name.into(),
            ok: false,
            path: None,
            via: None,
            version: None,
            required,
            hint: hint.into(),
        },
    }
}

fn component_plain(name: &str, required: bool, hint: &str) -> ComponentReport {
    match find_in_path(name) {
        Some(exe) => {
            let version = probe_version(&exe, is_cmd_shim(&exe));
            ComponentReport {
                name: name.into(),
                ok: true,
                path: Some(exe.display().to_string()),
                via: Some("path".into()),
                version,
                required,
                hint: String::new(),
            }
        }
        None => ComponentReport {
            name: name.into(),
            ok: false,
            path: None,
            via: None,
            version: None,
            required,
            hint: hint.into(),
        },
    }
}

/// 尽力取版本号：`<exe> --version`，失败返回 None，绝不阻塞体检。
fn probe_version(exe: &Path, needs_shim: bool) -> Option<String> {
    let out = if needs_shim {
        std::process::Command::new("cmd").arg("/c").arg(exe).arg("--version").output()
    } else {
        std::process::Command::new(exe).arg("--version").output()
    }
    .ok()?;
    let text = String::from_utf8_lossy(if out.stdout.is_empty() { &out.stderr } else { &out.stdout });
    text.lines().next().map(|l| l.trim().to_string()).filter(|s| !s.is_empty())
}

fn is_cmd_shim(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref(),
        Some("cmd") | Some("bat")
    )
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    let exts: &[&str] = if cfg!(windows) { &[".exe", ".cmd", ".bat"] } else { &[""] };
    for dir in std::env::split_paths(&path_var) {
        for ext in exts {
            let candidate = dir.join(format!("{name}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}
