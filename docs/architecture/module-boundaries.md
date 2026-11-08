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

## 源码静态质量门禁

Biome 范围覆盖 `src/**/*.ts`、`apps/**/*.ts`、`packages/**/*.ts`、`operations/**/*.ts`；TypeScript 严格类型检查覆盖相同运行时代码。`check:boundaries` 验证这些源码目录不能被未来配置遗漏。

## 已落实的第一阶段约束

`packages/contracts/execution.ts` 统一版本、表面协议、执行票据字段、响应结果与用量事件类型，推理/生成中心及其客户端统一使用该文件，不再分别实现鉴权和头校验。

`npm run check:boundaries` 拒绝共享包反向依赖 `src` / `apps`，并拒绝应用直接导入另一个应用的源码。重构期间旧的 `src` 实现仍存在，不能据此宣称 Gateway 已独立。

## 已迁移的运行入口

运行入口分别落在 `apps/gateway/index.ts`、`apps/inference/index.ts`、`apps/generation/index.ts`；原有 `src/index.ts` 等路径仅保留兼容性转发，现有 Wrangler 配置不改变，避免本批次触发生产部署行为变化。

## 请求与鉴权控制面归属

Gateway 应用直接持有 `apps/gateway/request-handler.ts` 和 `apps/gateway/preflight.ts`，负责入口认证、模型授权、请求编排、家族回退以及统一的请求级调度预算。`src/request/handler.ts` 与 `src/request/preflight.ts` 变为兼容性导出，供既有测试和旧内部引用逐步迁移。现阶段它们仍使用 `src/` 内的其他策略/配置工具，未声称 Provider 与协议转换已彻底迁出。

## 能力中心物理执行职责

`apps/inference/index.ts` 和 `apps/generation/index.ts` 仅保留私有 HTTP 鉴权、执行票据验证及健康检查；物理上游请求、OAuth/订阅解析和生成结果归一化分别归入各自的 `execution.ts`，错误信封由各自 `response.ts` 定义。两中心均不允许实现 Tier 调度、跨节点重试或对冲；中心内部业务逻辑仍需继续从共享 `src/` 依赖中抽离。

## Provider 静态路由描述符

`packages/contracts/provider-profiles.ts` 只提供 Provider 协议、surface、流式用量能力和 Tier 2 默认上游地址等无凭据的路由元数据。Gateway 配置解析器从该模块读取，避免直接调用 `src/providers/registry.ts` 的真实 Provider Adapter。使用 `scripts/check-provider-profiles.mjs` 对所有内置及未知 Provider 逐一验证与实际适配器语义一致。目前 OAuth 默认常量与旧直连路径仍可能通过其他模块间接引用注册表，不能据此宣称 Gateway 已不包含 Provider 代码。

## 图片能力目录与执行权限边界

`packages/contracts/image-capabilities.ts` 仅包含纯能力声明及无凭据的初步资格判断，不导入具体 Provider Adapter。Gateway 预检只用轻量描述符筛选路由候选；Generation Center 独立重新验证真实 Provider Adapter、节点、模型映射和上游 URL。`scripts/check-image-capabilities.mjs` 用三种实际图片适配器交叉核对支持尺寸、映射和非法组合，防止声明漂移。这并不表示 Gateway 其他配置模块中的 Provider 导入已经全部清除。

## 旧 Provider 执行路径隔离（待删除）

`src/request/attempt/dispatch.ts` 已收敛为单次尝试记账和能力中心选择；原本混杂在该文件中的 URL、OAuth、Provider 私钥、物理 fetch、错误响应及订阅线协议处理迁入专用的 `src/request/attempt/legacy-provider-dispatch.ts`。`attempt-mode.ts` 保持缓冲判定单一实现。新边界检查阻止调度层重新导入 Provider/OAuth。

**注意：这仍是源码层面隔离，不是删除旧执行路径。** 未绑定私有中心的环境仍使用兼容分支；下一阶段必须先完成中心合同等价测试，然后彻底删除它及其执行密钥依赖。当前不修改生产部署配置。

## 纯协议转换核心已抽离

`packages/conversion-core` 独立维护 canonical IR、转换预算、诊断结果、输入校验和诊断收集器。它不依赖 Gateway、Provider Adapter、Cloudflare 或 `src/` 中的运行时实现。旧 `src/conversion/` 入口仅保留兼容性导出，确保转换器类身份及旧调用路径不变。独立合同测试会验证所有导出保持同一引用，避免出现两套预算与转换错误类型。

**阶段限制**：这一步只是抽离纯转换核心，并未把请求正文和流式矩阵的实际执行从 Gateway 迁出。后续必须将协议转换、流处理放入 Inference Center，删除旧直连兼容路径。

## 推理中心转换器迁移：Chat

Chat 对象转换器与 Chat SSE 编解码器现由 `apps/inference/conversion/chat.ts`、`chat-stream.ts` 持有，依赖中立的 `packages/conversion-core`；旧 `src/conversion/matrix/chat*.ts` 仅保留 re-export，防止出现两套解析器或转换错误类型。`check:inference-chat-codec` 同时检查负向字段校验、流事件和类身份。

**当前仍是源码所有权迁移**：Gateway 的 fallback 和响应转换仍经兼容导出调用这些编解码器，下一阶段需将 Anthropic/Responses 编解码器和完整的正文、SSE 转换执行迁入 Inference Center，然后消除 Gateway 对转换实现的运行时依赖。

## 推理中心转换器迁移：Anthropic

Anthropic Messages 对象解析器与 SSE 编解码器已移入 `apps/inference/conversion/anthropic*.ts`，直接依赖 `packages/conversion-core` 与本中心 Chat 转换器。旧 `src/conversion/matrix/anthropic*.ts` 只提供原函数与类的兼容导出。中央合同之外，新增独立的模型字段校验、SSE 终止及身份一致性测试。

**阶段限制**：Responses 及完整 Matrix Pipeline 仍使用旧目录；Gateway 尚会经兼容导出执行协议转换，待全部 codec 稳定后迁移执行调用边界。

## 推理中心转换器迁移：Responses

Responses 对象转换和 SSE 编解码实现由 `apps/inference/conversion/responses*.ts` 持有。原生 Responses SSE 事件构造器已作为纯模块迁至 `packages/conversion-core/responses-events.ts`，Gateway 及推理中心可共享同一个类和事件格式。所有旧路径只提供同一实现的兼容导出，新增负向字段校验、终态和序号格式合同测试。

**阶段限制**：尽管 Chat、Anthropic、Responses 的协议编解码源码均已归推理中心，Gateway 仍通过旧导出执行 Matrix Pipeline 请求/响应转换。下一阶段要将其执行逻辑及流式边界真正移入推理中心。

## Matrix 请求转换执行入口

六组 Chat、Anthropic 和 Responses 的请求协议转换现由 `apps/inference/conversion/request.ts` 唯一实现，`src/conversion/matrix/pipeline.ts` 通过兼容导出保持原函数身份，原有 Gateway 路由暂不改动。`check:inference-matrix-request` 验证六组有向转换、默认强制流式、显式非流式偏好和不支持字段的安全失败。模块边界门禁拒绝旧实现回流。

仍待迁移：响应对象转换与 SSE 读取、用量结算边界，以及真正通过内网调用由 Inference Center 执行协议转换。不能将源码归属迁移等同于生产 Worker 之间的调用切换。

## Matrix 响应对象转换

`apps/inference/conversion/response.ts` 现持有原生 Provider 响应对象到 IR 的解析，以及 IR 到 Chat、Anthropic、Responses 三协议对象的渲染。原 `pipeline.ts` 仍通过同一组函数执行被动兼容调用，避免重复实现。新增兼容函数身份、文本与用量形状测试；`check:boundaries` 禁止重新引入旧实现。

剩余：Matrix SSE 读取/编码、首事件/中断边界和用量结算仍位于旧执行路径；未变更任何真实请求或中心服务绑定。

## SSE 共用传输原语迁移

流扫描、流转发、读取截止时间与合成流内部标记现由 `packages/transport` 唯一持有。旧 `src/stream/guard.ts` 仍持有首事件提交、回放与失败恢复边界，仅从中立模块导入 SSE 扫描器。旧 `src/conversion/sse.ts` 仅保留兼容导出。这样后续推理中心可以接管 Matrix SSE 流管道而不反向导入 Gateway 的流守卫。

## Matrix SSE 流转换归属

`apps/inference/conversion/stream.ts` 唯一持有 Matrix SSE 解码/编码、非流式对象收集、转换预算终止以及合成 SSE 响应；只依赖中立 `packages/transport`、`packages/conversion-core` 和本中心 Codec。旧 `src/conversion/matrix/pipeline.ts` 仅保留 Request、Response 和 Stream 的同一实现兼容导出。中央合同及本地身份/终态/合成事件测试覆盖原调用路径。

Gateway 继续持有原有首事件预提交、跨节点 Failover、路由授权和用量结算。**注意：真实 Worker 内网执行仍需迁移**，不能将此 PR 视为网关请求热路径已不运行转换实现。

## v2 推理中心实际请求转换（迁移阶段）

跨协议推理使用内网执行契约 **v2**：新增源协议 `x-aig-input-surface` 与可选的 `x-aig-conversion-prefer-nonstream`。原生推理和生成调用继续使用 v1。中心严格校验合约版本、源/目标协议、节点/模型、过期时间和中心密钥：旧 v1 中心拒绝 v2 请求，避免将原始客户端正文误发到上游。因此后续如需部署，**必须先发布支持 v2 的中心，再发布使用 v2 的 Gateway**；本次仅修改源码。

Gateway 的 `runFallbackChain` 继续进行独立转换可行性和高风险语义损失预检，维持“转换失败不占用物理尝试”与 Tier/Failover 不变；实际传输给 Inference Center 的是原始客户端协议正文，中心验证请求后以唯一的 `convertMatrixRequest` 完成转换，再做物理模型映射和 Provider 请求。两者共用 `packages/conversion-core/fidelity-policy.ts` 保守降级边界。

中心仍返回目标 Provider 的原生响应，Gateway 现有 `success-matrix` 负责反向响应转换、首事件提交和用量结算；**这些职责尚未完成下沉**。后续还要移除 Gateway 转换预检的执行依赖，提供不泄露正文的能力声明与预检契约，再删除旧直连 Provider 路径。当前未改动任何部署绑定或生产 Secrets。

## v3 非流式响应对象转换下沉

新增内网执行契约 **v3**：仅对跨协议的 `inputSurface` 且 `preferNonstream=true`、客户端不请求流/伪流的情况，请求票据增加 `x-aig-return-object: true`。v1 原生、v2 请求转换和 SSE 流转发保持原有行为；旧中心收到 v3 将拒绝，禁止默默把新报文当成 v2。

当上游成功返回有实际文本/工具调用的 JSON 对象，Inference Center 使用 `replyFromNativeObject` 与 `replyToObject` 在**中心内部**转换目标协议 → 客户端协议，返回带 `x-aig-response-format: translated-object-v1` 标记的私有封装 `{kind, response, upstreamUsage}`。Gateway 收到可信中心封装后直接输出 client response、按 `upstreamUsage` 进行物理账本结算，不再二次解码/重编码对象。空回复、非法格式仍沿旧成功层分类；真实 SSE 继续透传到 Gateway 的首事件守卫与 Matrix 流处理。

注意：此批次下沉的是**成功的非流式对象响应**，并非所有 SSE。中心仍不负责 Gateway 的逻辑请求调度、首事件提交、故障回退、限流与结算事务。后续要独立迁移流式响应转换及协议兼容预检，并在完成等价测试后删除旧 Provider 直连执行。部署必须**先升级支持 v3 的 Inference Center，再升级 Gateway**；本 PR 不触发部署或密钥更新。

## Gateway 请求转换预检委托（中心已绑定）

已绑定 `AIG_INFERENCE_SERVICE` 的 Gateway 在跨协议 fallback 前调用 `/internal/conversion/preflight`（独立版本 1、复用中心高熵认证、1.5s 上限，校验 UUID 和 Deadline）。中心只读解析客户端正文并运行 Matrix 请求转换，响应**仅包含固定的 fidelity/diagnostics/structuredOutput 或拒绝字段名**，不返回提示词、消息、工具参数、转换后的正文，也不接触 Provider 或任何 OAuth 凭据。

Gateway 依据诊断继续拒绝高风险语义丢失并安排 Tier 选择；中心不拥有重试、Hedge、429、节点权重和物理尝试预算。中心拒绝或连线故障会返回明确的 503，**不能回退为 Gateway 本地转换或 Provider 直连**，且不计入物理尝试。此端点必须随中心先部署，再部署 Gateway 的委托调用。尚未绑定中心的兼容路径仍由 Gateway 本地执行转换并保留其原有行为，以便最后删除旧 Provider 路径时统一清理。

当前新增预检独立内网调用（仅跨协议 fallback 阶段），需后续观察其耗时和消耗；不作为生产部署验收或性能改进的证明。SSE 流式响应下沉与完整撤除旧直连仍未完成。

## 下一阶段：Inference 私有流式分帧通道（尚未切流）

`packages/contracts/inference-stream-frames.ts` 提供运行时中立的版本化二进制流分帧：客户端 SSE 字节（chunk）、原始 Provider 用量（usage）、转换预算停止原因（budget）与完整终止标志（done）在同一私有传输中独立编码。解码器支持分块边界、总尺寸限制、非法帧拒绝、终止完整性校验和取消向上传播，绝不把 usage/budget 原始载荷当作客户端 SSE。

`apps/inference/conversion/framed-stream.ts` 已可调用真实 Matrix SSE 编解码器并生成私有分帧流；`src/inference/inference-stream-client.ts` 只将经内部响应格式与内容类型校验的流解出，并提供原始用量与预算事件回调。新增本地合同测试验证 Chat→Anthropic SSE 转换、独立物理用量、预算停止、损坏/截断/伪造帧拒绝及取消传播。架构检查禁止将协议内用量直接透传。

**当前没有改动 v1/v2/v3 执行契约，也没有让 Gateway 在生产请求中使用该格式。** 下一批需要明确 v4 能力协商、上游首事件预提交与 Failover 边界、预算停止的中性结算、原始用量 exactly-once，以及未标记/未知版本的硬拒绝，然后才能启用真正的中心流式响应转换。正式运行仍须先中心后 Gateway 升级；不得在缺少 Gateway 解帧器时下发私有帧。

## Gateway 控制面 fallback 编排

`apps/gateway/fallback.ts` 拥有跨协议目标遍历、语义损失拒绝、统一墙钟 / 尝试预算和共享 Tier 策略。旧 `src/request/fallback.ts` 只保留测试/兼容导出；Gateway 请求处理器直接使用自有模块。这个阶段尚未下沉正文转换：`convertMatrixRequest` 及响应 SSE/IR 处理目前仍经 `src/conversion/` 在 Gateway 请求链中执行，不能把目录搬迁误报为执行面隔离。后续应使能力中心拥有预检、转换与物理尝试，并从 Gateway 移除对正文转换器的运行时调用。

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
