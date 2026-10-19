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

- `provider_native_tool`：服务端工具（如 `web_search`）在目标协议中没有等价表示；
- `provider_native_tool_history`：历史中的服务端工具调用与结果。

以下被丢弃的特性不会拒绝回退，仅使保真度降为 `degraded` 并保留诊断：

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

矩阵转换的上游强制 `stream:true`：上游按 SSE 返回时走首事件守卫与流式翻译；上游返回 JSON（忽略流式标志）时，矩阵会将原生对象经 IR 转换后按客户端协议返回对象或合成 SSE 生命周期。

思考（thinking）语义在矩阵中是可携带的：Chat 的 `reasoning_content`、Responses 的 reasoning 项与 Anthropic 的 thinking 块在 IR 中一一对应；加密/红acted 的思考历史（Anthropic `redacted_thinking`、Responses `encrypted_content`）在通往 Anthropic 的路径上原样透传，其他目标会通过 `thinking_history: dropped` 诊断显式报告。思考强度在请求侧按 Chat/Responses 的 `reasoning_effort` 与 Anthropic 的 thinking `budget_tokens` 映射（low/4096 · medium/10000 · high/24000 · max/32000，预留 1024 输出余量），超出物理上限的值会被钳制并报告诊断。

## 错误信封

回退失败时，绝不能将目标上游的协议信封泄漏给原始客户端。

- OpenAI Chat 客户端收到 OpenAI 格式的错误。
- Anthropic Messages 客户端收到 Anthropic 格式的错误。
- 转换失败会在无效的目标请求被 dispatch 之前，以网关转换失败的形式上报。

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
