# 贡献指南

ai-gateway 倾向于聚焦、有证据支撑的小步变更，而非大范围重写。运行时行为、协议兼容性、路由、可靠性与部署语义，都被视为明确的契约。

## Issue 与 Discussions

Issue 仅用于已确认、可复现、并且能够被跟踪直至解决的网关缺陷。公开的 Issue 请使用「缺陷报告（Bug report）」表单。

部署、配置、provider 接入、使用方式与故障排查类问题，请在 Discussions / Q&A 中提出。功能、协议、路由、可靠性与产品改进类提案，请在 Discussions / Ideas 中提出。提案被确定要实施之后，可以转为 Issue 以跟踪执行。

切勿公开披露安全漏洞。请使用 [SECURITY.md](SECURITY.md) 中描述的私密报告流程。

## 开发环境

```bash
git clone https://github.com/fongap-labs/ai-gateway.git
cd ai-gateway
npm ci
npm run validate:merge
npm run check:deploy
```

请使用 Node.js **>=22.18.0**。

## Pull Request

1. 使用 `feat/`、`fix/`、`refactor/`、`docs/`、`test/`、`ci/` 或 `chore/` 前缀创建聚焦的分支。
2. 每个 PR 只有一个主要目标。
3. 对行为变更，新增或更新回归覆盖。
4. 当行为、配置、部署、协议或运营语义发生变化时，在同一 PR 中更新对应的规范文档。
5. 运行 `npm run validate:merge` 与 `npm run check:deploy`。
6. 必需的检查通过后，使用 squash merge 合并。

PR 描述应说明问题、行为变更、验证方式、兼容性影响、资源影响、安全影响，以及任何经过测量的热路径影响。重构类 PR 必须说明外部行为是否发生变化；保持行为不变的重构，不得悄悄改变调度器、协议、超时、冷却、回退或配置的语义。

## 仓库归属

- `src/` —— Cloudflare Worker 运行时。
- 测试不存放在本仓库中：它们位于 `fongap-labs/action-worker` 的 `tests/packs/ai-gateway/` 下，并通过 `npm test` 运行。
- `scripts/` —— 仓库、CI、配置、安装、部署与发现工具。
- `migrations/` —— 有序的 D1 schema 变更。
- `docs/` —— 长期有效的架构、运营与治理文档。

不要将测试文件放回 `scripts/` 下；测试可以调用脚本，但工具与校验分属不同的所有者。当受支持的入口点已经存在时，不要再添加重复的部署/更新包装器，参见 [scripts/README.md](scripts/README.md)。

## 文档职责

`README.md` 是项目的规范首页。文档体系如下：

- [架构](docs/architecture/overview.md) —— 持久的设计边界与不变式。
- [运营](docs/operations/configuration.md) —— 配置与部署流程。
- [治理](docs/governance/README.md) —— 开发、质量、依赖、产品与文档策略。

历史证据保存在 Git 历史、Pull Request、commit、已有的 tag 以及已有的 GitHub Release 之中。仓库不维护自动化的项目发布编号。仓库中的 `CHANGELOG.md` 是英文工程记录，并遵循 Action Worker 的变更日志约定；它不构成第二套历史系统。

如果需要命名的发布，由维护者选定目标 commit，并手动创建 Git tag 或 GitHub Release。CI 与部署自动化绝不可推断、递增、校验或发布项目发布编号。

不要为长期文档创建临时性的 `latest`、`final`、`new` 或带版本后缀的副本。应直接更新负责该内容的文档。

## 核心治理文档

- [开发策略](docs/governance/development-policy.md)
- [质量策略](docs/governance/quality-policy.md)
- [依赖策略](docs/governance/dependency-policy.md)
- [产品策略](docs/governance/product-policy.md)
- [文档策略](docs/governance/documentation-policy.md)

## 安全

切勿提交或粘贴真实的 API 密钥、bearer token、authorization 头、私有上游 URL、请求体或用户数据。请通过 [SECURITY.md](SECURITY.md) 中描述的私密流程报告漏洞。
