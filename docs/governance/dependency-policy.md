# 依赖策略

ai-gateway 将 Worker 运行时的依赖面保持在有意的最小范围内。当依赖变更影响打包、协议语义、网络行为或部署工具时，将其视为行为风险变更。

## Dependabot

`.github/dependabot.yml` 当前检查：

- npm 依赖，每月一次，最多 5 个未合并的 PR；
- GitHub Actions，每月一次，最多 5 个未合并的 PR。

安全更新不会仅仅为了维持每月的节奏而被推迟。

## 更新策略

### 补丁与次要版本更新

当满足以下条件时，可以合并补丁/次要版本的依赖更新：

- 必需的 CI 通过；
- 更新未引入已知的破坏性行为；
- Worker bundle 与部署 dry-run 仍然有效；
- 安全影响可以接受。

是否自动合并是仓库设置的选择，而非本策略所假定的前提。

### 主要版本更新

主要版本更新需要对破坏性变更、Worker/运行时兼容性、配置变更以及发布影响进行明确评审。若公共或运营行为发生变化，应更新相关的规范文档与 `CHANGELOG.md`。

## 运行时依赖

当 Web 平台或小型的本地实现已经足够时，优先不引入运行时依赖。新增运行时包需要有具体的理由，例如安全性、协议正确性，或能够大幅降低维护成本。

不要仅为了方便而引入通用框架、校验栈、HTTP 封装或工具库。

## Lockfile

- `package-lock.json` 纳入版本控制。
- CI 使用 `npm ci` 以保证安装的确定性。
- 不得手动编辑 lockfile。

## GitHub Actions

必需工作流所使用的 Actions 应固定到不可变的 commit SHA。更新 Action 的固定版本，需要与其他构建/部署依赖同等的评审纪律。

## Wrangler

Wrangler 以固定版本的 CLI 形式调用，而不是作为生产依赖安装。规范的部署包装器为 `scripts/cloudflare-wrangler.mjs`，它负责固定 Wrangler 版本，以及本地的部署与迁移行为。

当 Wrangler 版本锁定发生变化时：

1. 评审 Cloudflare 的破坏性变更；
2. 更新仓库工具与脚本中每一处有意重复声明的 CLI 版本锁定；
3. 按需运行 `npm run validate:merge`、`npm run validate:deploy` 与 `npm run check:deploy`；
4. 若行为或运行要求发生变化，更新运营文档。

除非 Wrangler 已真正迁移到 `package.json` 中，否则不要在文档中将 `package.json` 写成 Wrangler 版本的来源。
