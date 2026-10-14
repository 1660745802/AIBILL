/**
 * 客户端规则夹具（`tests/fixtures/notification-rules-payload.json`）· **漂移护栏**
 *
 * Android 的回归护栏（`NotificationFilterRegressionTest`）现在读这份**发布载荷**，
 * 而不是手工维护的 `scripts/rules.json`。两仓库独立 checkout，客户端**算不出**服务端
 * 的 `content_hash`（要复刻 `stableStringify` + 派生 precheck），所以「真源改了、夹具没重导」
 * 这件事只能在**服务端**这边发现——就是本文件。
 *
 * 变了怎么办：在仓库根目录重导（见 `scripts/export-client-fixture.ts` 的用法注释）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  loadRulesFile,
  validateRules,
  buildPublishPayload,
  payloadHash,
  corpusHash,
} from '../../src/lib/notification-rules.js'

const RULES_PATH = resolve(process.cwd(), 'config/rules.json')
const FIXTURE_PATH = resolve(process.cwd(), 'tests/fixtures/notification-rules-payload.json')

describe('客户端规则夹具 · 发布载荷与真源一致', () => {
  const rules = loadRulesFile(RULES_PATH)
  const payload = buildPublishPayload(rules)
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as {
    content_hash: string
    corpus_hash: string
    rules: unknown
  }

  it('真源本身通过校验（夹具只在真源合法时才有意义）', () => {
    expect(validateRules(rules)).toEqual([])
  })

  it('content_hash = 当前发布载荷的 hash', () => {
    expect(fixture.content_hash).toBe(payloadHash(payload))
  })

  it('corpus_hash = 当前 testcases 的 hash', () => {
    expect(fixture.corpus_hash).toBe(corpusHash(rules.testcases))
  })

  it('rules = 当前发布载荷（剔除 testcases + 派生 precheck），逐键相同', () => {
    expect(fixture.rules).toEqual(payload)
  })
})
