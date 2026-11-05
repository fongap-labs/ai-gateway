# 推理中心部署边界

## 当前状态

本阶段增加可独立编译的 `ai-inference-center` 私有 Worker。它已有**单节点、单次尝试、原生协议**的执行入口，但**尚未接入主网关，未部署生产，也不支持跨协议转换调用**。现有 `main` 网关仍按照原逻辑直接访问上游。先通过中央合同验证，再切换生产调用方。

`legacy/v0.1.5` 分支不修改。

## 环境与命名

| 环境名称 | 类型 | 责任 |
| --- | --- | --- |
| `AIG_INFERENCE_SERVICE` | Service Binding | 主网关私有地调用 `ai-inference-center` |
| `AIG_INFERENCE_AUTH_KEY` | Secret | 网关与推理中心共同持有的高熵内部认证密钥（至少 32 字符），缺失直接拒绝 |
| `AIG_TIER{N}_NODES_XX` | Variables | 推理中心使用与网关同一份经部署验证的节点配置 |
| `AIG_TIER{N}_CREDENTIALS_XX` | Secrets | 上游静态凭据由中心读取；后续迁移时从入口移除 |
| `AIG_MODELS_CONFIG` | Variable | 与网关保持一致的已授权逻辑模型目录 |
| `AIG_TOKEN_ENCRYPTION_KEY` | Secret | Tier 2 订阅令牌加解密所需；缺失不得使用 OAuth |
| `TOKEN_STATS_DB` | D1 Binding | 订阅 Token 状态所需，名称保持已部署数据库绑定的原样 |

新增自有配置遵循三至四段命名规范。已有 `AIG_TIER*` 分片、`AIG_ACCESS_KEY_<GROUP>` 和平台标准绑定不在此 PR 中强行更名；密钥迁移应当先审查引用、生产环境和值的所有权，绝不将变量重命名等同于密钥复制。

**密钥只配置在受控部署环境，不放在 Git、示例 JSON、PR 日志或普通 Variables 中。** `AIG_INFERENCE_AUTH_KEY` 必须由加密安全随机源生成，不能使用示例字面值。

## 私有入口

```http
POST /internal/execute HTTP/1.1
x-aig-contract-version: 1
x-aig-request-id: 2bcd92b1-5c79-45aa-8423-d98c359ca856
x-aig-node-id: configured-node-id
x-aig-model: configured-logical-model
x-aig-surface: chat_completions
x-aig-deadline-ms: <current-future-unix-milliseconds>
x-aig-inference-auth: <internal-secret>
content-type: application/json

{"model":"configured-logical-model","messages":[{"role":"user","content":"test"}],"stream":true}
```

演示中的 `x-aig-deadline-ms` 是占位符，调用时必须为未来 10 分钟以内的真实 Unix 毫秒时间戳；此示例不得当成可直接复制的生产请求。

- 入口必须由 **Cloudflare Service Binding** 调用，目标 Worker 设置 `workers_dev:false`，不得配置公网 routes。
- 服务端先验证内部 Key，再验证协议版本、节点 ID、模型、截止时间、请求大小和 surface；不匹配拒绝，且不发出上游请求。
- 入站 `Authorization`、`Cookie`、`x-api-key` 和不在白名单内的头不进入上游。服务端从 Secret 及受控 OAuth 存储读取真实凭据。
- 原生 Chat、Responses、Messages 的非专有成功流直接返回 ReadableStream；Google 订阅私有线协议转换为对应的原生回复后返回。
- 中心不跨节点、不进行模型回退或 hedge。网关必须保留全局请求预算和首事件提交边界。
- 中心只保留 `content-type`、`retry-after` 与受控内部诊断头；调用方在对客户端返回数据前，必须按客户端协议重新整形失败和过滤内部诊断。
- 当前最大请求体为 2 MiB；超过限制返回 413，不会自动绕开中心去使用旧路径。
- 当前只接受节点原生 surface；跨协议矩阵迁移、完整流首事件验证及物理用量回传列入后续执行步骤，未完成前不可进行正式切换。

## 构建与验证

```bash
npm ci
npm run typecheck
npm run check:inference
npm run validate:merge
```

`check:inference` 是仅生成构建产物的 Wrangler dry-run，**不是部署**。生产环境只能经 Action Worker 受控部署。中央测试包后续增加：内部密钥缺失/伪造、未知节点、未授权模型、过期截止时间、OAuth 异常、上游流式透传、错误头剔除及网络失败分类。

## 后续切换

```text
中央合同测试通过
→ 对中心配置 Secret、节点和必要的 D1 绑定
→ Action Worker 先部署私有中心并验证
→ 主网关配置 AIG_INFERENCE_SERVICE 与内部认证密钥
→ 按独立执行节点与完整协议契约切换数据面
→ 移除主网关上游凭据、OAuth 和大体积转换代码
→ 经过对照验收再删除旧路径
```

未满足全部条件前不得在主网关中安装可动态切换的双运行路径，也不准自动降级为直接连接 Provider。
