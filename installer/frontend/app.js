// ai-gateway deployment wizard — frontend controller.
// Drives a multi-step form backed by Tauri IPC commands.

import { loadCatalog } from "./providers.js";

// The wizard catalog (provider presets, logical models, access groups) is
// data, loaded once before any state or UI is built.
const { providers: PROVIDERS, logicalModels: LOGICAL_MODELS, accessGroups: ACCESS_GROUPS, providerById } =
  await loadCatalog();

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// ---- State ----
const state = {
  step: 0,
  prereq: null,
  projectRoot: "",
  sourceMessage: "",
  sourceError: "",
  sourceFetching: false,
  cfAuth: null,
  workerName: "ai-gateway",
  kvNamespaceId: "",
  kvCreated: false,
  publicUrl: "",
  nodes: [],
  accessGroups: ACCESS_GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    desc: g.desc,
    enabled: false,
    key: "",
    models: g.default_models,
  })),
  tokenEncryptionKey: "",
  deployResult: null,
  healthResults: null,
  error: "",
  busy: false,
  logs: [],
};

const STEPS = [
  "环境自检",
  "连接 Cloudflare",
  "基础配置",
  "上游节点",
  "访问分组",
  "确认配置",
  "部署",
  "验证",
];

// ---- Utilities ----
const BOOL_PROPS = new Set(["disabled", "readonly", "selected", "checked", "value", "placeholder"]);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (BOOL_PROPS.has(k)) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function genKey() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

// ---- Project source resolution ----
async function resolveSource() {
  state.sourceFetching = true;
  state.sourceError = "";
  render();
  try {
    const r = await invoke("sync_project", { overridePath: "" });
    state.projectRoot = r.path;
    state.sourceMessage = r.message;
    state.sourceFetching = false;
  } catch (e) {
    state.sourceError = String(e);
    state.sourceFetching = false;
  }
  render();
}

async function pickProjectFolder() {
  state.sourceError = "";
  render();
  try {
    const picked = await invoke("pick_folder");
    if (!picked) return;
    const r = await invoke("sync_project", { overridePath: picked });
    state.projectRoot = r.path;
    state.sourceMessage = r.message;
    render();
  } catch (e) {
    state.sourceError = String(e);
    render();
  }
}

// ---- Render ----
function render() {
  const app = document.getElementById("app");
  app.innerHTML = "";
  app.appendChild(renderHeader());
  app.appendChild(renderStepper());
  const content = el("div", { class: "content" });
  const sc = el("div", { class: "step-content" });
  sc.appendChild(renderStep());
  content.appendChild(sc);
  app.appendChild(content);
  app.appendChild(renderFooter());
  content.scrollTop = 0;
}

function renderHeader() {
  return el("div", { class: "header" },
    el("div", { class: "logo" }, "AI"),
    el("div", {},
      el("h1", {}, "ai-gateway 部署向导"),
      el("div", { class: "subtitle" }, "一键部署你的私有 AI API 网关到 Cloudflare Workers"),
    ),
  );
}

function renderStepper() {
  const wrap = el("div", { class: "stepper" });
  STEPS.forEach((label, i) => {
    const cls = i === state.step ? "active" : i < state.step ? "done" : "";
    wrap.appendChild(el("div", { class: `step-item ${cls}` },
      el("span", { class: "num" }, i < state.step ? "\u2713" : String(i + 1)),
      el("span", {}, label),
    ));
  });
  return wrap;
}

function renderStep() {
  switch (state.step) {
    case 0: return renderPrereq();
    case 1: return renderCloudflare();
    case 2: return renderBasics();
    case 3: return renderNodes();
    case 4: return renderAccess();
    case 5: return renderReview();
    case 6: return renderDeploy();
    case 7: return renderVerify();
    default: return el("div");
  }
}

// ---- Step 0: Prerequisites + Project Source ----
function renderPrereq() {
  const c = el("div");
  c.appendChild(el("h2", {}, "环境自检"));
  c.appendChild(el("p", { class: "lead" }, "部署前需要确认本机已安装必要工具，并准备 ai-gateway 项目源码。"));

  if (!state.prereq) {
    c.appendChild(el("div", { class: "alert alert-info" }, "正在检测环境…"));
    return c;
  }
  const p = state.prereq;
  const card = el("div", { class: "card" });
  card.appendChild(el("div", { class: "card-title" }, "工具检测"));

  const rows = [
    ["Node.js", p.node_ok, p.node_version, `要求 ${p.node_required}`],
    ["npm", p.npm_ok, p.npm_version, "包管理器"],
    ["Git", p.git_ok, p.git_version, "版本控制（自动获取源码用）"],
  ];
  for (const [label, ok, version, detail] of rows) {
    card.appendChild(el("div", { class: "check-row" },
      el("div", { class: "label" },
        el("span", { class: `icon ${ok ? "ok" : "err"}` }, ok ? "\u2713" : "\u2717"),
        el("strong", {}, label),
      ),
      el("div", { class: "detail" }, version || detail),
    ));
  }
  c.appendChild(card);

  // Project source card
  const sc = el("div", { class: "card" });
  sc.appendChild(el("div", { class: "card-title" }, "ai-gateway 项目源码"));

  if (state.sourceFetching) {
    sc.appendChild(el("div", { class: "alert alert-info" }, "正在获取项目源码…（直连 GitHub，失败后自动尝试镜像）"));
  } else if (state.projectRoot) {
    sc.appendChild(el("div", { class: "check-row" },
      el("div", { class: "label" },
        el("span", { class: "icon ok" }, "\u2713"),
        el("strong", {}, "项目就绪"),
      ),
      el("div", { class: "detail" }, state.projectRoot),
    ));
  } else if (state.sourceError) {
    sc.appendChild(el("div", { class: "alert alert-err" }, state.sourceError));
    const btns = el("div", { style: "display:flex;gap:10px;margin-top:10px" });
    btns.appendChild(el("button", { class: "btn btn-primary", onclick: resolveSource }, "重试自动获取"));
    btns.appendChild(el("button", { class: "btn", onclick: pickProjectFolder }, "手动选择文件夹"));
    sc.appendChild(btns);
  } else {
    sc.appendChild(el("div", { class: "alert alert-info" }, "点击下方按钮自动获取 ai-gateway 源码（直连 GitHub，失败后自动切换镜像）。"));
    sc.appendChild(el("button", { class: "btn btn-primary", style: "margin-top:10px", onclick: resolveSource }, "获取项目源码"));
    sc.appendChild(el("button", { class: "btn", style: "margin-top:10px;margin-left:8px", onclick: pickProjectFolder }, "手动选择文件夹"));
  }
  c.appendChild(sc);

  if (p.node_ok && state.projectRoot) {
    c.appendChild(el("div", { class: "alert alert-ok" }, "\u2713 环境就绪，可以继续。"));
  } else if (!p.node_ok) {
    c.appendChild(el("div", { class: "alert alert-err" }, "未检测到 Node.js，请安装 Node.js 22.18+ 后重试。下载地址: https://nodejs.org/"));
  }
  return c;
}

// ---- Step 1: Cloudflare ----
function renderCloudflare() {
  const c = el("div");
  c.appendChild(el("h2", {}, "连接 Cloudflare"));
  c.appendChild(el("p", { class: "lead" }, "网关部署在 Cloudflare Workers 上。请先登录你的 Cloudflare 账号。如果没有账号，请先在 cloudflare.com 注册。"));

  const card = el("div", { class: "card" });
  card.appendChild(el("div", { class: "card-title" }, "Cloudflare 账号状态"));

  if (!state.cfAuth) {
    card.appendChild(el("p", {}, "点击下方按钮检测登录状态。"));
  } else if (state.cfAuth.logged_in) {
    card.appendChild(el("div", { class: "badge badge-ok" }, "\u2713 已登录"));
    card.appendChild(el("pre", { class: "code-block", style: "margin-top:12px" }, state.cfAuth.output));
  } else {
    card.appendChild(el("div", { class: "badge badge-err" }, "\u2717 未登录"));
    card.appendChild(el("pre", { class: "code-block", style: "margin-top:12px" }, state.cfAuth.output));
  }

  c.appendChild(card);
  const btns = el("div", { style: "display:flex;gap:10px" });
  btns.appendChild(el("button", {
    class: "btn",
    onclick: async () => { state.cfAuth = null; render(); try { state.cfAuth = await invoke("cloudflare_whoami", { projectRoot: state.projectRoot }); } catch (e) { state.cfAuth = { logged_in: false, output: String(e) }; } render(); },
  }, "检测登录状态"));
  btns.appendChild(el("button", {
    class: "btn btn-primary",
    onclick: async () => {
      state.busy = true; render();
      let unlisten = null;
      try {
        unlisten = await listen("cf-login-done", async (e) => {
          if (e.payload === 0) {
            try { state.cfAuth = await invoke("cloudflare_whoami", { projectRoot: state.projectRoot }); }
            catch (err) { state.cfAuth = { logged_in: false, output: String(err) }; }
          } else {
            state.cfAuth = { logged_in: false, output: "登录未完成或被取消。" };
          }
          state.busy = false;
          if (unlisten) unlisten();
          render();
        });
        await invoke("cloudflare_login", { projectRoot: state.projectRoot });
      } catch (e) {
        state.error = String(e); state.busy = false;
        if (unlisten) unlisten();
        render();
      }
    },
  }, state.busy ? "等待登录完成…" : "登录 Cloudflare (打开浏览器)"));
  c.appendChild(btns);
  return c;
}

// ---- Step 2: Basics ----
function renderBasics() {
  const c = el("div");
  c.appendChild(el("h2", {}, "基础配置"));
  c.appendChild(el("p", { class: "lead" }, "设置 Worker 名称、KV 命名空间和网关公网地址。"));

  // Show project root
  c.appendChild(el("div", { class: "card" },
    el("div", { class: "card-title" }, "项目路径"),
    el("div", { class: "summary-grid" },
      el("div", { class: "key" }, "ai-gateway 源码"), el("div", { class: "val" }, state.projectRoot || "(未就绪)"),
    ),
    el("div", { style: "margin-top:10px" },
      el("button", { class: "btn btn-sm", onclick: pickProjectFolder }, "更改项目文件夹"),
    ),
  ));

  const card = el("div", { class: "card" });
  card.appendChild(el("div", { class: "field" },
    el("label", {}, "Worker 名称"),
    el("input", { type: "text", value: state.workerName, oninput: (e) => state.workerName = e.target.value, placeholder: "ai-gateway" }),
    el("div", { class: "hint" }, "Cloudflare Workers 中的标识，仅小写字母、数字和连字符。"),
  ));

  // KV namespace
  card.appendChild(el("div", { class: "field" },
    el("label", {}, "Tier 1 亲和 KV 命名空间 ID"),
    el("div", { class: "field-row" },
      el("input", { type: "text", value: state.kvNamespaceId, oninput: (e) => state.kvNamespaceId = e.target.value.trim(), placeholder: "32 位十六进制 ID", style: "flex:2" }),
          el("button", {
            class: "btn btn-sm",
            style: "flex:0 0 auto;align-self:flex-end",
            onclick: async () => {
              state.busy = true; render();
              try {
                const r = await invoke("create_kv_namespace", { projectRoot: state.projectRoot, title: "ai-gateway-tier1-affinity" });
                state.kvNamespaceId = r.id; state.kvCreated = true; state.busy = false;
              } catch (e) { state.error = String(e); state.busy = false; }
              render();
            },
          }, state.busy ? "创建中…" : "一键创建（或获取已有 ID）"),
    ),
    el("div", { class: "hint" }, state.kvCreated ? "\u2713 已自动创建并填入 ID" : "可手动粘贴已有 KV 命名空间的 32 位十六进制 ID，或点击一键创建。"),
  ));

  card.appendChild(el("div", { class: "field" },
    el("label", {}, "网关公网地址"),
    el("input", { type: "url", value: state.publicUrl, oninput: (e) => state.publicUrl = e.target.value.trim(), placeholder: "https://ai-gateway.your-name.workers.dev" }),
    el("div", { class: "hint" }, "部署后 Worker 的 https 公网地址，用于 OAuth 引导与仪表盘。"),
  ));

  // Token encryption key
  if (!state.tokenEncryptionKey) state.tokenEncryptionKey = genKey();
  card.appendChild(el("div", { class: "field" },
    el("label", {}, "订阅加密密钥 (自动生成)"),
    el("div", { class: "field-row" },
      el("input", { type: "text", value: state.tokenEncryptionKey, readonly: true, style: "flex:2" }),
      el("button", { class: "btn btn-sm", style: "flex:0 0 auto;align-self:flex-end", onclick: () => { state.tokenEncryptionKey = genKey(); render(); } }, "重新生成"),
    ),
    el("div", { class: "hint" }, "用于加密 Tier 2 订阅令牌，无需手动填写。"),
  ));

  c.appendChild(card);
  return c;
}

// ---- Step 3: Nodes ----
function renderNodes() {
  const c = el("div");
  c.appendChild(el("h2", {}, "上游节点配置"));
  c.appendChild(el("p", { class: "lead" }, "添加你的 AI API 节点。Tier 1 (免费/低成本) 至少需要一个，Tier 2 (订阅) 和 Tier 3 (付费 API) 可选。"));

  // Render existing nodes
  state.nodes.forEach((node, idx) => {
    c.appendChild(renderNodeCard(node, idx));
  });

  // Add buttons
  const addWrap = el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-top:8px" });
  for (const tier of [1, 2, 3]) {
    addWrap.appendChild(el("button", {
      class: "btn btn-sm",
      onclick: () => {
        const prov = providerById("nvidia");
        state.nodes.push({
          tier,
          id: `node-${Date.now().toString(36).slice(-4)}-${tier}`,
          provider: prov.id,
          base_url: prov.base_url,
          priority: 10,
          models: {},
          credential: "",
          oauth: false,
        });
        render();
      },
    }, `+ 添加 Tier ${tier} 节点${tier === 1 ? " (必填)" : tier === 2 ? " (订阅, 可选)" : " (付费, 可选)"}`));
  }
  c.appendChild(addWrap);

  if (state.nodes.length === 0) {
    c.appendChild(el("div", { class: "alert alert-info" }, "还没有节点。点击上方按钮添加你的第一个上游节点。"));
  }
  return c;
}

function renderNodeCard(node, idx) {
  const card = el("div", { class: "node-card" });
  const prov = providerById(node.provider);

  card.appendChild(el("div", { class: "node-header" },
    el("div", { style: "display:flex;align-items:center;gap:8px" },
      el("span", { class: "tag" }, `Tier ${node.tier}`),
      el("span", { style: "font-size:13px;font-weight:600" }, node.id || "(未命名节点)"),
    ),
    el("button", { class: "btn btn-sm btn-danger", onclick: () => { state.nodes.splice(idx, 1); render(); } }, "删除"),
  ));

  // Provider select
  card.appendChild(el("div", { class: "field-row" },
    el("div", { class: "field" },
      el("label", {}, "服务商"),
      el("select", {
        onchange: (e) => {
          node.provider = e.target.value;
          const np = providerById(node.provider);
          if (np.base_url) node.base_url = np.base_url;
          if (Object.keys(node.models).length === 0 && Object.keys(np.models).length) {
            node.models = { ...np.models };
          }
          render();
        },
      }, ...PROVIDERS.map((p) => el("option", { value: p.id, selected: p.id === node.provider }, p.label))),
    ),
    el("div", { class: "field" },
      el("label", {}, "节点 ID"),
      el("input", { type: "text", value: node.id, oninput: (e) => node.id = e.target.value.trim(), placeholder: "my-node-01" }),
    ),
  ));

  // Base URL
  card.appendChild(el("div", { class: "field" },
    el("label", {}, "Base URL"),
    el("input", { type: "url", value: node.base_url, oninput: (e) => node.base_url = e.target.value.trim(), placeholder: "https://api.example.com/v1" }),
    prov.key_url ? el("div", { class: "hint" }, `获取 API Key: `, el("a", { href: prov.key_url, target: "_blank" }, prov.key_url)) : null,
  ));

  // Tier 2 oauth toggle
  if (node.tier === 2) {
    card.appendChild(el("div", { class: "field" },
      el("div", {
        class: `toggle ${node.oauth ? "active" : ""}`,
        onclick: () => { node.oauth = !node.oauth; render(); },
      },
        el("div", { class: "switch" }),
        el("div", {},
          el("strong", {}, "OAuth 订阅模式"),
          el("div", { class: "hint" }, "Claude/Codex/Gemini 订阅权益。开启后无需 API Key，部署后通过 OAuth 引导连接。"),
        ),
      ),
    ));
  }

  // API Key (skip for oauth)
  if (!node.oauth) {
    card.appendChild(el("div", { class: "field" },
      el("label", {}, "API Key / 凭据"),
      el("input", { type: "password", value: node.credential, oninput: (e) => node.credential = e.target.value, placeholder: prov.key_hint || "粘贴你的 API Key" }),
    ));
  }

  // Model mappings
  card.appendChild(el("div", { class: "field" },
    el("label", {}, "模型映射 (逻辑模型 \u2192 上游模型)"),
  ));
  const modelsContainer = el("div");
  for (const [logical, upstream] of Object.entries(node.models)) {
    modelsContainer.appendChild(renderModelRow(node, logical, upstream));
  }
  // Quick-add logical model
  modelsContainer.appendChild(el("div", { style: "display:flex;gap:6px;margin-top:8px;flex-wrap:wrap" },
    ...LOGICAL_MODELS.filter((m) => !node.models[m]).map((m) =>
      el("button", { class: "btn btn-sm", onclick: () => {
        const np = providerById(node.provider);
        node.models[m] = np.models[m] || "";
        render();
      } }, `+ ${m}`),
    ),
  ));
  card.appendChild(modelsContainer);

  return card;
}

function renderModelRow(node, logical, upstream) {
  const row = el("div", { class: "model-row" },
    el("select", {
      style: "flex:1",
      onchange: (e) => {
        const newLogical = e.target.value;
        if (newLogical !== logical) {
          delete node.models[logical];
          node.models[newLogical] = upstream;
          render();
        }
      },
    }, ...LOGICAL_MODELS.map((m) => el("option", { value: m, selected: m === logical }, m)), el("option", { value: logical, selected: !LOGICAL_MODELS.includes(logical) }, logical)),
    el("span", { style: "color:var(--text-dim)" }, "\u2192"),
    el("input", {
      type: "text", style: "flex:2", value: upstream,
      oninput: (e) => node.models[logical] = e.target.value,
      placeholder: "上游模型名",
    }),
    el("span", { class: "remove", onclick: () => { delete node.models[logical]; render(); } }, "\u2715"),
  );
  return row;
}

// ---- Step 4: Access Groups ----
function renderAccess() {
  const c = el("div");
  c.appendChild(el("h2", {}, "访问分组配置"));
  c.appendChild(el("p", { class: "lead" }, "网关访问密钥按分组隔离。每个分组有自己的密钥和允许调用的模型列表。至少启用一个分组。"));

  // Collect all logical models from nodes for suggestions
  const allLogical = [...new Set(state.nodes.flatMap((n) => Object.keys(n.models)))];

  for (const g of state.accessGroups) {
    const card = el("div", { class: "card" });
    card.appendChild(el("div", {
      class: `toggle ${g.enabled ? "active" : ""}`,
      onclick: () => { g.enabled = !g.enabled; if (g.enabled && !g.key) g.key = genKey(); render(); },
    },
      el("div", { class: "switch" }),
      el("div", {},
        el("strong", {}, `${g.label} (${g.id})`),
        el("div", { class: "hint" }, g.desc),
      ),
    ));

    if (g.enabled) {
      card.appendChild(el("div", { style: "margin-top:14px" },
        el("div", { class: "field" },
          el("label", {}, "访问密钥"),
          el("div", { class: "field-row" },
            el("input", { type: "text", value: g.key, oninput: (e) => g.key = e.target.value, style: "flex:2" }),
            el("button", { class: "btn btn-sm", style: "flex:0 0 auto;align-self:flex-end", onclick: () => { g.key = genKey(); render(); } }, "重新生成"),
          ),
        ),
        el("div", { class: "field" },
          el("label", {}, "允许调用的模型 (逗号分隔)"),
          el("input", { type: "text", value: g.models, oninput: (e) => g.models = e.target.value, placeholder: "code-pro,general-air" }),
          el("div", { class: "hint" }, allLogical.length ? `当前节点中可用的逻辑模型: ${allLogical.join(", ")}` : "请先在上游节点步骤添加模型映射。",
          ),
        ),
      ));
    }
    c.appendChild(card);
  }

  const enabledCount = state.accessGroups.filter((g) => g.enabled).length;
  if (enabledCount === 0) {
    c.appendChild(el("div", { class: "alert alert-warn" }, "\u26a0 至少需要启用一个访问分组。"));
  }
  return c;
}

// ---- Step 5: Review ----
function renderReview() {
  const c = el("div");
  c.appendChild(el("h2", {}, "确认配置"));
  c.appendChild(el("p", { class: "lead" }, "请核对以下配置摘要，确认无误后进入部署。"));

  const card = el("div", { class: "card" });
  const grid = el("div", { class: "summary-grid" });
  grid.appendChild(el("div", { class: "key" }, "项目路径"));
  grid.appendChild(el("div", { class: "val" }, state.projectRoot || "(未就绪)"));
  grid.appendChild(el("div", { class: "key" }, "Worker 名称"));
  grid.appendChild(el("div", { class: "val" }, state.workerName));
  grid.appendChild(el("div", { class: "key" }, "KV 命名空间 ID"));
  grid.appendChild(el("div", { class: "val" }, state.kvNamespaceId || "(未填写)"));
  grid.appendChild(el("div", { class: "key" }, "公网地址"));
  grid.appendChild(el("div", { class: "val" }, state.publicUrl || "(未填写)"));
  grid.appendChild(el("div", { class: "key" }, "节点总数"));
  grid.appendChild(el("div", { class: "val" }, String(state.nodes.length)));
  grid.appendChild(el("div", { class: "key" }, "启用分组"));
  grid.appendChild(el("div", { class: "val" }, state.accessGroups.filter((g) => g.enabled).map((g) => g.id).join(", ") || "(无)"));
  card.appendChild(grid);
  c.appendChild(card);

  // Node summary
  for (const node of state.nodes) {
    const nc = el("div", { class: "card" });
    nc.appendChild(el("div", { class: "card-title" },
      el("span", { class: "tag", style: "font-size:11px;padding:2px 8px;border-radius:4px;background:var(--brand-bg);color:var(--brand-light)" }, `Tier ${node.tier}`),
      ` ${node.id} (${node.provider})`,
    ));
    nc.appendChild(el("div", { class: "summary-grid" },
      el("div", { class: "key" }, "Base URL"), el("div", { class: "val" }, node.base_url || "(OAuth)"),
      el("div", { class: "key" }, "模型映射"), el("div", { class: "val" }, Object.entries(node.models).map(([l, u]) => `${l}\u2192${u}`).join(", ") || "(无)"),
      el("div", { class: "key" }, "凭据"), el("div", { class: "val" }, node.oauth ? "(OAuth 订阅)" : "\u2022".repeat(8)),
    ));
    c.appendChild(nc);
  }

  // Access group summary
  for (const g of state.accessGroups.filter((g) => g.enabled)) {
    const gc = el("div", { class: "card" });
    gc.appendChild(el("div", { class: "card-title" }, `分组 ${g.label} (${g.id})`));
    gc.appendChild(el("div", { class: "summary-grid" },
      el("div", { class: "key" }, "密钥"), el("div", { class: "val" }, g.key.slice(0, 8) + "…"),
      el("div", { class: "key" }, "允许模型"), el("div", { class: "val" }, g.models),
    ));
    c.appendChild(gc);
  }

  if (state.error) {
    c.appendChild(el("div", { class: "alert alert-err" }, state.error));
  }
  return c;
}

// ---- Step 6: Deploy ----
function renderDeploy() {
  const c = el("div");
  c.appendChild(el("h2", {}, "部署到 Cloudflare Workers"));
  c.appendChild(el("p", { class: "lead" }, "点击开始部署。安装器会生成配置、校验、然后通过 wrangler 部署到 Cloudflare。"));

  if (!state.deployResult) {
    const card = el("div", { class: "card" });
    card.appendChild(el("div", { class: "card-title" }, "部署进度"));
    const steps = [
      "\u2460 生成配置文件与密钥分片",
      "\u2461 执行 wrangler deploy",
      "\u2462 等待部署完成",
    ];
    card.appendChild(el("div", {}, ...steps.map((s) => el("div", { style: "margin-bottom:6px" }, s))));

    if (state.logs.length > 0) {
      card.appendChild(el("div", { class: "log-box", style: "margin-top:12px" }, state.logs.join("\n")));
    }
    c.appendChild(card);

    c.appendChild(el("button", {
      class: "btn btn-primary",
      onclick: startDeploy,
    }, state.busy ? "部署中…" : "\u25b6 开始部署"));
  } else {
    c.appendChild(el("div", { class: "alert alert-ok" }, `\u2713 部署完成！Worker: ${state.deployResult.worker_name}`));
    c.appendChild(el("div", { class: "card" },
      el("div", { class: "card-title" }, "生成结果"),
      el("div", { class: "summary-grid" },
        el("div", { class: "key" }, "配置文件"), el("div", { class: "val" }, state.deployResult.user_config_path),
        el("div", { class: "key" }, "密钥文件"), el("div", { class: "val" }, state.deployResult.secrets_path),
        el("div", { class: "key" }, "变量分片"), el("div", { class: "val" }, state.deployResult.planned_vars.join(", ") || "(无)"),
        el("div", { class: "key" }, "密钥分片"), el("div", { class: "val" }, state.deployResult.planned_secrets.join(", ") || "(无)"),
      ),
    ));
    c.appendChild(el("div", { class: "log-box" }, state.logs.join("\n")));
  }
  return c;
}

async function startDeploy() {
  state.busy = true; state.logs = []; state.error = ""; render();

  // Listen for deploy logs
  const unlisten = await listen("deploy-log", (e) => { state.logs.push(e.payload); if (state.logs.length % 5 === 0) render(); });
  const unlistenDone = await listen("deploy-done", (e) => { /* handled below */ });

  try {
    const payload = buildPayload();
    const result = await invoke("generate_config", { payload, projectRoot: state.projectRoot });
    state.deployResult = result;
    state.logs.push("--- 配置生成完成，开始 wrangler deploy ---");
    render();

    const code = await invoke("deploy", {
      projectRoot: state.projectRoot,
      userConfig: "wrangler.user.jsonc",
      secretsFile: result.secrets_path,
    });
    if (code === 0) {
      state.logs.push("\n=== 部署成功 ===");
      state.step = 7;
    } else {
      state.logs.push(`\n=== 部署失败 (exit ${code}) ===`);
      state.error = `部署失败，退出码 ${code}。请查看上方日志。`;
    }
  } catch (e) {
    state.error = String(e);
    state.logs.push(`\n[错误] ${e}`);
  } finally {
    state.busy = false;
    unlisten(); unlistenDone();
    render();
  }
}

function buildPayload() {
  return {
    worker_name: state.workerName,
    kv_namespace_id: state.kvNamespaceId,
    public_url: state.publicUrl,
    nodes: state.nodes.map((n) => ({
      tier: n.tier,
      id: n.id,
      provider: n.provider,
      base_url: n.base_url,
      priority: n.priority,
      models: n.models,
      credential: n.credential,
      oauth: n.oauth,
    })),
    access_groups: state.accessGroups.filter((g) => g.enabled).map((g) => ({
      group: g.id, key: g.key, models: g.models,
    })),
    token_encryption_key: state.tokenEncryptionKey,
  };
}

// ---- Step 7: Verify ----
function renderVerify() {
  const c = el("div");
  c.appendChild(el("h2", {}, "验证部署"));
  c.appendChild(el("p", { class: "lead" }, "部署完成后，请验证网关是否正常运行。"));

  const card = el("div", { class: "card" });
  card.appendChild(el("div", { class: "field" },
    el("label", {}, "网关地址"),
    el("input", { type: "url", value: state.publicUrl, oninput: (e) => state.publicUrl = e.target.value.trim() }),
  ));
  const firstGroup = state.accessGroups.find((g) => g.enabled);
  card.appendChild(el("div", { class: "field" },
    el("label", {}, "访问密钥 (用于验证)"),
    el("input", { type: "password", value: firstGroup ? firstGroup.key : "", oninput: (e) => { if (firstGroup) firstGroup.key = e.target.value; } }),
  ));
  card.appendChild(el("button", {
    class: "btn btn-primary",
    onclick: async () => {
      state.busy = true; state.healthResults = null; render();
      try {
        state.healthResults = await invoke("health_check", { gatewayUrl: state.publicUrl, accessKey: firstGroup ? firstGroup.key : "" });
      } catch (e) { state.error = String(e); }
      state.busy = false; render();
    },
  }, state.busy ? "验证中…" : "\u25b6 验证"));

  if (state.healthResults) {
    for (const r of state.healthResults) {
      card.appendChild(el("div", { class: "card", style: "margin-top:12px" },
          el("div", { class: "card-title" },
          el("span", { class: `badge ${r.ok ? "badge-ok" : "badge-err"}` }, r.ok ? "\u2713" : "\u2717"),
          r.url,
        ),
        el("div", { class: "summary-grid" },
          el("div", { class: "key" }, "HTTP 状态"), el("div", { class: "val" }, String(r.status)),
        ),
        el("pre", { class: "code-block", style: "margin-top:8px" }, r.body),
      ));
    }
  }

  // Client config snippets
  if (state.healthResults && state.healthResults.every((r) => r.ok)) {
    c.appendChild(el("div", { class: "card" },
      el("div", { class: "card-title" }, "客户端接入配置"),
      el("div", { class: "hint", style: "margin-bottom:12px" }, "将客户端的 base URL 指向网关，密钥使用网关访问密钥。"),
      el("div", { class: "hint", style: "margin-bottom:4px;font-weight:600" }, "OpenAI 协议 (Chat Completions / Responses):"),
      el("div", { class: "code-block" },
        `OPENAI_BASE_URL=${state.publicUrl}/v1\nOPENAI_API_KEY=${firstGroup ? firstGroup.key : "<YOUR_GATEWAY_KEY>"}`),
      el("div", { class: "hint", style: "margin-bottom:4px;font-weight:600" }, "Anthropic 协议 (Messages, 如 Claude Code):"),
      el("div", { class: "code-block" },
        `ANTHROPIC_BASE_URL=${state.publicUrl}\nANTHROPIC_AUTH_TOKEN=${firstGroup ? firstGroup.key : "<YOUR_GATEWAY_KEY>"}`),
    ));
    c.appendChild(el("div", { class: "alert alert-ok" }, "\u2713 部署成功！网关已上线，可以开始使用了。" ));
  }

  return c;
}

// ---- Footer ----
function renderFooter() {
  const footer = el("div", { class: "footer" });
  const left = el("div");
  if (state.step > 0 && state.step < 7) left.appendChild(el("button", { class: "btn", onclick: () => { state.step--; render(); } }, "\u2190 上一步"));
  footer.appendChild(left);

  const right = el("div", { style: "display:flex;gap:10px" });
  if (state.step === 0) {
    right.appendChild(el("button", {
      class: "btn btn-primary",
      onclick: () => { state.step = 1; render(); },
      disabled: !canAdvance(),
    }, "开始 \u2192"));
  } else if (state.step === 1) {
    right.appendChild(el("button", { class: "btn btn-primary", onclick: () => { state.step = 2; render(); }, disabled: !state.cfAuth || !state.cfAuth.logged_in }, "下一步 \u2192"));
  } else if (state.step === 2) {
    right.appendChild(el("button", { class: "btn btn-primary", onclick: () => { state.step = 3; render(); }, disabled: !canAdvance() }, "下一步 \u2192"));
  } else if (state.step === 3) {
    right.appendChild(el("button", { class: "btn btn-primary", onclick: () => { state.step = 4; render(); }, disabled: !canAdvance() }, "下一步 \u2192"));
  } else if (state.step === 4) {
    right.appendChild(el("button", { class: "btn btn-primary", onclick: () => { state.step = 5; render(); }, disabled: !canAdvance() }, "下一步 \u2192"));
  } else if (state.step === 5) {
    right.appendChild(el("button", { class: "btn btn-primary", onclick: () => { state.step = 6; render(); }, disabled: !canAdvance() }, "进入部署 \u2192"));
  } else if (state.step === 6 && state.deployResult) {
    right.appendChild(el("button", { class: "btn btn-primary", onclick: () => { state.step = 7; render(); } }, "验证部署 \u2192"));
  }
  footer.appendChild(right);
  return footer;
}

function canAdvance() {
  switch (state.step) {
    case 0: return state.prereq && state.prereq.node_ok && state.projectRoot;
    case 2: return state.workerName && state.kvNamespaceId && state.publicUrl.startsWith("https://");
    case 3: return state.nodes.some((n) => n.tier === 1) && state.nodes.every((n) => n.id && n.provider && (n.oauth || n.credential) && Object.keys(n.models).length > 0);
    case 4: return state.accessGroups.some((g) => g.enabled && g.key && g.models);
    case 5: return true;
    default: return true;
  }
}

// ---- Init ----
async function init() {
  render();
  try {
    state.prereq = await invoke("check_prerequisites");
  } catch (e) {
    state.error = String(e);
  }
  render();
  // Auto-resolve project source if prereqs look ok
  if (state.prereq && state.prereq.node_ok && !state.projectRoot) {
    resolveSource();
  }
}

init();
