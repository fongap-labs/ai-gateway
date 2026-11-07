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

## 已迁移的运行入口

运行入口分别落在 `apps/gateway/index.ts`、`apps/inference/index.ts`、`apps/generation/index.ts`；原有 `src/index.ts` 等路径仅保留兼容性转发，现有 Wrangler 配置不改变，避免本批次触发生产部署行为变化。

## 能力中心物理执行职责

`apps/inference/index.ts` 和 `apps/generation/index.ts` 仅保留私有 HTTP 鉴权、执行票据验证及健康检查；物理上游请求、OAuth/订阅解析和生成结果归一化分别归入各自的 `execution.ts`，错误信封由各自 `response.ts` 定义。两中心均不允许实现 Tier 调度、跨节点重试或对冲；中心内部业务逻辑仍需继续从共享 `src/` 依赖中抽离。

## 单一 Tier 执行循环

`apps/gateway/tier-loop.ts` 拥有原 `src/request/handler.ts` 的实际 Tier 1/2/3 物理尝试调度，使用现有策略选择器、每请求逻辑预算与 Hedge 模块。此轮仅迁移位置，不修改任何调度算法。现存 `src/request/tier-loop.ts` 继续提供 Tier 分配等纯辅助函数，不创建第二套调度。后续随着请求处理模块的完全迁移，将消除 `src/request/handler.ts` 的过渡引用。

## 运维入口拆分

`apps/gateway/index.ts` 只负责用户请求；`operations/maintenance/usage.ts` 负责定时统计维护。`src/index.ts` 为当前 Cloudflare 入口组合二者，保留既有 cron 行为，后续才将维护任务拆成独立部署单元。新增标准 HTTP Mock 调用测试，不需要实际 Cloudflare Service Binding。

## 尚待迁移

1. 将各应用内部执行源码从 `src/` 继续迁移至各自目录，随后独立构建并分离环境配置类型。
2. 网关只调用 `ExecutionTransport`，彻底移走直连 Provider 和 OAuth。
3. 由推理中心拥有双向协议转换、流处理和物理上游用量；Gateway 仅有界检查首事件。
4. 对已有多模态理解建立真实感知中心，不制造无功能服务；生成中心继续完善非幂等边界。
5. 独立运维与可观测处理；新增本地 HTTP Mock 合同测试；删除入口旧路径和例外。

## 验收原则

每一个批次须通过 TypeScript、Biome、中心契约负面用例、中央 Action Worker 门禁；任何运行时兼容性变化须有与当前源码行为的对照测试。本阶段不修改生产 Secret，不改变路由或部署入口，不自动发布。
