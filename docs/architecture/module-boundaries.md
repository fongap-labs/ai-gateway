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

## 生成中心独占图片执行（本批已收敛）

Gateway 图片请求现在**无条件委托** `dispatchGenerationAttempt`，不再取决于 `AIG_GENERATION_ACTIVE` 或 Service Binding 是否预先存在。缺失私有中心绑定/认证时明确返回 503，不能落入旧 Provider 直连。旧 `legacy-provider-dispatch.ts` 的图片适配、直接请求和图片异常处理已删除，保留的旧直连仅服务于尚未完成测试迁移的推理路径。中央图片生成测试使用真实私有 Generation Center 内存绑定模拟物理 Provider 请求；静态边界检查防止未来回归。此轮未修改任何部署或生产密钥，启用这一源码版本前必须具备可用的私有 Generation Center。

## 旧 Provider 执行路径隔离（推理部分待删除）

`src/request/attempt/dispatch.ts` 已收敛为单次尝试记账和能力中心选择；原本混杂在该文件中的 URL、OAuth、Provider 私钥、物理 fetch、错误响应及订阅线协议处理迁入专用的 `src/request/attempt/legacy-provider-dispatch.ts`。`attempt-mode.ts` 保持缓冲判定单一实现。新边界检查阻止调度层重新导入 Provider/OAuth。

**注意：这仍是源码层面隔离，不是删除旧执行路径。** 未绑定推理中心的环境仍使用推理兼容分支；图片生成已经彻底脱离旧路径。下一阶段须迁移推理中央合同测试，再删除剩余推理直连及其密钥依赖。当前不修改生产部署配置。

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

## v4 推理流式执行分批接入（无转换预算路径）

私有推理中心已在契约 v4 接收明示的 `x-aig-return-stream: true` 与已授权的对外模型名称（`x-aig-display-model`），强制仅接受**跨协议 + stream=true + 无非流偏好**。v1/v2/v3 不允许携带这些字段；旧中心不认识 v4 会硬拒绝，避免将私有二进制协议误作为公开 SSE。中心执行真正的 Matrix 流式转换并返回 `inference-framed-v1` 私有流，数据、Provider 物理用量及终态分开编码。上游不支持 SSE 而返回原生 JSON 时仍保持旧对象回退处理，不伪造分帧标记。

Gateway 当前仅在绑定中心、客户端真实请求 SSE 且 `conversionBudget=false` 时申请 v4；开启 `AIG_CONVERSION_BUDGET` 的所有流请求仍沿 v2 的既有 Gateway 转换路径，等待预算中立结算等价验证。Gateway 在**首事件检查前**严格校验并解开私有分帧，第一输出判断基于客户端协议而非 Provider 目标协议；用量由私有回调交给现有 `observeUpstreamAttemptUsage` / `recordTokens` 的单次账本，不重复解码客户端数据。取消、超时、首事件失败及转换数据结算仍由原 Gateway 守卫和流跟踪层管理。中心未持有 Tier/Hedge/429 或客户端计费权。

**部署顺序必须先支持 v4 的 Inference Center，随后是申请 v4 的 Gateway。** 本批仅修改源码并以本地模拟 Provider 测试验证，未触发部署。后续分批支持转换预算帧和预算中性结算；再评估完全淘汰 v2 流转换、无中心时的旧直连路径。

## v5 跨中心转换预算：中心执行、Gateway 结算

预算已开启且客户端要求 SSE 时，Gateway 使用 `ExecutionContract v5`：除了 v4 的源/目标协议与公开模型，还通过 `x-aig-stream-budget` 发送严格校验的 mode（`error`/`truncate`）和五项有界预算。旧 v4 禁止该头，旧中心不能接受 v5，从而避免静默绕过预算。无预算流仍使用 v4；原生 v1/v2、非流式 v3 均未改变。

Inference Center 按此票据配置唯一 `openMatrixStream` 的预算 Tracker。超限时，中心产生与原 Gateway 相同的协议错误片段或短回复，并在私有传输帧上独立发送预算停止原因。Gateway 解帧后继续执行原首事件判定、原始 Provider 用量观测与一次性结算：`error` 模式为中性结束，不重复计入交付或节点故障；`truncate` 模式为成功的正常短回复。预算帧不能进入公开 SSE。

滚动升级顺序必须是**先中心后 Gateway**；此次只更改源码与门禁，不改部署、Secrets、Service Binding 或生产路由。后续仍须进一步清除 Gateway 的旧直连 Provider 执行路径与重复转换实现依赖。

## Gateway 控制面 fallback 编排

`apps/gateway/fallback.ts` 拥有跨协议目标遍历、语义损失拒绝、统一墙钟 / 尝试预算和共享 Tier 策略。旧 `src/request/fallback.ts` 只保留测试/兼容导出；Gateway 请求处理器直接使用自有模块。这个阶段尚未下沉正文转换：`convertMatrixRequest` 及响应 SSE/IR 处理目前仍经 `src/conversion/` 在 Gateway 请求链中执行，不能把目录搬迁误报为执行面隔离。后续应使能力中心拥有预检、转换与物理尝试，并从 Gateway 移除对正文转换器的运行时调用。

## 单一 Tier 执行循环

`apps/gateway/tier-loop.ts` 拥有原 `src/request/handler.ts` 的实际 Tier 1/2/3 物理尝试调度，使用现有策略选择器、每请求逻辑预算与 Hedge 模块。此轮仅迁移位置，不修改任何调度算法。现存 `src/request/tier-loop.ts` 继续提供 Tier 分配等纯辅助函数，不创建第二套调度。后续随着请求处理模块的完全迁移，将消除 `src/request/handler.ts` 的过渡引用。

## 运维入口拆分

`apps/gateway/index.ts` 只负责用户请求；`operations/maintenance/usage.ts` 负责定时统计维护。`src/index.ts` 为当前 Cloudflare 入口组合二者，保留既有 cron 行为，后续才将维护任务拆成独立部署单元。新增标准 HTTP Mock 调用测试，不需要实际 Cloudflare Service Binding。

## 节点元数据与 Provider 凭据隔离（本批源码）

Gateway 在以下已明确属于能力中心的候选节点上，只解析公开节点元数据，不再要求或留存静态 Provider 凭据：

- Inference Center 已有私有 Service Binding，或受控激活标记 `AIG_INFERENCE_ACTIVE=true`；
- 仅支持 `images_generations` 的图片 Provider（图片请求已强制通过 Generation Center）。

当 Gateway 已明确启用 Inference Center 时，即使运行环境仍残留旧的 `AIG_TIER*_CREDENTIALS_*`，也只枚举分片名称，不读取或解析其值；过期密钥、错误 JSON 不会进入公开网关内存中的凭据映射。未启用 Inference Center 的旧推理路径仍需要解析凭据，直至最终退役。

私有 Inference / Generation Center 的 `loadExecutionConfig` 仍严格要求静态凭据，不能因为公开 Gateway 可无密钥规划而放松中心的密钥校验。Gateway 未启用推理中心时的旧直连仍须提供真实凭据；这一批不读取、移动、复制或删除生产 Secret，也不修改生产部署。下一阶段才能经受控方案从 Gateway 运行时清单中移除剩余 Provider 凭据和 OAuth 执行依赖。

## 中央推理端到端回归：原生与故障切换第一批

中央 Action Worker 黑盒集成测试现将原生 OpenAI Chat 成功和同 Tier 503→健康节点切换两条路径经真实私有 `handleInferenceCenterRequest` 执行；Gateway 只持有节点元数据与中心认证，物理 Provider 凭据仅在中心测试环境中。对请求身份、上游映射、物理访问次数、鉴权头隔离及客户端隐藏拓扑持续验证。测试包通过固定 SHA 引用，便于审计和回归。

**迁移边界**：这仅代表两条执行路径的真实中心合同回归覆盖，其他中央推理测试仍有未绑定中心的直连模拟；不能据此删除 `legacy-provider-dispatch.ts`。后续按 OAuth、流式、跨协议转换、错误/配额及对冲类别继续迁移，确认等价后移除旧实现。本批不改运行时或生产部署。

## 中央推理端到端回归：协议与 SSE 第二批

中央测试包现新增将 Anthropic Messages 原生非流式及 SSE、Messages → Chat 转换、Responses 原生执行、Responses → Chat 转换等五条既有黑盒场景切到真实私有 `handleInferenceCenterRequest`。每条均验证内部中心调用次数，保留对外模型名、SSE 生命周期、跨协议对象、物理上游路径及鉴权隔离断言。Gateway 的测试环境不再保留这些场景的 Provider 静态密钥。

第一批覆盖原生 Chat 与同 Tier 故障切换，第二批覆盖上述协议与流式场景。**其余未迁移的中央测试仍允许旧直连**，不能据此宣布整体退役完成；OAuth/订阅、复杂 SSE 中断与响应错误、对冲、流量配额仍需中心化覆盖后才删除旧路径。

## 中央流式提交边界回归：第三批

中央 Action Worker 黑盒回归已将三项真实 SSE 执行边界迁至私有 Inference Center：仅有 role 的首事件不构成有效提交，仍可改走同 Tier 健康节点；产生有意义的文本后，即使上游 Reader 故障也不能透明重放到第二节点；流式会话期间 Tier 1 inFlight 占用保持，终止帧结算后归零。以上测试均通过真实私有执行入口，Gateway 不拥有这些 Provider 凭据。

此批为新增等价回归证据，不改变当前运行时；复杂跨协议流式预算中断、OAuth 订阅、配额与对冲仍依赖进一步迁移，**推理旧直连尚不得删除**。本批仅锁定中央测试包，不涉及生产部署。

## 中央调度、429 与对冲回归：第四批

中央 Action Worker 黑盒集成测试进一步将四项既有 Gateway 调度路径接入真实私有 Inference Center：Tier 1→Tier 2→Tier 3 严格有序回退；429 同 Tier 模型级冷却后改走可用节点；冷却期间第二次请求返回携带 Retry-After 的 429 而不发生第二次中心物理执行；Hedge 对冲期间两条竞争尝试均通过中心执行，落败者保持中性健康状态。

验证继续覆盖 Gateway 不持有 Provider 静态密钥、中心物理执行次数、各 Tier 实际调用顺序、冷却指标以及对冲结算。**这只是既有回归覆盖的迁移，不代表全部 Provider 直连调用已删除**：复杂流式预算中断、订阅 OAuth、配额结算变体、协议转换失败及其他旧测试仍待迁移。所有生产路由和部署保持不变。

## 订阅 OAuth 执行回归：第五批

中央 Action Worker OAuth 黑盒测试将 Tier 2 OpenAI Token 解密与 Bearer 分发、无 Token 安全拒绝、Anthropic Bearer 而非 x-api-key，以及 OAuth Refresh Grant 后的 D1 更新与上游执行四条路径迁移至真实私有 Inference Center。

执行测试在发出客户端请求前从 Gateway 环境删除 `AIG_TOKEN_ENCRYPTION_KEY`；私有中心单独持有解密密钥、OAuth Provider 配置和 Token D1 绑定。验证私有 `/internal/execute` 调用、Provider 鉴权头、无 Token 时禁止物理访问、刷新后密文持久化；Gateway 的 OAuth 授权/回调配置与管理端入口仍须单独迁移审查。

本批同时修复了中心路径的订阅预执行语义差距：Inference Center 仅在 OAuth Token 缺失、订阅适配器不可用或拒绝请求且**尚未发出物理 Provider 调用**时，以 `x-aig-result: skipped` 和精确 `x-aig-error-kind` 回报。Gateway 只对 `auth: oauth` 节点及三种受控状态码/错误码组合执行无计费、中性轮转；普通中心异常、未知原因和非订阅节点的伪造 skipped 状态仍失败关闭，禁止静默绕过中心直连。缺失 Token 的旧 502 调度耗尽语义由中心恢复，且不会接触 Provider。

这完成了有限的 OAuth 执行语义修正，但不代表 OAuth 管理端或全部旧 Provider 直连依赖已经删除。**不得据此删除 `legacy-provider-dispatch.ts`**；其余复杂错误、订阅失效与流式转换仍需完成等价测试。本批不更改生产配置、密钥或部署。

## 中央错误分类与时限回归：第六批

中央 Action Worker 原有 Gateway 客户端黑盒测试新增五条真实 Inference Center 路径：404 model_missing 仅影响对应模型映射且同节点其他模型正常；客户端 400 有界轮转到同 Tier Provider Key；HTTP 200 返回非 JSON 内容时执行错误分类、节点处罚与轮转；HTTP 200 JSON 内嵌 error 不被误认为成功；wall-clock 截止后不再发起第二个私有中心执行请求并返回 504。

这些测试验证每个 `/internal/execute` 私有调用次数、物理 Provider 调用顺序、节点健康状态以及模型级隔离。Gateway 只保留中心认证与节点元数据，不再持有这些用例的 Provider 密钥。**本批只是第六批等价测试，不等于已删除旧执行路径**，仍需逐项确认缓存、OAuth 管理端、复杂协议流、其他失败分支和全套中央验收。本批不涉及生产部署。

## 中央并发、准入与缓存回归：第七批

Action Worker 黑盒集成测试现将六项 Gateway 调度/流量边界迁至真实 Inference Center：Tier 1 单健康节点并发占用不应硬拒绝第二请求；过时 `QUOTA_RATE_LIMITER` 绑定不得执行 Provider 准入；忙碌 Tier 2 仍可在 Tier 1 失败后作为最后容量；上游 Provider 请求不能携带客户端 Cookie、转发头或内部中心认证；Gateway D1 写故障仅为观测异常，不应中断已成功的中心执行；边缘缓存 MISS 仅进入中心一次、HIT 不触发第二次私有执行。

此批同步校验中心物理执行次数、上游凭据隔离、并发占用释放、健康状态和 Cache MISS/HIT 的对外行为。Gateway 不保留这些请求的 Provider 静态凭据。

中央准入仍必须运行强制密钥扫描及 GitHub Actions 静态分析；校验器只能从官方发布资产下载，并校验固定 SHA-256。网络下载失败不得绕过安全门禁，必须恢复扫描后重新执行完整 CI。**该批完成的是集成测试部分的进一步等价迁移，其他中央测试套件和配置兼容性仍须审查；不能直接宣告旧 Provider 直连删除完毕。** 无生产部署或绑定变更。

## 中央鉴权、配置与只读接口回归：第八批

中央 Action Worker 集成测试中的八条无推理执行路径现改用中心启用、Gateway 不含 Provider 凭据的测试环境：缺失/错误客户端 Key 均拒绝；已删除节点字段构成严格 Schema 错误；禁用协议回退时不会触发私有转换预检；健康检查和公开模型列表只读取节点元数据；构建版本标识受控且已移除的旧版本入口保持 404。

这些测试除保留原有客户端状态码、诊断和响应合同外，还断言 **私有 Inference Center 调用次数为零**，防止鉴权失败、配置错误或只读接口意外触发实际推理。至此中央 `integration-test.mjs` 的现存黑盒用例已经全部进入私有中心模式，但不代表其它中央子测试包均已完成迁移；旧 Gateway Provider 直连仍须按全仓库测试依赖、协议与入口审计结果退役。本批不改变运行时或部署配置。

## 中央跨协议与回退矩阵回归：第九批

Action Worker 的 `protocol-fallback-test.mjs` 中 protocol-matrix 测试组已整体使用私有 Inference Center：Chat、Messages 和 Responses 原生 Provider 选择；同 Surface 失败切换；Responses→Messages、Chat→Messages、Messages→Chat 的受控跨协议矩阵；禁用 fallback 后的安全拒绝；Hedge 仅使用相同协议 Surface；节点 Schema 无效时不发起执行；客户端逻辑模型 ID 不被上游物理 ID 污染。

该测试组同时验证 Gateway 端不持有 Provider 静态凭据、内部调用不携带外部客户端认证头；对每个用例要求私有 `/internal/execute` 物理执行数与模拟 Provider 网络访问数严格相等，转换预检不计作物理执行。源代码级的旧 Provider 直连模块仍存在；其他独立测试套件和旧路径下的特殊行为继续按边界审查。本批不修改生产运行时、绑定或部署。

## 中央模型族与物理失败域回归：第十批

Action Worker 的模型族合同测试将 Code-Ultra→Max→Pro 与 Audit-Ultra→Max→Pro 的 429 全暂时性失败顺序改由真实私有 Inference Center 执行，保留原有 Retry-After、故障类型、对外返回 503 和物理模型映射。每个模型族三次中心 `/internal/execute`；Gateway 不读取静态 Provider 密钥。

模型失败域合同验证同一物理模型被多个逻辑别名引用时不会无界重复调用；同账号不同物理模型各有独立失败域；不同 Provider 账号即使映射同一模型也应独立重试。保留原始 2/4/3 次物理访问与 Gateway attempt/dispatch/failure_kinds 计数，并增加相同的中心物理执行次数和客户端凭据隔离断言。

**本批仅提升真实中心回归覆盖，未删除源码旧直连分支。** 下一步按剩余中央套件与模块依赖完成归零审查，确认无旧执行必要后再精简生产 Gateway。未更改生产绑定、密钥或部署。

## 中央 Responses 错误诊断回归：第十一批

中央 `protocol-fallback-test.mjs` 的 Responses 终态诊断已迁移到私有 Inference Center：429 首次物理执行后模型冷却，第二次请求不得重试中心；503 物理失败后的唯一兜底重试仍全部在中心；400 上游错误返回受控客户端信息、不泄露 Provider 原始错误；未知模型直接由 Gateway 拒绝，中心物理执行次数为零。保留原有 `x-gateway-error-code`、attempts、dispatches、failure_kinds 和 Responses 协议 JSON 错误对象。

第十批初始测试包曾因合并阶段重复导入中心入口而在 CI 发生模块语法错误。第十一批中央测试包删除重复导入，确保整个测试套件可以被 Node 正常加载，且保留模型族与物理失败域的所有断言。这些工作仍是回归覆盖，不代替对旧 Provider 源码依赖的全面验收。

第十一批完整回归另外确认：Responses 协议的私有 `/internal/conversion/preflight` 与 `/internal/execute` 是两类不同的内部调用，预检不会发出物理 Provider 请求。中央测试严格限定仅允许这两条已知路径，并只对 `/internal/execute` 统计 Provider 物理派发；429 冷却期间虽然可以预检，但不可重复访问 Provider。以上已纳入固定 SHA 的回归合同。

## 中央客户端准入与订阅开关回归：第十二批

中央 Action Worker 的 `client-budget-test.mjs` 与 `subscription-switch-test.mjs` 现运行于启用 Inference Center、Gateway 不持有静态 Provider 凭据的环境。客户端过期、非法或重复截止时间的拒绝、合法截止时间对 Gateway 总预算的约束、OAuth 管理端禁用开关、订阅节点 Health 元数据及真值解析，保持原有状态码和响应合同，并逐项检查私有中心执行次数严格为零。

这些属于不应发生物理推理的准入/配置测试。流完成、边缘缓存编码等纯函数单元测试不需要人为引入私有 Service Binding，应继续以原职责边界验证。Gateway 旧推理 Provider 直连源码仍未删除；必须先核对剩余实际请求用例、直连接口与部署模式，再实施源码级退役。本批仅更新不可变测试包引用和文档，禁止生产部署。

## Claude Code Messages 原生与回退合同：第十三批

中央 Action Worker `claude-contract-test.mjs` 的 24 项真实 Gateway 客户端黑盒合同现接入私有 Inference Center：Anthropic Messages 原生非流式及 SSE、思考与工具块、工具调用/结果传递、客户端鉴权、400/429/5xx、首事件与截断处理，以及 Claude Code → OpenAI Chat 的 metadata、cache_control、工具调用映射和不可转换语义拒绝。

测试私有中心拥有 Provider 静态凭据，Gateway 只持有节点元数据与内部 Service Binding。每项回归强制对齐私有 `/internal/execute` 调用数与真实 Provider 网络访问数；独立转换预检不作物理调用计算，Gateway 客户端的授权头不得进入中心上游请求。此前协议与一般 SSE 中央合同继续保留。

这只证明该 Claude Messages 测试套件已完成中心等价迁移。Codex Responses 与其他实际 Gateway 请求测试、OAuth 管理端、运行时旧 Provider 直连和部署选择器仍须分别清理，本批不执行生产部署。

## Codex Responses 原生与流式合同：第十四批

中央 Action Worker 的 `codex-contract-test.mjs` 已将 19 项真实 Gateway 客户端黑盒回归切换为私有 Inference Center：Responses 原生非流式与 SSE、reasoning、工具调用与函数参数增量、首事件前与首事件提交后的不同回退规则、401/429/5xx、Responses 诊断头、工具和上下文直传。

测试在独立中心持有 Provider 静态密钥，Gateway 只接入节点元数据、私有 Service Binding 和中心认证。测试以每用例累积计数独立验证 `/internal/execute` 次数等于真实上游 Provider 物理调用次数，避免同一用例重新设置模拟上游时遗漏前一阶段尝试；转换预检不算物理执行。客户端认证不能通过内部请求泄漏。该迁移保持原有客户端 SSE、模型身份和工具形状断言。

此批不代表旧 Provider 直连源码已删除。剩余实际网络测试的中心化、最终依赖扫描、运行时旧路径移除与部署选择器调整仍须独立完成；本批不涉及生产部署。

## 中央压力、并发与取消合同：第十五批

中央 Action Worker 的 `stress-test.mjs` 9 组 Gateway 黑盒压力与故障注入合同已迁移到真实私有 Inference Center：Tier 1 并发突发、P2C 软负载、显式 max_in_flight 限制、Tier 1 耗尽后 Tier 2 兜底、429 限流风暴冷却、half-open 单探针恢复、SSE 提交后客户端取消、wall-clock 总预算截止、混合临时错误的状态释放。

独立中心测试环境持有各 Tier Provider 凭据，Gateway 侧删除所有三层静态密钥；每项测试要求实际 Provider 网络请求数与私有 `/internal/execute` 次数一致，预检单列。原有响应码、并发占用、节点健康、Tier 1 inFlight、取消与防泄漏断言全部保留。**这代表压力合同的测试等价覆盖，不代表完成旧执行分支的源码退役。** 下阶段需审计尚未迁移的真实 Gateway 测试、严格禁止无中心物理派发，并独立评估受保护的旧部署模式；本批不部署。

## 中央 429 模型作用域与 413 尺寸合同：第十六批

Action Worker 的 `rate-limit-strategy-test.mjs` 429 冷却阶梯、配额文本解析、模型/帐号级故障作用域、413 大请求后的小请求可用性、模型缺失恢复等合同仍保留原有算法断言；其中真实 Gateway 请求路径现使用独立私有 Inference Center。Provider 凭据仅存于中心测试环境，Gateway 删除旧 `AIG_TIER1_CREDENTIALS_01` 并通过内部 Service Binding 调度物理执行。

每个用例以增量计数检查私有 `/internal/execute` 与真实 Provider 网络调用次数一致，转换预检另计；内部 RPC 不携带客户端鉴权头。**本批完成的是 429/413 中央回归迁移，尚未删除旧直连源码**。接下来需要对剩余真实 Gateway 客户端合同进行迁移，随后从入口和执行选择器中移除直连旁路，并单独完成生产配置与部署切换审批。本批未更改 Runtime 或部署。

## 中央模型族授权与回退合同：第十八批

中央 Action Worker `reliability-suite-test.mjs` 中原先使用 Gateway 直接 Provider 模拟的两项端到端收敛合同，已改为真实私有 Inference Center 执行：Air-only 客户端只可调用获授权 Air 节点，即使两次上游 503 也不能擅自降级到 Pro/Max；Max 客户端可按策略从 Max 回退至 Pro，但客户端响应的逻辑模型仍为 Max。

在这两项测试中，Gateway 环境删除静态 Provider 密钥，中心环境独立持有凭据但不接收客户端 Access Key；中心 RPC 不携带外部认证头，两个原生 Provider 物理尝试均须有对应的 `/internal/execute` 请求。既有授权隔离、上游实际模型顺序与响应断言保留。

连同本测试包中的热路径缓冲、Retry Budget 和流式稳定性测试，本批进一步减少了依赖旧 Gateway 直连模式的回归覆盖。**但旧执行模块和模式选择器仍存在，不得把测试迁移视为生产源码已完成彻底拆分。** 下一步须排查所有尚未中心化的真实网络测试、删除已无引用的旧直连分支并加强源码边界门禁；本批不触发部署。

## 尚待迁移

1. 将各应用内部执行源码从 `src/` 继续迁移至各自目录，随后独立构建并分离环境配置类型。
2. 网关只调用 `ExecutionTransport`，彻底移走直连 Provider 和 OAuth。
3. 由推理中心拥有双向协议转换、流处理和物理上游用量；Gateway 仅有界检查首事件。
4. 对已有多模态理解建立真实感知中心，不制造无功能服务；生成中心继续完善非幂等边界。
5. 独立运维与可观测处理；新增本地 HTTP Mock 合同测试；删除入口旧路径和例外。

## 验收原则

每一个批次须通过 TypeScript、Biome、中心契约负面用例、中央 Action Worker 门禁；任何运行时兼容性变化须有与当前源码行为的对照测试。本阶段不修改生产 Secret，不改变路由或部署入口，不自动发布。
