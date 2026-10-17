# ai-gateway 部署向导

这是一个基于 Tauri 的桌面应用，用于帮助初学者通过图形化界面一键部署 ai-gateway 到 Cloudflare Workers。

## 功能

- 图形化多步骤向导
- 自动检测前置条件 (Node.js, npm, Git)
- Cloudflare 账号登录向导
- KV 命名空间一键创建
- 上游节点配置（支持常见提供商预设）
- 访问分组与密钥生成
- 配置预览与确认
- 一键部署（包含 wrangler 调用与日志流式输出）
- 部署后健康检查与客户端配置生成

## 构建与运行

### 前置条件

- [Rust](https://www.rust-lang.org/tools/install) (1.85+)
- [Cargo](https://doc.rust-lang.org/cargo/getting-started/installation.html)
- (可选) [Node.js](https://nodejs.org/) 22.18+ 用于实际部署（向导本身不依赖 Node 构建）

### 开发模式

```bash
# 进入 installer 目录
cd installer

# 安装 Tauri CLI（如果尚未安装）
cargo install tauri-cli --version 2.12.1

# 启动开发服务器
cargo tauri dev
```

### 构建发行版

```bash
cargo tauri build
```

构建产物将位于 `src-tauri/target/release/bundle/` 中，包含:
- MSI 安装程序 (Windows)
- NSIS 安装程序 (Windows)
- 其他平台的打包格式（取决于构建目标）

## 使用说明

1. 将本 `installer` 目录放置在 ai-gateway 项目根目录下（即与 `package.json`, `wrangler.jsonc` 同级）。
2. 运行 `cargo tauri dev` 开发或 `cargo tauri build` 构建发行版。
3. 按照向导步骤操作：
   - 步骤 0: 检查环境（Node.js, Git 等）
   - 步骤 1: 登录 Cloudflare 账号
   - 步骤 2: 配置 Worker 基础信息
   - 步骤 3: 添加上游节点（至少需要一个 Tier 1 节点）
   - 步骤 4: 配置访问分组
   - 步骤 5: 检查确认配置
   - 步骤 6: 一键部署（可查看实时日志）
   - 步骤 7: 验证部署并获取客户端配置

## 注意事项

- 向导会在项目根目录创建临时目录 `.installer-tmp/` 存放中间文件，构建/运行后可安全删除。
- 生成的 `wrangler.user.jsonc` 会写入项目根目录（用于实际部署），请勿提交此文件到版本控制。
- 部署成功后，请妥善保管生成的访问密钥，它们只会显示一次（在确认步骤和部署结果中）。
- 向导依赖项目内部的 node 脚本（如 `plan-node-configuration.mjs`）进行配置校验与分片，请确保在 ai-gateway 项目目录中运行。

## 故障排除

### 环境检测失败

- 确认 Node.js 22.18+ 已安装并加入 PATH
- 确认 Git 已安装并加入 PATH
- 确认运行目录即为 ai-gateway 项目的 installer 子目录

### Cloudflare 登录失败

- 确保已在 [cloudflare.com](https://cloudflare.com) 注册账号
- 确保账号有权限管理 Workers 和 KV 命名空间

### 部署失败

- 检查网络连接（需要访问 cloudflare.com 与 npm registry）
- 查看部署日志中的错误信息
- 常见问题：KV 命名空间 ID 不正确、Worker 名称冲突、公网地址格式错误

### 验证步骤失败

- 确认公网地址正确无误且可达
- 确认使用的访问密钥对应已启用的访问分组
- 某些企业网络可能阻止对 *.workers.dev 的访问

## 开发者注释

### 架构

- 前端: 原生 HTML/CSS/JS (ES Modules)，无构建步骤
- 后端: Rust + Tauri 2
- 通议: Tauri IPC (`invoke` / `listen`)
- 部署流程: 
  1. 前端收集表单数据 → 调用 `generate_config`（Rust）
  2. Rust 调用项目内 `scripts/plan-node-configuration.mjs` 生成计划
  3. Rust 构建 `wrangler.user.jsonc` 与部署密钥文件
  4. 前端调用 `deploy`（Rust） → 调用 `scripts/cloudflare-wrangler.mjs` 执行 wrangler deploy
  5. 前端轮询 `/health` 与 `/v1/models` 验证部署

### 文件位置

- `src-tauri/src/lib.rs` - Tauri 入口与基本命令
- `src-tauri/src/config.rs` - 配置生成（调用 node 脚本进行分片）
- `src-tauri/src/orchestrator.rs` - Cloudflare 交互、部署流程、健康检查
- `frontend/` - 静态前端资源（HTML/CSS/JS）
  - `providers.js` - 提供商目录与模型建议
  - `app.js` - 向导状态机与渲染逻辑

### 为什么不使用 npm 构建前端？

为使向导本身「零依赖」，前端采用纯静态资源（HTML/CSS/JS），构建仅依赖 `cargo tauri`。这样用户只需 Rust 环境即可构建向导二进制文件，无需预装 Node.js/npm 用于向导构建（虽然实际部署仍需要 Node.js）。

## 许可证

MIT License - 参见 [LICENSE](../LICENSE)
