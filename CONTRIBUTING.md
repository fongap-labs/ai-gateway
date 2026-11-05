# 贡献指南

## 1. 变更类型

提交和合并请求标题仅允许三类。

### ❌ 错误做法 / 反面教材

使用其他类型或图标前缀。

```text
docs: update config guide
perf: optimize routing
:sparkles: add endpoint
```

### ✅ 正确做法 / 规范范例

标题用英文，类型固定。

```text
feat: add gateway endpoint
fix: correct retry behavior
chore: update configuration docs
```

破坏性变更使用 `!` 或标准脚注，不增加新类型。权威规则见 [Action Worker 变更规范](https://github.com/fongap-labs/action-worker/blob/main/docs/04_CHANGELOG_CONVENTIONS.md)。

## 2. 中文变更记录

每条记录只描述一项实际变化。

### ❌ 错误做法 / 反面教材

使用英文条目或片段目录。

```text
changelog.d/fix-retry.md
- fix: Improve reliability
```

### ✅ 正确做法 / 规范范例

直接更新中文日志，摘要不超过八十字。

```markdown
## [Unreleased]

- 修复: 修复网关重试期间的连接中断。
```

`feat`、`fix` 必须记录，`chore` 可省略。类别仅允许新增、修复、维护。

## 3. 开发验证

变更必须通过中央测试和部署检查。

### ❌ 错误做法 / 反面教材

跳过回归与部署校验。

```text
修改路由器 → 直接合并
```

### ✅ 正确做法 / 规范范例

安装依赖后执行规定检查。

```bash
npm ci
npm run validate:merge
npm run check:deploy
```

项目测试由 `fongap-labs/action-worker/tests/packs/ai-gateway/` 维护；不得把测试套件搬回 `scripts/`。发布版本由维护者决定，不由配置文件或变更日志自动赋值。

## 4. 合并方式

每个合并请求只处理一个目标。

### ❌ 错误做法 / 反面教材

一个请求混合无关任务。

```text
新路由协议 + 更新页面 + 清理全部配置
```

### ✅ 正确做法 / 规范范例

按三类创建聚焦分支，经中央门禁合并。

```text
feat/routing-update
fix/retry-timeout
chore/docs-cleanup
```

运行时、协议、配置、部署变化必须同步修改项目权威文档；禁止无意改变路由、降级和安全边界。

## 5. 安全边界

禁止公开敏感信息。

### ❌ 错误做法 / 反面教材

在日志或合并请求公开凭据。

```text
Authorization: Bearer actual-secret
```

### ✅ 正确做法 / 规范范例

脱敏后提交证据，漏洞私下报告。

```text
Authorization: Bearer [REDACTED]
```

披露流程见 [安全策略](SECURITY.md)；产品规范见 [治理索引](docs/governance/README.md)。
