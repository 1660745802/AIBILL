# 💰 AI 记账 (Bill)

自部署的 AI 个人财务工作台：说一句话就能记账，支持小范围多人使用。

![Vue3](https://img.shields.io/badge/Vue-3.5-4FC08D?logo=vue.js)
![Fastify](https://img.shields.io/badge/Fastify-5-000000?logo=fastify)
![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript)
![SQLite](https://img.shields.io/badge/SQLite-3-003B57?logo=sqlite)
![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker)

## 🎯 定位与原则

- **记账零摩擦**：说一句话就记完，不用填表单
- **记得准**：AI 解析 + 用户确认，常见输入一次通过率 > 80%
- **数据在自己手里**：自部署，业务数据不上传第三方
- **多端统一接口**：Web、App 共用同一套 API，来源可追溯
- **用户间完全独立**：各自记账互不可见。管理员默认只在管理面板做用户/系统管理；
  排障时可查看他人交易明细与 AI 解析原文，该跨用户读取**会写审计日志**（见 [API.md §12](docs/API.md)、[ARCHITECTURE.md §5.3](docs/ARCHITECTURE.md)）
- **AI 失败不阻塞**：任何 AI 环节出错，用户都能无感切到手动完成

体验目标：打开→入账 ≤ 3 步；AI 成功耗时 ≤ 5 秒；AI 失败**零损失**（无感切手动、输入保留）；批量 3 条约等于 1 条的时间。

**记账主入口的现实**（实测 2026-10，`app_logs`）：**91% 的记账来自 Android 通知自动入账**，手动 8%、AI 1%。
所以 **Android 是记账入口**，**Web 是数据整合端**（看账、对账、资产、分析）——
「记一笔」在 Web 只是普通导航项 + `⌘K` 快捷键，不值得做成视觉主角（见 [UI-DESIGN.md §6](docs/UI-DESIGN.md)）。

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

### 产品口径（跨端一致）

| 交易类型 | 计入支出 | 计入收入 | 计入预算 |
|---------|---------|---------|---------|
| 普通支出 | ✅ | — | ✅ |
| 普通收入 | — | ✅ | — |
| 转账 | ❌ | ❌ | ❌ |
| 退款/报销（收入分类） | — | ✅ | ❌ |

**去重**：幂等重试按同一 `client_id`；导入重复按「同 user + type + amount + date + description」提示确认；
App 通知去重**完全由客户端负责**（服务端不做）：包名+正文 hash、金额+渠道+包名 60s 窗口、DB 1s 去重；服务端只保存 `source_detail` 供追溯（**不是**拿它去重）。
**交易状态**：`confirmed`（默认，入账）/ `pending`（App 自动识别候选，**不计入统计**）。
金额单位（分）、日期格式（北京时间）等存储约定见 [DATA.md §1](docs/DATA.md)。

## 📋 功能现状（2026-10 核查）

| 阶段 | 模块 | 状态 |
|------|------|------|
| **P0** | 鉴权（邀请码 + JWT）· AI 快速记账 + 确认卡片 · 手动记账（fallback）· 流水列表/软删除 · 注册后引导 · 全局快速录入（⌘K/N）· 多端统一 API | ✅ |
| **P1** | 统计概览 · CSV 导入 · AI 问答 · 多账户+余额（增量+手填覆盖，单一真源）· 数据导出 · 回收站 | ✅ |
| **P2** | Dashboard 仪表盘 · Financial Analysis（过去/现在/未来） | ✅ |
| **P3a** | 投资理财（持仓估值 / 多市场行情 / 外币折算 / 盈亏） | ✅ |
| **P2c/P2d/P3e** | 负债中心 · 现金流预测 · App 通知/OCR 自动记账（Web 侧无动作，能力在 Android） | 📋 规划 |

> AI 快速记账的解析链路含：入站预筛、`precheck` 云控判据、机械字段 `confidence`/`needs_review`、
> 客户端拦截计数上报；接口细节见 [API.md 附录 C](docs/API.md)。

### 已废弃（deprecated）—— **本表是唯一权威**

以下功能经 3 个月真实数据验证判定为无价值：**服务端表全部 0 行**，且**两个客户端都没有可达入口**。
Web 端页面与导航入口已移除；**接口与数据表暂时保留，统一标记 deprecated**，待两端对齐排期后一并移除。

| 功能 | 废弃的接口 | 客户端现状 | 对应表 |
|------|-----------|-----------|--------|
| 预算管理 | `/api/budgets/*` | Web 已下线；Android 有 `BudgetApi`/`Repository`/`DTO` 四层数据链路但 **presentation 层零引用**（UI 入口从未做过） | `budgets` |
| 财务目标 | `/api/goals/*` | 两端均无引用 | `financial_goals` / `goal_progress` |
| 订阅管理 | `/api/subscriptions/*` | 两端均无引用 | `subscriptions` |
| AI 记忆（接口） | `/api/memories/*` | 两端均无引用 | ⚠️ `ai_memories` **表不可删**（见下） |
| 资产快照（接口） | ~~`/api/assets/snapshot`、`/api/assets/trend`~~ | **2026-10 已删除路由**（web 零引用；Android 全 history 零引用） | ⚠️ `asset_snapshots` **表不可删**（见下） |

**为什么标 deprecated 而不直接删**：一个客户端里「数据层写全了但 UI 没入口」很容易被误读成
「功能存在只是没人用」。标 deprecated 并写明判定依据，下一个读代码的人不用重新调研。

**两条硬约束（删表 = 故障，不是清理）**：
- ⚠️ **`ai_memories` 表被 AI 解析主流程活跃读写**（解析时读记忆注入 prompt、修正后自动学习写入、AI 问答读取）。**只下线路由，表必须保留**。
- ⚠️ **`asset_snapshots` 表被四方活跃读写**（portfolio 曲线、dashboard/analysis 净资产、手填余额凭证）。删表会让这些端点集体 500。

**兼容承诺**：`GET /api/stats/dashboard` 响应结构保持不变（仍含 `budget_progress` / `goals_top` /
`subscriptions_overview`，表为空故为空），以免已发布客户端解析失败。旧 Web 路由 `/budget` `/goals` `/subscriptions` 302 到 `/me`，不 404。

## ⚖️ 功能取舍流程（数据驱动，不靠直觉）

> 一个功能「没人用」和「不存在」是两回事——两者在代码里都可能有完整的数据链路，但处置方式完全不同。
> 用 `scripts/feature-triage.sh` 10 秒拿证据。

**四类证据（按可信度递增，只看第一类就会出错）**

| # | 证据 | 能说明什么 | 陷阱 |
|---|------|-----------|------|
| 1 | 表行数 | 服务端没数据 | 无法区分「没用」和「没做」 |
| 2 | 最近写入时间 | 是否「用了一阵就废了」 | — |
| 3 | 请求日志 | 主入口在哪 | `app_logs` **只记写操作**，没出现 ≠ 没人调；窗口 < 30 天结论不可靠 |
| 4 | **客户端可达性**（决定性） | 功能是否真的存在 | **要看 UI 层不是数据层**：数据层四层齐备 + `presentation/` 零引用 = 事实上的死代码 |

**处置矩阵**：有数据+可达 → 正常｜有数据+不可达 → 确认是否要接，不接则清数据｜**0 行+可达 → 不要删接口**，先问客户端｜**0 行+不可达 → 可以下线**（按下面顺序）。

**下线安全规则**：① 先撤前端入口、不动后端 ② 标 `deprecated` **并写判定依据**（别写「保留」，会被读成「还在用」）
③ 响应结构不动（恒空字段保留）④ 旧路由 302 到合理落点 ⑤ DROP 表要等客户端先删完且确认真的 0 行
⑥ **「接口废弃」≠「表废弃」**，分开判定。

**`0 行` ≠ `没用`**（都是真实误判）：`user_settings` 0 行但写入路径活跃（只是没人存过偏好）；
`ai_memories` 0 行但被解析主流程读写；「0 行 + 0 调用 + 指标恒 0」往往是**接线没接上**（`parse-feedback` 曾零调用，
管理者却据此判断「AI 很准」，结论完全相反）。
启发式：行数 0 但接口从没被调用 → 先查客户端；接口被频繁调用但结果为空 → 功能在用；从未被调用且客户端无引用 → 才是真没用。

**节奏**：每半年复盘一次（同一脚本，支持 `CONTAINER=` / `DB=`），让导航和功能跟着真实使用走。

## 🗺️ 路线图

| 里程碑 | 验收标准 |
|--------|---------|
| M1 能记账 | 注册 → AI/手动 → 流水可查 |
| M2 能看懂 | 月度摘要 + 分类饼图 + 趋势图 |
| M3 能对话 | AI 问答基于个人数据回答 |
| M4 能管理 | 预算 + CSV 导入 + 多账户 |
| M5 能部署 | Docker 一键部署，PWA 桌面化 |

**当前进度**：M1–M5 已达成；P0–P3a 核心功能完成，P2c/P2d/P3e 规划中。规划表的详细数据模型见 [DATA.md §4](docs/DATA.md)。

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

完整环境变量表、迁移、备份与更新见 [ARCHITECTURE.md §3](docs/ARCHITECTURE.md)。

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
│   ├── config/rules.json      # 通知记账规则的内容真源（进 git，启动时校验并发布）
│   ├── src/
│   │   ├── app.ts             # 入口（CORS / JWT / rate-limit / 错误出口）
│   │   ├── config.ts          # 环境变量
│   │   ├── ai/                # AI 模块（client / parser / prompts / matcher / verify）
│   │   ├── db/                # Schema + Migration（21 个版本）
│   │   ├── middleware/        # JWT 鉴权（含 token_version 校验）
│   │   ├── routes/            # 17 个路由模块（90 端点，见 docs/API.md）
│   │   ├── services/          # auth / logger / scheduler
│   │   └── lib/               # 纯领域逻辑：portfolio / account-balance / precheck /
│   │                          # quotes·fx·holdings·quote-acquisition / date
│   └── tests/                 # 53 个测试文件（687 用例）
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
├── docs/                      # 文档（5 份，见下）
├── scripts/                   # gen-api-docs.ts / feature-triage.sh / e2e-assets.mjs
├── Dockerfile                 # 多阶段构建
├── docker-compose.yml         # 单服务
└── README.md
```

## 📖 文档导航

| 文档 | 回答的问题 |
|------|-----------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 怎么搭的 / 怎么上线：技术架构、多端契约、部署运维、**开发规范·安全·PR·测试·文档纪律** |
| [docs/DATA.md](docs/DATA.md) | 数据模型；**余额 / 行情 / 日期口径** |
| [docs/API.md](docs/API.md) | 全部 90 个端点契约 + **附录 C 跨端解析契约** |
| [docs/UI-DESIGN.md](docs/UI-DESIGN.md) | 前端信息架构与**口径硬规则**（视觉 token 真源在 `web/src/assets/main.css`） |
| 本文（README） | 产品定位与原则、功能现状（**deprecated 权威表**）、取舍流程、路线图、快速开始 |

> 新接手阅读顺序：README（是什么/现在有什么）→ `ARCHITECTURE`（怎么搭的）→
> `DATA`（数据口径）→ `API`（接口）→ `UI-DESIGN`（前端规格）。
> **改动任何口径前先读对应章节**——这个项目大半的历史 bug 都出在「同一个数字有两套算法」。

## 🔒 安全特性

- JWT（含 token_version）永不过期，支持服务端撤销（改密/重置/禁用即失效）
- AI API Key 服务端持有，前端不可见；用户输入 `<user_input>` 包裹防 prompt injection
- 用户间数据完全隔离（强制 `user_id` 过滤）；跨用户读明细仅限排障且**写审计日志**
- 密码 bcrypt 哈希存储（cost ≥ 12）；SQL 全参数化
- CORS 白名单 + 限流（auth 5/min、AI 20/min）

完整安全规范见 [ARCHITECTURE.md §5](docs/ARCHITECTURE.md)。

## 📱 Android 客户端

原生 Android App（Kotlin + Jetpack Compose），复用同一套后端 API，支持通知自动记账（主要记账入口，
支持基线 **≥ 1.5.0**，`versionCode` 纪律见 [ARCHITECTURE.md §3.8](docs/ARCHITECTURE.md)）。

- 仓库：[AIBILL-ANDROID](https://github.com/1660745802/AIBILL-ANDROID)

## License

MIT
