<div align="center">

# ai-gateway

**基于 Cloudflare Workers 的高韧性 AI API 网关**

把分散在不同 Provider、API Key、额度与模型别名上的容量，汇成 **一个稳定的 OpenAI / Anthropic 兼容入口**

[![CI](https://img.shields.io/github/actions/workflow/status/fongap-labs/ai-gateway/ci.yml?branch=main&label=CI&style=for-the-badge&labelColor=17211f)](https://github.com/fongap-labs/ai-gateway/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/fongap-labs/ai-gateway?label=License&style=for-the-badge&labelColor=17211f&color=0f5d53)](LICENSE)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-0f5d53?style=for-the-badge&logo=cloudflare&logoColor=ffffff&labelColor=17211f)
![API](https://img.shields.io/badge/API-OpenAI%20%7C%20Anthropic-0f5d53?style=for-the-badge&labelColor=17211f)

[快速开始](#快速开始) · [工作原理](#工作原理) · [配置](#配置) · [API](#api) · [文档](#文档地图) · [安全](#安全)

</div>

<p align="center">
  <a href="https://api.135468.xyz/"><img src="https://api.135468.xyz/readme-status.svg?v=20260918-3" alt="维护者实例实时生产运行数据" width="920"></a>
</p>

<p align="center"><sub>上图为维护者真实生产实例的近实时数据，由网关自身渲染，并非合成的基准测试。</sub></p>

## 这是什么

ai-gateway 是一个**私有**的 AI API 网关。你把手里零散的模型容量接进来，客户端只需要一个地址和一把网关密钥，就能调用全部容量。它运行在 Cloudflare Workers（边缘无服务器运行环境）上，面向**家庭、个人运营者或小型可信团队**，不是公共服务。

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
| **客户端** | 使用 OpenAI 或 Anthropic SDK、Claude Code 等工具的程序 |
| **Provider** | 模型服务商，例如 OpenAI、Anthropic 或各类兼容平台 |
| **Key** | 某个 Provider 的上游 API 密钥；同一家可以有多把 |
| **网关密钥** | 你发给客户端的访问密钥（`AIG_ACCESS_KEY_*`），与上游 Key 完全分离 |

| 适合 | 不适合 |
| --- | --- |
| 手里有多个免费额度或多把 Key，希望统一调用 | 公共 SaaS、对外售卖 API |
| 个人或小团队自托管，想同时控制成本与稳定性 | 计费、转售、按用户计量 |
| 同时使用 OpenAI 与 Anthropic 协议的客户端 | 企业级组织、RBAC、多租户控制平面 |

> 产品边界以 [产品策略](docs/governance/product-policy.md) 为准。

## 解决什么问题

真实的 AI 容量很零散：额度不同、同一家有多把 Key、模型会被限流后又恢复、两种协议的接口也不完全一样。普通反向代理解决不了这些问题，ai-gateway 在资源池外层补上**有界**的调度与可靠性控制。

| 常见问题 | ai-gateway 的处理方式 |
| --- | --- |
| 免费额度触发限流（429） | 自适应冷却，到期后单次探测，确认恢复再放量 |
| 某个模型映射失效（404） | 只隔离失败的节点与模型映射，不影响同节点的其他模型 |
| 客户端协议与上游不一致 | OpenAI Chat Completions ↔ Anthropic Messages 有界互转 |
| 流式输出中途切换上游，客户端收到断裂内容 | 有意义的输出提交后，不再透明切换上游 |
| 重试与回退把请求量成倍放大 | 所有 attempt、hedge 与墙钟时间共享一套预算，`max_attempts` 为硬上限 |
| 付费容量被无谓消耗 | Tier 3 只作为受保护的最终兜底，不用来弥补本可避免的 Tier 1 不稳定 |

## 工作原理

### 容量分层

Tier 决定请求先走哪一类容量。三层**严格按序**使用：Tier 1 耗尽或不可用才看 Tier 2，Tier 2 之后才是 Tier 3。

| Tier | 容量类型 | 角色 | 设计重点 |
| --- | --- | --- | --- |
| **Tier 1** | 免费或近似免费的 API 容量 | 日常主力 | 韧性、负载分散、429 恢复、持续可用 |
| **Tier 2** | 订阅权益（Claude Pro/Max、ChatGPT/Codex、Google AI Premium，经 OAuth 接入） | 次级容量 | 订阅适配器；不是第二个通用 Key 池 |
| **Tier 3** | 付费 API 容量 | 受保护的最终兜底 | 可预测、有界、易于推理 |

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

三步共享同一个 `max_attempts`（请求级硬上限）与墙钟时间预算，任何一步都无法放大它。`/v1/responses` 只走原生路径，不参与第 ② 步。

| 约束 | 含义 |
| --- | --- |
| 原生优先 | 先用与客户端同协议的节点，耗尽后才做跨协议回退 |
| 有界回退 | 兼容模型家族最多两轮评估，不存在无界循环 |
| 流式安全 | 有意义的输出提交后，不再切换上游 |
| 亲和只是偏置 | 带 `x-session-id` 的会话优先回到同一账号，但不会绕过冷却或资格检查 |

## 快速开始

### 前置条件

| 需要 | 用途 |
| --- | --- |
| Node.js ≥ 22.18.0 | 运行安装与校验脚本（版本以 `package.json` 为准） |
| Cloudflare 账户 | 部署 Worker，并绑定 D1（SQLite 数据库）与 KV（键值存储） |
| 至少一个上游 Key 或订阅 | 没有上游凭据，网关无法转发任何请求 |

### 安装

```bash
git clone https://github.com/fongap-labs/ai-gateway.git
cd ai-gateway
npm ci
sh scripts/install.sh          # Windows: powershell scripts/install.ps1
```

安装脚本是交互式的，依次询问以下内容：

| 步骤 | 你需要提供 | 说明 |
| --- | --- | --- |
| 1 | Worker 名称 | 直接回车使用默认值 |
| 2 | Tier 1 亲和所用的 KV 命名空间 ID | 32 位十六进制字符串，需先在 Cloudflare 中创建 |
| 3 | 各 Tier 的节点配置（JSON 文件） | Tier 1 必填；Tier 2、3 可留空 |
| 4 | 节点凭据（JSON 文件） | 形如 `{ "节点 id": "凭据" }`，只进入 Secret |
| 5 | 网关访问分组 | 每组一把 `AIG_ACCESS_KEY_*` 加一份模型允许列表，至少配置一组 |
| 6 | 网关公网地址 | `https://` 开头，OAuth 回调与仪表盘需要 |

脚本会自动生成订阅 token 的加密密钥 `AIG_TOKEN_ENCRYPTION_KEY`，无需手动填写。若填写了部署后的地址，脚本还会请求 `/health` 与 `/v1/models` 做线上验证。

### 接入客户端

把客户端的 base URL 指向网关，密钥换成网关访问密钥。模型名使用**逻辑模型名**（例如 `code-pro`，需在该密钥所属分组的模型列表内），而不是上游的真实模型名。

```bash
# OpenAI 协议（Chat Completions / Responses）
OPENAI_BASE_URL=https://<你的网关>/v1
OPENAI_API_KEY=<YOUR_GATEWAY_KEY>

# Anthropic 协议（Messages，例如 Claude Code）
ANTHROPIC_BASE_URL=https://<你的网关>
ANTHROPIC_AUTH_TOKEN=<YOUR_GATEWAY_KEY>
```

仪表盘首页（`/`）的快速开始区域会按你的分组生成同样的配置，可以直接复制。

## 配置

### 配置来源

| 变量 | 作用 | 存放位置 |
| --- | --- | --- |
| `AIG_TIER{1,2,3}_NODES_01..10` | 节点定义：provider、地址、模型映射 | 普通变量 |
| `AIG_TIER{1,2,3}_CREDENTIALS_01..10` | 上游凭据，按节点 id 绑定 | Secret |
| `AIG_ACCESS_KEY_{AIR,PRO,MAX,ULTRA,AGENT}` | 网关访问密钥 | Secret |
| `AIG_ACCESS_MODELS_{AIR,PRO,MAX,ULTRA,AGENT}` | 该分组允许调用的逻辑模型 | 普通变量 |
| `AIG_POLICIES_CONFIG` | attempt、hedge、超时与 Tier 1 准入策略（可选） | 普通变量 |

`01..10` 只是分片编号。配置分片与凭据分片彼此独立（independent），凭据按 **Tier + node id** 绑定到节点，不按相同的后缀一一对应。完整的变量清单见 [配置文档](docs/operations/configuration.md)。

### 节点与凭据

节点描述一个账号或端点；凭据单独存放。

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
| `id` | 是 | 节点唯一标识，小写字母、数字与连字符 |
| `provider` | 是 | 决定协议：`anthropic` → Messages，`openai` → Chat 与 Responses，其余 → OpenAI 兼容 Chat |
| `base_url` | 是（订阅节点可省略） | 必须是 HTTPS 地址 |
| `models` | 是 | 逻辑模型 → 上游模型的映射 |
| `priority` | 否 | 静态优先级，仅 Tier 2、3 使用；Tier 1 的调度忽略它 |

凭据文件只包含节点 id 与密钥的对应关系：

```json
{ "nvidia-01": "<UPSTREAM_API_KEY>" }
```

> 凭据绝不写入节点配置。节点配置中出现的凭据字段会被直接拒绝。

### 访问分组

- 五个分组（`AIR`、`PRO`、`MAX`、`ULTRA`、`AGENT`）互不继承，各自拥有一把密钥和一份模型列表。
- 模型列表为空或缺失，意味着该分组**不能调用任何模型**，包括 `AGENT`。
- 分组只决定能调用哪些逻辑模型，不参与 Tier 1 的调度评分。

### Tier 2 订阅接入

订阅节点让你把自己的 Claude、ChatGPT/Codex 或 Google AI 订阅作为 Tier 2 容量使用。凭据不写进配置，而是通过 OAuth（PKCE 授权码流程）接入，token 加密后存入 D1。

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
| 3 | Claude 与 Codex 自动回调完成；Google 需要把页面给出的授权码粘贴回网关 |
| 4 | 网关以 AES-GCM 加密保存 token，调度时按需解析，并在过期前自动刷新 |

> **运营风险**：订阅节点以供应商自家命令行客户端的身份调用其订阅端点，可能违反该供应商的服务条款，供应商也可能对账号限流、暂停或封禁。是否启用由运营者自行决定并承担风险。设置 `AIG_IS_SUBSCRIPTION_ENABLED=false` 可整体关闭该功能。详见 [SECURITY.md](SECURITY.md#订阅代理与-provider-条款)。完整示例见 [配置 - Tier 2 订阅](docs/operations/configuration.md#tier-2-订阅oauth)。

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
| `GET` | `/` | 公开仪表盘 | 公开，可用 `AIG_PUBLIC_DASHBOARD=false` 关闭 |

## 运行与观测

项目目前处于**稳定期**：除非真实生产数据证明存在结构性问题，否则不再调整架构。日常关注的是下面这些真实信号：

| 信号 | 为什么看 |
| --- | --- |
| 真实 429 | 判断 Tier 1 的冷却与恢复机制是否跟得上 |
| fallback / hedge 放大 | 确认重试与对冲没有把请求量成倍放大 |
| D1 写入量 | 控制用量统计的存储与写入成本 |
| TTFT（首 token 延迟） | 发现长尾延迟与被降权的节点 |

已知边界如下：

| 边界 | 实际行为 |
| --- | --- |
| 全局限流 | 内置 RPM 限流只在单个 Worker 实例内生效，并按分组计算。需要严格的全局限流时，在 Cloudflare WAF 中叠加 Rate Limiting |
| Provider 全局配额 | 网关不宣称跨实例一致的上游额度；自适应状态只在实例内尽力而为，实例重启即清空 |
| 用量数据 | D1 中的 token 用量属于可观测性数据，不参与路由决策 |

## 文档地图

| 你想了解 | 去这里 |
| --- | --- |
| 系统边界、请求流程与模块职责 | [架构概览](docs/architecture/overview.md) |
| 路由、回退与 Tier 1 调度 | [路由模型](docs/architecture/routing-model.md) |
| 失败分类、冷却与恢复 | [可靠性模型](docs/architecture/reliability-model.md) |
| 协议转换与流式边界 | [协议模型](docs/architecture/protocol-model.md) |
| 订阅适配器契约 | [订阅模型](docs/architecture/subscription-model.md) |
| 配置项与变量清单 | [配置](docs/operations/configuration.md) |
| 生产部署与回滚 | [部署](docs/operations/deployment.md) |
| 故障排查 | [故障排查](docs/operations/troubleshooting.md) |
| 本地运维脚本 | [scripts/README.md](scripts/README.md) |
| 产品范围与治理规则 | [产品策略](docs/governance/product-policy.md) · [治理索引](docs/governance/README.md) |
| 参与贡献 | [CONTRIBUTING.md](CONTRIBUTING.md) |
| 报告安全问题 | [SECURITY.md](SECURITY.md) |

## 安全

- 上游凭据只存放在 Cloudflare Secret 中，不写入节点配置、日志或诊断输出。
- 客户端的 `Authorization` 与 cookie 不会转发到上游；上游默认只允许 HTTPS，重定向不携带凭据。
- 网关密钥通过 `Authorization: Bearer` 或 `x-api-key` 头传递，请勿放入 URL 查询参数。
- `/health`、`/metrics` 与 `/v1/*` 都需要鉴权。发现漏洞请使用 GitHub 私密报告（Security → Report a vulnerability），不要开公开 Issue。

完整规则见 [SECURITY.md](SECURITY.md)。

## 贡献与治理

- 本仓库继承 Fongap Labs 的[共享治理](https://github.com/fongap-labs/action-worker/tree/main/docs)；项目专有规则位于 [docs/governance](docs/governance/README.md)。
- 变更保持小步、聚焦。涉及行为、配置、协议或部署的改动，必须在同一 PR 中更新对应的规范文档。
- 测试套件位于 `fongap-labs/action-worker` 的 `tests/packs/ai-gateway/`，由中央 CI 运行。

提交前在本地运行两条校验：

```bash
npm run validate:merge   # 语法、配置、迁移、密钥扫描、文档与链接、lint、类型检查
npm run check:deploy     # Worker 产物的 dry-run
```

## 术语速查

| 术语 | 含义 |
| --- | --- |
| **Tier** | 容量层级：Tier 1 免费、Tier 2 订阅、Tier 3 付费 |
| **节点（Node）** | 一个上游账号或端点的配置单元 |
| **逻辑模型** | 客户端看到的模型名（如 `code-pro`），映射到各节点的真实上游模型名 |
| **访问分组** | `AIR`、`PRO`、`MAX`、`ULTRA`、`AGENT` 之一，决定网关密钥可调用的逻辑模型 |
| **原生（Native）** | 与客户端同协议的上游路径，是网关的首选 |
| **回退（Fallback）** | 当前候选失败后，转向下一个候选、另一协议或兼容模型 |
| **Hedge（对冲请求）** | 主请求在约定延迟内仍未提交时，并行发出的备份请求（默认 3 秒） |
| **TTFT** | Time To First Token，首个 token 到达所用的时间 |
| **P2C** | Power of Two Choices，随机取两个候选、比较综合评分后择一的负载均衡算法 |
| **亲和（Affinity）** | 同一会话尽量回到同一账号的软性偏置 |
| **isolate** | Cloudflare Worker 的一个运行实例；网关的短期状态只保存在 isolate 内 |
| **PKCE** | OAuth 授权码流程的防截获扩展，订阅接入使用它 |
| **D1 / KV** | Cloudflare 的 SQLite 数据库 / 键值存储 |

## License

MIT License，详见 [LICENSE](LICENSE)。
