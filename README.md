<div align="center">

# ai-gateway

**基于 Cloudflare Workers 的高韧性 AI API 网关**

把分散在不同 Provider、API Key、额度与模型别名上的容量，汇成 **一个稳定的 OpenAI / Anthropic 兼容入口**

[![CI](https://img.shields.io/github/actions/workflow/status/fongap-labs/ai-gateway/ci.yml?branch=main&label=CI&style=flat-square&labelColor=1D3F45)](https://github.com/fongap-labs/ai-gateway/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/fongap-labs/ai-gateway?label=License&style=flat-square&labelColor=1D3F45&color=0f5d53)](LICENSE)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-0f5d53?style=flat-square&logo=cloudflare&logoColor=ffffff&labelColor=1D3F45)
![API](https://img.shields.io/badge/API-OpenAI%20%7C%20Anthropic-0f5d53?style=flat-square&labelColor=1D3F45)

[快速开始](#快速开始) · [工作原理](#工作原理) · [配置](#配置) · [API](#api) · [文档](#文档地图) · [安全](#安全) · [维护者参考](#维护者参考)

</div>

<p align="center">
  <a href="https://api.135468.xyz/"><img src="https://api.135468.xyz/readme-status.svg?v=20260918-3" alt="维护者实例实时生产运行数据" width="920"></a>
</p>

<p align="center"><sub>上图为维护者真实生产实例的近实时数据，由网关自身渲染。</sub></p>

## 阅读路径

| 你的目标 | 从这里开始 |
| --- | --- |
| 第一次了解 | [这是什么](#这是什么)、[术语速查](#术语速查) |
| 部署并调用 | [快速开始](#快速开始) |
| 配置节点、访问分组或订阅 | [配置](#配置) |
| 理解路由与可靠性 | [工作原理](#工作原理)、[文档地图](#文档地图) |
| 参与贡献 | [参与贡献](#参与贡献) |
| 报告安全问题 | [安全](#安全) |
| 维护与治理 | [维护者参考](#维护者参考) |

## 这是什么

ai-gateway 是一个**私有**的 AI API 网关，运行在 Cloudflare Workers（边缘无服务器运行环境）上，面向**家庭、个人运营者或小型可信团队**。你把手里零散的模型容量接进来，客户端只需要一个地址和一把网关密钥。

> 可以把它想象成**多路插线板**：几家的电源（模型容量）插进来，某一路断了自动切到下一路，你的电器只插一个插口。

```mermaid
flowchart LR
    client(["客户端<br/>OpenAI / Anthropic 协议"]) --> gw["ai-gateway<br/>鉴权 · 路由 · 预算"]
    gw ==> tierOne["Tier 1<br/>免费 / 近似免费"]
    tierOne -. 耗尽或不可用 .-> tierTwo["Tier 2<br/>订阅权益"]
    tierTwo -. 耗尽或不可用 .-> tierThree["Tier 3<br/>付费 API 兜底"]
    tierOne --> up["Provider 与 Key"]
    tierTwo --> up
    tierThree --> up
    classDef capacityPrimary fill:#0f5d53,stroke:#0f5d53,color:#ffffff
    classDef capacitySecondary fill:#7cb4a5,stroke:#0f5d53,color:#17211f
    classDef capacityReserve fill:#f8f7f3,stroke:#0f5d53,color:#17211f
    class tierOne capacityPrimary
    class tierTwo capacitySecondary
    class tierThree capacityReserve
```

| 角色 | 含义 |
| --- | --- |
| **Provider** | 模型服务商，例如 OpenAI、Anthropic 或各类兼容平台 |
| **Key** | 某个 Provider 的上游 API 密钥 |
| **网关密钥** | 你发给客户端的访问密钥（`AIG_ACCESS_KEY_*`），与上游 Key 分离 |

| 适合 | 不适合 |
| --- | --- |
| 手里有多个免费额度或多把 Key，想统一调用 | 公共 SaaS、对外售卖 API |
| 个人或小团队自托管，想同时控制成本与稳定性 | 计费、转售、按用户计量 |
| 同时使用 OpenAI 与 Anthropic 协议的客户端 | 企业级组织、RBAC、多租户 |

## 解决什么问题

| 常见问题 | 处理方式 |
| --- | --- |
| 免费额度被限流（429） | 自适应冷却，到期后单次探测，恢复后再放量 |
| 某个模型映射失效（404） | 只隔离失败的映射，同节点的其他模型不受影响 |
| 两种协议接口不一致 | OpenAI Chat Completions ↔ Anthropic Messages 有界互转 |
| 流式输出中途切换上游 | 有意义的输出提交后，不再透明切换上游 |
| 重试与回退把请求量放大 | 所有尝试共享一套预算，`max_attempts` 为硬上限 |

## 工作原理

### 容量分层

请求按 Tier 顺序使用容量：Tier 1 耗尽或不可用才看 Tier 2，Tier 2 之后才是 Tier 3。

| Tier | 容量类型 | 角色 |
| --- | --- | --- |
| **Tier 1** | 免费或近似免费的 API 容量 | 日常主力，重点保证韧性与持续可用 |
| **Tier 2** | 订阅权益（Claude Pro/Max、ChatGPT/Codex、Google AI Premium，经 OAuth 接入） | 次级容量，不是第二个通用 Key 池 |
| **Tier 3** | 付费 API 容量 | 受保护的最终兜底，用量可预测 |

### 一次请求的生命周期

```mermaid
flowchart TD
    req(["请求进入"]) --> auth{"访问密钥有效<br/>且模型已授权？"}
    auth -- 否 --> deny(["拒绝"])
    auth -- 是 --> s1["① 同协议候选池<br/>Tier 1 → 2 → 3"]
    s1 -- 成功 --> out(["按客户端协议返回"])
    s1 -- 候选耗尽 --> s2["② 跨协议回退<br/>同一模型 · Chat ↔ Messages"]
    s2 -- 成功 --> out
    s2 -- 仍失败 --> s3["③ 兼容模型家族<br/>最多两轮"]
    s3 -- 成功 --> out
    s3 -- 预算耗尽 --> fail(["返回错误"])
    classDef stage fill:#0f5d53,stroke:#0f5d53,color:#ffffff
    class s1,s2,s3 stage
```

三步共享同一个 `max_attempts`（请求级硬上限）与时间预算。`/v1/responses` 只走原生路径，不参与第 ② 步。

## 术语速查

| 术语 | 含义 |
| --- | --- |
| **SDK** | 软件开发工具包，例如 OpenAI SDK、Anthropic SDK，用于在代码里调用 AI 接口 |
| **Worker** | 运行在 Cloudflare 边缘节点上的小程序，ai-gateway 本身就是一个 Worker |
| **Secret / 普通变量** | Cloudflare 上的两种配置方式：Secret 加密保存、写入后无法再读取，用于密钥；普通变量用于不敏感的配置 |
| **D1 / KV** | Cloudflare 的 SQLite 数据库 / 键值存储，分别用于用量数据与会话亲和 |
| **Tier** | 容量层级：Tier 1 免费、Tier 2 订阅、Tier 3 付费 |
| **节点（Node）** | 一个上游账号或端点的配置单元 |
| **逻辑模型** | 客户端使用的模型名（如 `code-pro`），映射到各节点的真实上游模型名 |
| **访问分组** | `AIR`、`PRO`、`MAX`、`ULTRA`、`AGENT` 之一，决定网关密钥可调用的逻辑模型 |
| **原生（Native）** | 与客户端同协议的上游路径，是首选 |
| **回退（Fallback）** | 当前候选失败后，转向下一个候选、另一协议或兼容模型 |
| **Hedge（对冲请求）** | 主请求在约定延迟内仍未返回时，并行发出的备份请求 |
| **TTFT** | Time To First Token，首个 token 到达所用的时间 |
| **亲和（Affinity）** | 同一会话尽量回到同一账号的软性偏置，不会绕过冷却或资格检查 |

## 快速开始

ai-gateway 本身是一个 **Cloudflare Worker**，安装脚本会把它部署到你的 Cloudflare 账户下。

### 开始前

- **Node.js** ≥ 22.18.0（版本以 `package.json` 为准）
- **Cloudflare 账户**
- **至少一个上游 Key** 或订阅，否则网关无法转发请求

### 部署

```bash
git clone https://github.com/fongap-labs/ai-gateway.git
cd ai-gateway
npm ci
sh scripts/install.sh          # Windows: powershell scripts/install.ps1
```

安装脚本会依次提问，然后完成配置并部署。每个问题怎么回答，展开下面的说明：

<details>
<summary>安装脚本会问什么</summary>

| 步骤 | 你需要提供 | 说明 |
| --- | --- | --- |
| 1 | Worker 名称 | 直接回车使用默认值 |
| 2 | KV 命名空间 ID | 在 Cloudflare 控制台创建一个 KV 命名空间，复制它的 ID |
| 3 | 节点配置文件（JSON） | Tier 1 必填，Tier 2、3 可留空；可参考 `config/tier1-nodes.example.json` |
| 4 | 节点凭据文件（JSON） | 形如 `{ "节点 id": "上游 Key" }`，只保存在本机，不要提交到 Git |
| 5 | 网关访问密钥 | 每个分组一把，至少一组。生成方式：`node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))'` |
| 6 | 网关公网地址 | `https://` 开头 |

脚本会自动生成订阅 token 的加密密钥，无需手动填写。

</details>

### 验证部署

```bash
curl https://<你的网关>/health -H "Authorization: Bearer <YOUR_GATEWAY_KEY>"
curl https://<你的网关>/v1/models -H "Authorization: Bearer <YOUR_GATEWAY_KEY>"
```

`/v1/models` 列表为空，通常是该分组的模型允许列表没有配置，见 [访问分组](#访问分组)。

### 接入客户端

客户端的 base URL 指向网关，密钥换成网关访问密钥。模型名使用**逻辑模型名**（如 `code-pro`）。

```bash
# OpenAI 协议（Chat Completions / Responses）
OPENAI_BASE_URL=https://<你的网关>/v1
OPENAI_API_KEY=<YOUR_GATEWAY_KEY>

# Anthropic 协议（Messages，例如 Claude Code）
ANTHROPIC_BASE_URL=https://<你的网关>
ANTHROPIC_AUTH_TOKEN=<YOUR_GATEWAY_KEY>
```

### 第一次调用

```bash
curl https://<你的网关>/v1/chat/completions \
  -H "Authorization: Bearer <YOUR_GATEWAY_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model": "code-pro", "messages": [{"role": "user", "content": "你好"}]}'
```

遇到问题，先查 [故障排查](docs/operations/troubleshooting.md)。

## 配置

### 配置来源

| 变量 | 作用 | 存放位置 |
| --- | --- | --- |
| `AIG_TIER{1,2,3}_NODES_01..10` | 节点定义：provider、地址、模型映射 | 普通变量 |
| `AIG_TIER{1,2,3}_CREDENTIALS_01..10` | 上游凭据，按节点 id 绑定 | Secret |
| `AIG_ACCESS_KEY_{AIR,PRO,MAX,ULTRA,AGENT}` | 网关访问密钥 | Secret |
| `AIG_ACCESS_MODELS_{AIR,PRO,MAX,ULTRA,AGENT}` | 该分组允许调用的逻辑模型 | 普通变量 |
| `AIG_POLICIES_CONFIG` | attempt、hedge、超时与 Tier 1 准入策略（可选） | 普通变量 |

`01..10` 只是分片编号。配置分片与凭据分片彼此独立（independent），凭据按 **Tier + node id** 绑定到节点，不按相同的后缀对应。完整清单见 [配置文档](docs/operations/configuration.md)。

### 节点与凭据

节点描述一个账号或端点，凭据单独存放。

```json
[
  {
    "id": "nvidia-01",
    "provider": "nvidia",
    "base_url": "https://integrate.api.nvidia.com/v1",
    "priority": 10,
    "models": { "Code-Max": "upstream-code-model" }
  }
]
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 节点唯一标识 |
| `provider` | 是 | 决定协议：`anthropic` → Messages，`openai` → Chat 与 Responses，其余 → OpenAI 兼容 Chat |
| `base_url` | 是（订阅节点可省略） | 必须是 HTTPS 地址 |
| `models` | 是 | 逻辑模型 → 上游模型的映射 |
| `priority` | 否 | 仅 Tier 2、3 使用；Tier 1 的调度忽略它 |

凭据文件只记录节点 id 与密钥的对应关系：`{ "nvidia-01": "<UPSTREAM_API_KEY>" }`。凭据绝不写入节点配置。

### 访问分组

- 五个分组（`AIR`、`PRO`、`MAX`、`ULTRA`、`AGENT`）互不继承，各自有一把密钥和一份模型列表。
- 模型列表为空，该分组就**不能调用任何模型**，包括 `AGENT`。

### Tier 2 订阅接入

订阅节点把你自己的 Claude、ChatGPT/Codex 或 Google AI 订阅作为 Tier 2 容量使用。凭据不写进配置，而是通过 OAuth（PKCE 授权码流程）接入，token 加密后存入 D1。

```json
{
  "id": "claude-sub-1",
  "provider": "anthropic",
  "auth": "oauth",
  "models": { "Code-Max": "upstream-code-model" }
}
```

| 步骤 | 操作 |
| --- | --- |
| 1 | 在 Tier 2 节点中声明 `"auth": "oauth"`，不配置静态凭据 |
| 2 | 用网关访问密钥打开 `/oauth/start?provider=<名称>&node=<节点 id>` 并完成授权 |
| 3 | Claude 与 Codex 自动回调完成；Google 需要把授权码粘贴回网关 |
| 4 | 网关加密保存 token，调度时按需解析并自动刷新 |

> **运营风险**：订阅节点以供应商自家客户端的身份调用其端点，可能违反服务条款，供应商也可能限流或封禁账号。是否启用由你自行决定；`AIG_IS_SUBSCRIPTION_ENABLED=false` 可整体关闭。详见 [SECURITY.md](SECURITY.md#订阅代理与-provider-条款)。

## API

| 方法 | 路径 | 协议 / 用途 | 鉴权 |
| --- | --- | --- | --- |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions | 网关密钥 |
| `POST` | `/v1/responses` | OpenAI Responses（仅原生） | 网关密钥 |
| `POST` | `/v1/messages` | Anthropic Messages | 网关密钥 |
| `POST` | `/v1/messages/count_tokens` | Anthropic 兼容的本地近似 Token 计数 | 网关密钥 |
| `GET` | `/v1/models` | 当前分组可见的模型目录 | 网关密钥 |
| `GET` | `/health` | 健康诊断，可按分组限制 | 网关密钥 |
| `GET` | `/metrics` | 运行时指标，可按分组限制 | 网关密钥 |
| `GET` | `/` | 公开仪表盘，可用 `AIG_PUBLIC_DASHBOARD=false` 关闭 | 公开 |

## 运行与边界

项目处于**稳定期**：架构调整只由真实生产数据驱动。日常关注真实 429、fallback / hedge 放大、D1 写入量与 TTFT。

| 边界 | 实际行为 |
| --- | --- |
| 全局限流 | RPM 限流只在单个 Worker 实例内生效；需要严格全局限流时，在 Cloudflare WAF 中叠加 Rate Limiting |
| Provider 额度 | 不宣称跨实例一致的上游额度；自适应状态只在实例内尽力而为 |
| 用量数据 | D1 中的用量仅用于观测，不参与路由决策 |

## 文档地图

| 想了解 | 文档 |
| --- | --- |
| 架构与模块职责 | [架构概览](docs/architecture/overview.md) |
| 路由、回退与调度 | [路由模型](docs/architecture/routing-model.md) |
| 失败分类、冷却与恢复 | [可靠性模型](docs/architecture/reliability-model.md) |
| 协议转换与流式边界 | [协议模型](docs/architecture/protocol-model.md) |
| 配置与变量清单 | [配置](docs/operations/configuration.md) |
| 部署与回滚 | [部署](docs/operations/deployment.md) |
| 故障排查 | [故障排查](docs/operations/troubleshooting.md) |
| 产品边界与治理 | [产品策略](docs/governance/product-policy.md) · [治理索引](docs/governance/README.md) |

---

## 维护者参考

> 面向维护者。只使用网关的读者可以跳过，下面的“参与贡献”与“安全”对所有人都适用。

### 治理边界

本仓库继承 Fongap Labs 的[共享治理](https://github.com/fongap-labs/action-worker/tree/main/docs)：业务规则留在本仓库，共用的门禁与执行交给 Action Worker。

| 归本仓库 | 归 Action Worker |
| --- | --- |
| 产品源码、迁移、配置示例、运维脚本 | 命名、变更分类、PR 门禁 `validate-merge` |
| 架构、运营与产品策略文档 `docs/` | 中央 CI、测试包 `tests/packs/ai-gateway/` |
| 部署清单 `.github/deploy.json`、部署入口 `scripts/deploy.sh` | 部署执行、Main Write Guard、凭据绑定 |

### 一次变更的旅程

```mermaid
flowchart LR
    A["Pull Request<br/>本仓库"] --> B["validate-merge<br/>Action Worker 门禁"]
    B --> C["Squash 合并<br/>到 main"]
    C --> D["Central CI<br/>测试包 · CI Evidence"]
    D --> E["自动部署<br/>scripts/deploy.sh"]
    E --> F["/health 校验<br/>commit SHA"]
    F -. 失败 .-> G["回滚 Worker"]
    classDef gate fill:#0f5d53,stroke:#0f5d53,color:#ffffff
    classDef step fill:#E7F0F1,stroke:#0f5d53,color:#17211f
    class B,D gate
    class A,C,E,F,G step
```

- 合并权限只属于 `validate-merge`；自动部署只在 `main` 的中央 CI 成功后运行。
- 部署标识是 commit SHA。项目发布编号由维护者人工通过 Git tag 或 GitHub Release 创建。

### 本地检查

| 命令 | 作用 |
| --- | --- |
| `npm run validate:merge` | 合并前的本地门禁：语法、部署配置、迁移、密钥扫描、文档与链接、lint、类型检查 |
| `npm run check:deploy` | Worker 产物的 dry-run，不部署到生产 |

## 参与贡献

完整规则见 [CONTRIBUTING.md](CONTRIBUTING.md)。

- 人类文档使用中文；PR 标题、工程 diff 与 CHANGELOG 使用英文。
- 分支使用 `feat/`、`fix/`、`docs/` 等前缀，每个 PR 只有一个主要目标。
- 行为、配置、协议或部署变化，必须在同一 PR 中更新规范文档。
- 提交前运行 `npm run validate:merge`；PR 描述按 `.github/pull_request_template.md` 填写，合并只用 Squash merge。

## 安全

- 上游凭据只存于 Cloudflare Secret，不写入节点配置、日志或诊断输出。
- 网关密钥通过 `Authorization: Bearer` 或 `x-api-key` 头传递，不要放进 URL。
- `/health`、`/metrics` 与 `/v1/*` 都需要鉴权。
- 发现漏洞请走 GitHub 私密报告（Security → Report a vulnerability），不要开公开 Issue。完整规则见 [SECURITY.md](SECURITY.md)。

## License

MIT License，详见 [LICENSE](LICENSE)。
