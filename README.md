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
| ✏️ 记账 | 自然语言一句话 → AI 解析 → 确认卡片 → 入账；支持手动兜底、批量记账 |
| 📒 账本 | 按日分组的流水、明细编辑、搜索筛选、统计图表 |
| 📅 本月结算 | 月度结算单：净资产、收支与储蓄率、待办、趋势、最近交易 |
| 💬 AI 问答 | 基于个人财务数据回答问题（"这个月餐饮花了多少？"） |
| 💳 资产全景 | 各账户余额、净资产与资产分布；投资持仓估值 / 多市场行情 / 外币折算 |
| 📥 账单导入 | 微信 / 支付宝 CSV 一键导入（预览确认后入账） |
| 📤 数据导出 | JSON 全量备份 + CSV 流水导出（Excel 兼容） |
| 👥 多用户 | 邀请码注册，数据完全隔离，管理员不可见他人数据 |
| 🗑️ 回收站 | 软删除可恢复，30 天后自动清理 |
| 🔧 管理面板 | 用户管理、AI 配置、解析质量监控、客户端拦截计数对照、系统日志、通知规则 |

> **两端分工**：91% 的记账来自 Android 通知自动记账，**Web 定位是数据整合端**
> （看账、对账、资产、分析），导航按功能分组（见 [docs/UI-DESIGN.md §6](docs/UI-DESIGN.md)）。
>
> 预算 / 财务目标 / 订阅 / AI 记忆接口已 **deprecated**（3 个月真实数据 0 使用），
> 状态与判定依据见 **[docs/PRODUCT.md §3.2](docs/PRODUCT.md)**（唯一真源）。

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
数据存储在宿主机 `~/.bill/`，备份只需复制该文件夹。

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

完整环境变量表、迁移、备份与更新见 [docs/ARCHITECTURE.md §3](docs/ARCHITECTURE.md)。

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
│   │   ├── db/                # Schema + Migration（17 个版本）
│   │   ├── middleware/        # JWT 鉴权（含 token_version 校验）
│   │   ├── routes/            # 17 个路由模块（90 端点，见 docs/API.md）
│   │   ├── services/          # auth / logger / scheduler
│   │   └── lib/               # 纯领域逻辑：portfolio / account-balance /
│   │                          # quotes·fx·holdings·quote-acquisition / date
│   └── tests/                 # 51 个测试文件（666 用例）
├── web/                       # 前端（Vue 3 + TailwindCSS）
│   ├── src/
│   │   ├── App.vue            # PC 侧边栏 + 移动端 Tab + Toast
│   │   ├── views/             # 14 个页面
│   │   ├── components/        # 26 个组件（含 ui/ 原子件）
│   │   ├── composables/       # useToast / useConfirm / useQuickEntry / useInvestmentNav
│   │   ├── stores/            # Pinia（auth / cluster / ledger / period）
│   │   ├── api/               # axios 封装 + 模块化
│   │   ├── nav.ts             # 导航单一真源（侧栏/底栏/索引页派生）
│   │   └── router/            # 路由表（含旧路由兼容重定向）
│   └── dist/                  # 构建产物
├── docs/                      # 文档（7 份，见下）
├── scripts/                   # gen-api-docs.ts / feature-triage.sh / e2e-assets.mjs
├── Dockerfile                 # 多阶段构建
├── docker-compose.yml         # 单服务
└── README.md
```

## 📖 文档导航

| 文档 | 回答的问题 |
|------|-----------|
| [docs/PRODUCT.md](docs/PRODUCT.md) | **产品方案**：定位、功能现状（含 deprecated 权威表）、取舍流程、路线图 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 怎么搭的：技术架构、多端契约、环境变量、部署运维 |
| [docs/DATA.md](docs/DATA.md) | 数据模型；**余额 / 行情 / 日期口径** |
| [docs/API.md](docs/API.md) | 全部 90 个端点契约（17 个路由模块，`scripts/gen-api-docs.ts` 生成对账） |
| [docs/UI-DESIGN.md](docs/UI-DESIGN.md) | 前端规格：设计 token、信息架构、口径硬规则 |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 开发规范、安全底线、测试地图、文档纪律 |
| [docs/recognition-flow.md](docs/recognition-flow.md) | AI 解析/预筛的**跨端契约**（与 Android 客户端共享） |

> 新接手阅读顺序：`PRODUCT`（做什么）→ `ARCHITECTURE`（怎么搭的）→
> `DATA`（数据口径）→ `UI-DESIGN`（前端规格）。**改动任何口径前先读对应章节**——
> 这个项目大半的历史 bug 都出在「同一个数字有两套算法」。

## 🔒 安全特性

- JWT（含 token_version）永不过期，支持服务端撤销（改密/重置/禁用即失效）
- AI API Key 服务端持有，前端不可见；用户输入 `<user_input>` 包裹防 prompt injection
- 用户间数据完全隔离（强制 `user_id` 过滤）；管理员不可查看其他用户明细
- 密码 bcrypt 哈希存储（cost ≥ 12）；SQL 全参数化
- CORS 白名单 + 限流（auth 5/min、AI 20/min）

完整安全规范见 [docs/DEVELOPMENT.md §5](docs/DEVELOPMENT.md)。

## 📱 Android 客户端

原生 Android App（Kotlin + Jetpack Compose），复用同一套后端 API，支持通知自动记账（主要记账入口）。

- 仓库：[AIBILL-ANDROID](https://github.com/1660745802/AIBILL-ANDROID)

## License

MIT
