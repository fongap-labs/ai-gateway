# ai-gateway 文档

此处只维护当前架构、配置、运维和项目专属规则。共享工程治理见 [Action Worker](https://github.com/fongap-labs/action-worker)。历史变更由 Git 与 Pull Request 保存。

## 架构

- [架构概览](architecture/overview.md)：当前实现与主请求流
- [轻量网关与能力中心](architecture/edge-capability-boundaries.md)：待实施的职责边界与可迁移内部契约
- [路由模型](architecture/routing-model.md)：Tier、亲和、尝试和对冲
- [可靠性模型](architecture/reliability-model.md)：429、配额、冷却与恢复
- [协议模型](architecture/protocol-model.md)：原生请求、转换和流
- [订阅模型](architecture/subscription-model.md)：Tier 2 OAuth 与适配器
- [模块布局](architecture/repository-layout.md)：源码职责和依赖方向
- [模块边界审计](architecture/module-boundary-audit.md)：已落实的模块归属与有意保留的差异
- [推理中心部署](operations/inference-center-deployment.md)：私有服务的执行合同、命名与接入条件
- [仪表盘日历图](architecture/calendar-heatmap.md)：统计口径与展示合同

## 运维

- [配置](operations/configuration.md)、[部署与回滚](operations/deployment.md)、[故障排查](operations/troubleshooting.md)
- [能力中心迁移计划](operations/center-migration-plan.md)：本阶段仅 Cloudflare，Oracle 留作未来选项
- [Provider 发现](operations/provider-discovery.md)、[公开模型状态](operations/public-model-status.md)
- [免费资源预算](operations/free-tier-budget.md)、[GitHub 仓库设置](operations/github-repository-settings.md)

## 治理

- [治理索引](governance/README.md)、[产品策略](governance/product-policy.md)、[质量策略](governance/quality-policy.md)
- [依赖策略](governance/dependency-policy.md)、[文档策略](governance/documentation-policy.md)、[开发策略入口](governance/development-policy.md)

## 事实来源

运行时代码、schema、测试与工作流定义实际行为；上述文档说明当前契约；Git 历史保存演变过程。不要将历史计划或配置默认值复制到多个文档中。

变更记录先写入 `changelog.d/`；普通 PR 不直接改写 `CHANGELOG.md` 的 `[Unreleased]` 段落，发布时再按中央规则归并。

项目入口：[README](../README.md) · [贡献指南](../CONTRIBUTING.md) · [安全策略](../SECURITY.md)。

