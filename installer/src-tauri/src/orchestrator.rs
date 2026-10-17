// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
// Orchestration commands: Cloudflare auth, KV provisioning, streaming deploy
// and post-deploy health verification.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::resolve_project_root_from_exe;

/// Locate the node executable (Windows prefers node.exe).
fn which_node() -> String {
    for candidate in ["node", "node.exe"] {
        if Command::new(candidate).arg("-v").output().is_ok() {
            return candidate.to_string();
        }
    }
    "node".to_string()
}

fn effective_root(override_path: &str) -> Result<PathBuf, String> {
    if override_path.is_empty() {
        return resolve_project_root_from_exe().ok_or_else(|| {
            "未找到 ai-gateway 项目根目录，请先获取项目源码，或在「基础配置」指定项目文件夹。".to_string()
        });
    }
    let p = PathBuf::from(override_path);
    if p.join("package.json").is_file()
        && p.join("src").is_dir()
        && p.join("wrangler.jsonc").is_file()
    {
        Ok(p)
    } else {
        Err("提供的项目路径无效：缺少 package.json、src/ 或 wrangler.jsonc".into())
    }
}

/// Run a wrapper subcommand with inherited-ish output streamed to the UI as
/// `{event}` messages, followed by `{event}-done` with the exit code.
fn run_streaming(
    app: &AppHandle,
    root: &std::path::Path,
    args: Vec<String>,
    event: &str,
) -> Result<i32, String> {
    let mut cmd = Command::new(which_node());
    cmd.arg("scripts/cloudflare-wrangler.mjs")
        .args(&args)
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("无法启动 wrangler: {e}"))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let app_out = app.clone();
    let event_out = format!("{event}-log");
    let out_handle = std::thread::spawn(move || {
        if let Some(pipe) = stdout {
            for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                let _ = app_out.emit(&event_out, line);
            }
        }
    });

    let app_err = app.clone();
    let event_err = format!("{event}-log");
    let err_handle = std::thread::spawn(move || {
        if let Some(pipe) = stderr {
            for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                let _ = app_err.emit(&event_err, line);
            }
        }
    });

    let status = child.wait().map_err(|e| format!("等待 wrangler 失败：{e}"))?;
    let _ = out_handle.join();
    let _ = err_handle.join();
    let code = status.code().unwrap_or(1);
    let _ = app.emit(&format!("{event}-done"), code);
    Ok(code)
}

#[derive(Debug, Serialize)]
pub struct AuthResult {
    pub logged_in: bool,
    pub output: String,
}

#[tauri::command]
pub fn cloudflare_whoami(project_root: String) -> Result<AuthResult, String> {
    let root = effective_root(&project_root)?;
    let out = Command::new(which_node())
        .arg("scripts/cloudflare-wrangler.mjs")
        .arg("whoami")
        .current_dir(&root)
        .output()
        .map_err(|e| format!("无法运行 wrangler whoami: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    Ok(AuthResult {
        logged_in: out.status.success(),
        output: if stdout.trim().is_empty() { stderr } else { stdout },
    })
}

#[tauri::command]
pub fn cloudflare_login(app: AppHandle, project_root: String) -> Result<i32, String> {
    let root = effective_root(&project_root)?;
    run_streaming(&app, &root, vec!["login".into()], "cf-login")
}

#[derive(Debug, Serialize)]
pub struct KvResult {
    pub id: String,
    pub title: String,
    pub output: String,
}

/// Create a KV namespace and extract its 32-hex id from wrangler output.
#[tauri::command]
pub fn create_kv_namespace(project_root: String, title: String) -> Result<KvResult, String> {
    let root = effective_root(&project_root)?;
    let name = if title.trim().is_empty() {
        "ai-gateway-tier1-affinity"
    } else {
        title.trim()
    };
    let out = Command::new(which_node())
        .arg("scripts/cloudflare-wrangler.mjs")
        .args(["kv", "namespace", "create", name])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("无法创建 KV 命名空间：{e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let combined = format!("{stdout}\n{stderr}");

    let id = extract_kv_id(&combined).ok_or_else(|| {
        format!("未能从 wrangler 输出中解析 KV ID，请检查是否已登录 Cloudflare。\n{combined}")
    })?;

    Ok(KvResult {
        id,
        title: name.to_string(),
        output: combined,
    })
}

/// Extract the first 32-hex token standing alone (wrangler prints `id = "..."`).
fn extract_kv_id(text: &str) -> Option<String> {
    for token in text.split(|c: char| !c.is_ascii_hexdigit()) {
        if token.len() == 32 {
            return Some(token.to_string());
        }
    }
    None
}

#[tauri::command]
pub fn deploy(app: AppHandle, project_root: String, user_config: String, secrets_file: String) -> Result<i32, String> {
    let root = effective_root(&project_root)?;
    let config = if user_config.trim().is_empty() {
        "wrangler.user.jsonc".to_string()
    } else {
        user_config
    };
    run_streaming(
        &app,
        &root,
        vec![
            "deploy".into(),
            "-c".into(),
            config,
            "--keep-vars".into(),
            "--secrets-file".into(),
            secrets_file,
        ],
        "deploy",
    )
}

#[derive(Debug, Serialize)]
pub struct CheckResult {
    pub url: String,
    pub status: u16,
    pub ok: bool,
    pub body: String,
}

#[tauri::command]
pub async fn health_check(gateway_url: String, access_key: String) -> Result<Vec<CheckResult>, String> {
    let base = gateway_url.trim().trim_end_matches('/').to_string();
    if !base.starts_with("https://") {
        return Err("网关地址必须以 https:// 开头".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败：{e}"))?;
    let key = access_key.trim();

    let mut results = Vec::new();
    for path in ["/health", "/v1/models"] {
        let url = format!("{base}{path}");
        let resp = client
            .get(&url)
            .header("Authorization", format!("Bearer {key}"))
            .send()
            .await;
        match resp {
            Ok(r) => {
                let status = r.status().as_u16();
                let ok = r.status().is_success();
                let body = r.text().await.unwrap_or_default();
                let body = if body.len() > 4000 {
                    format!("{}…", &body[..4000])
                } else {
                    body
                };
                results.push(CheckResult { url, status, ok, body });
            }
            Err(e) => {
                results.push(CheckResult {
                    url,
                    status: 0,
                    ok: false,
                    body: format!("请求失败: {e}"),
                });
            }
        }
    }
    Ok(results)
}
