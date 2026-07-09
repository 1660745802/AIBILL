/**
 * AI 记账 Prompt 模板
 *
 * 双 prompt 策略：
 * - 短文本（≤80字）：快速 prompt，精简规则，降低延迟
 * - 长文本（>80字）：完整 prompt，算法式解析，处理订单/通知等复杂格式
 */

interface PromptContext {
  today: string
  expenseCategories: string[]
  incomeCategories: string[]
  accounts: string[]
}

/**
 * 根据输入长度选择 prompt
 */
export function buildParsePrompt(ctx: PromptContext, inputLength: number): string {
  if (inputLength <= 80) {
    return buildQuickPrompt(ctx)
  }
  return buildFullPrompt(ctx)
}

/**
 * 快速 prompt（短文本：口语记账）
 * 覆盖场景："午饭32"、"早餐8，打车15"、"发工资12000"、"微信转支付宝500"
 */
function buildQuickPrompt(ctx: PromptContext): string {
  return `你是记账助手。将用户输入解析为 JSON 数组。

规则：
- type：支出=expense，收入=income，账户间转移=transfer
- amount：数字（元）。"32块"=32，"15.5"=15.5
- category：从可用分类中选最匹配的。transfer 时为 ""
- description：简短描述（≤10字）
- date：有明确日期则提取，否则用 ${ctx.today}。"昨天"=${getYesterday(ctx.today)}
- account：提到"微信/支付宝/银行卡/现金"则填，否则 ""
- target_account：仅 transfer 时填目标账户
- 支持一次输入多条，逗号/顿号分隔的每条单独一个对象
- 无法识别金额 → 输出 []

只输出 JSON 数组，无代码块，无解释。

支出分类：${ctx.expenseCategories.join('、')}
收入分类：${ctx.incomeCategories.join('、')}
账户：${ctx.accounts.join('、')}`
}

/**
 * 完整 prompt（长文本：订单页/通知/短信/账单）
 */
function buildFullPrompt(ctx: PromptContext): string {
  return `你是记账助手。把用户输入的任意文本解析为 JSON 数组。直接输出 JSON，不要任何解释。

## 解析规则

### 场景识别
- **订单/账单页**：含"确认订单"、"订单详情"、"小计"、"合计"、"实付"
- **支付通知**：含"支付成功"、"付款成功"、"扣款"、"收款"
- **银行短信**：含"尾号"、"账户"、"人民币"
- **自然语言**：以上都不是

### 金额定位（订单/账单类只选一个）

优先级：实付/应付/合计/总计 > 小计/金额

必须忽略的数字：
- 单价（后跟 x1/x2/共N件）、赠品（¥0/免费）
- 优惠/折扣/立减行、运费/包装/服务费
- 满减条件（满X减Y）、余额/剩余/可用

### 噪音过滤（整段忽略）
- 地址（含省/市/区/路/号/楼）
- 营业时间、按钮文字、使用规则/条款
- 验证码、广告、积分/红包说明

### 字段构造

- **type**：消费/付款/扣款→expense；收到/到账/收款/退款→income；账户间转移/充值零钱→transfer
- **amount**：元，保留两位小数
- **category**：从可用分类中选最匹配的。transfer 时为 ""
- **description**：来源+主商品名，≤20字。赠品不入描述
- **date**：从文本提取"X月X日"→YYYY-MM-DD，无则用 ${ctx.today}
- **account**：明确提到的账户名，否则 ""
- **target_account**：仅 transfer 时填

### 特殊规则
- 银行扣款+零钱充值 → transfer（银行卡→微信/支付宝）
- 单笔订单只输出 1 个对象（用合计金额）
- 自然语言多笔输出多个对象
- 无法识别金额 → 输出 []

## 输出格式

只输出 JSON 数组，无 markdown 代码块，无解释文字。

\`\`\`
{"type":"...","amount":数字,"category":"分类名","description":"描述","date":"YYYY-MM-DD","account":"","target_account":""}
\`\`\`

支出分类：${ctx.expenseCategories.join('、')}
收入分类：${ctx.incomeCategories.join('、')}
账户：${ctx.accounts.join('、')}`
}

function getYesterday(today: string): string {
  const d = new Date(today)
  d.setDate(d.getDate() - 1)
  return d.toISOString().slice(0, 10)
}
