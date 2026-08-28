# 智慧课评系统（Cloudflare 版）

基于 **Cloudflare Pages + D1 + Durable Objects** 的课评管理系统。支持多设备实时同步、本地离线优先（IndexedDB）、一键课评生成。

> 生产地址：`https://keping.whatis.dpdns.org/`

---

## 一、架构概览

| 层 | 技术 | 说明 |
|---|---|---|
| 前端 | 单文件 `public/index.html`（原生 JS） | IndexedDB 本地优先；WebSocket 接收实时广播后拉取最新；30s 轮询兜底 |
| 后端 API | `functions/api/[[catchall]].js`（Pages Functions） | classes/students/records 的 GET/POST/DELETE，写入 D1 后广播变更 |
| 实时中枢 | `sync-hub-worker/`（独立 Worker + Durable Object `SyncHub`） | 维护在线设备 WebSocket，写入后向同房间设备广播 `changed` |
| 数据库 | Cloudflare D1（`review-db`） | 三张表：classes / students / records |

数据流：某设备写入 → Pages Functions 写 D1 → `await` 广播到 SyncHub DO → 其它在线设备 WS 收到 `changed` → 立即 `syncNow()` 拉取最新。离线/退出场景靠 IndexedDB 本地优先 + 1.5s 防抖推送 + keepalive 退出兜底 + 下次打开补推，数据不丢。

---

## 二、本地开发 / 手动部署

```bash
# 部署前端 + Functions 到 Pages
wrangler pages deploy public --project-name review-system

# 部署实时同步 Worker（含 /api/sync/* 路由）
cd sync-hub-worker && wrangler deploy

# 端到端实时同步回归测试（需 node 18+）
node rt_test.js
```

> 部署依赖 Cloudflare 凭证。本仓库的 `wrangler.toml` 已绑定 D1 与 SyncHub Worker，无需额外配置。

---

## 三、GitHub 推送即部署（自动）

仓库已配置 `.github/workflows/deploy.yml`：**推送到 `main` 分支即自动部署 Worker + Pages**。

### 1. 在 GitHub 新建空仓库（不要勾选 README/.gitignore）
例如仓库名 `review-system`。

### 2. 本地推送（首次需 GitHub 登录一次）
```bash
git remote add origin https://github.com/<你的用户名>/review-system.git
git push -u origin main
```
之后你在 GitHub 网页里直接改文件并合并到 `main`，GitHub Actions 会自动重新部署到 Cloudflare。

### 3. 配置 GitHub Secrets（Actions 部署所需）
在仓库 **Settings → Secrets and variables → Actions → New repository secret** 添加：

| Secret 名称 | 值 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token（见下方获取方式） |
| `CLOUDFLARE_ACCOUNT_ID` | `087ce5f957d498fc3a25dc406fef4a74` |

**获取 `CLOUDFLARE_API_TOKEN`**（推荐用专用 API Token，比 OAuth Token 更稳定）：
1. 打开 https://dash.cloudflare.com/profile/api-tokens
2. **Create Token → Custom token**
3. 权限（Permissions）添加：
   - Account → Cloudflare Pages → Edit
   - Account → Workers Scripts → Edit
   - Account → D1 → Edit
   - Zone → Zone → Read
4. Account resources → 包含本账号
5. 创建并复制 Token，回填到上面的 Secret。

> 临时测试也可直接把本地 `default.toml` 里的 `cfoat_...` OAuth Token 用作 `CLOUDFLARE_API_TOKEN`，但 OAuth Token 会过期，生产请用上面的专用 API Token。

---

## 四、访问控制（Cloudflare Access，方案 A）

后端 `/api` 当前**无应用层鉴权**，需通过 Cloudflare Access 在站点入口加一道门锁（仅允许你指定的邮箱进入）。**此步骤需在 Cloudflare 控制台完成（API Token 无 Access 权限，无法用命令行配置）**。

1. 打开 **Cloudflare Zero Trust** 控制台（one.dash.cloudflare.com）→ **Access → Applications → Add application → Self-hosted**。
2. 名称填 `review-system`；Session Duration 选 `24h`。
3. **Application domain** 选择 `keping.whatis.dpdns.org`（即本站点域名，需为橙色云代理状态）。
4. 路径留空（保护整个站点，含 `/api` 与 WebSocket）。
5. 进入 **Policies**，新增一条：
   - Policy name：`allow-owner`
   - Action：`Allow`
   - Include（包含）：`Email` → 填**你自己的邮箱**（如 `1537932451@qq.com`）。如需让同事也能用，再加他们的邮箱或 `Email domain` 限定域名。
   - ⚠️ **不要**选 `Everyone` / `Any valid email`，否则任何人都能进。
6. 保存。

效果：陌生人知道域名也打不开页面（被 Access 挡在门外）；你用自己的邮箱 + 一次性验证码（OTP）登录后即可正常使用，浏览器会自动携带凭证，实时同步（WebSocket）与 `/api` 调用均不受影响。

---

## 五、安全说明

- ✅ 已修复 `escapeHtml` 引号转义（防存储型 XSS）：学生/班级名等用户输入在拼入 HTML 前转义 `& < > " '`。
- ✅ 已通过 Cloudflare Access（见上）限制站点访问。
- 应用内原有的"管理员登录"仅为前端标志位，不具备后端鉴权；真正的访问控制由 Cloudflare Access 提供。

---

## 六、目录结构

```
.
├── public/index.html            # 前端（单文件应用）
├── functions/api/[[catchall]].js# Pages Functions：D1 读写 + 广播
├── sync-hub-worker/             # 实时同步 Worker（Durable Object）
│   ├── index.js
│   └── wrangler.toml
├── wrangler.toml                # Pages 配置：D1 绑定 + SyncHub 引用
├── schema.sql                   # D1 表结构
├── migrate.js                   # 数据迁移脚本
├── rt_test.js                   # 实时同步端到端回归测试
└── .github/workflows/deploy.yml # 推送即部署
```
