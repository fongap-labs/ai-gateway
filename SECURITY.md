# 安全策略

## 支持的版本

仅当前的 `main` 分支与最新已发布的 Release（若存在）处于积极维护之中。较早的 Release 可能不会获得安全修复。

## 报告漏洞

切勿在公开的 Issue 中披露可被利用的细节。请使用仓库的 **Security → Report a vulnerability** 流程创建私密的 GitHub Security Advisory。

切勿包含以下内容：

- API token 或网关访问密钥的值；
- 完整的 authorization 头；
- 私有上游 URL；
- 用户提示词、请求体或个人数据；
- 公开讨论串中的可利用细节。

若私密 Advisory 不可用，请提交一个公开 Issue，内容仅限于请求一个私密的报告渠道。

## 部署职责

- 将已配置的 `AIG_ACCESS_KEY_AIR`、`AIG_ACCESS_KEY_PRO`、`AIG_ACCESS_KEY_MAX`、`AIG_ACCESS_KEY_ULTRA`、`AIG_ACCESS_KEY_AGENT` 值，以及所有 `AIG_TIER{1,2}_CREDENTIALS_*` 分片，存储为 Cloudflare Secret。将对应的 `AIG_ACCESS_MODELS_AIR`、`AIG_ACCESS_MODELS_PRO`、`AIG_ACCESS_MODELS_MAX`、`AIG_ACCESS_MODELS_ULTRA`、`AIG_ACCESS_MODELS_AGENT` 值，以及节点配置（`AIG_TIER{1,2}_NODES_*`），存储为非敏感变量。节点凭据按 **Tier + node id** 绑定；`01..10` 仅为分片编号，Config 与 Secret 的分片后缀相互独立（independent），无需一一对应；
- 切勿提交 `.dev.vars`、`.env`、`secrets*.json` 或 `wrangler.user.jsonc`；生产环境的自定义域名应放在 `wrangler.user.jsonc`（已被 git 忽略）中，参见 `wrangler.user.jsonc.example`；
- 切勿通过 URL 查询参数传递凭据；
- 保持 `/health` 与 `/metrics` 受保护；
- 对已暴露或疑似泄露的凭据，立即吊销并轮换；
- 在公开分享 Worker 日志之前，先进行审查。

## 网关强制执行的防护

- 使用常量时间比较的网关鉴权（Bearer / `x-api-key`）；
- 严格的上游头部白名单——客户端凭据、cookie、转发类头部以及 CF 私有头部绝不会被中继；
- 默认仅允许 HTTPS 上游；使用 `redirect: 'manual'`，因此重定向绝不会携带凭据；
- 有界的请求/响应读取；
- 除非显式设置了 `AIG_CORS_ORIGIN`，否则 CORS 处于禁用状态；
- 所有响应、诊断端点与日志行均不包含凭据。

## 限流边界

网关内置的 RPM 限流器（`src/ratelimit/key-rpm.ts`）是**isolate 本地**的：它仅在单个 Cloudflare Workers isolate 内对每个分组施加上限。在水平扩展（多个 isolate）的情况下，分布式客户端可能超过名义上的 RPM，超出倍数等于活跃 isolate 的数量。

若需要严格的账号级全局限流，运营者应在以下方案中选择其一叠加使用：

- **Cloudflare WAF Rate Limiting**（推荐；全局、在边缘执行）
- **Durable Object 计数器**（自定义协调，会增加延迟）

限流器是**按分组**（group-scoped）而非按 key 设置的：同一 `AIG_ACCESS_KEY_<GROUP>` 中的所有访问密钥共享同一 RPM 上限。这是有意的设计，以避免按 key 状态的爆炸式增长；详情参见 `src/ratelimit/key-rpm.ts`。

`AIG_ACCESS_KEY_RPM` 默认为 `0`，即不设每分组每分钟的上限；设为正数才会启用该上限。

### 认证失败节流

鉴权失败（缺少或错误的网关密钥）的请求，由独立的失败尝试窗口（`AIG_AUTH_ATTEMPT_RPM`，默认 `60`，每分钟，每个 isolate；设为 `0` 关闭）限制。该检查在凭据校验之前进行：超限的请求直接返回 `429`，错误码为 `gateway_auth_throttled`，并带有 `Retry-After` 头。

- **只计失败**：鉴权成功的请求不消耗失败预算；同一指纹一旦鉴权成功，其失败窗口即被清零。
- **指纹**：未携带凭据的请求共用 `ANON` 指纹；携带凭据的请求使用所提交凭据的 SHA-256 前 16 位十六进制字符。明文凭据不会被存储或记录。
- **已知局限**：指纹按凭据区分，因此每个不同的凭据拥有各自的窗口。持续更换凭据进行爆破的请求，不会累计到同一窗口，该节流对此无效；它主要抑制同一凭据反复失败的请求，以及无凭据的高频请求。针对凭据爆破的防护，需要依赖访问密钥本身的熵（推荐足够长的随机密钥）以及上述 Cloudflare WAF 规则。
- 与 RPM 上限一样，窗口是 isolate 本地的，跨 isolate 的总量不受严格约束。

## 公开仪表盘

公开仪表盘（`/`）与状态徽章（`/readme-status.svg`）由 `AIG_PUBLIC_DASHBOARD` 控制，**默认开启**（`true`）；设为 `false` 时两者均返回 404。匿名访客可以看到模型状态与用量聚合；仪表盘**不**列出访问密钥分组名（`AIR`、`PRO`、`MAX`、`ULTRA`、`AGENT` 等），分组名属于运营信息。

## 已退役的会员订阅执行层

旧 Tier 2 的 OAuth 会员代理、订阅专有适配器与 Token 刷新代码已从应用层和共享包中删除。新 Tier 2 只使用由私有执行中心读取的静态 API Token；旧 OAuth 节点配置及相关运行时变量会被拒绝，`/oauth/*` 返回 404。

历史 D1 迁移不可改写；旧数据和远程 Cloudflare Secrets 必须通过另行审批的受控清理流程处理，不能由普通代码合并或部署自动销毁。
