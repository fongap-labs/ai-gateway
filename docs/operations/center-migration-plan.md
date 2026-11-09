# 能力中心迁移计划

## 部署约束

本阶段仅使用现有 Cloudflare 环境。保留生产主网关公共域名和 Action Worker 受控部署；不创建 Oracle 主机、VPC、数据库或费用承诺。现有 `legacy/v0.1.5` 分支用于代码回退，不等同于已验证的生产镜像或配置备份。

Cloudflare Service Binding 仅是**当前传输适配器**，业务执行接口仍保持标准 HTTP 和流。能力中心先在同一个仓库维护，以便复用协议代码及统一审查；可以分别打包和部署。

## 阶段

| 阶段 | 必须完成的工作 | 验收 |
| --- | --- | --- |
| 一：基线 | 固定当前主分支 SHA、记录 Worker CPU/内存/失败率/TTFT、冻结旧版；定义服务契约、失败分类及私有凭据边界 | 不改变生产；中央 CI 通过 |
| 二：推理中心 | 提取 provider、协议转换与响应流处理；独立 Worker 打包，通过私有绑定执行单次尝试 | Chat / Responses / Messages、静态凭据与双向转换契约通过；无认证/数据泄漏 |
| 三：轻量入口 | 网关只做鉴权、模型/节点选择、额度准入及未提交前的恢复；减少 JSON 复制、SSE 全流扫描、同步 D1 写入 | 同一请求的尝试和截止时间不扩大；首次有效输出后无回退 |
| 四：感知与生成 | 将图片理解的重型适配移至感知中心，图像生成与未来视频任务移至生成中心；分别设计同步和异步边界 | AGENT 专用图片权限保持；已受理生成任务不盲重试，缺失接口明确拒绝 |
| 五：收敛 | 删除入口旧实现和无调用者的转换、缓存、OAuth、统计代码；修订 README、运营配置与中央测试包 | 主 Worker 不再引用已迁出的实现；Action Worker 所有门禁和部署验证通过 |
| 六：可迁移性核验 | 在不接入 Oracle 的前提下，用标准 HTTP Mock 代替 Service Binding 完成同一中心契约测试 | 不改客户端 API、不改变模型授权与故障语义即可切换内部传输适配器 |

阶段二、三先完成再拆感知/生成，不为了三种中心同时上线而引入空壳服务。所有能力必须由真实消费路径、合同测试及运维证据支持。

## Operations 独立调度的受控切换

当前 `src/index.ts` 仍组合 Gateway `fetch` 与 Operations `scheduled`，现有 `wrangler.jsonc` 在 Gateway Worker 上保留 `0 3 * * *` Cron；**不得只修改入口而不部署新定时维护单元**，否则可能造成统计维护停摆。

预备源码 `operations/standalone.ts` 已提供只包含 `scheduled` 的独立入口，没有公开 `fetch` 路由，并要求受控 D1 `TOKEN_STATS_DB` 绑定。预备 `wrangler.operations.jsonc` 的 `crons: []` 明确禁用独立 Cron；`npm run check:operations-cutover` 校验“旧 Cron 仍存在、新 Cron 禁止启用、D1 缺失失败关闭、无公网路径”。这些改动**不能证明生产 Operations 已部署**。

生产切换必须另行完成以下原子化验收步骤：

提供无部署动作的离线规划器：准备好由既有受控部署预检生成的 Gateway Wrangler JSON（包含唯一现有 `TOKEN_STATS_DB` D1 绑定），以及仓库的 `wrangler.operations.jsonc` 后，可用以下指令生成六份严格权限的私有 Wrangler 配置：

```bash
node scripts/operations-cutover-config.mjs \
  --gateway ./private-gateway-generated.json \
  --operations ./wrangler.operations.jsonc \
  --outdir ./private-operations-cutover
```

`prepare` 阶段保留 Gateway Cron 并部署关闭 Cron 的 Operations；`detach` 阶段停用 Gateway Cron；`activate` 阶段才启用独立 Operations Cron。所有阶段禁止双 Cron 且使用相同数据库 ID；工具只写本地 `0600` 配置文件，**不部署、不修改 Cloudflare、不读取 Provider Secrets、不批准变更**。输出涉及运行时元数据，必须存储在受保护目录，不提交 GitHub。实际执行顺序、环境密钥、延迟与回滚仍须另外审批。


1. 在受控、隔离环境部署新 Operations Worker，提供与当前 Gateway **同一 D1 数据库**的 `TOKEN_STATS_DB` 绑定；检查实际 D1 schema、保留策略、预算与每次维护执行日志。不要给 Operations 配置任何 Provider Token 或 Gateway 公开域名。
2. 在受控变更窗口核实上一次 Gateway Cron 已终止、没有正在运行的维护事务；准备一份包含 Gateway/Operations 版本、Cron 和 D1 绑定的回滚记录。
3. 先验证独立 Operations 的一次受控维护执行和只读结果；然后撤销 Gateway Cron，并启用新 Worker 的 `0 3 * * *`，在每个变更步骤前后检查**最多一个有效维护触发器**，避免重复保留期删除或遗漏维护。
4. 验证连续两轮统计聚合与旧指标一致、未丢失入库、无重复维护；失败即停止计划并按已记录的**代码+Cron+D1**整体回滚。

没有以上证据，不得把 Operations 标记为已独立部署，也不得删除 Gateway 的旧 `scheduled` 兼容组合。任何 `wrangler.operations.jsonc` 中 Cron 的启用必须经过单独的部署授权和中央 CI；当前 PR 不操作 Cloudflare/D1/Cron。

## 部署顺序

```text
冻结旧版 / 建立指标基线
→ Action Worker 中央合同测试
→ 部署新的私有中心（不开放公网）
→ 验证中心的单次执行与凭据访问
→ 部署轻量入口到受控测试目标
→ 小流量灰度、检验用量与 SSE
→ 中央门禁、main 来源证明、正式切换
→ 删除已无调用的旧执行路径
```

每次发布先部署被调用方，后部署调用方。不能在私有服务尚未就绪时把生产流量指向它。回滚需恢复与旧入口**兼容的中心及配置组合**，不可只回滚网关二进制却留下不兼容的内部合同。

## 质量门禁

- 安全：未授权 key 与模型绝不产生中心调用；客户端伪造的内部头被全部剔除；中心未公开；生产密钥仅位于获准的 Secret。
- 协议：原生与回退的 Chat、Responses、Messages 结构、工具调用、思考和流完成信号与现有合同一致；不支持的语义明确拒绝。
- 稳定：429、401/403、404、503、连接断开、首事件超时、上游返回空流、中心凭据失效和中心不可用均有分离的失败分类，不能跨请求重置预算。
- 用量：上游真实物理消耗与成功交付分开统计；预提交失败、对冲取消和断流不得虚报成功；D1 故障不得改变已鉴权的请求语义。
- 隔离：推理中心故障不得触发感知或生成的无效重试；未配置的中心显式失败，不自动直连 provider 绕开中心和认证。
- 部署：保持最小权限、CI Evidence、PR Governance、Main Write Guard、Action Worker 源可信性，所有密钥缺失直接失败。
- 性能：用生产可观测的基线比较 Worker CPU p50/p95/p99、错误 1102、内存压力、TTFT p95、成功率、每成功请求的上游尝试与成本；没有实测数据不得宣称已经降低了百分之几。

## 回滚

回滚目标必须是已通过发布预检、四 Worker 同源且互相兼容的不可变 SHA 与配置快照。先停住生产流量切换和后续发布，并记录四 Worker 当前及目标 SHA、健康状态、Service Binding、D1 身份、Secret **名称**和 Cron 所有权；不记录 Secret 值。若无法证明目标版本与同一组配置兼容，停止回滚并保持流量隔离，不能猜测版本组合。

执行顺序：

1. 停止放量并隔离 Gateway 流量，禁止新的发布或配置变更。先用只读 Cron 盘点确认 Gateway 与 Operations 当前所有权。若 Operations 有 Cron，使用已单独批准的 `deactivate --plan` 受控撤销它；核对两端读回结果。读回失败、出现未知 schedule 或双 Cron 时立即停止后续恢复，保持维护触发器关闭并人工处置。
2. 在 Gateway 流量仍隔离且两端 Cron 都关闭时，按记录的兼容目标恢复 Inference Center、Generation Center 和 Operations Worker。三者须使用同一目标 SHA；Operations 保持 Cron 关闭、继续绑定原有共享 `TOKEN_STATS_DB`。保留各私有中心自己的 Provider Secret 所有权，不把凭据复制回 Gateway。D1 数据与 schema 不回滚、不清空。
3. 对三个私有 Worker 分别核验线上 `health.build`、内部健康、Service Binding 可达性、D1 绑定身份和 Secret 名称归属。任一项与记录不符就保持 Gateway 流量隔离，停止切换。
4. 恢复与这些私有 Worker 同 SHA、同配置快照的 Gateway；确认两个私有 Service Binding、Tier 1 KV、额度策略和模型映射均与该快照一致，且 Gateway 没有 Provider 凭据。通过健康及 Mock/受控探测后才恢复 Gateway 流量。
5. Cron 最后恢复，并严格使用回滚记录中的唯一所有者。Operations 为所有者时，先 GET 确认 Gateway Cron 为空，再通过独立批准的 `activate --plan` 激活 Operations；Gateway 为所有者时，部署其已批准且含唯一 Cron 的配置，并 GET 确认 Operations Cron 为空。任何时刻最多一个 Cron 所有者。随后观察至少两个预定调度周期，并分别留存 Cloudflare 实际运行日志、D1 聚合结果及无重复维护证据。Cron API 配置读回不代表全球调度传播完成。

停止条件包括：Worker SHA/健康检查不一致、服务绑定或私有访问失效、D1 身份改变、任意 Provider Secret 出现在 Gateway、Cron 读回含糊或重复执行、缺少独立调度运行证据、聚合失败、保留期误删风险或与回滚前基线不一致。遇到任一条件，保持流量隔离；Cron 维持关闭，除非能确认唯一且已运行的所有者；修复并重新完成整套验收后再继续。

下面的简表用于故障当下的决策提示；必须结合上面的完整顺序和已批准的回滚记录执行：

```text
检查核心成功率 / CPU 1102 / 首事件与额度异常
→ 立即停止放量
→ 停止 Gateway 流量并确认单一 Cron 所有权，必要时先关闭 Operations Cron
→ 流量隔离期间恢复三个私有 Worker 到已验证兼容 SHA 和配置
→ 恢复同 SHA 的 Gateway；通过检查后再恢复流量
→ 最后恢复唯一 Cron 所有者，观察两个实际调度周期
```

不得自动创建项目版本号或未经审批直接触发发布；回滚的可信来源是已通过中央门禁的不可变 SHA。D1 迁移不是事务性回滚；遇到 schema 不兼容时应另行制定向前修复，不得通过删除生产数据来配合 Worker 回滚。
