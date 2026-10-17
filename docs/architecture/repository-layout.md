# 仓库布局

仓库中，每一类工作都有唯一的持久所有者：Worker 运行时、测试、工具、配置示例、迁移与文档。物理布局应当让这种归属一目了然。

```text
src/                         Cloudflare Worker 运行时
├── config/                  环境解析、节点、Model Registry、策略
├── providers/               单一 provider 适配器注册表：线协议契约、
│                            stream-usage 特例、OAuth 接入默认值，
│                            以及各 provider 的订阅可 dispatch 性
├── scheduler/               Tier 1 P2C/亲和，以及 Tier 2/3 候选选择
├── reliability/             失败分类、冷却、额度/热度/状态
├── transport/               上游路径、头部、原生 transport 行为
├── protocol/                客户端校验、CORS、协议特定的请求/错误行为
├── conversion/              仅负责 Chat Completions ↔ Anthropic Messages 转换
├── stream/                  首事件守卫、SSE 解析、流生命周期
├── request/                 请求编排、tier 循环、回退、attempt 边界
│   └── attempt/             dispatch、hedge、成功处理、结果、attempt 可观测性
├── oauth/                   Tier 2 订阅的 OAuth 接入/凭据解析
├── subscription/            订阅请求语义适配器（anthropic/openai/google），
│                            包括 google Code Assist 线协议转换器（google-wire.ts），
│                            通过 provider 适配器组合并绑定到节点
├── observability/           日志、指标、D1/token 用量、安全诊断
├── runtime/                 运行时可用性与只读的公共模型状态
└── dashboard/               公共/运营者展示层

tests/                       （不存在）测试套件位于 action-worker：tests/packs/ai-gateway/

scripts/                     仓库/运营者/CI 工具
├── README.md                受支持的工具入口与边界
├── cloudflare-wrangler.mjs  唯一的 Wrangler 版本锁定 + 直接的 CLI/部署行为
├── install.*                首次本地引导
├── reconfigure.*            已有运营者配置的更新
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

- 首次本地引导：`scripts/install.sh` / `scripts/install.ps1`。
- 已有的本地/运营者重新配置：`scripts/reconfigure.sh` / `scripts/reconfigure.ps1`。
- 直接的本地代码部署：`npm run deploy`。
- Wrangler 登录、身份、tail、开发与部署调用均通过 `scripts/cloudflare-wrangler.mjs` 路由。
- `scripts/cloudflare-wrangler.mjs` 是仓库中唯一的 Wrangler 版本锁定所有者。
- 诸如 `setup-and-deploy.*`、`update.*` 以及重复的 `deploy.*` 包装器等兼容别名不是独立职责，不应被重新引入。
- `wrangler.jsonc` 是受版本控制的基线；运营者特定的配置应放在被 git 忽略的 `wrangler.user.jsonc` 中。

生产部署仍由 GitHub Actions 负责，而非任何本地脚本。

## 运行时边界

- `config` 从外部环境数据中构建受信任的内部配置。
- `src/providers/registry.ts` 是 provider → 协议/surface 映射、stream-usage 特例、内置 OAuth 接入默认值以及订阅可 dispatch 性的唯一所有者；账号级节点 JSON 不携带这些字段。
- `scheduler` 选择可用节点；它不直接调用 provider。
- `reliability` 记录可用性/失败状态；它不负责协议转换。
- `request` 编排各领域模块；它不应重复实现其逻辑。
- `transport` 在节点被选定之后，负责上游 HTTP 语义。
- `conversion` 仅负责明确的 Chat ↔ Messages 桥接。
- 除非该契约被明确重新设计，否则 `observability` 与公共运行时投影不会把历史/D1 证据反馈到路由中。

## Tier 1 归属

- `src/scheduler/tier1-scheduler.ts`：Eligibility → Affinity → P2C 选择与槽位 claim。
- `src/scheduler/tier1-affinity.ts`：哈希后的会话绑定、缓存与逃逸决策。
- `src/reliability/tier1-state.ts`：isolate 本地的 in-flight、被动 TTFT、冷却、半开与自适应限流状态。
- `src/reliability/tier1-heat.ts`：有界的 provider-model 热度与 hedge/剩余容量保护。

Tier 1 的访问密钥分组仅用于授权，不拥有调度优先级路径。Tier 2/3 保留其独立的调度器/可靠性路径。

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
