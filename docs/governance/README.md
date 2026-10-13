# 治理

ai-gateway 的共享命名、变更分类、开发、PR 门禁、发布与仓库治理规则，继承自 [Fongap Labs Action Worker](https://github.com/fongap-labs/action-worker/tree/main/docs)。

本目录仅包含 ai-gateway 专有的策略。

## 项目专有的权威文件

| 文档 | 权威范围 |
| --- | --- |
| [product-policy.md](product-policy.md) | 产品范围、Tier 1/2/3 的角色、干净替换、人工持有的发布标识，以及简洁性边界 |
| [quality-policy.md](quality-policy.md) | ai-gateway 专有的 CI、协议、可靠性、安全与生产验证 |
| [dependency-policy.md](dependency-policy.md) | Worker 运行时、GitHub Actions、Wrangler 与依赖更新规则 |
| [documentation-policy.md](documentation-policy.md) | ai-gateway 文档的归属与代码-文档同步规则 |
| [development-policy.md](development-policy.md) | 临时的非权威重定向页，为当前的策略契约测试而保留 |

## 文档分类

| 目录 | 用途 |
| --- | --- |
| `docs/architecture/` | 持久的网关设计边界与运行时不变式 |
| `docs/operations/` | 当前的配置、部署与故障排查流程 |
| `docs/governance/` | ai-gateway 专有的产品与质量规则 |

共享的分支命名、PR 结构、变更日志分类与通用工程规则，属于 Action Worker 的职责范围。

可执行行为仍以运行时代码、schema、配置解析器、测试与工作流为准。项目文档在与之偏离时必须予以修正。
