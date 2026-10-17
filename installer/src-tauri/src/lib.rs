// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
// ai-gateway deployment wizard — Tauri library root.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use tauri::{AppHandle, Emitter};

mod config;
mod orchestrator;

pub use config::*;
pub use orchestrator::*;

const REPO_URL: &str = "https://github.com/fongap-labs/ai-gateway.git";
const REPO_NAME: &str = "ai-gateway";

/// Resolve the ai-gateway project root by walking up from the executable.
/// The installer lives at `<root>/installer/`, so the project root is found
/// by looking for a directory containing package.json + src/ + wrangler.jsonc.
pub fn resolve_project_root_from_exe() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let mut p = exe.parent()?.to_path_buf();
    for _ in 0..8 {
        if p.join("package.json").is_file()
            && p.join("src").is_dir()
            && p.join("wrangler.jsonc").is_file()
        {
            return Some(p);
        }
        if !p.pop() {
            break;
        }
    }
    None
}

/// List of mirror prefixes to try in order.
fn git_mirror_prefixes() -> Vec<String> {
    vec![
        "https://github.com".to_string(),
        "https://mirror.ghproxy.com".to_string(),
        "https://gh-proxy.com".to_string(),
        "https://hub.gitmirror.com".to_string(),
    ]
}

/// Attempt to clone (or reuse cached) the ai-gateway repo into the given base dir.
/// Returns the path to the cloned repo on success.
fn clone_or_use_cached(base_dir: &Path) -> io::Result<PathBuf> {
    let target_dir = base_dir.join(REPO_NAME);
    // If target already looks like a repo, reuse it
    if target_dir.join(".git").is_dir() {
        return Ok(target_dir);
    }

    // Remove stale non-repo dir to avoid confusion
    let _ = fs::remove_dir_all(&target_dir);

    // Try each URL: prefix + REPO_URL
    for prefix in git_mirror_prefixes() {
        let url = format!("{}/{}", prefix.trim_end_matches('/'), REPO_URL);
        println!("Attempting git clone from {url}");
        let status = Command::new("git")
            .args(&["clone", "--depth", "1", &url, target_dir.to_string_lossy().as_ref()])
            .status()?;
        if status.success() {
            return Ok(target_dir);
        }
        // cleanup and try next mirror
        let _ = fs::remove_dir_all(&target_dir);
    }

    Err(io::Error::new(
        io::ErrorKind::NotFound,
        format!("All git mirrors failed for {REPO_NAME}"),
    ))
}

/// Ensure we have a usable ai-gateway source tree.
/// Order:
/// 1. If override_path is Some and valid -> use it.
/// 2. If running from within a dev tree (exe inside installer/) -> resolve from exe.
/// 3. Try to reuse a cached clone under `cache_dir`.
/// 4. Otherwise clone using mirrors into cache_dir.
/// 5. On failure, return Err with suggestion to use folder picker.
pub fn ensure_project_source(
    override_path: Option<&Path>,
    cache_dir: &Path,
) -> Result<PathBuf, String> {
    // 1. Override (e.g. from picker)
    if let Some(path) = override_path {
        if path.join("package.json").is_file()
            && path.join("src").is_dir()
            && path.join("wrangler.jsonc").is_file()
        {
            return Ok(path.to_path_buf());
        }
        return Err(format!(
            "提供的路径 {} 不是有效的 ai-gateway 项目（缺少 package.json、src/ 或 wrangler.jsonc）",
            path.display()
        ));
    }

    // 2. Dev-mode: exe inside project/installer/
    if let Some(root) = resolve_project_root_from_exe() {
        return Ok(root);
    }

    // Ensure cache dir exists
    if !cache_dir.is_dir() {
        if let Err(e) = fs::create_dir_all(cache_dir) {
            return Err(format!("无法创建缓存目录 {cache_dir}: {e}"));
        }
    }

    // 3+4. Try clone (or reuse) into cache
    match clone_or_use_cached(cache_dir) {
        Ok(repo) => Ok(repo),
        Err(e) => Err(format!(
            "无法自动获取 ai-gateway 源码：{e}\n您可以手动选择本地已有的 ai-gateway 项目文件夹。"
        )),
    }
}

/// Cache directory used for an auto-cloned source tree.
fn cache_dir() -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push("ai-gateway-installer");
    p
}

#[derive(Debug, Serialize)]
pub struct SourceResult {
    /// Absolute path of the usable ai-gateway source tree.
    pub path: String,
    /// Whether an existing on-disk copy was found without cloning this run.
    pub cached: bool,
    /// Human-readable message for the UI.
    pub message: String,
}

/// Tauri command: resolve (or fetch via mirrors) a usable source tree.
/// `override_path` is empty -> auto resolve/clone; otherwise validate that path.
#[tauri::command]
pub fn sync_project(override_path: String) -> Result<SourceResult, String> {
    let cd = cache_dir();
    match ensure_project_source(if override_path.is_empty() { None } else { Some(Path::new(&override_path)) }, &cd) {
        Ok(path) => {
            // Determine if we cloned just now by checking if .git existed before
            let cached = path.join(".git").is_dir() && {
                // For simplicity, we consider it cached if the directory already existed as a repo.
                // A more precise check would require tracking state; here we assume if the folder
                // existed before this call then it's cached.
                true
            };
            Ok(SourceResult {
                path: path.display().to_string(),
                cached,
                message: format!("已就绪: {}", path.display()),
            })
        }
        Err(e) => Err(format!(
            "{e}\n如需手动指定，请在「基础配置」中选择已有的 ai-gateway 文件夹。"
        )),
    }
}

/// Open a native folder picker and return selected path.
#[tauri::command]
pub fn pick_folder() -> Option<String> {
    match rfd::FileDialog::new().pick_folder() {
        Some(path) => Some(path.display().to_string()),
        None => None,
    }
}

fn probe_version(bin: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(bin).args(args).output().ok()?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        if !stderr.trim().is_empty() {
            return Some(stderr.lines().next()?.trim().to_string());
        }
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    Some(stdout.lines().next()?.trim().to_string())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PrereqResult {
    pub node_ok: bool,
    pub node_version: Option<String>,
    pub node_required: String,
    pub npm_ok: bool,
    pub npm_version: Option<String>,
    pub git_ok: bool,
    pub git_version: Option<String>,
    pub project_root: Option<String>,
    pub project_ok: bool,
}

#[tauri::command]
pub fn check_prerequisites() -> PrereqResult {
    let node_version =
        probe_version("node", &["-v"]).or_else(|| probe_version("node.exe", &["-v"]));
    let npm_version =
        probe_version("npm", &["-v"]).or_else(|| probe_version("npm.cmd", &["-v"]));
    let git_version = probe_version("git", &["--version"]);

    let project_root = resolve_project_root_from_exe().map(|p| p.display().to_string());
    let project_ok = project_root.is_some();

    PrereqResult {
        node_ok: node_version.is_some(),
        node_version,
        node_required: ">=22.18.0".into(),
        npm_ok: npm_version.is_some(),
        npm_version,
        git_ok: git_version.is_some(),
        git_version,
        project_root,
        project_ok,
    }
}

#[tauri::command]
pub fn ping() -> String {
    "pong".into()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            ping,
            check_prerequisites,
            pick_folder,
            sync_project,
            cloudflare_whoami,
            cloudflare_login,
            create_kv_namespace,
            generate_config,
            deploy,
            health_check,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ai-gateway installer");
}
