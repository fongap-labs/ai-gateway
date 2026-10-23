# Changelog

## [Unreleased]

- 安全 [breaking, security]: 鉴权失败的请求由独立的失败尝试窗口节流（`AIG_AUTH_ATTEMPT_RPM`，默认每分钟 60 次，`0` 关闭）。超限返回 429，错误码为 `gateway_auth_throttled`，并带 `Retry-After`；鉴权成功的请求不消耗失败预算。访问密钥 RPM 上限 `AIG_ACCESS_KEY_RPM` 的默认值由 `0` 改为 `120`。迁移：此前未设置该变量的部署会开始受每分组每分钟 120 次的限制；需要更高吞吐的部署请显式设置更大的值，或设为 `0` 关闭。

- 安全 [breaking, security]: 公开仪表盘 `/` 与徽章 `/readme-status.svg` 默认关闭（`AIG_PUBLIC_DASHBOARD` 默认为 `false`，两者返回 404）。快速开始不再列出访问密钥分组名。迁移：需要公开仪表盘的部署须显式设置 `AIG_PUBLIC_DASHBOARD=true`。

- 安全 [security]: 边缘缓存在未配置 `AIG_TOKEN_ENCRYPTION_KEY` 时失败关闭：不查询也不写入缓存，凭据指纹不再用公开常量派生。

- 修复: 流式边缘缓存命中现在与上游流一样计入完成与取消，`activeRequests` 不再随每次命中单调增长。

- 安全 [security]: 没有可用 `Content-Length` 的请求体（例如 chunked 传输）按 `AIG_REQUEST_BODY_MAX_BYTES` 计入在途请求体预算，不再绕过 32 MiB 的预算。迁移注意：并发的无 `Content-Length` 请求超出预算时会返回可重试的 503；常规 JSON 客户端会发送 `Content-Length`，不受影响。

- 变更: D1 token 用量写入改为 isolate 内缓冲：按小时与模型合并，每 50 条或每 2 秒以一次 `d1.batch()` 提交。写入失败时增量回滚并在下次刷写时重试。读取与定时维护前会先刷写。isolate 被回收时尚未刷写的增量会丢失，口径仍为尽力而为。

- 变更: 大请求体读取改为收集分块后一次解码，减少峰值内存拷贝；超限仍返回 `BodyTooLargeError`。

- 安全 [security]: 修复 Worker 内存与缓存隔离问题。跨协议成功矩阵回退读取上游响应时不再无上限，最多读取 2 MiB；`/oauth/start` 与 `/oauth/paste` 的表单体限制为 64 KiB，未通过凭据校验的超大请求无法耗尽内存。边缘缓存的命中响应改为 `private, no-store`，与未命中一致，共享缓存不会把一个客户端的答案交给另一个。合成矩阵流补上 `x-request-id`。部署密钥同步此前忽略 `AIG_TOKEN_ENCRYPTION_KEY`，导致每次部署都丢弃它，订阅令牌因此无法解密，现已修复。

- 安全 [breaking, security, migration]: `/health` 与 `/metrics` 默认只允许 MAX 与 ULTRA 密钥读取，因为它们会暴露节点状态与部署版本。`AIG_DIAGNOSTICS_GROUPS` 可指定其他密钥组，设为 `*` 则恢复所有有效密钥的访问；部署预检在没有可读取 `/health` 的密钥时失败。迁移：所有密钥都不在 MAX 与 ULTRA 中的部署，须在下次部署前设置 `AIG_DIAGNOSTICS_GROUPS`。

- 安全 [security]: `/health` 只列出调用方访问密钥可用模型背后的节点，与 `/v1/models` 保持一致；汇总计数与诊断信息不变。

- 安全 [security]: 格式错误的凭据分片或密钥文档不再在 `/health` 与部署日志中泄露凭据字符，解析错误只报告为无效 JSON。

- 安全 [security]: 存储的订阅令牌以 AES-GCM 附加认证数据绑定节点、提供方与列。此前写入的行仍可解密，下次保存时重写为绑定格式。

- 安全 [security]: Wrangler 密钥包以 0600 权限写入，部署脚本以 `umask 077` 运行。

- 安全 [security]: 调度、抖动与对冲路径的随机数改用 CSPRNG `cryptoRng()`，移除 `Math.random()`，并修复 CodeQL 报告的 27 项告警（含随机数与正则 ReDoS）。曾经有偏的随机数转换改为与 `2^-32` 等价的乘法，分布不变。

- 安全 [security]: `test-pack.json` 固定到 40 位不可变提交 SHA，并在拉取前校验。此前可变的 `main` 引用可能让 action-worker 的任何改动在每台执行 `npm test` 的机器上运行任意代码。

- 安全 [security]: 密钥扫描新增 `GOCSPX-`、`gho_`/`ghu_`/`ghs_`、`github_pat_`、`npm_` 与 `xox` 系列令牌模式；Gemini CLI 公开 OAuth 常量按 SHA-256 摘要放行，其他同类值仍会被报告。

- 安全 [security]: `config-cli check` 不再输出 OAuth 节点数量，消除 CodeQL 报告的明文日志问题。

- 安全 [security]: 新增 `AIG_IS_SUBSCRIPTION_ENABLED`（默认 `true`）。设为 `false` 时不加载任何 Tier 2 `oauth` 节点，`/oauth/*` 返回 404。`SECURITY.md` 说明订阅适配器使用厂商的客户端身份，可能违反其服务条款。

- 安全 [breaking, security]: Tier 2 订阅接入（`/oauth/start`）只允许 `AIG_OAUTH_ADMIN_GROUPS` 变量列出的密钥组（如 ULTRA）使用。未设置时禁用接入，已绑定的订阅不受影响；接入新订阅前须先设置该变量。

- 安全 [security]: OAuth 回调与粘贴授权码以单条 `DELETE ... RETURNING` 认领流程状态，同一 state 的并发请求不再都能兑换授权码。

- 安全 [security]: 边缘缓存不再把一个调用方的答案回放给另一个调用方。流式与非流式请求分别存储，条目绑定到所呈现凭据的 keyed fingerprint；包含工具调用、被截断的流以及超过 2 MB 的响应不缓存；内容类型不匹配时不缓存。行为变更：`temperature: 0` 请求不再自动缓存，需发送 `x-gateway-cache: true` 或设置 `AIG_EDGE_CACHE_AUTO=true` 恢复。

- 安全 [security]: 仪表盘与 `/` 路由不再需要网关密钥，只展示公开的模型状态与聚合用量；`AIG_DASHBOARD_PUBLIC` 已退役，部署配置中应删除该变量。API 路由仍然强制网关密钥。

- 修复: 并发大请求体不再耗尽 isolate 内存。在途请求体按声明的 `Content-Length` 限制为每 isolate 32 MiB，超出时返回可重试的 503（`Retry-After: 1`）；超大 `Content-Length` 在读取前拒绝；单个最大尺寸的请求在没有其他在途请求时总是被接受。

- 修复: 配置错误不再使整个网关返回 500。错误的分片、冲突的节点（凭据、节点 ID 重复或位于其他层级）以及无效的 `AIG_MODELS_CONFIG`、`AIG_POLICIES_CONFIG`、`AIG_PROTOCOL_FALLBACKS`、`AIG_OAUTH_PROVIDERS` 只排除受影响的节点或回退到内置设置；`/health` 报告 `degraded` 并给出诊断；只有没有可用节点时才报告 `invalid`。

- 变更: 默认拒绝降级运行的配置。节点因缺少凭据、字段或 URL 无效而被排除时，`preflight`、`prepare` 与部署后的 `/health` 检查都会失败；只有确实需要降低容量时才设置 `AIG_ALLOW_DEGRADED=true`。`/health` 报告 `degraded`、`nodes_excluded` 与 `single_point_of_failure`，预检会对单一 Tier 1 节点、禁用的访问密钥 RPM 上限与无限制的 Tier 1 `max_in_flight` 发出警告。

- 修复: Tier 1 瞬时失败不再在仍有尝试次数时直接结束请求。整个计划用尽后，原生 Tier 1 的最近一次瞬时失败会在同一 key 上重试一次，且受 `max_attempts` 限制，并且只有剩余时间超过该次失败耗时时才重试。限流、认证失败与客户端错误从不在同一 key 上重试。

- 修复: 熔断的 Tier 1 模型可以在其 key 仍然繁忙时恢复。半开探测闸门此前统计了 key 上所有在途请求，导致该 key 的其他模型的稳定流量使熔断模型长期无法恢复；现在只统计该模型的在途请求，一次只允许一个探测，两次成功后关闭，规则不变。

- 修复: 单次 403 不再让 Tier 1 key 退出池子一小时。401 仍会按 `AIG_AUTH_FAILURE_COOLDOWN_MS` 冷却整个 key；Tier 1 的 403（策略、内容审核、地区或模型权限拒绝）只归咎于收到它的模型，首次不计冷却，只有反复出现时才按 `60s → 10m → AIG_AUTH_FAILURE_COOLDOWN_MS` 升级。成功会清除阶梯。Tier 2/3 仍使用凭据冷却。

- 修复: Tier 1 的 429 冷却按模型作用域进行，同一 key 的其他模型保持可路由；只有同一 key 上第二个模型在一分钟内也受限时才扩大到整个 key。默认阶梯上限从一小时降为 30 分钟（`AIG_RATE_LIMIT_STEPS_MS` 可调）。提供方给出的等待时间（`Retry-After` 或错误文本中的 "try again in"）在前两次失败时可信；文本提到额度、日限额或 credits 时，阶梯从 5 分钟开始；恢复的 key 会唤醒同一提供方的冷却中的兄弟 key。

- 修复: 429 冷却与限额恢复时间对齐。限额分为短窗口与长期额度两类，各自按真实恢复方式冷却。分类只看协议信号（文案或 `Retry-After` 时长），不看提供方名称；短窗口 429 使用 `AIG_RATE_LIMIT_WINDOW_STEPS_MS` 阶梯，最长 5 分钟；长期额度 429（小时或日套餐、`N-hour`、credits）从 5 分钟阶梯开始，首次出现即冷却整个 key，等待时间按提供方声明，最长 6 小时（`AIG_RATE_LIMIT_QUOTA_STEPS_MS`）。仅包含 "quota" 字样的每分钟限制不再冷却数分钟。调度日志与尝试记录新增 `rate_limit_class=`。

- 修复: 限额重置时间的解析修正：Go 风格的复合时长与绝对 epoch 重置头正确解析（10 位 epoch 此前被当作秒）；分钟窗口文案优先于弱耗尽提示；零额度尾部且无重置标记时不再永久拒绝准入；UTC 周边界不再在 UTC 以东的主机上偏移一天；日汇总不再重建已经过期的小时数据；汇总失败时跳过保留清理，避免源数据在汇总前被删除。

- 修复: 客户端对纯瞬时的网关失败会自动重试。预算耗尽的 504 与所有尝试都因瞬时原因失败的 502 不再带 `x-should-retry: false`；其他终止性失败保留该标记。

- 修复: 重新核对文档化的可靠性、路由、协议与配置契约，修正代码与文档之间的差距。半开契约改为两次连续成功探测恢复正常状态；同一模型反复 429 后才扩大到整个 key，且只有第二个不同模型受限或额度分类的 429 才会扩大；额度窗口按较差的一个尾部判定；`tier_attempts` 成为全请求的硬上限，由原生尝试、协议回退与模型家族轮次共享；Anthropic 的 `top_k` 采样控制在不支持的目标上以 `sampling_control` 报告为丢弃，不再被静默丢弃而仍标记为 `exact`；OAuth 刷新被拒绝时先重新读取已持久化的凭据，避免丢失刷新竞争的 isolate 把健康订阅标记为 `refresh_failed`。

- 修复: 修正全代码审计发现的配额预留、尝试计数与跨协议翻译的损失。中止的 Tier 1 请求会释放预留；已知的未来额度重置时刻在后续没有重置标记的报告中保留；结构损坏的 HTTP 200 保留短冷却；真实恢复会重置整个自适应 429 阶梯；每个物理上游尝试只结算一次；客户端中止跨协议请求时不再计为已交付；裸模型家族没有配置兄弟时保留策略规定的尝试预算；矩阵翻译中，封存的推理历史（`redacted_thinking`、`encrypted_content`）按协议原样传给 Anthropic，全部块被丢弃的回合不再发送空内容列表；Responses 路径上的内联 `data:` 图片转为 Anthropic 的 base64 源；Responses 流不再重复已由 `output_item.added` 携带的工具参数；同一工具调用的 id 与 index 分在两个片段时不再拆成两个调用。`AIG_OAUTH_PROVIDERS` 中被拒绝的条目会报告，而不是静默回退；`resets_in_seconds` 被解析为相对秒数。

- 修复: Claude Code 可以走协议回退。Claude Code 与自身函数工具并列的服务端工具（advisor、tool search、web search）被丢弃并报告为 `provider_native_tool_definition`，不再整体返回 502；仅由服务端工具组成的工具面、强制服务端工具、`mcp_servers` 与 `container` 仍会被拒绝。Claude Code 的 `betas` 数组被接受，并在跨协议目标上报告为丢弃诊断；`thinking.type:"adaptive"` 与 `thinking.display` 被接受；`service_tier`、`speed`、`inference_geo` 以 `request_hints` 诊断丢弃而非失败；`type:"custom"` 工具按普通函数工具处理（此前被静默删除）；图片块的 `cache_control` 被忽略。`is_error` 与 `context_management` 不再导致跨协议回退返回 502。

- 修复: 客户端写入的模型名与配置目录不一致时仍能解析。Claude Code 附加的上下文长度标签（`Code-Ultra[1m]`）会被去除，大小写与配置不同的写法（如 `Code-Max` 与 `code-max`）解析到同一目录项，节点的模型键重写为规范拼写；允许列表与可调用集合使用相同的大小写不敏感匹配，修复此前的 404。未知模型保持原始拼写，404 与 403 的失败关闭契约不变。

- 修复: 模型家族回退从最终能力层级推导，`Audit-Ultra` 这类前缀模型可以回退到 `Audit-Max` 与 `Audit-Pro`，且不跨家族；内置请求策略从前缀模型的层级后缀推断；Air 保持有界的四模型轮转，推理模型使用完整的六次尝试计划（60 秒阶段超时，180 秒请求预算）。

- 修复: 大提示与非流式请求的 504 已修复。超过 header 超时的非流式补全不再在每个节点上逐个失败；请求预算与首事件等待随提示大小增长；默认对冲延迟不再把几乎所有大请求复制到第二个 key，显式设置的 `AIG_HEDGE_DELAY_MS` 或 `hedge.delay_ms` 按原值使用。

- 修复: 节点本地的 HTTP 400 拒绝后，请求会轮换到其他上游，不再直接结束整个请求。

- 修复: 在 Chat 与 Responses 之间转换时，流式文本与推理内容被完整保留，Chat 流在 `finish_reason` 之后关闭即视为完成；非流式组装前记录尾部用量；矩阵组装为空或中止时释放并发与额度计数；`total_tokens` 由 prompt 加 completion 得出，不再依赖缺失的 `input_tokens`。

- 修复: 为 Anthropic 客户端翻译的 Chat 与 Responses 上游流不再丢失或误报工具调用。Responses 的工具参数若只在 `.done` 事件或 `output_item.added` 中出现会被保留且不重复；`incomplete` 的 Responses 流以 `max_tokens` 结束；携带工具调用的 Chat 回复以 `tool_use` 结束；无 `index` 的 Chat 工具片段接续所属调用。

- 修复: 协议转换的若干输入问题。`null` 形式的 `tool_choice` 与 `reasoning_effort` 被接受，`response_format` 的标准字段被允许，图片与 data URI 处理改善，redacted thinking 数据保留，`system` 不再重复，顶层 `system` 与 `developer` 被读取，Responses 支持自定义工具与 `local_shell`，`tool_result.is_error` 产生诊断。

- 修复: Messages 与 Chat/Responses 之间的翻译支持内联 base64 文档（PDF），映射为 Chat 的 `file` 部件或 Responses 的 `input_file`；URL 与内容块形式的文档来源仍然失败关闭。工具结果中的 `tool_reference` 转为可读的文本占位并附带 `emulated` 诊断；内容块上的 `citations` 与 `cache_control` 一样被忽略。无参数的工具调用在关闭前输出一个空的 `input_json_delta`。

- 修复: 路由去除重复的 `/v1/v1` 前缀，使 `ANTHROPIC_BASE_URL` 设为 `https://host/v1` 时仍能匹配 `/v1/messages`；请求路径先规范化（合并斜杠、去除查询与末尾斜杠、转为小写）。

- 修复: 页脚的文档链接指向了不存在的 ref。现在显示部署 ID（`AIG_BUILD_SHA` 前 7 位大写），并链接到构建所用的提交；没有提交 SHA 时回退为构建时间戳，链接指向 `main` 分支的文档。

- 修复: OAuth 密钥页与授权码粘贴页的内容安全策略曾使用 `form-action 'none'`，导致表单无法提交；这些页面改为 `form-action 'self'`，其他 HTML 页面保持 `'none'`。`POST /oauth/start` 返回刷新页而不是被浏览器拦截的 302。

- 修复: 仪表盘头部 logo 与标题的垂直对齐修正；仪表盘链接更新为 labs.fongap.com；仪表盘快速开始的访问组与公开端点来自运行时配置。

- 修复: `CLOUDFLARE_ACCOUNT_ID` 保留在 `.github/deploy.secrets.allowed` 中。控制面部署策略把该名称别名到 `CLOUDFLARE_ACCOUNT_ID_SECONDARY`，删除声明会静默丢弃别名并使生产部署预检失败；部署配置检查现在要求保留该声明。

- 修复: 运行时读取的 `AIG_CORS_ORIGIN` 与 `AIG_LOG_LEVEL` 与文档保持一致；Gemini CLI 的 User-Agent 升级到 v0.60.0，使 Code Assist 上游接受当前版本。

- 修复: Cloudflare 自定义域名使用有效的 host-only 路由模式。

- 修复: 边缘缓存的键使用请求的规范化 JSON 与调用方访问密钥组，值类型或字符串内分隔符不同的请求不再共享条目，条目也不在密钥组之间共享。部署后已有条目会未命中一次。

- 修复: 过期的 OAuth 流程状态在 `waitUntil` 中清理，不再使用可能被运行时取消的 fire-and-forget 承诺。

- 变更: 删除未使用的重复仪表盘脚本，并去掉 `key-rpm.ts` 头部重复的设计说明。

- 修复: 从 `registry.npmjs.org` 解析所有 npm 包，不再使用第三方镜像（完整性哈希不变）。

- 修复: 中央 CI 直接以固定参数运行 `biome check .` 与 `tsc --noEmit`，在 `npm run validate:merge` 之前执行，使 PR 无法通过修改 package 脚本削弱检查。

- 变更: 生产部署与 PR CI 迁至 Action Worker，删除仓库内的部署凭据、编排与门禁逻辑；main 与定时验证在部署集中化之前保留在仓库内。

- 变更: CI 改用通知桥接，main 推送后立即唤醒中央 Intake；加入薄 PR 分发器，PR 事件约一分钟内进入中央治理；PR 关闭时取消中央工作；删除旧的合并门禁与一次性引导流程。

- 变更: 测试与检查：产品测试套件改由 Action Worker 测试包运行（`tests/packs/ai-gateway`），PR 无法削弱自己的测试；`docs-check` 只允许一份 `README.md`，`link-check` 跳过 `.cache/`；Biome 取代旧的 linter 与格式化工具，并接入 `validate:merge` 与 `validate:deploy`；`CONTRIBUTING.md` 说明 Conventional Commits、CHANGELOG 规则与发布流程；提供仅用于手动检查的 commitlint 配置。

- 变更: CODEOWNERS 覆盖整个仓库、workflow 与脚本；`.github/security-scan.json` 让 CodeQL 扫描 TypeScript 源码。

- 变更 [breaking, migration]: 网关访问、部署、节点分片、凭据分片、绑定、超时、冷却与布尔配置名称一次性切换；Action Worker 派发目标从 `GITHUB_REPOSITORY_OWNER` 推导；部署默认启用，仓库身份从 GitHub 上下文推导。

- 变更: 内部重构：模型目录事实（能力、推理强度、模态）与运行策略（故障转移策略、可见性、界面分组）分离；提供方适配器注册表成为协议、订阅与 OAuth 的唯一权威，未知提供方回退到通用 OpenAI 兼容适配器；路由策略统一分派（Tier 1 使用 `p2c_ttft`，Tier 2/3 使用 `priority_lru`）；运行状态读取统一为 `RuntimeStateStore` 契约。行为不变。

- 变更: 减少大请求的内存与 CPU 占用。超大 `Content-Length` 在读取前拒绝；边缘缓存跳过 256 KiB 以上的请求体，缓存写入上限 2 MiB；超过 1 MiB 的请求不做对冲；原生请求体复用原始 JSON 文本；首个出站请求构建后释放原始大请求体；Anthropic token 估算不再对每个字符运行正则。`AIG_REQUEST_BODY_MAX_BYTES` 默认 20 MiB，上限提升到 32 MiB。

- 变更: 停止向额度耗尽的 key 发送无效探测。额度文案优先于窗口文案，窗口类 429 在阶梯到达第三阶段后自动升级到账户额度阶梯；同一模型连续三次 429 会把 Tier 1 作用域扩大到整个 key；Tier 1 探测闸门从 5 秒延长到 15 秒；key 仍在证明恢复时不允许并发请求进入。

- 变更: 订阅额度窗口提示由适配器解释：codex 与 claude 适配器把重置标记（窗口重置 epoch 头、`resets_in_seconds`、Anthropic 的 ratelimit 重置头）解释为冷却提示，只能延长 429 冷却，上限 6 小时；API key 节点从不使用订阅提示。

- 新增: Tier 2 订阅适配器（`src/subscription`）：`auth:"oauth"` 仅用于 Tier 2 节点，支持 PKCE 接入、AES-GCM 令牌存储、派发时刷新、内置提供方默认值，部署配置失败即关闭。Codex 请求带 `Originator`、`chatgpt-account-id` 与规范化的 `instructions`；Claude 订阅派发合并所需的 beta 标志，并发送 `x-app` 与 `claude-cli` User-Agent；刷新采用 isolate 内单飞与跨 isolate 的 `refresh_version` 比较交换，保证只有一个权威刷新令牌；派发前要求提供方具备已验证的订阅后端。

- 新增: Google Gemini 订阅支持：通过 Cloud Code Assist 派发，新增 `google-wire.ts` 在 Chat 与 Code Assist 信封之间转换消息、系统指令、工具调用与生成配置，`reasoning_effort` 映射为 `thinkingBudget`，思考内容返回为 `reasoning_content`，并计入 `reasoning_tokens`。Claude、ChatGPT、Gemini 三个主流订阅提供方端到端可用。

- 新增: 订阅模型发现：codex 与 claude 适配器在接入完成时尽力探测上游模型，并把结果写入 `discovered_models`（迁移 0013）作为运维诊断；节点配置中的静态 `models` 映射仍是路由的权威。

- 新增: Tier 2 订阅节点成为部署向导的一等目标，默认使用 OAuth 订阅模式，提供方预设为 anthropic、openai、google；订阅节点不再要求 `base_url`，可回退到提供方内置的订阅端点。

- 新增: 协议矩阵：新增 `src/conversion/matrix/`，把 Chat、Messages、Responses 三种协议统一表示为 IR（请求、响应、流错误），每种协议各自负责解析、构建、SSE 编解码与保真度诊断。回退链涉及 Responses 的配对改走矩阵，三种协议之间的全部方向配对都由矩阵完成；Chat 与 Messages 之间仍保留直连桥接。推理内容、推理强度（`low`/`medium`/`high`/`max` 映射到思考预算）与 TTFT、用量与对冲截止时间的行为与原生配对一致。

- 新增: 对冲的强制中止。对冲节点产生第一个真实输出（流式）或完整响应（非流式）时，落后节点的上游请求立即以 "Hedge lost" 中止，并归类为 `cancelled_after_peer_commit`，不影响节点健康评分。

- 新增: DeepSeek-R1 与 Claude 扩展思考互通：DeepSeek 的 `reasoning_content` 与 Anthropic 的 thinking 块双向转换；首事件保护在推理增量到达时即提交，避免长思考阶段误判超时。

- 新增: Tier 1 配额租约：提供方报告的配额窗口（OpenAI 与 Anthropic 的限额头、订阅窗口重置提示）进入 isolate 本地状态。接近上限的尾部在 429 到来前降低评分；耗尽的窗口通过预留计数器拦截准入；结算时扣减实际用量。未知配额保持直通，不伪造硬限制。

- 新增: Tier 1 长冷却跨 isolate 共享：凭据被拒（401）、长期额度耗尽或模型升级为至少 5 分钟的 403 冷却时，写入 `TIER1_AFFINITY` KV 命名空间（`tier1-cooldowns:v1`）；新 isolate 启动时读取，之后每 5 分钟至多读取一次。短窗口限流仍只在 isolate 内生效，共享为尽力而为。

- 新增: Tier 1 会话亲和：Claude Code 不发送 `x-session-id`，网关改用 `x-claude-code-session-id` 识别会话，同一会话的连续回合倾向于同一 Tier 1 key，提高上游提示缓存命中率；只有至少两个 Tier 1 key 可用时才启用。会话亲和的 KV 读取最多等待约 50 毫秒，超时则不绑定且不改写已存绑定；读取失败时保留未知绑定，不写入新绑定，避免耗尽 Workers Free 的 KV 写入额度。

- 新增: 可选的跨 isolate 尝试分析。设置 `AIG_ANALYTICS_DATASET` 后，部署绑定 Workers Analytics Engine 数据集 `GATEWAY_EVENTS`，每次真实上游调用写入一条数据点（密钥、提供方、层级、模型、结果、角色、路由、状态与耗时）。未设置时没有任何变化；写入失败不影响请求。

- 新增: 边缘幂等缓存：对 `temperature=0` 或带 `x-gateway-cache: true` 的推理请求，Cloudflare Cache API 命中时直接返回缓存（`x-gateway-cache-status: HIT`），未命中时标记 `MISS`。缓存键为规范化路由、模型与请求体的 SHA-256，TTL 由 `AIG_EDGE_CACHE_TTL_SEC` 控制（默认 4 小时，设为 0 关闭）。

- 新增: 浏览器友好的 OAuth 接入：`/oauth/start` 渲染粘贴页，网关访问密钥经 POST 体提交，不出现在 URL 中，因此不进入访问日志、浏览历史或 Referer；携带 `Authorization: Bearer <key>` 的请求跳过该页。安装脚本自动生成 `AIG_TOKEN_ENCRYPTION_KEY` 并收集 `AIG_PUBLIC_URL`，新部署可直接接入订阅而无需手动生成密钥；配置文档新增 Tier 2 示例。

- 新增: 仪表盘页脚显示博客链接，位于 Fongap Labs 与 GitHub 之间。
