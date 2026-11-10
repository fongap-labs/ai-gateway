# Cloudflare 只读资源盘点

`scripts/cloudflare-live-inventory.mjs` 为 AG #310 提供四 Worker 的在线只读清点。它只报告资源是否存在、配置名称/类型、绑定关系、Cron 和公开暴露计数；报告通过只表示 API 元数据符合已知合同，不代表配置迁移、运行时、全球 Cron 传播或生产切换已验收。

## 权限与运行

使用仅具备读取权限、范围限定到目标 account/zones 的 API Token，并在受保护的本地终端设置 `CLOUDFLARE_ACCOUNT_ID` 和 `CLOUDFLARE_API_TOKEN`。按 Cloudflare 当前 API 权限说明，完整清点需要 **Workers Scripts Read**、**Zone Read** 和 **Workers Routes Read**；仅有 Workers Metadata Read-Only 不足以读取 Worker Domains。脚本固定使用 HTTPS `GET`，不调用 Secret 接口，失败时不输出 Cloudflare 错误正文。

```bash
node scripts/cloudflare-live-inventory.mjs
node scripts/cloudflare-live-inventory.mjs --out ./private/cloudflare-inventory.json
```

报告文件使用独占创建模式写入，不覆盖现有文件。它包含 Secret **名称**、Worker 名称和资源计数，仍应保存在受保护工作区，不要作为公开 PR 附件提交。脚本不会请求 Secrets 列表或单个 Secret 接口：Cloudflare 的 Secret 列表响应字段包含 Secret 值。Secret 名称仅从 Worker 设置中的 Secret binding 元数据收集；报告仅保留 name/type，不保留或输出绑定值。

## 覆盖范围

- Worker Scripts 列表确认四个目标 Worker 是否存在；对每个存在的 Worker 查询最新有效部署、Settings、Schedules 和 Subdomain。
- Worker Scripts 列表本身不使用分页参数；如果响应提示结果数大于返回项数，脚本失败关闭。Zones 按账号过滤并使用官方分页参数获取全部 Zone，再逐 Zone 读取 Worker Routes；Zones 必须返回稳定的 `total_pages` 与 `total_count`，实收总数不符或元数据缺失时失败关闭。Routes 是单页响应，避免依赖 Scripts 列表中可选的 routes 字段；Worker Scripts、Routes 和 Domains 若报告的单页总数与实收结果不一致，也会失败关闭。Worker Domains 使用官方支持的 `service` 过滤器逐 Worker 查询；该接口在官方 SDK 中为单页列表，不发送未文档化的 `page/per_page` 参数，若 `result_info` 报告多页则失败关闭。Deployments 只请求第一页一条记录，以确认官方定义的最新活动部署。
- Settings 检查 Inference/Generation Service Bindings、Tier 1 KV、`TOKEN_STATS_DB`、遗留 Tier 3/OAuth/会员订阅绑定名，以及 Gateway/Operations 上游凭据分片名；D1/KV 原始资源 ID 只在内存中用于一致性比较，不进入报告。重复 binding 名、Secret binding 出现 key material 字段或响应计数不一致都会拒绝生成报告。
- Worker Routes 会逐个 Zone 读取，Custom Domains、workers.dev 和 Preview URL 归并成公开暴露计数；Gateway 至少要有一个公开接入路由。Private Inference、Generation 和 Operations 出现公开路由、启用域名、workers.dev 或 Preview URL 时报告阻断。
- Gateway 与 Operations 的 D1 必须分别恰有一个有效 `TOKEN_STATS_DB`，且 ID 相同。Tier 1 KV 必须恰有一个带有效身份的 `TIER1_AFFINITY` binding。
- Gateway 必须分别且唯一绑定 `ai-inference-center` 与 `ai-generation-center`。Cron 阶段按持有者和数量识别 Gateway 恰有一个 Cron 的 `prepare`、双方无 Cron 的 `detach`、Operations 恰有一个 Cron 的 `activate`；双 Cron、多 Cron 和中心 Cron 均阻断。Cron 表达式作为运行配置原样报告，不与硬编码表达式比较。

## 在线元数据与离线三阶段计划交叉核验

先在受保护终端生成在线清单，再从同一计划的三个 Wrangler 拓扑快照执行离线发布预检。两份报告应只保存在不被 Git 追踪的私有目录，不要上传到公开 PR、Issue 或 CI Artifacts：

```bash
node scripts/cloudflare-live-inventory.mjs --out ./private/cloudflare-inventory.json
node scripts/production-release-preflight.mjs --plan ./private/three-phase-plan.json > ./private/release-preflight.json
node scripts/production-cutover-evidence.mjs \\
  --inventory ./private/cloudflare-inventory.json \\
  --preflight ./private/release-preflight.json \\
  --phase prepare
```

最后一个命令只比较报告，不访问 Cloudflare。它要求：四 Worker 均已部署且活动流量权重有效、私有 Worker 没有公网入口、Gateway 两个 Service Binding 正确、KV 和共享 D1 存在、Tier/OAuth 遗留绑定消失、在线 Cron 所有权与 `prepare` / `detach` / `activate` 阶段完全一致。它还要求离线三阶段计划、不可变源码 SHA 和未验证事项清单完整。离线测试 `npm run check:production-cutover-evidence` 使用模拟报告，不连接生产。

成功输出仅表示**元数据进入受保护的运行时核验阶段**，始终是 `production_deployment_authorized:false`。它不验证报告是否来自真实 Cloudflare、Provider Secret 能否工作、四 Worker 实际构建 SHA、TTFT/429/503、Cron 全球传播或回滚演练；这些必须在独立生产观察和审批流程中完成，不能通过替换 JSON 状态直接获得发布权限。

## 结果解释

退出码 `0` 表示上述在线**元数据**合同未发现阻断；退出码 `2` 表示盘点失败或存在阻断。JSON 会列出每个 Worker 的部署存在性、活动部署版本数量、绑定名称/类型、Secret 名称、Cron、D1/KV 身份是否有效和路由暴露计数。

报告始终设置 `production_cutover_approved: false`。下列事项仍需独立证据：Secret 值和 Provider 凭据有效性、节点 JSON 中的 OAuth 标记与迁移冲突、四 Worker 同源 Git SHA、真实健康与请求指标、全球 Cron 传播以及回滚演练。Cron 配置 API 的读回不等同于调度已在全球传播。运行时观察窗口、独立运行证据及停止条件必须在生产切换操作手册中单独确认。

离线 Mock 合同由 `npm run check:cloudflare-inventory` 执行；它不连接 Cloudflare，不验证真实账号状态。

接口合同以 Cloudflare 官方文档为准：[Scripts 列表](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/list/)、[Script Settings](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/get/)、[Deployments](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/)、[Schedules](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/schedules/)、[Subdomain](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/methods/get/)、[Zones](https://developers.cloudflare.com/api/resources/zones/methods/list/)、[Worker Routes](https://developers.cloudflare.com/api/resources/workers/subresources/routes/methods/list/)、[Worker Domains](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/list/) 和 [Secrets 列表响应](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/list/)。
