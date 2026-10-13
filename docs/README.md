# ai-gateway 文档

本目录描述 ai-gateway 自身的架构、运维与产品策略。Fongap Labs 共用的工程治理维护在 `fongap-labs/action-worker` 中，此处不做复制。

## 文档结构

```text
docs/
├── architecture/     长期有效的系统边界与不变量
├── operations/       当前的配置、部署与故障排查流程
└── governance/       产品边界，以及修改、验证与记录系统的规则
```

历史记录属于 Git、Pull Request 与 commit。当运维者需要命名的版本时，可以使用人工创建的标签或 GitHub Release；项目的版本编号不在源码文档中维护。

## 架构

| 文档 | 职责 |
| --- | --- |
| [overview.md](architecture/overview.md) | 系统边界、请求流、固定的 Tier 角色，以及事实来源的归属 |
| [protocol-model.md](architecture/protocol-model.md) | 原生协议、Chat ↔ Messages 回退、转换保真度、流式边界 |
| [subscription-model.md](architecture/subscription-model.md) | Tier 2 订阅适配器合同、额度提示、专有 wire 协议、fail-closed 的可调度性 |
| [routing-model.md](architecture/routing-model.md) | Tier 路由、Tier 1 P2C、亲和性、热度保护、attempt 与 hedge |
| [reliability-model.md](architecture/reliability-model.md) | 失败分类、冷却、限流恢复、TTFT、熔断行为 |
| [repository-layout.md](architecture/repository-layout.md) | 仓库与模块职责 |
| [module-boundary-audit.md](architecture/module-boundary-audit.md) | 2026-09-16 对模块内聚、重复、边界债务与分阶段重构优先级的源码审计 |
| [calendar-heatmap.md](architecture/calendar-heatmap.md) | 仪表盘日历热力图合同 |

## 运维

| 文档 | 职责 |
| --- | --- |
| [configuration.md](operations/configuration.md) | Node、访问组、模型、策略与运行时配置 |
| [deployment.md](operations/deployment.md) | 从 CI 到生产的流程、D1 迁移、commit SHA 校验、回滚 |
| [troubleshooting.md](operations/troubleshooting.md) | 配置与运行时故障诊断 |
| [provider-discovery.md](operations/provider-discovery.md) | 只读的 Provider 能力观测 |
| [public-model-status.md](operations/public-model-status.md) | 只读的公开状态投影 |
| [github-repository-settings.md](operations/github-repository-settings.md) | 预期的 GitHub 设置与规范的 About 元数据 |

## 治理

| 文档 | 职责 |
| --- | --- |
| [README.md](governance/README.md) | 治理索引与权威模型 |
| [product-policy.md](governance/product-policy.md) | 家庭 / 个人 / 小团队范围、Tier 角色、干净替换、人工持有的发布身份、简化边界 |
| [quality-policy.md](governance/quality-policy.md) | CI、测试、安全、部署身份与生产门禁 |
| [dependency-policy.md](governance/dependency-policy.md) | 依赖与工具链的更新策略 |
| [documentation-policy.md](governance/documentation-policy.md) | 中文人类文档与机器可读文档的分工，以及代码与文档的同步 |

## 权威顺序

产品方向首先由 [product-policy.md](governance/product-policy.md) 约束：实现不得在未经说明的情况下把 ai-gateway 扩展到家庭 / 个人 / 小团队范围之外，也不得重新定义固定的 Tier 1/2/3 角色。

在该产品边界之内，对于当前可执行的行为，冲突按以下顺序裁决：

1. 运行时代码、schema、配置解析器、测试与工作流定义仓库实际做了什么。
2. 当前的规范文档解释这些行为，并且在与之偏离时必须修正。
3. Git 历史、PR 与 commit 解释当前状态是如何形成的。

文档不得虚构运行时中不存在的能力；运行时变更也不得在无声中违背产品策略。

## 入口

- [README.md](../README.md) —— 项目的规范首页（中文）。
- [CONTRIBUTING.md](../CONTRIBUTING.md) —— 贡献流程。
- [SECURITY.md](../SECURITY.md) —— 漏洞报告与密钥处理规则。
