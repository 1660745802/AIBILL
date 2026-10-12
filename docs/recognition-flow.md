# 自动记账识别 · 跨端契约 v1（服务端 ⇄ Android）

> 双边共享，**改契约先改这里**。实现真源（服务端）：`routes/ai.ts`、`ai/prompts.ts`、`ai/verify.ts`、
> `lib/parse-filter.ts`、`routes/notification-rules.ts`、`db/schema.ts`。状态：v1（2026-10）。

## 0. 术语与字段命名（先定名，避免同义两套）
| 名 | 含义 |
|---|---|
| tier | `classifyNotification` 档位：0 强/弱噪声、1 金额+动词、2 仅金额、3 仅动词、4 无信号 |
| 入站预筛 | tier 0/4 → **不调模型**；出站佐证 = tier 2/3 的模型结果需过 `verifyParsed` |
| `channel` | **入口归因**：`nls`｜`sms`｜`a11y`｜`manual`；`input` = 解析正文（唯一必填） |
| `source` | **来源应用**：`{ package_name, source_name? }`。⚠️ 不要用它表示入口，会和 `channel` 撞名 |

## 1. `POST /api/ai/parse` 响应有 8 种形态（客户端必须按形态分支）
请求：`{ input: string(1..3000) }`（扩展见 §5）。限流 20/min。

| # | 触发 | HTTP | code | data | parse_log_id |
|---|---|---|---|---|---|
| 1 | 入站预筛挡下 | 200 | 0 | `{items:[], raw_input, source:'prefilter'}` | 无 |
| 2 | 快捷正则解析 | 200 | 0 | `{items, raw_input, parse_log_id, source:'quick'}` | `data` |
| 3 | 出站判定为噪声 | 200 | 0 | `{items:[], raw_input, source:'postfilter'}` | 无 |
| 4 | 模型解析成功 | 200 | 0 | `{items, raw_input, parse_log_id}` | `data`（`source` 缺失，§6 补 `'ai'`） |
| 5 | 模型空结果 | 200 | 5001 | `null`（`fallback:'manual'`） | **顶层** |
| 6 | AI 超时 / 上游错误 | 504 / 502 | 5001 | `null`（`fallback:'manual'`） | 无 |
| 7 | 响应格式异常 | 200 | 5002 | `null`（`fallback:'manual'`） | 无 |
| 8 | 入参校验失败 | 400 | 2000 | `null` | 无 |

- ⚠️ #1/#3/#6/#7 **没有 parse_log_id**（无 `ai_parse_logs` 行）→ **不存在可反馈对象**，不要回传；判失败要看 `code`/`fallback`，**别只看 HTTP**（#5/#7 是 200）。

## 2. 反馈闭环（Q1）—— 双方优先做，服务端已确认可做
`POST /api/ai/parse-feedback`（认证）：
```jsonc
{
  "parse_log_id": 123,      // §1 取得（data 或顶层）
  "final_items": [ /* 用户确认后的**最终态**数组，元素同 parse items 形状 */ ],
  "modified": true,         // 与 AI 原始是否不同（服务端只信这个布尔，不自行 diff）
  "channel": "nls"          // 可选归因（见 §0）
}
```
- **客户端传「用户改后的 items」**（最终态），不是 AI 原始、不是补丁：**删除整笔 = 该项不在 `final_items` 里**，新增 = 多出的项，改字段 = 直接是新值；`modified=false` + 传 items 也接受（语义：确认无误）。
- 响应 `{code:0,data:null}`；记录不存在/不属于当前用户 → 404 `3002`。
- 服务端行为：写 `ai_parse_logs.final_items / user_modified / modification_detail`；`modified=true` 时
  尝试自动学习 `ai_memories(source='ai_suggested')`（**不会**注入 prompt，防自我污染）。
- ⚠️ **服务端先修**：自动学习按 **index 配对**（`Math.min(original.length, final.length)`），
  条数不等（删/增）时会**错配并学到错误记忆**。修法：条数不等时不学习。

## 3. 规则同源下发（Q2）—— ④ 与 ⑤ **必须同批做**
- **不做映射表**（客户端已证伪）：客户端预筛是**另一套分类学**（自身通知/系统分组摘要/日报汇总/单包熔断/DB 去重），服务端是 tier 档位链；强行映射只会得到**第三种口径**。所以先做 ④（下发服务端判据），客户端命中即用**同一 `rule_id`** 计数 → ⑤ 天然同口径。
- 客户端**独有**的拦截用 `client_only.<name>` 上报，**明确标注「服务端无对应判据」、不参与误杀率比较**。
- `precheck` **由 `ai/verify.ts` 常量在发布时派生注入**（**不写在 rules.json 里**，避免手抄漂移）；`content_hash` 覆盖**已发布 payload（含 precheck）** → 代码里改判据也会换 hash、客户端会重拉。
- ⚠️ 本判据 **channel 无关**（服务端不分区 nls/sms/a11y）；客户端可在其之前先做自己的渠道门禁（那些计入 `client_only.*`）。⚠️ 因此 `a11y/sms` 词表（渠道门禁）与 `STRONG_NOISE/WEAK_NOISE`（服务端判据）是**两个层次**，重叠词条不是 bug；新增词条时先问一句：**这是渠道门禁，还是服务端判据？**（前者进 `rules.json`，后者进 `ai/verify.ts`）。
| rule_id（稳定，跨端同名） | tier | 语义（客户端要按它计数并解释「为什么没调 AI」） |
|---|---|---|
| `precheck.strong_noise` | 0 | 纯噪声 regex 命中 → 不调模型（验证码/广告/系统提示） |
| `precheck.money_verb` | 1 | 金额 + 交易动词 → **一定**调模型 |
| `precheck.weak_noise` | 0 | 弱噪声 regex，**仅在无正向信号时**才拦（顺序即语义） |
| `precheck.money_only` | 2 | 只有金额 → 调模型，但出站需**金额佐证** |
| `precheck.bare_amount` | 2 | 短句（≤30 字）光杆数字（「午饭32」） |
| `precheck.verb_only` | 3 | 只有交易动词 |
| `precheck.no_signal` | 4 | 无任何信号 → 不调模型（兜底，排最后） |
- **已实现**（本地）：payload = `precheck{schema:1, derived_from, channel_agnostic, signals{money{pattern,flags},verb{pattern,flags},bare_amount{pattern,flags},bare_amount_max_len:30}, rules[14 条], should_call_ai:"tier in (1,2,3)", corroboration_required:"tier in (2,3)"}`；`schema` 不认识 → 整体忽略并降级用本地词表。**`rule_id = 'precheck.' + 服务端 reason`（逐字拼接，`+` 也不改名）**→ ⑤ 对账是机械前缀剥离，不是映射表。
- **拦不拦怎么判（客户端勿猜）**：按 `rules[]` **顺序取第一条命中**，只看它的 `tier`：`tier ∈ {1,2,3}` = 放行去调模型（即 `should_call_ai`），`tier ∈ {0,4}` = 拦。⚠️ **没有 `tier:null` 的条目**（早期草案里的 `precheck.payment_verb` 已删除）；`type:'predicate'` 用 `expr` 引用 `signals`，`type:'fallback'` 是兜底（排最后）。`pattern` 是**不含分隔符的正则源码**，必须与同条 `flags` 一起编译（仅允许 `g`/`i`/`m`；**`money` 是 `gi`**——丢了会让 `rmb 100` 两端不一致）。
- **`bare_amount_max_len` 精确定义**：取客户端发来的 `input` **原串**（不是 title/body），`input.trim().length <= 30`；长度按 **UTF-16 code unit** 计（中文=1、emoji=2）——**Kotlin `String.length` 同口径**，直接可比。
- **`expr` 语法边界（客户端按封闭小语法实现，不要写表达式解析器）**：只允许三种形态——`signal`、`signal && signal`、`len<=<int> && signal`（`signal` 必须是 `signals` 的键；分隔符统一为**前后各一个空格**的 ` && `）。**其余形态客户端必须忽略该条规则 + 记日志 + 计入 `precheck_unknown_expr`**（fail-safe：绝不当成「命中」或「不命中」来猜）。服务端用回归用例保证只产出上述三种（并校验引用的 signal 存在）；将来要扩形态必须**先改本契约并播报**。
- **只覆盖入站**：`precheck` 是「调模型之前」的判据；出站佐证（`verifyParsed` 的 drop 理由）在模型调用后才产生，客户端算不出来，故不在清单、也不参与 ⑤ 对比。
- ⚠️ 正则交集子集（**本轮修正**）：**允许有界 lookaround**（单字符类，如 `(?<![\d.])`、`(?!\d)`——服务端自己的判据就在用，且 Java 的定长 lookbehind 能表达）；**禁变长 lookbehind**（`(?<=a+)`，JVM 编译不过）/ 命名组 / `\p{}` / possessive / 内联 flags。服务端**启动时校验**，且**派生出的正则自己先过一遍**（有回归用例自证）。文件与 admin POST **两条发布路径都注入 precheck**（否则激活 admin 版本会让客户端丢掉整个判据）；文件里手写 `precheck` 直接 400。

## 4. 拦截计数上报（Q3）—— **已实现**（`POST /api/ai/filter-report`，认证，限流 20/min）
- **不复用 `ai_parse_filters`**：那张表是「服务端挡了哪些」的**逐条事件**（DATA §10.4）；客户端上报是按窗口**聚合计数**且带客户端维度，混在一起「服务端 53%」就不可比。新表 `client_filter_stats` + `client_filter_totals`（migration021）。
- 请求：`{window_start, window_end, client_version, channel, counts:[{rule_id,count}], totals:{notifications,blocked}}`。`channel` **必填**（nls|sms|a11y|manual）且**进幂等键**（SQLite 唯一索引里 NULL 互不相等，允许 NULL 会让重复上报变多行）。
- **窗口**：可解析、`start<=end`、跨度 ≤31 天；**无时区串按北京时间解释**（项目「今天」口径），存储与去重统一为 **UTC** `YYYY-MM-DD HH:MM:SS` → 所以 `2026-10-12T00:00:00+08:00` 与 `2026-10-12 00:00:00` 是**同一个键**。⚠️ 别用 `Date.parse` 直接归一：它对无时区串按**本机时区**解释（容器跑 UTC 就差 8h）。
- **幂等 = 覆盖**：同 (user, client_version, channel, 窗口, rule_id) 重复上报**改写** hits 而非累加 → 客户端可放心重试。
- `rule_id` 只允许 `precheck.*`（可比）或 `client_only.*`（服务端无对应，不可比）；**第三个前缀 400**。回执 `{accepted, unknown_precheck_ids}`——后者是「你的清单与我当前清单不一致」的**漂移信号**（收下但标出，不拒绝）。
- 约束：`counts` 1..200 条、`blocked <= notifications`；超限一律 400（不静默截断）。
- **admin 对照视图**：`GET /api/admin/filter-stats?days=30` → `client.by_rule[{rule_id,namespace,comparable,hits}]` + `client.by_channel/totals(block_rate)` + `server.by_reason`（**只含入站** reason，出站不在 precheck 范围）。⚠️ **不返回「误杀率」**：它必须靠语料 `expect_txn` 判定，用计数相减算出来的是编的（视图 `note` 里明说）。
- `client_only.*` = **客户端独有判据 + 诊断计数**（服务端无对应判据，**不可比**）；id 语义由**客户端维护**，此处为 2026-10 快照（`self_notification` 自身通知 · `duplicate_content` 5s 内容去重 · `blank_text` 空正文 · `system_group_summary` 系统分组摘要 · `summary_report` 日报/区间合计 · `promo_sentence` 促销句式 · `marketing` 营销词且无强交易特征 · `not_financial` 账务判据未过 · `ai_memory` 5min 长窗 · `ai_muted` 单包熔断 · `db_duplicate` 1s 去重 · **`precheck_unknown_expr` 漂移诊断，非拦截**）。
  接受诊断类条目上报（否则漂移没人看得见）：服务端只搬计数，**不维护 id→语义 映射**（映射会腐）——语义真源在客户端。

## 5. 入参扩展（Q4）—— 收，但 `hints` 不进 prompt
```jsonc
{ "input":"…", "channel":"nls",
  "source": {"package_name":"com.tencent.mm","source_name":"微信支付"},
  "title":"…", "body":"…", "received_at":"2026-10-12T23:40:00+08:00",
  "hints": {"amount_cents":3200,"merchant":"美团","account_name":"微信","direction":"expense"} }
```
- `input` 仍唯一必填（向后兼容）。`title`/`body` v1 **只收 + 校验 + 落库**，**暂不参与**去噪/佐证：
  body 变长会让 tier2「短句光杆数字」判据（len≤30）失效，属独立行为变更，不混做。
- `received_at` **必须带时区偏移**：服务端取它的**北京日期**作为该请求的「今天」（跨午夜迟发不写错日期）；
  越出 [今天-7, 今天+1] 则忽略并回落今天（手机时钟护栏）；锚定值在 quickParse / prompt / 校验间保持一致。
- ⚠️ `source.source_name`：服务端已有 `source_mapping`（包名→友好名）**唯一真源**；请**必发 `package_name`**，友好名可选且仅作参考。
- ⚠️ `hints` v1 **只落库、不喂 prompt**（进 prompt 会让模型抄 hint、绕过金额佐证→假账）；响应新增可选 `hints_conflict`。
  落库：`ai_parse_logs` 加 `channel/source_package/received_at/hints`，`ai_parse_filters` 加 `channel/source_package`（migration019）。

## 6. 出参扩展（Q5）—— 全部**机械推导/抽取，不进 prompt**；`method` 复用 `account`
| 字段 | 取值 | 来源（均为机械，模型不参与） |
|---|---|---|
| `source` | `quick｜ai｜prefilter｜postfilter` | 补齐 #4 缺失的 `'ai'` |
| `merchant` | string｜null | 商户关键词/描述前缀抽取（供分类预填与学习）；与 `description` 并存 |
| `order_no` / `card_tail` | string｜null | 正文正则（订单号/流水号、`尾号\d{4}`）；**不让模型复制**（纯复制必幻觉） |
| `balance_after_cents` | int｜null，**仅提示** | 正文「余额/剩余」抽取；**语义未定**（可用余额 vs 账户余额无法区分） |
| `balance_text` | string｜null | 上项命中的**原始片段**（含「可用余额」等前缀词）→ 客户端按前缀做**同模板自比** |
| `time` | `HH:mm`｜null | 正文时刻抽取；日期仍在 `date`。**已核实**与 `POST /transactions` 同格式（`^\d{2}:\d{2}$`） |
| `confidence` | `high｜medium｜low`（**枚举，非 0~1**） | 派生：quick? + 分类是否精确命中 + 金额是否有佐证 |
| `confidence_reasons` | string[] | 上述判据的机械原因（阈值可审计） |
| `needs_review` | boolean | **服务端用唯一阈值算**：`verifyParsed=review`／分类未精确命中／金额来自裸数字 |
- **客户端请用 `needs_review` 作「不自动入账」判据，不要自己对 `confidence` 设阈值**——否则又是两套阈值（本项目顽疾）；`confidence` 仅供展示/排序。
- `confidence` **不是模型自评**（模型根本不输出它），派生自 tier/quick/精确分类/金额佐证 → 语义稳定、可回归；**不要**用 0~1 浮点。
- `card_tail` 与 `balance_after_cents`/`balance_text` **必在同一 items 元素**（按元素抽取，抽不到则同为 null）。
- `hints_conflict` 只反映「客户端 hint 与文本不一致」，属 **hint 质量问题**，**不进** `needs_review`/`confidence`；客户端用作本地诊断即可，**不据此降级或拒收**（本地正则不得间接决定账目）。
- 模型只输出 `type/amount/category/description/date/account/target_account`：再加 7 个键会每次多输出约 7×N 个键，且 identifier 属纯复制（幻觉高发）→ **不加**；落库**零 migration**（`parsed_items` 等都是 JSON TEXT）。
- ⚠️ 这些是**解析元数据**不是账本字段（提交 `POST /transactions` 会被 zod 剥掉，不污染账本）；`balance_after_cents` **不得**用于写余额（唯一写入口 = 归属账单增量 + 手填覆盖，DATA §12）。

## 7. 兼容与灰度（Q6）—— 确认可行
- payload **只加键、不改既有键语义**；新增键一律可选且有默认值。
- 客户端：**未知键必须忽略**（Moshi 不要开 failOnUnknown）。
- 服务端：zod `.parse()` 会**静默剥离**入参未知键 → 客户端新增入参在服务端加字段前**不可依赖**。
- 响应无 schema 校验（加键天然向后兼容）；`client_version` **只记录与统计**、**不用它分叉行为**（不可测），能力协商用 `precheck.schema`。
- 失败语义不变：解析失败保持 200 + `5001/5002` + `fallback:'manual'`；超时 504、上游错误 502。

## 8. 分工与顺序（先 ① 再 ②…）
| 序 | 项 | 服务端 | 客户端 |
|---|---|---|---|
| ① | 反馈闭环 | 修 index 配对学习；补 `data.parse_log_id` | DTO 加 `parse_log_id`（两层都读）；按最终态回传 + `channel` |
| ② | 入参扩展 | 收 `channel/source/title/body/received_at`；`hints` 只落库 | 发 `package_name`；`received_at` 带 offset |
| ③ | 出参扩展 | 机械推导 §6 六项 + 补 `source` | 本地机械校验；**不得据此自动入账** |
| ④ | precheck 下发 | 由 `verify.ts` 常量派生 + admin schema 放行 | 实现同一判据；`schema` 不认识则降级 |
| ⑤ | 拦截上报 | 新端点 + `client_filter_stats` + admin 视图 | 按 `rule_id` 聚合上报 |

## 9. 规则真源归属（Q2 续）—— 服务端为内容真源：**有条件同意**
- ① ETag 绑**内容 hash**，不用手填 `version`（现 `version` 由上传方手填、ETag=`"<version>"` → 忘 bump 就永不重拉，已踩）；客户端 ETag 保持 opaque。
- ② **未知键 400、不静默剥离**（`.strict()`）；缺键=合法；「新客户端推旧服务端」fail-loud 是期望行为。③ **能力键（如 `precheck`）必须可选可降级**，禁止一次下发废掉老版本。
- ④ 优先级（**已实现**）：`server/config/rules.json`=内容真源（进 git）｜DB=发布载体（历史/审计/拉取）｜admin UI=查看/激活历史/回滚，不做在线编辑。env `RULES_PATH`（默认 `<cwd>/config/rules.json`）；镜像 `COPY server/config`；compose 只读挂载 `./server/config/rules.json:/app/config/rules.json:ro` → **改文件 + 重启即发布**。
- 启动（**幂等 + fail-fast**）：读文件 → 严格校验 → `testcases` 自检 → 算 hash（**剔除 testcases**、canonical JSON，**含 precheck**）→ 与激活版本 hash 不同则 `MAX(version)+1` 插入并激活，相同则不动；⚠️ 载荷新增 precheck 后，**老库升级首次启动会发布一个新版本**（存量行里没有 precheck，客户端必须重拉），再跑才幂等；文件缺失/不合法/自检失败 → **拒绝启动**。
- 校验：顶层键白名单 strict（未知键报错）｜正则交集子集（禁 lookbehind/命名组/`\p{}`/possessive/内联 flags）｜结构必填（`payment_signal_regex` 可编译、`processor` 区间）｜`testcases` 逐条 tier 断言。**ETag 已改为 `"<content_hash>"`**（客户端 opaque 无需改）；admin POST 现在拒绝未知键（旧写法会 400）；`update_rules.sh` 降级为本地联调，其推送会被下次重启覆盖（期望语义）。

## 10. `testcases` 形状（真护栏语料，`corpus_hash` 版本化；**不进下发 payload**）
```jsonc
"corpus_hash": "025e7de0a94002cead2472031b250a570865231bc18bcf8a25a11cd1e152afe6",   // 快照：21 条（nls7/sms4/a11y6/manual4），12 条真交易
"testcases": [ { "id":"sms-bank-consume","channel":"sms","text":"…","expect_tier":1,"expect_reason":"money+verb","expect_txn":true,"expect_client":"pass" } ]
```
- 字段分工（**防「假映射」的关键**）：`expect_tier`/`expect_reason` = **服务端断言**；`expect_txn` = **夹具意图标记**（true=真交易），客户端 P0 断言（真交易一条不许拦）**必须挂在它上面**——不能拿 `tier∈{1,2,3}` 当代理（余额页/待付款页也会落 tier1）；`expect_client` **只允许 `pass` 或缺省**（写服务端 reason 会被服务端校验直接拒，那正是假映射）。
- 客户端**独有**判据（自身通知/去重/熔断/a11y 排除表）用 `client_only.*` 上报，不参与误杀率比较。
- **分歧不对称**：`expect_txn=true` 而客户端 block = **误杀**（丢真账，P0）；其余（噪声被放行 = 漏挡）可接受但计入上报。
- 渠道覆盖：nls 7 / sms 4 / **a11y 6** / manual 4。a11y 含 3 条真交易 + 3 条非交易（待付款页/购物车按钮/余额页）；后两条顺带记录一个**服务端已知问题**：`充值/提现` 在动词表里，零钱余额页会被判 tier1（多调一次模型）。
- 语料**不进下发 payload**（改一条用例就换 content_hash → 全体客户端重拉）：放 `server/config/rules.json` 顶层、发布时剔除；客户端副本是**测试夹具**（非真源）随 `corpus_hash` 同步（算法：**递归按键名排序 + 无空白 JSON → sha256**）；来源只从**合成回归语料（`server/tests/`）与手写 case** 派生，**不导出** `ai_parse_logs`/`ai_parse_filters` 的真实用户原文（隐私，无脱敏管线）。

## 11. 客户端支持基线（版本策略）
- **基线 = Android ≥ 1.5.0**（`versionCode ≥ 7`）；更老的包（v0.4 等）**不做专门垫片**——契约按本文件演进，客户端必须容忍 `null`（≥1.0.0 起 `category_id`/`category_name`/`category_icon` 已可空）。
- 「分类匹配不到」**一律返回契约内合法的 `null`，不返回非法 id `0`**。强更与 versionCode 纪律见 `docs/ARCHITECTURE.md §3.8`（最低安全 `versionCode = 2`）。
- 形状护栏：`server/tests/compat/client-response-shape.test.ts` —— 只断言客户端仍声明**非空**的键（`message`/`items`/`created`/`duplicates`/分页四件套/`percent`/`icon`…）；分支枚举必须配「数据非空」构造 + 变异自检（DEVELOPMENT §7.2）。
