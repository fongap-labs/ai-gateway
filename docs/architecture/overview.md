# 架构概览

ai-gateway 是面向家庭、个人运营者或小型可信团队的 Cloudflare Workers AI API 网关。它让一组异构的 AI 容量表现为一个可预期的端点，同时不隐藏协议边界，也不承诺运行时并不具备的全局保证。

产品边界由[产品策略](../governance/product-policy.md)约束。本项目刻意不做公共 SaaS 网关、企业级 API 管理平台、计费系统、转售平台或通用多租户控制平面。

## 设计目标

长期设计优先级如下：

1. 保持 Tier 1（免费 token 容量）稳定、高效、安全、可持续使用；
2. 保证协议正确性与安全性；
3. 为家庭或小型可信团队保持运维简单；
4. 在不掩盖重试、回退放大的前提下，最大化有效的免费容量利用；
5. 为 Tier 2（订阅权益容量）保留接入能力；
6. 将 Tier 3（付费 API 容量）保留为受保护的付费兜底容量；
7. 仅为已有的具体使用场景增加扩展能力。

一项运行时功能应至少改善以下属性之一，且不得实质性地损害其他属性：

- 请求成功率与恢复行为；
- 免费容量利用率；
- 长尾延迟控制；
- 协议兼容性；
- 运行可预测性；
- 安全性；
- Worker 热路径成本。

除非生产证据表明本地塑形不足以解决问题，项目优先采用有界的本地机制，而非全局协调。对于已被取代的机制，项目倾向于直接删除，而不是让新旧实现并行存在。

## Tier 角色

Tier 角色是长期有效的架构边界，而不是泛化的优先级标签。

| Tier | 长期角色 | 设计优先级 |
| --- | --- | --- |
| **Tier 1** | 跨 provider/账号的免费或实际上免费的 token 容量（Free or effectively free token capacity） | 日常主流量；韧性、负载分散、429 恢复、低成本、持续可用 |
| **Tier 2** | 订阅权益容量（Membership/subscription entitlement capacity） | 订阅权益适配器（Claude/Codex/Gemini）；不是第二个通用 API Key 池 |
| **Tier 3** | 付费 API 容量（Paid API capacity） | 受保护的最终兜底；使用可预测且有界 |

因此，Tier 1 获得大部分可靠性工程投入。Tier 2 与 Tier 3 必须保持更简单，在没有明确需求的情况下，不得积累 Tier 1 专用的自适应机制。

## 请求流程

```text
Client
  ↓
鉴权 + 路由/请求体校验
  ↓
请求编排
  ↓
逻辑模型轮次
  ↓
Native 协议/surface 候选池
  ↓
Tier 1 → Tier 2 → Tier 3
  ↓
可选的同一模型 Chat Completions ↔ Anthropic Messages 回退
  ↓
若逻辑模型池已耗尽：有界的兼容模型回退
  ↓
对已恢复的兼容池最多进行一轮复检
  ↓
按协议输出响应 / 流
```

OpenAI Chat Completions 与 Anthropic Messages 均为 Native 优先（Native First）。只有在 native 池耗尽后，才可能执行已配置的跨协议回退。OpenAI Responses 在协议转换方面为仅 Native（Native Only）。

逻辑模型回退是独立的外层编排。封闭家族为 `Code-Max ↔ Code-Pro → Code-Ultra`、`Max ↔ Pro → Ultra`，以及单向的 `Air → Pro → Max → Ultra`。兼容家族最多评估两轮；所有轮次共享原始的 attempt、dispatch、hedge 与墙钟时间预算。`max_attempts` 仍是请求级硬上限，家族回退绝不会将其放大。

## 模块职责

```text
Model Registry     逻辑模型目录事实（能力、推理强度、模态）与运行时策略
                    （故障转移策略绑定、可见性、UI 分组）——两个不同概念，同一注册表
Node config         provider 名称、base URL、逻辑→上游模型映射、
                    可选的 Tier 2/3 priority、凭据绑定、
                    可选的仅 Tier 2 使用的 `auth:"oauth"` 订阅标记
Provider Registry   单一的 provider → 适配器映射：线协议契约
                    （protocol + 可路由 surface）、stream-usage 特例、
                    内置 OAuth 接入默认值，以及订阅请求语义
                    （由 src/subscription 组合而成）
Request             native/协议/模型家族回退编排与共享预算
Scheduler           下一次 attempt 应发往哪个可用节点
Reliability         某个节点/账号/模型当前是否可用，以及失败如何改变其状态
Transport           如何调用所选的上游端点
Protocol            客户端请求校验与协议特定错误
Conversion          受支持的 Chat ↔ Messages 语义桥接
Stream              首事件守卫、SSE 生命周期、提交边界
OAuth               Tier 2 订阅凭据：AIG_OAUTH_PROVIDERS 解析/合并
                    （覆盖 provider 声明的默认值）、PKCE 接入路由、
                    AES-GCM token 存储、dispatch 时解析
Subscription        provider 特定的订阅请求语义：anthropic/openai/
                    google 适配器，通过 provider registry 组合进 provider 适配器；
                    节点级订阅绑定
Observability       日志、指标、D1/token 用量、诊断
Runtime             运行时可用性、只读的公共模型状态，以及覆盖两种状态后端的
                    统一 RuntimeStateStore 读取契约
Dashboard           仅负责展示
```

这些边界是有意设计的。Transport 不选择节点。Scheduler 与 Reliability 不解析 provider 的线协议事件。模型家族回退不替代节点调度或可靠性状态，它只决定当前池耗尽后下一个应评估的兼容逻辑模型。provider registry 是协议/surface 结构与 provider 特定语义的唯一所有者，账号记录不得覆盖它们。OAuth 负责订阅凭据的存储与解析；Scheduler 从不读取 token 存储，解析失败会以 dispatch 前的 auth 轮换形式体现。

## 当前不变式

- 账号级 Node Config 接受 `id`、`provider`、`base_url`、`models`、可选的 `priority`，以及仅 Tier 2 可用的 `auth:"oauth"` 订阅标记；`protocol`、`surfaces` 与 `limits` 会被拒绝。对于 provider 适配器声明了内置订阅端点的 Tier 2 `auth:"oauth"` 节点，`base_url` 可选（配置层从 provider registry 解析该端点）。
- `auth:"oauth"` 仅在 Tier 2 节点上有效；Tier 2 订阅节点不得在 `AIG_TIER{N}_CREDENTIALS_*` 中声明静态凭据（每个节点只能有一个凭据来源）。
- Provider Wire Profile 推导运行时的 protocol/surface：`anthropic` → Messages，`openai` → Chat + Responses，其他所有 provider → OpenAI 兼容 Chat。
- 原生 OpenAI Chat 上游目标为 `/v1/chat/completions`。
- 原生 OpenAI Responses 上游目标为 `/v1/responses`。
- 原生 Anthropic Messages 上游目标为 `/v1/messages`。
- 内置转换矩阵仅包含 OpenAI Chat Completions ↔ Anthropic Messages。
- OpenAI Responses 不进入跨协议转换。
- `Code-Max` 与 `Code-Pro` 是首选可互换的 coding 别名；`Code-Ultra` 是家族级的更高层回退。
- `Max` 与 `Pro` 是首选可互换的通用别名；`Ultra` 是家族级的更高层回退。
- Code 别名绝不会回退到非 Code 别名。
- `Air` 可以向上回退到 `Pro → Max → Ultra`；更高层的通用别名绝不会向下回退到 `Air`。
- 兼容模型家族最多获得两轮评估；不存在无界的模型循环。
- `max_attempts` 是请求级硬上限；模型家族回退绝不会在内部放大它。
- 模型形态的 404 会隔离失败的节点/模型映射；经授权的兼容同级模型仍可能在同一请求预算内被评估。
- Native 重试、协议回退与模型家族回退共享同一套逻辑 attempt 与墙钟故障转移预算。
- hedge 孪生请求保留在主请求的协议与 surface 内。
- Tier 1 使用 Eligibility → 软 Affinity → P2C，并结合被动 TTFT 与有界的热度保护；访问密钥分组不会改变其评分。provider 报告的额度窗口会在此之上增加一层主动机制：报告的接近上限尾部会降低评分，耗尽的窗口会通过预留计数器对准入进行门控（未知额度保持为无操作的直通，因此对于不报告任何信息的 provider，由自适应的 429/冷却路径负责治理）。
- Tier 2/3 与 Tier 1 的自适应状态保持独立。
- Tier 2 订阅（`auth:"oauth"`）凭据在 dispatch 时从 OAuth token 存储中解析：先查 isolate 缓存，仅在缓存未命中或临近过期时才访问 D1，并在 5 分钟的裕量内刷新；解析失败属于 dispatch 前的 auth 轮换，并附带 isolate 本地的否定缓存，以避免故障的订阅反复冲击 provider 的 token 端点。
- Refresh token 轮换安全：每个节点每个 isolate 同时只允许一个进行中的解析（singleflight），刷新结果的持久化只能通过对持久化的 `refresh_version` 进行 compare-and-swap 来完成；失败的写入方会重新加载胜出方的凭据，因此持久化的权威 refresh token 始终只有一个。本设计不引入 Durable Objects。
- Provider 账号身份（例如 OpenAI 的 `account_id`）以明文形式与凭据一同持久化，且仅作为 `chatgpt-account-id` 头用于 OpenAI 协议的订阅 dispatch；它绝不会污染 RuntimeNode 的 schema。
- 没有经过验证的订阅后端的 provider 仍保留 OAuth 接入，但运行时 dispatch 会失败即关闭；它们绝不会落入通用 OpenAI 兼容路径并假装可用。provider registry（`src/providers/`）是唯一的可 dispatch 性权威：`auth:"oauth"` 节点若其 provider 没有订阅适配器，或其适配器拒绝对请求进行整形，则在 dispatch 前轮换。
- 内置的 `google` 订阅适配器负责 Code Assist 私有线协议（`cloudcode-pa.googleapis.com/v1internal` 的 `generateContent`/`streamGenerateContent`）：它在订阅适配器内部（`src/subscription/google-wire.ts`）完成 OpenAI Chat Completions 与 Code Assist 信封之间的双向转换，dispatch 层在成功层消费之前，将成功的上游响应包装为节点的 native 协议结构。私有线协议绝不会进入网关通用的 transport 或 conversion 层（两个 native 协议族保持不变）。
- 订阅额度窗口只是提示，绝非事实：provider 适配器解读权益重置标记（`quotaResetHint`：窗口重置的 epoch 头、resets_in_seconds 响应体），且只能延长 429 限流冷却（有上限）；恢复沿用所有节点共享的路径：冷却到期 → 单次半开探测 → 自动恢复熔断。不存在订阅专用的可靠性状态机。
- 订阅的访问 token 与刷新 token 使用 `AIG_TOKEN_ENCRYPTION_KEY` Worker 密钥进行 AES-GCM 加密；缺少该密钥会禁用全部订阅接入与解析（失败即关闭），token 绝不会以明文形式存入 D1。
- OAuth 接入（`/oauth/start`、`/oauth/callback/<provider>`、`/oauth/paste`）使用 PKCE S256，并配合一次性使用的 D1 流程状态（TTL 10 分钟）；`/oauth/start` 要求网关访问密钥与匹配的 Tier 2 节点，且每次 callback/paste 无论结果如何都会消费其状态行。
- 三个主流订阅 provider（anthropic、openai、google）的内置 OAuth 默认值嵌入了其开源 CLI 的公开常量；`AIG_OAUTH_PROVIDERS` 条目按 provider 整体替换默认值。带有 `manual_redirect_url` 的 provider（Google）使用手动粘贴授权码的流程，因为其 OAuth 客户端不允许任意的网关回调 URI。
- 短生命周期的 scheduler/reliability 状态仅在 isolate 内尽力而为，并随 isolate 一同消失。
- 运行时状态读取（可用性、账号/模型状态、额度）通过统一的 `RuntimeStateStore` 契约（`src/types/runtime-state.ts`）解析，该契约投影于 Tier 1 自适应运行时与 Tier 2/3 节点状态之上；两个后端保持各自独立的实现与学习信号。
- D1 的 Token 总量反映真实的物理上游用量（上游报告的 usage），而公共的「次请求」统计使用成功交付的请求数。
- D1 token 用量与公共模型状态属于可观测性数据，不是路由的决策依据。
- `TIER1_AFFINITY` KV 仅存储哈希后的会话亲和信息，不会使路由具有全局粘性。
- Provider Discovery 是只读的建议性工具。
- Public Model Status 是只读的五状态投影；仪表盘的 P50/P95/样本数是模型级聚合，绝不会反馈给 Scheduler 或 Reliability。
- ai-gateway 只保留一套当前的内部/配置契约；已被取代的旧版本路径会被直接删除，而不是保留在兼容垫片之后。

## 配置权威来源

- 运行时变量名与默认值：`src/config/runtime-vars.ts`。
- 节点解析与凭据绑定：`src/config/nodes.ts` 及相关配置模块。
- provider 协议/surface 映射、stream-usage 特例、OAuth 接入默认值与订阅可 dispatch 性：`src/providers/registry.ts`（由 `src/providers/` 中的各 provider 适配器与 `src/subscription/` 中的订阅适配器组合而成）。
- 逻辑模型目录事实与运行时策略：`src/config/registry.ts`（目录事实：能力、推理强度、模态；运行时策略：故障转移策略绑定、可见性、UI 分组——在类型层面分离；扁平的 `AIG_MODELS_CONFIG` 运营者 schema 保持不变）。
- 逻辑模型回退策略：`src/request/model-fallback.ts` 及其契约测试。
- 协议回退矩阵：协议回退的配置/转换模块及其契约测试。
- 失败分类：`src/reliability/classify.ts`。
- OAuth provider 注册表（订阅端点/客户端/scope/headers）：`src/oauth/provider-configs.ts` 负责解析 `AIG_OAUTH_PROVIDERS`；token 存储/刷新与接入路由：`src/oauth/`。
- 订阅 token schema：`migrations/0011_subscription_tokens.sql`（由 `src/oauth/token-store.ts` 负责；可观测性模块从不读写这些表）。

架构文档只是对上述来源的摘要；当可执行行为发生变化时，必须同步修正本文档。

## 稳定期

当前模块职责以及路由/可靠性架构在稳定期内冻结。日常工作应聚焦于提升正确性、测试、运维以及实测的生产行为，而不是重组目录或发明并行的控制平面。

- Reliability 与 scheduler 状态按设计仅在 isolate 内尽力而为。
- 除非生产证据表明 isolate 本地塑形正在造成实质性故障，否则不引入 Durable Objects 或全局调度器。
- Provider Wire Profile 仍然是线协议契约元数据，而不是第二套逐模型的能力引擎。
- 能力校验保持精简，仅对已声明的逻辑模型元数据中明显的矛盾进行失败即关闭。
- 结构性变更需要具体的生产问题、证据表明现有边界无法解决该问题，以及明确的架构评审。

本阶段的主要生产信号为：真实上游 429、回退放大、hedge 放大、D1 写入量与 TTFT 分布。这些测量应驱动下一次可靠性改动；目录重组不应作为驱动因素。

## 持久化边界

D1 与 KV 在可能的情况下被刻意置于关键调度决策路径之外。

- `TIER1_AFFINITY` KV：短生命周期的会话绑定，TTL 为 30 分钟。
- Token 用量 D1：持久化的物理上游用量、成功交付证据、近期公共状态证据，以及模型级 TTFT 聚合。
- Tier 1 的 TTFT、in-flight、冷却、自适应 429/热度、半开状态：isolate 本地内存。
- Tier 2/3 的健康/熔断/并发状态：isolate 本地内存。

网关不会基于这些本地状态宣称跨 PoP 全局准确的并发数或 provider 账号额度。不会仅因为全局协调在理论上更「干净」就引入它；只有实测证据表明家庭或小型团队的部署模型确实需要时，才会引入。

详细契约请参阅[协议模型](protocol-model.md)、[订阅模型](subscription-model.md)、[路由模型](routing-model.md)与[可靠性模型](reliability-model.md)。
