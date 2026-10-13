# GitHub 仓库设置

本文档定义**预期的仓库配置**。GitHub Settings/API 才是任一时刻实际生效设置的权威；本文件则是可供评审的目标状态。

## About（仓库简介）

简介应说明运营上的价值，而不是逐一罗列所有受支持的端点。

**Description（描述）**

以下英文描述与 `package.json` 的 `description` 保持一致；它是 GitHub About 中的元数据值，因此保留英文原文：

> AI API gateway on Cloudflare Workers that turns fragmented, failure-prone providers and keys into one stable OpenAI/Anthropic-compatible endpoint — maximizing low-cost capacity through smart routing and tiered failover.

**Topics（主题标签）**

主题标签应兼顾项目身份、生态发现以及高意图的能力搜索。避免把所有可用位置都填满通用的基础设施术语，或近似重复的代理类标签。

标准集合如下（标签为英文标识符，保持原样）：

```text
ai-gateway
anthropic-api
claude-code
cloudflare-workers
llm-gateway
llm-router
load-balancing
multi-provider
openai-api
openai-compatible
rate-limiting
```

该集合保留了 gateway/router 相关术语，因为它们代表不同的搜索习惯；保留 `multi-provider`，是因为 provider 聚合是项目的核心特征。除非项目定位发生变化，否则会省略 `ai`、`llm`、`proxy`、`serverless`、`api-gateway`、`llm-proxy`、`openai-proxy` 与 `llmops` 等宽泛或冗余的术语。

主题标签必须描述已经实现的行为，而不是愿景中的功能。

**Homepage（主页）**

> https://api.135468.xyz/

主页是公开的实时网关仪表盘。它展示模型可用性、流量/Token 活动以及客户端快速开始信息，但不暴露运营者的私有配置。

以上数值即为 About 元数据的规范目标值。当项目定位发生实质性变化时，应同时更新本文档与 GitHub 元数据。

## Main 分支 Ruleset

目标：`main`。

预期控制项：

- 合并前必须提交 Pull Request；
- 必须解决评审讨论串；
- 必须通过 `validate-merge` 状态检查；
- 必须保持线性历史；
- 禁止强制推送；
- 禁止删除分支。

单人项目的评审人数应由实际的 Ruleset 设定，而不应硬编码在治理文字中。质量主要依靠可执行检查与聚焦的评审来保障。

## Pull Request 合并策略

预期的仓库设置：

- 允许 squash 合并；
- 禁用 merge commit；
- 禁用 rebase 合并；
- 在可行的情况下，合并后自动删除分支。

这样可以保证 `main` 上每个 PR 只有一个被接受的 commit，并使稳定 tag 的指向无歧义。

## 必需的检查

| 检查 / 工作流 | 触发时机 | 作用 |
| --- | --- | --- |
| `validate-merge` | PR + push | PR 的必需合并门禁 |
| `validate-deploy` | main 推送、定时/手动 CI | 完整的生产验证；不是 PR 的必需检查 |
| Deploy 工作流 | 在符合条件的 main CI 成功之后，或手动 Deploy 时 | 生产操作；不是 PR 的必需检查 |

不要把 Deploy 配置为合并前的必需检查：它在已被接受的变更进入 `main` 之后才运行。

## Variables 与 Secrets

非敏感的部署标识与运行时配置放在仓库 **Variables**（`vars.*`）中；凭据放在 **Secrets**（`secrets.*`）中。

- `CLOUDFLARE_ACCOUNT_ID` 是 **Variable**（`vars.CLOUDFLARE_ACCOUNT_ID`），不是 Secret；它不得列入 `.github/deploy.secrets.allowed`。
- `CLOUDFLARE_API_TOKEN` 是 **Secret**（`secrets.CLOUDFLARE_API_TOKEN`）。

## GitHub Actions

工作流权限应保持最小化。在可行的情况下，必需的 Action 应固定到不可变的 commit SHA。

生产变更只由部署工作流负责。CI 工作流应保持以读取和校验为主，且绝不能悄悄地在定时/手动的测试运行中执行部署。

## Dependabot

`.github/dependabot.yml` 是依赖更新节奏的权威来源。当前策略为：npm 与 GitHub Actions 每月跟踪一次，安全修复则及时处理。

## 安全报告

应保持 GitHub 私密漏洞报告 / Security Advisories 可用。公开的 Issue 不得包含真实凭据、authorization 头、私有上游 URL、请求体，或应当私下报告的可利用细节。

参见 [SECURITY.md](../../SECURITY.md)。

## Discussions 与 Issue

可以为一般的项目交流保持 Discussions 开启。Issue 应用于可复现的缺陷以及聚焦的功能请求，并优先使用已提供的模板。

## 仓库元数据维护

修改 About 的描述、主题标签或主页时：

1. 更新 GitHub 仓库元数据；
2. 在同一次维护变更中，更新本文档中的规范数据块；
3. 在相关处，保持 `package.json` 的 description/keywords 与公开 README 的术语在语义上一致。

About 元数据属于项目定位，并不能替代架构文档。
