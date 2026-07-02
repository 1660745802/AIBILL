# 项目开发规范

> 本文档定义项目从开发到部署的全流程规范，所有参与者必须遵守。
> 目标：代码可追溯、质量可控、协作无摩擦、项目可持续演进。

---

## 一、版本控制

### 1.1 分支策略（Git Flow 简化版）

```
main          ─── 生产分支，始终可部署，仅通过 PR 合并
  └── dev     ─── 开发主线，功能完成后合并到 main
       ├── feat/xxx   ─── 功能分支
       ├── fix/xxx    ─── 缺陷修复
       └── refactor/xxx ─── 重构
```

| 分支 | 用途 | 保护规则 |
|------|------|---------|
| main | 生产就绪代码 | 禁止直接 push，必须 PR + 测试通过 |
| dev | 日常开发集成 | PR 合并，允许 squash merge |
| feat/* | 新功能开发 | 从 dev 拉出，完成后 PR 回 dev |
| fix/* | Bug 修复 | 从 dev 拉出，紧急修复可从 main 拉 hotfix |
| refactor/* | 重构 | 从 dev 拉出，不改变外部行为 |

### 1.2 分支命名

```
feat/ai-parse          # 功能
fix/amount-precision   # 修复
refactor/db-layer      # 重构
docs/testing-plan      # 文档
chore/docker-config    # 工程配置
```

### 1.3 Commit 规范（Conventional Commits）

```
<type>(<scope>): <subject>

<body>（可选）

<footer>（可选，如 BREAKING CHANGE）
```

**type 枚举：**

| type | 说明 |
|------|------|
| feat | 新功能 |
| fix | Bug 修复 |
| docs | 文档变更 |
| style | 格式调整（不影响逻辑） |
| refactor | 重构（不改变行为） |
| test | 测试相关 |
| chore | 构建/工具/依赖变更 |
| perf | 性能优化 |

**scope 参考：** server, web, ai, db, auth, transaction, stats, config

**示例：**
```
feat(ai): 实现记账解析 prompt 模板和 few-shot 示例
fix(transaction): 修复金额浮点精度丢失问题
refactor(db): 统一查询条件封装为 baseWhere 函数
test(auth): 补充邀请码过期场景单元测试
chore: 升级 fastify 到 v5.2
```

**规则：**
- subject 不超过 72 字符
- 使用中文或英文均可，但同一项目保持一致（本项目用中文）
- 每个 commit 只做一件事，禁止混合提交

### 1.4 Tag 与版本号

遵循 [Semantic Versioning](https://semver.org/)：`vMAJOR.MINOR.PATCH`

| 变更类型 | 版本号变化 | 示例 |
|---------|-----------|------|
| 不兼容 API 变更 | MAJOR | v1.0.0 → v2.0.0 |
| 新增功能（向后兼容） | MINOR | v1.0.0 → v1.1.0 |
| Bug 修复 | PATCH | v1.0.0 → v1.0.1 |

里程碑对应：
- M1 完成 → v0.1.0
- M2 完成 → v0.2.0
- M5 完成（可部署） → v1.0.0

### 1.5 禁止操作

- ❌ 直接 push 到 main
- ❌ force push 到公共分支（main / dev）
- ❌ commit 包含 .env、API Key、密码等敏感信息
- ❌ 单个 commit 超过 500 行变更（应拆分）
- ❌ merge commit 含未解决的冲突标记

---

## 二、代码规范

### 2.1 通用规则

- TypeScript strict 模式开启
- 禁止 any（必要时用 unknown + 类型守卫）
- 所有导出函数必须有 JSDoc 或 TypeScript 类型签名
- 文件不超过 300 行，超过则拆分
- 函数不超过 50 行，超过则提取子函数
- 禁止嵌套超过 3 层（提前 return / 提取函数）

### 2.2 命名规范

| 类型 | 风格 | 示例 |
|------|------|------|
| 文件名 | kebab-case | `category-matcher.ts` |
| 变量/函数 | camelCase | `getUserById` |
| 类/接口/类型 | PascalCase | `TransactionService` |
| 常量 | UPPER_SNAKE_CASE | `MAX_RETRY_COUNT` |
| 数据库字段 | snake_case | `user_id`, `created_at` |
| API 路径 | kebab-case | `/api/invite-codes` |
| 环境变量 | UPPER_SNAKE_CASE | `AI_BASE_URL` |

### 2.3 后端规范（Fastify）

```
routes/       → 路由定义 + 参数校验（JSON Schema）
services/     → 业务逻辑（无 HTTP 概念）
db/           → 数据访问（SQL 查询）
middleware/   → 中间件（auth、error handler）
```

- 路由层只做：参数校验 → 调用 service → 返回响应
- Service 层不依赖 request/reply 对象
- 数据库查询全部参数化（禁止字符串拼接 SQL）
- 所有业务查询默认带 `user_id` + `deleted_at IS NULL` + `status = 'confirmed'`

### 2.4 前端规范（Vue3）

- 组合式 API（Composition API）+ `<script setup>`
- 组件文件名：PascalCase（`ConfirmCard.vue`）
- 组件职责单一，超过 200 行考虑拆分
- 状态管理：Pinia store 按模块划分
- API 调用统一走 `api/` 目录封装，组件不直接 fetch
- 样式：TailwindCSS 优先，避免自定义 CSS（除非 Tailwind 无法表达）

### 2.5 工具链配置

| 工具 | 用途 | 配置 |
|------|------|------|
| ESLint | 代码质量 | @typescript-eslint + vue 规则集 |
| Prettier | 格式化 | 2 空格缩进、单引号、无分号、尾逗号 |
| Husky | Git hooks | pre-commit 运行 lint + format check |
| lint-staged | 增量检查 | 只检查暂存文件 |

```json
// .prettierrc
{
  "semi": false,
  "singleQuote": true,
  "trailingComma": "all",
  "tabWidth": 2,
  "printWidth": 100
}
```

---

## 三、数据库规范

### 3.1 Schema 变更流程

1. 新建 migration 文件：`migrations/002_add_budgets.sql`
2. 文件内容包含 UP（变更）语句
3. 应用层启动时自动检测并执行未应用的 migration
4. schema_migrations 表记录已应用版本
5. **禁止修改已应用的 migration 文件**，只能新增

### 3.2 SQL 编写规范

- 表名复数：`transactions`, `categories`, `accounts`
- 字段名 snake_case
- 主键统一 `id INTEGER PRIMARY KEY AUTOINCREMENT`
- 时间字段统一 ISO 8601 字符串
- 金额统一整数（分）
- 外键字段以 `_id` 结尾
- 必须有 `created_at`，可变记录加 `updated_at`
- 软删除用 `deleted_at`（NULL = 有效）

### 3.3 索引规范

- 高频查询字段必须有索引
- 复合索引注意列顺序（高选择性在前）
- 索引命名：`idx_<表名>_<字段名>`

---

## 四、依赖管理

### 4.1 规则

- 使用精确版本号（`"fastify": "5.2.1"`），禁止 `^` 或 `~`
- 新增依赖需说明理由（PR 描述中注明）
- 优先选择：维护活跃、周下载量 > 10k、无已知漏洞
- 每月定期审查依赖更新（`npm outdated`）
- 禁止引入功能重叠的依赖

### 4.2 lock 文件

- `package-lock.json` 必须提交到仓库
- 禁止手动修改 lock 文件
- CI 使用 `npm ci`（而非 `npm install`）

---

## 五、环境与配置

### 5.1 环境分离

| 环境 | 用途 | 配置文件 |
|------|------|---------|
| development | 本地开发 | .env（不提交） |
| test | 自动化测试 | .env.test（内存 SQLite） |
| production | 生产部署 | docker-compose 环境变量 |

### 5.2 敏感信息

- `.env` 已加入 `.gitignore`
- 提供 `.env.example` 作为模板（值为空或示例值）
- API Key、JWT Secret 等绝不出现在代码或提交历史中
- 如果不慎提交敏感信息：立即轮换密钥 + 通知相关方

---

## 六、测试规范

### 6.1 测试必须覆盖

- 所有 service 函数（单元测试）
- 所有 API 路由（集成测试）
- 核心用户流程（E2E 测试）
- 新增功能必须同步提交测试，PR 无测试不合并

### 6.2 测试文件组织

```
server/
  src/
    services/transaction.service.ts
  tests/
    unit/transaction.service.test.ts
    integration/transaction.route.test.ts

web/
  src/components/ConfirmCard.vue
  tests/
    components/ConfirmCard.test.ts
  e2e/
    quick-record.spec.ts
```

### 6.3 测试命名

```typescript
describe('TransactionService', () => {
  describe('create', () => {
    it('应创建单条支出记录并返回完整数据', () => {})
    it('相同 client_id 应返回已有记录（幂等）', () => {})
    it('transfer 类型 category_id 应为 null', () => {})
  })
})
```

---

## 七、文档规范

### 7.1 必须维护的文档

| 文档 | 内容 | 更新时机 |
|------|------|---------|
| README.md | 项目简介、快速启动、部署方式 | 功能/部署变更时 |
| docs/PRD.md | 产品需求 | 需求变更时 |
| docs/DATABASE.md | 数据库设计 | Schema 变更时 |
| docs/DEVELOPMENT.md | 研发方案 | 架构/技术决策变更时 |
| docs/TESTING.md | 测试方案 | 测试策略变更时 |
| docs/CHANGELOG.md | 版本变更记录 | 每次发版时 |
| .env.example | 环境变量模板 | 新增配置项时 |

### 7.2 CHANGELOG 格式

```markdown
# Changelog

## [v0.2.0] - 2026-07-15

### Added
- 统计页面：月度趋势图、分类饼图

### Fixed
- 金额小数点精度丢失问题

### Changed
- AI 解析超时从 15s 调整为 10s

## [v0.1.0] - 2026-07-08

### Added
- 用户注册/登录（邀请码机制）
- AI 快速记账 + 确认卡片
- 手动记账表单
- 交易流水列表
```

---

## 八、安全规范

### 8.1 代码安全

- SQL 全部参数化，禁止字符串拼接
- 用户输入全部校验（JSON Schema / zod）
- 前端渲染用户内容时转义 HTML
- 密码存储使用 bcrypt（cost ≥ 10）
- JWT 签名密钥 ≥ 32 字符随机字符串

### 8.2 API 安全

- 所有接口（除 register/login）需 JWT 认证
- admin 接口额外校验 role
- 频率限制：登录接口 5次/分钟，AI 接口 20次/分钟
- 响应不暴露系统内部信息（数据库错误、堆栈）

### 8.3 数据安全

- 用户间数据完全隔离
- 软删除保留 30 天，支持恢复
- 备份文件权限 600（仅 owner 可读写）
- 生产环境禁止开启 debug 日志

---

## 九、发布流程

### 9.1 发版步骤

```
1. dev 分支功能冻结，全部测试通过
2. 更新 CHANGELOG.md
3. 更新 package.json version
4. 创建 PR：dev → main
5. Review + CI 通过 → Merge
6. 在 main 打 tag：git tag v0.1.0
7. 构建 Docker 镜像并推送
8. 部署到生产环境
```

### 9.2 回滚策略

- Docker 部署保留最近 3 个版本镜像
- 数据库 migration 只增不改，回滚需手动（谨慎操作）
- SQLite 备份在发版前自动执行
- 回滚命令：`docker-compose up -d --force-recreate` 指定旧版本镜像

---

## 十、协作约定

### 10.1 PR 规范

- 标题遵循 Commit 规范格式
- 描述包含：变更内容、影响范围、测试方式
- 单个 PR 不超过 400 行变更（大功能拆多个 PR）
- 自测通过后再提 PR

### 10.2 代码审查

- 关注：逻辑正确性、安全隐患、性能问题、可维护性
- 不关注：格式问题（交给工具）
- 审查意见分级：
  - 🔴 Must Fix（阻塞合并）
  - 🟡 Suggestion（建议优化）
  - 💬 Question（讨论）

### 10.3 TODO 管理

- 代码中的 TODO 必须关联 issue 或说明原因
- 格式：`// TODO(username): 描述 - #issue_number`
- 禁止无限期 TODO，定期清理
