# 配置

生产配置由 GitHub Actions 下发到 Cloudflare Workers。非敏感的账号配置应放在仓库 Variables 中；凭据应放在 Secrets 中。Cloudflare Dashboard 不是日常配置的规范来源。

## 配置来源

| 来源 | 用途 |
| --- | --- |
| `AIG_TIER{1,2,3}_NODES_01..10` | 非敏感的账号/节点定义 |
| `AIG_TIER{1,2,3}_CREDENTIALS_01..10` | 按节点 id 索引的、按 Tier 划分的凭据 |
| `AIG_ACCESS_KEY_{AIR,PRO,MAX,ULTRA,AGENT}` | 网关访问密钥 |
| `AIG_ACCESS_MODELS_{AIR,PRO,MAX,ULTRA,AGENT}` | 按分组划分的逻辑模型允许列表 |
| `AIG_MODELS_CONFIG` | 可选的逻辑模型元数据/能力声明 |
| `AIG_POLICIES_CONFIG` | attempt、hedge、超时与 Tier 1 准入策略 |
| `AIG_DASHBOARD_MODELS` | 可选的公共仪表盘逻辑模型展示允许列表 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账号标识符；值来自主机仓库 Variable `CLOUDFLARE_ACCOUNT_ID_SECONDARY`（经中央别名注入，该名字需声明在 `.github/deploy.secrets.allowed`） |

`src/config/runtime-vars.ts` 是运行时变量默认值与取值范围的唯一来源。

## 访问分组

五个相互独立的分组为 `AIR`、`PRO`、`MAX`、`ULTRA` 与 `AGENT`。已配置的分组需同时使用以下两项：

```text
AIG_ACCESS_KEY_<GROUP>
AIG_ACCESS_MODELS_<GROUP>
```

分组之间不相互继承。空的或缺失的模型允许列表，对每个分组（包括 `AGENT`）都意味着零个模型授权。分组名称仅是授权边界，不会为 Tier 1 调度器分配优先级。

## 节点配置

节点 JSON 描述的是一个账号/端点，而非协议实现细节。

必填字段（Required fields:）：

```text
id
provider
base_url
models
```

可选字段：

```text
priority
```

示例：

```json
{
  "id": "nvidia-01",
  "provider": "nvidia",
  "base_url": "https://integrate.api.nvidia.com/v1",
  "priority": 10,
  "models": {
    "Code-Max": "upstream-code-model"
  }
}
```

规则：

- `id` 须匹配 `^[a-z0-9][a-z0-9-]{0,63}$`，并且全局唯一。
- `tier` 不是节点字段；由变量名前缀决定其所属的 Tier。
- 凭据绝不会出现在节点 JSON 中。
- `provider`、`base_url` 与 `models` 为必填项。仅当 Tier 2 的 `auth:"oauth"` 订阅节点所属的 provider 适配器声明了内置订阅端点（anthropic、openai、google）时，`base_url` 才可省略；此类节点的接入只需 `{id, provider, auth:"oauth", models}`。
- 除非显式启用了不安全的 HTTP，否则 `base_url` 必须是绝对的 HTTPS 地址。
- 若提供了 `priority`，它必须是非负整数。Tier 2/3 可以使用它；Tier 1 不会将静态节点 priority 用作 P2C 评分。
- `models` 是一个从逻辑模型到上游模型的映射对象。`{}` 仅表示有意设置的、受目录约束的通配符。
- `protocol`、`surfaces`、`limits`、凭据字段以及其他未知字段均会被拒绝（`protocol`, `surfaces`, `limits`, credential fields, and other unknown fields are rejected）。

当前只有一种节点结构。不保留任何备用或兼容的 schema。

### 订阅节点（`auth: "oauth"`，仅限 Tier 2）

Tier 2 节点可以声明 `"auth": "oauth"`，用以标记一个订阅权益节点。其凭据是在 dispatch 时从订阅 token 存储中解析出的 OAuth 访问 token，而非静态的 `AIG_TIER{N}_CREDENTIALS_*` 密钥。

```json
{
  "id": "claude-sub-1",
  "provider": "anthropic",
  "auth": "oauth",
  "base_url": "https://api.anthropic.com",
  "models": { "Code-Max": "claude-sonnet-4-5" }
}
```

规则：

- `auth: "oauth"` 仅在 Tier 2 节点上有效；在 Tier 1/3 节点上声明该字段属于配置错误。
- 订阅节点不得在 `AIG_TIER{N}_CREDENTIALS_*` 中拥有静态凭据——每个节点只能有一个凭据来源。
- 部署规划器（`plan-node-configuration` / `config-cli`）与运行时执行同样的规则：`auth:"oauth"` 仅限 Tier 2，订阅节点不需要静态凭据分片条目，且其 `base_url` 可交给 provider 内置订阅端点（anthropic、openai、google）。安装向导生成的 tier-2 配置已采用该形态。
- 若未配置 `AIG_OAUTH_PROVIDERS` 与 `AIG_TOKEN_ENCRYPTION_KEY`，订阅节点将保持不可用（失败即关闭），且不会接收任何流量。
- 接入方式：使用网关访问密钥打开 `/oauth/start?provider=<name>&node=<node-id>`；浏览器完成 provider 的授权同意后，将返回 `/oauth/callback/<name>`。

## Provider wire profiles（提供商线协议配置）

协议与 API surface 属于 Provider 的能力，并且仅在 provider 适配器注册表（`src/providers/registry.ts`）中定义一次：

- `provider: "anthropic"` → Anthropic 协议，`messages` surface。
- `provider: "openai"` → OpenAI 协议，`chat_completions` 与 `responses` surface。
- 其他 provider → OpenAI 兼容的 `chat_completions` surface。

运行时归一化会将这些协议/surface 事实添加到 `RuntimeNode` 中；账号级的节点 JSON 不会覆盖它们。

若某个 Provider 需要不同的线协议契约，应修改其在 `src/providers/` 中的 provider 适配器。不要在每个账号中重复声明结构性的协议/surface 字段。

OpenAI Responses 同样参与跨协议翻译；三个协议 surface 两两互转（规范化 IR 矩阵），内置默认链为：

```json
{
  "anthropic:messages": ["openai:chat_completions", "openai:responses"],
  "openai:chat_completions": ["anthropic:messages", "openai:responses"],
  "openai:responses": ["anthropic:messages", "openai:chat_completions"]
}
```

## 凭据分片

凭据分片是以节点 id 为键的 JSON 对象：

```json
{
  "nvidia-01": "credential-value",
  "nvidia-02": "credential-value"
}
```

Config 与 Secret 的分片后缀相互独立（independent）。绑定依据是 **Tier + node id**，而非分片后缀的匹配。

## Tier 角色

路由顺序固定为：

```text
Tier 1 → Tier 2 → Tier 3
```

- Tier 1：免费或实际上免费的容量；可靠性工作的主要关注点。
- Tier 2：订阅权益容量。静态 API Key 节点与 `auth: "oauth"` 订阅节点共享该层；该层不引入 Tier 1 的自适应机制。
- Tier 3：付费 API 容量；受保护的最终兜底。

## Tier 2 订阅（OAuth）

Tier 2 允许网关调用你**已有的付费 AI 订阅**——Claude Pro/Max、ChatGPT/Codex，或 Google One AI Premium / AI Pro——使用各 provider 的标准登录方式，而不是按量计费的 API Key。你只需在浏览器中登录一次；网关会存储加密后的 token 并自动刷新。你无需额外付费：它使用的是你已经在付费的容量，并通过网关的统一端点对外提供服务。

订阅节点是声明了 `"auth": "oauth"` 的 Tier 2 节点。其凭据是在 dispatch 时从订阅 token 存储中解析出的 OAuth 访问 token，而非静态的 `AIG_TIER{N}_CREDENTIALS_*` 密钥。Tier 2 订阅节点通过网关的 PKCE 接入流程，关联运营者自有的 provider 订阅（Claude Pro/Max、ChatGPT/Codex、Google One AI Premium，或任何经 OAuth 授权的上游）。

### 开始之前

在接入订阅之前，你需要满足以下全部条件：

- 一个可以通过浏览器访问的已部署网关。
- 一个网关访问密钥（`AIG_ACCESS_KEY_<GROUP>`），且其所属分组已列入 `AIG_OAUTH_ADMIN_GROUPS`（一个以逗号分隔的 Variable，例如 `ULTRA`）。关联订阅会替换该节点所有客户端所使用的凭据，因此只有列出的分组才能启动接入；未设置时，任何人都无法接入（失败即关闭）。无论如何，已关联的订阅都将继续正常工作。
- 已设置 `AIG_TOKEN_ENCRYPTION_KEY`（一个 base64 编码的 256 位 AES 密钥——安装程序会为你生成；若缺失，订阅接入将保持禁用，失败即关闭）。
- 已设置 `AIG_PUBLIC_URL`（仪表盘已经要求该项——它用于推导 OAuth 回调 URI）。
- 至少拥有三个 provider 之一的付费订阅。

### 第一个订阅（操作示例）

最快的路径是配置一个 Gemini 节点——它只需要四个字段（网关会从 provider 适配器解析端点）：

```json
[
  { "id": "gemini", "provider": "google", "auth": "oauth", "models": { "Code-Max": "gemini-2.5-pro" } }
]
```

1. 将上述 JSON 放入 `AIG_TIER2_NODES_01`（一个 Cloudflare **Variable**，而非 Secret）。
2. 在浏览器中打开以下 URL（替换主机名）：

   ```
   https://<your-gateway-url>/oauth/start?provider=google&node=gemini
   ```

   启动页面会要求输入你的网关访问密钥，并通过表单请求体提交（绝不通过 URL 提交），因此密钥不会出现在访问日志、浏览器历史或 `Referer` 头中。若调用该路由时附带 `Authorization: Bearer <key>` 头，则会跳过粘贴页面。
3. 同意 Google 的授权页面。Google 会跳转到其自身的 `codeassist.google.com/authcode` 页面（其 OAuth 客户端不允许任意的网关回调 URL），该页面会显示授权码。
4. 复制授权码，并将其粘贴到启动页面所显示的 `/oauth/paste` 链接处。
5. 网关使用 PKCE 与 `client_secret` 交换授权码，存储加密后的 token，此时该节点即已上线。

可用的 Gemini 上游模型（即 `models` 映射中的值）：

| 上游模型 | 说明 |
| --- | --- |
| `gemini-2.5-pro` | Gemini 2.5 Pro（Google One AI Premium / AI Pro） |
| `gemini-2.5-flash` | Gemini 2.5 Flash（速度更快，额度更低） |

Claude 与 Codex 节点遵循相同的模式，分别使用 `provider: "anthropic"` 或 `provider: "openai"`，其接入为**自动**完成（无需粘贴授权码的步骤）。请参阅下文的各 provider 接入流程。

### 网关如何处理你的登录信息

- 访问 token 与刷新 token 以 **AES-GCM 加密**后存储在 D1 中；绝不以明文存储，也绝不存入节点配置。若缺少 `AIG_TOKEN_ENCRYPTION_KEY`，则禁用全部订阅接入与解析（失败即关闭）。
- 在 dispatch 时自动刷新 token，并配有 isolate 本地缓存，以及以下机制：
  - 在主动刷新之前保留 5 分钟的过期裕量；
  - isolate 级别的 singleflight（同一节点的并发请求共享同一次刷新）；
  - 基于持久化 `refresh_version` 的跨 isolate compare-and-swap，因此败给他人的刷新写入方会重新加载胜出方轮换后的凭据，而不是覆盖它——持久化的权威 refresh token 始终只有一个；
  - 对刷新失败设置 60 秒的否定缓存，使失效的订阅不会反复冲击 provider 的 token 端点。
- 对于 OpenAI/Codex：OAuth 响应中的 `account_id` 会被持久化（明文，非机密），并在每一次 Codex 订阅 dispatch 中作为 `chatgpt-account-id` 头发送。Codex 订阅 dispatch 还会携带第一方的 `Originator: codex-tui` 标记，并在 Responses surface 上将缺失的 `instructions` 字段规范化为空字符串（ChatGPT 后端要求该字段必须存在）。
- 流程状态为一次性使用，并在 10 分钟后过期。

本节其余部分为参考资料：内置的 provider 默认值、OAuth 的变量/密钥，以及各 provider 的接入步骤。

### 参考：内置 provider 默认值

三个主流的国际 provider 均内置了**默认值**（来自其开源 CLI 的公开 OAuth 常量）——接入它们无需配置 `AIG_OAUTH_PROVIDERS`：

| Provider 键 | 订阅 | 接入方式 | Dispatch |
| --- | --- | --- | --- |
| `anthropic` | Claude Pro/Max | 自动（PKCE，回跳网关） | 已启用——主流的反向代理形态：Bearer + 所需的 OAuth beta 标志（`claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14`，与客户端提供的 beta 合并）+ `x-app: cli` + 第一方 claude-cli user agent。未实现 CCH 计费块签名（CLIProxyAPI 的额外偏执层）；请使用你自己的订阅进行实际验证。 |
| `openai` | ChatGPT/Codex | 自动（PKCE，回跳网关） | 已启用（Bearer + `chatgpt-account-id` + `Originator: codex-tui` + Responses surface 上的 `instructions` 规范化） |
| `google` | Gemini（Google One） | 手动粘贴（Google OAuth 客户端仅允许其自身的回调页面） | 已启用——Code Assist 后端（`cloudcode-pa.googleapis.com/v1internal`）：网关在订阅适配器内部，在 OpenAI Chat Completions 与私有的 `generateContent`/`streamGenerateContent` 信封之间相互转换（通用的 transport/conversion 层保持不变）。Bearer + 第一方 Gemini CLI user agent。 |

要使用默认值进行接入，请将 Tier 2 节点配置为匹配的 provider 名称，然后执行下文的接入流程。若要覆盖某项默认值或新增 provider，请设置 `AIG_OAUTH_PROVIDERS`。

### 参考：变量与密钥

- `AIG_OAUTH_PROVIDERS`（普通 Variable，JSON，可选）——按 provider 划分的 OAuth 注册表。用户条目会在 provider 层级**替换**内置默认值（整体替换，而非逐字段合并）。未设置时仅使用内置默认值：

```json
{
  "google": {
    "authorize_url": "https://accounts.google.com/o/oauth2/v2/auth",
    "token_url": "https://oauth2.googleapis.com/token",
    "client_id": "<your own client id>",
    "client_secret": "<your own client secret>",
    "scope": "https://www.googleapis.com/auth/cloud-platform",
    "manual_redirect_url": null,
    "upstream_headers": {}
  }
}
```

  `client_secret` 用于机密（confidential）OAuth 客户端（Google 始终要求提供；Claude/Codex 是公开的 PKCE 客户端，不需要）。设置 `manual_redirect_url` 会选择手动粘贴授权码的流程——若要使用自动回跳流程，请省略它（或通过默认设置使用你自己的网关回调地址）。是否具备 dispatch 资格由 provider 适配器注册表（`src/providers/`）决定，而非由配置决定：缺少订阅适配器或拒绝接入的 provider，仍可保持 OAuth 接入可用，但运行时 dispatch 会失败即关闭。内置的 `google` 适配器负责 Code Assist 线协议转换（`src/subscription/google-wire.ts`）；私有线协议绝不会进入网关通用的 transport 或 conversion 层。

- `AIG_TOKEN_ENCRYPTION_KEY`（Secret）——base64 编码的 256 位 AES 密钥。生成方式：`openssl rand -base64 32`。若未设置，订阅接入与解析将被禁用（失败即关闭）。

- `AIG_PUBLIC_URL`（Variable，仪表盘已经要求该项）——用于推导 OAuth 回调 URI `/oauth/callback/<provider>`。

### 参考：接入流程

`/oauth/start` 会渲染一个粘贴页面，通过 POST 请求体提交你的网关访问密钥，因此密钥绝不会出现在 URL 中（访问日志、浏览器历史、`Referer`）。携带 `Authorization: Bearer <key>` 的请求会直接跳转到 provider 的回调。

**Claude / Codex（自动）**：

1. 在浏览器中打开 `https://<your-gateway-url>/oauth/start?provider=anthropic&node=<node-id>`（或 `provider=openai`），并输入你的网关访问密钥。
2. 同意授权页面；provider 会跳转回 `/oauth/callback/<provider>`，网关随即完成交换。

**Gemini（手动粘贴）**：

1. 在浏览器中打开 `https://<your-gateway-url>/oauth/start?provider=google&node=<node-id>`，并输入你的网关访问密钥。
2. 同意 Google 的授权页面。Google 会跳转到其自身的 `codeassist.google.com/authcode` 页面（其 OAuth 客户端不允许任意的网关回调 URL），该页面会显示授权码。
3. 复制授权码，并将其粘贴到启动页面所显示的 `/oauth/paste` 链接处。
4. 网关使用 PKCE 与 `client_secret` 交换授权码，存储 token，并确认完成。

## 运行时变量

当前的数值型可调参数由 `src/config/runtime-vars.ts` 负责：

- `AIG_UPSTREAM_HEADER_TIMEOUT_MS`
- `AIG_FIRST_EVENT_TIMEOUT_MS`
- `AIG_STREAM_IDLE_TIMEOUT_MS`
- `AIG_RATE_LIMIT_COOLDOWN_MS`
- `AIG_AUTH_FAILURE_COOLDOWN_MS`
- `AIG_REQUEST_BODY_MAX_BYTES`
- `AIG_FAILOVER_BUDGET_MS`
- `AIG_HEDGE_DELAY_MS`
- `AIG_REQUEST_HEDGE_MAX`
- `AIG_ACCESS_KEY_RPM`
- `AIG_EDGE_CACHE_TTL_SEC`

`AIG_REQUEST_BODY_MAX_BYTES` 默认 20 MiB，最大 32 MiB。请求体会先作为文本读取再解析，超大请求更容易触及 Worker 的内存上限；除非上游确实需要，否则不要提高该值。超过 256 KiB 的请求不参与边缘缓存，超过 1 MiB 的请求不启动 hedge。

`AIG_EDGE_CACHE_AUTO`（布尔值，默认为 `false`）控制自动边缘缓存。默认情况下，只有发送了 `x-gateway-cache: true` 的请求才会被缓存；将其设为 `true` 后，`temperature: 0` 的请求也会被缓存。缓存条目的作用范围限定在调用方的 key 分组，以及其所提交凭据的带键指纹（由 `AIG_TOKEN_ENCRYPTION_KEY` 派生），流式请求与非流式请求绝不共享条目。包含工具调用的响应、被截断的流以及超过 2 MB 的响应体均不会被存储。轮换 `AIG_TOKEN_ENCRYPTION_KEY` 也会使现有缓存条目失效。

`AIG_RATE_LIMIT_COOLDOWN_MS` 是 Tier 2/3 节点在 429 未携带任何提示时的回退等待时间。Tier 1 不使用它：Tier 1 的 key 遵循自适应阶梯 `15s -> 30s -> 1m -> 2m -> 5m -> 10m -> 20m -> 30m`（参见[可靠性模型](../architecture/reliability-model.md#429-处理)）。若要修改该阶梯，请将 `AIG_RATE_LIMIT_STEPS_MS` 设置为以逗号分隔的毫秒数，例如 `15000,30000,60000,300000`。除非某个 provider 需要不同的设置，否则请保持其未设置；缺失或格式错误的值会保持默认值。

当 429 被分类为短期窗口类（分钟级限流，依据响应措辞或不超过 90 秒的显式等待提示）时，Tier 1 改用封顶 5 分钟的温和阶梯 `15s -> 30s -> 45s -> 1m -> 1.5m -> 2m -> 3m -> 5m`；若要修改该阶梯，请将 `AIG_RATE_LIMIT_WINDOW_STEPS_MS` 设置为同样格式的逗号分隔毫秒数（默认阶梯、长期配额起步与分类规则见[可靠性模型](../architecture/reliability-model.md#429-处理)）。同样地，缺失或格式错误的值会保持内置窗口阶梯。

当 429 被分类为长期配额类（小时级、日级窗口，依据响应措辞，或不低于 10 分钟的显式等待提示）时，Tier 1 使用长期配额阶梯 `5m -> 10m -> 20m -> 40m -> 1h -> 2h -> 3h -> 5h`，并让整个 key 一起冷却。这类窗口要等 provider 重置才会恢复，所以阶梯一直延伸到 5 小时窗口的长度；provider 自己声明的等待（`Retry-After`、正文里的 "resets in 4 hours"）在这类 429 上最多保留 6 小时，而不是被截成 10 分钟。若要修改该阶梯，请将 `AIG_RATE_LIMIT_QUOTA_STEPS_MS` 设置为同样格式的逗号分隔毫秒数，例如 `600000,3600000,18000000`；缺失或格式错误的值会保持内置阶梯。

超时与 hedge 的内置默认值会随请求体大小和回复方式自适应（参见[可靠性模型](../architecture/reliability-model.md#随请求体大小自适应)与[路由模型](../architecture/routing-model.md#hedge)）：请求体超过 50000 字符后，请求预算、响应头等待和首事件等待每 25000 字符各增加 1 秒（上限 45 秒）；非流式请求的响应头等待改为整个 attempt 窗口；内置的 3 秒 hedge 延迟会随大提示词、主节点的 TTFT 以及非流式回复（至少 10 秒）而推后。显式设置 `AIG_HEDGE_DELAY_MS` 或策略的 `hedge.delay_ms` 会按原值使用。

`AIG_IS_SUBSCRIPTION_ENABLED`（布尔值，默认为 `true`）用于开启或关闭 Tier 2 订阅代理。设为 `false` 时，标记为 `auth: "oauth"` 的节点不会被加载，且每个 `/oauth/*` 路由都会返回 404。`AIG_PUBLIC_DASHBOARD`（布尔值，默认为 `true`）决定是否在 `/` 提供仪表盘、在 `/readme-status.svg` 提供徽章；设为 `false` 时两者均返回 404。`AIG_DIAGNOSTICS_GROUPS`（以逗号分隔的 key 分组，默认为空）将 `/health` 与 `/metrics` 限制为所列分组；设置之后，其他任何有效 key 都会收到 403，而 `/v1/models` 仍对所有 key 开放。

其他当前使用的变量还包括：`AIG_CORS_ORIGIN`、`AIG_USAGE_INCLUDE_MODE`、`AIG_USAGE_EXCLUDE_PROVIDERS`、`AIG_ANTHROPIC_COUNT_MODE`、`AIG_LOG_LEVEL`、`AIG_PROTOCOL_FALLBACKS`、`AIG_SHOULD_EXPOSE_UPSTREAM`、`AIG_HAS_STREAM_GUARD`、`AIG_CAN_USE_HTTP`、`AIG_DASHBOARD_MODELS`、`AIG_OAUTH_PROVIDERS` 与 `AIG_OAUTH_ADMIN_GROUPS`（参见 [Tier 2 订阅](#tier-2-订阅oauth)）。

## 仪表盘模型展示

`AIG_DASHBOARD_MODELS` 是逻辑模型的展示允许列表，以逗号分隔。

示例：

```text
AIG_DASHBOARD_MODELS=Code-Ultra,Code-Max,Code-Pro,Ultra,Max,Pro,Air
```

它不会改变路由、授权、`/v1/models`、回退、D1 采集或聚合用量总计。它控制的是：哪些公共逻辑模型会出现在模型状态区域中，以及哪些模型可以在模型用量细分中按名称显示；未在允许列表中的用量会被汇总到「其他」中。

## 容量与可靠性

Tier 1 使用观测到的运行时事实，而非猜测的 Provider 额度：

- 实时 in-flight 工作量；
- 真实的限流响应，包括由失败分类器归一化后的、形如配额的 provider 错误；
- 有界的自适应冷却与 `Retry-After`；
- provider-model 热度；
- 被动 TTFT；
- 软性会话亲和、探索、恢复/熔断状态；
- 可选的显式 `AIG_POLICIES_CONFIG.max_in_flight` 安全上限。

配置 Tier 1 节点时，GitHub 部署预检强制要求 `AIG_AFFINITY_KV_ID`；运行时若未绑定该 KV，亲和会静默禁用，主链路仍可用。生产环境建议至少两个独立 Tier 1 账号，并将 `AIG_ACCESS_KEY_RPM` 设为非 0、为策略设置有限的 `max_in_flight`；这些不是硬编码默认值。

访问密钥分组不会增加路由评分因子。`AIG_ACCESS_KEY_RPM` 用于保护网关访问密钥；它不是 Provider 额度模型。

## 策略

示例：

```json
{
  "default": {
    "max_attempts": 5,
    "tier_attempts": null,
    "hedge": { "enabled": true, "tiers": ["tier1"] },
    "headers_timeout_ms": null,
    "first_event_timeout_ms": null,
    "failover_budget_ms": null,
    "max_in_flight": null
  }
}
```

`max_attempts` 是请求级的逻辑 attempt 上限。Tier 上限必须落在该值之内。`headers_timeout_ms`、`first_event_timeout_ms` 与 `failover_budget_ms` 可以选择性地为某一个策略覆盖全局的请求时序设置。若没有显式的模型策略，`Air`/`Code-Air` 使用内置的 `fast` 策略（`max_attempts=4`，60 秒故障转移预算），在 Air → Pro → Max → Ultra 之间提供一轮评估。`Pro`/`Max`/`Ultra` 及其 `Code-*` 变体使用 `long-reasoning`（`max_attempts=6`，不启用 hedge，60 秒 header 超时，60 秒首事件超时，180 秒故障转移预算），与完整的 3/2/1 家族回退计划保持一致。其他模型使用 `default`。显式设置的 `AIG_MODELS_CONFIG.<model>.policy` 总是优先。跨 Tier 的分配模型只有一种：严格的 Tier 优先级。`budget_split`, weighted allocation, and alternate tier-budget modes are not part of the current policy schema（`budget_split`、加权分配以及备用的 Tier 预算模式不属于当前的策略 schema），若出现即作为未知字段被拒绝。

## 请求时序

除非解析后的模型策略提供了 `failover_budget_ms`，否则 `AIG_FAILOVER_BUDGET_MS` 即为一次请求的全局墙钟预算。`AIG_UPSTREAM_HEADER_TIMEOUT_MS` 与 `AIG_FIRST_EVENT_TIMEOUT_MS` 仍是全局的阶段默认值，而模型策略可以用 `headers_timeout_ms` 与 `first_event_timeout_ms` 覆盖它们。Native Tier、协议回退、模型家族回退以及有界复检都不会重置已解析的预算。一次物理 dispatch 会在 header、首个有意义的输出、响应体组装以及有界的诊断读取之间共享同一个绝对 attempt 截止时间。hedge 孪生请求继承该截止时间。

## 用量计费

仪表盘的用量展示有意将公共服务量与物理上游工作量分开：

- Token 总量使用上游报告的真实物理 Token 消耗，在上游报告了用量时，包括重试/回退/hedge attempt 的消耗；
- public `次请求` counts successfully delivered requests（公共「次请求」统计的是成功交付的请求），因此不会因为内部重试、回退或 hedge 孪生请求而膨胀；
- 模型用量细分可以在其工具提示中显示物理上游调用次数；
- TTFT 的 `samples` 统计近期窗口内带有 TTFT 样本的、成功交付的请求数；
- 缺失的上游用量会被记录为缺失，绝不会进行估算。

D1 用量与公共状态仅作为可观测性输入；历史聚合数据不会影响路由决策。

## 部署标识

部署标识是 Git commit SHA，它被注入为 `GITHUB_SHA`，并通过经过认证的 `/health` 以 `build` 字段暴露。若需要命名发布，由人工以 Git tag / GitHub Release 的方式创建。

## 本地校验

```bash
npm run config:check -- --tier1 <tier1-nodes.json> --secrets <secrets.json>
npm run validate:merge
```

`config:check` 需要显式传入文件参数：`--secrets` 必填，且至少提供 `--tier1`、`--tier2`、`--tier3` 之一；`--models` 与 `--policies` 可选。
