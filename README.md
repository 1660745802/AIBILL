# AI 记账 (Bill)

自部署的 AI 个人财务工作台。说句话就能记账，支持小范围多人使用。

## 功能

- 🤖 **AI 快速记账** — 自然语言输入，AI 解析为结构化数据
- ✏️ **手动记账** — AI 的 fallback，传统表单模式
- 📊 **统计分析** — 趋势图、分类饼图、消费排行
- 💬 **AI 问答** — 基于个人财务数据回答问题
- 💰 **预算管理** — 设置月度预算，超支提醒
- 📥 **账单导入** — 支持微信/支付宝 CSV 账单
- 📤 **数据导出** — JSON 全量备份 + CSV 流水导出
- 👥 **多用户** — 邀请码注册，数据完全隔离
- 📱 **PWA** — 添加到手机桌面，离线可用

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | Vue3 + TypeScript + TailwindCSS + Chart.js |
| 后端 | Node.js + Fastify + TypeScript |
| 数据库 | SQLite (better-sqlite3) |
| AI | OpenAI / Claude 兼容接口 |
| 部署 | Docker |

## 快速开始

### Docker 部署（推荐）

```bash
# 1. 克隆项目
git clone <repo-url> && cd bill

# 2. 配置环境变量
cp server/.env.example .env
# 编辑 .env，至少设置 JWT_SECRET 和 AI_API_KEY

# 3. 启动
docker-compose up -d

# 4. 访问
# http://localhost:3000
# 默认管理员：admin / changeme123
```

### 本地开发

```bash
# 后端
cd server
cp .env.example .env  # 编辑配置
npm install
npm run dev           # http://localhost:3000

# 前端（新终端）
cd web
npm install
npm run dev           # http://localhost:5173（代理到3000）
```

## 使用流程

1. **管理员登录** — 用 admin 账号登录
2. **生成邀请码** — 设置 → 管理员面板 → 生成邀请码
3. **配置 AI** — 设置 → AI 设置 → 填入 API Key
4. **邀请用户** — 将邀请码分享给朋友
5. **开始记账** — 首页输入 "午饭32，打车15" → 确认

## 项目结构

```
bill/
├── server/          # 后端 API
│   └── src/
│       ├── routes/  # 路由（auth/transaction/ai/stats/budget/import/export/admin）
│       ├── ai/      # AI 模块（client/prompts/parser/category-matcher）
│       ├── db/      # 数据库（schema/migration/连接）
│       └── middleware/  # 认证中间件
├── web/             # 前端 SPA
│   └── src/
│       ├── views/   # 页面（Home/Transactions/Stats/AiChat/Budget/Settings）
│       ├── components/ # 组件（ConfirmCards/ManualForm/TodayList/...）
│       └── stores/  # Pinia 状态
├── docs/            # 设计文档
├── Dockerfile
└── docker-compose.yml
```

## API 概览

| 模块 | 端点 | 说明 |
|------|------|------|
| 认证 | POST /api/auth/register, login | 邀请码注册 + JWT 登录 |
| 交易 | GET/POST/PUT/DELETE /api/transactions | 批量创建+幂等+筛选 |
| AI | POST /api/ai/parse | AI 记账解析 |
| AI | POST /api/ai/chat | AI 问答 |
| 统计 | GET /api/stats/summary, by-category, trend | 收支摘要+分类+趋势 |
| 预算 | GET/POST/PUT/DELETE /api/budgets | 预算管理 |
| 导入 | POST /api/import/csv | 微信/支付宝账单导入 |
| 导出 | GET /api/export/json, csv | 数据导出 |
| 管理 | /api/admin/* | 邀请码+用户+设置 |

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| JWT_SECRET | ✅ | JWT 签名密钥（≥32字符随机串） |
| ADMIN_USERNAME | 否 | 管理员用户名（默认 admin） |
| ADMIN_PASSWORD | 否 | 管理员密码（默认 changeme123） |
| AI_BASE_URL | 否 | AI 接口地址（默认 OpenAI） |
| AI_API_KEY | ✅ | AI API 密钥 |
| AI_MODEL | 否 | 模型名称（默认 gpt-4o-mini） |
| DB_PATH | 否 | 数据库路径（默认 ./data/bill.db） |
| PORT | 否 | 监听端口（默认 3000） |

## 备份

SQLite 单文件，直接复制 `data/bill.db` 即备份：

```bash
cp data/bill.db backup/bill_$(date +%Y%m%d).db
```

## License

MIT
