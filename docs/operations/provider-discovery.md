# Provider Discovery

Provider Discovery 是只读的运营工具，用于跟踪外部的协议/surface 证据。它不属于请求路由的一部分，并且绝不能修改生产环境的节点配置。

## 边界

```text
外部 provider 证据
        ↓
Discovery 目录
        ↓
归一化 / 语义差异比较
        ↓
运行时一致性报告
        ↓
人工评审
        ↓
（若有充分理由）显式的配置变更
```

关键规则是单向流动：Discovery 可以报告运行时配置与观测到的 provider 能力不一致；但它不会自动禁用节点、改写模型、修改 base URL 或变更 Tier。

## 线协议契约

Discovery 读取与运行时相同的账号级 Node Config：`id`、`provider`、`base_url`、`models` 以及可选的节点 `priority`。协议与可路由的 surface 不是账号字段，它们来自 `src/providers/registry.ts`——运行时与 Discovery 共用的唯一 provider 线协议契约。

当前的线协议配置为：

- `anthropic` → Anthropic `messages`；
- `openai` → OpenAI `chat_completions` + `responses`；
- 其他 provider 名称 → OpenAI 兼容的 `chat_completions`。

有效的 Node Config 不得添加 `protocol` 或 `surfaces` 来覆盖该契约。

## 目录模型

目录记录 OpenAI 与 Anthropic 协议族的 provider 观测结果，包括已知的 base URL 与 surface。

支持状态为三值的：

- `true`——当前证据表明支持；
- `false`——证据表明不支持；
- `null`——未知或未经确认。

未知并不等同于不支持。

当前目录的 surface 包括：

- OpenAI：`chat_completions`、`responses`；
- Anthropic：`messages`，以及作为 discovery 元数据的 `count_tokens`。

`count_tokens` 仅是 discovery 元数据；运行时节点 schema 将 Anthropic `messages` 建模为可路由的 Anthropic surface。

## 证据纪律

Discovery 会按照目录 schema，区分已配置、官方、已验证与未知的证据。当工具只读取了文档或安全的元数据时，不得声称已完成生成能力的验证。

Live Model Discovery 执行两项有界的观测：

1. 使用已配置的节点凭据调用 `GET /v1/models`；
2. 使用一个刻意无效的空 `POST {}` 请求进行 surface 探测。

surface 探测并不是有效的生成请求，绝不能包含提示词、用户内容或真实的模型负载。其目的仅是通过状态码区分「端点存在」与「端点不受支持」。

## 运行时一致性

运行时比较使用经过脱敏的投影，例如：

```text
id
provider
protocol
surfaces
base_url
```

快照、报告、产物、日志与差异中均排除凭据。

告警仅供参考，并按严重程度排序。base URL 的差异属于差异本身，并不能证明任一 URL 无效。

## CLI

```bash
npm run discovery:check
npm run discovery:summary

node scripts/provider-discovery.mjs check-snapshot <catalog.json>
node scripts/provider-discovery.mjs summary <catalog.json>
node scripts/provider-discovery.mjs diff <before.json> <after.json> [--out FILE] [--json-out FILE]
node scripts/provider-discovery.mjs runtime-check <catalog.json> <runtime-view.json> [--json-out FILE]
node scripts/provider-discovery.mjs live --previous <previous-models.json> --out-dir <directory>
```

退出码 `2` 表示高优先级的运行时一致性告警；它并不是自动修改运行时配置的信号。

## 工作流

当前本仓库的 `.github/workflows/` 中**没有** `model-discovery.yml`（仅包含 `ci.yml` 与 `dispatch-pr-governance.yml`）。因此，目前不存在定时自动执行的外部观测。需要时可手动运行上述 CLI。

若将来重新配置定时观测工作流，它应当：

- 与必需的合并 CI 解耦，使第三方服务的可用性不会阻塞正常的 Pull Request；
- 仅在受控的 GitHub Actions 环境中、且仅在运行期间，临时接收认证 provider 观测所需的 Node Config 变量与节点 Secret 分片；凭据绝不能写入 Discovery 快照、产物、报告、日志或仓库文件。

中央 CI 使用离线测试验证 Discovery 的实现。外部观测属于后台运营证据，既不是合并要求，也不是运行时依赖。

## 安全

Discovery 绝不能：

- 持久化或记录 API 凭据、authorization 头、cookie 或用户请求数据；
- 从不受信任的 provider 名称合成 provider URL；
- 使用携带凭据的 URL；
- 跟随未通过结构或 DNS 支撑的 SSRF 校验的 URL 或重定向，除非为受信任的私有 provider 显式启用了 `AIG_CAN_DISCOVER_PRIVATE_PROVIDERS`；
- 执行破坏性操作或写入配置的操作；
- 成为 `src/request`、`src/scheduler`、`src/reliability`、`src/transport`、`src/protocol`、`src/conversion` 或 `src/stream` 的运行时依赖。

目录是供评审使用的证据，而不是高于正在运行配置的权威。
