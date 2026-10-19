# 工具

`scripts/` 包含仓库、运营者、CI、配置、部署、校验以及 provider 发现相关的工具。它不是 Worker 运行时代码或测试的存放地。

## 受支持的入口点

| 用途 | 入口点 |
| --- | --- |
| 直接进行本地代码部署 | `npm run deploy` |
| 本地 Worker 开发 | `npm run dev` |
| Cloudflare 登录 / 身份 / 日志 tail | `npm run cf:login`、`npm run cf:whoami`、`npm run tail` |
| 配置检查 | `npm run config:check -- --tier1 <file> --secrets <file>`；`config:show` 与 `config:diff` 同样需要通过 `--` 传入文件参数（用法见 `scripts/config-cli.mjs`） |
| Provider Discovery | `npm run discovery:check`、`npm run discovery:summary` |

生产部署仍然由 GitHub Actions 以仓库为驱动完成。本地入口点是运营者工具；它们不能替代生产 CI 门禁。

## Wrangler 归属

`scripts/cloudflare-wrangler.mjs` 是仓库中唯一的 Wrangler 版本锁定所有者，并负责通用的直接 CLI 行为。对于真实的本地部署，它还负责强制要求必需的 Tier 1 亲和绑定（TIER1_AFFINITY），以及 D1 迁移先于 Worker 部署的执行顺序。

不要将 Wrangler 版本号复制到 package 脚本、安装程序、重新配置脚本或新的包装器中。所有 Cloudflare CLI 调用都应通过 `cloudflare-wrangler.mjs` 进行。

## 配置工具

- `config-cli.mjs` 用于检查、校验、展示和比较运营者配置。
- `node-config-shards.mjs` 负责节点配置/Secret 分片的校验与规划原语。
- `plan-node-configuration.mjs` 将这些原语以 CLI 的形式暴露出来。
- `github-deployment-config.mjs` 负责将 GitHub Variables/Secrets 桥接到生产部署载荷中。

`wrangler.jsonc` 是受版本控制的基线配置。运营者特定的 Worker 名称、绑定与本地变量应放在被 git 忽略的 `wrangler.user.jsonc` 中；引导工具不得改写受版本控制的基线。

## 校验工具

仓库在 `scripts/` 下使用一组聚焦的可执行检查，包括语法、部署配置、迁移、文档、链接与密钥扫描。这些工具的测试位于中央测试包（`action-worker:tests/packs/ai-gateway/`）中。

## 运营者探针

`health-check.*`、`models-check.*` 与 `metrics-check.*` 是刻意保持精简的、平台原生的 Shell/PowerShell 探针。它们保持独立，是为了让凭据可以通过交互方式输入，而不引入跨平台的交互式依赖，也不为三个简单端点引入大型抽象。

## Provider Discovery

`scripts/provider-discovery/` 是只读的建议性子系统，负责能力快照、归一化、差异比较、运行时一致性检查、报告生成以及 SSRF 防护。它不会修改运行时节点配置，也不会加入 AI 请求的热路径。

## 不属于本目录的内容

- Worker 运行时代码 → `src/`
- 可执行的测试/契约/仅供测试使用的辅助代码 → `action-worker:tests/packs/ai-gateway/`
- 持久化的配置示例 → `config/`
- D1 schema 变更 → `migrations/`
- 长期有效的设计与策略文档 → `docs/`

当已有受支持的入口点承担某项操作时，不要新增兼容别名，例如 `setup-and-deploy.*`、`install.*`、`reconfigure.*`、`update.*` 或重复的 `deploy.*` 包装器。
