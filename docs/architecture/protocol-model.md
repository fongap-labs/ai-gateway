# 协议模型

ai-gateway 支持两个协议族：OpenAI 与 Anthropic。账号级 Node Config **不**声明协议或可路由的 surface。运行时通过 `src/providers/registry.ts` 从 provider 适配器推导它们，然后基于归一化后的运行时 `protocol + surface + model` 三元组进行调度。

当前的 provider 协议配置如下：

- `provider: "anthropic"` → Anthropic 协议，`messages` surface；
- `provider: "openai"` → OpenAI 协议，`chat_completions` 与 `responses` surface；
- 其他所有 provider 名称 → OpenAI 兼容协议，`chat_completions` surface。

节点级不存在 `protocol` 或 `surfaces` 覆盖项。如果某个 provider 需要不同的线协议契约，应修改 Provider Profile，而不是在账号记录中重复编写传输结构。

订阅后端可能使用私有线协议（例如 Google Code Assist 的 `v1internal` `generateContent`）。声明了 `wire` 的订阅适配器，负责在 `src/subscription/` 与 dispatch 层内部完成与其节点原生协议之间的转换；网关的两个原生协议族以及通用 transport/conversion 层保持不变。私有线协议绝不会泄漏到非订阅流量中。

## 原生 surface

| 客户端路径 | 协议 | 原生上游路径 |
| --- | --- | --- |
| `/v1/chat/completions` | OpenAI Chat Completions | `/v1/chat/completions` |
| `/v1/responses` | OpenAI Responses | `/v1/responses` |
| `/v1/messages` | Anthropic Messages | `/v1/messages` |
| `/v1/messages/count_tokens` | Anthropic 兼容的本地工具接口 | 除非被禁用，否则返回本地近似计数 |

配置归一化之后，每个 `RuntimeNode` 都携带由其 provider profile 推导出的 protocol 与 surface。调度器在选择节点之前，会按 protocol + surface + model 进行过滤；这些归一化后的运行时字段并非用户可配置的节点 JSON 字段。

## Native 优先（Native First）

三个协议 surface（OpenAI Chat Completions、OpenAI Responses、Anthropic Messages）始终优先尝试 native 节点。只有当 native 候选池耗尽且该路由已启用时，跨协议转换才会开始。

内置的回退链（六条有向路径）如下：

```json
{
  "anthropic:messages": ["openai:chat_completions", "openai:responses"],
  "openai:chat_completions": ["anthropic:messages", "openai:responses"],
  "openai:responses": ["anthropic:messages", "openai:chat_completions"]
}
```

`AIG_PROTOCOL_FALLBACKS=disable` 会禁用转换回退。显式的 JSON 映射会覆盖内置回退链。Responses ↔ Chat 与 Responses ↔ Messages 的回退经由规范化 IR 矩阵（见下文），与 Chat ↔ Messages 回退享有相同的保真度诊断与预算契约。

回退不会重置请求。Native attempt 与转换回退共享同一个 `max_attempts`、tier-attempt 计数、dispatch 上限以及 `AIG_FAILOVER_BUDGET_MS` 墙钟预算。hedge 孪生请求仅从当前协议/surface 池中选择；不允许跨协议 hedge。

## 转换边界

`src/conversion/` 的桥接分为两层：

- 直接适配器：OpenAI Chat Completions ↔ Anthropic Messages（历史路径，语义直译）。
- 规范化 IR 矩阵：`src/conversion/matrix/`，以内部规范化中间表示（canonical IR）为pivot，覆盖全部六条有向路径（三个 surface 两两互转）。矩阵在转换后端共享统一的请求/响应/流式/错误语义，并沿用同一套保真度诊断。

转换属于语义层面的转换，并且可能有损。`src/conversion/result.ts` 中的结果包装器会明确报告这一点：

```ts
type ConversionResult = {
  body: Record<string, unknown>;
  fidelity: 'exact' | 'portable' | 'degraded';
  diagnostics: readonly ConversionDiagnostic[];
  structuredOutput?: { strategy: 'native' | 'tool' | 'prompt' };
};
```

### 保真度（Fidelity）

| 保真度 | 含义 |
| --- | --- |
| `exact` | 未记录任何语义映射、模拟、默认值或丢弃 |
| `portable` | 语义已映射为目标表示，且未记录已知损失 |
| `degraded` | 至少有一项功能被丢弃、模拟或使用了默认值 |

诊断信息使用固定分类，例如 `mapped`、`dropped`、`emulated` 与 `defaulted`。诊断中绝不能包含请求文本、提示词、schema、凭据、私有工具名称或其他客户端可控的敏感值。

### 高风险丢失（回退拒绝）

跨协议回退在转换后会检查诊断。若某项被丢弃的特性会改变上游实际收到的请求语义，则该回退目标会被拒绝，而不是降级后发出。当前高风险集合为：

- `provider_native_tool`：请求的工具面完全由服务端工具（如 `web_search`）构成、或带有 `mcp_servers` / `container`，在目标协议中没有等价表示，丢弃后请求就不再是原来的请求；强制指定（`tool_choice`）某个服务端工具同样直接拒绝；
- `provider_native_tool_history`：历史中的服务端工具调用与结果。

以下被丢弃的特性不会拒绝回退，仅使保真度降为 `degraded` 并保留诊断：

- `provider_native_tool_definition`：请求同时带有可移植的函数工具时，随之出现的服务端工具定义（advisor、tool search、`web_search` 等）被丢弃。Claude Code 的每一轮请求都把这类可选的服务端工具与自己的函数工具列在一起；目标模型只是少了一项能力，不会被告知这些工具存在，也不会被伪装成函数暴露出去；

- `tool_result_error_marker`：工具结果的失败标记在 Chat 中没有对应字段，失败文本仍保留在工具结果内容中；
- `context_management`：仅是客户端侧上下文编辑（如清理旧工具结果）的提示，不改变消息内容。

## 结构化输出

结构化输出转换采用保守的能力顺序：

```text
Native JSON Schema
        ↓ 若明确已知不受支持/不可用
Synthetic Tool
        ↓ 仅当请求侧支持与响应侧解包均已被证明
Prompt 模拟
```

规则：

- `native` 要求有明确证据表明目标线协议实现接受原生 JSON Schema。
- `tool` 要求同时具备合成工具输出的支持，以及能够将保留工具解包为客户端所期望的结构化结果的响应适配器。
- 现有的客户端 tool/tool-choice 契约不会被合成工具模拟覆盖。
- OpenAI `strict:false` 的 schema 不会被悄悄加强为严格的 Anthropic 原生 schema。
- 对于未知的目标能力，使用 `prompt`，而不是猜测 provider 的兼容性。

当前的运行时回退路径不会将逐节点的结构化输出能力证据传入转换包装器，因此未知目标默认保持在保守的 Prompt 策略上。Native 与 Tool 策略是能力原语，并不意味着每个已配置的 provider 都会自动使用它们。

## OpenAI Chat → Anthropic Messages

转换器支持网关 Chat 回退所需的可移植子集，包括普通消息、函数工具/调用/结果、转换器支持范围内的图片 URL 映射、停止控制以及常见的生成参数。

Anthropic 要求提供 `max_tokens`；当 OpenAI Chat 回退请求省略该字段时，转换器会应用其当前的安全默认值，并将其报告为 `defaulted` 保真度信息，而不是隐藏这一语义选择。

OpenAI 的 system/developer 语义可能需要映射或模拟，因为 Anthropic 使用顶层 system 表示。不受支持的请求语义会使转换失败，而不会被悄悄地凭空构造。

## Anthropic Messages → OpenAI Chat

可移植的函数工具以及工具调用/结果历史，在可表示的情况下会被映射。通用 Chat 无法安全表示的 Anthropic 专有控制项或历史内容，可能会被丢弃或模拟，并通过保真度诊断体现出来。

可能导致语义降级的示例包括：Anthropic 的 thinking 控制项/历史、上下文管理控制项、provider 原生工具、工具提示、并行工具控制，以及对话中途的 system 指令。

以下 Anthropic 专有输入不会拒绝回退：`thinking.type:"adaptive"`（无固定预算，强度仍由 `output_config.effort` 映射）、`thinking.display`、`type:"custom"` 工具（即普通函数工具）、内容块上的 `cache_control`；`service_tier`、`speed`、`inference_geo` 仅影响 Anthropic 的服务路径，会以 `request_hints: dropped` 诊断丢弃。`container` 属于服务端代码执行工具，按 `provider_native_tool` 丢弃并受高风险规则约束。

Anthropic 的 `document` 块：内联 base64 文档映射为 Chat 的 `file` 部分或 Responses 的 `input_file` 部分（用户消息与工具结果中均可），纯文本来源转为文本（`emulated`）；URL 与 content 来源没有可移植的内联形式，转换失败而不是猜测。工具结果中的 `tool_reference` 以文本占位表示（`emulated`），内容块上的 `citations` 被忽略。

## 响应与流式转换

回退同时涵盖请求方向与响应方向。转换后的上游响应会以**客户端原始协议的信封**返回。

流式适配器会逐步翻译受支持的事件。首事件守卫仍然掌控提交边界：在第一个有意义的客户端可见输出被提交之前，故障转移是安全的；提交之后则刻意不尝试透明的故障转移。

OpenAI Chat 上游的完成边界：`finish_reason` 之后，尾随的 usage 帧（`include_usage`）或 `[DONE]` 才封口，这样客户端收到的 token 计数是真实值；上游在 `finish_reason` 之后直接关闭连接（不发 `[DONE]`）视为完整回复，而不是流中断。

各协议的完成语义保持各自独立：

- OpenAI Chat 在出现有意义的内容、推理或工具调用输出时提交。
- OpenAI Responses 在受支持的响应输出增量上提交。
- Anthropic Messages 在有意义的文本、thinking 或工具输入增量上提交。

流式翻译中，工具调用的归属与结束遵循以下规则：

- Responses 上游的工具参数既可能以 `function_call_arguments.delta` 增量到达，也可能只出现在 `function_call_arguments.done`、`output_item.done` 或 `output_item.added` 中；已通过增量送出的参数不会重复。
- Chat 上游的工具调用分片优先按 `index` 归属；没有 `index` 时，重复出现的 `id` 属于同一个调用，既无 `index` 也无 `id` 的续传分片属于最近一个调用。多个调用的分片相互交错（先打开多个调用、再交替发送参数）不受支持：参数按到达时刻归入当前最近打开的调用。
- 携带工具调用的回复以工具轮次结束（Anthropic `tool_use`），即使 Chat 上游报告的是普通 `stop`；被截断的回复（Chat `length`、Responses `incomplete`）保持 `max_tokens`，绝不会被当作已完成的工具调用。

矩阵转换的上游强制 `stream:true`：上游按 SSE 返回时走首事件守卫与流式翻译；上游返回 JSON（忽略流式标志）时，矩阵会将原生对象经 IR 转换后按客户端协议返回对象或合成 SSE 生命周期。

思考（thinking）语义在矩阵中是可携带的：Chat 的 `reasoning_content`、Responses 的 reasoning 项与 Anthropic 的 thinking 块在 IR 中一一对应；加密/红acted 的思考历史（Anthropic `redacted_thinking`、Responses `encrypted_content`）在通往 Anthropic 的路径上原样透传，其他目标会通过 `thinking_history: dropped` 诊断显式报告。思考强度在请求侧按 Chat/Responses 的 `reasoning_effort` 与 Anthropic 的 thinking `budget_tokens` 映射（low/4096 · medium/10000 · high/24000 · max/32000，预留 1024 输出余量），超出物理上限的值会被钳制并报告诊断。

## 错误信封

回退失败时，绝不能将目标上游的协议信封泄漏给原始客户端。

三个协议的网关错误保留各自的 JSON 正文格式，并统一通过响应头提供恢复信息：`x-gateway-error-code` 是已分类的网关错误码，`x-gateway-retryable` 表示该错误能否重试，`x-gateway-budget-exhausted: true` 表示请求的时间或尝试预算已经耗尽。已有聚合诊断同时提供 `x-gateway-attempts`、`x-gateway-dispatches`、`x-gateway-hedges` 和 `x-gateway-failure-kinds`；不暴露节点、凭据或原始上游错误。`Retry-After` 仍负责说明等待时间。浏览器通过 CORS 读取这些响应头，需要运营者配置允许的来源。

Chat 和 Messages 的已分类网关错误还在 `error.details` 中提供 `gateway_code`、`retryable`，以及存在等待提示时的 `retry_after_ms`，供只保留错误正文的客户端适配器使用。Responses 保持标准正文与 `error.code: null`，通过响应头传递这些诊断。

客户端可发送 `x-gateway-deadline-ms`，值为正整数形式的 Unix 毫秒时间戳。这个截止时间只会缩短网关提交首个有效输出之前的回退预算，不能延长服务端策略；它不限制已提交流的正常生成。客户端重试同一步时必须复用原值，不能每次重新计算。已过期的截止时间在 dispatch 前返回不可重试的 408，错误码为 `gateway_client_deadline_exceeded`；不合法的值返回 400。客户端应保存任务进度并在新的任务步骤中恢复，避免重新遍历已耗尽的上游池。

- OpenAI Chat 客户端收到 OpenAI 格式的错误。
- Anthropic Messages 客户端收到 Anthropic 格式的错误。
- 对于仅目标协议不支持的请求，继续保留 502 转换失败语义（不将有效的客户端请求误标为 400）；新增稳定的 `gateway_conversion_not_supported` 错误码与 `x-should-retry: false`，避免 SDK 把不可转换的请求当作瞬时故障。
- 当唯一失败原因是顶层请求字段，返回 400 与 `gateway_unsupported_request_field`；该字段仅来自请求本身，且不暴露上游拓扑。
- Chat Completions 跨协议转换允许标准 `stream_options.include_usage` 布尔提示，但不会把 Chat 专用字段透传到 Anthropic/Responses 目标。未知或非法值仍拒绝转换。
- 全部上游在 dispatch 前因认证不可用失败时，返回 502 与 `gateway_upstream_auth_unavailable`；全部上游报告模型不存在时，返回 502 与 `gateway_upstream_model_unavailable`。错误不泄露节点/Token。
- 流式直通仅在无需重写客户端模型别名时使用；同家族回退后的真实上游模型会以实际生效的路由模型判断。
- 例外：请求被拒的唯一原因是客户端顶层字段无法被任何目标协议承载（例如 Claude Code auto 权限模式发送的 `safeguards`），且该模型没有任何 native 节点时，返回 400 `invalid_request_error`，`error.details.failure_kind` 为 `unsupported_request_field`，`error.details.unsupported_fields` 列出字段名。这个网关没有任何节点能承载这些字段，重试不会改变结果；客户端去掉它们后重发即可，Claude Code 会自动这样做。只要该模型有 native 节点（即使暂时不可用），仍返回 502，因为 native 节点恢复后能原样承载这些字段。
- 原生尝试已经 dispatch、而某个回退目标随后被转换拒绝时，耗尽响应（含故障转移预算耗尽）的 `error.details.conversion_rejected` 给出被拒绝的转换次数。只报告次数：原因文本可能引用客户端可控的名称，仅保留在 `fallback_conversion_skipped` 服务器日志中。

## 职责边界

| 层 | 职责 |
| --- | --- |
| Provider Profile | 将 provider 名称映射为 protocol + 可路由 surface |
| Protocol | 客户端校验与协议特定错误 |
| Transport | 上游路径、头部、原生线协议行为 |
| Conversion | Chat ↔ Messages 直接桥接，以及全部协议对共用的 IR 矩阵 |
| Stream | 首事件守卫与流生命周期 |
| Scheduler | 候选节点选择；绝不解析协议事件 |
| Reliability | 失败状态；绝不负责请求结构转换 |

关于协议资格如何与 attempt、hedge 与 cooldown 相互作用，请参阅[路由模型](routing-model.md)与[可靠性模型](reliability-model.md)。

## 后端文生图

文生图使用独立 `POST /v1/images/generations` 入口。客户端聊天模型继续使用原有文本接口；宿主或后端工具执行器调用 `generate_image` 时才访问图片入口。网关本身不擅自执行聊天模型输出的工具调用。

- 逻辑模型名称仍为 `Image-Creator`，不改为路径名称。
- 图片仅允许 `AGENT` 访问密钥组调用，`visibility: "internal"` 只控制目录可见性，不能代替鉴权。
- `/v1/models` 不列出内部模型，普通聊天接口对仅输出图片的模型直接返回 400，不进行上游 dispatch。
- `modalities.input=["text"]`、`modalities.output=["image"]` 与 `visibility="internal"` 是图片请求的硬性门禁；未配置的旧别名无法自动获得图片权限。
- `n=1`，仅允许 `b64_json`，尺寸仅接受 `1024x1024`、`1024x1536`、`1536x1024`。未知字段直接拒绝。
- 图片上游只能用明确声明原生图片 surface 的 Provider：`openai`、`google-image`、`cloudflare-image`。`google`、通用聊天兼容节点、OAuth 订阅节点不能借用图片 API 权限。
- 图片路由禁用模型家族替换、跨协议 fallback、Hedge 和失败后对同一节点的重试。不确定结果不得重新生成；仅确定无生成的 429/404 可以选择其他节点。
- 不记录提示词和 Base64 图片，不把图片计入文本 Token 用量。

配置逻辑模型（加入现有 `AIG_MODELS_CONFIG`）：

```json
{
  "Image-Creator": {
    "policy": "default",
    "visibility": "internal",
    "ui_visible": false,
    "group": "image",
    "modalities": {
      "input": ["text"],
      "output": ["image"]
    }
  }
}
```

绑定上游的例子（加入已有 Tier 节点 JSON；凭据必须放在对应 Tier 的 `AIG_TIER{N}_CREDENTIALS_*` Secret 中）：

```json
[
  {
    "id": "image-openai",
    "provider": "openai",
    "base_url": "https://api.openai.com",
    "models": { "Image-Creator": "gpt-image-1" }
  },
  {
    "id": "image-google",
    "provider": "google-image",
    "base_url": "https://generativelanguage.googleapis.com",
    "models": { "Image-Creator": "gemini-2.5-flash-image" }
  },
  {
    "id": "image-cf",
    "provider": "cloudflare-image",
    "base_url": "https://api.cloudflare.com/client/v4/accounts/<account_id>/ai/run",
    "models": { "Image-Creator": "@cf/black-forest-labs/flux-1-schnell" }
  }
]
```

仅后台工具使用 `AIG_ACCESS_KEY_AGENT`，在 `AIG_ACCESS_MODELS_AGENT` 中明确允许 `Image-Creator`。切勿将 AGENT 密钥下发到浏览器。Cloudflare 示例中 `<account_id>` 必须替换为实际账户 ID；图像调用额度独立于网关 CPU 限制。

调用示例：

```bash
curl -X POST 'https://<gateway>/v1/images/generations' \
  -H 'Authorization: Bearer <backend-agent-key>' \
  -H 'Content-Type: application/json' \
  -d '{"model":"Image-Creator","prompt":"水墨山水","size":"1024x1024","n":1}'
```

响应采用 OpenAI Images 的 `data[].b64_json` 结构。

### Workers 免费版 CPU 限制

Workers Free 单请求仅有 10ms CPU、128MB 内存。等待外部 `fetch` 的时间不计 CPU，但 JSON 和 Base64 处理计入 CPU。原生 OpenAI Images 响应按流透传，不解析大图片；Cloudflare/Gemini 响应若需转为统一结构，限定 2MiB 的已编码缓冲响应，超限明确失败，不自动重复生成。**这不是 10ms 的达标证明。** 生产上线前必须通过 Cloudflare CPU/内存实测；若转换阶段达到限制，应把图片格式归一化迁移到 Oracle 后端，而不是增加 Worker CPU 预算或偷偷回退付费方案。
