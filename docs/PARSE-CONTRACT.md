# AI 解析 · 跨端契约（服务端 ⇄ Android）

> 两边共享：**改契约先改这里**。实现真源：`server/src/routes/ai.ts`、`server/src/ai/verify.ts`、
> `server/src/lib/parse-filter.ts`、`server/src/routes/notification-rules.ts`。
> 状态：v1（2026-10）。分工与顺序见 §7。

## 0. 名词
| 代号 | 含义 |
|---|---|
| tier | 服务端 `classifyNotification` 档位：0 强/弱噪声、1 金额+动词、2 仅金额、3 仅动词、4 无信号 |
| 入站预筛 | tier 0 / 4 → **不调模型** |
| 出站判定 | tier 2/3 的模型结果需过 `verifyParsed`（`pass`/`drop`/`review`） |
| reason / rule_id | 同一条判据的标识；服务端用 reason 名，客户端上报用 `precheck.*`（§3 给出映射） |

## 1. `POST /api/ai/parse`（认证，限流 20/min）
请求：`{ input: string(1..3000) }`（v1 扩展见 §4）。

**响应有 8 种形态，客户端必须按 `code` + `data.source` + `fallback` 分支**：

| # | 触发 | HTTP | code | data | parse_log_id |
|---|---|---|---|---|---|
| 1 | 入站预筛挡下 | 200 | 0 | `{items:[], raw_input, source:'prefilter'}` | 无 |
| 2 | 快捷正则解析 | 200 | 0 | `{items, raw_input, parse_log_id, source:'quick'}` | `data` |
| 3 | 出站判定为噪声 | 200 | 0 | `{items:[], raw_input, source:'postfilter'}` | 无 |
| 4 | 模型解析成功 | 200 | 0 | `{items, raw_input, parse_log_id}` | `data`（`source` 缺失，§5 补齐为 `'ai'`） |
| 5 | 模型空结果 | 200 | 5001 | `null` | **顶层** |
| 6 | AI 超时 / 上游错误 | 504 / 502 | 5001 | `null`（带 `fallback:'manual'`） | 无 |
| 7 | 响应格式异常 | 200 | 5002 | `null`（带 `fallback:'manual'`） | 无 |
| 8 | 入参校验失败 | 400 | 2000 | `null` | 无 |

- ⚠️ **待统一（服务端）**：`parse_log_id` 补一份到 `data.parse_log_id`（#5 顶层保留，兼容旧客户端）。
- ⚠️ task 无 `parse_log_id` 的形态（#1/#3/#6/#7）**不存在可反馈对象**，客户端不要回传。
- 客户端只能按 `fallback==='manual'` 或 `code!=0` 走手动兜底，**不要只看 HTTP 状态码**。

## 2. `POST /api/ai/parse-feedback`（认证）—— 反馈闭环（优先做）
请求契约（v1，客户端按此实现）：
```jsonc
{
  "parse_log_id": 123,              // §1 拿到的，data 或顶层
  "final_items": [ /* 用户确认后的**最终态**数组，元素同 parse items 形状 */ ],
  "modified": true,                 // 与 AI 原始是否不同（服务端只信这个布尔）
  "entry": "nls"                    // 可选：nls | a11y | sms | manual（归因）
}
```
语义（**不做 diff**）：
- 传**最终态**，不是补丁：删除 = 该项不在数组里；新增 = 数组里多出；改字段 = 直接是新值。
- `modified=false` 但传了 final_items 也接受（视为「确认无误」）。
- `entry` v1 只落进 `modification_detail` JSON（**无需 migration**），要统计再单独加列。

响应：`{code:0,data:null,message:'反馈已记录'}`；不属于当前用户/不存在 → 404 `3002`。

服务端行为：写 `ai_parse_logs.final_items / user_modified / modification_detail`；`modified=true` 时
尝试自动学习 `ai_memories(source='ai_suggested')`。

- ⚠️ **待修（服务端，先修再做闭环）**：自动学习按 **index 配对** `original[i]`↔`final[i]` 且用
  `Math.min` —— 条数不等（删/增）时会**错配并学到错误记忆**。修法：条数不等时不学习（或按 description 匹配）。

## 3. `GET /api/config/notification-rules`（无认证，ETag/304）—— 规则同源
现状：`rules = {nls, a11y, sms, source_mapping, processor}` 已云控；**但服务端 tier 判据是代码硬编码**。
新增（增量键，不改既有键）：
```jsonc
"precheck": {
  "schema": 1,                       // 客户端不认识就整体忽略并降级用本地词表
  "derived_from": "ai/verify.ts",    // **由该文件的同一批常量在运行时序列化**，不手抄
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
- ⚠️ **阻塞点（服务端）**：admin 创建规则的 `z.object({nls,a11y,sms,source_mapping,processor})` 会
  **剥离未知键** → 必须同时给该 schema 加 `precheck`，否则上传被静默丢弃。
- ⚠️ **正则跨语言**：JS 与 Kotlin/Java 正则语义不同。约定只用**交集语法**：字符类、量词、分组、
  `|`、`\d`、`\s`、锚点；**禁止** lookbehind / 命名组 / Unicode 属性类。否则「同源」会变成第三种口径。
- 版本策略：`precheck.schema` 自描述；服务端不按客户端版本分叉行为，只做降级。

## 4. 入参扩展（v1，全部可选，`input` 仍必填）
```jsonc
{ "input":"…", "source":"nls", "package_name":"com.tencent.mm",
  "title":"…", "text":"…", "posted_at":"2026-10-12T23:40:00+08:00",
  "hints": {"amount_cents":3200,"merchant":"美团","account_name":"微信","direction":"expense"} }
```
- `input` 是唯一必填；`title`/`text` 为结构化补充，服务端以 `input` 为主。
- `posted_at` 必须带时区偏移：只用于判断**这条通知属于哪一天**（跨午夜迟发）；
  **服务端「今天」恒为北京时间**（DATA §1.2），不随客户端时区变。
- ⚠️ `hints` v1 **只落库、不喂 prompt**（理由：hints 进 prompt 会让模型「抄 hint」而非读文本，
  绕过金额佐证 `hasCorroboration` → 直接制造假账）。响应可回 `hints_conflict` 供客户端机械校验。

## 5. 出参扩展（服务端**机械推导**，不让模型输出 → 零 token、零幻觉）
| 字段 | 取值 | 来源 |
|---|---|---|
| `source` | `quick｜ai｜prefilter｜postfilter` | 补齐 #4 缺失的 `'ai'` |
| `confidence` | `high｜medium｜low` | tier + 是否 quick + 分类是否精确命中 + 金额佐证 |
| `needs_review` | bool | tier 2/3、无佐证、hints 冲突时为 true |
| `evidence` | string[] | 原文中命中金额/动词的片段（机械抽取） |
| `posted_at` | ISO8601（北京） | 入参 `posted_at` 或正文日期 |
| `balance_after_cents` | int｜null | 正文「余额/剩余」机械抽取 |

- ⚠️ **`balance_after_cents` 只是提示**：服务端**不会**用它写余额。余额唯一写入口是
  「归属账单增量 + 手填覆盖」（DATA §12），客户端也不要拿它自动配平。
- 落库：items 是 JSON，响应加键向后兼容，**无需 migration**。

## 6. 客户端拦截计数上报（新端点 + 新表，**不复用 `ai_parse_filters`**）
- 理由：`ai_parse_filters` 是「服务端挡了哪些」的**逐条事件**（DATA §10.4 刻意与 `ai_parse_logs` 分离）；
  客户端上报是**聚合计数**且含客户端特有维度，混进去会让「服务端 53%」这个口径不可比。
- `POST /api/ai/filter-report`（认证，限流 20/min）：
  `{window_start, window_end, client_version, entry, counts:[{rule_id,count}], totals:{notifications,blocked}}`
- 幂等：`(user_id, client_version, window_start, window_end, rule_id)` upsert；新表 `client_filter_stats`（migration019）。
- **对齐前提**：`rule_id` 用 §3 的命名空间，与服务端 reason 建立映射表（两边同一张表，否则无法比较误杀率）。

## 7. 兼容与灰度（双方确认）
- payload **只加键、不改既有键语义**；新增键一律可选且有默认值。
- 客户端：**未知键必须忽略**（Moshi 不要开 failOnUnknown）。
- 服务端：zod `.parse()` 会**静默剥离**入参未知键 → 客户端新增入参在服务端加字段前**不可依赖**。
- 响应无 schema 校验，加键天然向后兼容。
- `clientVersion`：**只做记录与统计**（归因、灰度观测），**不用它分叉服务端行为**（无法测试）；
  能力协商用自描述版本号（`precheck.schema`）。
- 失败语义不变：解析失败保持 HTTP 200 + `code 5001/5002` + `fallback:'manual'`；超时 504、上游错误 502。

## 8. 分工与顺序（先 ① 再 ②…）
| 序 | 项 | 服务端 | 客户端 |
|---|---|---|---|
| ① | 反馈闭环 | 修 index 配对学习；`data.parse_log_id` 补齐 | DTO 加 `parse_log_id`（两层都读）；按最终态回传 + `entry` |
| ② | 入参扩展 | 收 `source/package_name/title/text/posted_at`；`hints` 只落库 | 传带 offset 的 `posted_at` |
| ③ | 出参扩展 | 机械推导 `confidence/needs_review/evidence/posted_at/balance_after_cents` + 补 `source` | 本地机械校验用；**不得据此自动入账** |
| ④ | precheck 下发 | 由 `verify.ts` 常量派生 + admin schema 放行 | 实现同一判据；`schema` 不认识则降级 |
| ⑤ | 拦截上报 | 新端点 + `client_filter_stats` + admin 视图 | 按 `rule_id` 聚合上报 |
