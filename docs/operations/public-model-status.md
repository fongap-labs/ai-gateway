# 公共模型状态

公共仪表盘上显示的状态是**只读的服务投影**。它与 isolate 本地的调度状态不是同一回事，绝不能成为路由的输入。

## 两个不同的概念

### 运行时可用性（Runtime Availability）

`src/runtime/availability.ts` 汇总当前 Worker isolate 对候选可用性的了解：Tier 1 的观测/冷却状态，以及 Tier 2/3 的可靠性状态。

Scheduler 与 reliability 逻辑可以使用这些运行时状态。

### 公共模型状态（Public Model Status）

`src/runtime/model-status.ts` 将当前的运行时可用性与持久化的近期成功证据相结合，从而使公共页面不会在 isolate 重启之后，错误地将每个模型都标记为「未观测」。

数据流是单向的：

```text
运行时状态 + D1 可观测性
            ↓
公共模型状态
            ↓
仪表盘 HTML
```

公共模型状态绝不会反馈给 Scheduler、Reliability、Transport、Protocol、Conversion、Hedge、Cooldown 或 Failover。

## 仪表盘展示允许列表

`AIG_DASHBOARD_MODELS` 是一个可选的、非机密的 Worker **文本变量**，用于控制哪些逻辑模型会在公共仪表盘上单独显示。

示例：

```text
AIG_DASHBOARD_MODELS=Code-Ultra,Code-Max,Code-Pro,Ultra,Max,Pro,Air
```

规则：

- 未设置或为空 → 显示完整的公共模型目录；
- 已设置 → 仅在**模型状态**中显示匹配的公共模型；
- 匹配不区分大小写，并会去除首尾空白；
- UI 中保留逻辑模型的官方大小写形式；
- 未知名称会被忽略，绝不会生成虚假的行；
- 重复项会被去除；
- 配置中 CSV 的顺序即为模型状态的显示顺序。

该变量仅影响展示。它**不会**改变 `/v1/models`、模型注册、访问密钥允许列表、路由、模型家族回退、健康判定、D1 采集，或聚合的 Token/请求总量。在**模型使用**面板中，它控制哪些逻辑模型有资格以具名行的形式出现；未在允许列表中的用量会被汇总到「其他」中，而不会从总量中移除。现有的 `AIG_MODELS_CONFIG` 可见性规则会先被应用，因此该允许列表无法重新暴露已被注册配置隐藏的模型。

## 状态

当前的公共状态包含五种状态：

| 状态 | UI 标签 | 含义 |
| --- | --- | --- |
| `available` | 服务可用 | 至少有一条当前路径可用，或者在 24 小时内有成功证据支撑一个新鲜的/未观测的 isolate |
| `fluctuating` | 服务波动 | 所有当前候选都被明确标记为不可用，但该模型在 24 小时内有成功证据 |
| `no_recent` | 无新记录 | 没有当前可用路径，且 24 小时内没有成功记录，但在 7 天的保留历史中存在成功记录 |
| `no_record` | 暂无记录 | 该模型已被配置/公开，但保留的统计窗口中没有任何成功证据 |
| `down` | 服务故障 | 不存在可服务的候选，或所有可服务的候选都被明确标记为不可用，且近期没有成功证据 |

当持久化的近期成功记录证明某个模型一直在提供服务时，一个没有本地 Tier 1 TTFT 样本的冷 isolate，绝不能被错误地判定为全局故障。

## 成功证据

持久化的证据路径复用 `src/observability/token-usage-store.ts` 及其子模块下的 token 用量存储。模型状态投影直接查询现有 D1 聚合中按模型统计的**成功交付请求**证据，而不是另建一套健康数据库。

使用两个时间窗口：

- 近期证据：24 小时；
- 历史证据：7 天的保留窗口（按模型）。

按模型统计的某一行若满足 `requests > 0`，表示该时间桶中至少有一个真实请求被成功交付。上游的重试、回退与 hedge attempt 本身不会产生公共的成功证据。

## TTFT 展示

仪表盘还会为相同的近 24 小时窗口展示模型级 TTFT 聚合：

- `P50` requires at least 5 successful TTFT samples（P50 至少需要 5 个成功的 TTFT 样本）；
- `P95` requires at least 20 successful TTFT samples（P95 至少需要 20 个成功的 TTFT 样本）；
- `samples` is `successful_ttft_count`（即记录了 TTFT 样本的成功交付请求数）。

TTFT 以分桶边界的形式呈现，而不是伪造的精确数值。开放式的最后一个分桶渲染为 `≥10s`。

这些聚合仅属于展示与可观测性数据。它们不会从 D1 反馈到候选评分中，也不会替代 Scheduler 所使用的 Tier 1 isolate 本地被动 TTFT。

## D1 故障行为

作为展示功能，公共状态采用失败即放行（fail-open）的策略：

- 没有 D1 绑定 → 仅使用运行时证据继续；
- D1 读取失败 → 在没有持久化证据的情况下继续；
- 近期证据查询结果为空 → 不得臆造成功；
- TTFT 查询失败 → 保留模型行与状态，并渲染缺失的 TTFT 数值；
- 展示层故障不得破坏请求路由的热路径。

D1 的问题不得自动将所有模型标记为可用或不可用。

## 隐私边界

公共投影只能暴露仪表盘所需的、模型级的聚合服务事实：逻辑模型 id、公共状态、分桶后的 P50/P95、样本数，以及聚合的用量视图。

下列内容不得暴露：

- 节点 id；
- provider/tier/protocol/surface 的内部细节；
- 上游 base URL 或凭据；
- 冷却/失败原因的内部细节；
- 按节点/账号划分的 TTFT 或 scheduler 状态；
- 请求体或用户数据。

公共状态契约的存在是为了服务展示，而不是为了运营者排障。

## 性能边界

近期的模型证据与 TTFT 聚合，以共享的仪表盘查询/缓存输入的形式加载，而非对每个节点/模型各执行一次数据库查询。公共状态始终位于 scheduler 热路径之外。

## 源文件

- `src/runtime/availability.ts`——isolate 本地的可用性投影。
- `src/runtime/model-status.ts`——公共五状态的判定逻辑。
- `src/dashboard/model-status-view.ts`——仪表盘允许列表、P50/P95/样本数的渲染。
- `src/observability/token-usage-store.ts` 与 `src/observability/token-usage-store/`——持久化的成功/TTFT/用量访问。
- 仪表盘相关模块——仅负责展示。

任何未来意在影响路由的状态信号，都应当被设计为独立的可靠性功能，而不能悄悄复用这一公共投影。
