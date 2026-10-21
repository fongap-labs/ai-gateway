# 故障排查

从失败的边界处获取证据：配置校验、CI 作业/步骤、经过认证的 `/health` 构建标识、脱敏的网关日志，以及聚合的失败诊断。在确定失败所在的层级之前，不要轮换或改写无关的配置。

## 配置故障

### 网关处于 `unconfigured` 状态

请检查：

- 至少配置了一个 `AIG_ACCESS_KEY_{AIR,PRO,MAX,ULTRA,AGENT}` Secret；
- 与之对应的 `AIG_ACCESS_MODELS_<GROUP>` Variable 存在且非空；
- 至少存在一个 `AIG_TIER{1,2,3}_NODES_XX` Variable；
- 可用的节点在同一 Tier 的 `AIG_TIER{1,2,3}_CREDENTIALS_XX` Secret 中拥有凭据。

分组的 key 若其模型允许列表为空，则会有意地授予零个模型。

### 网关处于 `degraded` 或 `invalid` 状态

配置里出错的部分只会让出错的部分失效，不会让整个网关停摆：

- **`degraded`（仍在服务）**：至少还有一个可用节点，但有内容被拒绝。例如某个节点缺少凭据，或其凭据定义在另一个 Tier 的分片中、node id 重复（该 id 的所有副本都会被排除）、某个分片不是合法 JSON，或 `AIG_MODELS_CONFIG`、`AIG_POLICIES_CONFIG`、`AIG_PROTOCOL_FALLBACKS`、`AIG_OAUTH_PROVIDERS` 有错误（相应设置回落到内置默认值）。`/health` 返回 200，并在 `diagnostics` 中逐条列出原因。
- **`invalid`（停止服务）**：没有任何可用节点。`/health` 返回 503，推理请求返回 500。

`/health` 中的 `diagnostics` 就是排查清单。只要存在配置错误，部署预检就会拒绝上线，即使设置了 `AIG_ALLOW_DEGRADED=true` 也一样（该变量只放行"节点被排除、容量减少"这一种情况）。

### `No AIG_TIER{1,2,3}_NODES_XX GitHub Variable is configured.`

请添加至少一个有效的 Tier 配置分片，其内容为包含节点的 JSON 数组。后缀仅是分片编号。

当前账号级节点 schema 为：

```text
必填：id, provider, base_url, models
可选：priority
```

`protocol`、`surfaces`、`limits`、凭据以及未知字段均会被拒绝。协议与可路由的 surface 来自 provider 适配器注册表（`src/providers/registry.ts`）。

### 节点凭据缺失

凭据按 Tier + node id 绑定。它们无需与 Config 分片使用相同的后缀，也能被放入 Secret 分片中。

示例：

```text
AIG_TIER1_NODES_03 包含节点 "nvidia-01"
AIG_TIER1_CREDENTIALS_01 可以包含 {"nvidia-01":"..."}
```

如果 Tier 不一致，该凭据对该节点无效。

### `AIG_MODELS_CONFIG` / `AIG_POLICIES_CONFIG` 无效

这些辅助配置采用快速失败（fail-fast）的方式校验。请检查 JSON 格式错误、未知字段、无效取值，以及指向不存在的策略名称的 模型→策略 引用。

请运行：

```bash
npm run config:check -- --tier1 <tier1-nodes.json> --secrets <secrets.json>
npm run validate:merge
```

## 部署故障

### 预检失败

请根据作业所指明的具体缺失的 Variable/Secret 进行修复。不要为了让预检继续通过而添加无关的占位值。如果错误是 `configuration is degraded (...)`，说明有已声明的节点被排除；修复该节点的凭据、字段或 URL，或显式设置 `AIG_ALLOW_DEGRADED=true` 接受减少后的容量。

### D1 迁移失败

当必需的迁移失败时，Worker 不会被部署。请先检查迁移错误；不要绕过迁移的执行顺序。

### Worker 部署成功但验证失败

工作流会尝试回滚 Worker。请分别检查部署工作流中的 `Verify deployed gateway` 步骤、回滚步骤以及回滚后的验证步骤（这些步骤由 Action Worker 的部署工作流执行）。

经过认证的 `/health` 会以 `build` 字段暴露已部署的 commit SHA；生产验证会将该值与部署工作流选定的 commit 进行比较。

如果回滚后的验证也失败，则之前的 Worker 可能并不健康，或外部配置/上游状态已发生变化。应停止自动重试，并检查已部署的构建与配置证据。

### 仅修改文档的变更未部署

当触发部署的 `main` commit 只修改了 Markdown 文件和/或 `docs/**` 时，这属于预期行为。部署门禁会有意跳过仅涉及文档的变更，不进行 Worker 部署。

## 运行时 HTTP 故障

### 400 / 其他客户端类 4xx

当前的失败分类将终止性的请求无效 4xx 视为 `client`，并停止该逻辑请求。网关并不声称能够对每一种由 provider 特定的 400 进行兼容性分类，也不会对每一种此类错误都自动执行轮换。

请检查：

- 所选的上游是否真的支持该请求字段；
- 请求走的是 native 路径还是转换回退路径；
- 结构化输出/工具字段以及 provider 线协议的兼容性；
- 在可用的情况下，查看经过脱敏的上游错误文本。

不要假定 400 意味着该 key 本身不健康。

### 429 Too Many Requests

Tier 1 从真实的上游限流证据中学习，而不是依赖配置的节点 RPM 猜测值。

请检查：

- provider 若返回了 `Retry-After`，则查看该值；
- 受影响的凭据是否处于 key 级的自适应冷却/恢复之中；
- 同一 `(provider, 上游模型)` 下是否有多个独立 key 正在产生 provider-model 热度；
- 当前 isolate 本地的 in-flight 压力；
- 是否有多个 Worker isolate/PoP 在共享同一上游账号/key；
- 仅当你刻意为已知的逐账号本地安全上限进行了配置时，才检查可选策略 `max_in_flight`。

Tier 1 的冷却范围限定在受影响的 provider/key-slot 上；它不会有意禁用整个 Provider 或某个逻辑模型。provider-model 热度是有界的排序信号，而不是全局冷却。

当前 schema 中不存在节点级的 `limits.rpm`、`rpm_mode`，也不存在猜测出的 Provider 全局并发契约（There is no node `limits.rpm`, `rpm_mode`, or guessed Provider-global concurrency contract in the current schema）。

### 502 Bad Gateway

请利用失败诊断判断主要的问题属于以下哪一类：

- `server`
- `network`
- `headers_timeout`
- `first_event_timeout`
- `stream_interrupted`
- `model_missing`
- `endpoint_not_found`
- 转换失败 / 不受支持的回退语义

转换后的回退仍会返回原始客户端的错误信封。

### 503 Service Unavailable

常见原因：

- 网关配置无效或未配置；
- 所有匹配的 protocol/surface/model 候选均暂时不可用；
- 在可重试的失败之后，请求级的逻辑 attempt 计划已耗尽；
- 相关 Tier 1 策略上显式的本地 `max_in_flight` 上限已被占满；
- 在同一请求预算内，已无经过授权的兼容家族回退可用。

请使用经过认证的 `/health` 与经过脱敏的运行时诊断信息。可重试的家族耗尽型 503 并不能证明部署中的每个账号都已被测试或全局不可用。

### 504 Gateway Timeout

请求级的 `AIG_FAILOVER_BUDGET_MS` 已耗尽，或在墙钟预算之内已无安全的 attempt 可用。在增大预算之前，请先检查上游的 header/首事件延迟、已尝试的故障域，以及回退/hedge 的活动情况。

最常见的三个原因：

- **非流式请求生成时间长**：上游在生成结束前不发响应头，响应头等待因此就是整段生成时间。网关对非流式请求使用 attempt 窗口而不是 `AIG_UPSTREAM_HEADER_TIMEOUT_MS`；客户端若能改用流式（`stream: true`），首事件守卫还能更早发现故障。
- **大提示词**：上下文越长，上游 prefill 越慢。请求体超过 50000 字符后，网关已自动放宽预算与超时；`failure_kinds` 里仍以 `headers_timeout` / `first_event_timeout` 为主时，再考虑通过策略的 `headers_timeout_ms`、`first_event_timeout_ms`、`failover_budget_ms` 为该模型单独放宽。
- **hedge 过早重复发送**：每个请求都出现 `hedge:` 日志，说明 3 秒的内置延迟对这类负载偏短。检查 `AIG_HEDGE_DELAY_MS` 是否被显式设置（显式值不会自适应），或把该模型的策略 `hedge.enabled` 设为 `false`。

请求预算耗尽的 504，以及每次 attempt 都只是瞬时失败（超时、5xx、429）的 502，不会带 `x-should-retry: false`：此时没有任何内容送达客户端，重发不会重复工具调用，且冷却状态会把重试引向已恢复的容量，所以 Claude Code、OpenAI SDK 等客户端会自动重试。含有非瞬时失败（上游拒绝请求、模型不存在、协议转换不被支持）的 502 仍带 `x-should-retry: false`。

## 模型问题

### 模型未列出或不可用

请对照节点 `models` 映射以及可选的 `AIG_MODELS_CONFIG`，检查逻辑模型名称。面向 provider 的模型 id 可能与网关的逻辑模型别名不同。

模型形态的上游 404 会使用一个针对该上游模型的短期冷却；在重映射之后，它不应永久地污染逻辑别名。

### Claude Code / Anthropic Messages 回退问题

原生的 Anthropic 路由要求节点的 `provider` 解析到 Anthropic provider 适配器。若 native 候选已耗尽且回退已启用，请求可能会被转换为 OpenAI Chat。

部署里完全没有 Anthropic 节点时，每个 Claude Code 请求都走这条回退路径。Claude Code 的每一轮请求都会带上 advisor、tool search 之类的可选服务端工具定义；只要请求里还有普通函数工具，这些定义会被丢弃（诊断为 `provider_native_tool_definition`），请求照常发出。以下情况仍会返回 502 `conversion_not_supported`（服务端日志中的 `fallback_conversion_skipped` 给出原因）：工具面完全由服务端工具构成（例如只有 `web_search` 的搜索子请求）、`tool_choice` 强制指定了服务端工具、请求带有 `mcp_servers` 或 `container`、历史中含有 `web_search` 的 `server_tool_use` 块。

Claude Code 还会用小模型（默认是 Haiku 系列）做标题、摘要等后台请求。网关只会路由已知模型目录里的模型，所以请设置 `ANTHROPIC_DEFAULT_HAIKU_MODEL`（或 `ANTHROPIC_SMALL_FAST_MODEL`）指向网关已配置的模型，否则这些请求会返回 404 `Model not found for this key.`。

转换桥接刻意不做完整的 Anthropic 语义模拟。诸如 thinking 历史/控制、上下文管理控制、provider 原生工具以及部分工具提示等特性，可能会被降级或被拒绝。调试时，转换诊断会以固定的类别暴露信息，而不包含请求内容。

### OpenAI Responses 问题

原生的 Responses 路由要求节点的 `provider` 解析到 OpenAI provider 适配器 (`provider: "openai"`)。若 native 候选已耗尽，Responses 客户端也可以回退到 Chat 或 Messages 上游（经规范化 IR 矩阵翻译，客户端仍收到 Responses 协议）。

请确认：

- Node Config 使用了 `provider: "openai"`；
- `base_url` 指向预期的 OpenAI 端点；
- 逻辑模型映射解析到一个支持 `/v1/responses` 的模型；
- 凭据在同一 Tier 中已绑定到该节点。

不要添加节点级的 `protocol` 或 `surfaces` 字段；当前的节点 schema 会拒绝它们。如果其他 Provider 需要原生 Responses 支持，必须显式修改其 provider 适配器。

### 结构化输出回退

转换策略是保守的：

- 只有在具备明确的原生能力证据时，才会使用原生 JSON Schema；
- 合成 Tool 模式还需要响应侧的解包适配器；
- 未知的目标能力使用 Prompt 模拟。

因此，当前通用的运行时回退路径会将未知目标默认为 Prompt，而不会强行发送不受支持的 `response_format`。

## Tier 1 路由诊断

流量最快的 key 并不保证获得最多的流量。Tier 1 会有意地在被动 TTFT 与实时压力及失败证据之间取得平衡。

如果一个此前被优先选择的亲和 key 获得的流量减少了，请检查：

- 它当前的 in-flight 压力是否偏高；
- provider-model 限流热度是否正在对该群体进行惩罚；
- 随着压力/热度上升，其亲和优势是否已经减弱；
- 它是否处于冷却/恢复/半开状态；
- 显式的本地 `max_in_flight` 上限是否已被占满；
- hedge 的剩余容量门控是否将其排除在可选的孪生请求之外。

访问密钥分组（`AIR/PRO/MAX/ULTRA/AGENT`）仅用于授权模型；它们不会分配 Tier 1 调度优先级（Access-key groups authorize models; they do not assign Tier 1 scheduler priority）。

## 仪表盘 / 用量诊断

公共仪表盘有意使用不同的计数器来回答不同的问题：

- Token 总量：真实的物理上游 Token 用量；当上游报告了用量时，包括重试/回退/hedge 的工作量；
- 公共「次请求」：成功交付的请求数，因此内部的重试/回退/hedge attempt 不会使该计数膨胀；
- 模型用量的工具提示：用于模型用量细分的物理上游调用次数；
- 模型状态的 `samples`：近期窗口内记录了 TTFT 样本的、成功交付的请求数。

请勿将聚合的物理 Token 用量除以上游 attempt 数，再将结果与公共的成功请求数或 TTFT 样本数直接比较；二者回答的是不同的问题。

## 流式故障

### Headers 超时

在 `AIG_UPSTREAM_HEADER_TIMEOUT_MS` 之前，没有收到上游的响应头。请检查网络与 provider 的响应速度。

### 首事件超时

已收到响应头，但在当前 attempt 截止时间之前，没有出现有意义的、协议特定的输出。`AIG_FIRST_EVENT_TIMEOUT_MS` 受同一请求/attempt 墙钟预算的约束；仅包含生命周期事件的 SSE 不一定会提交响应。

### 流中断

流可以成功提交，之后再被截断。提交之后，网关不会将请求透明地重放到另一个 provider，因为重复的部分输出是不安全的。

## 安全的证据收集

切勿在 Issue 或公开日志样本中包含真实凭据、完整的 authorization 头、私有上游 URL、提示词/请求体或用户数据。参见 [SECURITY.md](../../SECURITY.md)。
