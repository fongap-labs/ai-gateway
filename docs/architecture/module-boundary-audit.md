# 模块边界与重复性审计

Baseline: `8e375078cbde553d91d71e1ed4784d790db2b390`（基线提交，2026-09-16）。

本审计按职责归属、依赖方向、状态归属、控制流以及重复行为来检视运行时模块。它不是按行数计算的练习：只有当单一共享所有者能让契约更清晰时，才会消除重复。

## 当前状态

All material P1/P2 ownership findings from the baseline audit are resolved（基线审计中所有实质性的 P1/P2 职责归属问题均已解决），且未改变路由策略、冷却数值、流提交语义、计费语义、错误语义或公共 API 行为。

已完成的变更：

- Tier 1 评分构造迁移至 `src/scheduler/tier1-scoring.ts`。
- provider-model 429 热度合并至 `src/reliability/tier1-heat.ts`。
- `src/reliability/tier1-state.ts` 现在负责 Tier 1 的可变可靠性状态，而不再负责排序策略。
- 成功结果的收尾处理拆分为 `success.ts`、`success-stream.ts` 与 `success-object.ts`。
- 跨层的上游处理失败从 transport 迁移至中立的 `src/types/upstream-processing.ts` 契约。
- 通用的与 Tier 1 的自动冷却抖动现在共享 `src/reliability/cooldown-jitter.ts`。

下文所列的其余重复代码属于有意保留，在没有新证据之前不应抽象化。

## 模块结论

| 模块 | 重复程度 | 边界 | 结论 |
| --- | --- | --- | --- |
| `config` | 低/中等的解析/缓存脚手架 | 良好 | 保持校验器相互独立；不引入通用解析框架。 |
| `providers` | 低 | 良好 | 每个 provider 族一个适配器；注册表是 provider → 线协议/OAuth/订阅/特例的唯一权威。 |
| `scheduler` | 低 | 良好 | 拥有排序策略；不要把可靠性状态迁移到这里。 |
| `reliability` | 低/中等 | 良好 | 状态、热度、分类与共享的冷却算术都有明确的所有者。 |
| `request` | 中等 | 成功拆分之后良好 | 保持 `success.ts` 精简；协议特定的分支保持可见。 |
| `transport` | 低 | 良好 | 线路/路径判断保留在此处。 |
| `protocol` | 低/中等 | 良好 | 保持协议语义明确。 |
| `conversion` | 中等的内部重复 | 良好 | 保持明确的 Chat ↔ Messages 转换；不建立通用 IR（no universal IR）。 |
| `stream` | 中等的机械性重复 | 良好 | OpenAI/Anthropic 状态机保持独立。 |
| `observability` | 中等，有意的查询/写入并行 | 良好 | 将已交付与物理上游的计费保持为两个独立概念。 |
| `runtime` | 低 | 良好 | 仅只读投影。 |
| `dashboard` | 低/中等的渲染重复 | 良好 | 展示层不得反向依赖执行状态相关的模块。 |
| `ratelimit` | 低 | 良好 | 保持隔离。 |
| `types` | 低 | 良好 | 仅放置中立的跨层契约；不是工具杂物箱。 |

## 已解决的问题

### Tier 1 ownership（Tier 1 职责归属）

实际落地的归属如下：

```text
reliability/tier1-state.ts   可变的账号/模型状态
reliability/tier1-heat.ts    provider-model 热度 + hedge 压力
scheduler/tier1-scoring.ts   评分常量 + 评分计算
scheduler/tier1-scheduler.ts 资格 + 亲和 + P2C + claim
```

这只是职责归属的修正。既有的 P2C 行为、TTFT 加权、亲和、额度与热度因子均保持不变。

### Success finalization（成功结果收尾）

原先的 `request/attempt/success.ts` 热点被机械地拆分为：

```text
attempt/success.ts           精简的分发器 + 共享契约
attempt/success-stream.ts    首事件守卫 + 流生命周期
attempt/success-object.ts    对象组装 + 对象收尾
```

dispatch 判断与协议特定行为保持明确。嵌入式错误与响应头之后的分支不会被强行纳入通用的结果引擎。

### Upstream-processing failures（上游处理失败）

`src/types/upstream-processing.ts` 现在负责跨层的失败词汇表。流/协议代码产生带类型的处理失败，`reliability/classify.ts` 决定其可靠性影响。已退役的 `src/transport/processing-error.ts` 路径已被删除，而未保留为兼容垫片。

### Automatic cooldown jitter（自动冷却抖动）

通用节点可靠性与 Tier 1 此前重复实现了相同的 ±10% 算术。现在 `src/reliability/cooldown-jitter.ts` 负责这一纯计算；两个状态机各自独立决定何时应用抖动。

### Provider adapter consolidation（provider 适配器整合）

此前 provider 知识分散在 `src/config/provider-profile.ts`（线协议 switch）、`src/config/provider-quirks.ts`（stream usage）、`src/oauth/provider-configs.ts`（OAuth 默认值）以及 `src/subscription/index.ts`（适配器表）中。现在每个 provider 在 `src/providers/` 中只声明一次，并通过 `src/providers/registry.ts` 解析。订阅适配器的实现仍保留在 `src/subscription/` 中，并被组合进 provider 适配器；OAuth 的解析/合并机制仍保留在 `src/oauth/provider-configs.ts` 中，并消费适配器声明的默认值。已退役的 switch 与 quirks 模块已被删除，而未保留为垫片。

以下重要语义保持不变：

- 只有自动计算出的冷却/退避时间才使用抖动；
- provider 明确给出的 `Retry-After` 保持精确且不抖动；
- 抖动范围保持为 ±10%；
- Tier 1 的 429 时长仍由 `adaptive-429.ts` 负责。

## 有意保留的重复（Intentional duplication）

### Delivered vs physical-upstream queries（已交付 vs 物理上游查询）

`token-usage-store/queries.ts` 与 `token-usage-store/upstream-queries.ts` 看起来刻意相似，因为它们回答的是不同的计费问题：

- 已交付的列描述成功请求的证据以及 TTFT；
- `upstream_*` 列描述物理上的重试/回退/hedge 消耗。

除非出现具体的漂移问题或第三种计费视图，否则不要把它们合并为通用的查询构建器。

### Protocol stream assemblers（协议流组装器）

OpenAI 与 Anthropic 组装器共享读取器/扫描器的机制，但具有不同的终止事件、EOF 规则与语义状态。除非第三种实现证明存在稳定的共同抽象，否则保持它们各自明确。

### Configuration parsers（配置解析器）

`models.ts`、`policies.ts` 与 `protocol-fallbacks.ts` 共享解析/缓存/诊断的模式，但它们的 schema 与失败契约不同。通用解析器目前会模糊校验逻辑。

### Conversion paths（转换路径）

`SUPPORTED_CONVERSIONS` 与回退策略可能包含相同的方向，但二者分别表示能力与策略。它们被允许分歧，并保持分离。

## 守护措施

`action-worker:tests/packs/ai-gateway/governance-contract-test.mjs`（其中的 module-boundary 部分）固定了稳定的依赖方向与已解决的职责归属决定：

- scheduler 拥有 Tier 1 评分；
- reliability 拥有 Tier 1 热度/状态；
- 两个可靠性状态机都使用共享的冷却抖动原语；
- 成功结果的分发/流/对象职责保持分离；
- reliability 消费中立的上游处理契约，且不依赖 transport 获取失败词汇表；
- provider 知识通过唯一的注册表解析（`src/providers/registry.ts`）；已退役的 provider-profile/provider-quirks 模块保持删除状态，订阅仅作为组合存在，scheduler/reliability/transport 绝不导入 provider 注册表；
- 持久化的可观测性与路由执行保持独立；
- 仪表盘展示层不得反向依赖 scheduler/reliability/transport 的执行状态。

`action-worker:tests/packs/ai-gateway/cooldown-quota-test.mjs` 单独固定了共享的 ±10% 算术，覆盖下限、中性与上限三个随机样本。

未来的重构应优先采用干净替换，而非兼容层；不应仅为减少行数而新增抽象。
