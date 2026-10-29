# Docker 部署

本文描述 `cloud-host-docker` 部署通道：在云主机上以 Docker 容器运行 ai-gateway。容器内运行的是与 Cloudflare Worker 相同的 `fetch` 处理函数，入口为 [`docker/server.mjs`](../../docker/server.mjs)。协议、流式、调度与冷却契约在两个通道上一致；差异只在于 Workers 专属绑定缺失时的功能降级（见下文）。两个通道的可信源都是 `main`，通道划分见[产品策略](../governance/product-policy.md)。

## 前置条件

- Docker Engine 与 Docker Compose v2。
- 一台可以访问上游 provider 的云主机。
- 一个 TLS 反向代理（如 Caddy 或 Nginx）用于对外提供 HTTPS。容器只监听 `127.0.0.1:8787`，不直接暴露公网。

## 1. 准备配置

在仓库根目录创建 `.env`（已被 git 忽略）。变量名与 Worker 部署相同，参见[配置](configuration.md)。

```bash
cp .dev.vars.example .env
```

Compose 的 `env_file` 每行一个 `KEY=VALUE`，因此 JSON 类变量（如 `AIG_TIER1_NODES_01`）必须写成**单行**，不能像 `.dev.vars.example` 那样跨行书写。

最少需要的变量：

- 至少一组 `AIG_ACCESS_KEY_<GROUP>` 与 `AIG_ACCESS_MODELS_<GROUP>`；
- 至少一个 `AIG_TIER{1,2,3}_NODES_XX` 分片，以及对应的 `AIG_TIER{N}_CREDENTIALS_XX`；
- 访问 `http://` 上游时需要 `AIG_CAN_USE_HTTP=true`（生产环境应只使用 `https://` 上游）。

## 2. 构建并启动

```bash
AIG_BUILD_SHA="$(git rev-parse HEAD)" docker compose up -d --build
```

`AIG_BUILD_SHA` 会写入镜像，经认证的 `/health` 会返回它，用于确认运行的是哪个提交。

查看状态与日志：

```bash
docker compose ps
docker compose logs -f ai-gateway
```

## 3. 验证

```bash
curl -H "Authorization: Bearer <GROUP_KEY>" http://127.0.0.1:8787/health
```

- `200`：配置有效，检查 `build`、`status`、`nodes_usable`。
- `401` / `403`：密钥不对或分组无权限，但服务已可达。
- `503`：配置无效，按响应中的 `diagnostics` 修正 `.env`。

容器的 HEALTHCHECK 只判断进程是否可达（HTTP 状态码小于 500），不判断配置是否完整。

## 4. 反向代理

反向代理负责 TLS 与公网入口，把请求转发到 `127.0.0.1:8787`。流式响应需要关闭代理侧的响应缓冲，否则客户端会等待整段回复。

Nginx 示例（需要关闭缓冲）：

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_buffering off;
    proxy_read_timeout 900s;
    proxy_set_header Host $host;
}
```

## 5. 升级与回滚

升级：拉取新提交后重新构建。

```bash
git pull --ff-only
AIG_BUILD_SHA="$(git rev-parse HEAD)" docker compose up -d --build
```

回滚：检出上一个已知良好的提交，用同样的命令重新构建启动。

```bash
git checkout <known-good-sha>
AIG_BUILD_SHA="$(git rev-parse HEAD)" docker compose up -d --build
```

容器不做自动回滚。升级后请重新执行第 3 步的 `/health` 检查。

## 6. 停止

```bash
docker compose down
```

容器收到 `SIGTERM` 后停止接收新连接，并最多等待 10 秒让进行中的请求结束。

## 容器与 Cloudflare Worker 的差异

Workers 专属绑定在容器中不存在。代码对这些绑定都是 fail-open 设计，因此服务仍可运行，但下列能力会降级：

| 能力 | Cloudflare Worker | Docker 容器 |
| --- | --- | --- |
| 协议转换、流式、路由、冷却 | 有 | 有（同一份代码） |
| 用量统计 D1（`TOKEN_STATS_DB`）与 `/metrics` 持久化 | 有 | 无；`/metrics` 只反映当前进程内存 |
| 会话亲和 KV（`TIER1_AFFINITY`） | 有 | 无；亲和退化为纯评分比较 |
| Tier 1 长时间冷却的跨实例共享 | 有 | 无；只在本进程内生效 |
| edge cache（Cache API） | 可配置 | 无 |
| 定时用量维护（cron） | 有 | 无 |
| Tier 2 订阅 OAuth 接入与 token 存储 | 有（依赖 D1） | **不可用**，`/oauth/*` 无法完成授权 |

因此，容器形态适合以静态 Tier 1 / Tier 3 凭据运行网关。需要 Tier 2 订阅接入时，目前只能在 Cloudflare Worker 上完成。

单进程内存状态意味着：容器重启后冷却与熔断状态会清零；如果运行多个容器副本，它们之间不共享这些状态。当前设计是单机单容器部署。

## 不在本文范围

- Cloudflare Worker 的部署流程见[部署](deployment.md)。
- 配置变量的语义见[配置](configuration.md)。
- 异常排查见[故障排查](troubleshooting.md)。
