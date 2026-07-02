# 💰 AI 记账 (Bill)

自部署的 AI 个人财务工作台。说句话就能记账，支持小范围多人使用。

![Vue3](https://img.shields.io/badge/Vue-3.5-4FC08D?logo=vue.js)
![Fastify](https://img.shields.io/badge/Fastify-5-000000?logo=fastify)
![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript)
![SQLite](https://img.shields.io/badge/SQLite-3-003B57?logo=sqlite)
![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker)

## ✨ 功能特性

| 功能 | 说明 |
|------|------|
| 🤖 AI 快速记账 | 自然语言输入 → AI 解析 → 确认卡片 → 入账 |
| ✏️ 手动记账 | AI 的 fallback，传统表单模式 |
| 📊 统计分析 | 趋势折线图、分类饼图、消费排行、环比变化 |
| 💬 AI 问答 | 基于个人财务数据回答问题（"这个月餐饮花了多少？"） |
| 💰 预算管理 | 月度总预算 + 分类预算，超支实时提醒 |
| 📥 账单导入 | 支持微信 / 支付宝 CSV 账单一键导入 |
| 📤 数据导出 | JSON 全量备份 + CSV 流水导出（Excel 兼容） |
| 👥 多用户 | 邀请码注册，数据完全隔离，管理员不可见他人数据 |
| 📱 响应式 | 手机底部 Tab + PC 侧边栏，PWA 可添加桌面 |
| 🗑️ 回收站 | 软删除可恢复，30 天后自动清理 |

## 🖼️ 界面预览

```
┌─────────────────────────────────────┐
│  本月支出 ¥3,280   收入 ¥12,000    │  ← 渐变摘要卡片
├─────────────────────────────────────┤
│  [说点什么就能记账...]  [记账] [手动]│  ← AI 输入
├─────────────────────────────────────┤
│  🍜 午饭       -¥32    微信        │
│  🚗 打车       -¥15    支付宝      │  ← 今日流水
│  ☕ 咖啡       -¥28    微信        │
└─────────────────────────────────────┘
```

## 🚀 快速开始

### Docker 部署（推荐）

```bash
# 1. 克隆项目
git clone <repo-url> && cd bill

# 2. 配置环境变量
cat > .env << EOF
JWT_SECRET=$(openssl rand -hex 32)
ADMIN_PASSWORD=your-strong-password
AI_API_KEY=sk-your-openai-key
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4o-mini
EOF

# 3. 启动
docker-compose up -d

# 4. 访问 http://localhost:3000
# 默认管理员：admin / 你设置的 ADMIN_PASSWORD
```

数据存储在宿主机 `~/.bill/` 目录下，备份只需复制该文件夹。

### 本地开发

```bash
# 后端（端口 3000）
cd server
cp .env.example .env   # 编辑填入 AI_API_KEY 等
npm install
npm run dev

# 前端（端口 5173，自动代理到 3000）
cd web
npm install
npm run dev
```

## 📖 使用流程

1. **管理员登录** → 用 admin 账号登录
2. **生成邀请码** → 设置 → 管理员面板 → 生成邀请码
3. **配置 AI** → 设置 → AI 设置 → 填入 API Key 和模型
4. **邀请朋友** → 将邀请码分享给朋友注册
5. **开始记账** → 首页输入 "午饭32，打车15" → 确认入账

## 🏗️ 技术架构

```
┌───────────────────────────────────────────┐
│           客户端（Vue3 + PWA）              │
│   手机：底部 Tab    PC：侧边栏导航         │
└─────────────────┬─────────────────────────┘
                  │ HTTPS
┌─────────────────▼─────────────────────────┐
│         后端 API（Fastify + TypeScript）    │
│  认证 → 路由 → 业务逻辑 → SQLite          │
│                    ↓                       │
│              AI Engine → OpenAI/Claude     │
└───────────────────────────────────────────┘
```

| 层级 | 技术 |
|------|------|
| 前端 | Vue 3 + TypeScript + TailwindCSS + Chart.js |
| 后端 | Node.js 20 + Fastify 5 + TypeScript |
| 数据库 | SQLite（better-sqlite3），金额以"分"存储 |
| AI | OpenAI / Claude / 任何兼容接口 |
| 部署 | Docker，数据存 `~/.bill/bill.db` |

## 📁 项目结构

```
bill/
├── server/                 # 后端
│   └── src/
│       ├── routes/         # 10 个路由模块
│       │   ├── auth.ts     # 注册/登录/改密码
│       │   ├── transaction.ts  # 交易 CRUD + 回收站
│       │   ├── ai.ts       # AI 记账解析 + 问答 + 会话
│       │   ├── stats.ts    # 统计（摘要/分类/趋势）
│       │   ├── budget.ts   # 预算管理
│       │   ├── category.ts # 分类管理
│       │   ├── account.ts  # 账户管理
│       │   ├── import.ts   # CSV 导入
│       │   ├── export.ts   # 数据导出
│       │   └── admin.ts    # 管理员 + 用户设置
│       ├── ai/             # AI 模块
│       ├── db/             # 数据库 Schema + Migration
│       └── middleware/     # JWT 认证中间件
├── web/                    # 前端
│   └── src/
│       ├── views/          # 10 个页面
│       │   ├── Home.vue    # 首页（AI 记账 + 确认卡片）
│       │   ├── Transactions.vue  # 流水列表
│       │   ├── Stats.vue   # 统计图表
│       │   ├── AiChat.vue  # AI 问答对话
│       │   ├── Budget.vue  # 预算管理
│       │   ├── Import.vue  # 账单导入
│       │   ├── Settings.vue # 设置 + 管理员
│       │   ├── Onboarding.vue   # 首次引导
│       │   └── Trash.vue   # 回收站
│       ├── components/     # 7 个组件
│       └── composables/    # useToast
├── docs/                   # 设计文档（PRD/DB/开发/测试/贡献规范）
├── Dockerfile
└── docker-compose.yml
```

## 🔌 API 概览

| 模块 | 端点 | 说明 |
|------|------|------|
| 认证 | POST /api/auth/register, login | 邀请码注册 + JWT |
| 认证 | PUT /api/auth/password | 修改密码 |
| 交易 | GET/POST/PUT/DELETE /api/transactions | 批量创建 + 幂等 + 筛选 |
| 交易 | GET /trash, POST restore, DELETE permanent | 回收站 |
| AI | POST /api/ai/parse | 自然语言 → 结构化记账数据 |
| AI | POST /api/ai/chat | 智能问答 |
| 统计 | GET /api/stats/summary, by-category, trend | 收支分析 |
| 预算 | GET/POST/PUT/DELETE /api/budgets | 预算管理 |
| 导入 | POST /api/import/csv | 微信/支付宝 CSV |
| 导出 | GET /api/export/json, csv | 数据备份 |
| 管理 | /api/admin/* | 邀请码 + 用户 + 全局设置 |

## ⚙️ 环境变量

| 变量 | 必填 | 说明 | 默认值 |
|------|------|------|--------|
| JWT_SECRET | ✅ | JWT 签名密钥（≥32 字符） | - |
| AI_API_KEY | ✅ | AI 模型 API 密钥 | - |
| ADMIN_PASSWORD | 建议 | 管理员密码 | changeme123 |
| AI_BASE_URL | 否 | AI 接口地址 | https://api.openai.com/v1 |
| AI_MODEL | 否 | 模型名称 | gpt-4o-mini |
| ADMIN_USERNAME | 否 | 管理员用户名 | admin |
| DB_PATH | 否 | 数据库路径 | ./data/bill.db |
| PORT | 否 | 监听端口 | 3000 |

## 💾 备份与恢复

```bash
# 备份（SQLite 单文件）
cp ~/.bill/bill.db ~/backup/bill_$(date +%Y%m%d).db

# 恢复
cp ~/backup/bill_20260701.db ~/.bill/bill.db
docker restart bill-app

# 或使用内置导出
# 访问 设置 → 数据管理 → 导出 JSON
```

## 🔒 安全特性

- JWT 认证（30 天有效期）
- AI API Key 服务端持有，前端不可见
- 用户间数据完全隔离（所有查询强制 user_id 过滤）
- 管理员不可查看其他用户数据
- 密码 bcrypt 哈希存储
- SQL 全参数化，防注入
- 启动时检测默认密钥并警告

## 📝 开发文档

- [产品设计 PRD](docs/PRD.md)
- [数据库设计](docs/DATABASE.md)
- [研发方案](docs/DEVELOPMENT.md)
- [测试方案](docs/TESTING.md)
- [开发规范](docs/CONTRIBUTING.md)
- [工作台扩展](docs/WORKBENCH.md)

## License

MIT
