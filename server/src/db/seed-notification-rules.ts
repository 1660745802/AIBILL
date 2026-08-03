/**
 * 通知记账规则初始数据
 * 在后端首次启动时，如果 notification_rules 表为空，插入默认规则并激活
 */
import { getDb } from './index.js'

const DEFAULT_RULES = {
  nls: {
    payment_signal_regex: '[¥￥$]|RMB|CNY|人民币|元|支付|已付|付款|实付|扣款|消费|收入|到账|收款|转账|退款',
    wechat: {
      package_name: 'com.tencent.mm',
      direct_pass_titles: ['微信支付', '微信支付凭证'],
      direct_pass_title_contains: ['零钱'],
      message_prefixes: ['[转账]', '[微信红包]'],
      amount_symbols: ['¥', '￥'],
    },
    alipay: {
      package_name: 'com.eg.android.AlipayGphone',
      allowed_title_keywords: ['交易提醒', '支付', '账单', '花呗', '余额', '到账', '收款', '退款'],
    },
    bank_package_patterns: ['bank', 'cmb', 'icbc', 'ccb', 'boc', 'abchina', 'psbc', 'cib', 'spdb'],
    sms_packages: [
      'com.android.mms',
      'com.google.android.apps.messaging',
      'com.samsung.android.messaging',
      'com.miui.mms',
      'com.huawei.message',
      'com.oppo.mms',
      'com.vivo.mms',
    ],
  },
  a11y: {
    embedded_payment_apps: [
      'me.ele',
      'com.sankuai.meituan',
      'com.dianping.v1',
      'com.taobao.taobao',
      'com.tmall.wireless',
      'com.xunmeng.pinduoduo',
      'cn.damai',
      'com.taobao.idlefish',
      'com.autonavi.minimap',
    ],
    success_keywords: ['支付成功', '付款成功', '交易成功', '支付完成'],
    embedded_success_keywords: ['订单支付成功', '等待商家接单', '订单已提交'],
    common_exclude_keywords: [
      '购物车', '加入购物车', '立即购买', '去支付', '确认订单',
      '极速付款', '立即付款', '确认付款', '更改付款方式',
      '查看物流', '再次购买', '评价', '申请售后', '退款成功',
      '已收货', '已签收', '待发货', '已发货', '待收货',
      '提交订单', '确认收货', '删除订单', '追加评价', '申请退款', '交易已取消',
    ],
    wechat_alipay_exclude_keywords: [
      '朋友圈', '通讯录', '发现', '搜索小程序', '扫一扫',
      '看一看', '视频号', '直播', '购物', '游戏',
      '消息', '收藏', '相册', '表情', '设置',
    ],
    amount_regex: '[¥￥]\\s*(\\d+\\.?\\d{0,2})|(\\d+\\.?\\d{0,2})元',
    cooldown_minutes: 5,
  },
  sms: {
    spam_keywords: [
      '订购', '退订', '办理', '开通', '激活', '贷款', '借款',
      '提额', '申请', '审批', '邀请', '回复R', '回复TD',
      '免费领', '中奖', '恭喜', '点击链接',
    ],
  },
  source_mapping: {
    'com.tencent.mm': '微信支付',
    'com.eg.android.AlipayGphone': '支付宝',
    'com.icbc': '工商银行',
    'com.chinamworld.bocmbci': '中国银行',
    'com.ccb.start': '建设银行',
    'com.CMB.PB': '招商银行',
    'com.xunmeng.pinduoduo': '拼多多',
    'com.taobao.taobao': '淘宝',
    'com.sankuai.meituan': '美团',
    'me.ele': '饿了么',
    'com.jd.app.reader': '京东',
  },
  processor: {
    scoring_window_seconds: 10,
    dedup_window_seconds: 60,
    marketing_suffix_cutoffs: [
      '点击领取', '点击查看', '点击开启', '戳我领', '立即领取',
      '去领', '快来领', '可领取', '赶紧领',
    ],
    max_amount_cents: 10000000,
    min_amount_cents: 1,
  },
}

/**
 * 确保至少有一条激活的通知规则（首次启动用）
 */
export function ensureDefaultNotificationRules(): void {
  const db = getDb()
  const existing = db.prepare('SELECT COUNT(*) as c FROM notification_rules').get() as { c: number }

  if (existing.c > 0) return

  db.prepare(
    'INSERT INTO notification_rules (version, rules, is_active) VALUES (?, ?, 1)',
  ).run(1, JSON.stringify(DEFAULT_RULES))

  console.log('[App] Default notification rules (v1) created and activated')
}
