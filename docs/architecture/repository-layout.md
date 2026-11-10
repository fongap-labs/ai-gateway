# 仓库布局

仓库中，每一类工作都有唯一的持久所有者：Worker 运行时、测试、工具、配置示例、迁移与文档。物理布局应当让这种归属一目了然。

```text
src/                         Gateway 领域工具与迁移期兼容入口（中立契约在 packages/）
├── config/                  环境解析、节点、Model Registry、策略
├── providers/               provider → 协议/surface 映射与 stream-usage 特例
├── scheduler/               Tier 1 免费池 P2C/亲和，以及 Tier 2 Token 健康/优先级选择
├── reliability/             失败分类、冷却、额度/热度/状态
├── transport/               packages/transport 的兼容导出；执行属于私有 Inference
├── perception/              私有 Perception 执行入口的稳定转发
├── protocol/                客户端校验、CORS、协议特定的请求/错误行为
├── conversion/              Chat / Responses / Messages 兼容导出；实现位于 apps/inference 与 packages/conversion-core
├── stream/                  首事件守卫、SSE 解析、流生命周期
├── request/                 兼容导出；实际编排、tier 回退与 attempt 属于 apps/gateway
│   └── attempt/             dispatch、hedge、成功处理、结果、attempt 可观测性
├── observability/           日志、指标、D1/token 用量、安全诊断
├── runtime/                 运行时可用性与只读的公共模型状态
└── dashboard/               公共/运营者展示层

apps/                        Gateway 控制面、Inference/Perception 推理执行与 Generation 图片生成的独立入口
packages/                    中立的合同、转换 IR、SSE 传输及用量存储原语
operations/                  D1 用量维护与独立 Cron 运行入口（发布状态另核验）

tests/                       （不存在）受控测试套件位于 action-worker：tests/packs/ai-gateway/

scripts/                     仓库/运营者/CI 工具
├── README.md                受支持的工具入口与边界
├── cloudflare-wrangler.mjs  唯一的 Wrangler 版本锁定 + 直接的 CLI/部署行为
├── config-cli.mjs           配置检查/差异 CLI
├── node-config-shards.mjs   节点配置规划/分片
├── plan-node-configuration.mjs
├── github-deployment-config.mjs
├── *-check.*                校验/运营者检查
└── provider-discovery/      只读的 provider 目录/差异/报告实现

config/                      公共配置示例
migrations/                  有序的 D1 迁移
docs/                        长期有效的当前文档
├── architecture/            持久的系统边界与不变式
├── operations/              当前的配置/部署/运营者操作流程
└── governance/              变更与校验系统所遵循的规则

.github/
├── workflows/               CI 与 PR 治理分发（ci.yml、notify-action-worker.yml）
├── ISSUE_TEMPLATE/
├── pull_request_template.md
└── dependabot.yml
```

## 归属规则

`src/` 只包含属于 Worker 产品/运行时的代码。仅供测试使用的辅助代码与可执行契约，应归入中央测试包（`action-worker:tests/packs/ai-gateway/`），绝不能放在本仓库中。仓库、部署、安装、配置、发现与校验工具，应归入 `scripts/`。

当文件的主要目的是验证行为，且失败本身即是有意义的测试证据时，它是一个**测试**。当运营者、CI 或维护者为执行一项独立的仓库操作而调用某个文件时，它是一个**脚本/工具**。测试可以调用 `scripts/` 中的工具，但工具本身不会移入测试包。

`migrations/` 保持独立，因为迁移的顺序与不可变性属于部署契约，而非测试夹具。

仓库治理由 GitHub 规则/工作流与可执行校验共同执行。开发者可以在本地使用 Git hooks，但 `.githooks/` 不是仓库所有的契约，因为机器相关的 hook 行为不可移植，并且可能在 CI 评审之外改写提交。

## 工具入口归属

- 直接的本地代码部署：`npm run deploy`。
- Wrangler 登录、身份、tail、开发与部署调用均通过 `scripts/cloudflare-wrangler.mjs` 路由。
- `scripts/cloudflare-wrangler.mjs` 是仓库中唯一的 Wrangler 版本锁定所有者。
- 诸如 `setup-and-deploy.*`、`install.*`、`reconfigure.*`、`update.*` 以及重复的 `deploy.*` 包装器等兼容别名不是独立职责，不应被重新引入。
- `wrangler.jsonc` 是受版本控制的基线；运营者特定的配置应放在被 git 忽略的 `wrangler.user.jsonc` 中。

生产部署仍由 GitHub Actions 负责，而非任何本地脚本。

## 运行时边界

- `config` 从外部环境数据中构建受信任的内部配置。
- `src/providers/registry.ts` 只维护 provider → 协议/surface 映射及 stream-usage 特例；不包含会员 OAuth 授权、订阅刷新或订阅能力判断。账号级节点 JSON 不携带协议/surface 字段。
- `scheduler` 选择可用节点；它不直接调用 provider。
- `reliability` 记录可用性/失败状态；它不负责协议转换。
- `request` 编排各领域模块；它不应重复实现其逻辑。
- 物理上游 HTTP 语义由私有 Inference/Perception/Generation 执行；Perception 仅接收明确支持的图像请求，`packages/transport` 提供不依赖具体 Worker 的原生协议及流原语。
- Inference Center 负责 Chat、Responses、Messages 之间经明确验证的协议转换，`packages/conversion-core` 持有中立 IR 和预算/保真原语。
- 除非该契约被明确重新设计，否则 `observability` 与公共运行时投影不会把历史/D1 证据反馈到路由中。

## Tier 1 归属

- `src/scheduler/tier1-scheduler.ts`：Eligibility → Affinity → P2C 选择与槽位 claim。
- `src/scheduler/tier1-affinity.ts`：哈希后的会话绑定、缓存与逃逸决策。
- `src/reliability/tier1-state.ts`：isolate 本地的 in-flight、被动 TTFT、冷却、半开与自适应限流状态。
- `src/reliability/tier1-heat.ts`：有界的 provider-model 热度与 hedge/剩余容量保护。

Tier 1 的访问密钥分组仅用于授权，不拥有调度优先级路径。Tier 2 静态 API Token 池保留独立的健康/优先级候选选择与可靠性状态，不接入会员订阅 Token。

## 兼容入口与退役顺序

`src/request/`、`src/conversion/`、`src/inference/`、`src/generation/` 中的纯转发文件不代表第二套执行实现。真正的运行时所有者分别位于 `apps/` 和 `packages/`；兼容导出仍可能被中央 Action Worker 测试包或外部工具引用。删除前必须核查源码导入、中央测试与构建入口，并以精确提交 SHA 通过完整 CI，不能仅凭文件薄或本仓库内没有调用就删除。

`src/index.ts` 是当前已部署 Gateway 的最小组合入口，只转发 Gateway `fetch` 与 Operations `scheduled`。在受控 Cron 转移完成并验证新 Operations 独立运行之前，不得删除 `scheduled` 或提前改用 Gateway-only 入口；源码边界检查强制其保持纯转发，生产切换后的退役另走独立验证。

## 转换归属

`src/conversion/result.ts` 在直接转换器与规范化 IR 矩阵之外，补充保真度、诊断以及结构化输出策略。`src/conversion/matrix/` 以内部 IR 为支点覆盖 Chat / Responses / Messages 的两两互转。

## Dashboard / 可观测性归属

- `src/observability/token-usage-store/` 负责持久化的物理上游 Token 用量、已交付请求证据、TTFT 聚合以及查询契约。
- `src/runtime/model-status.ts` 负责五状态的公共逻辑模型投影。
- `src/dashboard/model-status-view.ts` 负责 P50/P95/样本数以及仅供仪表盘使用的模型过滤。
- `src/dashboard/usage-view.ts` 负责物理 Token 总量、成功的公共请求数以及模型用量细分的展示。

这些模块都是运行证据的只读消费者。它们不会仅因为仪表盘展示了这些数据，就成为路由的输入。

## 文件规则

- 可执行测试与仅供测试使用的辅助代码位于中央测试包中，而非本仓库（没有 `tests/` 目录）。
- `scripts/` 中不得积累 `*-test.mjs` 文件。
- `.githooks/` 不纳入提交；本地 hook 仅属于开发者本地的、建议性质的设置。
- `docs/**/*.md` 使用小写的 `kebab-case.md` 命名，约定的 `README.md` 除外。
- `.dev.vars`、`.env*`、`secrets*.json` 与 `wrangler.user.jsonc` 仅保留在本地，并被 git 忽略。
- 新增顶层目录需要一项持久的职责，且该职责不得与现有所有者重叠。
- 不得为现有职责创建 `new`、`final`、`latest` 或带版本后缀的副本。
