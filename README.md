# 💰 AI 记账 (Bill)

自部署的 AI 个人财务工作台。说一句话就能记账，支持小范围多人使用。

![Vue3](https://img.shields.io/badge/Vue-3.5-4FC08D?logo=vue.js)
![Fastify](https://img.shields.io/badge/Fastify-5-000000?logo=fastify)
![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript)
![SQLite](https://img.shields.io/badge/SQLite-3-003B57?logo=sqlite)
![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker)

## ✨ 功能特性

导航按**真实使用频率**分层（详见 `docs/UI-DESIGN.md` §1）：每天只暴露记账 / 账本 / 本月。

| 功能 | 使用频率 | 说明 |
|------|------|------|
| ✏️ 记账（默认落地页） | **每天** | 自然语言一句话 → AI 解析 → 确认卡片 → 入账；支持手动兜底 |
| 📒 账本 | **每天** | 按日分组的流水、明细编辑、搜索筛选、统计图表 |
| 📅 本月 | 每周 | 月度结算单：净资产、本月收支与储蓄率、待办、7 日趋势、最近交易 |
| 💬 AI 问答 | 偶尔 | 基于个人财务数据回答问题（"这个月餐饮花了多少？"） |
| 📥 账单导入 | 偶尔 | 支持微信 / 支付宝 CSV 账单一键导入 |
| 💳 资产全景 | 偶尔 | 各账户余额、净资产与资产分布 |
| 📤 数据导出 | 偶尔 | JSON 全量备份 + CSV 流水导出（Excel 兼容） |
| 👥 多用户 | — | 邀请码注册，数据完全隔离，管理员不可见他人数据 |
| 🗑️ 回收站 | — | 软删除可恢复，30 天后自动清理 |
| 🔧 管理面板 | 管理员 | 用户管理、AI 配置、解析质量监控、系统日志、通知规则 |

### 已废弃（deprecated）

以下功能经 3 个月真实数据验证判定为无价值：**服务端表全部 0 行**，且**两个客户端都没有可达入口**。
Web 前端已移除页面与导航入口；**接口与数据表暂时保留，但标记为 deprecated**，便于两端对齐排期后一并移除。

| 功能 | 废弃的接口 | 客户端现状（2026-10 核查） |
|------|-----------|----------------|
| 预算管理 | `/api/budgets/*` | Web 已下线；Android 有 `BudgetApi`/`Repository`/`DTO` 四层数据链路但** presentation 层零引用**（未做 UI 入口） |
| 财务目标 | `/api/goals/*` | 两端均无引用 |
| 订阅管理 | `/api/subscriptions/*` | 两端均无引用 |
| AI 记忆 | `/api/memories/*` | 两端均无引用；**但 `ai_memories` 表被 AI 解析主流程使用，不可删表** |
| 资产快照 | `/api/assets/snapshot`、`/api/assets/trend` | 两端均无引用 |

> 为什么不直接删：一个客户端里「数据层写全了但 UI 没入口」很容易被误读成「功能存在只是没人用」。
> 标 deprecated 能让下一个读到代码的人知道真实状态，而不是花时间重新调研一遍。

`GET /api/stats/dashboard` 的响应结构保持不变（仍含 `budget_progress` / `goals_top` /
`subscriptions_overview`，值恒为空），以免影响已发布的移动 App。旧 Web 路由
`/budget` `/goals` `/subscriptions` 302 到 `/me`，不会 404。

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
│   └── tests/                 # 28 个测试文件（406 用例）
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
│   ├── API.md                 # 全部 85 个端点契约
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
- 前端设计规格 → [docs/UI-DESIGN.md](docs/UI-DESIGN.md)
- 功能取舍流程 → [docs/FEATURE-TRIAGE.md](docs/FEATURE-TRIAGE.md)（`scripts/feature-triage.sh` 一键体检）

> 新接手先看这三份：`ARCHITECTURE`（整体怎么搭的）→ `DATA`（数据模型与
> 余额/行情口径）→ `UI-DESIGN`（前端规格）。**改动任何口径前先读对应章节**——
> 这个项目大半的历史 bug 都出在「同一个数字有两套算法」。
- 开发规范 → [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)
- 测试方案 → [docs/TESTING.md](docs/TESTING.md)

## 🔌 API 概览

完整接口列表见 [docs/API.md](docs/API.md)（共 85 个端点）。

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
| `QUOTE_REFRESH_MINUTES` | 否 | 行情刷新间隔（分钟） | `15` |

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

- JWT（含 token_version）永不过期，支持服务端撤销（改密/重置/禁用即失效）
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