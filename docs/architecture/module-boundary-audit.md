# 模块边界审计

Baseline: `8e375078cbde553d91d71e1ed4784d790db2b390`（2026-09-16）。本文件只保留基线结论与仍然有效的边界约束；实现历史见 Git。

All material P1/P2 ownership findings from the baseline audit are resolved. 当前未确认需要重新引入通用框架的重复路径。

## Tier 1 ownership

- `src/reliability/tier1-state.ts`：可变的模型与账号状态
- `src/reliability/tier1-heat.ts`：provider-model 热度与对冲压力
- `src/scheduler/tier1-scoring.ts`：评分公式
- `src/scheduler/tier1-scheduler.ts`：资格、亲和、P2C 与槽位

## Success finalization（成功收尾与协议）

- `src/request/attempt/success.ts` 是薄分发器；流和对象收尾分别属于 `success-stream.ts` 与 `success-object.ts`。
- 跨层错误词汇表属于 `src/types/upstream-processing.ts`；可靠性层不得反向依赖 transport。
- `src/providers/registry.ts` 是 provider wire 和静态 Token 协议能力的单一归属；未知 provider 使用通用 OpenAI Chat 适配器。
- `src/conversion/matrix/` 承担 Chat、Responses、Messages 的转换 IR；native 请求不经过矩阵。

## Automatic cooldown jitter

`src/reliability/cooldown-jitter.ts` 只负责 ±10% 的计算。是否抖动由调用者决定；provider 显式给出的 `Retry-After` 不参与抖动。

## Intentional duplication（有意保留的差异）

- `token-usage-store/queries.ts` 和 `upstream-queries.ts` 分别回答已交付请求和物理上游消耗，不能仅凭 SQL 结构相似而合并。
- OpenAI 与 Anthropic 的流结束/EOF 规则不同，保留各自状态机。
- 模型、策略、协议回退配置解析器的 schema 与失败合同不同，不抽象为一个通用解析器。

中央测试包 `action-worker:tests/packs/ai-gateway/governance-contract-test.mjs` 锁定上述依赖方向。后续删除应以调用关系和测试证据为依据，而非按行数判断。

