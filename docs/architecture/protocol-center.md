# Protocol Center · 分阶段迁移

## 范围

新增私有 `ai-protocol-center`，在明确配置 Service Binding 后处理跨协议预检与请求转换。它不保存 Provider 凭据、不选择 Key、不执行 Provider 请求、不承担 Tier 调度或重试。

Gateway 在配置 `AIG_PROTOCOL_SERVICE` Service Binding 与 `AIG_PROTOCOL_AUTH_KEY` Secret 后可以使用独立中心。未配置绑定时沿用 Inference 预检；显式绑定但缺少 Secret 或中心不可用则拒绝，不允许静默回退。

## 不变约束

- 预检只返回保真等级、固定诊断标记和错误字段，不返回消息、工具 Schema、API Key 或转换结果。
- 六个方向均复用原 `packages/conversion-core` 矩阵，禁止硬编码上游模型能力。
- 阶段二的跨协议调用链：Gateway → Protocol（一次请求转换）→ Inference（一次物理请求与兼容响应转换）→ Protocol（原样回传）→ Gateway。
- v7 保留兼容：Inference 可接管已准备请求且自行转换响应。
- v8 由 Protocol → Inference 签发：Inference 一次物理请求后返回原生响应字节与非敏感元数据；Protocol Core 根据原始请求与目的协议单次转换对象、SSE、流式预算，使用既有私有分帧向 Gateway 回传物理用量。
- 原生请求保持 Gateway → Inference 直通；无新 Service Binding 时继续使用已有 v1-v6 转换。
- 原生协议直接 Gateway → Inference，绕过 Protocol；所有未绑定环境仍按旧逻辑执行，不能因为新代码存在就改变生产流量。
- 仅增加构建、契约和门禁测试，不修改生产部署清单、Secret 来源，也不启用 Gateway 生产绑定。

## 后续工作

1. 收敛 Gateway 的重复预检：保障无损能力检查一次，真实请求仅转换一次，避免无效内存拷贝。
2. 补齐生产部署四中心与 Operations 的独立鉴权、Service Binding 及回滚契约；不改既有变量命名。
3. 用 Code-Max 做真实工具、流、错误分类及 CPU/内存/延迟验收，通过前不切生产。
