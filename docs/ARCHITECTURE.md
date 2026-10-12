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
