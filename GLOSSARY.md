# 术语表（GLOSSARY）

> 领域语言与架构词汇的唯一真源。**代码、文档、提交信息、评审**都用这里的名字。
> 新增概念先在此登记，再在代码里使用；同一个概念不另起第二个名字。
> （同步纪律见 [docs/ARCHITECTURE.md §8](docs/ARCHITECTURE.md)。）

## 记账领域

| 术语 | 含义 | 归属（interface / 实现） |
|---|---|---|
| **入账（记一笔）** | 让一笔收支成为事实：`POST /api/transactions` 落 `transactions` 行（`status='confirmed'`） | `routes/transaction.ts` |
| **记录 / 流水** | `transactions` 表的一行。金额一律整数分、日期北京时间 | `db/schema.ts` |
| **待审池 / needs_review** | AI 有结果但信息不完整（分类未精确命中 / 金额仅裸数字 / 佐证未过），**不自动入账**、等用户确认。阈值**只在服务端一处实现** | `lib/parse-extract.ts` 的 `deriveReviewMeta` |
| **归类（category resolution）** | 模型给的分类名 → 用户真实存在的 `category_id`。硬不变量：落地的 id 必属于该用户的活跃分类，否则 `null`（绝不编造） | `ai/category-matcher.ts` 的 `resolveCategory` |
| **判据（criteria）** | 「这是不是一笔账 / 这个数字站不站得住」的确定性判定。跨层词表不得互相矛盾，发布期 fail-fast | `ai/verify.ts`、`ai/noise-terms.ts`、`ai/criterion-consistency.ts` |
| **规则真源** | 客户端预筛词表/包名/窗口参数的唯一内容真源：`server/config/rules.json`。经 `content_hash` 派生 ETag 下发，客户端凭代际重拉 | `lib/notification-rules.ts` |
| **预筛（prefilter）** | 调模型**之前**「值不值得当一次账」的判定链。命中噪声 → 记 `ai_parse_filters`，不烧模型 | `ai/verify.ts` 的 `classifyNotification` |
| **解析落地（parse landing）** | `/ai/parse` 的返回值与 `/transactions` 真正写进去的行之间的关联：按 `(type, amount, date)` 指纹回填 `parse_log_id` / `ai_raw_input` / `final_items` | `lib/parse-landing.ts` |

## 解析装配（ParseAssembly）

| 术语 | 含义 | 归属 |
|---|---|---|
| **解析装配（ParseAssembly）** | 「候选 → 响应 item」的唯一实现：归类、分类行回查、账户匹配、§6 机械字段、needs_review/confidence、噪声审计。两条入口（quick/ai）各自产出候选后一律走这里 | `lib/parse-assembly.ts`：`resolveItems` / `finalizeItems` |
| **候选（candidate）** | 尚未装配的一条解析结果，归一到 `AssemblyCandidate`：`type/amount(元)/category/description/date/account/target_account` | `lib/parse-assembly.ts` |
| **出站校验（verifyParsed）** | 装配两阶段之间对「确定是噪声」的整批 / 逐项判定。`drop` → 换成 `postfilter` 响应（另一条出口）。**是 ai 路径的策略，不在装配模块内** | `ai/verify.ts` |

## 架构词汇（codebase-design 口径）

| 术语 | 含义 |
|---|---|
| **module** | 有明确 interface、把实现藏在背后的一段代码。**不说** component / service / unit |
| **interface** | 调用方需要知道的那一小片。**不说** API / signature |
| **深度（depth）** | interface 比实现小多少。深 = 小 interface 藏大实现；浅 = interface 与实现一样复杂 |
| **seam** | 可替换实现的位置（换 adapter 不改调用方）。**不说** boundary |
| **adapter** | seam 上的一个具体实现（生产 vs 单测） |
| **leverage** | 一个 interface 服务 N 个调用点 |
| **locality** | 一个概念只在一处，改它只动一处 |
| **deletion test** | 删掉这段代码，复杂度是**集中**了还是只是**搬家**了？集中 = 该删 |
