# 能力中心源码拆分：依赖约束与阶段门禁

本文件追踪源码迁移，不证明 Cloudflare 生产环境已切换。

## 最终结构

- `apps/gateway`：客户端认证、模型授权、Tier 选择、准入、Failover、Hedge、预算、首事件提交与转发。
- `apps/inference`：Provider 执行、OAuth/订阅、Chat/Responses/Messages 转换与流式协议。
- `apps/perception`：已有图片/多模态理解的真正执行；不存在的 OCR/视频能力不得建空壳冒充。
- `apps/generation`：图片生成及未来异步生成任务。
- `packages/contracts`：内网执行契约、错误与物理用量事件；只依赖平台标准 Request/Response/Streams。
- `packages/provider-kit`、`packages/transport`、`packages/observability`：仅放跨业务单元复用的基础设施。
- `operations`：Dashboard、聚合、维护，不进入请求热路径。

## 已落实的第一阶段约束

`packages/contracts/execution.ts` 统一版本、表面协议、执行票据字段、响应结果与用量事件类型，推理/生成中心及其客户端统一使用该文件，不再分别实现鉴权和头校验。

`npm run check:boundaries` 拒绝共享包反向依赖 `src` / `apps`，并拒绝应用直接导入另一个应用的源码。重构期间旧的 `src` 实现仍存在，不能据此宣称 Gateway 已独立。

## 尚待迁移

1. 将实际运行入口和执行代码分别移至各 `apps`，分别构建，并将每个应用的配置/环境类型独立。
2. 网关只调用 `ExecutionTransport`，彻底移走直连 Provider 和 OAuth。
3. 由推理中心拥有双向协议转换、流处理和物理上游用量；Gateway 仅有界检查首事件。
4. 对已有多模态理解建立真实感知中心，不制造无功能服务；生成中心继续完善非幂等边界。
5. 独立运维与可观测处理；新增本地 HTTP Mock 合同测试；删除入口旧路径和例外。

## 验收原则

每一个批次须通过 TypeScript、Biome、中心契约负面用例、中央 Action Worker 门禁；任何运行时兼容性变化须有与当前源码行为的对照测试。本阶段不修改生产 Secret，不改变路由或部署入口，不自动发布。
