# Protocol Center · 分阶段迁移

## 范围

新增私有 `ai-protocol-center`，在明确配置 Service Binding 后处理跨协议预检与请求转换。它不保存 Provider 凭据、不选择 Key、不执行 Provider 请求、不承担 Tier 调度或重试。

Gateway 在配置 `AIG_PROTOCOL_SERVICE` Service Binding 与 `AIG_PROTOCOL_AUTH_KEY` Secret 后可以使用独立中心。未配置绑定时沿用 Inference 预检；显式绑定但缺少 Secret 或中心不可用则拒绝，不允许静默回退。

## 不变约束

- 预检只返回保真等级、固定诊断标记和错误字段，不返回消息、工具 Schema、API Key 或转换结果。
- 六个方向均复用原 `packages/conversion-core` 矩阵，禁止硬编码上游模型能力。
- 阶段二的跨协议调用链：Gateway → Protocol（一次请求转换）→ Inference（一次物理请求与兼容响应转换）→ Protocol（原样回传）→ Gateway。
- 新增严格版本化的 v7 已转换请求内部票据；Inference 不再次转换请求，仍保留原有响应对象和流式转换处理。
- 原生协议直接 Gateway → Inference，绕过 Protocol；所有未绑定环境仍按旧逻辑执行，不能因为新代码存在就改变生产流量。
- 仅增加构建、契约和门禁测试，不修改生产部署清单、Secret 来源，也不启用 Gateway 生产绑定。

## 后续工作

1. 将跨协议响应对象和 SSE 翻译从 Inference 迁入 Protocol，并维持单次结算、增量背压。
2. 收敛 Gateway 的重复预检：保障无损能力检查一次，真实请求仅转换一次，不额外复制完整上下文。
3. 用 Code-Max 做真实工具、流、错误分类和 CPU/内存/延迟验收；通过前不切生产。
