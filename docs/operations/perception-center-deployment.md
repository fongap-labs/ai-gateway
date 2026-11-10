# Perception Center：源码范围与发布边界

本页记录 Issue #350 的源码审计与离线验收范围。四个计算 Worker 是 Gateway、Inference、Perception、Generation；受控统计 Operations 属于同一部署拓扑，因此只读运行盘点共检查五个 Worker。此实现尚未授权或执行 Cloudflare 生产发布、Secret 更新或流量切换。

## 有证据的范围矩阵

| 范围 | 当前源码合同与实现 | Perception 处理 |
| --- | --- | --- |
| Chat Completions | `messages[].content[]` 中的 `image_url`；OpenAI Provider Profile 声明 `imageInput: true` | 当模型目录 `capabilities.vision` 明确为 `true` 且请求含图时，经 Perception 私有绑定执行；纯文本仍走 Inference |
| Responses | `input_image`，包括 `input` 中 message 的 `content[]` 形式；OpenAI Provider Profile 声明 `imageInput: true` | 与现有执行票据、预算和响应合同一同交给 Perception；入口只检查结构，不读取或改写 Base64/URL 内容 |
| Anthropic Messages | `messages[].content[]` 中 `type: "image"`；Anthropic Provider Profile 声明 `imageInput: true` | 与现有 Messages 执行和转换链一同交给 Perception |
| 未明确声明图像输入的 Provider | Generic OpenAI 兼容、Google 和图片生成 Provider 的 `imageInput` 为 `false` | 不发送图像；调度跳过该 Provider。模型未明确声明 vision 时返回 400 |
| OCR | 现有目录包含保留的 `capabilities.ocr` 字段 | 没有专用 OCR endpoint 或 OCR 处理承诺；`ocr` 字段不触发独立路由 |
| Audio / Video | 现有节点和协议执行合同没有被本功能扩展 | 不支持独立 audio/video 路由、转码、任务 ID、异步状态、取消或恢复 |

Provider Profile 与现有 wire surface 定义是执行资格的依据；Unknown Provider 采用保守的 Generic Profile。`capabilities.vision` 是目录显式 opt-in，`modalities` 仍不是路由权威。未知、非图像或无声明请求不得因为名字相似而自动转发到 Perception。

## 私有与密钥边界

- `ai-perception-center` 由 `src/perception/perception-center-entry.ts` 执行，`workers_dev: false`，无 routes、domains、公开健康接口或额外公网入口。
- Gateway 仅使用 `AIG_PERCEPTION_SERVICE` 与独立 `AIG_PERCEPTION_AUTH_KEY` / `x-aig-perception-auth`。Inference 与 Generation 的认证头和 Secret 不可替代它。
- Perception 复用已验证的单次执行票据、Provider 执行、协议转换、流、截止时间、用量和故障分类；中心在 Provider 请求前再次确认模型 vision、Provider 图像合同及实际图片结构。
- 公共 Gateway 继续不加载 `AIG_TIER{1,2}_CREDENTIALS_XX`；中心凭据只属于对应 Cloudflare Worker Secret。`AIG_ACCESS_KEY_<GROUP>` 授权方式不变。
- 图像识别器仅读取固定 JSON 结构字段，不解析、解码或复制大块图片数据。中心不可用时返回明确错误，不绕过中心直连 Provider。

## 唯一发布入口与部分失败

只使用 Action Worker 已有的 `scripts/deploy.sh` 源码部署服务。部署准备 Inference、Perception、Generation 三份相同 SHA 的私有配置后，记录 Gateway 恢复基线，按此顺序发布三个中心；逐一只读核对其内部认证 Secret 和实际所需的 Tier 凭据分片名；再校验 Gateway Secret 名称及三条精确 Service Binding；最后才发布 Gateway 并执行现有精确 SHA 健康检查。

首次 Secret bootstrap 时，新私有 Worker 可以已经创建，但只要任一中心缺少内部认证 Secret 或必要 Provider 分片，流程就必须在 Gateway 发布前失败。由受保护的 `ai-gateway-ops` 操作人员选择对应 Worker，通过既有单项 Secret 管理流程配置缺失项，再用相同已审核源码 SHA 重跑唯一源码部署入口。普通部署只读 Secret 名称，不向 Cloudflare 上传或删除 Secret 值。

多 Worker 发布不是原子事务。失败日志会列出本次尝试过更新的中心和 Gateway 阶段。若 Gateway 尚未发布，原 Gateway 配置仍在，但当前绑定可能已经调用更新后的 Inference、Perception 或 Generation；若 Gateway 发布或回滚发生错误，状态须视为未知。流程不会猜测或调用任意“上一版本”回滚私有中心。运维人员须先通过受保护元数据流程核实每个 Worker 的确切部署身份，再选择已通过 CI 且互相兼容的 SHA 恢复，并验证全部 Worker；在此之前不得重试、切流量或声称整体回滚成功。

## 验收与安全边界

中央 Action Worker 测试包覆盖真实 Gateway 请求、Perception 私有绑定、认证隔离、无绑定失败关闭、文本请求仍走 Inference、无 vision 声明拒绝、Perception 配置过滤、Secret 归属及部署顺序。仓库内的 Wrangler dry-run 仅构建；GET-only 元数据盘点不调用 Secrets API，也不读取 Secret 值。

本任务的 CI/PR 不触碰 Cloudflare。`.github/deploy.json` 保持 `automatic: false`；不更新生产 Secret、不部署 Worker、不更改 Service Binding、不迁移 Provider 凭据、不切换流量、不改 Operations Cron/D1/KV。生产启用需要另行完成 Secret bootstrap、受保护只读盘点、独立运行时验证、兼容回滚计划及部署授权。
