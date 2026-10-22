# 部署

生产部署使用共享的 Action Worker 执行平面。本仓库负责产品代码、部署清单（deploy manifest）、校验以及 Cloudflare 部署入口。Action Worker 负责源码准入、CI 证据（CI Evidence）、主分支写入来源证明（provenance）、runner 解析、GitHub Environment 绑定、密钥范围控制以及部署编排。

## 生产路径

```text
Pull Request
    ↓
Action Worker PR Governance
    ↓
validate-merge
    ↓
squash 合并到 main
    ↓
ai-gateway .github/workflows/ci.yml
    ↓ 仅做薄分发
Action Worker Central CI
    ↓
CI Evidence + Main Write Guard
    ↓
.github/deploy.json
    ↓
Action Worker Deploy Source Script
    ↓ environment: production
scripts/deploy.sh
    ↓
预检 + 部署校验
    ↓
Cloudflare Worker 部署
    ↓
按精确源码 SHA 进行健康验证
    ↓
成功 / 部署失败时回滚 Worker
```

源码仓库不拥有单独的生产部署工作流。部署契约声明于 `.github/deploy.json` 中：

```json
{
  "schema_version": "1",
  "adapter": "source-script",
  "automatic": true,
  "ignore_docs_only": true,
  "runner_profile": "production-deploy",
  "environment": "production",
  "entrypoint": "scripts/deploy.sh"
}
```

清单表达的是部署意图。它本身并不授予 runner 访问权限、凭据或生产环境的操作权限。

## 自动部署

在中央 CI 对当前默认分支 HEAD 运行成功之后，Action Worker 会解析源码所有的部署清单。只有同时满足以下条件，才会进行自动部署：

- 源码 SHA 是当前默认分支的 HEAD；
- 仓库具备中央 `deploy` 能力；
- 受信任的 Action Worker `CI Evidence` 为成功；
- Main Write Guard 证明该源码经过了受治理的合并路径；
- 清单中 `automatic: true`；
- 所选的 runner profile 解析到特权信任域；
- 当 `ignore_docs_only: true` 时，本次变更不仅限于文档。

Pull Request 的 CI 不会触发生产部署。

## 中央手动部署

Action Worker 的 `Deploy Source Script` 工作流可以手动启动，参数如下：

```text
source_repository = fongap-labs/ai-gateway
source_sha        = <精确的 40 位当前 main SHA>
```

手动执行并非绕过校验的途径。同样的源码、CI Evidence、Main Write Guard、部署清单、runner、Environment 与密钥范围检查全部适用。

## 生产 Environment

部署清单将执行作业绑定到名为 `production` 的 GitHub Environment。非敏感的运行时配置应放在 Variables 中；凭据应放在 Secrets 中。

Action Worker 会导出解析后的 Variables，并且只暴露源码声明的部署 Secrets。`.github/deploy.secrets.allowed` 定义了应用密钥的最大暴露范围。在 `scripts/deploy.sh` 执行之前，中央控制凭据会被移除。

核心生产 Variables 包括：

- 可选的 `AIG_IS_DEPLOY_ENABLED=false` 紧急开关（kill switch）；
- `CLOUDFLARE_ACCOUNT_ID`；
- `AIG_PUBLIC_URL`；
- 至少一个 `AIG_TIER{1,2,3}_NODES_XX` 分片；
- 配置 Tier 1 节点时所需的 `AIG_AFFINITY_KV_ID`（GitHub 部署预检强制要求；运行时缺失时亲和自动禁用，主链路仍可用）；
- 可选的 `AIG_ALLOW_DEGRADED=true`：显式允许带着被排除的节点继续部署（默认拒绝）；
- 可选的 `AIG_USAGE_D1_ID`；
- 可选的 `AIG_ANALYTICS_DATASET`：Workers Analytics Engine 数据集名称（字母、数字、下划线，最长 64 个字符），设置后部署会添加 `GATEWAY_EVENTS` 绑定，参见[跨 isolate 调用分析](#跨-isolate-调用分析)；
- 对应的 `AIG_ACCESS_MODELS_{AIR,PRO,MAX,ULTRA,AGENT}`；
- 可选的 `AIG_MODELS_CONFIG`、`AIG_POLICIES_CONFIG` 以及其他运行时 Variables。

核心生产 Secrets 包括：

- `CLOUDFLARE_API_TOKEN`；
- 已配置的 `AIG_ACCESS_KEY_{AIR,PRO,MAX,ULTRA,AGENT}`；
- 按 Tier 划分范围的 `AIG_TIER{1,2,3}_CREDENTIALS_01..10`；
- 使用加密订阅凭据时所需的 `AIG_TOKEN_ENCRYPTION_KEY`。

`CLOUDFLARE_ACCOUNT_ID` 的值不是 Secret，而是由中央策略别名注入：`policies/deploy-secrets.json` 将 `CLOUDFLARE_ACCOUNT_ID` 映射到主机仓库的 `CLOUDFLARE_ACCOUNT_ID_SECONDARY` Variable。由于 `resolve-secret-scope` 只对 target 在 `.github/deploy.secrets.allowed` 中声明的名字应用别名，该名字必须保持在列表中——列表声明的是可注入的环境变量名，而不是"已存储的 Secret 清单"。

当必需的生产输入缺失时，应用预检会失败即关闭。

预检还会拒绝 `degraded` 配置：只要已声明的节点因缺少凭据、字段非法或 URL 非法而被排除，部署就会失败，避免容量静默减少。确实需要带着减少后的容量上线时，显式设置 `AIG_ALLOW_DEGRADED=true`，并在部署摘要与 `/health` 中确认 `nodes_usable/nodes_total`、`nodes_excluded` 和 `degraded`。部署后的健康检查同样默认拒绝 `degraded`，并会重试三次后回滚。配置错误（被拒绝的分片、冲突的节点、无效的模型/策略/回退/OAuth 设置）与容量减少不同：运行时会绕开它们继续服务，但预检总是拒绝部署，`AIG_ALLOW_DEGRADED` 不会放行它们。

## 跨 isolate 调用分析

`/health` 与 `/metrics` 只反映响应它们的那一个 isolate，无法回答「每个免费 key 用了多少、被限流多少次、多少请求靠重试或 hedge 才成功」。设置 `AIG_ANALYTICS_DATASET` 后，网关对**每一次真实的上游调用**写入一条 Workers Analytics Engine 数据点；未设置、绑定缺失或写入失败时网关行为完全不变。这些数据只用于观测，不参与路由。

| 位置 | 内容 |
| --- | --- |
| `index1` | node id（采样键） |
| `blob1`–`blob7` | node id、provider、tier、逻辑模型、结果（`ok` 或失败类别，如 `rate_limit`、`server`）、角色（`primary`、`hedge`、末位同 key 重试 `retry`）、路由 |
| `double1`–`double4` | 上游 HTTP 状态（无响应为 0）、响应头耗时、首个有意义输出耗时、该次调用耗时（毫秒，未知为 -1） |

流式请求的 `ok` 表示已提交首个有意义输出；提交之后的中断仍记在网关日志里。

用 [Analytics Engine SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/) 查询（需要具有 Account Analytics 读取权限的 API Token）。例如最近一天每个 key 的调用结果分布：

```sql
SELECT blob1 AS node, blob5 AS outcome, SUM(_sample_interval) AS calls
FROM gateway_events
WHERE timestamp > NOW() - INTERVAL '1' DAY
GROUP BY node, outcome
ORDER BY node, calls DESC
```

把 `gateway_events` 换成你设置的数据集名称。按 `blob6` 分组可以看出重试与 hedge 带来的额外上游调用占比。

## Cloudflare 免费套餐预算

网关按 Workers Free 设计。下表列出免费额度（按账号每天计，UTC 0 点重置）、网关的消耗方式，以及超出后的表现。数字来自 Cloudflare 公布的免费额度；CPU 一行是在 Node（与 workerd 同为 V8，但不是同一运行时）上实测的估计值。

| 资源 | 免费额度 | 网关的消耗 | 超出后 |
| --- | --- | --- | --- |
| Workers 请求 | 100,000 次/天 | 每个客户端请求一次，`/health`、`/metrics` 等诊断请求也计入 | 请求被 Cloudflare 拒绝，直到重置 |
| CPU 时间 | 每次请求 10ms | 解析与改写请求体的开销随请求体增长：按原样转发时约每 MB 2–3ms，需要重新序列化（模型别名、协议转换）时约每 MB 5ms，4 MB 约 22ms | 该请求被 Cloudflare 终止 |
| KV 读取 | 100,000 次/天 | 会话亲和：带 `x-session-id` 且至少两个 Tier 1 key 能服务时，每个会话每 5 秒最多一次；共享冷却：每个活跃 isolate 首个请求一次，此后每 5 分钟最多一次 | 读取失败视为没有数据：不偏置、不写入，冷却只在本地生效 |
| KV 写入 | 1,000 次/天 | 会话亲和：新会话首次成功、闲置超过 30 分钟后再来、迁移到另一个 key 时各一次；共享冷却：只在学到新的长时间冷却时一次 | 写入失败，亲和与冷却共享退化为仅本地 |
| D1 写入行数（可选 `AIG_USAGE_D1_ID`） | 100,000 行/天 | 每次上游调用约 3 行（小时、总计、小时×模型） | 用量统计写入失败，不影响请求 |
| Analytics Engine（可选 `AIG_ANALYTICS_DATASET`） | 100,000 个数据点/天 | 每次上游调用一个 | 写入失败不影响请求 |

据此：

- 长上下文请求是免费套餐上最先撞到的限制。多 MB 的请求可能超过 10ms CPU 而被终止，尤其是经过模型别名或协议转换时；客户端应控制上下文大小。
- 每个请求都换一个新 `x-session-id` 的客户端，每个请求都会写一次 KV，会很快用完每天 1,000 次写入，并连带让冷却共享失效。要么保持会话 ID 稳定，要么不发送该头。
- 开启 D1 统计时，每天约 33,000 次上游调用就会用完写入额度（重试与 hedge 也计入）。

## 源码自有的部署入口

`scripts/deploy.sh` 通过 `DEPLOY_SOURCE_SHA` 接收经过准入的精确源码 SHA。它会依次：

1. 遵守紧急部署开关；
2. 要求提供完整的、不可变的源码 SHA；
3. 安装锁定的 Node 依赖；
4. 运行 `npm run validate:deploy` 与 `npm run check:deploy`；
5. 准备 Cloudflare 部署配置与密钥载荷；
6. 通过固定版本的 Wrangler 包装器进行部署；
7. 按精确的源码 SHA 验证线上构建；
8. 若部署后验证失败，则回滚 Worker 部署。

Cloudflare 是执行目标，而不是配置的规范编辑入口。

## 节点凭据绑定

Config 与 Secret 分片是相互独立（independent）的分区。运行时绑定依据是 **Tier + node id**，而非分片后缀的匹配。

添加或轮换上游 key 的步骤：

1. 将节点保留在相应的 `AIG_TIER*_NODES_XX` Variable 中；
2. 在该 Tier 的任一 Secret 分片中，以相同的节点 id 添加或更新其凭据；
3. 由下一次受治理的部署重新构建运行时配置。

不要将凭据放入节点 JSON 中。

## 网关访问分组

```text
AIG_ACCESS_KEY_AIR       + AIG_ACCESS_MODELS_AIR
AIG_ACCESS_KEY_PRO       + AIG_ACCESS_MODELS_PRO
AIG_ACCESS_KEY_MAX       + AIG_ACCESS_MODELS_MAX
AIG_ACCESS_KEY_ULTRA     + AIG_ACCESS_MODELS_ULTRA
AIG_ACCESS_KEY_AGENT     + AIG_ACCESS_MODELS_AGENT
```

已配置的密钥若其模型允许列表为空或缺失，则会失败即关闭，且授予零个模型的访问权限。

## 验证与回滚

已部署的 Git commit SHA 会被传入 Worker 构建。经过认证的 `/health` 会暴露该构建标识。

部署后验证要求线上构建与经过准入的精确源码 SHA 一致，随后再校验必需的网关接口。健康检查失败会触发 Worker 回滚。

D1 迁移不会因 Worker 回滚而被事务性地撤销。因此，迁移变更必须在部署与回滚的边界两侧都保持安全。

## 本地/运营者生命周期

本地直接部署仍是运营者路径，与受治理的 GitHub 生产路径相互独立：

- `npm run deploy`——从已配置好的检出副本直接部署；
- `npm run cf:login`、`npm run cf:whoami`、`npm run tail`——Cloudflare 运营者命令。

所有直接的 Cloudflare CLI 调用都通过 `scripts/cloudflare-wrangler.mjs` 进行。受版本控制的 `wrangler.jsonc` 仍是仓库基线；本地覆盖配置应放在被 git 忽略的 `wrangler.user.jsonc` 中。

## 仓库保护

`validate-merge` 是 PR 阶段必需的合并权威。生产部署属于合并之后的执行环节，不是 PR 的必需检查项。

仓库设置参见 [github-repository-settings.md](github-repository-settings.md)；运行时配置语义参见[配置](configuration.md)。
