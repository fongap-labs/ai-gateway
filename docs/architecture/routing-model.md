# 路由模型

路由受 **protocol + surface + model + tier** 四个维度约束。Native 请求只能进入其 provider 适配器支持当前 protocol 与 surface 的运行时节点；转换后的回退请求，只有在转换成功之后，才会进入目标协议池。

Tier 顺序是产品级不变式：

```text
Tier 1 → Tier 2 → Tier 3
```

Tier 1 是免费或实际上免费的容量，也是日常的主要层级。Tier 2 是订阅权益容量（通过 OAuth 接入的 Claude/Codex/Gemini 订阅）。Tier 3 是付费 API 容量，作为受保护的最终回退保留。

OpenAI Chat Completions ↔ Anthropic Messages 回退仅在 native 路由耗尽之后才会评估。OpenAI Responses 在候选耗尽后同样参与跨协议翻译（经规范化的 IR 矩阵，与 Chat/Messages 回退同预算）。

## 模型注册表、Provider Registry 与节点

模型注册表（Model Registry）将逻辑模型的知识划分为两类不同的概念：目录事实（能力、推理强度、模态）与运行时策略（故障转移策略绑定、可见性、UI 分组）；扁平的 `AIG_MODELS_CONFIG` 运营者 schema 保持不变。`src/providers/registry.ts` 中的 provider 适配器注册表负责 protocol 与可路由 surface（以及 stream-usage 特例、OAuth 接入默认值和订阅可 dispatch 性）。账号级 Node Config 负责 provider 名称、base URL、逻辑→上游模型映射、可选的静态 priority 以及凭据绑定；运行时归一化会将这些事实合并为可路由的 `RuntimeNode`。

节点的 `limits`、`protocol` 与 `surfaces` 均不属于账号 schema（Node `limits`, `protocol`, and `surfaces` are not part of the account schema）。Provider 的容量来自运行时观测到的信号，而非运营者提供的 RPM/并发数猜测值。

凭据按 **Tier + node id** 绑定。Config 与 Secret 的分片后缀是相互独立（independent）的分区编号。

静态节点 `priority` 对 Tier 2/3 有意义，而 Tier 1 的 P2C 会有意忽略它。网关访问分组（Gateway access groups）只授权逻辑模型（access groups only authorize logical models）；它们不会影响 Tier 1 的候选评分。

## 客户端模型拼写解析

已知模型目录（Known Model Catalog）是模型存在性的唯一来源。客户端可接受的功能性拼写差异被视为**同一个**逻辑目录条目的别名（aliases），而不是不同的模型身份：

- Claude Code 会把官方上下文长度标记写进模型字符串（例如 `Code-Ultra[1m]`，表示同一模型的 1M-token 变体）；客户端之间的大小写也可能不一致（如 `Code-Max` 与配置里的 `code-max`）。
- preflight 在授权与路由之前，把客户端拼写解析到配置的目录条目上：剥掉 `[数字m]` 形态的上下文长度标记，并把大小写折叠到配置拼写。访问分组的 allowlist 匹配同样对大小写宽容。
- 解析**绝不**发明目录里不存在的模型：客户端写出目录或该 key 的 allowlist 中没有的名字时，仍然走原来的 fail-closed 路径（未知模型 404、key 无权限 403），边界判定从不放宽。
- 解析后的目录拼写会贯穿 fallback 规划与调度，且来自已知目录，fallback 和 family 语义不因拼写差异而改变。
- 同一逻辑模型在 `AIG_MODELS_CONFIG` 与各节点 `models` 中若仅大小写不同，会归并为一个目录条目：规范拼写优先取 `AIG_MODELS_CONFIG` 中的写法，否则取首次出现的写法；各节点的 `models` 键随之改写为规范拼写。同一节点把两种写法映射到不同上游时，该节点被视为配置歧义并被排除。

## 逻辑模型家族回退

逻辑模型回退独立于协议回退。协议回退改变同一逻辑模型的线协议/surface；家族回退改变逻辑模型本身，同时保留客户端路由与请求的模型标识。

家族成员资格由最终的能力等级推导。每个前置的名称段都会作为逻辑家族前缀保留，因此新增家族无需修改源码。

```text
<family>-Ultra → <family>-Max → <family>-Pro
<family>-Max   → <family>-Pro → <family>-Ultra
<family>-Pro   → <family>-Max → <family>-Ultra
<family>-Air   → <family>-Pro → <family>-Max → <family>-Ultra
```

同样的规则也适用于无前缀的 `Ultra / Max / Pro / Air`。例如 `Code-*`、`Audit-*`，以及任何未来在已知模型目录中暴露出匹配同级层级的家族。

回退绝不跨越家族前缀。`Air` 可以在其家族内向上移动；`Ultra / Max / Pro` 绝不会向下回退到 `Air`。若未配置兼容的同级模型，则请求的逻辑模型保持原有的单模型行为，并使用由策略负责的 attempt 预算。

`max_attempts` 是请求级的硬上限（`max_attempts` is the request-wide hard ceiling），家族规划绝不会提高它。第一轮家族分配先横向扩展、再纵向加深。兼容家族至多获得一轮有界的第二轮评估，且该轮只能使用同一请求中剩余的预算。

每一轮模型评估都会先执行 Tier 1 → Tier 2 → Tier 3 的 native 路由，并在已配置的情况下，对同一有效模型执行受支持的跨协议回退。模型切换绝不会产生新的逻辑 attempt、dispatch、hedge 或墙钟预算。

模型形态的 404 会隔离失败的节点/模型映射。经授权的兼容同级模型仍可能在同一请求预算内被尝试。

家族重试规划感知故障域：配置在同一节点/账号上、并解析为同一上游模型的别名，会共享一个请求内的故障域。该故障域一旦耗尽，便不会再通过别名消耗额外的逻辑 attempt，也不会为未来的请求预留虚假的墙钟逃逸时间；唯一的例外是计划用尽之后的[末位同 key 重试](#末位同-key-重试)。

全部为瞬时失败、且家族有界规划耗尽的情况是可重试的；这意味着请求计划已经用尽，但并不代表部署中的每个账号都已被证实不可用。

## Tier 1: Eligibility → Affinity → P2C（资格 → 亲和 → P2C）

Tier 1 没有独立的 attempt 上限（Tier 1 has no independent attempt cap）。它使用请求级预算、可选的显式逐层上限、当前的可 dispatch 性以及墙钟故障转移预算。

```text
Eligibility（资格）
   ↓
软性会话 Affinity（亲和）
   ↓
P2C 采样
   ↓
有界评分比较
   ↓
实时 inFlight 记录
   ↓
真实上游请求
   ↓
被动 TTFT / 失败状态更新
```

不存在全池延迟排序。

### Eligibility（资格）

一个 Tier 1 节点必须：

- 为 `tier-1`；
- 匹配 protocol 与 surface；
- 服务于请求的逻辑模型；
- 未被禁用，且不处于活动中的账号/模型/上游模型冷却之中；
- 未被本模型的半开单次探测状态阻塞（同一 key 上其他模型的在途请求不计入）；
- 若运营者明确配置了正数的 `max_in_flight` 上限，则需满足该上限。

热度保护仅用于排序，绝不会把最后一个健康候选变成人为的硬失败。

### 软性会话亲和（Soft session affinity）

客户端可以提供 `x-session-id`（8–128 个字符）。网关会先对其进行哈希，然后再在 `TIER1_AFFINITY` 中存储 Tier 1 的账号绑定。

亲和是评分偏置，而非粘性路由。它不能绕过资格、冷却或健康状态。

读取亲和不会拖慢请求：KV 读取最多等待约 50ms，超时就当作没有绑定（这次也不会覆盖它），晚到的结果仍会写入 isolate 缓存供下一个请求使用。KV 读取失败（例如超出每日读取额度）同样视为绑定未知：不偏置、不缓存、不覆盖，因此不会变成每个请求一次写入。能服务该请求的 Tier 1 key 少于两个时没有可选的对象，会话头被忽略，不读也不写 KV。

### P2C 评分

当存在多个候选时，Tier 1 会从中采样两个不同的可用账号，并选择有界评分较低者。评分信号包括：

- 按账号/模型统计的被动 TTFT；
- 当前的 in-flight 压力；
- 半开恢复状态；
- 软性亲和；
- 对未观测节点的探索；
- provider + 上游模型的多 key 限流热度。

成功率不是正向的路由奖励。访问密钥分组名称是授权类别，而非调度器的优先级类别。

### 被动 TTFT

TTFT 仅从真实请求中学习。未知节点仍然可用，并获得有界的探索机会。Tier 1 不运行任何后台延迟探测。

## Tier 1 热度保护

Tier 1 利用可观测的运行时事实分散负载，而非依赖猜测的 provider 额度。

### 实时 in-flight 压力

当前的 in-flight 工作量是一个软性的排序信号：一个 key 上有 n 个在途请求时，它的评分是空闲时的 (n + 1) 倍，类似「延迟 × 在途数」的均衡器。有界的 TTFT 因子仍让更快的 key 分到更多请求，但没有哪个 key 会仅仅因为快就包揽全部流量，而是按速度比例与空闲的同级 key 分担，避免把单个免费 key 打到限流。当没有其他替代时，繁忙的 key 仍然可用。

### provider-model 限流热度

在一个较短的时间窗口内，不同 key 的限流证据会在 isolate 本地按 `(provider, 上游模型)` 进行聚合。它只影响排序：不会产生 provider 级的冷却，也不会移除最后一个健康候选。

若某些 provider 使用非 429 的状态码来表示吞吐限制，当错误响应体明确标识为速率/吞吐配额时，可靠性分类会将其归一化。普通的客户端负载错误保持其客户端错误语义。

### 亲和衰减与 hedge 门控

当实时压力或热度上升时，对亲和的偏好会向中性值衰减。Tier 1 的 hedge 孪生请求属于可选的延迟优化工作，在剩余容量较低时会让位于主流量。

### 刻意的限制

Tier 1 不会增加以下机制：

- 成功率奖励加权；
- 访问分组优先级加权；
- 猜测的动态 provider 并发上限；
- 跨 isolate 的全局协调；
- 额外的容量字段；
- 硬性移除最后一个健康的主候选。

## Tier 2 与 Tier 3

Tier 2/3 使用独立的 `node-state.ts` 可靠性模型以及既有的选择器。它们可以考虑静态 priority、活动请求负载、健康/熔断状态、冷却与延迟偏好。

Tier 2/3 不消费 Tier 1 的 TTFT、亲和或 provider-model 热度状态。

它们的产品角色保持明确而狭窄：Tier 2 是订阅权益容量；Tier 3 是付费 API 兜底。在没有实测需求的情况下，不要把 Tier 1 的机制复制到它们之中。

## Attempt 分配

跨 Tier 的分配模型只有一个（There is exactly one cross-tier allocation model）。

`max_attempts` 是请求级的逻辑 attempt 上限（即 request-wide logical-attempt ceiling）。`tier_attempts` 可以显式地限制各个 Tier 的 attempt 数。对于每一轮 model/protocol 评估：

1. 没有可 dispatch 候选的 Tier 分配到零；
2. 首先应用显式的 `tier_attempts` 上限；显式设为零即禁用该 Tier；
3. 在预算允许的前提下，其余可 dispatch 的 Tier 按严格的 Tier 1 → Tier 2 → Tier 3 顺序，各分得一次 attempt 的基线；
4. 其余所有剩余 attempt 分配给第一个可调整的、可 dispatch 的 Tier。

候选数量只影响**Tier 内部**的选择，绝不会把请求预算从更高的 Tier 上重新分配走。

当前 schema 中不存在 `budget_split`、加权分配或其他跨 Tier 预算模式（There is no `budget_split`, weighted allocation, or alternate cross-tier budget mode in the current schema）。

模型家族回退与协议回退共享同一个硬性的 `max_attempts` 与墙钟边界。

### 末位同 key 重试

同一请求内，每个节点在一次失败后默认被排除。只配一个 Tier 1 key 时，这意味着 `max_attempts` 形同虚设：一次偶发的 5xx 就会直接变成 502。因此在整个请求计划（native、协议回退、模型家族）都已用尽之后，网关会对**最近一次 Tier 1 瞬时失败**的那个 key 再重试**一次**。条件全部满足才会触发：

- 失败类别是 `server`、`network`、`headers_timeout`、`first_event_timeout` 或 `stream_interrupted`，且发生在 native attempt 上（不是协议转换后的 attempt）；
- 仍有未用完的逻辑 attempt（`max_attempts` 仍是硬上限）；
- 剩余墙钟预算长于那次失败本身花掉的时间；
- 该 key 仍可调度（例如熔断已打开时不会重试）。

429、401/403、400 等客户端错误永远不会触发这次重试。每个请求最多重试一次。

## 故障转移预算

`AIG_FAILOVER_BUDGET_MS` 限制整个请求的墙钟时间；默认值为 60 秒。协议回退与模型家族回退都不会获得新的时钟。

attempt 分配器会为后续的请求计划机会保留有界的逃逸时间，而不是把整个预算平均分配。存活的候选与可达的兼容家族轮次都参与该保留时间的计算。已知的重复故障域会从未来的保留规划中剔除。

每一次物理 dispatch 都会获得一个绝对的 attempt 截止时间。Header 等待、首个有意义的输出、响应组装以及有界的非 2xx 诊断响应体读取，都在该截止时间之内完成。hedge 孪生请求继承主逻辑 attempt 的截止时间。

## Hedge

当当前的逻辑 attempt 在配置的延迟之前仍未提交时，反应式 hedge 会启动一个孪生请求。`AIG_HEDGE_DELAY_MS` 默认为 3 秒；设为 0 则禁用。

3 秒只是短对话的下限。大提示词（见[可靠性模型](reliability-model.md#随请求体大小自适应)）或 TTFT 本来就很长的主节点，几乎每个请求都会超过 3 秒，导致每次都对第二个 key 重复发送：上游负载翻倍，限流余量被健康的请求白白消耗，反过来推高 429。因此未显式配置延迟时，内置延迟会取以下各项的最大值：主节点 TTFT EWMA 的 2 倍、请求体大小余量，以及非流式回复的 10 秒下限，其中自适应部分上限 20 秒。运营者通过 `AIG_HEDGE_DELAY_MS` 或策略 `hedge.delay_ms` 显式设置的延迟按原值使用，不做自适应。

- 孪生请求属于同一个逻辑 attempt；
- 它消耗一次物理 dispatch，但不消耗另一个逻辑 attempt 名额；
- 它使用与主请求相同的 protocol 与 surface；
- 在对端已提交后被取消的失败方属于中性结果；
- 真实的超时/服务端失败仍计为真正的失败；
- Tier 1 的孪生请求还需通过剩余容量门控。

## 容量信号

节点级配置的 RPM/并发限制不属于 schema。活动路由使用：

- 实时 in-flight 压力；
- 真实的限流证据与 `Retry-After`；
- provider-model 多 key 热度；
- 熔断状态与计入的瞬时失败；
- 被动 TTFT；
- 仅当运营者明确掌握真实账号契约时，才使用显式的正数 `max_in_flight`。

`AIG_ACCESS_KEY_RPM` 是独立的，用于保护客户端访问密钥；它并不代表 Provider/节点的容量配置。

失败分类、冷却、恢复与流生命周期的归属，请参阅[可靠性模型](reliability-model.md)。
