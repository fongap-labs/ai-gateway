# 开发策略

Fongap Labs 共享的开发治理规则维护于：

- https://github.com/fongap-labs/action-worker/tree/main/docs

本文件暂时保留，是因为当前 ai-gateway 的策略契约测试仍会读取这一路径。它不是独立的治理权威。

项目本地的开发不变式定义于[产品策略](product-policy.md)中：

- **Clean replacement rule**（干净替换规则）：当规范设计发生变化时，应在同一次变更中删除被取代的路径（remove the superseded path in the same change）。
- Tier 1 is free-token capacity; Tier 2 is reserved for membership/subscription entitlements; Tier 3 is reserved for paid API capacity（Tier 1 是免费 token 容量；Tier 2 保留给会员/订阅权益；Tier 3 保留给付费 API 容量）。
- **Project release numbering is not an engineering automation concern**（项目发布编号不属于工程自动化的范畴）：发布编号是人工在源码契约之外按需创建的。
- gateway 专有的质量与依赖要求，仍保留在本目录的[质量策略](quality-policy.md)与[依赖策略](dependency-policy.md)中。

待契约测试改为直接读取规范文档之后，本兼容页面即应删除。
