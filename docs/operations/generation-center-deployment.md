# 私有生成中心

## 范围

本次仅迁移**已经存在的同步图片生成**执行链，沿用 `openai-image`、`google-image`、`cloudflare-image` 适配器。生成中心负责上游凭据、供应商参数准备、图片响应转换；网关保留客户端鉴权、模型授权、节点选择、额度和错误恢复决策。视频、长时间异步任务、任务存储与重试去重**尚未实现**，不能以聊天或图片接口冒充视频生成。

`src/generation/generation-center-entry.ts` 是真实可构建的独立 Worker，不暴露公网访问。现在不接入 Oracle，内部只使用 Cloudflare 私有 Service Binding。业务契约是标准 HTTP 请求、响应及流，以便后续迁移。

## 环境与专用密钥

| 名称 | 所在位置 | 用途 |
| --- | --- | --- |
| `AIG_GENERATION_TARGET` | Action Worker 部署变量 | 可选；仅接受 `ai-generation-center`，空值代表尚未切换 |
| `AIG_GENERATION_SERVICE` | 主网关私有 Service Binding | 由部署器生成，目标为 `ai-generation-center` |
| `AIG_GENERATION_AUTH_KEY` | 主网关与生成中心 Secret | 独立高熵内部认证密钥，至少 32 字符，缺失必须失败 |
| `AIG_GENERATION_ACTIVE` | 历史部署标记 | 本批源码不再以此开关决定执行路径；是否有有效中心绑定与密钥由私有执行客户端检查 |
| `AIG_TIER{N}_NODES_XX` | 生成中心 Variables | 选定节点及模型映射，与主网关的受控配置一致 |
| `AIG_TIER{N}_CREDENTIALS_XX` | 生成中心 Secrets | Provider 实际凭据，不从客户端请求或主网关请求头读取 |
| `AIG_MODELS_CONFIG` | 生成中心 Variable | 仅授权的已知逻辑模型目录 |

现有部署变量与密钥名称不在此 PR 中强制更名。Cloudflare 原生绑定继续使用平台结构。**专用 Secret 与服务绑定必须先在中心端配置完成，才能启用主网关切换。**

## 单次执行协议

```http
POST /internal/execute HTTP/1.1
x-aig-contract-version: 1
x-aig-request-id: 12345678-1234-4234-8234-123456789012
x-aig-node-id: configured-image-node
x-aig-model: image-logical-model
x-aig-surface: images_generations
x-aig-deadline-ms: <当前时间之后的 Unix 毫秒>
x-aig-generation-auth: <部署 Secret>
content-type: application/json

{"model":"image-logical-model","prompt":"Draw a diagram","size":"1024x1024"}
```

服务端重新校验中心密钥、版本、节点 ID、模型映射、模态、截止时间、请求大小及图片请求字段。不允许 OAuth 订阅节点冒用图片执行，客户端 `Authorization`、`Cookie` 和 `x-api-key` 不会到达上游。生成中心自行读取 Provider Secret，每次内部请求只执行一次 Provider `fetch`。

响应状态通过私有头 `x-aig-result` 区分：`not-dispatched` 表示中心拒绝且未联系上游，`dispatched` 表示已收到供应商 HTTP 响应，`attempted` 表示上游可能已经开始执行但结果未知。**`attempted` 绝不能重试。** 对明确的 429/404 预生成拒绝，网关才可在既有预算内调度其他节点。其他失败作为终态返回，不泄露上游细节或内部凭据。

有效图片响应在中心被标准化为 OpenAI `images/generations` 的 `data[].b64_json` 结构，网关不再扫描或解码 Base64。原生 OpenAI 图片 JSON 继续流式转发；Google/Cloudflare 使用原本的有界转换上限。元数据保留 `x-aig-generation-normalized` 内部标志，仅由网关消费后剔除。上游真实 Token 用量未知时不推算。

## 离线受控配置准备
## 普通 Chat 客户端的显式绘图工具

普通对话的文字不会被网关自动理解成付费生成请求。客户端明确声明 `generate_image` 函数并使用 `tool_choice` 强制选择它时，**已授权 AGENT 后端**可以经标准 `/v1/chat/completions` 调用生成中心，而不是把生成请求转发给 Max 文本 Provider。示例：

```json
{
  "model": "Max",
  "messages": [{ "role": "user", "content": "Draw a square" }],
  "tools": [{ "type": "function", "function": { "name": "generate_image", "parameters": { "type": "object", "properties": {} } } }],
  "tool_choice": { "type": "function", "function": { "name": "generate_image" } },
  "metadata": { "aig_image_model": "Image-Creator", "aig_image_size": "1024x1024" },
  "stream": false
}
```

若客户端将同一个 `generate_image` 函数声明为唯一工具，指定相同 `metadata.aig_image_model`，并把 `tool_choice` 改为 `"auto"`，Gateway 会先向原文本模型执行一次非流式工具决策：模型返回普通文字时，原样返回文字；模型明确选择唯一的 `generate_image` 函数时，再调用私有 Generation Center 一次。流式 Chat 会在该决策与图片生成结束后合成 SSE；不会把已开始的生成请求重新派发。模型返回多个工具调用或错误参数将直接失败，不自动产生额外费用。此模式仍需要客户端提供工具契约，网关不会从自然语言中猜测是否应该生成图片。

AGENT Key 必须同时被授权调用原 Chat 模型与独立内部图片模型。图片任务由已有 `AIG_GENERATION_SERVICE` 与 `AIG_GENERATION_AUTH_KEY` 执行，不引入新环境变量。Chat 回答的 `content` 是带 Base64 Data URI 的 Markdown 图片；**客户端必须支持 Data URI 图片渲染**。如果客户端不支持此输出格式，仍应直接调用 `/v1/images/generations` 并由客户端显示返回的图片。

网关禁止根据聊天自然语言自动触发付费生成；没有选择工具时普通 Chat 的模型路由不变。工具被选择但调用者不是 AGENT、没有声明函数、没有明确模型、带图片编辑输入、内部中心不可用或 Provider 返回未知结果，均返回明确错误且不盲目重复生成。流式客户端在生成完成后收到合成 Chat SSE，服务端生成本身仍是同步单次提交。

## 离线受控配置准备

新增 `scripts/generation-center-deployment.mjs` 可在受保护的本地/Runner 环境以 `prepare --config PATH --secrets PATH` 方式生成候选 `wrangler` 配置和 Secret 文件，只允许在 `RUNNER_TEMP` 下写入权限为 `0600` 的临时文件；**不执行 Cloudflare 发布，也不上传 Secret**。所需环境包括明确的 `DEPLOY_SOURCE_SHA`、`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、独立高熵 `AIG_GENERATION_AUTH_KEY`、两层图片节点分片、私有凭据分片、模型注册与策略配置。任何 Tier 3、旧会员 OAuth 或非图片 Provider 节点一律拒绝。

当前不存在自动调用该准备器的生产部署脚本，也未给独立生成中心添加部署触发。正式发布必须分别验证 Worker 的无公网访问、Service Binding、实际 Provider Secret、模型映射、小额请求及回滚组合，并获取独立生产批准。

## 验收顺序

```text
Action Worker 执行类型、静态、安全、合同和两个中心 dry-run 构建
→ 先部署私有生成中心（workers_dev=false，无 routes）
→ 配置节点、实际 Provider Secret 与专用内部认证密钥
→ 内部健康和真实小额图片生成验收
→ 受控环境设 AIG_GENERATION_TARGET=ai-generation-center
→ 部署网关并进行限流、故障、额度、成功率与耗时对照
→ 仅在中心绑定及专用 Secret 准备完成后发布 center-only Gateway 源码
```

**源码从本批起无条件使用 Generation Center**：即使缺少 `AIG_GENERATION_ACTIVE`、内部绑定或密钥，网关也不得回退到旧 Provider 直连；未配置中心时返回 503。生产发布前必须先验收中心、Provider 凭据和 Gateway 私有 Service Binding，否则图片生成不可用。本批不修改部署、Secret 或路由流量，运营侧切换仍须经受控灰度与回滚验收。

回滚必须恢复旧构建与对应变量/Secret/绑定组合，先停止放量，再按 Action Worker 中央治理流程执行；恢复旧入口不能仅删除一个孤立 Secret。

## 感知中心与视频

已有 Chat、Responses、Messages 图像输入由独立私有 Perception 入口承接。该入口通过单独的 `AIG_PERCEPTION_SERVICE` 和 `AIG_PERCEPTION_AUTH_KEY` 调用，并复用既有执行器；模型目录必须显式声明 `capabilities.vision: true`，Provider Profile 也必须声明图像输入。OCR、audio 和 video 仍没有专用执行合同。完整源码范围、配置筛选、Secret 所有权与部分失败处理见[Perception Center 部署边界](perception-center-deployment.md)。视频任务仍缺少任务 ID、状态查询、取消和幂等恢复合同，因此不增加视频执行路径。
