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
按精确源码 SHA 验证公开就绪端点
    ↓
成功 / 部署失败时回滚 Worker
```

源码仓库不拥有单独的生产部署工作流。部署契约声明于 `.github/deploy.json` 中：

```json
{
  "schema_version": "1",
  "adapter": "source-script",
  "automatic": false,
  "ignore_docs_only": true,
  "runner_profile": "production-deploy",
  "environment": "production",
  "entrypoint": "scripts/deploy.sh"
}
```

清单表达的是部署意图。它本身并不授予 runner 访问权限、凭据或生产环境的操作权限。

**两层架构切换保护**：AG #312 已合并；在生产凭据和 Inference、Perception、Generation 三个私有中心未验收前，`.github/deploy.json` 的 `automatic` 暂时设为 `false`，停止合并后自动派发生产部署。2026-11-09 核查到 [Action Worker 生产部署请求 #42612960426](https://github.com/fongap-labs/action-worker/actions/runs/42612960426)，其验证作业通过，实际部署作业先进入 `waiting`，随后于 `Resolve deploy Secret plan` 失败，原因是缺少 `CLOUDFLARE_ACCOUNT_ID_SECONDARY` 的受控变量来源；因此没有进入 `scripts/deploy.sh` 和 Cloudflare 发布步骤。未完成旧 Tier 3→新 Tier 2 凭据迁移、私有中心验收、回滚准备和独立生产审批前，不得因补齐该变量而重新发起生产部署。后续部署历史仍需重新核查。详见[两层生产切换检查单](../architecture/two-tier-cutover.md)。

## 自动部署（切换期间已禁用）

在中央 CI 对当前默认分支 HEAD 运行成功之后，Action Worker 会解析源码所有的部署清单。只有同时满足以下条件，才会进行自动部署：

- 源码 SHA 是当前默认分支的 HEAD；
- 仓库具备中央 `deploy` 能力；
- 受信任的 Action Worker `CI Evidence` 为成功；
- Main Write Guard 证明该源码经过了受治理的合并路径；
- 清单中 `automatic: true`；
- 所选的 runner profile 解析到特权信任域；
- 当 `ignore_docs_only: true` 时，本次变更不仅限于文档。

Pull Request 的 CI 不会触发生产部署。仅修改 `docs/` 的合并应由 `ignore_docs_only: true` 排除自动部署；仍需在合并后核对中央调度日志，确认没有将其错误归类为可部署的代码变更。

## 中央手动部署

Action Worker 的 `Deploy Source Script` 工作流可以手动启动，参数如下：

```text
source_repository = fongap-labs/ai-gateway
source_sha        = <精确的 40 位当前 main SHA>
```

手动执行并非绕过校验的途径。同样的源码、CI Evidence、Main Write Guard、部署清单、runner、Environment 与密钥范围检查全部适用。

## 单一部署布局

AI Gateway 只保留根清单 `.github/deploy.json`，其目标环境为 `production`。不能再同时存在 `projects/*/deploy.json`、`projects/*/release.manifest.json` 或 `projects/*/follows.json` 等产品清单；`projects/model-discovery/task.json` 不属于产品清单，仍用于中央任务能力。

已撤销旧 `inference-center-ops` 的源码部署合同，原 `product=inference-center` 不再有效。现有 `scripts/inference-center-deployment.mjs` 仅作为后续复用的构建配置准备工具，不能据此宣称中心已上线。

生产发布使用同一个 `ai-gateway-ops` 环境中的 Cloudflare 发布凭据、内部认证密钥和 Provider 凭据分片。网关访问密钥保存在 Cloudflare Worker Secrets 中。

## 生产 Environment

部署清单的目标为 `production`。Action Worker 使用 `ai-gateway-ops` GitHub Environment 读取扁平配置。节点和其他非敏感配置各自存为 Variables，凭据各自存为 Secrets。

Action Worker 会导出解析后的 Variables，并且只暴露源码声明的部署 Secrets。`.github/deploy.secrets.allowed` 定义了应用密钥的最大暴露范围。在 `scripts/deploy.sh` 执行之前，中央控制凭据会被移除。

核心生产 Variables 包括：

- 可选的 `AIG_IS_DEPLOY_ENABLED=false` 紧急开关（kill switch）；
- `CLOUDFLARE_ACCOUNT_ID`；
- `AIG_PUBLIC_URL`；
- 至少一个 `AIG_TIER{1,2}_NODES_XX` 分片；旧 `AIG_TIER3_*` 不得出现在新运行时；
- 配置 Tier 1 节点时所需的 `AIG_AFFINITY_KV_ID`（GitHub 部署预检强制要求；运行时缺失时亲和自动禁用，主链路仍可用）；
- 可选的 `AIG_ALLOW_DEGRADED=true`：显式允许带着被排除的节点继续部署（默认拒绝）；
- 可选的 `AIG_USAGE_D1_ID`；
- 可选的 `AIG_ANALYTICS_DATASET`：Workers Analytics Engine 数据集名称（字母、数字、下划线，最长 64 个字符），设置后部署会添加 `GATEWAY_EVENTS` 绑定，参见[跨 isolate 调用分析](#跨-isolate-调用分析)；
- 对应的 `AIG_ACCESS_MODELS_{AIR,PRO,MAX,ULTRA,AGENT}`；
- 可选的 `AIG_MODELS_CONFIG`、`AIG_POLICIES_CONFIG` 以及其他运行时 Variables。

生产 Environment 的 Secrets 包括：

- `CLOUDFLARE_API_TOKEN`：部署 Worker、D1 迁移与绑定所需的 Cloudflare 发布凭据；
- `AIG_INFERENCE_AUTH_KEY`、`AIG_PERCEPTION_AUTH_KEY`、`AIG_GENERATION_AUTH_KEY`：Gateway 与三个私有中心之间的内部服务认证密钥；
- `AIG_TIER{1,2}_CREDENTIALS_01` 到 `_10`：每个已使用的分片为一个 Secret，值为 `{ "节点 ID": "Provider API Key" }` JSON 对象。

`CLOUDFLARE_ACCOUNT_ID` 是非敏感账号标识，由中央策略映射到 `CLOUDFLARE_ACCOUNT_ID_SECONDARY`。由于 `resolve-secret-scope` 只对目标在 `.github/deploy.secrets.allowed` 中声明的名字应用别名，三个名称必须与 `.github/deploy.secrets.required` 一致。

部署预检按 Tier 与节点 ID 核对所有私有节点的凭据。私有中心仅接收本中心使用的节点凭据，三个中心认证密钥用于对应的 Service Binding。

普通部署通过 `wrangler secret list` 只读取 Secret 名称和类型；Gateway 必须同时具有 `AIG_INFERENCE_SERVICE`、`AIG_PERCEPTION_SERVICE`、`AIG_GENERATION_SERVICE` 私有绑定和对应内部认证 Secret，并且**不再持有任何 `AIG_TIER{1,2}_CREDENTIALS_XX` 上游 Provider 凭据**；三个能力中心分别持有自身所需的静态 Token Secret。发布前核对应用访问密钥名称。新 Gateway 版本按名称继承现用密钥，排除旧订阅和 Provider 分片。历史版本仍保留原绑定以便回滚。发布后再次校验实际密钥清单。

部署前的静态预检验证变量与绑定；部署后使用无需网关访问密钥的 `GET /health/ready` 核对线上构建 SHA、就绪状态与降级标记。该端点只返回 `build`、`status`、`ready`、`degraded`，不含节点或诊断明细。默认拒绝降级容量；若节点被排除或就绪检查失败，部署会按受控流程回滚 Gateway。本版本**必须同时配置** Inference、Perception、Generation Service Binding 以及各自对应的中心认证 Secret。

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
| KV 读取 | 100,000 次/天 | 会话亲和：带 `x-session-id`（或 Claude Code 的 `x-claude-code-session-id`）且至少两个 Tier 1 key 能服务时，每个会话在每个 isolate 里首次一次，之后每 5 秒最多一次后台刷新；共享冷却：每个活跃 isolate 首个请求一次，此后每 5 分钟最多一次 | 读取失败视为没有数据：不偏置、不写入，冷却只在本地生效 |
| KV 写入 | 1,000 次/天 | 会话亲和：新会话首次成功、闲置超过 30 分钟后再来、迁移到另一个 key 时各一次；共享冷却：只在学到新的长时间冷却时一次 | 写入失败，亲和与冷却共享退化为仅本地 |
| D1 写入行数（可选 `AIG_USAGE_D1_ID`） | 100,000 行/天 | 用量按（类别、小时、模型）在 isolate 内合并；最多每 5 分钟写一批，不因 dashboard 读取而 flush。每批全局最多每类别 2 行（小时与 lifetime），再加本批出现的抽样模型行；未写入的 isolate 缓冲可能在回收时丢失 | 用量统计写入失败，不影响请求 |
| Analytics Engine（可选 `AIG_ANALYTICS_DATASET`） | 100,000 个数据点/天 | 每次上游调用一个 | 写入失败不影响请求 |

据此：

- 长上下文请求是免费套餐上最先撞到的限制。多 MB 的请求可能超过 10ms CPU 而被终止，尤其是经过模型别名或协议转换时；客户端应控制上下文大小。
- 每个请求都换一个新 `x-session-id` 的客户端，每个请求都会写一次 KV，会很快用完每天 1,000 次写入，并连带让冷却共享失效。要么保持会话 ID 稳定，要么不发送该头。
- D1 总量行统计所有已提交的 provider usage；模型 token 明细按 `AIG_TOKEN_D1_SAMPLE_PCT` 抽样且不外推。当前旧版本留下的历史行可能混有不同采样口径，不能恢复成精确总量。每个 isolate 的批次最多每 5 分钟一次，并在窗口后续 usage 写入或该 isolate 的显式 flush 时提交；低流量 isolate 在回收时仍可能丢失未提交缓冲。
- 100,000 行/天是账号共享额度。实际 D1 行写入量取决于同时活跃的 isolate 数、5 分钟批次数、模型数量与上游尝试数；没有生产遥测时，不对实际额度余量作推断。

## 源码自有的部署入口

`scripts/deploy.sh` 通过 `DEPLOY_SOURCE_SHA` 接收经过准入的精确源码 SHA。它会依次：

1. 遵守紧急部署开关；
2. 要求提供完整的、不可变的源码 SHA；
3. 安装锁定的 Node 依赖；
4. 运行 `npm run validate:deploy` 与 `npm run check:deploy`；
5. 准备只包含非敏感变量与绑定的 Wrangler 配置；
6. 在同一受保护流水线中生成 Inference、Perception、Generation 三个中心的配置，校验所有节点的 Provider 凭据后记录 Gateway 的 Cloudflare 版本，依序发布三个**非公开**中心；
7. 为三个中心同步各自的 Provider 分片及内部认证，随后核对 Cloudflare Secret 名称，确认同步完成才继续发布 Gateway；
8. 根据 Gateway Secret 清单生成继承计划，排除旧 OAuth 和已迁移的 Provider 凭据；
9. 不携带 `--secrets-file` 发布 Gateway 代码，保留 Cloudflare 中已有的应用访问密钥；
10. 验证线上 Gateway 的实际 Secret 清单与精确源码 SHA；
11. 若部署后验证失败，只在发布身份仍匹配时回滚到明确的历史版本 UUID，并通过 Cloudflare 核验已恢复的版本。


**统一入口**：仍然只从 Action Worker 的 `手动 · 部署服务` 选择 `fongap-labs/ai-gateway`、`production`，或使用原来经过准入的自动部署触发。禁止另起一个私有中心代码发布工作流。

**首次迁移提示**：由同一次部署建立私有 Worker 并同步 `ai-gateway-ops` 中的 Provider 凭据。部署脚本在失败时报告已尝试更新的中心和 Gateway 阶段。恢复前须核实每个 Worker 的版本并选择兼容 SHA。

Cloudflare 是执行目标，而不是配置的规范编辑入口。

## 节点凭据绑定

Config 与 Secret 分片是相互独立（independent）的分区。运行时绑定依据是 **Tier + node id**，而非分片后缀的匹配。

添加或轮换 Provider API Key 时，在 Action Worker 的 `ai-gateway-ops` 环境中更新同一 Tier 的 `AIG_TIER{1,2}_CREDENTIALS_XX` Secret。该 Secret 的 JSON 键使用节点 Variable 中的原始 `id`。分片编号可以独立分配，例如 `AIG_TIER1_NODES_09` 的节点可以在 `AIG_TIER1_CREDENTIALS_01` 中。同一个节点 ID 只能出现在一个凭据分片中。部署会根据中心路由筛选并同步对应条目。

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

已部署的 Git commit SHA 会被传入 Worker 构建。公开的 `/health/ready` 会暴露该构建标识；完整 `/health` 诊断仍要求授权访问。

部署前，`scripts/deployment-recovery.mjs` 使用 Cloudflare API Token 记录当前 `ai-gateway` 的部署和版本 UUID。回滚目标必须是当前承载 100% 流量的单一版本。旧 Worker 的公开就绪接口和源码 SHA 注记不参与这一步。Wrangler 为本次发布添加 `action-worker:deploy:<SHA>` 注记，发布后核对该注记、版本 UUID 和部署 UUID。

部署后验证要求 `/health/ready` 返回的线上构建 SHA 与准入 SHA 一致，随后再核对 Cloudflare 当前 UUID 与本次发布记录一致，才允许成功审计。就绪检查失败时先确认当前版本仍属于本次发布，再向 Wrangler 传入部署前记录的版本 UUID。Cloudflare 必须确认该历史版本重新承载 100% 流量。即使成功恢复旧版本，发布任务仍为失败。Gateway 代码上传不携带 Secret 值。

**边界**：Cloudflare 版本切换接口不是条件原子写入；在回滚前读取与真正写入之间仍存在极短的外部并发发布窗口。中央单并发调度仅覆盖中央入口，无法为旁路发布提供分布式互斥。遇到已观察到的生产漂移必须拒绝回滚；在证明排他控制之前，这些源码合同不构成真实生产回滚验收。

D1 迁移不会因 Worker 回滚而被事务性地撤销。因此，迁移变更必须在部署与回滚的边界两侧都保持安全。

## 本地/运营者生命周期

本地直接部署仍是运营者路径，与受治理的 GitHub 生产路径相互独立：

- `npm run deploy`——从已配置好的检出副本直接部署；
- `npm run cf:login`、`npm run cf:whoami`、`npm run tail`——Cloudflare 运营者命令。

所有直接的 Cloudflare CLI 调用都通过 `scripts/cloudflare-wrangler.mjs` 进行。受版本控制的 `wrangler.jsonc` 仍是仓库基线；本地覆盖配置应放在被 git 忽略的 `wrangler.user.jsonc` 中。

## 仓库保护

`validate-merge` 是 PR 阶段必需的合并权威。生产部署属于合并之后的执行环节，不是 PR 的必需检查项。

仓库设置参见 [github-repository-settings.md](github-repository-settings.md)；运行时配置语义参见[配置](configuration.md)。
