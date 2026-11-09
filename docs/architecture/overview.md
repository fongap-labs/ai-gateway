# 架构概览

AI Gateway 采用小内核、独立能力中心和两层额度调度。Gateway 只负责鉴权、准入、路由、重试、状态与响应交付；真实 Provider 请求由私有 Inference / Generation Center 执行。各中心共享协议契约，不共享运行时密钥。

## 设计目标

- 统一 OpenAI Chat / Responses 与 Anthropic Messages 入口；保持物理上游执行与逻辑尝试、Hedge 及响应交付解耦。
- 能力清晰分层：Gateway（策略）→ Inference / Generation（执行）→ Operations（统计与维护）。
- 遵循失败关闭：旧三层配置、会员 OAuth 节点、过时权限和未迁移的额度预算不得被静默忽略。
- 不将 Provider Token 放入公开 Gateway 的配置解析器、日志或客户端回复。

## Tier 角色

| 层级 | 唯一职责 | 节点选择 |
| --- | --- | --- |
| Tier 1 | 免费 API Key 额度池，优先消费 | P2C、TTFT、软亲和、额度/429 恢复 |
| Tier 2 | API Token 额度池，最终兜底 | 优先级、健康、冷却、请求负载与 LRU |

请求顺序固定为 **Tier 1 → Tier 2**。重试与对冲均服从请求总预算及当前协议、模型资格约束，不允许增加物理请求预算。Tier 2 的凭据来自静态 `AIG_TIER2_CREDENTIALS_*` Secrets，不使用会员登录、OAuth Token、订阅刷新或第三层兼容路由。

## 请求流程

1. 公开 Gateway 验证访问密钥和逻辑模型权限；读取节点元数据与全局模型目录。
2. 先尝试免费 Tier 1，满足超时、配额、冷却和剩余预算约束后才前往 Tier 2。
3. Gateway 通过受保护的 Service Binding 将带版本的执行票据发送给私有中心；中心执行单次物理 Provider 请求。
4. Gateway 负责成功结果、流式 SSE 和失败终态的统一结算。客户端响应开始后禁止透明切换。
5. D1 用量统计与 Analytics Engine 只是观测，不得改变上游请求归属。

## 模块职责

- `apps/gateway`：认证、路由、节点选择、Hedge、限流、预算、错误与成功响应。
- `apps/inference`：凭据绑定、Provider HTTP 请求、矩阵转换和推理响应。
- `apps/generation`：图像能力检查、物理生成与结果归一化。
- `operations/`：持久化统计和定期维护。
- `packages/contracts` 与 `packages/transport`：中立协议契约和传输原语，不持有会员订阅执行路径。
- `src/config`、`src/reliability`：逐步收敛的兼容核心与共享可靠性状态；不通过兼容层恢复 OAuth 实现。

## 当前不变式

- `Tier = 1 | 2`，`TIER_ORDER = [1, 2]`。旧 Tier 3 配置不得静默失效，旧 Tier 2 会员节点不得进入新 API Token 池。
- 所有新节点需显式 `base_url`、模型映射及私有中心静态凭据。账号级 JSON 不得含 Secret 或声明协议/surface。
- `/oauth/*` 固定拒绝；不保留旧会员 Token 存储、刷新、Provider OAuth 配置或隐藏启用开关。
- 对旧订阅配置只做迁移识别和拒绝，不自动清除旧 Cloudflare Secrets 或历史 D1 记录。
- 架构变更只能通过中央 CI、安全、治理和独立应用构建验证进入 `main`，不能为通过测试而放宽门禁。

## 配置权威来源

节点配置来自 `AIG_TIER{1,2}_NODES_XX`，其私有凭据来自 `AIG_TIER{1,2}_CREDENTIALS_XX`。逻辑模型、策略与协议后备来自单一配置加载器；旧 `tier3` 重试预算和对冲目标必须显式迁移。具体请见[两层迁移预检](two-tier-cutover.md)和[配置文档](../operations/configuration.md)。

## 稳定期

保留已有请求预算、Hedge 实际物理调用、429 恢复和流式交付行为，变化仅限 Tier 所有权和订阅执行面退役。中心迁移与生产部署独立验收，实际 Secret/绑定改造不得隐式随合并发生。

## 持久化边界

D1 用量/缓存与历史订阅 SQL 迁移属于不同的数据生命周期。历史迁移文件必须保持不可变以维护数据库重放一致性；不意味着保留会员代理的运行时代码。未来任何清理 SQL 或 Secret 删除均需单独评估、备份及批准。
