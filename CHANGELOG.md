# Changelog

所有版本变更记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### 资产工作台 · 口径归一（本轮最大的一组）

这个项目大半的历史 bug 都是「同一个数字有两套算法」。这组改动把账户余额和
行情这两处口径收敛成单一真源，并把发现的问题一并修掉。

**账户余额 = 单一真源**（migration 017）

- `accounts.balance` 是唯一真源，由两条路径维护：有归属的账单增删改 → 增量加减；
  手填 → 覆盖并刷新基准线
- **基准线用 `transactions.id` 而不是日期或时间戳**。用日期会让「手填当天下午记的
  账单」（业务日期就是今天）被永久跳过，直接推翻「我改了余额，后续有新账单余额跟着变」；
  用时间戳则同一秒内分不出先后。自增 id 无精度问题
- 6 个写入口全部接入（建账 / 编辑 / 软删 / 恢复 / 订阅自动记账），三处非事务写已包事务
- 修掉跨用户越权改余额（`applyTxn` 不按 `user_id` 过滤）、同日二次改余额 500、
  自转账扣钱、迁移回填判据错误等

**行情**

- **时区错位（静默且致命）**：门禁原用 `now.getHours()`（服务器本地时间），
  而容器跑 UTC → 北京盘中（UTC 02:00）被判成「非交易时段」，**盘中一次都没抓过**。
  新增 `beijingNow()` / `beijingDate()` 固定 UTC+8
- **按市场分时段**：只判断「是不是 A 股盘中」会让**港股收盘价（16:00）永远抓不到**、
  **美股（北京 21:30-04:00）完全不抓**。现按 A股/港股/美股分别判断
- **汇率整条链路曾静默失效**：`normalizeCode` 把 `whHKDCNY` 当成美股代码改成
  `usWHHKDCNY`，腾讯不认 → 外币持仓永远「待补汇率」。新增 ECB 官方兜底源
- **外币折算成人民币**：`marketValue` 是折算后的数，同时保留原币市值/币种/汇率供展示；
  缺汇率时给 `null` 而不是把港元当人民币
- 调度间隔 60 分钟 → **15 分钟**（`QUOTE_REFRESH_MINUTES` 可调）；
  重复抓取靠 `UNIQUE(code, quote_date, quoted_at)` 去重
- 节假日不维护日历，改为**从数据推断**：行情日期不是今天 ⇒ 该市场今天没开市
- 修复港股/美股的日期格式（`2026/10/09 16:08:08`）、代码大小写（`hf_XAU` vs `hf_xau`）

**资产页与仪表盘对齐**

- 账户行主数字改为**账户总价值**（现金 + 持仓市值），页头加合计，
  与仪表盘净资产同口径。此前行上只有现金输入框，加起来差一个持仓市值
- 现金编辑收进行内展开、离开即存，不再是常驻输入框
- 设置页账户列表的理财账户标注「现金」，避免被读成账户总额
- 数字格式统一（此前仪表盘 `¥86,182`、资产页裸 `12`、设置页 `¥12.00` 三种）

**账户增删**

- 「停用/启用」改为「删除/还原」：账户是有或没有，不该停在中间态
- 删除账户时**流水保留**（有真实外键，且流水是账本事实），连带清掉快照与持仓
- `POST /api/accounts` 接受 `asset_type` → 建账户时一次选对类型，
  不用建完再去资产页改一次（此前同一设置两个入口，第二个藏得最深）

**交互与布局**

- 行情手动刷新按钮 + 逐个代码回报结果；「上次更新」改为**从数据读**而非前端 ref
- 导航 5 组 11 项 → **3 组 10 项**（每组平均 2 项时，组头和条目一样多）
- 投资页：读数铺满 4 列、总价值不再写两遍、低频编辑默认收起
- 修复 HTML 注释泄漏成页面可见文字（注释里写了 `<!---->`，其 `-->` 提前闭合）

**文档**

- 删除 `HANDOFF-asset-workbench.md`（内容已并入 `CONTRIBUTING.md §3.2`）与
  `feature-removal-plan.md`（未执行、且针对的端点已重建）
- `CONTRIBUTING.md` 补入**读生产库只能用只读连接**的硬规则与事故经过

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
- **导航分层（后已推翻，见下文「导航改功能分类」）**：一级只留「记一笔 / 账本 / 本月 / AI 助手」，其余收进「偶尔」分组
- **下线 5 个零使用功能**（Web 端）：预算、财务目标、订阅管理、AI 记忆、资产快照；删除 `Budget.vue` `Goals.vue` `Subscriptions.vue` `api/goals.ts`，并从 Dashboard / Home / Me / Settings / Assets 中移除相关区块
- **后端接口与数据表暂时保留但标记 `deprecated`**：`/api/budgets/*` `/api/goals/*` `/api/subscriptions/*` `/api/memories/*` `/api/assets/snapshot|/trend`。`GET /api/stats/dashboard` 响应结构不变（那三个字段仍返回空数组），避免影响已发布客户端；旧 Web 路由 302 到 `/me` 而非 404
  - 依据：Android 侧 `BudgetApi` / `BudgetRepository` / `BudgetResponse` / Hilt 绑定四层数据链路齐备，但 `presentation/` 层**零引用**——即「数据层写全了，UI 入口从未存在」。标 deprecated 而非“保留”，是为了避免下一个读到代码的人误以为该功能还在被使用

### 导航改功能分类（推翻上一版的频率分层）

上一版用「每天 / 偶尔」分层导航，基于真实使用频率。**加了投资功能之后这条轴撑不住了**：
「账户总览」「投资组合」是**状态**，「记一笔」是**动作**，状态和动作不在同一条频率轴上。

- **新增 `web/src/nav.ts` 单一真源**：侧栏 / 手机底栏 / 「全部功能」索引页三处都从它派生。
  上一版侧栏和「我的」各列一遍同一批功能，是重复入口
- **分组**：账本 / 资产 / 洞察 / 工具 / 系统；「记一笔」不进任何分组（它是全局动作）
- **手机底栏 3 槽**由 `mobileSlot` 标记：账本 / 本月结算 / 账户总览。
  塞不下「组」只能放页面，是物理约束不是退回频率分层
- **`/me` 改成「全部功能」索引页**：手机上没侧栏，它是到达「工具」「系统」两组的唯一路径

### 资产 = 汇总 / 投资 = 明细（信息架构分层）

用户的口径：**资产是整合的信息，理财账户单独一个 tab 管配置和明细。**
据此把资产侧分成两层：

- **资产（`/assets`）**：汇总。每个账户**一个数**（现金），加净资产、每日余额录入、账户设置
- **投资（`/investments`）**：明细。按理财账户分段，配持仓、填总投入、看盈亏
- 导航里「投资」**仅当存在 `asset_type='investment'` 的账户时出现**，挂在「资产」组下
  （投资是资产的子集，不是并列概念）。手机底栏保持 4 槽，投资从账户总览点进去

**为什么分两层**：有 20 只股票时资产页不该被 20 行持仓撑爆。这和「记一笔」降级为普通 tab
是同一条原则——**一级只放常看的整合信息**。

### 修：持仓入口依赖一个发现不了的隐藏前置

用户反馈「能进，就是填不了」。查下来的因果链是硬的：

```
持仓区只在存在 asset_type='investment' 的账户时才渲染
  → 而把账户标成「理财投资」藏在「账户设置 → 展开账户行 → 类型下拉」里
  → 新的 4 个默认账户都是 liquid，所以全新用户永远看不到持仓区
```

而且资产页副标题当时写着「4 个账户 · 持仓一次配好」——**页面在宣传一个它此刻不提供的功能**。
kiro 审查用两张逐字节相同的截图坐实了这点（全新态 / 有账户未标投资态）。

现在：入口由「存在理财账户」驱动，不由「存在数据行」驱动；账户类型在行上**可见**（不藏进展开层）；
投资页空态直接给「去账户设置」的具体动作。

### 修：单只不算盈亏（同时消掉一处自相矛盾）

用户明确「投入不要针对单只持仓股，计算总投入就可以」。据此：

- **migration 016**：删 `investments.cost_basis`、`asset_snapshots.quantity`、`asset_snapshots.total_invested`，
  并把总投入搬到 `accounts.invested_total`（账户属性，只在存/取钱时变）
- `lib/holdings.ts`：单只只算市值（股数 × 现价），没有成本价、没有单只浮盈
- 总投入从快照搬到账户，是因为它**只在存/取钱时变**，不是每日读数；
  放快照里会导致「改一次总投入得伪造一条带日期的快照」

**这修掉了一个同屏矛盾**：页面头条「浮动盈亏 +14,170」而同一只持仓行显示「−13,830」，
正负号相反。根因就是单只也算了成本（而单只浮盈与账户级浮盈天然不同——后者含现金）。

### 修：三种「算不出」不再显示成 0 或假数字

| 状态 | 旧表现 | 现在 |
|---|---|---|
| 未取到价 | 市值 ¥0.00 | 「—」，且浮盈给 null |
| 持仓未配置（有总投入无持仓） | 显示一个大负数（把"没录进来"算成亏） | 「持仓未配置」 |
| 快照不完整 | 净资产整块塌成 ¥0 | `≥¥X` + 未取价账户数 |

### 修：仪表构成横条与净资产口径不一致

净资产已改读快照（含持仓市值），但构成横条还在读 dashboard 的流水口径 `asset_breakdown`——
于是出现「净资产 ¥114,170」而构成写着「还没有账户」。现在有快照时按 portfolio 的账户分组算。

实现时还踩了一个：在 `assetSplit` 里为 portfolio 分支写了 early return，**绕过了下面共用的
`percent` 映射** → 组件里 `r.percent.toFixed(0)` 抛错 → 整块渲染失败。已在注释里记下。

### 修：持仓名显示成代码两次

用户只填代码和股数，所以 `investments.name` 为空。行情返回里本来有名称，
但路由映射时把 `name` 丢了。现在 `name = 持仓名 || 行情名 || null`。

### 其它

- 「各账户余额」加**日期选择**（默认今天）。空态一直承诺「漏几天随时补」、接口也支持 `date`，
  但 UI 从不传——**承诺和能力必须一致**
- 抽 `lib/investments-repo.ts`：两个路由原来各写一遍「读持仓 + 取最新行情」，
  容易漂移（正好是浮盈算两遍那类问题的温床）
- 投资页顶部也放「总投入 / 现金」两个输入，不用跳页就能配齐

### 资产工作台：手动快照替代流水回算

**背景**（生产数据实测）：553 笔交易里**只有 1 笔带 `account_id`**，13 个账户只有 2 个有期初余额。
这意味着从流水回算的净资产必然是错的（实测算出来每个账户都是 0）。
既然自动不可靠，就直接记「某天这个账户值多少」。

- **migration 013**：给**已存在**的 `asset_snapshots` 加 `quantity` / `total_invested`
  （这张表一直存在、0 行、标 deprecated；`source` 列本来就有 `'manual'`，这是「找回」不是新建）
- **migration 014**：新建 `investments`（按标的的持仓）与 `investment_quotes`（行情历史）
- **migration 015**：补建 `ai_parse_filters`。见下方「遗留」注解
- **`lib/portfolio.ts`**：净资产 / 各账户最新快照 / 曲线覆盖率 / 日变动。三个口径必须守住：
  ① 净资产 = 各账户**最新一条**快照之和，不强行按日期对齐；
  ② 曲线上每天的**覆盖率**要一起返回（某天只更新 2/5 个账户时 UI 必须能说）；
  ③ 日变动只在找到「全员都更新过」的上一次时才给，否则返回 `null` 而不是拿部分之和冒充
- **净资产口径 = 持仓市值 + 现金**（不是 `balance`，那是现金部分）。
  首版实现把 `balance` 当总价值，导致证券账户的持仓市值在净资产里凭空消失
- **`lib/quotes.ts`**：腾讯行情批量抓取。三个实测出的坑：**返回是 GBK**；
  **两种格式**（`~` 88 段的 A 股/ETF，`,` 分隔的外盘）；**必须用行情自带时间戳**——
  同一次请求里两个 A 股标的停在 10-09 收盘，伦敦金已是 10-10，用「今天」当快照日期
  会在非交易日造出假新鲜度。夹具是**真实抓取**的响应（`tests/fixtures/quotes-sample.txt`）
- **`scheduler.ts`**：盘中每小时 + 收盘后抓价。**失败只记日志、不写快照**——
  写一条错的价格比不写更危险（页面会显示一个看起来很新的假数字）
- **成本价是派生的**（`净投入 ÷ 份额`，不存储）：改了股数单价自动跟着变，
  不存在「改了股数忘了更新成本」的脏状态
- **`records → 持仓 API`**：`GET/POST/PATCH/DELETE /api/investments`，
  代码自动 normalize（`518880` / `sh518880`），负债账户不显示持仓区

> **遗留**：migration 012 曾被原地改写两次（A 版重建 `ai_parse_logs` → C 版新建 `ai_parse_filters`），
> 而它已被应用到生产库，导致代码要写的 `ai_parse_filters` 表在生产库里不存在。
> migration 015 是幂等补建（`CREATE TABLE IF NOT EXISTS`），在生产库副本上实跑两遍验证过。
> **教训：连生产库的脚本只能用 `mode=ro`，不能调 `initDb()`。**

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
- **手机端 `PageHeader` 标题被吸顶条压住**：与外壳 topbar 都是 `sticky top:0`，
  标题看不见只剩副标题。改成 `PageHeader` 只在 `≥1024px` 吸顶
- **`SnapshotEditor` 里多一个 `</span>`** 导致标签不闭合，`vite build` 报 "Element is missing end tag"
- **禁止负余额**是错的：信用卡欠款就是负的。已改成负数合法、单列「负债」、
  负债账户不显示成本价/浮盈（欠款没这回事）
- **`previousNetWorth` 循环用错了日期**：用了「余额最大账户的最后更新日」而不是全局最大日期
- **注释泄漏到页面上**（与 v-slot 那次同类）
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