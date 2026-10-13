# 文档策略

## 语言政策

本仓库的文档语言按用途划分：

- **人类文档使用中文。** 包括 `README.md`、`SECURITY.md`、`CONTRIBUTING.md`、`docs/**`、`migrations/README.md`、`scripts/README.md`、`.github/pull_request_template.md`，以及 Issue/Discussion 模板中面向用户的标签、说明与占位文字。
- **机器可读文档使用英文，不得新增中文。** 包括 `AGENTS.md`、`CLAUDE.md`、契约、策略与规则文件、配置示例与 JSON schema。
- **`CHANGELOG.md` 是工程记录，使用英文。**
- **每份人类文档只保留一个中文版本。** 不得使用 `*.zh-CN.md`、`README_ZH.md`、`docs/i18n/` 或其他镜像文件；仓库中只有一个 `README.md`。
- **不得编写语言切换说明或语言切换链接。**
- **第三方、上游与供应商文件豁免。** 例如 `LICENSE*`、`NOTICE`、`THIRD_PARTY*` 与供应商 README 等，保持原样，不做翻译。

文件与目录名称保持英文：`docs/` 下的文件使用小写英文 `kebab-case.md` 命名，约定的 `README.md` 除外。

## 事实来源模型

文档用于解释可执行行为，本身并不定义行为。

当证据之间发生冲突时，按以下顺序判断：

1. 运行时代码、配置解析器/schema、测试与 GitHub 工作流决定当前的可执行行为；
2. 规范的现行文档对该行为进行总结，并且在其发生偏离时必须修正；
3. Git 历史、Pull Request、Issue、commit 以及人工创建的 tag/Release 保存历史上下文。

[product-policy.md](product-policy.md) 是产品范围、Tier 角色、干净替换、简洁性以及人工持有的发布标识的治理权威。

不要把临时的实施计划写入长期的策略文档。不要仅为保留历史而把已完成的迁移计划留在 `docs/governance/` 中。

## 文档归属

| 变更领域 | 规范文档 |
| --- | --- |
| 产品范围、Tier 角色、干净替换、发布标识 | `docs/governance/product-policy.md` |
| `src/config/*` | `docs/operations/configuration.md` |
| `src/scheduler/*` | `docs/architecture/routing-model.md` |
| `src/reliability/*` | `docs/architecture/reliability-model.md` |
| `src/transport/*`、`src/protocol/*`、`src/conversion/*` | `docs/architecture/protocol-model.md` |
| `src/stream/*` | `docs/architecture/protocol-model.md`、`docs/architecture/reliability-model.md` |
| `src/runtime/*` 的公共投影 | `docs/operations/public-model-status.md` |
| Provider Discovery 行为 | `docs/operations/provider-discovery.md` |
| 部署工作流 / Wrangler 绑定 | `docs/operations/deployment.md` |
| 受支持的本地工具入口 | `scripts/README.md` |
| 测试布局与执行方式 | `action-worker:tests/packs/ai-gateway/`（测试包由 Action Worker 仓库拥有） |
| 仓库设置 / About 元数据 | `docs/operations/github-repository-settings.md` |
| 顶层模块布局 | `docs/architecture/repository-layout.md` |
| CI 与质量门禁 | `docs/governance/quality-policy.md` |
| 依赖/工具链策略 | `docs/governance/dependency-policy.md` |
| 面向公众的首页摘要 | `README.md` |

行为变更的 PR 必须在同一 PR 中更新其所属的规范文档。仅涉及文档的 PR 可以在不改变运行时行为的前提下修正偏差。

## 现行契约与历史

架构与运营文档描述的是**当前契约**。不要为长期文档创建带编号的项目发布副本，也不要创建 `latest`、`final` 或 `new` 等变体。

项目发布编号不存储在文档中。若运营者需要一个命名的发布，应由人工创建 Git tag 或 GitHub Release。当前文档保持不带编号，且只描述当前契约。

不要仅因为某个已退役的实现曾使用过旧的运行时/配置契约，就让该契约继续存在。历史属于 Git，而不应以兼容分支的形式留在当前代码中。

## 避免重复事实

高漂移的数值应尽可能只有一个可执行的所有者。

- Node 版本要求：`package.json.engines.node`。
- 运行时变量名称与默认值：`src/config/runtime-vars.ts`。
- 错误类别词汇表：`src/reliability/classify.ts`。
- 套件发现：`action-worker:tests/run-pack.mjs`（套件从磁盘自动发现；`pack.json` 中只列出 gate 层级）。
- Wrangler 版本锁定：`scripts/cloudflare-wrangler.mjs`。
- 部署标识：由 CI 选定的 Git commit SHA，通过 `/health.build` 暴露。

项目发布编号有意**不设可执行的所有者**。它由人工在源码契约之外按需创建。

## README 策略

`README.md` 应按以下顺序回答问题：

1. 网关是什么，以及它刻意只面向家庭、个人或小型团队使用；
2. 它当前支持哪些协议与可靠性行为；
3. 如何启动与配置它；
4. 在哪里可以找到架构、运营、治理与安全相关的文档。

README 可以概述长期的 Tier 角色，但相关规则以[产品策略](product-policy.md)为准。

本仓库只保留一个 `README.md`，不存在其他语言的 README 版本。

## 文档检查

仓库通过以下方式校验文档：

- `scripts/docs-check.mjs`：目录、命名与内部链接规则；
- `scripts/link-check.mjs`：Markdown 链接完整性；
- `action-worker:tests/packs/ai-gateway/governance-contract-test.mjs`：对已知架构与配置漂移的可执行守护（其中的 docs-contract 部分）；
- `action-worker:tests/packs/ai-gateway/governance-contract-test.mjs`：对永久产品范围、Tier 角色、干净替换、人工持有的发布标识以及简洁性规则的可执行守护（其中的 product-policy 部分）。

文档检查通过并不能证明每一句话都是最新的。评审者仍须将变更的表述与其可执行来源进行比对。

## 删除策略

当某份长期文档所承担的职责已不复存在，或已被其他文档吸收时，应将其删除。历史存档由 Git 承担，不要为保留历史叙述而留下过时文档。
