# 订阅模型

Tier 2 承载订阅权益容量（membership/subscription entitlement capacity）：运营者自有的 Claude、Codex 与 Gemini 订阅，通过 OAuth（PKCE）接入，并以 `auth: "oauth"` 节点的形式分发请求。订阅节点的凭据是在 dispatch 时从订阅 token 存储中解析出的 OAuth 访问 token，而不是静态 API Key。Tier 2 **不是**第二个通用 API Key 池；免费与付费 API Key 容量已由 Tier 1 与 Tier 3 覆盖。

本文档是订阅**适配器**的稳定契约。适配器是按 provider 划分的请求语义扩展点。适配器负责规定某一订阅权益族应如何被调用；它从不决定调用哪个节点（由 scheduler 负责）、失败如何改变节点状态（由 reliability 负责），也不负责对响应进行分类（由 `classify.ts` 负责）。通用性体现在**统一接入方式**（一套适配器契约，经由 provider registry 组合）之中，而不是强行把每个 provider 的订阅语义塞进同一个引擎。

> **运营风险。** 适配器使用供应商自身的客户端身份（user agent、`x-app`、`originator`，以及公开的 Gemini CLI OAuth 客户端）。以此方式使用订阅可能违反该 provider 的服务条款。设置 `AIG_IS_SUBSCRIPTION_ENABLED=false` 可禁用整个功能；参见 [SECURITY.md](../../SECURITY.md#订阅代理与-provider-条款)。

## 范围与流水线位置

`SubscriptionAdapter` 通过 `src/providers/registry.ts` 组合进 `ProviderAdapter`，并由 `auth: "oauth"` 标记绑定到节点。provider registry 是唯一的可 dispatch 性权威：`auth: "oauth"` 节点若其 provider 没有订阅适配器，或其适配器拒绝对请求进行整形，则会在 dispatch 前轮换，绝不会落入通用 OpenAI 兼容路径并假装可用。

单次订阅 attempt 的 dispatch 流水线位置如下：

```text
OAuth 解析器（凭据）-> 适配器（请求整形）-> transport（线协议）
                                                 |
                          （当适配器声明了 `wire` 时）
                          dispatch 在成功层消费之前，
                          将成功的上游响应包装为节点的原生协议结构
```

凭据存储与解析由 `src/oauth/` 负责（AES-GCM token 存储、PKCE 接入路由、dispatch 时解析、isolate singleflight 与 compare-and-swap 刷新）。适配器契约只消费 `ResolvedSubscriptionCredential`；它从不读取 token 存储，凭据解析失败会以 dispatch 前 auth 轮换的形式体现。接入流程与 OAuth 各层请参见[配置 - Tier 2 订阅](../operations/configuration.md#tier-2-订阅oauth)。

## 适配器契约

定义于 `src/subscription/types.ts`。适配器是一个普通对象；除 `prepare` 外，所有方法均为可选。

```ts
type SubscriptionAdapter = {
  prepare(ctx: SubscriptionDispatchContext): SubscriptionPreparedRequest | null;
  quotaResetHint?(failure: SubscriptionFailureView, now: number): number | null;
  discoverModels?(credential: ResolvedSubscriptionCredential, env: Record<string, unknown>): Promise<readonly string[] | null>;
  wire?: SubscriptionWire;
};
```

| 方法 | 返回值 | 返回 null 或未定义时 |
| --- | --- | --- |
| `prepare` | 请求头 + 可选的替换请求体 + 可选的 `upstreamUrl` 覆盖 | 返回 `null` 会在 dispatch 前轮换该节点（失败即关闭） |
| `quotaResetHint` | 用于延长 429 冷却的毫秒数，或 `null` | 返回 `null` 则保持通用的失败分类不变 |
| `discoverModels` | 尽力而为的可达上游模型 ID 列表，或 `null` | 返回 `null` 表示不支持发现；静态节点 `models` 仍是路由的权威来源 |
| `wire` | 私有线协议转换器 | 对于复用节点原生协议线路的后端，此项缺省 |

`prepare` 接收只读的 `SubscriptionDispatchContext`（`node`、`credential`、`request`、模型替换之后的 `body`、生效的 `surface`），并返回 `SubscriptionPreparedRequest`：

```ts
type SubscriptionPreparedRequest = {
  headers: Readonly<Record<string, string>>; // 最后应用，叠加在协议/transport 头部之上
  body: Record<string, unknown> | null;       // 替换请求体；为 null 时保留 dispatch 请求体
  upstreamUrl: string | null;                 // 整体替换 dispatch 的目标 URL；为 null 时不替换
};
```

`upstreamUrl` 用于那些线路路径无法通过 `resolveUpstreamPath(protocol, surface)` 表达的订阅后端（例如 Google Code Assist 的 `v1internal:generateContent` 与 `v1internal:streamGenerateContent?alt=sse`）。复用节点原生协议路径的后端应保持其为 `null`。

`prepare` 不得修改 dispatch 的 `body`；若需要改写，它应返回修改后的副本（例如 Codex 在 Responses surface 上为缺失的 `instructions` 字段补全默认值）。客户端身份材料绝不会被转发：transport 的头部白名单依然作用于适配器返回的所有内容。

## Dispatch 可用性规则（失败即关闭）

可 dispatch 性由 provider registry 决定，而非节点自行决定。该契约在每一道关卡都是失败即关闭的：

- 没有 `subscription` 适配器的 provider 仍可使用 OAuth 接入，但运行时 dispatch 失败即关闭；它绝不会落入通用 OpenAI 兼容路径。
- `prepare` 返回 `null` 会在 dispatch 前轮换节点，因此无法整形的请求绝不会以半成品形态发往上游。
- 对于 `wire` 适配器，`objectToNative` 返回 `null`（即无有意义的输出）时，将作为空响应进行轮换。
- `isSubscriptionNode(node)`（位于 `src/subscription/index.ts`）描述的是**意图**，而非可服务性：对于没有适配器的 provider，其 `auth: "oauth"` 节点仍会进入订阅路径，并在 dispatch 前失败即关闭。之所以让无法服务的订阅节点保留在该路径上，正是为了保证它们绝不会把半成品请求发往上游。`dispatch.ts` 调用此谓词，而不是直接读取 `node.auth`，从而使该判断不会在请求路径中被重复硬编码。

未来若出现新的凭据形式，只需修改该谓词（以及它所交接的解析器），而不会影响 dispatch、调度或适配器契约。

## quotaResetHint 语义

订阅权益后端会在各自特定的位置公布额度窗口：绝对的 epoch 重置头、剩余秒数头、`resets_in_seconds` 响应体字段，或 gRPC `RetryInfo.retryDelay`。这些都是**提示，绝非事实**。

- `quotaResetHint` 仅在 429 类失败时被调用，并返回需要等待的毫秒数。
- 提示只能**延长** 429 冷却，绝不能缩短它；结果上限为 `QUOTA_HINT_MAX_MS`（6 小时——超出部分视为可疑数据，而非额度窗口）。
- 恢复沿用所有节点已在使用的共享模型：冷却到期 → 单次半开探测 → 自动恢复。**不存在订阅专用的可靠性状态机。**
- 每个适配器只声明其针对该 provider 所信任的标记名称；共享解析器位于 `src/subscription/quota-hints.ts`：

| 辅助函数 | 输入 | 读取内容 |
| --- | --- | --- |
| `hintFromResetHeaders` | 头部 + 名称 | 绝对的 epoch 秒/毫秒/ISO 重置时刻 |
| `hintFromSecondsHeaders` | 头部 + 名称 | 相对的距离重置的秒数 |
| `hintFromResetBody` | 响应体 + 字段 | 携带秒数或绝对重置时刻的 JSON 字段 |
| `hintFromRetryAfterHeader` | 头部 | 标准 `Retry-After`（秒数或 HTTP 日期） |
| `hintFromRetryDelayBody` | 响应体 | gRPC `RetryInfo.retryDelay`（如 `"42s"`） |
| `capHint` | 重置时刻 + 相对毫秒数 | 将多个候选值合并为一个有上限的提示 |

## 私有线协议（可选）

某些订阅后端使用自己的请求/响应结构，而非节点的原生协议。当 `SubscriptionAdapter` 声明了 `wire` 时，dispatch 层会在成功层处理之前，先将成功的上游响应转换为节点的原生协议结构，从而使所有现有的成功/流/对象处理器保持一致的契约。

```ts
type SubscriptionWire = {
  streamToNative(body: ReadableStream<Uint8Array> | null | undefined, options: { messageId: string, model: string }): ReadableStream<Uint8Array>;
  objectToNative(data: unknown): Record<string, unknown> | null;
};
```

规则：

- **流式转换是惰性的。** `streamToNative` 必须实时地将上游数据块逐段转发，随到随译事件类型，并在上游流结束时**恰好一次**地输出原生的结束标记（例如 OpenAI 的 `data: [DONE]`）。它**不得**在输出前缓冲完整响应，否则首事件守卫将无法在有意义的输出被提交之前完成轮换。
- **非流式对象是即时转换的**，由 dispatch 层执行。
- **转换失败即关闭。** 当响应不包含有意义的输出时，`objectToNative` 返回 `null`，dispatch 层会将其作为空响应进行轮换。
- 私有线协议归**订阅模块所有**：它位于 `src/subscription/` 内部，绝不会进入网关通用的 transport 或 conversion 层。两个原生协议族（OpenAI / Anthropic）保持不变。这是订阅专有的私有线协议，而非第三个协议族。

## 内置适配器

三个主流订阅 provider 均内置了 OAuth 默认值（来自其开源 CLI 的公开常量），以及位于 `src/subscription/` 中的内置订阅适配器。

| Provider | `prepare` 的整形方式 | 额度标记 | `wire` | `discoverModels` |
| --- | --- | --- | --- | --- |
| `anthropic`（Claude Pro/Max） | 合并所需的 OAuth beta 标志（`claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14`）+ `x-app: cli` + claude-cli user agent | `anthropic-ratelimit-*-reset` 头，`resets_in_seconds`/`reset_at`/`resets_at` 响应体 | 无（使用原生 Anthropic Messages 线协议） | Anthropic `/v1/models` 目录 |
| `openai`（ChatGPT/Codex） | `Originator: codex-tui` + `chatgpt-account-id` + Responses surface 上的 `instructions` 规范化 | `x-codex-*-window-reset` / `x-ratelimit-reset-*` 头，`resets_in_seconds` 响应体 | 无（使用原生 OpenAI Chat/Responses 线协议） | OpenAI `/v1/models` 目录 |
| `google`（Gemini / Code Assist） | 将 OpenAI Chat 转换为 Code Assist 信封，将 `upstreamUrl` 设为 `v1internal:generateContent` / `v1internal:streamGenerateContent?alt=sse` | `Retry-After` 头 + gRPC `RetryInfo.retryDelay` 响应体 | 有（`google-wire.ts`：Chat ↔ Code Assist 信封，双向，支持流式与对象） | 不支持（没有经过验证的模型列表端点） |

CCH 计费块签名（CLIProxyAPI 额外的偏执防护层）不属于主流 Anthropic 的整形方式，本项目未实现。

## 新增订阅适配器

扩展流程有意保持精简。若要接入一个拥有自身线协议契约、OAuth 接入或订阅后端的新 provider，需要：

1. 在 `src/subscription/<provider>.ts` 中实现一个适配器模块，实现 `SubscriptionAdapter`。需要决定使用原生线协议（省略 `wire`）还是私有线协议（在同级的 `<provider>-wire.ts` 中实现 `SubscriptionWire`）。
2. 在 `src/providers/<provider>.ts` 中实现一个 provider 适配器，声明 `wire`（protocol + surfaces）、`streamUsage`、可选的 `oauth` 接入默认值、可选的 `subscriptionEndpoint`，以及 `subscription: <adapter>`。
3. 在 `src/providers/registry.ts` 的 `PROVIDER_REGISTRY` 中新增一行。
4. 在中央测试包（`action-worker:tests/packs/ai-gateway/`）中添加契约测试。

新增一个普通的 OpenAI 兼容 provider 完全不需要修改源码——通用 OpenAI 适配器就是 registry 的兜底。适配器契约是唯一的订阅扩展点；scheduler、reliability、transport 与 conversion 层保持与 provider 无关，不会按 provider 名称分支。

## 职责边界

| 层 | 职责 |
| --- | --- |
| Provider registry | 唯一的可 dispatch 性权威；将订阅适配器组合进 provider 适配器 |
| 订阅适配器 | 单一权益族的 provider 特定请求语义；绝不负责调度、可靠性或分类 |
| OAuth（`src/oauth/`） | 凭据存储、PKCE 接入、dispatch 时解析、refresh singleflight 与 compare-and-swap |
| Dispatch | 调用 `prepare`，应用整形后的头部/请求体/URL，将 `wire` 响应包装为原生协议结构 |
| Reliability | 冷却与恢复；`quotaResetHint` 仅能延长 429 冷却且有上限 |
| Transport | 节点选定后的上游 HTTP；绝不负责请求结构转换 |
| Conversion（`src/conversion/`） | 仅负责 Chat ↔ Messages 桥接；订阅私有线协议保留在 `src/subscription/` 中 |

## 不变式

- `auth: "oauth"` 仅在 Tier 2 节点上有效；订阅节点不得同时在 `AIG_TIER{N}_CREDENTIALS_*` 中声明静态凭据（每个节点只能有一个凭据来源）。
- 对于 provider 适配器声明了内置 `subscriptionEndpoint` 的 Tier 2 `auth: "oauth"` 节点，`base_url` 可选；配置层从 provider registry 解析该端点。
- 没有 `subscription` 适配器的 provider 仍保留 OAuth 接入，但运行时 dispatch 失败即关闭；它绝不会落入通用 OpenAI 兼容路径。
- `prepare` 返回 `null` 即为 dispatch 前轮换；无法整形的请求绝不会以半成品形态发往上游。
- `quotaResetHint` 仅为建议性质：它可以延长 429 冷却（上限 6 小时），但绝不会缩短冷却；恢复遵循共享的冷却 → 探测 → 恢复熔断路径。不存在订阅专用的可靠性状态机。
- 私有 `wire` 归 `src/subscription/` 内部所有；两个原生协议族以及通用 transport/conversion 层保持不变。
- 流式线协议转换是惰性的（输出前不缓冲）；非流式转换是即时的；二者均为失败即关闭。
- 订阅 token 使用 `AIG_TOKEN_ENCRYPTION_KEY` 进行 AES-GCM 加密；缺少该密钥会禁用全部订阅接入与解析（失败即关闭）；token 绝不会以明文形式存入 D1。
- Provider 账号身份（例如 OpenAI 的 `account_id`）以明文形式与凭据一同持久化，且仅应用于该 provider 的订阅 dispatch 头部；它绝不会污染 `RuntimeNode` 的 schema。
- 当前只存在一套适配器契约；已被取代的路径会被直接删除，而不是保留在兼容垫片之后。

相关的上下文契约请参见[协议模型](protocol-model.md)、[路由模型](routing-model.md)与[可靠性模型](reliability-model.md)。
