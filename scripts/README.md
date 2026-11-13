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
- `tier-cutover-plan.mjs` 只读生成三层到两层的脱敏迁移预检报告；通过 `npm run config:cutover:plan -- --tier1 ... --tier2 ... --tier3 ... --credential-index ... --policies ... --model-catalog ...` 使用。报告保留迁移动作和模型映射指纹，不包含上游模型名、凭据值或生产批准。具体契约见 [两层迁移预检](../docs/architecture/two-tier-cutover.md)。
- `node-config-shards.mjs` 负责节点配置/Secret 分片的校验与规划原语。
- `plan-node-configuration.mjs` 将这些原语以 CLI 的形式暴露出来。
- `github-deployment-config.mjs` 负责将 GitHub Variables/Secrets 桥接到生产部署载荷中。

`wrangler.jsonc` 是受版本控制的基线配置。运营者特定的 Worker 名称、绑定与本地变量应放在被 git 忽略的 `wrangler.user.jsonc` 中；引导工具不得改写受版本控制的基线。

## 校验工具

仓库在 `scripts/` 下使用一组聚焦的可执行检查，包括语法、部署配置、迁移、文档、链接与密钥扫描。这些工具的测试位于中央测试包（`action-worker:tests/packs/ai-gateway/`）中。

`production-release-preflight.mjs --plan FILE` 离线串联四 Worker 拓扑、Wrangler 发布白名单和 Operations 三阶段/Cron 合同；要求拓扑清单只放在受保护目录，检查通过也不会授权或触发生产部署。

## 运营者探针

`health-check.*`、`models-check.*` 与 `metrics-check.*` 是刻意保持精简的、平台原生的 Shell/PowerShell 探针。它们保持独立，是为了让凭据可以通过交互方式输入，而不引入跨平台的交互式依赖，也不为三个简单端点引入大型抽象。

## 真实网关能力验收

`check-live-gateway-capabilities.mjs` 向**已经部署的** HTTPS Gateway 发真实请求，不使用模拟 Provider，也不会进行部署或修改配置。用例包括文本模型、可选 Omni 直连、普通 Chat 与原生 Responses 经 Perception 识图、可选实际故障转移和显式付费生成。Responses 检查须显式指定 `--responses-delegate-model`，会调用真实上游文本及视觉模型；在未配置访问 Key、模型或受控 HTTPS 环境时不应执行。需在受控环境提供原有 `AIG_ACCESS_KEY_MAX` / `AIG_ACCESS_KEY_AGENT` 等访问 Key；脚本不会输出 Key 或图片数据。

```bash
node scripts/check-live-gateway-capabilities.mjs --url https://<gateway-host> --chat-model Max --vision-model Omni --delegate-model Code-Max --responses-delegate-model Code-Max
```

识图验收使用随机红、蓝、绿、黄方块图片并校验模型给出的颜色；无法看图、回答错误或非颜色文本均判失败，不再仅凭非空回复判通过。测试不会回显图片或原始模型回复。

生图验收兼容 PNG、JPEG、WebP、GIF（不再只接受 PNG）。相关响应格式另有离线断言脚本 `check-live-gateway-assertions.mjs`，中央 CI 会自动运行，但这不等于真实 Provider 验收。真实付费图片请求**默认不执行**。在确认成本和权限后，才增加 `--run-image --image-model Image-Creator`（只执行一次图片生成）；`--run-direct-image` 会再增加一次明确的直接图片调用；`--run-auto-image` 会让文本模型选择 `generate_image`，在确实选择工具时再执行一次付费图片生成，未选择图片时作为验收失败处理。故障转移检查可使用 `--failover-model Code-Max --expect-dispatches 2`，但仅应在部署了可控失败节点的测试环境执行，并要求响应包含真实物理派发计数；如果缺少证据，脚本会报错，不将单次成功冒充故障转移成功。

## Provider Discovery

`scripts/provider-discovery/` 是只读的建议性子系统，负责能力快照、归一化、差异比较、运行时一致性检查、报告生成以及 SSRF 防护。它不会修改运行时节点配置，也不会加入 AI 请求的热路径。

## 不属于本目录的内容

- Worker 运行时代码 → `src/`
- 可执行的测试/契约/仅供测试使用的辅助代码 → `action-worker:tests/packs/ai-gateway/`
- 持久化的配置示例 → `config/`
- D1 schema 变更 → `migrations/`
- 长期有效的设计与策略文档 → `docs/`

当已有受支持的入口点承担某项操作时，不要新增兼容别名，例如 `setup-and-deploy.*`、`install.*`、`reconfigure.*`、`update.*` 或重复的 `deploy.*` 包装器。
