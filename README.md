# 💰 AI 记账 (Bill)

自部署的 AI 个人财务工作台。说一句话就能记账，支持小范围多人使用。

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
| 📊 Dashboard | 财务仪表盘：净资产、趋势图、分类饼图、预算进度、异常提醒 |
| 📈 统计分析 | 趋势折线图、分类饼图、消费排行、环比变化、AI 分析 |
| 💬 AI 问答 | 基于个人财务数据回答问题（"这个月餐饮花了多少？"） |
| 💭 AI 记忆 | AI 记住你的消费习惯和偏好，解析越来越准 |
| 💰 预算管理 | 月度总预算 + 分类预算，超支实时提醒 |
| 🔁 订阅管理 | 追踪周期性支出，到期提醒，月/年费统计 |
| 📥 账单导入 | 支持微信 / 支付宝 CSV 账单一键导入 |
| 📤 数据导出 | JSON 全量备份 + CSV 流水导出（Excel 兼容） |
| 👥 多用户 | 邀请码注册，数据完全隔离，管理员不可见他人数据 |
| 📱 响应式 | 手机底部 Tab + PC 侧边栏，PWA 可添加桌面 |
| 🗑️ 回收站 | 软删除可恢复，30 天后自动清理 |
| 🔍 AI 质量监控 | 管理员面板查看解析成功率、耗时、用户修正率 |

## 🚀 快速开始

### Docker 部署（推荐）

```bash
git clone <repo-url> && cd bill

cat > .env << EOF
JWT_SECRET=$(openssl rand -hex 32)
ADMIN_PASSWORD=your-strong-password
AI_API_KEY=sk-your-openai-key
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4o-mini
EOF

docker-compose up -d
```

访问 `http://localhost:3000`，默认管理员 `admin / 你设置的 ADMIN_PASSWORD`。

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

详细部署、环境变量、数据库迁移见 [docs/ARCHITECTURE.md §7](docs/ARCHITECTURE.md)。

## 📖 使用流程

1. **管理员登录** → 用 admin 账号登录
2. **生成邀请码** → 设置 → 管理员面板 → 生成邀请码
3. **配置 AI** → 设置 → AI 设置 → 填入 API Key 和模型
4. **邀请朋友** → 将邀请码分享给朋友注册
5. **开始记账** → 首页输入 "午饭32，打车15" → 确认入账

## 📁 项目结构

```
bill/
├── server/                    # 后端（Fastify + TypeScript）
│   ├── src/
│   │   ├── app.ts             # 入口（CORS / JWT / rate-limit / onSend）
│   │   ├── config.ts          # 环境变量
│   │   ├── ai/                # AI 模块（client / parser / prompts / matcher）
│   │   ├── db/                # Schema + Migration（10 个版本）
│   │   ├── middleware/        # JWT 鉴权（含 token_version 校验）
│   │   ├── routes/            # 16 个路由模块（80 端点）
│   │   ├── services/          # auth / logger / scheduler
│   │   └── lib/               # response / error-codes（统一响应包装）
│   └── tests/                 # 8 个测试文件（96 用例）
├── web/                       # 前端（Vue 3 + TailwindCSS）
│   ├── src/
│   │   ├── App.vue            # PC 侧边栏 + 移动端 Tab + Toast
│   │   ├── views/             # 16 个页面（含 admin/ 子目录）
│   │   ├── components/        # 9 个组件
│   │   ├── composables/       # useToast
│   │   ├── stores/            # Pinia（auth + 业务模块）
│   │   ├── api/               # axios 封装 + 模块化
│   │   └── router/            # 路由表（含旧路由兼容重定向）
│   └── dist/                  # 构建产物
├── docs/                      # 设计文档（5 份）
│   ├── ARCHITECTURE.md        # 架构 / 技术栈 / 功能清单 / 部署
│   ├── DATA.md                # 数据模型 / 表结构 / 索引 / 迁移
│   ├── API.md                 # 全部 80 个端点契约
│   ├── CONTRIBUTING.md        # 开发规范 / Git / 安全底线
│   └── TESTING.md             # 测试用例清单
├── scripts/
│   └── gen-api-docs.ts        # 自动生成 API 端点表草稿
├── Dockerfile                 # 多阶段构建
├── docker-compose.yml         # 单服务
├── update.sh                  # 一键更新
└── README.md
```

## 📖 文档导航

- 架构 & 功能 → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 数据模型 → [docs/DATA.md](docs/DATA.md)
- API 契约 → [docs/API.md](docs/API.md)
- 开发规范 → [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)
- 测试方案 → [docs/TESTING.md](docs/TESTING.md)

## 🔌 API 概览

完整接口列表见 [docs/API.md](docs/API.md)（共 80 个端点）。

| 模块 | 端点数 | 关键端点 |
|------|--------|---------|
| 认证 | 4 | register / login / me / password |
| 交易 | 9 | CRUD + trash + tags + 永久删除 |
| AI | 9 | parse / chat / sessions / memories |
| 资产 | 4 | overview / trend / snapshot |
| 目标 | 6 | CRUD + progress |
| 订阅 | 6 | CRUD + cancel / renew |
| 管理员 | 15 | invites / users / settings / ai-stats |

## ⚙️ 环境变量

| 变量 | 必填 | 说明 | 默认值 |
|------|------|------|--------|
| `JWT_SECRET` | ✅ | JWT 签名密钥（≥32 字符） | - |
| `AI_API_KEY` | ✅ | AI 模型 API 密钥 | - |
| `ADMIN_PASSWORD` | 建议 | 管理员密码 | `changeme123` |
| `AI_BASE_URL` | 否 | AI 接口地址 | `https://api.openai.com/v1` |
| `AI_MODEL` | 否 | 模型名称 | `gpt-4o-mini` |
| `ADMIN_USERNAME` | 否 | 管理员用户名 | `admin` |
| `DB_PATH` | 否 | 数据库路径 | `./data/bill.db` |
| `PORT` | 否 | 监听端口 | `3000` |
| `CORS_ORIGINS` | 否 | 逗号分隔白名单 | `localhost:5173,localhost:3000` |

## 💾 备份与恢复

```bash
# 备份
cp ~/.bill/bill.db ~/backup/bill_$(date +%Y%m%d).db

# 恢复
cp ~/backup/bill_20260701.db ~/.bill/bill.db
docker restart bill-app

# 或使用内置导出
# 访问 设置 → 数据管理 → 导出 JSON
```

## 🔄 更新

```bash
cd ~/AIBILL
git pull origin main
docker-compose up -d --build
```

数据库 migration 自动应用。

## 🔒 安全特性

- JWT（含 jti）30 天有效期，支持服务端撤销
- AI API Key 服务端持有，前端不可见
- 用户间数据完全隔离（强制 `user_id` 过滤）
- 管理员不可查看其他用户明细
- 密码 bcrypt 哈希存储（cost ≥ 12）
- SQL 全参数化，防注入
- CORS 白名单 + 限流（auth 5/min、AI 20/min）
- AI 用户输入 `<user_input>` 包裹防 prompt injection

详细安全规范见 [CONTRIBUTING.md §5](docs/CONTRIBUTING.md)。

## 📱 Android 客户端

原生 Android App（Kotlin + Jetpack Compose），复用同一套后端 API，额外支持通知自动记账。

- 仓库：[AIBILL-ANDROID](https://github.com/1660745802/AIBILL-ANDROID)

## License

MIT