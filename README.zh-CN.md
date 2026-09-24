<div align="center">

# ai-gateway

**基于 Cloudflare Workers 的高韧性 AI API 网关**

多 Provider 路由 · 多 Key 负载均衡 · 分层故障转移 · OpenAI / Anthropic 兼容

[English](README.md) · [**简体中文**](README.zh-CN.md)

[![CI](https://github.com/fongap-labs/ai-gateway/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/fongap-labs/ai-gateway/actions/workflows/ci.yml)
[![Deploy](https://github.com/fongap-labs/ai-gateway/actions/workflows/deploy.yml/badge.svg?branch=main&event=workflow_run)](https://github.com/fongap-labs/ai-gateway/actions/workflows/deploy.yml)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![License](https://img.shields.io/github/license/fongap-labs/ai-gateway?label=License)

[快速开始](#快速开始) · [架构](docs/architecture/overview.md) · [配置](docs/operations/configuration.md) · [部署](docs/operations/deployment.md)

</div>

<p align="center">
  <a href="https://api.135468.xyz/"><img src="https://api.135468.xyz/readme-status.svg?v=20260918-3" alt="维护者实例实时生产运行数据" width="920"></a>
</p>

## 这是什么

ai-gateway 把分散在不同 AI Provider、API Key、额度和模型别名上的容量，汇聚成 **一个稳定的 API 入口**。

它运行在 Cloudflare Workers 上，适合个人或小型可信团队自托管使用，尤其适合“低成本/免费容量很多，但限流、波动和临时不可用也很多”的场景。

## 为什么需要它

真实的 AI API 资源很零散：Provider 额度不同，同一家可能有多个 Key，模型会 404 / 429 后又恢复，OpenAI 与 Anthropic 接口也不完全一样。免费容量应该优先吃，但 retry / fallback 不能失控。

普通反向代理解决不了这些问题。ai-gateway 在资源池外面补上有界调度和可靠性控制。

## 怎么工作

```text
Client
  ↓
ai-gateway
  ↓
Tier 1  免费 / 近似免费容量
  ↓
Tier 2  会员 / 订阅权益容量
  ↓
Tier 3  付费 API 托底
  ↓
各 Provider 与 Key
```

每个请求共用一套 attempt 和时间预算。原生协议优先；跨协议只支持 **OpenAI Chat Completions ↔ Anthropic Messages**，**OpenAI Responses 保持 Native Only**。

Tier 1 会根据实时可用性、in-flight、TTFT、429 冷却/恢复和 Provider-Model 热度动态分流；模型家族 fallback 也有明确上限。\n\nTier 2 同时支持静态 API-Key 节点和**订阅节点**（`auth: "oauth"`）：运营者自己的 Claude / Codex / Gemini 订阅通过 PKCE 授权接入，Token 以 AES-GCM 加密存储在 D1，调度时自动刷新、按需解析，全程 fail-closed。详见 [Configuration - Tier 2 订阅](docs/operations/configuration.md#tier-2-subscriptions-oauth)。

核心行为：

- **多 Provider / 多 Key 聚合**：客户端只看到一个逻辑入口。\n- **订阅权益接入**：OAuth (PKCE) 授权、Token 加密存储、自动刷新。
- **额度保护**：429 进入恢复机制，模型型 404 只隔离对应映射。
- **流式安全**：真正内容开始输出后，不再透明切换上游。
- **放大可见**：Token、成功请求、TTFT、retry / fallback / hedge 分开统计。
- **默认收紧**：凭据与 Node Config 分离，模型 allowlist 缺失时不给访问权限。

完整规则见 [Architecture](docs/architecture/overview.md)。

## 真实运行

上方状态图来自维护者真实生产实例，不是合成 Benchmark。

项目目前已经进入 **稳定性阶段**：除非真实生产数据证明现有架构有结构性问题，否则不再继续调整架构。后续重点看真实 429、fallback / hedge 放大、D1 写入量和 TTFT。

## 快速开始

要求：Node.js **>=22.18.0**、Cloudflare 账户，以及至少一个上游凭据。

```bash
git clone https://github.com/fongap-labs/ai-gateway.git
cd ai-gateway
npm ci
sh scripts/install.sh
```

Windows：

```powershell
powershell scripts/install.ps1
```

安装脚本会校验配置、读取凭据、部署 Worker，并可验证线上入口。

Config shard 与 Secret shard 彼此独立，按 **Tier + node id** 绑定，不按相同后缀一一对应。访问由 `AIG_ACCESS_KEY_{AIR,PRO,MAX,ULTRA,AGENT}` 与 `AIG_ACCESS_MODELS_{AIR,PRO,MAX,ULTRA,AGENT}` 控制。

Schema 见 [Configuration](docs/operations/configuration.md)，生产部署见 [Deployment](docs/operations/deployment.md)。

## API Surface

| Method | Path | Surface |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions |
| `POST` | `/v1/responses` | OpenAI Responses |
| `POST` | `/v1/messages` | Anthropic Messages |
| `POST` | `/v1/messages/count_tokens` | Anthropic-compatible 本地 Token 计数 |
| `GET` | `/v1/models` | 鉴权后的模型目录 |
| `GET` | `/health` | 鉴权后的健康诊断 |
| `GET` | `/metrics` | 鉴权后的运行时指标 |

## 文档

[Architecture](docs/architecture/overview.md) · [Configuration](docs/operations/configuration.md) · [Deployment](docs/operations/deployment.md) · [Product Policy](docs/governance/product-policy.md) · [Governance](docs/governance/README.md)

英文文档是规范来源；简体中文 README 面向中文读者维护。

## 安全

不要将上游凭据写入 Node Config 或公开日志。详见 [SECURITY.md](SECURITY.md)。

## License

MIT License，详见 [LICENSE](LICENSE)。
