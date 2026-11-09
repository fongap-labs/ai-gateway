# 两层 Tier 配置迁移预检

本文件对应 [#310](https://github.com/fongap-labs/ai-gateway/issues/310)。历史 PR #311 提供旧三层只读预检；后续两层运行时 PR 负责类型、配置及调度切换。**在该运行时 PR 完成中央合同验收并合并前，main 仍按三层运行**。任何阶段均不自动迁移生产凭据或部署。

## 目标映射

| 旧配置 | 目标 | 处理 |
| --- | --- | --- |
| Tier 1 静态 API Key | Tier 1 | 保留免费池与现有 429/配额保护 |
| Tier 2 静态 API Key / Token | Tier 2 | 保留并入新的 Token 池 |
| Tier 2 OAuth 会员节点 | 不进入新路由 | 退役会员权益节点，不删除任何现有 Token、D1 数据或 Secret |
| Tier 3 静态 API Key / Token | Tier 2 | 升级为最终兜底池 |

## 安全的本地预检

请在本地准备旧配置的三个 JSON 数组（即使某层为空也需要提供空数组），及实际使用的 AIG_POLICIES_CONFIG JSON 对象；没有自定义策略时提供空对象。凭据索引只使用非敏感节点 ID，不接受真实 Secret 值：

~~~json
{
  "tier1": ["free-01"],
  "tier2": ["token-02"],
  "tier3": ["paid-03"]
}
~~~

其中三个数组分别表示现有 AIG_TIER1_CREDENTIALS_*、AIG_TIER2_CREDENTIALS_*、AIG_TIER3_CREDENTIALS_* 绑定的节点 ID。不要将实际 Secret 值、OAuth 令牌或 Cloudflare 凭据放进这个索引。

~~~bash
npm run config:cutover:plan -- \
  --tier1 ./old-tier1.json \
  --tier2 ./old-tier2.json \
  --tier3 ./old-tier3.json \
  --credential-index ./credential-ids.json \
  --policies ./old-policies.json
~~~

输出是脱敏 JSON，含 node_moves、retired_oauth_nodes、policy_reviews、blockers 和 preflight_passed。工具不会生成包含凭据的新文件；如有阻断项，退出码为 2。即使 preflight_passed=true，它也只表示**结构预检**通过，并不意味着可直接部署：真实 Secret 值的有效性、跨节点共享同一 Token 的情况和 Cloudflare 资源配置不在本工具可验证范围内。

npm run check:cutover-plan 在中央校验中验证预检工具的脱敏、节点映射、重复 ID、静态凭据来源、OAuth 与重试策略冲突等行为；这是对原有门禁的补充，不替代中央测试包。

## 切换前的硬条件

1. 先在新配置中合并旧 Tier 2 的静态节点与旧 Tier 3，保持 ID 不冲突；删除 OAuth 节点的路由定义，不要自动删除已有机密或数据库记录。
2. 在私有 Inference/Generation 中按新 Tier 2 重新配置凭据分片，核对每个节点的来源、额度及授权。不得直接把旧 Tier 3 节点改名后忘记迁移其凭据。
3. 为 tier_attempts.tier2、tier_attempts.tier3 和 hedge.tiers 作明确的预算选择。**不能**把两个原层级的预算简单相加，更不能静默丢弃旧 Tier 3 的预算或容量。
4. 下一批源码 PR 必须同时更新两层类型、运行时、配置校验、CLI、仪表盘及中央 Action Worker 测试合同，拒绝残余旧 Tier 3 配置，避免隐式降级。
5. 全量 CI、安全审查、中央治理门禁和四应用独立构建通过后，才能合并完成两层运行时改造。Cloudflare 现有部署、KV、D1、Secrets 和 Service Bindings 的切换属于后续单独审批的受控步骤。

本工具不读取完整 Secrets，也不提供自动删除旧配置的捷径；保留这一限制是为了防止一次迁移损失现有付费额度。
