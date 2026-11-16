# 默认 High 与弹性思考

AI Gateway 将没有思考等级、`default`、`auto` 统一解释为「以 High 为目标」；客户端显式 Low/Medium/High/Max/Off 优先。该策略只表达请求意图，不对所有物理节点承诺同等推理能力。

## 执行边界

- Gateway 不因请求 High 过滤模型回退计划、减少节点候选或增加重试。
- Gateway 将请求意图通过已鉴权的私有执行合同交给 Inference/Perception Center，普通客户端请求头不能直接伪造。
- 物理节点未声明 `reasoning`：保留原生请求，不猜测参数，不增加 Token 预算。
- 节点声明 `reasoning.mode` 后，执行中心才注入相应协议参数；不修改 Code/General 分级或节点选择。
- `budget` 模式仅在有足够输出预算时启用，不自动抬高 `max_tokens`。用户显式配置的 Thinking Budget 保留。
- 显式 Off 由网关转发为独立意图；协议转换丢失原始 `none` 时，已声明能力的执行节点仍可处理 Off。

## 节点可选声明

以下示例仅展示结构，不代表当前节点已证实支持这些参数。仅在核实真实 Provider 能力后填写。

```json
{
  "id": "example-node",
  "provider": "openai",
  "base_url": "https://provider.example/v1",
  "models": {"Max": "actual-model"},
  "reasoning": {
    "mode": "effort",
    "efforts": ["low", "medium", "high"]
  }
}
```

对 Anthropic 协议，可在确认支持后声明 `{"mode":"adaptive","efforts":["low","medium","high"]}`，或带有经过验证的 `high_budget_tokens` 的 `budget` 模式。无配置不会改变原节点可用性。支持 `none` 模式的节点会剥离不兼容思考参数；这种执行不等于实际提供了 High 思考。

## 客户端与模型目录

`GET /v1/models` 增加 `reasoning_policy`（High / best_effort）、`reasoningEfforts` 和 `reasoning_efforts`，依据当前访问 Key 和节点声明形成能力信息。逻辑模型可能连接不同物理模型，公布的可选等级是可请求范围，非所有节点的原生能力保证。

客户端不显示思考菜单时仍可发送普通请求；显示 `Default` 时不必显式注入 High。需要关闭思考时应明确发送 `none/off` 或对应协议的 `thinking.type=disabled`。客户端若把 Off 和缺省都编码成完全相同的请求，网关不能区分，必须修复客户端适配层。

## 验收

`npm run check:reasoning-policy` 覆盖内部思考语义、节点适配、显式 Off、预算上限和私有合同。部署后仍需使用真实 Provider 验证前后吞吐量、422、429、503、输出质量及首 Token 延迟。不要用离线测试宣布线上 High 已得到保证。
