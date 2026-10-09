#!/usr/bin/env bash
#
# 功能取舍体检脚本 —— 输出判定「某功能是否还有价值」所需的三类证据。
#
#   1. 表行数       ：数据从来没被写过？
#   2. 最近写入时间 ：写过一次之后就没人碰了？
#   3. 请求日志     ：前端/客户端到底调过没有？
#
# 用法：
#   scripts/feature-triage.sh                 # 默认连 bill-app 容器
#   CONTAINER=my-app scripts/feature-triage.sh
#   DB=/path/to.db scripts/feature-triage.sh  # 直接读本地库（需装了 better-sqlite3）
#
# 第 4 类证据「客户端是否可达」需要跨仓库 grep，见 docs/FEATURE-TRIAGE.md §2.4。

set -euo pipefail

CONTAINER="${CONTAINER:-bill-app}"
DB="${DB:-/app/data/bill.db}"

# 在容器里执行 node；不在容器里就直接用本地 node
run_sql() {
  if [ -n "${DB}" ] && [ -d "$(dirname "$DB")" ]; then
    DB="$DB" node -e "$1"
  else
    docker exec -e DB="$DB" "$CONTAINER" node -e "$1"
  fi
}

if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER"; then
  if [ ! -f "${DB:-}" ]; then
    echo "找不到容器 $CONTAINER，也找不到数据库文件 $DB" >&2
    echo "用法：CONTAINER=xxx 或 DB=/path/to.db $0" >&2
    exit 1
  fi
fi

echo "══════════════════════════════════════════════════════════════"
echo " 功能取舍体检 · $CONTAINER"
date '+ 生成时间：%Y-%m-%d %H:%M'
echo "══════════════════════════════════════════════════════════════"

# ── 1 & 2：表行数 + 最近写入 ─────────────────────────────────────
run_sql "
const db = require('better-sqlite3')(process.env.DB, { readonly: true })
const tables = db.prepare(
  \"select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name\"
).all().map(r => r.name)

const has = (t, col) => {
  try { db.prepare(\`select \${col} from \${t} limit 1\`); return true } catch { return false }
}

const rows = []
for (const t of tables) {
  let n = 0
  try { n = db.prepare(\`select count(*) c from \${t}\`).get().c } catch { continue }
  let last = null
  for (const col of ['updated_at', 'created_at', 'date', 'paid_at', 'deleted_at']) {
    if (has(t, col)) {
      try {
        const r = db.prepare(\`select max(\${col}) m from \${t}\`).get()
        if (r && r.m) { last = String(r.m).slice(0, 10); break }
      } catch {}
    }
  }
  rows.push({ table: t, rows: n, last })
}

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length))
console.log()
console.log('【1】表行数与最近写入')
console.log('  ' + pad('表', 22) + pad('行数', 10) + '最近写入')
console.log('  ' + '─'.repeat(44))
for (const r of rows) {
  const flag = r.rows === 0 ? '  ← 空的' : (r.last && r.last < '2026-01-01' ? '  ← 长期未动' : '')
  console.log('  ' + pad(r.table, 22) + pad(r.rows, 10) + (r.last || '—') + flag)
}
console.log()
console.log('  重点看：行数=0 的表 = 建了从来没用过')
"

# ── 3：请求日志 ────────────────────────────────────────────────
run_sql "
const db = require('better-sqlite3')(process.env.DB, { readonly: true })
let rows = []
try {
  rows = db.prepare(\`
    select message as endpoint, count(*) as n
    from app_logs
    where message like '%/api/% →%'
    group by message order by n desc limit 30
  \`).all()
} catch {}

console.log('【2】真实调用过的接口（app_logs）')
if (!rows.length) {
  console.log('  （无记录：可能 logger 只记写操作，或表为空）')
} else {
  const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length))
  for (const r of rows) console.log('  ' + pad(r.n, 7) + r.endpoint)
}
console.log()

// 日志窗口有多长，决定结论可不可信
try {
  const w = db.prepare(\"select min(created_at) a, max(created_at) b, count(*) c from app_logs\").get()
  console.log('  日志覆盖：' + String(w.a).slice(0,10) + ' ~ ' + String(w.b).slice(0,10) + '（' + w.c + ' 条）')
  const days = (new Date(w.b) - new Date(w.a)) / 86400000
  if (days < 30) console.log('  ⚠️  窗口不足 30 天，结论仅供参考')
} catch {}
console.log()
"

# ── 记账来源：判断「主入口在哪」 ────────────────────────────────
run_sql "
const db = require('better-sqlite3')(process.env.DB, { readonly: true })
let rows = [], act = []
try {
  rows = db.prepare('select source, count(*) n from transactions group by source order by n desc').all()
  act = db.prepare(\`
    select user_id, count(distinct date(created_at)) d, count(*) n,
           min(date(created_at)) f, max(date(created_at)) l
    from transactions group by user_id order by n desc
  \`).all()
} catch {}

console.log('【3】记账来源分布（判断主入口）')
for (const r of rows) {
  const pct = rows.length ? Math.round(r.n * 100 / rows.reduce((s, x) => s + x.n, 0)) : 0
  console.log('  ' + String(r.source).padEnd(24) + String(r.n).padStart(6) + '  ' + pct + '%')
}
console.log()
console.log('【4】各用户活跃度（判断是否已有人真在用）')
for (const a of act) {
  const span = Math.round((new Date(a.l) - new Date(a.f)) / 86400000) + 1
  console.log('  user#' + a.user_id + '  ' + String(a.n).padStart(5) + ' 笔 / ' +
    a.d + ' 活跃天（跨度 ' + span + ' 天，粘性 ' + Math.round(a.d * 100 / span) + '%）')
}
"

echo "══════════════════════════════════════════════════════════════"
echo " 判定标准见 docs/FEATURE-TRIAGE.md"
echo " 记住：表行数=0 只能说明「服务端没数据」，"
echo "       必须叠加「客户端是否可达」才能下结论。"
echo "══════════════════════════════════════════════════════════════"
