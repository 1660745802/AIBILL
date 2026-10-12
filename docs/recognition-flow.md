# 自动记账识别 · 跨端契约 v1（服务端 ⇄ Android）

> 双边共享，**改契约先改这里**。实现真源（服务端）：`routes/ai.ts`、`ai/prompts.ts`、`ai/verify.ts`、
> `lib/parse-filter.ts`、`routes/notification-rules.ts`、`db/schema.ts`。状态：v1（2026-10）。

## 0. 术语与字段命名（先定名，避免同义两套）
| 名 | 含义 |
|---|---|
| tier | `classifyNotification` 档位：0 强/弱噪声、1 金额+动词、2 仅金额、3 仅动词、4 无信号 |
| 入站预筛 | tier 0/4 → **不调模型**；出站佐证 = tier 2/3 的模型结果需过 `verifyParsed` |
| `channel` | **入口归因**：`nls`｜`sms`｜`a11y`｜`manual`（同时满足「通知/手动」归因需求） |
| `source` | **来源应用**：`{ package_name, source_name? }`。⚠️ 不要用 `source` 表示入口，那会和本项撞名 |
| `input` | 解析正文，唯一必填 |

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

- ⚠️ **待统一（服务端）**：`parse_log_id` 补进 `data.parse_log_id`（#5 顶层保留以兼容旧客户端）。
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
- **客户端传「用户改后的 items」**（最终态），不是 AI 原始、不是补丁。
- **删除整笔 = 该项不出现在 `final_items` 里**；新增 = 多出的项；改字段 = 直接是新值。
- `modified=false` + 传 `final_items` 也接受（语义：确认无误）。
- 响应 `{code:0,data:null}`；记录不存在/不属于当前用户 → 404 `3002`。
- 服务端行为：写 `ai_parse_logs.final_items / user_modified / modification_detail`；`modified=true` 时
  尝试自动学习 `ai_memories(source='ai_suggested')`（**不会**注入 prompt，防自我污染）。
- ⚠️ **服务端先修**：自动学习按 **index 配对**（`Math.min(original.length, final.length)`），
  条数不等（删/增）时会**错配并学到错误记忆**。修法：条数不等时不学习。

## 3. 规则同源下发（Q2）—— 能做，但必须「由代码派生」而非手抄
- 现状：`rules={nls,a11y,sms,source_mapping,processor}` 已云控，但 **tier 判据硬编码在 `ai/verify.ts`**，
  两端目前是**两套词表**。
- 新增增量键（既有键不动）：
```jsonc
"precheck": {
  "schema": 1,                    // 客户端不认识 → 整体忽略，降级用本地词表
  "derived_from": "ai/verify.ts",
  "order": ["strong_noise","money+verb","weak_noise","money_only","bare_amount","verb_only"],
  "rules": [
    {"id":"precheck.strong_noise","tier":0,"pattern":"…"},
    {"id":"precheck.weak_noise","tier":0,"pattern":"…"},
    {"id":"precheck.payment_verb","tier":null,"pattern":"…"},
    {"id":"precheck.bare_amount","tier":2,"expr":"len<=30 && digits>=2"}
  ],
  "should_call_ai": "tier in (1,2,3)"
}
```
- ⚠️ **阻塞点（服务端）**：`createRulesSchema` 的 `z.object({nls,a11y,sms,source_mapping,processor})`
  会**剥离未知键** → 必须同步放行 `precheck`，否则 admin 上传被静默丢弃（客户端观察正确）。
- ⚠️ **正则跨语言**：只用 JS/Kotlin 交集语法（字符类、量词、分组、`|`、`\d`、`\s`、锚点）；
  **禁** lookbehind / 命名组 / Unicode 属性类。否则「同源」会变成第三种口径。
- 降级：`precheck.schema` 自描述；服务端**不按客户端版本分叉行为**。

## 4. 拦截计数上报（Q3）—— 能收，但**不复用 `ai_parse_filters`**
- 理由：`ai_parse_filters` 是「服务端挡了哪些」的**逐条事件**（DATA §10.4 刻意与 `ai_parse_logs` 分离）；
  客户端上报是**聚合计数** + 客户端特有维度，混进去会让「服务端 53%」不再可比。
- `POST /api/ai/filter-report`（认证，限流 20/min）：
  `{window_start, window_end, client_version, channel, counts:[{rule_id,count}], totals:{notifications,blocked}}`
- 幂等：`(user_id, client_version, window_start, window_end, rule_id)` upsert；新表 `client_filter_stats`。
- **对齐前提**：`rule_id` 用 §3 命名空间；需要一份「客户端 rule_id ↔ 服务端 reason」映射表（否则误杀率无法比较）。

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
- 响应无 schema 校验，加键天然向后兼容。
- `client_version`：**只记录与统计**，**不用它分叉服务端行为**（不可测）；能力协商用 `precheck.schema`。
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
- ④ 优先级：`server/config/rules.json`=内容真源（进 git）｜DB=发布载体（历史+审计+拉取）｜admin UI 降级为查看/激活历史/回滚（不做在线编辑，避免双写）。
- 启动流程（幂等）：读文件 → 校验 → 算内容 hash → 与激活版本不同则插新版本并激活，相同则不动。校验：键白名单 strict（缺键允许）｜正则交集子集（`\d\s\w` 限 ASCII；禁 possessive/命名组/lookbehind/`\p{}`/内联 flags）｜结构必填｜`testcases` 自检（§10）。
- `update_rules.sh` 降级为本地开发/联调；它推的规则会被下次重启的文件覆盖（期望语义）。顺手修：`cachedRules` 解析失败静默变 `null` → fail-fast；`version` 补 UNIQUE。

## 10. `testcases` 形状（真护栏语料，`corpus_hash` 版本化；**不进下发 payload**）
```jsonc
"corpus_hash": "<testcases 数组的 hash>",
"testcases": [ { "id":"sms-bank-consume","channel":"sms","text":"您尾号1234的储蓄卡消费50.00元","expect_tier":1,"expect_client":"pass" } ]
```
- 断言分工：`expect_tier` 服务端断言（tier 语义在服务端）；`expect_client` 客户端断言，取**规范 id**（`pass`｜`block:<precheck.* / 服务端 reason>`），客户端在测试里映射到内部 BlockReason → 与 §4 上报共用一套 id 空间。`channel` 只影响客户端链。
- **分歧不对称**：`expect_tier ∈ {1,2,3}` 而客户端 block = **误杀**（丢真账，P0）；`expect_tier ∈ {0,4}` 而客户端 pass = **漏挡**（多一次往返，可接受但计入上报）。
- 语料**不进下发 payload**（改一条用例就换 content_hash → 全体客户端重拉）：放 `server/config/rules.json` 顶层、发布时剔除；客户端副本是**测试夹具**（非真源）随 `corpus_hash` 同步；来源只从**合成回归语料（`server/tests/`）与手写 case** 派生，**不导出** `ai_parse_logs`/`ai_parse_filters` 的真实用户原文（隐私，无脱敏管线）。
