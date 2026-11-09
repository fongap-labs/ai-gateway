# Operations Cron 受控交接

此工具仅服务于 AG 四 Worker 生产切换的独立审批阶段。合并源码或运行 CI 不会自动操作 Cloudflare。

## 前提

1. 冻结并发的 Worker/Cron 管理操作，记录独立上线审批、不可变源码 SHA、回滚负责人及原 Gateway 调度状态。
2. 私有 Inference 和 Generation 已部署并通过实际健康验证；Gateway 与 Operations 的单一 TOKEN_STATS_DB 身份已离线核对，Service Bindings/Secrets 与二层 Token 配置已通过独立预检。
3. 使用 scripts/operations-cutover-config.mjs 生成 prepare、detach、activate 三阶段私有 Wrangler 文件；生成结果须保留在受保护的运行目录。
4. 在严格审批下先发布 prepare-operations.json（仅 crons:[]），随后发布 detach-gateway.json（旧 Gateway Cron 移除，入口为 apps/gateway/index.ts）。必须确认 Gateway 运行及数据存取健康，才能激活 Operations。
5. 为需要执行的阶段准备完整四 Worker 离线拓扑 JSON（交给 scripts/check-private-center-release.mjs 复核）；它不是单独的 Wrangler 文件。文件包含非明文生产元数据，不得提交 Git 或输出日志。

## 只读检查

受保护的操作者环境需具有 CLOUDFLARE_ACCOUNT_ID 与 CLOUDFLARE_API_TOKEN（Workers 脚本读取权限）。执行：

    node scripts/operations-cron-control.mjs inspect

工具使用 Cloudflare Workers Cron Schedules GET 接口，只返回状态：

- prepare：Gateway 唯一 Cron 所有者，Operations 无 Cron
- detach：两个 Worker 均无 Cron，允许进入独立激活审批
- activate：Operations 唯一 Cron 所有者

任何未知触发器或双 Cron 均视为异常并拒绝宣称准备就绪。

## 激活

仅在实际远程状态为 detach、生产审批有效且没有并发 Wrangler/Cron 修改时，受保护的操作流程才能配置：

- DEPLOY_SOURCE_SHA：与已验收离线拓扑完全一致的 40 位 Git SHA
- AIG_OPERATIONS_CRON_APPROVED=activate：该阶段的单独执行批准
- CLOUDFLARE_ACCOUNT_ID 与 CLOUDFLARE_API_TOKEN：仅在受保护环境中注入，不记录明文

然后执行：

    node scripts/operations-cron-control.mjs activate --plan /private/activate-topology.json

工具会先验证四 Worker 离线拓扑的 stage=activate 和同源 SHA，再次 GET 两个 Worker 的实际 Cron，只在 Gateway 已无 Cron、Operations 也未激活时对 Operations 发出受限 PUT，最后再次读取两端。失败时尝试把 Operations Cron 恢复为空，并明确要求人工复核；不暗示 Cloudflare 两 Worker 配置更新具有原子性。

## 撤销与回滚

在批准回滚时，配置 AIG_OPERATIONS_CRON_APPROVED=deactivate，使用 stage=detach 的离线拓扑：

    node scripts/operations-cron-control.mjs deactivate --plan /private/detach-topology.json

工具只删除 Operations 的已知维护 Cron；即使发生两个 Worker 同时持有该 Cron 的事故，也可紧急清除 Operations 所有权。先用只读检查确认 Operations Cron 已关闭，再进行 Gateway 的受控回滚或旧 Cron 恢复。不要反向操作，以免制造双 Cron。

## 边界

- 此工具不会部署 Worker 代码、迁移 D1、修改 Provider Secret、请求明文 Token 或改变 Gateway Cron。
- 不执行命令即不触及 Cloudflare；默认 inspect 是只读的。
- Cloudflare Cron 传播和跨 Worker 修改并非一个事务。激活/撤销期间必须冻结并发变更，并安排人工观察 Cron 事件、数据库维护执行次数与错误率。
- 自动生产部署保持关闭：.github/deploy.json 中 automatic:false。
