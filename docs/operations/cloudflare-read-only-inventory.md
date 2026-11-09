# Cloudflare 只读资源盘点

`scripts/cloudflare-live-inventory.mjs` 为 AG #310 提供四 Worker 的在线只读清点。它只报告资源是否存在、配置名称/类型、绑定关系、Cron 和公开暴露计数；报告通过只表示 API 元数据符合已知合同，不代表配置迁移、运行时、全球 Cron 传播或生产切换已验收。

## 权限与运行

使用限定到目标 Workers 的 **Metadata Read-Only** API Token，并在受保护的本地终端设置 `CLOUDFLARE_ACCOUNT_ID` 和 `CLOUDFLARE_API_TOKEN`。为完整枚举公开路由，还需要账号的 **Zone Read** 与各 zone 的 **Workers Routes Read**。Metadata Read-Only 可查看 Workers 元数据与设置，但不能查看脚本内容或 Secret 值；Routes Read 和 Zone Read 也只用于 GET 清点。脚本固定使用 HTTPS `GET`，失败时不输出 Cloudflare 错误正文。

```bash
node scripts/cloudflare-live-inventory.mjs
node scripts/cloudflare-live-inventory.mjs --out ./private/cloudflare-inventory.json
```

报告文件使用独占创建模式写入，不覆盖现有文件。它包含 Secret **名称**、Worker 名称和资源计数，仍应保存在受保护工作区，不要作为公开 PR 附件提交。脚本不会请求 Secrets 列表或单个 Secret 接口：Cloudflare 的 Secret 列表响应字段包含 Secret 值。Secret 名称仅从 Worker 设置中的 Secret binding 元数据收集；报告仅保留 name/type，不保留或输出绑定值。

## 覆盖范围

- Worker Scripts 列表确认四个目标 Worker 是否存在；对每个存在的 Worker 查询最新有效部署、Settings、Schedules 和 Subdomain。
- Worker Scripts 列表本身不使用分页参数；如果响应提示结果数大于返回项数，脚本失败关闭。Zones 按账号过滤并使用官方分页参数获取全部 Zone，再逐 Zone 读取 Worker Routes，避免依赖 Scripts 列表中可选的 routes 字段。Worker Domains 按官方 `result_info` 处理所有分页，Zones 与 Domains 盘点均设有 100 页上限；Deployments 只请求第一页一条记录，以确认当前活动部署。
- Settings 检查 Inference/Generation Service Bindings、Tier 1 KV、`TOKEN_STATS_DB`、遗留 Tier 3/OAuth/会员订阅绑定名，以及 Gateway/Operations 上游凭据分片名；D1/KV 原始资源 ID 只在内存中用于一致性比较，不进入报告。
- Worker Routes 会逐个 Zone 读取，Custom Domains、workers.dev 和 Preview URL 归并成公开暴露计数；Gateway 至少要有一个公开接入路由。Private Inference、Generation 和 Operations 出现公开路由、启用域名、workers.dev 或 Preview URL 时报告阻断。
- Gateway 与 Operations 的 D1 必须分别恰有一个有效 `TOKEN_STATS_DB`，且 ID 相同。Tier 1 KV 必须恰有一个带有效身份的 `TIER1_AFFINITY` binding。
- Gateway 必须分别且唯一绑定 `ai-inference-center` 与 `ai-generation-center`。Cron 阶段仅识别 Gateway 持有旧 Cron 的 `prepare`、双方无 Cron 的 `detach`、Operations 持有 Cron 的 `activate`；双 Cron、未知 Cron 和中心 Cron 均阻断。

## 结果解释

退出码 `0` 表示上述在线**元数据**合同未发现阻断；退出码 `2` 表示盘点失败或存在阻断。JSON 会列出每个 Worker 的部署存在性、活动部署版本数量、绑定名称/类型、Secret 名称、Cron、D1/KV 身份是否有效和路由暴露计数。

报告始终设置 `production_cutover_approved: false`。下列事项仍需独立证据：Secret 值和 Provider 凭据有效性、节点 JSON 中的 OAuth 标记与迁移冲突、四 Worker 同源 Git SHA、真实健康与请求指标、全球 Cron 传播以及回滚演练。Cron 配置 API 的读回不等同于调度已在全球传播。运行时观察窗口、独立运行证据及停止条件必须在生产切换操作手册中单独确认。

离线 Mock 合同由 `npm run check:cloudflare-inventory` 执行；它不连接 Cloudflare，不验证真实账号状态。

接口合同以 Cloudflare 官方文档为准：[Scripts 列表](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/list/)、[Script Settings](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/get/)、[Deployments](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/)、[Schedules](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/schedules/)、[Subdomain](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/methods/get/)、[Zones](https://developers.cloudflare.com/api/resources/zones/methods/list/)、[Worker Routes](https://developers.cloudflare.com/api/resources/workers/subresources/routes/methods/list/)、[Worker Domains](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/list/) 和 [Secrets 列表响应](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/list/)。
