// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
// Wizard payload -> node config files, node secrets, deployment plan,
// wrangler.user.jsonc and the bulk secrets file consumed by wrangler deploy.
//
// The sharding/planning logic is NOT reimplemented here. We write the
// operator raw inputs to disk and delegate to the repository own
// scripts/plan-node-configuration.mjs, so the installer can never drift
// from the gateway configuration contract.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeInput {
    pub tier: u8,
    pub id: String,
    pub provider: String,
    pub base_url: String,
    #[serde(default)]
    pub priority: Option<i64>,
    pub models: BTreeMap<String, String>,
    #[serde(default)]
    pub credential: String,
    #[serde(default)]
    pub oauth: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessGroupInput {
    pub group: String,
    pub key: String,
    pub models: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WizardPayload {
    pub worker_name: String,
    pub kv_namespace_id: String,
    pub public_url: String,
    pub nodes: Vec<NodeInput>,
    pub access_groups: Vec<AccessGroupInput>,
    #[serde(default)]
    pub token_encryption_key: String,
}

#[derive(Debug, Serialize)]
pub struct TierSummary {
    pub tier: u8,
    pub nodes: usize,
    pub shards: usize,
}

#[derive(Debug, Serialize)]
pub struct GenerateResult {
    pub user_config_path: String,
    pub secrets_path: String,
    pub worker_name: String,
    pub planned_vars: Vec<String>,
    pub planned_secrets: Vec<String>,
    pub tiers: Vec<TierSummary>,
}

fn validate_worker_name(name: &str) -> Result<(), String> {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes.len() > 63 {
        return Err("Worker 名称长度需为 1-63".into());
    }
    let first = bytes[0];
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return Err("Worker 名称必须以小写字母或数字开头".into());
    }
    if bytes[bytes.len() - 1] == b'-' {
        return Err("Worker 名称不能以连字符结尾".into());
    }
    for b in bytes {
        if !(b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-') {
            return Err("Worker 名称只能包含小写字母、数字和连字符".into());
        }
    }
    Ok(())
}

fn validate_kv_id(id: &str) -> Result<(), String> {
    if id.len() != 32 || !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("KV 命名空间 ID 必须是 32 位十六进制字符".into());
    }
    Ok(())
}

/// Write node tier files and the node-secrets file, then run the planner.
fn run_planner(
    root: &std::path::Path,
    payload: &WizardPayload,
) -> Result<PathBuf, String> {
    let tmp = root.join(".installer-tmp");
    fs::create_dir_all(&tmp).map_err(|e| format!("无法创建临时目录: {e}"))?;

    let mut tiers: [Vec<serde_json::Value>; 4] = Default::default();
    let mut secrets_map: BTreeMap<String, String> = BTreeMap::new();

    for node in &payload.nodes {
        if node.tier < 1 || node.tier > 3 {
            return Err(format!("节点 {} 的 tier 必须是 1、2 或 3", node.id));
        }
        let mut obj = serde_json::Map::new();
        obj.insert("id".into(), node.id.clone().into());
        obj.insert("provider".into(), node.provider.clone().into());
        if !node.oauth {
            obj.insert("base_url".into(), node.base_url.clone().into());
        }
        if let Some(p) = node.priority {
            obj.insert("priority".into(), p.into());
        }
        if node.oauth {
            obj.insert("auth".into(), "oauth".into());
        }
        let models_json: serde_json::Map<String, serde_json::Value> = node
            .models
            .iter()
            .map(|(k, v)| (k.clone(), v.clone().into()))
            .collect();
        obj.insert("models".into(), serde_json::Value::Object(models_json));
        tiers[node.tier as usize].push(serde_json::Value::Object(obj));

        if !node.oauth {
            if node.credential.trim().is_empty() {
                return Err(format!("节点 {} 缺少凭据 (API Key)", node.id));
            }
            secrets_map.insert(node.id.clone(), node.credential.clone());
        }
    }

    for n in 1..=3u8 {
        let path = tmp.join(format!("tier{n}-nodes.json"));
        fs::write(&path, serde_json::to_string_pretty(&tiers[n as usize]).unwrap())
            .map_err(|e| format!("写入 tier{n} 配置失败：{e}"))?;
    }
    let secrets_path = tmp.join("node-secrets.json");
    fs::write(
        &secrets_path,
        serde_json::to_string_pretty(&secrets_map).unwrap(),
    )
    .map_err(|e| format!("写入凭据文件失败: {e}"))?;

    let plan_path = tmp.join("plan.json");
    let mut args = vec![
        "plan".to_string(),
        "--secrets".to_string(),
        secrets_path.to_string_lossy().into_owned(),
        "--out".to_string(),
        plan_path.to_string_lossy().into_owned(),
    ];
    for n in 1..=3u8 {
        if !tiers[n as usize].is_empty() {
            let p = tmp.join(format!("tier{n}-nodes.json"));
            args.push(format!("--tier{n}"));
            args.push(p.to_string_lossy().into_owned());
        }
    }

    let node_bin = which_node();
    let status = Command::new(node_bin)
        .arg("scripts/plan-node-configuration.mjs")
        .args(&args)
        .current_dir(root)
        .output()
        .map_err(|e| format!("无法运行 plan-node-configuration: {e}"))?;

    if !status.status.success() {
        let err = String::from_utf8_lossy(&status.stderr);
        let out = String::from_utf8_lossy(&status.stdout);
        return Err(format!(
            "配置校验失败:\n{}\n{}",
            out.trim(),
            err.trim()
        ));
    }
    Ok(plan_path)
}

#[derive(Debug, Deserialize)]
struct Plan {
    vars: BTreeMap<String, String>,
    secrets: BTreeMap<String, String>,
    planned_vars: Vec<String>,
    planned_secrets: Vec<String>,
    tier_summary: BTreeMap<String, TierSummaryRaw>,
}

#[derive(Debug, Deserialize)]
struct TierSummaryRaw {
    nodes: usize,
    shards: usize,
}

/// Find the node executable. On Windows prefer node.exe.
fn which_node() -> String {
    for candidate in ["node", "node.exe"] {
        if Command::new(candidate)
            .arg("-v")
            .output()
            .is_ok()
        {
            return candidate.to_string();
        }
    }
    "node".to_string()
}

#[tauri::command]
pub fn generate_config(payload: WizardPayload, project_root: String) -> Result<GenerateResult, String> {
    validate_worker_name(&payload.worker_name)?;
    validate_kv_id(&payload.kv_namespace_id)?;
    if !payload.public_url.starts_with("https://") {
        return Err("网关公网地址必须以 https:// 开头".into());
    }
    if payload.nodes.iter().filter(|n| n.tier == 1).count() == 0 {
        return Err("至少需要一个 Tier 1 节点".into());
    }
    if payload.access_groups.is_empty() {
        return Err("至少需要配置一个访问分组".into());
    }
    for g in &payload.access_groups {
        if g.key.trim().is_empty() {
            return Err(format!("分组 {} 的密钥不能为空", g.group));
        }
        if g.models.trim().is_empty() {
            return Err(format!("分组 {} 的模型列表不能为空", g.group));
        }
    }
    if payload.token_encryption_key.trim().is_empty() {
        return Err("缺少订阅加密密钥".into());
    }

    let root = PathBuf::from(project_root);
    if !(root.join("package.json").is_file()
        && root.join("src").is_dir()
        && root.join("wrangler.jsonc").is_file()) {
        return Err("提供的项目路径无效：缺少 package.json、src/ 或 wrangler.jsonc".into());
    }

    let plan_path = run_planner(&root, &payload)?;
    let plan_raw = fs::read_to_string(&plan_path)
        .map_err(|e| format!("读取部署计划失败: {e}"))?;
    let plan: Plan = serde_json::from_str(&plan_raw)
        .map_err(|e| format!("解析部署计划失败: {e}"))?;

    // Build wrangler.user.jsonc from the immutable wrangler.jsonc base.
    let base_raw = fs::read_to_string(root.join("wrangler.jsonc"))
        .map_err(|e| format!("读取 wrangler.jsonc 失败：{e}"))?;
    let mut base: serde_json::Value =
        serde_json::from_str(&base_raw).map_err(|e| format!("解析 wrangler.jsonc 失败：{e}"))?;

    // Remove inherit/keep_vars so the user config is self-contained.
    if let Some(obj) = base.as_object_mut() {
        obj.remove("inherit");
        obj.remove("keep_vars");
        // vars
        let mut vars = serde_json::Map::new();
        for (k, v) in &plan.vars {
            vars.insert(k.clone(), serde_json::Value::String(v.clone()));
        }
        vars.insert(
            "AIG_PUBLIC_URL".into(),
            payload.public_url.clone().into(),
        );
        for g in &payload.access_groups {
            vars.insert(
                format!("AIG_ACCESS_MODELS_{}", g.group),
                g.models.clone().into(),
            );
        }
        obj.insert("vars".into(), serde_json::Value::Object(vars));
        // kv_namespaces
        let kv = serde_json::json!([{
            "binding": "TIER1_AFFINITY",
            "id": payload.kv_namespace_id
        }]);
        obj.insert("kv_namespaces".into(), kv);
        // name
        obj.insert("name".into(), payload.worker_name.clone().into());
    }

    let user_config_path = root.join("wrangler.user.jsonc");
    let pretty = serde_json::to_string_pretty(&base).unwrap();
    fs::write(&user_config_path, format!("{pretty}\n"))
        .map_err(|e| format!("写入 wrangler.user.jsonc 失败：{e}"))?;

    // Build the bulk secrets file for `wrangler deploy --secrets-file`.
    let mut bulk = serde_json::Map::new();
    for (k, v) in &plan.secrets {
        bulk.insert(k.clone(), v.clone().into());
    }
    bulk.insert(
        "AIG_TOKEN_ENCRYPTION_KEY".into(),
        payload.token_encryption_key.clone().into(),
    );
    for g in &payload.access_groups {
        bulk.insert(
            format!("AIG_ACCESS_KEY_{}", g.group),
            g.key.clone().into(),
        );
    }
    let secrets_path = root.join(".installer-tmp").join("deploy-secrets.json");
    fs::write(
        &secrets_path,
        serde_json::to_string_pretty(&serde_json::Value::Object(bulk)).unwrap(),
    )
    .map_err(|e| format!("写入部署密钥文件失败: {e}"))?;

    let tiers = plan
        .tier_summary
        .iter()
        .map(|(k, v)| TierSummary {
            tier: k.parse().unwrap_or(0),
            nodes: v.nodes,
            shards: v.shards,
        })
        .collect();

    Ok(GenerateResult {
        user_config_path: user_config_path.to_string_lossy().into_owned(),
        secrets_path: secrets_path.to_string_lossy().into_owned(),
        worker_name: payload.worker_name,
        planned_vars: plan.planned_vars,
        planned_secrets: plan.planned_secrets,
        tiers,
    })
}
