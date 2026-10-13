/**
 * 这条测试在锁什么
 * ----------------
 * **判据一致性断言真的挂在两条发布路径上**（这是 C1–C8 写了七步之后的第一处 fail-fast：
 * 在此之前 `collectCriterionConflicts()` 只被测试调用，生产启动与 admin 发布都不碰它）。
 *
 * 三件事：
 * 1. **启动路径（`publishRulesFromFile`）**：真实 rules.json 通过；坏判据 → 抛错，
 *    进程起不来，且**不写库**（与该模块头部的「宁可起不来，也不要带着坏规则启动」同级）。
 * 2. **admin 发布路径（POST /api/admin/notification-rules）**：坏判据 → 400 + 原样消息，
 *    `notification_rules` 表行数**不变**（不留半成品版本）。
 * 3. **豁免清单是有实效的**：把 `ALLOWED_OVERLAPS` 里某条去掉，C6 必须报出来
 *    ——否则这份清单就是「把断言按死了」，不是「记录了已知无害的重叠」。
 *
 * 用「坏判据」造坏表的方式：往 testcases 里塞一条 `expect_txn: true` 但没写
 * `expect_client: 'pass'` 的语料（C7 直接命中），或塞一条服务端判不动的噪声语料（C4）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { initDb, getDb, closeDb } from '../../src/db/index.js'
import { buildApp, teardownApp, authHeaders, loginAdmin } from '../helpers.js'
import { publishRulesFromFile } from '../../src/lib/notification-rules.js'
import { collectCriterionConflicts } from '../../src/ai/criterion-consistency.js'
import { ALLOWED_OVERLAPS, rulesCriterionSlice } from '../../src/ai/criterion-rules.js'
import type { RulesFile } from '../../src/lib/notification-rules.js'

const REAL_RULES_PATH = fileURLToPath(new URL('../../config/rules.json', import.meta.url))
const loadReal = (): RulesFile => JSON.parse(fs.readFileSync(REAL_RULES_PATH, 'utf8')) as RulesFile

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aibill-criterion-'))
const writeTmp = (name: string, obj: unknown): string => {
  const p = path.join(tmpDir, name)
  fs.writeFileSync(p, JSON.stringify(obj))
  return p
}

/** 真交易语料却没写 expect_client='pass' → C7 命中 */
const brokenByC7 = (rules: RulesFile): RulesFile => ({
  ...rules,
  testcases: [
    ...(rules.testcases ?? []),
    {
      id: 'synthetic-txn-without-expect-client',
      text: '动账提醒 您尾号0001的储蓄账户今日支出人民币12.34元。',
      expect_tier: 1,
      expect_txn: true,
    } as NonNullable<RulesFile['testcases']>[number],
  ],
})

function ruleRowCount(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM notification_rules').get() as { n: number }
  return row.n
}

describe('判据断言 · 启动发布路径（publishRulesFromFile）', () => {
  beforeAll(() => { initDb() })

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    closeDb()
  })

  it('真实 rules.json：判据一致（C1–C8 全绿），发布照常', () => {
    const before = ruleRowCount()
    const result = publishRulesFromFile(getDb(), REAL_RULES_PATH)
    expect(result.published === true || result.published === false).toBe(true)
    expect(result.content_hash).toMatch(/^[0-9a-f]{16,}$/)
    expect(ruleRowCount()).toBeGreaterThanOrEqual(before)
  })

  it('真实常量 + 真实 rules.json：C6/C7 参与后仍是空数组', () => {
    // 直接验判据本身（发布路径只是它的一个调用点）
    const slice = rulesCriterionSlice(loadReal())
    expect(slice.clientBlockKeywords.length).toBeGreaterThan(20)
    expect(slice.serverPositiveTokens).toContain('退款')
    // 真实常量那侧没有冲突；rules 那侧的冲突要么为空、要么被显式豁免登记
    const conflicts = collectCriterionConflicts()
    expect(conflicts).toEqual([])
  })

  it('坏判据 → fail-fast 抛错，且**不写库**', () => {
    const bad = writeTmp('broken-c7.json', brokenByC7(loadReal()))
    const before = ruleRowCount()
    expect(() => publishRulesFromFile(getDb(), bad)).toThrow(/判据一致性检查失败/)
    expect(ruleRowCount()).toBe(before)
  })

  it('豁免清单有实效：拿掉「退款成功」的豁免 → C6 立刻报出这个重叠', () => {
    const rules = loadReal()
    const slice = rulesCriterionSlice(rules)
    const withoutExemption = { ...slice, allowedOverlaps: slice.allowedOverlaps.filter((o) => o.term !== '退款成功') }
    const conflicts = conflictsWith(rules, withoutExemption)
    expect(conflicts.map((c) => `${c.kind}:${c.term}`)).toContain('client_block_vs_server_positive:退款成功')
    // 而带豁免时它是绿的
    expect(conflictsWith(rules, slice)).toEqual([])
  })
})

/** 用给定 rules 入参跑一遍全套判据（真实常量 + 规则切片） */
function conflictsWith(rules: RulesFile, slice: ReturnType<typeof rulesCriterionSlice>) {
  const tables = {
    synonyms: [], quickConfidence: [], importRules: [], noiseTerms: [],
    seedExpenseNames: [], seedIncomeNames: [], promptNoiseExamples: [],
    rules: { ...slice, testcases: rules.testcases?.map((c) => ({
      id: c.id, expect_txn: c.expect_txn, expect_client: c.expect_client,
    })) ?? [] },
  }
  return collectCriterionConflicts(tables)
}

describe('判据断言 · admin 发布路径（POST /api/admin/notification-rules）', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = await buildApp()
    token = authHeaders(await loginAdmin(app))
  })

  afterAll(async () => {
    await teardownApp(app)
  })

  beforeEach(() => {
    ruleRowCount() // 触发一次查询，确保 DB 连接就绪
  })

  it('坏判据（C7）→ 400 + 原样消息，且 notification_rules 行数不变', async () => {
    const before = ruleRowCount()
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/notification-rules',
      headers: token,
      payload: { rules: brokenByC7(loadReal()) },
    })
    const body = JSON.parse(res.payload)
    expect(res.statusCode).toBe(400)
    expect(body.code).toBe(2000)
    expect(body.message).toMatch(/判据一致性检查失败/)
    expect(body.message).toContain('synthetic-txn-without-expect-client')
    expect(ruleRowCount()).toBe(before)
  })

  it('干净 rules → 仍然能发布（断言没有把正常路径也堵死）', async () => {
    const before = ruleRowCount()
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/notification-rules',
      headers: token,
      payload: { rules: loadReal() },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).code).toBe(0)
    expect(ruleRowCount()).toBe(before + 1)
  })
})
