# 产品策略

本文档定义 ai-gateway 长期有效的产品与架构规则。运行时实现可以演进，但变更必须始终处于这些边界之内，除非先明确修订本策略。

## 产品范围

ai-gateway 是一个面向家庭、个人运营者或小型可信团队的私有 AI API 网关（a private AI API gateway for a household, an individual operator, or a small trusted team）。

它不是公共 SaaS 网关、企业级 API 管理平台、转售平台、计费系统，也不是通用的多租户控制平面。主要服务于这些产品形态的功能不在范围之内。

本产品应当保持易于部署、易于理解、易于运维。优先采用少量明确的概念，而不是泛化的框架、扩展层、兼容垫片或面向未来的抽象。

## 运行宿主与部署通道

ai-gateway 有两个部署通道，各自是 Action Worker 部署清单中的一个目标：

- `cloud-host-docker`：运营者自有云主机上的 Docker 容器（见[Docker 部署](../operations/docker-deployment.md)）。Cloudflare Workers 的 CPU 时间额度不足以支撑长请求与流式转换的开销，因此它承担长期运行的主要负载。
- `cloudflare-worker`：Cloudflare Workers，保留为第二通道。

规则：

- `main` 是唯一可信源。两个通道部署的是同一个经过 PR 合并的 commit SHA，不存在第二条可信分支。
- 两个通道运行同一份 `fetch` 处理函数，协议、流式、调度、冷却与 token 记账契约必须一致。
- 宿主专属的能力差异（D1、KV、Cache API、cron）必须在运维文档中明确列出；差异只能表现为功能降级，不能改变协议或路由语义。
- 两个通道各自使用独立的部署环境与密钥白名单，不共享凭据。
- 部署经由 Action Worker 治理，ai-gateway 不实现独立的生产部署 workflow。
- 两个通道不得各自维护一套运行时契约（one current runtime contract）。

## Tier 角色

### Tier 1 — free-token capacity（免费 token 容量）

Tier 1 是长期的主要运行层，承载来自多个 provider/账号的免费或实际上免费的 token 容量。

其首要目标是持续可用性。在配额不均、速率限制、延迟波动以及 provider 故障的情况下，Tier 1 必须保持稳定、高效、安全，并可持续使用。

Tier 1 的工程重点应放在：

- 多 key、多 provider 的韧性；
- 基于真实限流/故障证据的自适应恢复；
- 有界的负载分散，而非依赖单一首选 key；
- 可预测的故障转移与流安全；
- 低热路径开销；
- 防止单个异常账号/provider 拖垮整个池；
- 能够区分有效流量与重试/回退/hedge 放大的可观测性。

在没有生产证据表明更简单的本地设计已不足够之前，不要增加推测性的全局协调、猜测的 provider 限额，或复杂的优化机制。

### Tier 2 — membership/subscription entitlement capacity（订阅权益容量）

Tier 2 面向那些通过运营者自有的会员或订阅权益获得的 AI 容量（Claude Pro/Max、ChatGPT/Codex、Google One AI Premium）。三个主流 provider 均提供内置的订阅适配器，并带有第一方的 OAuth 接入默认值。

Tier 2 只使用运营者本人持有的订阅，仅供运营者个人使用。不得把订阅凭据、由此产生的访问权限或网关访问密钥分享给其他用户（包括家庭成员与团队成员）。需要多人共用时，应使用 Tier 1 或 Tier 3 的容量，而不是 Tier 2。

不要把 Tier 2 变成另一个通用的 API Key 池。除非有实测的生产证据表明需要，它不应引入 Tier 1 的自适应机制。

### Tier 3 — paid API capacity（付费 API 容量）

Tier 3 保留给付费 API 容量，作为最终的受保护兜底层。

不要动用 Tier 3 的容量去弥补本可避免的 Tier 1 不稳定。Tier 3 应保持可预测、有界且易于推理。

## 干净替换策略

ai-gateway maintains one current contract（只维护一套当前的契约）。它不保留已退役的配置名称、旧字段、已被取代的内部契约或历史行为。

当设计发生变化时：

1. 变更规范的实现；
2. 在同一次变更中同步更新 schema、测试、文档、示例与部署配置；
3. 删除被取代的路径；
4. 不得仅为保留已退役的 ai-gateway 行为，而新增别名、双读/双写路径、弃用窗口、兼容开关或垫片（do not add aliases, dual-read/dual-write paths, deprecation windows, compatibility switches, or shims）；
5. 历史应由 Git 历史与 Pull Request 承载，而不是在运行时代码中延续旧行为。

运营者指南可以说明需要做哪些改动，但一项变更被接受之后，运行时不得继续保留已退役的契约。

本规则**不**取消与外部客户端/上游协议（OpenAI Chat/Responses 与 Anthropic Messages）的有意兼容。协议兼容性是当前的产品能力。

## 发布标识规则

项目发布编号仅由人工持有（Project release numbering is human-owned only）。

- 源文件、配置、文档、测试、CI 与运行时端点，都不得包含、生成、推断、同步、递增或校验项目发布编号。
- `package.json` 与 lock 元数据不承载项目发布编号。
- 运行时的部署标识是 Git commit SHA，通过经过认证的 `/health` 暴露，并被部署验证所使用。
- 当需要命名发布时，由人工创建 Git tag 或 GitHub Release（human creates the Git tag or GitHub Release manually）。
- 自动化绝不可代替运营者创建或推进发布编号（Automation must never create or advance release numbering）。

依赖版本号、运行时要求、协议标识符、迁移序号、日期以及其他技术性标识符，不属于项目发布编号，在需要之处仍须明确保留。

## 简洁性规则

每一项新能力都必须能够证明自己对家庭或小型可信团队有价值。

默认决策顺序：

1. Tier 1 的可靠性与持续可用性；
2. 安全性与协议正确性；
3. 运维简单性；
4. 有效利用免费容量；
5. 清晰的 Tier 2 / Tier 3 兜底边界；
6. 仅在已存在具体使用场景时才考虑扩展性。

优先删除而非保留已过时的过渡设计（Prefer deletion over preserving obsolete transitional design）。优先采用一套当前机制，而非新旧并行的机制。优先采用明确的适配器，而非通用插件框架。在没有生产证据要求之前，优先采用本地有界状态，而非分布式协调。

除非先有意调整产品范围，否则本项目不应增加以下能力：

- 公共多租户；
- 为转售而进行的用户计费或计量；
- 企业级组织/RBAC 层级；
- 市场或插件生态；
- 通用工作流/编排平台；
- 推测性的 provider 抽象层；
- 在没有实测需求的情况下进行的集群级配额协调；
- 仅为保留已退役 ai-gateway 行为而存在的兼容层。

## 变更评审规则

每一个架构或功能 PR 都必须依照本策略进行检查。若某项变更增加了复杂度，则必须说明其解决了哪一个具体的家庭/小型团队问题，以及为何更简单的实现无法满足需求。

与本策略冲突的变更，必须先修订本文档；实现不得悄悄地重新定义产品。
