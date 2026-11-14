# Protocol Center · 第一阶段

## 范围

新增私有 `ai-protocol-center`，只做转换预检，不执行 Provider 请求、用户鉴权、模型选择、Key 调度或重试。

Gateway 在配置 `AIG_PROTOCOL_SERVICE` Service Binding 与 `AIG_PROTOCOL_AUTH_KEY` Secret 后可以使用独立中心。未配置绑定时沿用 Inference 预检；显式绑定但缺少 Secret 或中心不可用则拒绝，不允许静默回退。

## 不变约束

- 预检只返回保真等级、固定诊断标记和错误字段，不返回消息、工具 Schema、API Key 或转换结果。
- 六个方向均复用原 `packages/conversion-core` 矩阵，禁止硬编码上游模型能力。
- Inference 实际请求转换和响应流转换暂时保持原样，避免未验证的生产断链。
- 仅增加构建、契约和门禁测试，不修改生产部署清单、Secret 来源，也不启用 Gateway 生产绑定。

## 后续工作

1. Protocol Center 接管实际请求转换，区分无损直通与跨协议处理。
2. 接管跨协议响应对象及背压流转换，不重复缓冲长上下文。
3. 使用 Code-Max 做实际工具、流、错误分类及 CPU/内存/延迟验收；通过前不切生产。
