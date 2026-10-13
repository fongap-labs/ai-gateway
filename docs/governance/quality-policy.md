# 质量策略

质量门禁在部署之前保护运行时行为。仓库将合并门禁（merge gate）与完整的生产门禁（production gate）区分开来。

## CI 模型

本仓库的 `.github/workflows/ci.yml` 仅在 `main` 分支推送与 `workflow_dispatch` 时运行，它只负责将运行请求分发给 Action Worker（`fongap-labs/action-worker`）。实际的中央执行契约位于 `.github/scripts/central-ci.sh`，由 Action Worker 调用。测试套件由 Action Worker（`tests/packs/ai-gateway`）拥有，并针对本仓库的检出结果运行。

### 合并门禁

合并门禁针对 Pull Request 与推送运行。中央执行契约按以下顺序执行：

```bash
npm ci
npx --no-install biome check .
npx --no-install tsc --noEmit
npm run validate:merge
node "$CENTRAL_CI_AW_ROOT/tests/run-pack.mjs" ai-gateway "$TARGET_ROOT" all
npm run check:deploy
```

`npm run validate:merge` 本地执行以下检查：语法、部署配置、迁移治理、安全扫描（secret scanning）、文档检查、Markdown 链接检查，以及 TypeScript 类型检查（均通过 `package.json` 中的脚本运行）。Biome 检查与单元/契约测试套件则由中央契约执行。`npm run check:deploy` 执行 Worker bundle 的 dry-run。

### 生产门禁

生产门禁在非 PR 的中央运行（例如 `main` 分支推送）中执行 `npm run validate:deploy`。当 `CENTRAL_CI_PR_NUMBER` 为 `0` 时，中央契约会执行该步骤。

在本仓库中，`npm run validate:deploy` 与 `npm run validate:merge` 的脚本内容完全相同。额外的单元、集成、压力、Codex 与 Claude 契约测试属于 Action Worker 测试包的一部分，而不是本地 `validate:deploy` 脚本的内容。

仅当 `main` 分支的推送触发的 CI 运行成功时，才允许自动部署到生产环境（`.github/deploy.json` 中 `automatic: true`）。部署入口 `scripts/deploy.sh`（由 `.github/deploy.json` 引用）在触碰生产环境之前，会先运行 `npm run validate:deploy` 与 `npm run check:deploy`，并在部署后通过 `/health` 验证部署标识（commit SHA）。

## 行为契约

任何涉及某项行为的变更，都必须保留或有意地更新对应的可执行契约。

高风险领域包括：

- 协议与 surface 路由；
- Chat Completions ↔ Anthropic Messages 回退；
- OpenAI Responses 的 Native Only 行为；
- 流式输出的首事件提交点；
- Tier 1 的 P2C、亲和、热度保护、RPM 准入与限流恢复；
- Tier 2/3 的选择与熔断状态；
- 逻辑 attempt、dispatch、hedge 与故障转移预算；
- 访问分组授权与节点凭据绑定；
- 部署顺序与回滚；
- D1 保留策略与公共模型状态投影。

不要仅因为新的实现与某个契约测试不一致，就重写该契约测试。应先判断预期行为是否确实发生了变化。

## 协议质量

内置的协议回退配置恰好为：

```json
{
  "anthropic:messages": ["openai:chat_completions"],
  "openai:chat_completions": ["anthropic:messages"]
}
```

OpenAI Responses 为仅 Native（Native Only）。转换回退与原始请求的 attempt 及墙钟预算共享；hedge 孪生请求不会跨协议。

转换诊断信息必须保持为分类化且不含敏感内容。请求体、提示词、JSON Schema、凭据以及客户端工具名称，不得进入诊断日志。

## 可靠性质量

Tier 1 的热度保护是有界的整形增强，而不是第二套配额系统。

- RPM 余量可以在硬性门禁之前，对选择结果进行软性调整。
- 亲和可以在热度作用下向中性值衰减，但绝不能成为独立的惩罚项。
- 在备用容量较低时，可以抑制可选的 hedge 孪生请求。
- 主请求的资格判定仍由既有的硬性并发/RPM/冷却规则控制。
- 成功率不作为正向的路由奖励。
- 在没有真正的全局协调机制的情况下，实现不得宣称具有全局一致的 provider 配额。

## 安全门禁

`npm run security:scan` 必须通过。仓库与评审规则必须防止真实凭据或私有数据进入源码、示例、日志或诊断信息。

至少包括：

- 节点配置必须拒绝凭据字段；
- 上游凭据仅保存在按层级划分的 Secret 中；
- 网关客户端密钥使用分组访问密钥模型；
- 客户端的 authorization 头与 cookie 绝不转发到上游；
- 上游默认要求 HTTPS；
- `/health` 与 `/metrics` 保持鉴权；
- 敏感的请求体不得写入日志。

参见 [SECURITY.md](../../SECURITY.md)。

## 文档质量

规范文档属于契约的一部分。CI 检查结构与链接，但评审还必须核对文档与源码、工作流之间的事实一致性。

`README.md` 为规范文档；本地化文档必须指回它。

## 发布标识质量

自动化校验的是**基于 commit SHA 的部署标识**，而非项目发布编号。在生产验证通过之前，`/health.build` 必须与被部署的 commit 相匹配。

项目发布编号由人工持有，且不在自动化质量门禁的范围之内。若需要命名发布，人工可以在验证过目标 commit 之后创建 Git tag 或 GitHub Release。CI 绝不可生成、推断、递增、同步或校验该编号。
