# 架构设计

> 技术实现基线：**怎么搭的、怎么部署的**。
> 产品方案（做什么、为什么）见 [PRODUCT.md](PRODUCT.md)；数据模型与口径见 [DATA.md](DATA.md)；
> API 契约见 [API.md](API.md)。

---

## 1. 技术架构

### 1.1 整体图

```
┌─────────────────────────────────────────────────┐
│                   客户端                          │
├──────────────────────┬──────────────────────────┤
│   Web (Vue3 + Vite)  │  移动端 (PWA / App)      │
└──────────┬───────────┴──────────┬───────────────┘
           │         HTTPS        │
           ▼                      ▼
┌─────────────────────────────────────────────────┐
│            后端 API (Node.js + Fastify)           │
│                                                  │
│  JWT 鉴权 → 路由层 → 业务逻辑 → 数据访问层     │
│                                  ↓               │
│                          SQLite + AI Engine      │
└──────────────────────┬──────────────────────────┘
                       ▼
                 OpenAI / 兼容 API
```

### 1.2 技术栈

| 层级 | 技术 | 理由 |
|------|------|------|
| 前端 | Vue3 + TypeScript + Vite + TailwindCSS | 轻量高效，生态成熟 |
| 移动端 | PWA（同一套 Web 代码）+ Android App | 免 App 审核 / 复用 API |
| 后端 | Node.js + Fastify + TypeScript | 快速开发，接 AI 方便 |
| 数据库 | SQLite (better-sqlite3) | 自用无需 MySQL，零运维，单文件备份 |
| AI | OpenAI / Claude / 任意兼容接口 | 自带 Key，按需切换 |
| 部署 | Docker / NAS / VPS | 简单 |

### 1.3 代码分层（后端）

```
routes/      → 路由定义 + 参数校验 + 把异常翻成 HTTP 响应
lib/         → 纯领域逻辑（净资产读模型 portfolio / 余额 account-balance /
              日期 date / 行情 quotes·fx·holdings·quote-acquisition）
services/    → 后台任务与横切（scheduler / logger / auth.service）
db/          → 数据访问（schema + migration）
middleware/  → 中间件（auth）
```

「同一个数字只有一个算法」的约束（净资产口径、余额写入语义、日期口径）
**全部落在 `lib/`**，路由层只翻译 HTTP。详细编码规范见 [DEVELOPMENT.md §2](DEVELOPMENT.md)。

### 1.4 LLM 调用架构

**为什么放服务端：**
1. API Key 安全——不暴露在前端代码/浏览器
2. 服务端拼接 prompt + 附带用户历史摘要
3. 换模型、调参数、加 fallback 都集中在一处

**调用时序：**

```
前端 ── POST /api/ai/parse ──► 后端
                                ├─ 拼 prompt（few-shot + 分类/账户列表 + user_input 包裹）
                                ├─ 调用 LLM API
                                ├─ 校验 JSON + 金额转分 + 分类名匹配
                                ◄── 结构化数据 ── 前端展示确认卡片
前端 ── POST /api/transactions ──► 入库
```

---

## 2. 认证与多端契约

### 2.1 角色

| 角色 | 权限 |
|------|------|
| `admin` | 邀请码 + 用户 + 全局 AI 配置 + 自己的记账数据 |
| `user` | 注册/登录 + 自己的记账数据 |

**隐私原则**：记账数据极度私密，**用户之间完全隔离**。管理员默认只在管理面板做
用户/系统管理；排障时可经管理面板查看他人交易明细与 AI 解析原文，该跨用户读取
**必写审计日志**（见 [API.md §12](API.md)、[DEVELOPMENT.md §5.3](DEVELOPMENT.md)）。
数据隔离约定见 [DATA.md §1.1](DATA.md)。

### 2.2 注册流程
```
用户访问注册页 → 邀请码 + 用户名 + 密码
后端校验邀请码（存在、未过期、未用完）
同一事务内：创建用户 + 生成默认分类 + 生成默认账户
邀请码 used_count + 1 → 返回 JWT
```
默认分类/账户在事务中静默生成，前端无需额外调用。引导靠 `/onboarding` 向导（注册后进入）与空态文案。

### 2.3 登录流程
```
用户名 + 密码 → bcrypt 比对 → 签发 JWT（payload 含 ver，永不过期）
前端存 localStorage → Authorization: Bearer <jwt>
```
改密 / 重置密码 / 禁用用户 → `users.token_version` 自增，所有现存 token 立即失效。
详见 [API.md §1 认证](API.md)。

### 2.4 多端接入规范（API 契约）

```json
POST /api/transactions
{
  "items": [{
    "client_id": "uuid-v4",          // 幂等键
    "client_type": "web",            // web | app_android | app_ios | import_script
    "client_created_at": "ISO8601",  // 离线场景用
    "source": "ai",                  // manual | ai | import_csv | app_notification | ocr | subscription
    "source_detail": "...",          // 原始来源内容
    "type": "expense",
    "amount": 3200,
    "category_id": 1,
    "account_id": 1,
    "target_account_id": null,       // 仅 transfer 时必填
    "description": "午饭",
    "date": "2026-07-01"
  }]
}
```

**统一规则**：始终用 `items` 数组；单条记账传 `items: [单条对象]`，批量传多条。
响应信封、错误码、字段约定见 [API.md §0](API.md)。

---

## 3. 部署与运维

### 3.1 环境变量

| 变量 | 必填 | 说明 | 默认值 |
|------|------|------|--------|
| `JWT_SECRET` | ✅ | JWT 签名密钥（≥32 字符） | `your-random-secret-at-least-32-chars`（必须改） |
| `AI_API_KEY` | ✅ | AI 模型 API 密钥 | `sk-your-key`（必须改） |
| `ADMIN_PASSWORD` | 建议 | 管理员初始密码 | `changeme123` |
| `ADMIN_USERNAME` | 否 | 管理员用户名 | `admin` |
| `AI_BASE_URL` | 否 | AI 接口地址 | `https://api.openai.com/v1` |
| `AI_MODEL` | 否 | 模型名称 | `gpt-4o-mini` |
| `DB_PATH` | 否 | 数据库路径 | `./data/bill.db` |
| `PORT` | 否 | 监听端口 | `3000` |
| `CORS_ORIGINS` | 否 | 逗号分隔白名单 | `*`（⚠️ 生产环境必须改成具体 origin） |
| `QUOTE_REFRESH_MINUTES` | 否 | 行情刷新间隔（分钟） | `15` |
| `UPDATES_DIR` | 否 | App 更新包（APK）目录 | `./data/updates` |

### 3.2 Docker 部署（推荐）
```bash
git clone <repo-url> && cd bill
cat > .env << EOF
JWT_SECRET=$(openssl rand -hex 32)
ADMIN_PASSWORD=your-strong-password
AI_API_KEY=sk-your-openai-key
EOF
docker-compose up -d
```
数据存储在宿主机 `~/.bill/`，备份只需复制该文件夹。

### 3.3 本地开发
```bash
# 后端（端口 3000）
cd server && cp .env.example .env && npm install && npm run dev

# 前端（端口 5173，自动代理）
cd web && npm install && npm run dev
```

### 3.4 数据库迁移
启动时自动检测并执行未应用的 migration。`schema_migrations` 表记录已应用版本。
**禁止修改已应用的 migration，只能新增**（事故复盘与正确姿势见
[DEVELOPMENT.md §3.2](DEVELOPMENT.md)）。当前 17 个版本，清单见 [DATA.md §9](DATA.md)。

### 3.5 备份与恢复
```bash
# 备份（⚠️ WAL 模式下 cp 可能拿到不完整副本，用 db.backup 或连 -wal 一起复制）
cp ~/.bill/bill.db* ~/backup/

# 恢复
cp ~/backup/bill_20260701.db ~/.bill/bill.db
docker restart bill-app

# 或使用内置导出：设置 → 数据管理 → 导出 JSON
```

### 3.6 更新
```bash
cd ~/AIBILL
git pull origin main
docker-compose up -d --build
```
数据库 migration 自动应用。

### 3.7 通知规则分发（`server/config/rules.json`）

客户端（Android 通知记账）的预筛词表/包名/窗口参数不随 App 发版，而是**从服务端下发**：

| 角色 | 是谁 |
|------|------|
| **内容真源** | `server/config/rules.json`（进 git，可 review / `git revert`） |
| 发布载体 | 表 `notification_rules`（历史 + 激活态 + `content_hash`） |
| 下发接口 | `GET /api/config/notification-rules`（无认证；`ETag = "<content_hash>"`，支持 304） |
| 管理面板 | **只看/激活历史/回滚，不做在线编辑**（避免与文件双写） |
| 契约细节 | [recognition-flow.md §9/§10](recognition-flow.md) |

**启动流程（幂等 + fail-fast）**：读文件 → 严格校验（顶层键白名单 / 必需形状清单 / 正则交集子集 /
`testcases` 自检）→ 算内容 hash（剔除 `testcases`，**含代码派生的 `precheck`**）→ 与激活版本 hash
不同则插入新版本并激活，相同则不动。**任何一步失败都拒绝启动**（宁起不来，也不下发坏规则）。

**部署面**：镜像内置 `config/`；`docker-compose.yml` 只读挂载 `./server/config/rules.json:/app/config/rules.json:ro`；
env `RULES_PATH`（默认 `<cwd>/config/rules.json`）。非 Docker 部署需保证该文件存在（或设 `RULES_PATH`）。

**改规则的流程**：改 `server/config/rules.json` → commit → `docker-compose up -d --build`（已挂载时
`docker restart bill-app` 即可）→ 客户端凭 ETag 自动重拉。**回滚**：`git revert` 该文件后重启。
⚠️ 老库升级后首次启动会发布一个新版本（存量行里没有 `precheck`），客户端会重拉一次；再启动即幂等。

### 3.8 App 自更新与 `versionCode` 纪律

Android 客户端用 `GET /api/app/update?versionCode=` 检查更新；`app_updates` 表里激活版本的
`force_update=1` 时，所有 **`versionCode` 低于该版本**的客户端都会被要求强制升级
（服务端只回标志，是否强更由客户端 `UpdateManager` 执行）。

| 事实 | 值 |
|------|-----|
| **最低安全版本**（含「转账 `category_id` 可空」修复 `9e318a2`） | **`versionCode = 2`（v1.0.0）** |
| **客户端支持基线** | **Android ≥ 1.5.0 = `versionCode ≥ 7`**；更老的包不做专门兼容（v0.4 垫片已撤除，见 [recognition-flow.md §11](recognition-flow.md)） |
| 记录本文时的 HEAD | `versionCode = 24` / `1.6.0` |

**发布检查单（发版前跑一遍）：`versionCode` 必须唯一且严格递增。**

```sql
-- ① 重复：有返回行即违规（历史真实出现过：v1.0.0/v1.1.0 都是 2；v1.3.0/v1.3.1 都是 4）
SELECT version_code, COUNT(*) c, GROUP_CONCAT(version_name) names
  FROM app_updates GROUP BY version_code HAVING c > 1;

-- ② 非严格递增：有返回行即违规（按 id/created_at 排序后出现 <= 前一个）
SELECT version_code, version_name, prev FROM (
  SELECT id, version_code, version_name,
         LAG(version_code) OVER (ORDER BY id) AS prev
    FROM app_updates
) WHERE prev IS NOT NULL AND version_code <= prev;
```

⚠️ **什么才算违规**：**只有「重复」与「非严格递增」是问题**。**跳号（gap）是正常的**——历史上
`v1.4.0 = 5 → v1.5.0 = 7` 就跳过了 6（发版节奏/取消过一版都会造成），不要为此去查原因，
更不要在检查单里加「必须连续」这种规则。

⚠️ **为什么必须有这条**：更新判断只看 `versionCode`。一旦重复，**自报相同 code 的老安装会被判成
「已是最新」，强更推不到它**（例：装了 v1.1.0 的机器自报 2，而服务器激活版本也可能自报 2）。
两条 SQL 已用上述历史序列实测：① 检出 2 与 4 两组重复，② 检出 v1.1.0、v1.3.1。
