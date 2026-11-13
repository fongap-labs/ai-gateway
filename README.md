<div align="center">

# AI Gateway

**基于 Cloudflare Workers 的自托管 AI API 网关，将多个模型提供方、密钥和额度汇聚为统一的 OpenAI / Anthropic 兼容入口。**

[![CI](https://img.shields.io/github/actions/workflow/status/fongap-labs/ai-gateway/ci.yml?branch=main&label=CI&style=flat-square&labelColor=1D3F45)](https://github.com/fongap-labs/ai-gateway/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/fongap-labs/ai-gateway?label=License&style=flat-square&labelColor=1D3F45&color=0f5d53)](LICENSE)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-0f5d53?style=flat-square&logo=cloudflare&logoColor=ffffff&labelColor=1D3F45)

[快速开始](#快速开始) · [配置说明](docs/operations/configuration.md) · [部署文档](docs/operations/deployment.md) · [安全策略](SECURITY.md)

</div>

## 这是什么

AI Gateway 面向个人、家庭和可信小团队，适合把多家服务商提供的免费额度和付费 API Token 整合到自己的网关。客户端使用一个网关地址和自己的访问密钥，无须持有上游密钥。

它不是公共 API 转售服务，也不提供用户计费、多租户组织或企业级权限管理。**自托管不等于零成本**：Cloudflare 资源用量、上游 API 费用与额度限制由运营者自行承担。

## 核心能力

| 能力 | 当前实现 |
| --- | --- |
| 统一接口 | 提供 OpenAI Chat Completions、Responses 和 Anthropic Messages 接口；按请求能力进行协议转换 |
| 分层调度 | 按 Tier 1（免费 API Key）→ Tier 2（付费 API Token）选择可用节点 |
| 故障恢复 | 根据限流、额度和上游故障实施冷却、重试与回退；允许同一逻辑模型跨协议回退及兼容模型家族回退 |
| 权限与隔离 | 使用网关密钥和独立模型允许列表，对 AIR、PRO、MAX、ULTRA、AGENT 五个分组授权 |
| 运行观测 | 提供健康检查、运行指标、仪表盘及可选 D1 用量存储；统计覆盖范围受配置和资源限制影响 |

~~~mermaid
flowchart LR
    A["客户端请求"] --> B{"密钥有效且<br/>模型已授权？"}
    B -- 否 --> X["拒绝请求"]
    B -- 是 --> C["Tier 1<br/>免费容量"]
    C -- 成功 --> F["返回结果"]
    C -. 不可用 .-> D["Tier 2<br/>付费 API Token"]
    D -- 成功 --> F
    D -. 不可用 .-> G["返回错误"]
    classDef primary fill:#0f5d53,stroke:#0f5d53,color:#ffffff
    classDef neutral fill:#e7f0f1,stroke:#0f5d53,color:#17211f
    class B,F primary
    class A,C,D,X,G neutral
~~~

图示为容量顺序，不代表无限次重试。请求共享尝试次数和时间预算；**流式响应开始输出后不会再透明切换上游**。不同接口和模型能力可能限制回退路径。

## 四个计算 Worker + Operations（共五个 Worker）

```mermaid
flowchart LR
    Client[客户端] --> Gateway[Gateway：鉴权、额度与路由]
    Gateway -->|私有 Service Binding| Inference[Inference Center：文本推理]
    Gateway -->|私有 Service Binding| Perception[Perception Center：图像识别]
    Gateway -->|私有 Service Binding| Generation[Generation Center：图片生成]
    Gateway --> Stats[(共享用量 D1)]
    Operations[Operations：定时维护] --> Stats
```

- Gateway 只处理鉴权、额度、调度、限流和故障恢复，不直接请求 Provider。
- Inference、Perception 和 Generation 三个私有中心按能力执行，分别持有对应 Provider 凭据；Gateway 通过 Service Binding 调用它们。
- Operations 只运行定时维护，通过共享 D1 汇总和保留用量数据；它没有公开请求路由，也不持有 Provider 凭据。
- 调度固定为 Tier 1 免费 API Key → Tier 2 API Token；会员 OAuth 与第三层 Tier 不属于当前运行时。

这描述的是仓库架构和离线发布合同。生产 Cloudflare 上的 Worker 存在性、健康状态、Secret 所有权、Service Binding、D1/KV 与 Cron 交接必须依据最新只读盘点和运行证据核验；源码合并或 Mock 通过不等于生产切换完成。当前仓库保持 `.github/deploy.json` 的 `automatic:false`。操作步骤见[四 Worker 迁移与回滚计划](docs/operations/center-migration-plan.md)及[Cloudflare 只读盘点说明](docs/operations/cloudflare-read-only-inventory.md)。

## 快速开始

需要 Node.js **22.18.0 或更高版本**、Cloudflare 账户、一个可用的上游节点，以及部署后可访问的 HTTPS 域名。直接部署需要创建并绑定名为 `TIER1_AFFINITY` 的 Cloudflare KV 命名空间；D1 用量统计为可选功能。

~~~bash
git clone https://github.com/fongap-labs/ai-gateway.git
cd ai-gateway
npm ci
npm run cf:login
~~~

部署前按以下顺序完成配置：

1. 参考 [节点示例](config/tier1-nodes.example.json) 准备自己的节点 JSON，并为需要静态凭据的节点准备本地凭据 JSON；节点配置不得包含密钥。
2. 参考 [本地配置示例](wrangler.user.jsonc.example) 创建不提交到 Git 的 `wrangler.user.jsonc`，配置 Worker、`TIER1_AFFINITY` 绑定，以及按需使用的 D1 与域名。
3. 配置 `AIG_TIER1_NODES_01` 等节点变量、`AIG_TIER1_CREDENTIALS_01` 等凭据密钥，以及至少一组 `AIG_ACCESS_KEY_<GROUP>` 与 `AIG_ACCESS_MODELS_<GROUP>`。节点 Config 和凭据 Secret 的分片相互独立，按 **Tier + 节点 ID** 关联，无需按分片后缀对应；分组之间不继承模型权限。
4. 按 [配置文档](docs/operations/configuration.md) 校验全部生产变量、密钥和部署条件；旧三层生产配置必须先运行两层迁移预检再做受控切换。

完成配置后，使用自己的文件路径运行：

~~~bash
npm run config:check -- --tier1 ./my-nodes.json --secrets ./my-secrets.json
npm run deploy
~~~

`config:check` 只校验本地节点与凭据文件，不会自动把它们上传到 Cloudflare。`npm run deploy` 是运营者的直接部署入口；仓库正式生产环境采用 [Action Worker 中央 CI、受控部署和回滚](docs/operations/deployment.md)，不应使用直接部署绕过其门禁。

### 验证与客户端接入

~~~bash
curl https://your-gateway.example/health/ready
curl -H "Authorization: Bearer YOUR_MAX_OR_ULTRA_KEY" https://your-gateway.example/health
curl -H "Authorization: Bearer YOUR_GATEWAY_KEY" https://your-gateway.example/v1/models
~~~

`/health/ready` 公开返回构建 SHA、就绪状态和降级标记，不含节点或诊断明细；部署与回滚用它验证版本。详细的 `/health` 和 `/metrics` 默认仅允许 MAX、ULTRA 分组读取，可通过 `AIG_DIAGNOSTICS_GROUPS` 调整。`/v1/models` 仍需网关访问密钥，并仅展示该密钥获准访问的模型。客户端使用当前模型目录中已配置的逻辑模型 ID，而不是必然使用上游原始模型名。

| 客户端协议 | 网关地址 | 请求入口 |
| --- | --- | --- |
| OpenAI 兼容 | `https://your-gateway.example/v1` | `/chat/completions`、`/responses`、`/models` |
| Anthropic 兼容 | `https://your-gateway.example` | `/v1/messages`、`/v1/messages/count_tokens` |

客户端将原始服务商密钥替换为网关访问密钥。实际环境变量名依客户端而定；接入细节参见 [配置说明](docs/operations/configuration.md)。

真实上游验收不能只依赖中央 CI：现有 `npm run validate:merge` 检查离线合同，不访问生产 Provider。先确认线上 `/health/ready` 的构建 SHA 与目标发布相符，再在**受控环境**中运行现有的真实 HTTP 验收脚本（它会发起实际文本推理请求）：

~~~bash
# 先在本地安全地设置 AIG_ACCESS_KEY_MAX，切勿将密钥写入命令参数或日志。
node scripts/check-live-gateway-capabilities.mjs \
  --url https://your-gateway.example \
  --chat-model YOUR_LOGICAL_TEXT_MODEL
~~~

脚本还支持 `--vision-model`、`--delegate-model` 和 `--responses-delegate-model` 验证实际图片输入；`--failover-model` 可观察故障转移，但只有在受控故障节点池中配合 `--expect-dispatches` 才能据此证明多次真实派发。**图片生成必须显式传入 `--run-image --image-model ...`，可能产生上游费用**。这些真实测试需要网关 URL、对应分组的访问密钥及可用的上游节点；脚本不会自行获取生产凭据，也不自动发布。CPU、内存、D1/KV 用量仍须结合 Cloudflare 账户侧运行指标验证，测试通过不等于免费配额充足。

## 安全与运行边界

上游凭据和网关访问密钥必须放在 Secrets 中，不得写入仓库、节点 JSON 或请求网址。`/health/ready` 仅返回最小发布就绪信息并公开；详细的 `/health`、`/metrics` 和模型接口要求鉴权。**仪表盘 `/` 和状态图 `/readme-status.svg` 默认公开**，不希望公开时设置 `AIG_PUBLIC_DASHBOARD=false`。

Tier 2 仅接受静态 API Token，不使用会员登录或 OAuth；可用性受付费 API 额度、服务商限额和上游状态约束。KV、D1 或边缘资源达到限额时，部分共享状态及统计能力可能退化；不要把网关视为零故障或零成本服务。

## 文档与贡献

| 内容 | 文档 |
| --- | --- |
| 系统架构、路由与协议 | [架构概览](docs/architecture/overview.md) · [四 Worker 边界](docs/architecture/edge-capability-boundaries.md) · [路由模型](docs/architecture/routing-model.md) · [协议模型](docs/architecture/protocol-model.md) · [源码迁移记录](docs/architecture/module-boundaries.md) |
| 配置与故障排查 | [配置](docs/operations/configuration.md) · [故障排查](docs/operations/troubleshooting.md) |
| 部署、CI 与回滚 | [部署](docs/operations/deployment.md) |
| 贡献、安全及全部文档 | [贡献指南](CONTRIBUTING.md) · [安全策略](SECURITY.md) · [文档索引](docs/README.md) |

## 许可证

本项目以 [MIT 许可证](LICENSE) 发布。第三方组件仍遵循各自的许可条款。
