# D1 迁移

本目录负责 ai-gateway token 用量可观测性所涉及的、有序的 schema 变更。

## 生产环境的执行顺序

当配置了 `AIG_USAGE_D1_ID` 时，生产部署路径会在发布新 Worker **之前**应用 D1 迁移：

```text
预检 + 运行时配置校验
        ↓
D1 迁移
        ↓
原子化的 Worker 部署
        ↓
远程验证
        ↓
成功 / 部署后失败时回滚 Worker
```

迁移失败会阻止 Worker 部署。若未配置 D1，则跳过迁移步骤。

Worker 回滚**不会**撤销已经应用的 D1 迁移。因此，新的迁移必须与回滚时可能被恢复的旧版 Worker 保持兼容。

完整的生产执行顺序参见[部署](../docs/operations/deployment.md)。

## 治理

`npm run migrations:check` 负责执行可执行的迁移契约：

1. SQL 迁移文件使用 `NNN_slug.sql` 命名，数字前缀唯一且连续。
2. 已执行的 SQL 文件在其已执行的 SQL 内容上是不可变的。schema 的修正应以新增迁移的方式完成，而不是编辑、删除或重命名既有迁移。仅修改注释（版权头、说明文字）是被允许的，因为它们不会改变已执行的 SQL，也不会使线上 schema 产生偏差。
3. 在适用的情况下，`CREATE TABLE` / `CREATE INDEX` 语句使用 `IF NOT EXISTS`，以保证安全地重复应用仍然可行。
4. 破坏性操作默认被阻止，因为它们可能破坏回滚兼容性。
5. 只有在确认向后兼容之后，才能通过 `scripts/migrations-check.mjs` 中的显式允许列表放行破坏性迁移。

`0007_drop_redundant_usage_indexes.sql` 是当前唯一经过显式允许列表放行的清理迁移：它删除冗余索引，且不改变旧版 Worker 所期望的 schema。

每个新迁移都应保持聚焦且向前兼容。不要依赖 Worker 回滚来恢复数据库 schema。

## 当前 schema 历史

| 迁移 | 变更 |
| --- | --- |
| `0001_token_usage_hourly.sql` | 新增全局的小时级 token 用量聚合 |
| `0002_token_usage_model_hourly.sql` | 新增按模型的小时级聚合，供模型状态与仪表盘读取使用 |
| `0003_token_usage_ttft_histogram.sql` | 新增分桶的 TTFT 直方图存储 |
| `0004_token_usage_totals.sql` | 新增累计 token 用量总计 |
| `0005_token_usage_daily.sql` | 新增用于活动热力图的 UTC+8 每日聚合 |
| `0006_token_usage_weekly.sql` | 新增用于滚动活动视图的 UTC+8 每周聚合 |
| `0007_drop_redundant_usage_indexes.sql` | 删除已被主键索引覆盖的冗余索引 |
| `0008_token_usage_cache_tokens.sql` | 为用量表新增 Anthropic prompt cache 的创建/读取 token 拆分列 |
| `0009_upstream_attempt_usage.sql` | 在已交付响应统计之外，新增物理上游 attempt 用量；历史值以已知的已交付用量作为下限进行初始化 |
| `0010_cache_observation.sql` | 新增与协议无关的上游有效输入以及显式的缓存观测计数器；历史缓存观测覆盖范围被有意不予重建 |
| `0011_subscription_tokens.sql` | 新增 Tier 2 订阅 OAuth 凭据存储（`subscription_tokens`，AES-GCM 加密）以及一次性使用的 PKCE 流程状态（`oauth_flow_states`） |
| `0012_subscription_account_cas.sql` | 新增订阅的 `account_id` 身份列，以及用于 refresh token 轮换的 `refresh_version` compare-and-swap 保护 |
| `0013_subscription_discovered_models.sql` | 新增 `discovered_models` 诊断列，用于接入时由适配器负责的模型发现 |

SQL 文件本身才是 schema 变更的事实来源；本表仅作为索引。

## 校验

运行：

```bash
npm run migrations:check
```

该治理检查由 `action-worker:tests/packs/ai-gateway/deployment-governance-test.mjs` 覆盖，并同时包含在合并校验与部署校验之中。

除非部署机制确实发生了变化，否则不要新增单独的迁移执行器或平行的 schema 历史。
