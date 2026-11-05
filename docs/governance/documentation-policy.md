# 文档治理

## 1. 文档语言

人类文档与变更日志必须使用中文。

### ❌ 错误做法 / 反面教材

中英双语标题，变更日志使用英文。

```markdown
## Quick Start（快速开始）
- fix: Improve gateway reliability.
```

### ✅ 正确做法 / 规范范例

中文标题、中文条目，技术标识符保持原文。

```markdown
## 快速开始
- 修复: 修复请求重试时的连接中断。
```

机器读取文件（`AGENTS.md`、`CLAUDE.md`、协议、策略、规则、配置键及代码注释）使用英文。中文文档只保留单一版本，禁止镜像翻译。第三方文件保持原样。

## 2. 文档权威

运行时事实与文档必须一致。

### ❌ 错误做法 / 反面教材

另建发布编号文档或复制可执行默认值。

```text
docs/architecture/latest-routing.md
docs/governance/version-policy.md
```

### ✅ 正确做法 / 规范范例

以实现和测试为事实来源。

```text
src/config/runtime-vars.ts → 运行时默认值
src/reliability/classify.ts → 错误类型
docs/architecture/routing-model.md → 路由设计
```

实际行为以源码、合同、配置及测试为准；文档描述当前规则。历史记录保留在 Git，不为历史实现增加长期兼容说明。发布标识由维护者管理，不由此文件推断版本。

## 3. 文档归属

项目规则只记录网关专属内容。

### ❌ 错误做法 / 反面教材

重复中央命名、提交类型和发布门禁。

```text
本仓库新建一套 PR 分类和合并权限规则
```

### ✅ 正确做法 / 规范范例

中央共用规则只引用，项目事实留本仓库。

```text
中央共用治理 → fongap-labs/action-worker/docs/
产品策略 → docs/governance/product-policy.md
质量策略 → docs/governance/quality-policy.md
依赖策略 → docs/governance/dependency-policy.md
部署操作 → docs/operations/deployment.md
```

业务差异按源代码归属更新：配置见 `docs/operations/configuration.md`；路由见 `docs/architecture/routing-model.md`；可靠性见 `docs/architecture/reliability-model.md`；协议见 `docs/architecture/protocol-model.md`。项目发布编号不得增加本地工程自动化权威。

## 4. 文档检查

行为变更应同步更新文档和验证。

### ❌ 错误做法 / 反面教材

只更新说明，不校验实际接口。

```text
修改路由说明 → 跳过合同测试
```

### ✅ 正确做法 / 规范范例

先执行确定性测试，再核对文字。

```bash
node scripts/docs-check.mjs
node scripts/link-check.mjs
```

文档和测试应在同一合并请求中更新。中央测试位于 `action-worker/tests/packs/ai-gateway/`；文档检查不等于行为正确，仍须核对运行时证据。

## 5. 文件清理

失效文档必须删除，不创建版本副本。

### ❌ 错误做法 / 反面教材

保留无人维护的旧规则和双语镜像。

```text
README_ZH.md
docs/i18n/
docs/architecture/final-routing.md
```

### ✅ 正确做法 / 规范范例

直接修改唯一权威文件。

```text
README.md
docs/architecture/routing-model.md
docs/governance/README.md
```

文件名遵守平台约定；项目自有新增名称遵守中央命名规范。历史修改通过 Git 追溯。

`CHANGELOG.md` 是唯一变更记录来源。禁止 `changelog.d/`；已发布版本小节不得由普通合并请求改写。
