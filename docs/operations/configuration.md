# 配置

生产配置由 GitHub Actions 下发到 Cloudflare Workers。非敏感的账号配置应放在仓库 Variables 中；凭据应放在 Secrets 中。Cloudflare Dashboard 不是日常配置的规范来源。

## 配置来源

| 来源 | 用途 |
| --- | --- |
| `AIG_TIER{1,2}_NODES_01..10` | 现行两层非敏感账号/节点定义；原 Tier 3 仅用于历史迁移预检，禁止作为运行时变量 |
| `AIG_TIER{1,2}_CREDENTIALS_01..10` | 私有执行中心按 Tier + 节点 ID 绑定的静态 Token Secret；原 Tier 3 分片不得直接保留在新运行时 |
| `AIG_ACCESS_KEY_{AIR,PRO,MAX,ULTRA,AGENT}` | 网关访问密钥 |
| `AIG_ACCESS_MODELS_{AIR,PRO,MAX,ULTRA,AGENT}` | 按分组划分的逻辑模型允许列表 |
| `AIG_MODELS_CONFIG` | 可选的逻辑模型元数据/能力声明 |
| `AIG_POLICIES_CONFIG` | 可选策略覆盖；若 `AIG_MODELS_CONFIG` 引用了非内置策略名，必须在此定义同名策略 |
| `AIG_DASHBOARD_MODELS` | 可选的公共仪表盘逻辑模型展示允许列表 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账号标识符；值来自主机仓库 Variable `CLOUDFLARE_ACCOUNT_ID_SECONDARY`（经中央别名注入，该名字需声明在 `.github/deploy.secrets.allowed`） |

`src/config/runtime-vars.ts` 是运行时变量默认值与取值范围的唯一来源。生产发布会在修改 Cloudflare 之前，对推理、感知、生成三个中心统一执行只读预检。策略 `default`、`fast`、`long-reasoning`、`chat` 和 `coding` 由代码内置，无需配置 `AIG_POLICIES_CONFIG`；仅引用其他自定义策略时才需要在该变量中定义。每个中心仍必须有至少一个符合能力要求的真实节点；不能用空节点替代生产能力。

**生产切换状态**：2026-11-09 新两层源码已合并，但不代表线上配置已切换。当前仓库仍保留部署清单，但 `automatic: false` 暂时冻结自动生产派发；历史 Environment 部署请求需独立核实。发布前请按[两层 Tier 生产切换门禁](../architecture/two-tier-cutover.md)确认旧版凭据与中心绑定；不要直接批准等待中的自动部署。边缘缓存只能使用独立的 `AIG_EDGE_CACHE_HMAC_KEY` Secret（至少 32 字符），不得恢复旧会员 Token 密钥。

## 访问分组

五个相互独立的分组为 `AIR`、`PRO`、`MAX`、`ULTRA` 与 `AGENT`。已配置的分组需同时使用以下两项：

```text
AIG_ACCESS_KEY_<GROUP>
AIG_ACCESS_MODELS_<GROUP>
```

分组之间不相互继承。空的或缺失的模型允许列表，对每个分组（包括 `AGENT`）都意味着零个模型授权。分组名称仅是授权边界，不会为 Tier 1 调度器分配优先级。

## 节点配置

节点 JSON 描述的是一个账号/端点，而非协议实现细节。

必填字段（Required fields:）：

```text
id
provider
base_url
models
```

可选字段：

```text
priority
```

示例：

```json
{
  "id": "node-01",
  "provider": "<registered-provider-id>",
  "base_url": "https://provider.example/v1",
  "priority": 10,
  "models": {
    "<logical-model-id>": "<upstream-model-id>"
  }
}
```

规则：

- `id` 须匹配 `^[a-z0-9][a-z0-9-]{0,63}$`，并且全局唯一。
- `tier` 不是节点字段；由变量名前缀决定其所属的 Tier。
- 凭据绝不会出现在节点 JSON 中。
- `provider`、`base_url` 与 `models` 为必填项。任何节点都必须显式声明 `base_url`，不得使用旧会员订阅回退端点。
- 除非显式启用了不安全的 HTTP，否则 `base_url` 必须是绝对的 HTTPS 地址。
- 若提供了 `priority`，它必须是非负整数。Tier 2 可以使用它；Tier 1 不会将静态节点 priority 用作 P2C 评分。
- `models` 是一个从逻辑模型到上游模型的映射对象。`{}` 仅表示有意设置的、受目录约束的通配符。
- `protocol`、`surfaces`、`limits`、凭据字段以及其他未知字段均会被拒绝（`protocol`, `surfaces`, `limits`, credential fields, and other unknown fields are rejected）。

当前只有一种节点结构。不保留任何备用或兼容的 schema。

被拒绝的节点只排除它自己：其余可用节点继续服务，网关状态为 `degraded`，原因列在 `/health` 的 `diagnostics` 中；只有一个可用节点都没有时才是 `invalid`。重复的 node id 或重复定义的凭据有歧义，该 id 的所有副本都会被排除。任何配置错误都会让部署预检失败（参见[故障排查](troubleshooting.md#网关处于-degraded-或-invalid-状态)）。

### Tier 2 API Token 节点

Tier 2 只接受静态 API Token。节点必须声明 `id`、`provider`、`base_url` 和 `models`，不得包含 `auth`、OAuth 登录信息或直接内嵌的凭据。上游 Token 只存放在对应的私有中心 `AIG_TIER2_CREDENTIALS_XX` Secret 分片中。

## Provider wire profiles（提供商线协议配置）

协议与 API surface 属于 Provider 的能力，并且仅在 provider 适配器注册表（`src/providers/registry.ts`）中定义一次：

- `provider: "anthropic"` → Anthropic 协议，`messages` surface。
- `provider: "openai"` → OpenAI 协议，`chat_completions` 与 `responses` surface。
- 其他 provider → OpenAI 兼容的 `chat_completions` surface。

运行时归一化会将这些协议/surface 事实添加到 `RuntimeNode` 中；账号级的节点 JSON 不会覆盖它们。

若某个 Provider 需要不同的线协议契约，应修改其在 `src/providers/` 中的 provider 适配器。不要在每个账号中重复声明结构性的协议/surface 字段。

OpenAI Responses 同样参与跨协议翻译；三个协议 surface 两两互转（规范化 IR 矩阵），内置默认链为：

```json
{
  "anthropic:messages": ["openai:chat_completions", "openai:responses"],
  "openai:chat_completions": ["anthropic:messages", "openai:responses"],
  "openai:responses": ["anthropic:messages", "openai:chat_completions"]
}
```

## 凭据分片

凭据分片是以节点 id 为键的 JSON 对象：

```json
{
  "nvidia-01": "credential-value",
  "nvidia-02": "credential-value"
}
```

Config 与 Secret 的分片后缀相互独立（independent）。绑定依据是 **Tier + node id**，而非分片后缀的匹配。

## Tier 角色

路由顺序固定为：

```text
Tier 1 → Tier 2
```

- Tier 1：免费或实际上免费的容量；可靠性工作的主要关注点。
- Tier 2：静态 API Token 额度池，作为免费池耗尽后的最终兜底。

## 旧会员订阅层退役

旧会员订阅代理、OAuth、Token 刷新及专有适配器已删除。所有 `/oauth/*` 路由返回 404。旧 `AIG_OAUTH_*`、`AIG_TOKEN_ENCRYPTION_KEY` 和 `AIG_IS_SUBSCRIPTION_ENABLED` 配置被拒绝，不可重新启用。

将原 Tier 3 静态 Token 迁移到新 Tier 2 之前，在受保护环境中给 `npm run config:cutover:plan` 提供旧 Tier 1/2/3 节点、节点 ID 凭据索引、`AIG_POLICIES_CONFIG` 和 `AIG_MODELS_CONFIG`（不存在时显式提供空对象）。报告核对 Tier 2 静态 Key 保留、OAuth 节点退役、ID/凭据引用冲突、模型映射指纹和策略额度改写；不输出上游模型名或凭据值。它无法验证不同节点是否引用了相同真实 Secret 值。系统不会自动读取、复制或删除旧生产 Secret，也不会更改历史 D1 迁移记录。

## 运行时变量

当前的数值型可调参数由 `src/config/runtime-vars.ts` 负责：

- `AIG_UPSTREAM_HEADER_TIMEOUT_MS`
- `AIG_FIRST_EVENT_TIMEOUT_MS`
- `AIG_STREAM_IDLE_TIMEOUT_MS`
- `AIG_RATE_LIMIT_COOLDOWN_MS`
- `AIG_AUTH_FAILURE_COOLDOWN_MS`
- `AIG_REQUEST_BODY_MAX_BYTES`
- `AIG_FAILOVER_BUDGET_MS`
- `AIG_HEDGE_DELAY_MS`
- `AIG_REQUEST_HEDGE_MAX`
- `AIG_ACCESS_KEY_RPM`
- `AIG_AUTH_ATTEMPT_RPM`
- `AIG_EDGE_CACHE_TTL_SEC`

`AIG_AUTH_FAILURE_COOLDOWN_MS` 默认 1 小时，是凭据失效时的冷却时长：401 直接使用它；Tier 1 的 403 先走 `0 -> 60s -> 10m` 的模型级阶梯，连续多次才达到它（参见[可靠性模型](../architecture/reliability-model.md#冷却与半开恢复)）。

`AIG_REQUEST_BODY_MAX_BYTES` 默认 20 MiB，最大 32 MiB。它限制的是单个请求；多个大请求同时进入同一个 isolate 时，另有一个 32 MiB 的「在途请求体」预算（按声明的 `Content-Length` 计）。实测一个请求在准备阶段占用的内存约为请求体的 2–3 倍（文本、解析后的 JSON、发往上游的副本），而一个 Worker isolate 只有约 128 MB；超出就会整个 isolate 被终止，连同其中所有请求、流与学到的 Tier 1 状态。因此超过预算的新请求会收到可重试的 503（`Retry-After: 1`，错误码 `gateway_body_budget_exhausted`）；没有其他请求在途时，单个达到上限的请求总能进入。声明了有效 `Content-Length`（有限且大于 0）的请求体按该值计入预算；没有有效 `Content-Length`（缺失、非数字或不大于 0，例如分块传输）的请求体按最坏情况计入，即 `AIG_REQUEST_BODY_MAX_BYTES`；没有请求体的请求不计入预算。请求体会先作为文本读取再解析，超大请求更容易触及 Worker 的内存上限；除非上游确实需要，否则不要提高该值。超过 256 KiB 的请求不参与边缘缓存，超过 1 MiB 的请求不启动 hedge。未修改的 native 请求直接复用原始 JSON 文本，避免二次 `JSON.stringify`；超过 1 MiB 的原始文本在构建或发出首个上游请求体后释放，不跨流式响应或后续重试保留；大型流式响应提交后，已解析的请求体及协议转换后的请求体也会被释放，避免在整个流期间保留 prompt 树。

边缘缓存只响应显式 `x-gateway-cache: true` 的请求；`temperature: 0` 不会自动启用缓存。`AIG_EDGE_CACHE_TTL_SEC` 控制 Cache API 条目寿命，默认普通配置为 4 小时；启用 `AIG_COST_GUARDS` 且未显式设 TTL 时为 1 小时，设为 `0` 时跳过查找和写入。缓存键使用当前请求域名，并包含路由、模型、请求体、流式选择、key group 和由独立 `AIG_EDGE_CACHE_HMAC_KEY` 派生的调用凭据指纹。流式与非流式响应不共享条目。只有安全的 200 JSON 或协议终止完整的 SSE 流会缓存；工具调用、畸形/截断/不完整输出、观察超限和超过 256 KiB 的响应都不会存储。客户端取消会停止缓存填充。命中与未命中响应发送给客户端时都使用 `Cache-Control: private, no-store`，内部条目使用显式 `public, max-age`。Cloudflare Cache API 是按数据中心本地缓存，不会在不同数据中心间复制；生产部署需使用支持 Cache API 的自定义域名。轮换 `AIG_EDGE_CACHE_HMAC_KEY` 会改变调用凭据指纹，使旧缓存条目不再匹配。

`AIG_RATE_LIMIT_COOLDOWN_MS` 是 Tier 2 节点在 429 未携带任何提示时的回退等待时间。Tier 1 不使用它：Tier 1 的 key 遵循自适应阶梯 `15s -> 30s -> 1m -> 2m -> 5m -> 10m -> 20m -> 30m`（参见[可靠性模型](../architecture/reliability-model.md#429-处理)）。若要修改该阶梯，请将 `AIG_RATE_LIMIT_STEPS_MS` 设置为以逗号分隔的毫秒数，例如 `15000,30000,60000,300000`。除非某个 provider 需要不同的设置，否则请保持其未设置；缺失或格式错误的值会保持默认值。

当 429 被分类为短期窗口类（分钟级限流，依据响应措辞或不超过 90 秒的显式等待提示）时，Tier 1 改用封顶 5 分钟的温和阶梯 `15s -> 30s -> 45s -> 1m -> 1.5m -> 2m -> 3m -> 5m`；若要修改该阶梯，请将 `AIG_RATE_LIMIT_WINDOW_STEPS_MS` 设置为同样格式的逗号分隔毫秒数（默认阶梯、长期配额起步与分类规则见[可靠性模型](../architecture/reliability-model.md#429-处理)）。同样地，缺失或格式错误的值会保持内置窗口阶梯。

当 429 被分类为长期配额类（小时级、日级窗口，依据响应措辞，或不低于 10 分钟的显式等待提示）时，Tier 1 使用长期配额阶梯 `5m -> 10m -> 20m -> 30m`，并让整个 key 一起冷却。这类窗口要等 provider 重置才会恢复，但 Tier 1 最多只冷却 30 分钟：provider 声明的等待（`Retry-After`、正文里的 "resets in 4 hours"）超过 30 分钟时也只冷却 30 分钟，之后由单次恢复探测确认，避免已经恢复的 key 在池外白白多待几个小时。被归为短期窗口类的 429（例如每分钟限额）不会升级为长期配额类，只会停留在封顶 5 分钟的窗口阶梯上。若要修改长期配额阶梯，请将 `AIG_RATE_LIMIT_QUOTA_STEPS_MS` 设置为同样格式的逗号分隔毫秒数，例如 `300000,600000,1200000,1800000`；运营者显式写入的阶梯按原样使用，缺失或格式错误的值会保持内置阶梯。

超时与 hedge 的内置默认值会随请求体大小和回复方式自适应（参见[可靠性模型](../architecture/reliability-model.md#随请求体大小自适应)与[路由模型](../architecture/routing-model.md#hedge)）：请求体超过 50000 字符后，请求预算、响应头等待和首事件等待每 25000 字符各增加 1 秒（上限 45 秒）；非流式请求的响应头等待改为整个 attempt 窗口；内置的 3 秒 hedge 延迟会随大提示词、主节点的 TTFT 以及非流式回复（至少 10 秒）而推后。显式设置 `AIG_HEDGE_DELAY_MS` 或策略的 `hedge.delay_ms` 会按原值使用。

`AIG_PUBLIC_DASHBOARD`（布尔值，默认为 `true`）决定是否公开仪表盘 `/` 与 `/readme-status.svg`；设为 `false` 时返回 404。

其他当前使用的变量还包括：`AIG_CORS_ORIGIN`、`AIG_USAGE_INCLUDE_MODE`、`AIG_USAGE_EXCLUDE_PROVIDERS`、`AIG_ANTHROPIC_COUNT_MODE`、`AIG_LOG_LEVEL`、`AIG_PROTOCOL_FALLBACKS`、`AIG_SHOULD_EXPOSE_UPSTREAM`、`AIG_HAS_STREAM_GUARD`、`AIG_CAN_USE_HTTP` 与 `AIG_DASHBOARD_MODELS`。`AIG_OAUTH_*` 属于已退役配置，见[旧会员订阅层退役](#旧会员订阅层退役)。

`AIG_DIAGNOSTICS_GROUPS` 决定哪些访问密钥分组可以读取 `/health` 与 `/metrics`，逗号分隔、不区分大小写，例如 `ULTRA` 或 `MAX,AGENT`。未设置时默认为 `MAX,ULTRA`；设为 `*` 时所有有效密钥都可读取。其他分组的密钥访问这两个端点会收到 `403`，`/v1/*` 不受影响。部署后的健康检查使用一个允许读取的分组密钥；已配置的密钥中没有任何一个允许读取时，部署预检直接失败。

## 仪表盘模型展示

`AIG_DASHBOARD_MODELS` 是逻辑模型的展示允许列表，以逗号分隔。

示例：

```text
AIG_DASHBOARD_MODELS=<comma-separated logical model IDs from the active catalog>
```

它不会改变路由、授权、`/v1/models`、回退、D1 采集或聚合用量总计。它控制的是：哪些公共逻辑模型会出现在模型状态区域中，以及哪些模型可以在模型用量细分中按名称显示；未在允许列表中的用量会被汇总到「其他」中。

## 容量与可靠性

Tier 1 使用观测到的运行时事实，而非猜测的 Provider 额度：

- 实时 in-flight 工作量；
- 真实的限流响应，包括由失败分类器归一化后的、形如配额的 provider 错误；
- 有界的自适应冷却与 `Retry-After`；
- provider-model 热度；
- 被动 TTFT；
- 软性会话亲和、探索、恢复/熔断状态；
- 可选的显式 `AIG_POLICIES_CONFIG.max_in_flight` 安全上限。

配置 Tier 1 节点时，GitHub 部署预检强制要求 `AIG_AFFINITY_KV_ID`；运行时若未绑定该 KV，亲和会静默禁用，主链路仍可用。生产环境建议至少两个独立 Tier 1 账号，并将 `AIG_ACCESS_KEY_RPM` 设为非 0、为策略设置有限的 `max_in_flight`；这些不是硬编码默认值。

访问密钥分组不会增加路由评分因子。`AIG_ACCESS_KEY_RPM` 用于保护网关访问密钥；它不是 Provider 额度模型。其默认值为 `0`，即不限制；设为正数才会按分组每分钟限制请求数。`AIG_AUTH_ATTEMPT_RPM`（默认 `60`，`0` 关闭）限制鉴权失败的请求，超限返回 429（`gateway_auth_throttled`），详见 [SECURITY.md](../../SECURITY.md#认证失败节流)。

## 策略

示例：

```json
{
  "default": {
    "max_attempts": 5,
    "tier_attempts": null,
    "hedge": { "enabled": true, "tiers": ["tier1"] },
    "headers_timeout_ms": null,
    "first_event_timeout_ms": null,
    "failover_budget_ms": null,
    "max_in_flight": null
  }
}
```

未显式配置时，内置 `chat` 策略最多 3 次逻辑尝试，内置 `coding` 最多 5 次；两者默认关闭 Hedge 并沿用全局超时、调度回退与并发限制。它们是兼顾可靠性和资源占用的安全基线，并非未经实测即断言的全局最优值。`AIG_POLICIES_CONFIG` 可按策略名显式覆盖，运行时和私有中心使用同一份内置定义。\n\n`max_attempts` 是请求级的逻辑 attempt 上限，Tier 上限必须落在该值之内。`headers_timeout_ms`、`first_event_timeout_ms` 与 `failover_budget_ms` 可按策略覆盖全局时序。默认策略会按逻辑模型标识的内置分类选择预算；运营者可在 `AIG_POLICIES_CONFIG` 定义策略，并通过 `AIG_MODELS_CONFIG.<model>.policy` 将当前逻辑模型绑定到策略。模型回退候选仅从当前模型目录中解析，并受请求级 attempt 上限约束；逻辑模型 ID 和上游映射来自配置，不应复制进代码或操作手册。跨 Tier 只支持严格 Tier 优先级；`budget_split`、加权分配及其他 Tier 预算模式会作为未知字段拒绝。

## 请求时序

除非解析后的模型策略提供了 `failover_budget_ms`，否则 `AIG_FAILOVER_BUDGET_MS` 即为一次请求的全局墙钟预算。`AIG_UPSTREAM_HEADER_TIMEOUT_MS` 与 `AIG_FIRST_EVENT_TIMEOUT_MS` 仍是全局的阶段默认值，而模型策略可以用 `headers_timeout_ms` 与 `first_event_timeout_ms` 覆盖它们。Native Tier、协议回退、模型家族回退以及有界复检都不会重置已解析的预算。一次物理 dispatch 会在 header、首个有意义的输出、响应体组装以及有界的诊断读取之间共享同一个绝对 attempt 截止时间。hedge 孪生请求继承该截止时间。

中央部署默认启用已有的请求准入、流式透传、热路径保护、成本保护与恢复探测开关，并将流式和非流式尝试上限都设为 3、每个 isolate 的在途请求上限设为 8、hedge 上限设为 0。部署时的显式变量可以覆盖这些值；直接部署应自行设置对应变量。模型策略仍保留其原有定义，启用 `AIG_REQUEST_ADMISSION` 时再应用尝试上限。这里的并发限制只在单个 isolate 生效，不能当作 provider 的全局额度。

Agent 客户端应让网关承担一次请求内的有限回退，客户端最多补一次有界重试；同一步的重试复用 `x-gateway-deadline-ms`，并遵守 `Retry-After`。不要仅按 HTTP 503/504 判断是否重试，应读取网关错误元数据。Cloudflare 返回的 1102 可能绕过 Worker 的错误处理器：客户端需另外识别资源错误，停止原样重试并保存进度。协议响应头和截止时间的完整说明见[协议模型](../architecture/protocol-model.md#错误信封)。

## 用量计费

仪表盘的用量展示有意将公共服务量与物理上游工作量分开：

- Token 总量使用上游报告的真实物理 Token 消耗，在上游报告了用量时，包括重试/回退/hedge attempt 的消耗；
- public `次请求` counts successfully delivered requests（公共「次请求」统计的是成功交付的请求），因此不会因为内部重试、回退或 hedge 孪生请求而膨胀；
- 模型用量细分可以在其工具提示中显示物理上游调用次数；
- TTFT 的 `samples` 统计近期窗口内带有 TTFT 样本的、成功交付的请求数，不受模型 Token 明细抽样率影响；
- 缺失的上游用量会被记录为缺失，绝不会进行估算。

D1 用量与公共状态仅作为可观测性输入；历史聚合数据不会影响路由决策。

## 部署标识

部署标识是 Git commit SHA，它被注入为 `GITHUB_SHA`，并通过经过认证的 `/health` 以 `build` 字段暴露。若需要命名发布，由人工以 Git tag / GitHub Release 的方式创建。

## 本地校验

```bash
npm run config:check -- --tier1 <tier1-nodes.json> --secrets <secrets.json>
npm run validate:merge
```

`config:check` 需要显式传入文件参数：`--secrets` 必填，且至少提供 `--tier1`、`--tier2` 之一；`--models` 与 `--policies` 可选。
