# 治理索引

## 1. 共用规则

组织规则只从中央继承。

### ❌ 错误做法 / 反面教材

业务仓库复制通用提交类型。

```text
本仓库独立定义 11 类提交
```

### ✅ 正确做法 / 规范范例

直接引用 Action Worker 权威文件。

```text
fongap-labs/action-worker/docs/01_SHARED_GOVERNANCE.md
fongap-labs/action-worker/docs/04_CHANGELOG_CONVENTIONS.md
```

## 2. 项目规则

网关专属规范只维护一份。

### ❌ 错误做法 / 反面教材

把同一规则写入多个文档。

```text
路由规则 → 产品策略 + 质量策略 + 开发策略（重复）
```

### ✅ 正确做法 / 规范范例

按责任查阅唯一项目文档。

```text
product-policy.md       产品范围、三级容量、人工发布标识
quality-policy.md       协议、可靠性、安全、生产验证
dependency-policy.md    依赖与工具链
documentation-policy.md 文档与变更日志
development-policy.md   现有合同测试使用的入口
```

## 3. 执行证据

实际行为以运行时和测试为准。

### ❌ 错误做法 / 反面教材

仅凭文档声称功能已上线。

```text
修改 README.md → 宣称部署成功
```

### ✅ 正确做法 / 规范范例

先验证合同，再同步说明。

```text
运行时源码 + 配置解析 + 合同测试 + 工作流
                   ↓
               项目治理文档
```

架构见 `docs/architecture/`，运维见 `docs/operations/`；历史证据保存在 Git，不保留多份治理镜像。
