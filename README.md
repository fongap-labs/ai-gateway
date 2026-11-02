<div align="center">

# AI Gateway

**将分散的 AI 模型、服务商账号与额度，整合为一个自托管的 API 入口。**

基于 Cloudflare Workers，兼容 OpenAI 与 Anthropic 客户端，优先利用免费容量，在失败、限流或额度不足时执行有界回退。

[![CI](https://img.shields.io/github/actions/workflow/status/fongap-labs/ai-gateway/ci.yml?branch=main&label=CI&style=flat-square)](https://github.com/fongap-labs/ai-gateway/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/fongap-labs/ai-gateway?style=flat-square)](LICENSE)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white)

[快速开始](#快速开始) · [配置文档](docs/operations/configuration.md) · [部署说明](docs/operations/deployment.md) · [架构说明](docs/architecture/overview.md)

</div>

## 项目定位

AI Gateway 为**个人、家庭和可信的小团队**管理多个上游账号与模型。客户端只需要网关地址、网关访问密钥和逻辑模型名；上游账号的密钥留在网关侧，不必分发给每个客户端。

项目首先解决免费额度分散、多个账号限流和上游不稳定的问题。订阅权益和付费 API 是后续容量来源，而非默认将每次请求转交给付费服务。

**这不是公共 AI API 平台。** 项目不提供多租户计费、API 转售、企业级组织权限或通用工作流编排。免费容量、订阅权益与付费接口的使用都受服务商规则约束；自托管也不意味着无限额度或零成本。

## 当前能力

| 领域 | 当前实现 |
| --- | --- |
| 统一协议 | 支持 `/v1/chat/completions`、`/v1/responses`、`/v1/messages`；提供 `/v1/models` 和 Anthropic 兼容的近似 token 计数接口 |
| 多层容量 | Tier 1 为免费或实际上免费的容量；Tier 2 为订阅权益；Tier 3 为付费 API 兜底，按顺序评估可调度候选 |
| Tier 1 调度 | 资格过滤、软性会话亲和、双随机选择（P2C）、被动首字延迟、在途压力和限流热度保护 |
| 故障恢复 | 按真实的 429、超时、上游故障与额度提示冷却及恢复；在请求次数和总耗时预算内重试、故障转移及按条件对冲 |
| 模型与协议回退 | 原生协议优先；原生候选耗尽后，可进行已配置的跨协议转换及同家族逻辑模型回退 |
| 订阅适配 | 提供 Anthropic、OpenAI、Google 的 OAuth 接入适配器；是否能使用取决于实际授权、订阅权益及上游条款 |
| 访问控制 | `AIR`、`PRO`、`MAX`、`ULTRA`、`AGENT` 五个独立密钥分组，各自按逻辑模型允许列表授权 |
| 运行观测 | 鉴权健康检查、指标、模型清单、公开仪表盘；可选 D1 用量记录与 Workers Analytics Engine 上游调用数据 |
| 资源保护 | 鉴权失败限流、可选客户端密钥限流、请求体与并发保护、可显式开启的边缘响应缓存 |

**可靠性边界：** 这些机制提高故障恢复能力，不保证每次请求成功。所有重试、协议转换、模型回退和对冲受共同预算约束。流式响应一旦向客户端提交有效输出，便不会再静默切换上游；跨协议转换也不保证保留每项专有能力。

详见[路由模型](docs/architecture/routing-model.md)、[可靠性模型](docs/architecture/reliability-model.md)及[协议模型](docs/architecture/protocol-model.md)。

## 请求如何处理

```text
客户端（OpenAI / Anthropic 兼容）
           │
           ▼
       鉴权与模型授权
           │
           ▼
       原生协议候选
           │
           ▼
   Tier 1 → Tier 2 → Tier 3
           │
           ├─ 成功 → 按客户端协议返回
           │
           └─ 候选耗尽
                ├─ 已启用且可安全转换 → 跨协议回退
                └─ 同家族模型仍可尝试 → 兼容模型回退
                         │
                         └─ 受同一请求预算约束
```

Tier 1 并不是按账号列表顺序轮询，也不把访问密钥分组当作调度优先级。逻辑模型首先尝试请求的模型；需要回退时，依据同家族候选的可用性和负载选择，不跨模型家族，也不会绕过访问密钥授权。`Air` 只能向同家族更高等级回退，其他等级不会回落至 `Air`。

节点只描述账号、提供商、地址与逻辑模型映射。协议及可路由接口由[提供商适配器](src/providers/registry.ts)确定，不能在节点 JSON 中自行添加 `protocol`、`surfaces` 或 `limits` 字段。

## 快速开始

### 1. 准备环境

需要 Node.js **22.18.0 或更高版本**、Cloudflare 账号、至少一个真实可用的上游接口，以及部署所用的 Worker 域名。

```bash
git clone https://github.com/fongap-labs/ai-gateway.git
cd ai-gateway
npm ci
npm run cf:login
npm run cf:whoami
```

### 2. 配置节点与访问权限

以下示例仅说明变量结构；服务商地址、上游模型与密钥都需要替换为实际值。

普通变量 `AIG_TIER1_NODES_01`：

```json
[
  {
    "id": "example-01",
    "provider": "custom",
    "base_url": "https://provider.example.com/v1",
    "models": {
      "code-pro": "upstream-model"
    }
  }
]
```

与之对应的 Secret `AIG_TIER1_CREDENTIALS_01`：

```json
{
  "example-01": "YOUR_UPSTREAM_API_KEY"
}
```

再配置一个网关访问密钥分组，例如：

| 配置项 | 类型 | 示例 |
| --- | --- | --- |
| `AIG_ACCESS_KEY_MAX` | Secret | 自行生成的长随机密钥 |
| `AIG_ACCESS_MODELS_MAX` | 普通变量 | `code-pro` |

访问分组彼此独立，不会自动继承其他组权限；模型允许列表缺失或为空时，该密钥不能调用任何模型。节点与凭据按 **Tier + 节点 ID** 匹配，不要求配置分片与密钥分片的数字后缀一致。

配置参考：[节点示例](config/tier1-nodes.example.json)、[访问密钥示例](config/access-keys.example.json)、[完整配置说明](docs/operations/configuration.md)。不要把真正的上游密钥、网关密钥或 OAuth token 放入节点 JSON、源码或提交记录。

### 3. 准备 Cloudflare 绑定

按[部署说明](docs/operations/deployment.md)准备 Cloudflare 配置和部署所需的 Variables / Secrets。

- 本地直接部署使用不提交到 Git 的 `wrangler.user.jsonc`；可参考[运营者配置模板](wrangler.user.jsonc.example)。直接部署脚本要求实际使用的配置包含名为 `TIER1_AFFINITY` 的 KV 绑定及有效命名空间 ID。
- 直接部署脚本会用标准 JSON 解析器检查运营者配置，因此该文件中不要保留示例模板里的注释。
- D1 用量统计为可选能力；使用 OAuth 订阅时，需额外准备 D1 token 存储、`AIG_TOKEN_ENCRYPTION_KEY`、`AIG_PUBLIC_URL` 和允许发起授权的访问分组。
- 若要使用自定义域名，需在 Cloudflare 中完成域名与路由配置。未配置的第三方上游账号不会由本项目自动创建。

### 4. 校验并部署

准备本地节点和凭据文件后，可先做独立配置校验：

```bash
npm run config:check -- --tier1 ./my-nodes.json --secrets ./my-secrets.json
npm run validate:merge
npm run check:deploy
npm run deploy
```

`config:check` 只检查指定的本地 JSON 文件，**不会上传**节点变量或密钥；真实部署还须事先完成 Cloudflare 配置。`check:deploy` 为本地部署预检，`deploy` 是运营者的直接部署入口，并会在配置 D1 时先执行相应迁移。

本仓库的**正式生产环境**不是用以上命令绕过门禁：代码经 Pull Request、Action Worker 中央 CI、可信主分支校验后，才由受控部署流程执行。具体前置条件与回滚机制见[部署文档](docs/operations/deployment.md)。

## 接入客户端

将客户端的 API 地址指向自己的 Worker 域名，并使用**网关访问密钥**代替上游服务商密钥。客户端发送的是逻辑模型名，例如 `code-pro`，不是必须填写上游的原始模型名。

| 客户端类型 | API 基础地址 | 典型接口 |
| --- | --- | --- |
| OpenAI 兼容 | `https://your-gateway.example/v1` | `/chat/completions`、`/responses`、`/models` |
| Anthropic 兼容 | `https://your-gateway.example` | `/v1/messages`、`/v1/messages/count_tokens` |

部署后可验证：

```bash
curl -H "Authorization: Bearer YOUR_MAX_OR_ULTRA_KEY" \
  https://your-gateway.example/health

curl -H "Authorization: Bearer YOUR_GATEWAY_KEY" \
  https://your-gateway.example/v1/models
```

`/health` 与 `/metrics` 默认只对 `MAX`、`ULTRA` 访问分组开放，可通过 `AIG_DIAGNOSTICS_GROUPS` 修改。`/v1/models` 只展示当前访问密钥获准调用的已配置模型；因此不能将其视为所有上游模型的完整目录。

## 安全和运行边界

- **默认公开内容：** 仪表盘 `/` 与状态图 `/readme-status.svg` 默认可公开访问。私有部署可设置 `AIG_PUBLIC_DASHBOARD=false` 关闭两者。`/health`、`/metrics` 与模型 API 需要鉴权。
- **容量和费用：** Cloudflare Workers、KV、D1、Analytics Engine 与各上游均有独立用量、费用及服务限制。KV 或 D1 写入失败时，相关共享状态或统计可能退化，不等于全部请求不可用。
- **统计口径：** 客户端成功请求数、真实上游调用次数及实际 token 用量并非同一指标；重试和对冲会放大上游调用。跨 isolate 的聚合观测需要相应的持久化或分析配置。
- **可选缓存：** 只有显式携带 `x-gateway-cache: true` 的合适请求才会尝试边缘缓存；缓存依赖 Cloudflare 实际部署条件，不是跨地域共享的统一缓存。
- **订阅授权：** OAuth 适配器不能绕过订阅账号限制或服务商条款，不应将订阅权益理解为无限量的通用 API 配额。

安全漏洞、凭据处理及报告方式见[安全策略](SECURITY.md)；部署问题见[故障排查](docs/operations/troubleshooting.md)。

## 文档索引

| 主题 | 入口 |
| --- | --- |
| 架构与模块职责 | [架构概览](docs/architecture/overview.md) · [仓库布局](docs/architecture/repository-layout.md) |
| 调度、回退及协议 | [路由模型](docs/architecture/routing-model.md) · [可靠性模型](docs/architecture/reliability-model.md) · [协议模型](docs/architecture/protocol-model.md) |
| 订阅权益与 OAuth | [订阅模型](docs/architecture/subscription-model.md) · [配置说明](docs/operations/configuration.md) |
| 部署与排障 | [部署说明](docs/operations/deployment.md) · [故障排查](docs/operations/troubleshooting.md) |
| 观测与数据 | [公开模型状态](docs/operations/public-model-status.md) · [Provider 发现](docs/operations/provider-discovery.md) |
| 开发与治理 | [贡献指南](CONTRIBUTING.md) · [产品策略](docs/governance/product-policy.md) · [完整文档索引](docs/README.md) |

## 许可证

本项目采用 [MIT 许可证](LICENSE)。第三方组件与上游服务仍受各自许可证及服务条款约束。
