/**
 * 导出客户端规则夹具（`notification-rules-payload.json`）
 *
 * 为什么需要它：客户端回归护栏（Android `NotificationFilterRegressionTest`）此前直接读
 * 一份**手工维护**的 `scripts/rules.json`，它与 `server/config/rules.json`（规则真源）
 * 早已结构性漂移（缺 `per_package`/`default_rule`、词表不同、缺全部 `a11y.*`）。
 * 结果是护栏护的是一条**生产到不了**的分支。
 *
 * 本脚本把真源 → **发布载荷**（`buildPublishPayload`：剔除 testcases + 代码派生 precheck）
 * 导出成一份带 provenance 的夹具，与 `precheck-payload.json` 同款：
 *
 *   { source, version, content_hash, corpus_hash, rules }
 *
 * `content_hash` / `corpus_hash` 让「客户端 vendor 的副本是否陈旧」**可见**；
 * 服务端 `tests/lib/notification-rules-fixture.test.ts` 会在真源变更却未重导时变红。
 *
 * 用法（在仓库根目录）：
 *   npx tsx scripts/export-client-fixture.ts \
 *     --out server/tests/fixtures/notification-rules-payload.json \
 *     --out ../AIBILL-ANDROID/app/src/test/resources/notification-rules-payload.json
 *   npx tsx scripts/export-client-fixture.ts --check <同样的 --out ...>
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadRulesFile,
  validateRules,
  selfTestTestcases,
  buildPublishPayload,
  payloadHash,
  corpusHash,
} from '../server/src/lib/notification-rules.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RULES_PATH = resolve(ROOT, 'server/config/rules.json')
const DEFAULT_OUT = resolve(ROOT, 'server/tests/fixtures/notification-rules-payload.json')

/** 夹具里的 version 是**占位**：真实 version 由服务端 DB 分配，客户端只把它当不透明值。 */
const FIXTURE_VERSION = 1

interface ClientFixture {
  source: string
  version: number
  content_hash: string
  corpus_hash: string
  rules: unknown
}

function buildFixture(): ClientFixture {
  const rules = loadRulesFile(RULES_PATH)
  const errors = validateRules(rules)
  if (errors.length > 0) {
    throw new Error(`规则真源校验失败（${RULES_PATH}）：\n- ${errors.join('\n- ')}`)
  }
  // 与启动发布同一条链：语料自检 + 派生 precheck（`buildPublishPayload` 自己会再校验 precheck 安全子集）
  selfTestTestcases(rules)
  const payload = buildPublishPayload(rules)
  return {
    source: 'GET /api/config/notification-rules → data（rules 已含代码派生 precheck、不含 testcases；meta 原样保留）',
    version: FIXTURE_VERSION,
    content_hash: payloadHash(payload),
    corpus_hash: corpusHash(rules.testcases),
    rules: payload,
  }
}

function serialize(fixture: ClientFixture): string {
  return JSON.stringify(fixture, null, 2) + '\n'
}

function main(): void {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const outs: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') {
      const p = args[++i]
      if (!p) throw new Error('--out 需要一个路径')
      outs.push(resolve(process.cwd(), p))
    }
  }
  if (outs.length === 0) outs.push(DEFAULT_OUT)

  const fixture = buildFixture()
  const text = serialize(fixture)

  let stale = 0
  for (const out of outs) {
    if (check) {
      const current = existsSync(out) ? readFileSync(out, 'utf8') : ''
      if (current !== text) {
        console.error(`✗ 陈旧：${out}`)
        stale++
      } else {
        console.log(`✓ 最新：${out}`)
      }
    } else {
      writeFileSync(out, text, 'utf8')
      console.log(`写入 ${out}（content_hash=${fixture.content_hash.slice(0, 12)}…）`)
    }
  }

  if (check && stale > 0) {
    console.error('\n夹具已漂移：在仓库根目录运行 `npx tsx scripts/export-client-fixture.ts --out …` 重新导出。')
    process.exit(1)
  }
}

main()
