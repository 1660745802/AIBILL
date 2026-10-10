# Changelog

所有版本变更记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### 界面重做：仪表读数（Instrument）—— 替换上一版的「账本纸」

> 上一版「账本纸」的设计规格已整体重写（见 `docs/UI-DESIGN.md`）。改动原因见该文件 §0：
> 账本纸执行得干净，但「发丝线网格 + 近乎零圆角 + 中性灰白 + 单一克制主色」正是生成式界面
> 最常见的那一档外观——专业、克制，但不专属于「一个人用 AI 记自己的账」这件事。
> 本次换的不是皮肤是隐喻：账本是文档，钱是**读数**。

- **仪表面恒为深色**：真实汽车仪表盘在日光下也是黑面，所以浅色系统下是「浅页面 + 深仪表面」，
  深色系统下是「深页面 + 更深一档仪表面」。个性来自这个对比和刻度结构，不来自「整个 App 变暗」
- **新增 `Gauge` / `InstrumentCluster`**：三个读数（净资产 / 储蓄率 / 本月支出 vs 上月）常驻内容区顶部，
  点击读数直达对应详情——仪表是导航入口，不是装饰截图
- **没有意义量程的数字不给刻度带**：净资产配的是构成横条不是刻度带（量程是占比，指针无意义）
- **主操作单独用会翻转的 token**（`--color-inverse`）：仪表黑按钮在深色系统下会「深底压深底」退到背景里，
  主操作必须是画面里对比最强的东西，不能分模式变弱
- **自托管 IBM Plex**（`web/public/fonts/`，6 个 woff2 / 348KB，latin 子集）：读数与表格数字用 Plex Mono，
  中文落系统栈（每个字重 300–700KB，个性也不靠中文字形承载）
- **删除上一版设计**：`paper-ruled` 纸纹横格、双线压边、会计式栏头全部移除

### 记账从「页面」变成「动作」
记账是唯一的高频动作，但原来要以「先跳到 `/` 页面」为前提——而人在看账本时冒出的新账，
恰恰是最容易忘掉的时刻，那时的摩擦最大。

- **全局快速录入**（`QuickEntry.vue`）：任意页面 `⌘K` / `N` 就地拉出，不跳页
- **草稿留得住**：误按 Esc 不丢句子（sessionStorage），下次打开还在
- **`/` 键有上下文**：有搜索框的页面聚焦搜索框（`#page-search`），没有的才拉快速录入
- **底部 5 槽 → 3 槽 + 右下药丸 FAB**：FAB 从居中挪到右下（拇指自然落点），且放回文档流——
  上一版用 absolute 定位，直接压住了中间那一槽
- **侧栏与「我的」不列同一批功能**：两个地方列同一个功能，人会犹豫该点哪个

### 周期改为全局状态
周期控件长在仪表面上，是唯一入口（`stores/period.ts`，落 localStorage）。以前只活在账本页，
从「账本 3 月」切到「本月」会突然跳回当月——这是整个产品最容易记错账的地方。

### 账本的位置记忆
无限滚动下不能一次性 `scrollTo`（浏览器会静默截断超���已加载高度的位置），改为记「目标位置」，
每次分页渲染完试一次、高度不够就补页。两个坑写进注释：存位置必须在 `onBeforeRouteLeave`
（router 会先把新页面滚到顶部才卸载旧组件，`onUnmounted` 里读到的是 0）；
路由的 `scrollBehavior` 对账本返回 `false`，否则会和组件自己的恢复逻辑打架。

### 服务端：AI 解析加机械校验层
prompt 让模型判断「这是不是一笔交易」，**代码**判断「这个数字站不站得住」。分工依据是实测：
- 线上 1419 条解析日志里，**41% 的交易描述是渠道名**（`微信支付`×98）而不是买了什么——
  根因是通知里就没有商户名（`微信支付 已支付¥876.90`），换模型变不出来
- 成功解析耗时中位数已从 20.3s 降到 4.0s（provider 提速，近三周稳定），**延迟不再是瓶颈**
- `quick-parser` 对通知流命中率 **6/1419 = 0.4%**：同义词表是给「午饭32」手打设计的，
  通知的描述是渠道名，词形不重叠；44% 还卡在「长度 > 30 字」（通知中位数 30 字）

- **新增 `ai/verify.ts`**：入站分档（省 24~26% 模型调用，实测 1419 条里 0 误杀真交易）、
  噪声形态识别、金额佐证、卡号尾号防误当金额、`共N笔` 总额防平摊
- **新增 `lib/parse-landing.ts`**：服务端**自己**判断解析结果有没有进账本（短 TTL 指纹关联，
  命中 70%、92% 唯一，P50 间隔 0.2 分钟）。此前 `final_items` 845 条全空、`user_modified` 恒为 0，
  `ai_memories` 零行——服务端的自我学习回路从来没被触发过
- **新增 `lib/parse-filter.ts` + migration 012**：`ai_parse_filters` 独立表记录「没调模型」的事件，
  不污染 `ai_parse_logs` 的空结果率。**不重建 `ai_parse_logs`**——为加一个枚举值去 DROP+RENAME
  一张 1419 行的表收益不抵风险
- **修 `prompts.ts` 的老 bug**：指令写「只输出 JSON 数组」但示例给的是单个对象 `{...}`，
  模型照示例走返回对象 → `extractJsonArray` 抛错。**实测导致约 25% 的真账解析失败**，
  且与促销规则无关，一直存在
- **修 `extractJsonArray` 双重解码**：模型偶尔把整个数组再包一层 JSON 字符串，约 1/8 概率
- **prompt 补两条规则**：「汇总类总额不可按笔数平摊」+「识别不出交易就返回空」——
  加完后噪声用例 8/8 返回 `[]`，真账 18/18 正确
- **`utils/money.ts` 统一 `num()` 兜底**：接口少给字段时不再出现 `¥NaN.`

### 修复：登出不清本地持久化
`logout()` 原先只删 token。`bill.period`（localStorage，跨登出存活）、`bill.ledger-state`
与 `bill.quick-draft`（sessionStorage，含**用户输入的搜索词与未提交草稿**）都不清——
自部署共用设备时 A 登出 B 登录，B 会继承 A 的输入内容。现已全部清理，键名收敛为单一来源。

- **设计语言重建**：从「暖奶油底 + 靛蓝圆角卡片」改为「账本纸」——结构由发丝线与表格行承载，颜色只表达含义（收/支/警/信息），主操作为石墨实底而非品牌色。完整规格见 `docs/UI-DESIGN.md`
- **墨色拆成两个角色**：`--color-ink-1` 只用于文字（近黑），大面积填充改用 `--color-action`（石墨 `#39434b`）——纯黑填充块在大片浅纸上压版面
- **新增 15 个原子组件**（`web/src/components/ui/`）：`Money` `PageHeader` `LedgerLabel` `StatTile` `Meter` `SegmentedControl` `PeriodNav` `BaseModal` `Notice` `EmptyState` `Skeleton` `SheetRow` `AppIcon` `ToastHost` `ConfirmHost`；原 `EmptyState` / `Skeleton` / `TodayList` 删除
- **深色模式**：`prefers-color-scheme: dark` 全站自动生效；新增 `--color-action-fg` / `--color-on-tone` 前景色 token（否则深色下 action 变亮、硬编码 `#fff` 会白底白字）
- **图表配色**：`utils/chart.ts` 统一处理 canvas 不认 CSS 变量 / `var()` / `color-mix()` 的问题，并在配色方案切换时自动重绘
- **原生弹窗全部替换**：`confirm()` → `useConfirm()` + `ConfirmHost`（文案说明后果，危险操作用描边红）
- **响应式**：手机吸顶报头 + 底部 5 槽 + 凸起 FAB；320px 起无横向溢出（修掉 `PageHeader` 吸顶负边距 `-1.5rem` 超出容器 `1rem` 内边距导致的 8px 溢出）

### 信息架构：按真实使用频率重构
三个月真实数据（550 笔交易、87/90 活跃天）：`budgets` / `financial_goals` / `subscriptions` / `ai_memories` / `asset_snapshots` 五张表**均为 0 行**；调用日志里 91% 的记账来自通知快捷入口。据此：
- **落地页改为记账**：`/` 从 Dashboard 改为记账页（原 `/quick` 重定向到 `/`）；原 Dashboard 移到 `/overview`，定位为「本月结算单」
- **导航分层**：一级只留「记一笔 / 账本 / 本月 / AI 助手」，其余收进「偶尔」分组；移动端底栏改为「账本 / 本月 / FAB 记一笔 / 助手 / 我的」
- **下线 5 个零使用功能**（Web 端）：预算、财务目标、订阅管理、AI 记忆、资产快照；删除 `Budget.vue` `Goals.vue` `Subscriptions.vue` `api/goals.ts`，并从 Dashboard / Home / Me / Settings / Assets 中移除相关区块
- **后端接口与数据表暂时保留但标记 `deprecated`**：`/api/budgets/*` `/api/goals/*` `/api/subscriptions/*` `/api/memories/*` `/api/assets/snapshot|/trend`。`GET /api/stats/dashboard` 响应结构不变（那三个字段仍返回空数组），避免影响已发布客户端；旧 Web 路由 302 到 `/me` 而非 404
  - 依据：Android 侧 `BudgetApi` / `BudgetRepository` / `BudgetResponse` / Hilt 绑定四层数据链路齐备，但 `presentation/` 层**零引用**——即「数据层写全了，UI 入口从未存在」。标 deprecated 而非“保留”，是为了避免下一个读到代码的人误以为该功能还在被使用

### Found（功能体检发现，待处理）

功能取舍体检（`scripts/feature-triage.sh`）发现三个「0 行 ≠ 没用」的反例，详见 `docs/FEATURE-TRIAGE.md §7`：

1. **`user_settings` 不是废弃旧表**：与 `settings` 同在 migration001 创建，用途不同（全局 KV vs 用户级偏好），
   写入路径 `PUT /api/settings` 活跃且正确。0 行只是没人保存过偏好。**差点被误判成重构遗留而误删。**
2. **`ai_memories` 表不能随 `/api/memories/*` 一起删**：被 AI 解析主流程活跃读写
   （`ai.ts:150` 注入 prompt、`ai.ts:380-397` 自动学习、`ai.ts:530` AI 问答）。只下线路由，表保留。
3. **AI 自动学习链路从未接通**（真实 bug）：`POST /api/ai/parse-feedback` 在 `app_logs` 中零记录，
   `ai_parse_logs.user_modified` 1415 条全 0，导致管理面板「修正率」**恒为 0%**。
   看上去像「用户从不修正」，实际是客户端没回传反馈：Android 端（91% 流量）完全未调用该接口，
   Web 端受 `if (parseLogId.value)` 限制也未触发过。
   **后果是误导性的**：管理者看到修正率 0% 会以为 AI 解析质量很好，结论完全相反。
   修复方向在客户端（用户修正解析结果后回传），需要与 Android 端协同排期。

### Fixed
- **SPA 深链 500**：`@fastify/static` 用 `decorateReply:false` 注册后 `reply.sendFile` 不存在，导致 `/quick` `/ledger` 等任何非根路径硬刷新返回 **HTTP 500**（`GET /favicon.ico` 同）。改为自行读文件流发送；`/favicon.ico` 改为 302 到图标
- **改密后被静默踢下线**：`auth` store 定义了 `setAuth` 但未 return，`Settings.vue` 调用 `auth.setAuth()` 必抛 `TypeError`，新 token 写不进 localStorage。现已导出
- **支出显示为正数**：`Money` 组件的 `sign="auto"` 按数值正负取号，支出（红色）会渲染成 `+¥456.00`。改为按语义色取号：支出恒 `-`、收入恒 `+`
- **标签渲染成原始 JSON**：账本直接把 `tags` 字段（JSON 字符串）插值，显示为 `#["吃的","多喝水"]`。改为解析成数组，最多展示 2 个 + `+N`
- **悬空分隔符**：日期无时分秒时元信息行渲染成「餐饮 · 」

### Refactor（行为不变）
- **日期口径收拢**：新增 `lib/date.ts`（`monthRange` / `prevMonthRange` / `today` / `dateOffset` / `toDateStr`），替换 stats / budget / transaction 中重复的 6 段“算月首月末日”代码；统一走本地时区
- **预算阈值收拢**：新增 `lib/budget.ts`（`WARN_PERCENT=80` / `OVER_PERCENT=100` / `budgetStatus` / `budgetProgress`），替换 3 处重复的百分比与状态判断
- **消除重复聚合**：`stats/dashboard` 不再为资产分布重跑一遍与净资产完全相同的聚合 SQL，改为对已查出的账户行内存分组（验证与 `assets/overview` 的独立实现结果一致）
- **消除预算 N+1**：`GET /api/budgets` 原来每条预算各查一次支出，改为一次 `GROUP BY` 预取
- **金额格式化收拢**：新增 `web/src/utils/money.ts`（`formatAmount` / `formatYuan` / `formatCompact` / `centsToYuan` / `yuanToCents`），替换 11 个 `.vue` 中各自复制的一份 `(cents/100).toFixed(2)`，并把 Dashboard / Assets / Goals 的重复实现改为复用
- **删除死代码**：`lib/response.ts` 中从未被调用的 `success()` / `fail()`、`lib/error-codes.ts`（常量表零引用，权威表在 docs/API.md §0.3）、`auth.service.ts` 的 `disableUser()`（逻辑已在 admin 路由内联）、`AccountManager.vue` 的 `formatBalance()`、3 处未使用变量（TS6133）、5 个已空目录的 `.gitkeep`
- **统一净资产口径**（新增 `lib/assets.ts` `summarizeNetWorth`，两接口共用）：`/api/stats/dashboard` 与 `/api/assets/overview` 曾对“总负债”用两套口径——总览页说 ¥800、资产页说 ¥1300，且 dashboard 的口径违反会计恒等式。现在统一为“负余额计负债、正余额计资产”，并顺带修掉“按 asset_type 分组后取绝对值”导致信用卡溢缴款抵消其他卡欠款的问题；dashboard 补上 `total_assets`
- 新增 `tests/lib/helpers.test.ts`（12 例）覆盖 date / budget / assets 三个公共模块，新增 `tests/routes/networth.test.ts`（5 例）做两接口交叉一致性断言

### Fixed
- **删除用户必 500**：`DELETE /api/admin/users/:id` 的删除顺序违反外键约束（`subscriptions` / `financial_goals` 未先删、`categories`/`accounts` 早于子表删），只要用户用过订阅或财务目标就会 `SQLITE_CONSTRAINT_FOREIGNKEY`。改为声明式有序表（`USER_SCOPED_TABLES`，依赖倒序）+ `created_by` 置空 + 可读错误兜底
- **CSV 导入 >50 条整批失败**：批量上限 50→200，前端按 100 条分片提交，单片失败不再中断其他片（此前一条非法数据会导致整批回滚，真实账单场景不可用）
- **导入记录丢失分类**：解析时按商户关键词预填分类（新增 `lib/import-matcher.ts`），此前 `category_id` 恒为 NULL，导致分类统计（`JOIN categories`）、分类预算回溯、AI 分类分析均看不到导入数据
- **导入无去重**：新增同 `user + type + amount + date + description` 重复检测（对比已有记录 + 批次内部，回收站不计），预览页默认跳过重复项并可勾选包含
- **改密后当前设备被静默踢下线**：`PUT /api/auth/password` 现在为当前设备换发新 token（`data.token`），旧 token 仍按 `token_version` 失效，其他设备行为不变
- **AI 聊天丢失最近上下文**：历史消息改为 `ORDER BY id DESC LIMIT 20` 后反转（此前取的是最早 20 条，超过 10 轮后模型看不到最近对话）；`GET /api/ai/sessions` 的 `first_message` 改用 `MIN(id)` 关联子查询（`MIN(content)` 是字典序最小而非时间最早）
- `POST /api/import/csv` 参数校验失败的错误码由 `1` 统一为 `2000`（原先不在错误码表内）

### Added
- **CHANGELOG.md**（本文件）
- 账单导入支持分类预填 + 重复标记 + 逐行改分类 / 批量归类
- 测试：新增 `tests/routes/admin.test.ts`（9）、`tests/routes/import.test.ts`（16）、`tests/routes/ai-chat.test.ts`（5），`auth.test.ts` 补充 2 例；总计 96 → 128

### Security
- **CORS 白名单**：通过 `CORS_ORIGINS` 环境变量配置，默认 `localhost:5173,localhost:3000`
- **JWT 撤销机制**：新增 `users.token_version` 字段（migration 009）；改密 / 重置密码 / 禁用用户自动 bump，旧 token 立即失效（O(1)，无黑名单查询开销）
- **限流**：登录 / 注册 `5/分钟`，AI 路由 `20/分钟`
- **bcrypt cost 10 → 12**
- **AI prompt 注入防护**：用户输入 `<user_input>` 标签包裹；system prompt 显式声明忽略内部指令；`ai_memories` 注入只取 `source='manual'`
- **新增错误码 `1006`**：令牌已失效（密码已修改或账号已重置）

### Performance
- 修复 `assets.ts` 净资产 N+1：原每账户 4 次 SELECT → 单条聚合 `LEFT JOIN GROUP BY`
- 修复 `stats.ts` `analysis` 4 月循环查询：原 4 次循环 → 单条 `GROUP BY substr(date,1,7)`
- 修复 `stats.ts` `dashboard` / `analysis` 净资产相关子查询：单条聚合
- migration 010：DROP 4 个冗余单列索引 + 新增 `idx_subscriptions_due` partial index

### Changed
- **docs 精简**：7 份 → 5 份（120KB → 60KB，-50%）
  - 新增 `ARCHITECTURE.md`（合并 PRD + DEVELOPMENT）
  - 新增 `DATA.md`（合并 DATABASE + WORKBENCH 数据模型）
  - 重写 `API.md`（覆盖全部 80 端点）
  - 精简 `CONTRIBUTING.md` / `TESTING.md`
  - 删除 `PRD.md` / `DATABASE.md` / `DEVELOPMENT.md` / `WORKBENCH.md` / `WORKSTATION_UPGRADE.md`
- 新增 `scripts/gen-api-docs.ts`：从 routes/*.ts 自动生成端点表
- 新增 `server/src/lib/response.ts` + `error-codes.ts`：统一响应包装 helper
- 全局 `onSend` 钩子：自动包装未包装响应；跳过 `/health`、文件下载、静态资源

### Removed
- 前端死代码清理：`views/Transactions.vue` / `Stats.vue` / `Analysis.vue` / `Memories.vue`（已被 `/ledger` 替代）
- 前端未引用组件：`components/Toast.vue` / `ConfirmModal.vue`

### Fixed
- `App.vue:90` 双层 `.value.value` 解包 bug
- `router/index.ts` 守卫绕过 Pinia 直接读 localStorage → 改用 `useAuthStore().token`
- onSend 钩子保护 `/health`（避免破坏外部探针）和 `Content-Disposition: attachment` 文件下载

### Added
- `CHANGELOG.md`（本文件）

### Migration
- DB 自动应用 migration 009（token_version）和 migration 010（清理索引 + 新 partial index）
- 不需要手动操作

---

## [v0.3.2] - 2026-08-26

### Fixed
- 管理面板手机端菜单适配
- 容器构建网络问题 + 代理参数化

## [v0.3.1] - 2026-08-26

### Fixed
- 现有功能完善（7 项问题修复）

## [v0.3.0] - 2026-08-26

### Added
- 管理面板改为左侧菜单 + 右侧内容布局
- 资产全景页（`/api/assets/*`）
- 财务目标页（`/api/goals/*`）

## [v0.2.x] - 2026-07~08

### Added
- 订阅管理（`/api/subscriptions/*`）
- AI 全局记忆（`/api/memories/*`）
- Financial Analysis（过去/现在/未来三维度）
- Dashboard 仪表盘（净资产 / 趋势 / 异常提醒）
- 通知记账规则云控（`/api/config/notification-rules`）

## [v0.1.0] - 2026-07-08

### Added
- 核心功能：注册/登录、AI 记账、手动记账、流水列表
- 统计概览、预算管理
- CSV 导入（微信 / 支付宝）
- 数据导出（JSON / CSV）
- 回收站（软删除 30 天保留）