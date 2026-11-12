# 源码迁移记录与当前 Worker 边界

## 当前四计算 Worker 架构

- `apps/gateway`：公开请求鉴权、模型授权、额度、两层调度、路由与故障恢复；不直接执行 Provider 推理。
- `apps/inference`：私有推理执行与协议转换；保留既有完整模型池以兼容旧 Gateway，Provider 凭据只在私有 Worker。
- `apps/perception`：私有图像请求入口；仅接受目录显式 vision 模型与支持图像输入的 Provider，复用共享执行器。
  当前仍通过受限的 `apps/perception/index.ts → apps/inference/execution.ts` 过渡依赖复用物理执行器。边界检查只允许这一条已审计的单一执行边，不允许额外跨应用模块依赖；后续必须将无调度职责的物理执行器与所需转换代码一起提取为真正的中立模块，并删除此例外。入口搬迁不代表执行器解耦完成。第一批已将执行票据的协议映射与 Provider 请求头白名单下沉至 `packages/conversion-core/surface-protocol.ts` 和 `packages/transport/provider-forward-request.ts`；第二批进一步将单次 Provider `fetch`、响应头超时、取消和网络错误分类统一到 `packages/transport/provider-attempt.ts`；此模块不得拥有 Tier/模型选择、重试或对冲。第三批将 Chat、Responses、Messages 的对象/流转换与私有帧处理统一收敛到 `packages/conversion-core/matrix/`，`apps/inference/conversion/` 只保留兼容转发；Inference 执行器和预检直接引用中立实现。第四批将 HTTP 边界、Anthropic/OpenAI 协议辅助、Provider 请求路径与 Header 构造，以及模型目录、节点配置、超时与策略校验下沉至 `packages/config-core/`、`packages/protocol-core/`、`packages/transport/` 和 `packages/contracts/`。`src/` 相关旧路径保留纯兼容导出，并检查导出身份、认证与缓冲错误类别。`apps/inference/execution.ts` 与预检不再直接导入 `src/`。Perception 仍临时复用 `apps/inference/execution.ts` 的整体编排，跨应用例外尚未删除；需独立抽离完整编排和 app 层错误响应适配后再清理。
- `apps/generation`：私有生成能力；只持有其执行所需的 Provider 凭据。
- `operations`：独立定时维护入口，使用共享 `TOKEN_STATS_DB`，没有公开 `fetch` 路由且不持有 Provider 凭据。
- `packages/contracts`、`packages/provider-kit`、`packages/transport`、`packages/observability`：跨 Worker 的中立契约和基础设施。

当前运行时只有 Tier 1 → Tier 2；会员 OAuth 执行和 Tier 3 均已退役。四个计算 Worker 之外，Operations 仍为独立统计 Worker；只读在线盘点共覆盖五个 Worker。当前源码职责见[架构概览](overview.md)、[能力 Worker 边界](edge-capability-boundaries.md)和[配置手册](../operations/configuration.md)。Perception 源码范围与生产边界见[Issue #350 实现说明](../operations/perception-center-deployment.md)；Issue #310 保留原有迁移验收历史。

## 历史记录说明

下方各节按批次保留实施当时的源码迁移记录，包含已经过时的“待迁移”、Tier 3、OAuth 和模块状态表述；这些记录仅供追溯，不能作为当前架构、当前待办或生产状态证据。生产部署、Secret、Cron、D1/KV 和健康状态须另按只读盘点与运行证据核验。

## 源码静态质量门禁

Biome 范围覆盖 `src/**/*.ts`、`apps/**/*.ts`、`packages/**/*.ts`、`operations/**/*.ts`；TypeScript 严格类型检查覆盖相同运行时代码。`check:boundaries` 验证这些源码目录不能被未来配置遗漏。

## 已落实的第一阶段约束

`packages/contracts/execution.ts` 统一版本、表面协议、执行票据字段、响应结果与用量事件类型，推理/生成中心及其客户端统一使用该文件，不再分别实现鉴权和头校验。

`npm run check:boundaries` 拒绝共享包反向依赖 `src` / `apps`，并拒绝应用直接导入另一个应用的源码。重构期间旧的 `src` 实现仍存在，不能据此宣称 Gateway 已独立。

## 已迁移的运行入口

运行入口分别落在 `apps/gateway/index.ts`、`apps/inference/index.ts`、`apps/perception/index.ts`、`apps/generation/index.ts`；原有 `src/index.ts` 等路径保留稳定转发入口。Wrangler build 配置只做独立 dry-run，本 PR 不触发生产部署。

## 请求与鉴权控制面归属

Gateway 应用直接持有 `apps/gateway/request-handler.ts` 和 `apps/gateway/preflight.ts`，负责入口认证、模型授权、请求编排、家族回退以及统一的请求级调度预算。`src/request/handler.ts` 与 `src/request/preflight.ts` 变为兼容性导出，供既有测试和旧内部引用逐步迁移。现阶段它们仍使用 `src/` 内的其他策略/配置工具，未声称 Provider 与协议转换已彻底迁出。

## 能力中心物理执行职责

`apps/inference/index.ts`、`apps/perception/index.ts` 和 `apps/generation/index.ts` 提供私有执行入口；Inference 与 Perception 共用经审查的单次推理执行器，Generation 使用独立执行器。中心均不实现 Tier 调度、跨节点重试或对冲；Perception 在上游调用前二次校验图像结构、目录 vision 声明和 Provider Profile。中心内部业务逻辑仍需继续从共享 `src/` 依赖中抽离。

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

Gateway 依据诊断继续拒绝高风险语义丢失并安排 Tier 选择；中心不拥有重试、Hedge、429、节点权重和物理尝试预算。中心拒绝或连线故障会返回明确的 503，**不能回退为 Gateway 本地转换或 Provider 直连**，且不计入物理尝试。此端点必须随中心先部署，再部署 Gateway 的委托调用。Gateway 跨协议 fallback 已不再本地执行请求正文转换；中心绑定缺失、凭据无效或预检不可用时直接失败关闭，不触发物理 Provider 请求。Gateway 的历史矩阵响应 SSE/IR 处理仍需独立下沉，不等于轻网关已全部完成。

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

## 中央请求执行所有权合同：第十九批

中央 Action Worker [#1530](https://github.com/fongap-labs/action-worker/pull/1530) 已通过静态分析、命名、安全、合同、私有沙箱及 validate-merge，并合并为不可变测试包 SHA `17077173f114241ca0172cebe41bd120371f7ea8`。其中 `request-execution-test.mjs` 的真实 Gateway 客户端请求执行合同现统一走私有 `handleInferenceCenterRequest`，中心独立拥有各 Tier Provider 凭据，Gateway 仅持有节点元数据、客户端鉴权和私有中心认证。

原有 Responses 首事件卡顿后的同族模型回退、非 200 错误体卡顿后的节点轮转、缓冲 JSON 合成 SSE，以及正常结束/客户端取消后的请求统计断言均保留。每项新增真实 Provider 网络请求次数与私有 `/internal/execute` 次数一一对应的检查；转换预检不计物理尝试，内部请求不得携带客户端 Authorization 或 x-api-key。

**本批仅完成请求执行所有权的中央回归迁移，尚未删除 `legacy-provider-dispatch.ts`、旧执行模式选择器或 OAuth 管理端代码。** 后续应继续迁移未中心化的真实网络合同，独立验证源码删除不会引入未配置中心时的隐式直连，并在合并前执行完整门禁。本批不修改 Gateway Runtime、生产 Secrets、Service Binding 或部署。

## 中央 Groq ITPM 413 回退合同：第二十批

Action Worker [#1531](https://github.com/fongap-labs/action-worker/pull/1531) 已通过静态分析、命名、安全、中央合同、沙箱和 validate-merge，合并提交 `66fca480ad5c0177b4dd7f93e8036c01ce39ad32`。中央 `cooldown-quota-test.mjs` 的真实 Gateway 请求已通过私有 `handleInferenceCenterRequest` 执行，Tier 1 Groq Provider 与 Tier 2 兜底 Provider 凭据仅存在中心环境。

保留上游返回 413（ITPM 本请求额度超限）时不施加全节点冷却、允许转下一个 Tier 2 候选、对外成功回复及原始物理调用顺序；同时校验每一次 Provider 物理请求恰由一次私有 `/internal/execute` 发起，内部 RPC 不能转送客户端认证头，Gateway 不携带任何静态 Provider 凭据。原本纯函数 413 分类合同保持不变。

**本批只增加中心执行等价回归，不改运行时或生产配置。** 剩余的旧 Gateway Provider 直连与非中心测试仍需逐一排查，未完成前不得删除运行时分支，亦不执行部署。

## 中央跨协议转换遗留合同：第二十一批

Action Worker [#1532](https://github.com/fongap-labs/action-worker/pull/1532) 已通过静态分析、命名、安全、合同、私有沙箱和 validate-merge，合并为不可变测试包 `94708203061ca4bc13394319d7594b587de7b4e2`。中央 `conversion-test.mjs` 的所有真实 Gateway 请求合同现通过 `handleInferenceCenterRequest` 私有中心完成 Provider 访问，覆盖 Anthropic Messages / OpenAI Chat / Responses 的原生与跨协议转换，以及 529/429/5xx 回退、工具调用、首事件超时、Hedge、取消和 SSE 返回行为。

原有客户端响应形状、状态、Provider 调用顺序及时间预算等断言均保留；新增每个黑盒用例的私有 `/internal/execute` 物理调用次数与真实 Provider `fetch` 一一对应的校验，转换预检不计物理尝试。Gateway 测试环境删除静态 Provider Secret，中心独立持有凭据；中心 RPC 只允许已知的私有路径且不传播客户端鉴权头。纯函数转换测试保持原验收职责。

首轮中央 Linux 全量回归发现了实际中心化语义差异：客户端在执行期间主动取消，旧直连返回 499，而私有中心以 499 Response（非抛出异常）结束 RPC 时，Gateway 的 `inference-dispatch.ts` 将缺失 `x-aig-result: dispatched` 的响应错误归类为 503。已在中心 RPC 返回后的处理路径按优先顺序重新检查 Hedge 取消与客户端取消，保持 499 和中性失败分类；仅在确认已物理执行时结算未交付尝试。原始客户端 499 断言未放宽，须以修复后最终 HEAD 的完整中央测试为准。

**本批除中央等价回归外，还包含明确的 Gateway Runtime 客户端取消分类修复；不修改生产 Secrets、Service Binding 或部署。** 仍须审计其它中央套件中遗留的直连模拟以及源码引用，再删除 `legacy-provider-dispatch.ts` 和旧执行模式选择器；不得将测试包迁移误报为运行时退役。

## 新增模型配置驱动与目录合同：第二十二批

Action Worker [#1533](https://github.com/fongap-labs/action-worker/pull/1533) 已通过静态分析、命名、安全、合同、私有沙箱与 validate-merge，并合并为不可变测试包 `00b1131ddc350188b281073e0a8e4d0f2e6445fe`。中央 `model-catalog-test.mjs` 的全新逻辑模型 Brand-New → 上游 gpt-brand-new 真实客户端请求改由 `handleInferenceCenterRequest` 私有执行，仍不需要修改 Gateway 的模型路由源码。原客户端 JSON 内容及 `/v1/models` 中工具能力、推理强度元数据断言保持原样。

新增严格的一次 `/internal/execute` 对应一次真实 Provider 网络调用断言、Gateway 不持有静态 Provider 密钥、中心内部鉴权与外部客户头隔离。模型目录只读查询必须保持中心物理调用与转换预检零增量，不允许元数据接口引发计费请求。

**本批只更新测试包引用与验收记录，不改 Gateway Runtime、Secrets、Service Binding 或部署。** 旧直连源码尚待全套依赖归零后删除。

## Tier 1 保活与可靠性调优合同：第二十三批

中央 Action Worker [#1534](https://github.com/fongap-labs/action-worker/pull/1534) 已将可靠性调优中的真实 Gateway 请求迁移至私有推理中心，覆盖五小时配额型 429 分级冷却、分钟级限流、Tier 3 Retry-After、缓冲/流式/大 Prompt 超时与 Hedge 窗口，以及 Claude Code Messages→Chat 的可选工具和不可降级语义拒绝。原有客户端状态码、冷却状态与请求时限断言保持不变。

中央 Action Worker [#1535](https://github.com/fongap-labs/action-worker/pull/1535) 在 `tier1-capacity-test.mjs` 内迁移五组真实请求：同一密钥 403 后继续服务、单密钥 5xx 的一次受限重试、超过限制不得重试、429/403/400 不得错误进行同密钥重试，以及全节点瞬态故障后的有限恢复。真实 Provider 物理 fetch 必须逐次对应私有 `/internal/execute`；Gateway 不携带静态 Provider Secret，内部 RPC 限制路径与鉴权头。

两项中央 PR 均已通过全部门禁，本批锁定最新不可变 SHA `ffa5c274cd0ded7158e38934e6de7dc6a45b720f`，由 AI Gateway 再进行中央 Linux 全量、Security、CI Evidence、PR Governance 与 validate-merge 验收。**本批不改运行时与部署配置**。凭据冲突、无效分片、部署预检等旧配置语义测试仍然保留原配置环境，整套 Tier 1 容量测试尚未完成中心化；不能因此删除 `legacy-provider-dispatch.ts` 或宣布旧直连已退役。

## 无密钥健康接口与会话亲和合同：第二十四批

中央 Action Worker [#1536](https://github.com/fongap-labs/action-worker/pull/1536) 将 `health-visibility-test.mjs` 三项客户端合同迁移到显式启用 Inference Center 的无 Provider 静态密钥环境：AIR 客户端仅可看到允许的模型节点，PRO 客户端保持全节点可见，未授权请求拒绝 401；所有 `/health` 只读请求必须保证私有中心物理执行与转换预检零调用。该 PR 在 Action Worker 基线更新后重新通过全部门禁，并合并为 `0fb160de1677a9b0abec9fac99c3d65136de914c`。

中央 Action Worker [#1537](https://github.com/fongap-labs/action-worker/pull/1537) 将 `tier1-capacity-test.mjs` 的六组实际 Gateway 请求迁移至私有中心：单密钥无多余 KV 亲和读写、KV 超时与错误不拖慢请求/不制造写入、Claude Code 会话标识识别、每个实际 Provider 尝试精确关联 Analytics 事件以及 Analytics 故障不影响成功请求。保留原 KV 次数、响应状态、计时与事件字段断言；新增私有 `/internal/execute` 对真实 Provider 请求的一一对应检查。配置/密钥冲突与大请求预算等未迁移用例仍单独保留。

本批锁定中央不可变测试包 `0fb160de1677a9b0abec9fac99c3d65136de914c`，须经 AI Gateway 最终 Head 全量 Linux、Security、CI Evidence、PR Governance 与 validate-merge 验收。**仅变更测试包引用与文档，不改生产 Runtime、Secrets、Service Binding 或部署；剩余旧 Gateway Provider 直连和执行选择器尚未退役。**

## Gateway 推理中心强制切换：源码退役门禁

本源码变更移除 `src/request/attempt/legacy-provider-dispatch.ts` 并删除推理旧执行模式选择器。所有推理尝试无条件走私有 `dispatchInferenceAttempt`；Service Binding 缺失或无效时只允许无 Provider 调用的受控 503，而不是凭旧 Secret 静默直连。

`loadGatewayConfig` 对公开 Gateway 不再解析任何 `AIG_TIER*_CREDENTIALS_*` 值，即使旧部署仍注入密钥、或者私有中心尚未配置；仅能力中心的 `loadExecutionConfig` 负责严格读取上游密钥。旧静态配置校验测试如仍假定 Gateway 拥有 Provider 凭据，必须迁移为能力中心验证，不得为凑绿放松中心密钥审查。

中央 Action Worker [#1539](https://github.com/fongap-labs/action-worker/pull/1539) 已整合 Tier 1 共享冷却、Claude Code 高风险字段与 17/19 MiB 大请求的中心等价合同，另有 Action Worker [#1540](https://github.com/fongap-labs/action-worker/pull/1540) 将 17 项剩余 OAuth／订阅上游执行合同迁入私有中心。两批合并后的中央测试包固定为 `138f30ad8143d795702b63495f4edfa79ec59c11`。该源码退役变更必须在最终 HEAD 上完整通过中央 Linux、Security、CI Evidence、PR Governance 与 validate-merge 后才能合并。**不更改生产 Secrets、Service Binding、部署或发布。**

中央 Action Worker [#1541](https://github.com/fongap-labs/action-worker/pull/1541) 进一步将真实架构黑盒请求切至私有中心、把 Provider 凭据冲突判定归属 `loadExecutionConfig`，并维护两阶段源码切换的预算校验。最新不可变中央包为 `9f980005ae776ef5f3676b675b765966787aa783`，AG 当前 HEAD 必须使用该 SHA 通过完整 Linux/Security/CI Evidence/PR Governance/validate-merge 才允许退役旧执行器。旧 Gateway 在任何模式下不能直接持有 Provider 密钥或调用上游；旧中心参数与当前中心实行差异若出现，必须在真实中心修复而非放宽协议断言。

## Operations 源码入口独立（不切部署）

`operations/index.ts` 正式拥有定时维护 `scheduled` 入口，直接调用 `operations/maintenance/usage.ts`；`src/index.ts` 仅保留 Cloudflare 的 `fetch` 和 `scheduled` 兼容组合，公开 `apps/gateway/index.ts` 不承担定时维护职责。静态架构边界门禁强制检查三个文件之间的委托关系，防止统计维护重新混入请求热路径。

此变更不改变现有 `wrangler.jsonc`、Cron 时间、D1 绑定、生产 Secrets、部署或发布。**独立入口不等于 Operations 已独立部署或整套应用已独立构建**：仍须继续隔离其 `src/observability` 依赖并建立独立构建合同。

### 私有中心排除无效节点后的安全轮转

中央回归发现：Gateway 只解析公开元数据时，中心可能因节点凭据冲突将候选排除。中心必须为未进入物理执行的缺失节点返回精确的 `404 / center_route_unavailable / x-aig-result: skipped` 信号；Gateway 仅接受该完整组合做不计费、中性轮转，继续尝试其它通过中心密钥校验的候选。其它未知中心错误继续失败关闭，不能触发旧 Provider 直连。既有中央 `tier1-capacity-test.mjs` 必须验证坏节点被排除且好节点继续返回 200。

## Operations 定时用量维护实现归属

`operations/maintenance/retention.ts` 现在独占实现定时用量维护、小时/天/周与模型保留期清理及聚合失败时的安全延迟删除。Cron 入口经 `operations/index.ts` → `operations/maintenance/usage.ts` 直接调用该实现；原 `src/observability/token-usage-store/retention.ts` 只作兼容导出，现有统计 API 和中央测试入口保持不变。架构门禁禁止恢复双份清理实现，保留先 Flush → 聚合 → 清理的现有顺序。

本次只改变维护源码的职责归属，不变更 D1 表、Cron 时间、持久化语义或部署。**Operations 尚未完全独立构建**：统计 Buffer、Key 与聚合持久化工具仍依赖 `src/observability/`，需要按既定迁移任务继续抽离。

## Gateway 私有能力中心调用客户端归属

将 `src/inference/inference-client-request.ts` 与 `src/generation/generation-client-request.ts` 的传输实现迁至 `apps/gateway/transport/`，Gateway 的推理与生图执行层直接引用新位置；旧路径仅保留单行导出，以维持现有合同调用方兼容。标准 HTTP Request / Response、Service Binding 鉴权、客户端令牌隔离、截止时间及信号透传保持原合同。中央 `check:transport` 同时验证源码归属及私有请求行为。**本项为职责与源码迁移，不涉及能力中心物理执行实现，也不调整生产部署。**

## 中立运行时类型合同：应用解耦

`packages/contracts/cloudflare.ts` 现在拥有 D1 结构类型，`packages/contracts/runtime.ts` 拥有共享环境和执行上下文类型。Gateway、Inference、Generation 与 Operations 直接导入这些中立类型，不再依赖旧 `src/types/` 实现。原 `src/types/cloudflare.ts`、`src/types/runtime.ts` 仅提供兼容性的 type-only re-export，保持既有调用方的类型兼容而不引入运行时代码。

`check:boundaries` 同时遍历 `operations/`，禁止应用和 Operations 重新导入旧 Runtime 类型，禁止 Operations 反向依赖其他应用，并要求三套应用及 Operations 入口直接引用中立合同。此项推进源码/类型依赖解耦，但**不代表 Operations 已独立打包**；统计持久化实现仍依赖 `src/observability/`，后续须继续迁移并验证独立构建。生产配置、密钥与部署均未改变。

## 用量持久化中立模块与 Operations 聚合

D1 Token 用量的时间桶、键与保留期常量、SQL 增量语句、每 isolate 统计缓冲分别位于 `packages/usage-store/{time-buckets,keys,statements,buffer}.ts`，由 Gateway 请求统计与 Operations 定时维护共享。小时→天、天→周的聚合实现归属于 `operations/maintenance/aggregation.ts`，由已有 `retention.ts` 直接调用；旧 `src/observability/` 对应路径全部变为 re-export，保持外部 API 兼容。

`check:boundaries` 现在禁止 Operations 反向导入任何 `src/` 或其他应用，实现静态依赖闭包 `operations/ → packages/`；中立包不得引用 `src/` 或 `apps/`。旧路径不得恢复 D1 缓冲、SQL 和聚合的第二份实现。

本项不改变 D1 表结构、合并缓冲时序、UTC/UTC+8 统计口径、Cron 触发、失败回退与清理顺序。仅完成源码归属，**独立部署及整个仓库的分服务构建合同仍待验证**；不触及生产配置或部署。

## Operations 独立构建合同

`wrangler.operations-build.jsonc` 是仅供源码打包验证的隔离配置，入口为 `operations/index.ts`，不会配置生产 Worker、Service Binding、Token、D1、KV、外部路由或 Cron。合并门禁强制运行 `npm run check:operations`（Wrangler `deploy --dry-run`），以及配置安全合同；它只构建临时工件，不发布或切换服务。

这让 Operations 从独立源码目录进入**可单独打包**的验收阶段。由于未配置生产环境绑定，不能把成功 dry-run 视作已完成生产部署、D1 绑定或 Cron 迁移。当前部署仍由 `wrangler.jsonc` 和旧组合入口承载；不得在本阶段启用独立生产定时任务。

## 三应用独立构建与预检客户端归属

`wrangler.gateway-build.jsonc`、`wrangler.inference-build.jsonc`、`wrangler.generation-build.jsonc` 分别从 `apps/gateway/index.ts`、`apps/inference/index.ts`、`apps/generation/index.ts` 进行独立 Wrangler dry-run。它们不包含路由、Service Binding、Cron、D1、KV、密钥和生产环境继承，不代替现有部署清单。`npm run check:apps` 纳入合并、部署前和本地构建验收。

私有转换预检客户端实现从 `src/inference/inference-preflight-client.ts` 迁入 `apps/gateway/transport/inference-preflight-client.ts`，Gateway 回退逻辑直接依赖自有模块；旧路径只负责兼容导出。转换行为、私有鉴权、超时、取消与失败关闭语义不变，中心实际转换仍由 Inference 执行。

本阶段确认**三套应用可作为独立打包入口**，不等于模块依赖已全部清除，尤其 `src/request/`、OAuth 与可观测性仍待进一步迁移。生产 `wrangler*.jsonc`、Cloudflare Secrets、Cron、路由、Service Binding 均不变，也不执行部署。

## Gateway 私有推理流解码归属

`apps/gateway/transport/inference-stream-client.ts` 是内部推理流帧解码器的唯一实现，`apps/gateway/attempt/success-matrix.ts` 的 Gateway 响应逻辑直接引用它。原 `src/inference/inference-stream-client.ts` 仅保留兼容导出。中央帧流 Mock 合同直接覆盖新的运行时代码，并由架构门禁阻止旧位置恢复独立实现。

生产配置及服务调用方式保持不变；私有流帧必须经共享合同 `unframeInferenceStream` 解码后才能进入 Gateway 的首事件保护与客户端流输出，物理 Provider 用量继续按现有结算边界处理。

## Gateway 公开请求策略与边缘缓存归属

`apps/gateway/policy/` 独占鉴权、路径检测、模型授权和路由可行性判断实现；`apps/gateway/cache/edge-cache.ts` 独占公开请求的边缘缓存实现。Gateway 的 `index.ts`、`preflight.ts`、`request-handler.ts`、`tier-loop.ts` 直接导入这些应用内部模块，缓存直接使用应用内鉴权函数，避免不经意引入第二份鉴权或缓存状态。

原 `src/request/{auth,router,model-authz,route-feasibility,edge-cache}.ts` 仅作 `export *` 兼容层。架构门禁检查单一代码所有权、入口直接依赖和无重复实现。现有客户端鉴权与模型授权、路由、缓存键隔离、流式缓存失败关闭合同均保持不变。

本次完成 Gateway 主请求路径一批实质源码迁移，**不意味着 `src/request/` 全部清空**：后续还有模型回退、错误处理、尝试/执行与观测模块；OAuth 管理路径归属也仍需收敛。生产 Wrangler、Secrets、配额、Service Binding、路由和部署均保持不变。

## Gateway 模型回退和 Tier 调度策略所有权

`apps/gateway/policy/model-fallback.ts` 负责模型家族、前缀隔离、Air 只上行、容量优先选择及有界重查规划；`apps/gateway/scheduling/tier-policy.ts` 负责 Tier 1→2→3 调度优先级、显式 Tier 尝试上限、请求级已用预算抵扣和未用预算的有界释放。Gateway 的 `preflight`、`request-handler`、`fallback`、`tier-loop` 直接调用这些应用自有策略，不跨服务引入第二个调度器。

原 `src/request/model-fallback.ts`、`src/request/tier-loop.ts` 只保留兼容导出。中央模块门禁要求现有预算/配额硬边界和唯一实现持续成立；所有接口和实际运行顺序不变。

本项仅完成模型家族回退和 Tier 选择策略的源码归属；`src/request/attempt/` 的响应结算和结果处理、错误响应、统计与 OAuth 兼容依赖还未全部迁移，不得报告整体架构已完成。生产部署、Secrets、Cron 与 Service Binding 均不变。

## Gateway 终止错误与响应处理源码归属

`apps/gateway/response/errors.ts` 统一负责客户端错误体（OpenAI Chat / Responses、Anthropic Messages）、错误码、拓扑保护与 `Retry-After` 等失败语义；`apps/gateway/response/response-helpers.ts` 统一负责 CORS、上游响应头过滤、流中断片段和映射后的模型名。原 `src/request/errors.ts` 与 `src/request/response-helpers.ts` 仅保留兼容导出，**不再拥有实际运行实现**。

`apps/gateway/` 的请求预检、请求处理、回退与 Tier 循环，以及仍在 `src/request/attempt/` 的推理、生成、流式结果处理逻辑，直接引用 Gateway-owned 响应实现。模块边界门禁锁定此依赖方向、唯一代码所有权、协议格式和上游拓扑隐私，避免迁移产生重复错误码路径。请求状态码、重试窗口、计费和密钥管理均保持原有语义。

此项是 Gateway 旧请求目录清理的一部分，**不代表 `src/request/attempt/` 执行归属迁移已经完成**；后续仍需继续收敛尝试处理与观测边界。无生产配置、部署或 Service Binding 更改。

## Gateway 尝试辅助模块源码归属

`apps/gateway/attempt/body-release.ts` 统一处理大请求流式提交后的正文释放；`apps/gateway/attempt/attempt-mode.ts` 统一决定上游缓冲模式；`apps/gateway/attempt/oversize.ts` 统一处理超限响应终止。旧 `src/request/attempt/{body-release,attempt-mode,oversize}.ts` 仅作兼容导出，热路径直接依赖 Gateway-owned 代码，并由架构门禁固定。

物理尝试用量及流统计现由 `apps/gateway/attempt/observability.ts` 唯一实现；`src/request/attempt/observability.ts` 仅兼容导出。中央测试包已按维护者明确授权升级，重复结算实现禁止。对冲、请求级选择器及 Inference/Generation 私有中心分发适配均已迁归 Gateway；旧入口仅保留兼容导出。无生产 Secret、Wrangler、Cron、D1、Service Binding、部署或发布改动。

## Gateway 成功响应处理实现归属

将原 `src/request/attempt/success-image.ts` 的完整运行实现迁至 `apps/gateway/attempt/success-image.ts`，旧路径仅作兼容导出；`apps/gateway/attempt/success.ts` 统一分发器直接调用新归属。图像生成的非幂等终态、取消、响应格式及记账行为保持原合同。

原生 `success-stream.ts` 的首事件提交、流生命周期与中断处理均已归属 `apps/gateway/attempt/success-stream.ts`，原目录仅兼容导出；中央测试包已锁定升级版并保留原行为断言。矩阵转换成功响应终结实现已迁入 `apps/gateway/attempt/success-matrix.ts`；原 `src/request/attempt/success-matrix.ts` 仅为兼容导出，`success.ts` 分发器直接引用 Gateway-owned 实现，所有原有私有帧流解码、物理用量结算、预算终止与错误响应断言改为检验真实新路径。经明确授权的中央测试包已改为检查真实 owner，并保留原行为断言。对象、物理尝试观测、终态结算、对冲、dispatch 与 Inference/Generation 分发适配均已迁归 Gateway；中心的物理 Provider 执行仍独立于 Gateway。无生产配置或部署改动。

## Gateway OAuth 管理路由归属

OAuth 订阅管理的 `/oauth/start`、`/oauth/callback`、`/oauth/paste` 等实际 HTTP 路由，从 `src/oauth/routes.ts` 移入 `apps/gateway/oauth/routes.ts`；公开 Gateway 的 `apps/gateway/preflight.ts` 直接调用新实现。旧 `src/oauth/routes.ts` 只保留兼容导出。Gateway 路由直接调用自有 `policy/auth.ts`，保持表单凭据授权、PKCE、状态一次性消费与管理入口可关闭等既有安全语义。

本批不迁移 `src/oauth/crypto.ts`、`token-store.ts`、`resolve.ts` 和 `provider-configs.ts`：令牌解密、D1 持久化和订阅刷新仍涉及私有推理中心与共享配置解析，必须按中心归属单独迁移。未变更加密密钥、访问控制、Token 存储结构、Cloudflare Secrets、Wrangler、D1 schema、Service Binding 或部署。

## Gateway Tier 1 调度归属

Tier 1 会话亲和 KV 缓存、短时熔断与 P2C 候选选择分别归属于 `apps/gateway/scheduling/tier1-affinity.ts` 和 `apps/gateway/scheduling/tier1-scheduler.ts`。旧 `src/scheduler/` 文件只保留兼容导出，避免两份缓存或调度状态。Gateway 请求入口、Tier 循环和对冲执行均直连真正 owner；评分实现 `src/scheduler/tier1-scoring.ts` 暂维持中央源码静态合同，后续单独迁移。

本批不改变 KV 时限、熔断阈值、上游选择或失败回退，不涉及生产部署。

## Gateway Tier 2/3 选择器归属

Tier 2/3 的协议及 surface 硬门禁、模型资格、即时可用性、候选评分、槽申请和竞争回避，由 `apps/gateway/scheduling/scheduler.ts` 单一实现。`src/scheduler/scheduler.ts` 只保留兼容导出，旧测试和旧模块调用获得相同函数身份；`apps/gateway/request-handler.ts` 与 `apps/gateway/attempt/hedge.ts` 直接调用新的 Gateway owner。

此次仅变更源码所有权，不改变 Tier 2/3 优先级、活跃请求排序、健康/TTFT 与 LRU 比较、冷却/熔断、模型/协议支持和 hedge 候选行为。节点可靠性状态暂仍复用 `src/reliability/node-state.ts`，后续逐步收口；不涉及中心私有执行、生产配置和部署。

## Gateway 跨隔离区 Tier 1 冷却共享归属

`apps/gateway/reliability/tier1-shared-cooldowns.ts` 持有 Tier 1 长期冷却的唯一 KV 同步实现，包括隔离区内已知记录、五分钟刷新、50ms 读取超时、单写者合并与完成后的脏数据续刷。`src/reliability/tier1-shared-cooldowns.ts` 仅作为原测试和调用方的兼容导出，Gateway 请求入口与失败终态直接调用真正 owner，避免生成第二份缓存、冷却状态或 KV 写入竞争。底层模型熔断/配额仍沿用 `src/reliability/tier1-state.ts` 的同一实现，此次未改变任何冷却判定。

同时修复 Tier 2/3 迁移 #308 的遗漏：`apps/gateway/scheduling/tier-policy.ts` 直接从本地 `scheduler.ts` 读取选点和候选数量，不再经旧 `src/scheduler/scheduler.ts` 转发。架构门禁验证唯一实现、旧路径无状态、KV 时间预算与实际调用方向；现有中央 Tier 1 容量/冷却测试仍通过原 re-export 检查同一对象。未修改 Action Worker 测试包、门禁、pin、Secrets、D1、Wrangler 或生产部署。

## 历史待迁移清单（已被后续变更取代）

以下条目仅记录当时计划，不是当前待办：

1. 将各应用内部执行源码从 `src/` 继续迁移至各自目录，随后独立构建并分离环境配置类型。
2. Gateway 物理推理统一走私有中心；继续移走非执行 OAuth 管理和 Provider 配置兼容依赖。
3. 由推理中心拥有双向协议转换、流处理和物理上游用量；Gateway 仅有界检查首事件。
4. 对已有多模态理解建立真实感知中心，不制造无功能服务；生成中心继续完善非幂等边界。
5. 独立运维与可观测处理；新增本地 HTTP Mock 合同测试；删除入口旧路径和例外。当前完成状态及未核验的生产事项见 Issue #310。

## 验收原则

每一个批次须通过 TypeScript、Biome、中心契约负面用例、中央 Action Worker 门禁；任何运行时兼容性变化须有与当前源码行为的对照测试。本阶段不修改生产 Secret，不改变路由或部署入口，不自动发布。
