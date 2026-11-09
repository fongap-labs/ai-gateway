# 两层 Tier：生产切换准备与验收

本页对应 [AG #310](https://github.com/fongap-labs/ai-gateway/issues/310)。**源码阶段已完成**：两层运行时 [#312](https://github.com/fongap-labs/ai-gateway/pull/312) 于 2026-11-09 合并到 `main`（`56adb64e16c3f436094280975d62af7e3ce9fbe0`）；中央受控测试包固定于 Action Worker `f0501774a1049fa75088b161fd895a7930fba4c3`。这不代表生产配置或部署已经切换。

**严禁以“源码已合并”作为生产放行依据**。仓库的 `.github/deploy.json` 仍配置 `automatic: true`。2026-11-09 核查发现由该主分支提交触发的 [Action Worker 部署请求 #42612960426](https://github.com/fongap-labs/action-worker/actions/runs/42612960426)，其 `Execute source-script deploy` 当时为 `waiting`，目标环境 `production`。部署执行状态必须重新核实；**在以下所有门禁通过及独立批准前，不得批准等待中的生产部署作业**。本文件和下述工具不会调用 Cloudflare 或修改生产环境。

## 目标与数据边界

| 原容量 | 新容量 | 迁移动作 |
| --- | --- | --- |
| Tier 1 免费静态 Key | Tier 1 | 保留节点、路由与免费配额/429 恢复 |
| 旧 Tier 2 静态 Key/Token | Tier 2 | 保留仍具合法授权的静态节点 |
| 旧 Tier 2 会员 OAuth | 无 | 从执行配置退役，不恢复授权/刷新/订阅 Adapter |
| 旧 Tier 3 静态付费 Token | Tier 2 | 明确迁移节点及对应私有 Secret 分片 |

旧 `AIG_TIER3_*`、`AIG_OAUTH_*`、`AIG_IS_SUBSCRIPTION_ENABLED`、`AIG_TOKEN_ENCRYPTION_KEY` 在新运行时中是**失败关闭**的遗留绑定；不允许借用隐式兼容层继续使用。当前节点与凭据分片仅接受 `AIG_TIER{1,2}_NODES_01..10` 和私有中心的 `AIG_TIER{1,2}_CREDENTIALS_01..10`。

旧 D1 迁移历史必须保留，且不得未经独立授权清空旧 OAuth Token 数据或删除任何 Cloudflare Secret。**公开 Gateway 只保存不含凭据的节点元数据；真实 Provider Token 只由受控私有执行中心持有。** 云端同一 Token 是否在不同节点重复使用，无法通过仅包含节点 ID 的清单确认。

## 第一道门禁：历史配置只读预检

运营者在受控环境中分别导出*旧版* Tier 1/2/3 节点 JSON 数组，旧 `AIG_POLICIES_CONFIG` 对象（没有时也必须显式提供 `{}`），以及三个旧凭据分片的**节点 ID 索引**。不要导出或粘贴 Secret 值、OAuth Token、客户端密钥或上游授权头。

凭据索引示例（数组内仅为占位 ID）：

```json
{
  "tier1": ["free-01"],
  "tier2": ["static-02"],
  "tier3": ["paid-03"]
}
```

```bash
npm run config:cutover:plan -- \
  --tier1 ./old-tier1.json \
  --tier2 ./old-tier2.json \
  --tier3 ./old-tier3.json \
  --credential-index ./credential-ids.json \
  --policies ./old-policies.json
```

`scripts/tier-cutover-plan.mjs` 只读运行，产生脱敏的 `node_moves`、`retired_oauth_nodes`、`policy_reviews`、`blockers`。退出码 2 表示存在阻断；即使 `preflight_passed=true`，也只代表**结构及凭据节点 ID 归属**可迁移，**不是部署批准**。必须逐项解决重复 ID、静态凭据缺失、会员节点混入、跨 Tier 凭据、`tier_attempts.tier2/tier3` 和 `hedge.tiers` 的预算冲突；不得自动把旧预算相加。

用 `npm run check:cutover-plan` 和 `npm run check:two-tier-runtime` 复核本地只读迁移合同。不要把清单、任何真实上游 URL 或生产节点元数据作为公开 issue / PR 附件。

## 第二道门禁：目标生产资源核对

在**只读、已授权**的运营通道核对以下内容并将结果以“通过/阻断/未知”记录在私有变更单；本聊天及公开 GitHub PR 不接受生产凭据值：

1. **部署控制**：重新确认 [自动部署请求 #42612960426](https://github.com/fongap-labs/action-worker/actions/runs/42612960426) 及所有同一提交的部署是否仍等待、已经失败或已经执行；未获得上线审批时不得批准 `production` Environment。必要时由授权维护者设置 `AIG_IS_DEPLOY_ENABLED=false` 或运用现有环境保护规则进行管控，操作本身需单独记录和确认。
2. **完整旧版库存**：核实三个旧 Tier 的所有节点、模型允许列表、优先级、额度、凭据 ID 及真实上游授权是否仍有效。旧 Tier 2 中 OAuth 节点应明确退役；旧 Tier 2 静态 Token 与旧 Tier 3 静态 Token 目标汇总后不得出现节点 ID 冲突。
3. **私有执行中心**：分别确认 Inference 和 Generation 的 Worker 名称、未公开状态、Service Bindings、内部认证密钥、Provider Secret **名称及来源**，以及新 Tier 2 分片的实际绑定。不要仅迁移公开 Gateway 的节点列表后就批准发布。
4. **身份和状态资源**：确认访问组 Secret 名称、健康检查密钥、KV、D1 和分析资源 ID；备份实际运行的 Worker 版本、当前非敏感配置、Service Binding 清单和回滚所需的兼容 Secret **名称**。真实值只在受保护的密钥管理通道中备份。
5. **缓存隔离**：如计划继续使用边缘缓存，需单独准备至少 32 字符的 `AIG_EDGE_CACHE_HMAC_KEY` Cloudflare Secret，并验证只在 Secret 存储、不暴露到 GitHub Variables 或公开 Gateway 响应；缺失时缓存应安全关闭，普通推理不受影响。不允许复用旧会员加密密钥。
6. **策略和额度**：确认两层版本的重试上限、Hedge、路由回退、速率限制和付费预算；新 Tier 2 是最后一道兜底，不允许静默产生第三层。验证新目标配置对所有遗留 `TIER3`/会员绑定严格拒绝。
7. **回滚配套**：必须具有先后相容的 Gateway、Inference、Generation 版本与变量/Secret/Service Binding 组合。回滚 Worker 代码不会自动恢复已删 Secret 或 D1 数据；缺乏经过验证的回滚组合应停止切换。

**任何一项状态为未知或阻断，就不能将部署视为已通过门禁。** 仅从 GitHub 源码或 Secret 名称清单无法证明生产 Token 值正确、中心可执行或费用预算充足。

## 第三道门禁：分阶段受控验收

1. 在独立隔离的验证环境准备新 Tier 2 的静态 Token 分片和新旧策略对应表；先对私有中心执行身份、模型映射、Chat/Responses/图片、小额调用、429、超时、限流与 Secret 隔离验证，再验证 Gateway。
2. 预先记录稳定版本和部署回滚执行人。变更窗口内协调业务流量、两个中心的部署顺序以及兼容的 Gateway 版本；不要把新旧 Tier 结构不兼容的组件混接。
3. 由单独明确授权的维护者批准生产发布。发布前再次查看排队中的自动部署作业、核对 SHA 和资源库存；部署时优先使用中央受控路径及原有 CI Evidence / Main Write Guard / GitHub Environment 门禁。
4. 发布后核对 `/health` 的准确构建 SHA、全部授权组、Tier 1→Tier 2 路由、付费成本上限、响应兼容性、流式输出和隔离指标。指标异常立即停止流量升级并按**已验证的版本+配置组合**回退。
5. 历史变量、旧 OAuth Secrets、旧 D1 数据的最终清理只能另开受控变更；先证明备份与回滚不再依赖，再逐项移除。不能因部署成功就自动清理。

## 独立批准边界

`main` 源码、自动部署请求存在与否、只读预检通过及中央 CI 成功，**均不等于生产切换授权**。本次准备工作只可修改文档或新增无副作用的离线验证工具；不得自动执行 Cloudflare Secret 写入/删除、D1 数据操作、Service Binding 切换、GitHub Environment 审批、手动部署或批准等待中的自动部署。
