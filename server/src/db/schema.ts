/**
 * 数据库 Schema 定义
 * 所有建表语句集中管理，通过 migration 机制执行
 */

/** Migration 001: 初始 Schema */
export const migration001 = `
-- 用户表
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    nickname TEXT,
    role TEXT DEFAULT 'user' CHECK(role IN ('admin', 'user')),
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 邀请码表
CREATE TABLE IF NOT EXISTS invite_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    max_uses INTEGER DEFAULT 1,
    used_count INTEGER DEFAULT 0,
    created_by INTEGER REFERENCES users(id),
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 分类表
CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('expense', 'income')),
    icon TEXT DEFAULT '📦',
    parent_id INTEGER REFERENCES categories(id),
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    UNIQUE(user_id, name, type)
);

-- 账户表
CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    type TEXT DEFAULT 'other' CHECK(type IN ('cash', 'wechat', 'alipay', 'bank', 'credit', 'other')),
    icon TEXT DEFAULT '💳',
    initial_balance INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    UNIQUE(user_id, name)
);

-- 交易记录表（核心）
CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    type TEXT NOT NULL CHECK(type IN ('expense', 'income', 'transfer')),
    amount INTEGER NOT NULL CHECK(amount > 0),
    category_id INTEGER REFERENCES categories(id),
    account_id INTEGER REFERENCES accounts(id),
    target_account_id INTEGER REFERENCES accounts(id),
    description TEXT,
    date TEXT NOT NULL,
    time TEXT,
    tags TEXT DEFAULT '[]',
    source TEXT DEFAULT 'manual' CHECK(source IN ('manual', 'ai', 'import_csv', 'app_notification', 'ocr', 'subscription')),
    source_detail TEXT,
    client_id TEXT,
    client_type TEXT DEFAULT 'web' CHECK(client_type IN ('web', 'app_android', 'app_ios', 'import_script')),
    client_created_at TEXT,
    status TEXT DEFAULT 'confirmed' CHECK(status IN ('confirmed', 'pending')),
    ai_raw_input TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_client_id ON transactions(user_id, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_user_date ON transactions(user_id, date);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_deleted ON transactions(deleted_at);

-- 预算表（P1，提前建好）
CREATE TABLE IF NOT EXISTS budgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    category_id INTEGER NOT NULL DEFAULT 0,
    amount INTEGER NOT NULL CHECK(amount > 0),
    period TEXT DEFAULT 'monthly' CHECK(period IN ('monthly', 'yearly')),
    year INTEGER NOT NULL,
    month INTEGER NOT NULL DEFAULT 0,
    UNIQUE(user_id, category_id, year, month)
);

-- AI 对话记录表（P1，提前建好）
CREATE TABLE IF NOT EXISTS ai_conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_conversations_user ON ai_conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_conversations_session ON ai_conversations(session_id);

-- 全局设置表
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 用户级设置表
CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER NOT NULL REFERENCES users(id),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, key)
);

-- 数据库版本表
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`

/** Migration 002: AI Parse Logs */
export const migration002 = `
CREATE TABLE IF NOT EXISTS ai_parse_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    raw_input TEXT NOT NULL,
    cleaned_input TEXT,
    ai_response TEXT,
    parsed_items TEXT,
    final_items TEXT,
    status TEXT NOT NULL CHECK(status IN ('success', 'empty', 'error', 'timeout')),
    error_message TEXT,
    duration_ms INTEGER,
    user_modified INTEGER DEFAULT 0,
    modification_detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_parse_logs_user ON ai_parse_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_parse_logs_status ON ai_parse_logs(status);
CREATE INDEX IF NOT EXISTS idx_ai_parse_logs_created ON ai_parse_logs(created_at);
`

/** Migration 003: 统计查询性能优化索引 */
export const migration003 = `
-- 核心复合索引：覆盖统计/预算/趋势等高频查询
-- 查询模式: WHERE user_id=? AND type=? AND status='confirmed' AND deleted_at IS NULL AND date BETWEEN ? AND ?
CREATE INDEX IF NOT EXISTS idx_transactions_stats
  ON transactions(user_id, type, date)
  WHERE status = 'confirmed' AND deleted_at IS NULL;

-- 分类统计索引：by-category 查询 GROUP BY category_id
CREATE INDEX IF NOT EXISTS idx_transactions_category_stats
  ON transactions(user_id, category_id, date)
  WHERE status = 'confirmed' AND deleted_at IS NULL AND type = 'expense';

-- 交易列表排序优化：ORDER BY date DESC, created_at DESC
CREATE INDEX IF NOT EXISTS idx_transactions_list
  ON transactions(user_id, date DESC, created_at DESC)
  WHERE status = 'confirmed' AND deleted_at IS NULL;

-- AI 对话查询优化
CREATE INDEX IF NOT EXISTS idx_ai_conversations_session_user
  ON ai_conversations(user_id, session_id, created_at);
`

/** Migration 004: AI 记忆表 */
export const migration004 = `
-- AI 全局记忆表
CREATE TABLE IF NOT EXISTS ai_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    content TEXT NOT NULL,
    category TEXT DEFAULT 'preference' CHECK(category IN ('preference', 'habit', 'rule', 'context')),
    source TEXT DEFAULT 'manual' CHECK(source IN ('manual', 'ai_suggested')),
    source_detail TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_memories_user_active ON ai_memories(user_id, is_active);
`

/** Migration 005: 订阅管理表 */
export const migration005 = `
CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK(amount > 0),
    cycle TEXT NOT NULL CHECK(cycle IN ('monthly', 'quarterly', 'yearly')),
    category_id INTEGER REFERENCES categories(id),
    account_id INTEGER REFERENCES accounts(id),
    start_date TEXT NOT NULL,
    next_payment_date TEXT,
    reminder_days INTEGER DEFAULT 3,
    auto_record INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'cancelled')),
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_next ON subscriptions(user_id, next_payment_date);
`

/** Migration 006: 应用日志表 */
export const migration006 = `
CREATE TABLE IF NOT EXISTS app_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT NOT NULL CHECK(level IN ('info', 'warn', 'error')),
    module TEXT NOT NULL,
    message TEXT NOT NULL,
    data TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_app_logs_level ON app_logs(level);
CREATE INDEX IF NOT EXISTS idx_app_logs_module ON app_logs(module);
CREATE INDEX IF NOT EXISTS idx_app_logs_created ON app_logs(created_at);
`

/** 默认全局设置数据 */
export const seedSettings = `
INSERT OR IGNORE INTO settings (key, value) VALUES
('ai_base_url', 'https://api.openai.com/v1'),
('ai_api_key', ''),
('ai_model', 'gpt-4o-mini'),
('ai_temperature_parse', '0.1'),
('ai_temperature_chat', '0.7'),
('currency', 'CNY');
`

/** 为新用户生成默认支出分类（参数化插入） */
export function insertDefaultExpenseCategories(db: any, userId: number): void {
  const categories: [string, string, number][] = [
    ['餐饮', '🍜', 1],
    ['交通', '🚗', 2],
    ['购物', '🛒', 3],
    ['住房', '🏠', 4],
    ['娱乐', '🎮', 5],
    ['医疗', '🏥', 6],
    ['教育', '📚', 7],
    ['通讯', '📱', 8],
    ['日用', '🧴', 9],
    ['服饰', '👕', 10],
    ['人情', '🎁', 11],
    ['其他', '📦', 99],
  ]
  const stmt = db.prepare(
    'INSERT INTO categories (user_id, name, type, icon, sort_order) VALUES (?, ?, ?, ?, ?)',
  )
  for (const [name, icon, order] of categories) {
    stmt.run(userId, name, 'expense', icon, order)
  }
}

/** 为新用户生成默认收入分类（参数化插入） */
export function insertDefaultIncomeCategories(db: any, userId: number): void {
  const categories: [string, string, number][] = [
    ['工资', '💰', 1],
    ['奖金', '🎉', 2],
    ['理财', '📈', 3],
    ['兼职', '💼', 4],
    ['红包', '🧧', 5],
    ['退款', '↩️', 6],
    ['其他', '📦', 99],
  ]
  const stmt = db.prepare(
    'INSERT INTO categories (user_id, name, type, icon, sort_order) VALUES (?, ?, ?, ?, ?)',
  )
  for (const [name, icon, order] of categories) {
    stmt.run(userId, name, 'income', icon, order)
  }
}

/** 为新用户生成默认账户（参数化插入） */
export function insertDefaultAccounts(db: any, userId: number): void {
  const accounts: [string, string, string, number][] = [
    ['微信', 'wechat', '💚', 1],
    ['支付宝', 'alipay', '🔵', 2],
    ['银行卡', 'bank', '💳', 3],
    ['现金', 'cash', '💵', 4],
  ]
  const stmt = db.prepare(
    'INSERT INTO accounts (user_id, name, type, icon, sort_order) VALUES (?, ?, ?, ?, ?)',
  )
  for (const [name, type, icon, order] of accounts) {
    stmt.run(userId, name, type, icon, order)
  }
}

/** Migration 007: 通知记账规则表 */
export const migration007 = `
CREATE TABLE IF NOT EXISTS notification_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version INTEGER NOT NULL,
    rules TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id),
    is_active INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notification_rules_active ON notification_rules(is_active);
CREATE INDEX IF NOT EXISTS idx_notification_rules_version ON notification_rules(version);
`
