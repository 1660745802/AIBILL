#!/usr/bin/env node
// Run: env -u NODE_OPTIONS /mnt/Data/billserver/server/node_modules/.bin/tsx /mnt/Data/billserver/scripts/e2e-review-fixes.mjs
// Real Vue/Vite + Fastify buildApp + fresh SQLite memory DB. No installed/downloaded browser,
// production app, scheduler, persistent browser profile, .env, or external service is used.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { randomUUID } from 'node:crypto'
import net from 'node:net'
import http from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TMP = mkdtempSync('/tmp/bill-review-e2e-')
const USER = 'isolated_review_admin'
const PASSWORD = 'synthetic-review-password-2026'
const KEY = 'sk-synthetic-review-only-not-a-real-provider-key'
// MUST precede every dynamic server import (config.ts snapshots environment on import).
Object.assign(process.env, {
  NODE_ENV: 'test', DB_PATH: ':memory:',
  JWT_SECRET: 'synthetic-review-jwt-secret-at-least-32-characters',
  ADMIN_USERNAME: USER, ADMIN_PASSWORD: PASSWORD,
  AI_API_KEY: KEY, AI_BASE_URL: 'https://review-ai.invalid/v1', AI_MODEL: 'synthetic-model',
  UPDATES_DIR: join(TMP, 'updates'), RULES_PATH: join(TMP, 'unused-rules.json'),
  CORS_ORIGINS: 'http://127.0.0.1', PORT: '3000',
})
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
  delete process.env[key]
}
const requireServer = createRequire(join(ROOT, 'server/package.json'))
const dotenv = requireServer('dotenv')
const originalDotenvConfig = dotenv.config
// Prevent even reading the repository's real .env; config.ts still runs unmodified.
dotenv.config = () => ({ parsed: {} })

// Deny Node egress before loading application modules; only this run's loopback ports pass.
const allowedPorts = new Set()
const deniedNode = []
const originalConnect = net.Socket.prototype.connect
const originalFetch = globalThis.fetch
function localURL(raw) {
  const url = new URL(typeof raw === 'string' || raw instanceof URL ? raw : raw.url)
  return ['http:', 'ws:'].includes(url.protocol) && url.hostname === '127.0.0.1' && allowedPorts.has(Number(url.port))
}
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0]
  const options = typeof first === 'object' ? first : { port: first, host: args[1] }
  if (options?.host !== '127.0.0.1' || !allowedPorts.has(Number(options?.port))) {
    deniedNode.push('non-fixture socket')
    throw new Error('E2E egress denied: only owned 127.0.0.1 ports are allowed')
  }
  return originalConnect.apply(this, args)
}
globalThis.fetch = async (input, init) => {
  if (!localURL(input)) {
    deniedNode.push('non-fixture fetch')
    throw new Error('E2E egress denied: external fetch')
  }
  return originalFetch(input, init)
}
syncBuiltinESMExports()

let app, db, closeDb, vite, browser, context, page, proxy
let base, adminToken, account, categories, today
let passed = 0
const failures = [], asyncErrors = [], pageErrors = [], consoleErrors = [], deniedBrowser = []
const expectedAborts = new Set()
const observedAborts = new Set()
const writes = []
const openGates = new Set()
let backgroundDenied = 0
const importLocal = (relative) => import(pathToFileURL(join(ROOT, relative)).href)
function gate() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  const entry = { promise, release: () => { resolve(); openGates.delete(entry) } }
  openGates.add(entry)
  return entry
}
async function eventually(check, label, timeout = 15000) {
  const end = Date.now() + timeout
  let last
  do {
    try { if (await check()) return } catch (error) { last = error }
    await delay(25)
  } while (Date.now() < end)
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`)
}
async function okJSON(response) {
  const body = await response.json()
  assert.equal(response.statusCode ?? response.status(), 200, `API HTTP status: ${body.message || body.error || ''}`)
  return body
}
async function inject(method, url, payload, token = adminToken) {
  const response = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} })
  const body = await okJSON(response)
  assert.equal(body.code, 0, `${method} ${url}: ${body.message}`)
  return body.data
}
function rows(description) {
  return db.prepare('SELECT * FROM transactions WHERE description = ? AND deleted_at IS NULL').all(description)
}
function savedAccount() {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(account.id)
}
function setting(key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value
}
async function goto(path) {
  await page.goto(base + path, { waitUntil: 'networkidle' })
}
async function login(username = USER, password = PASSWORD) {
  await page.getByPlaceholder('请输入用户名').fill(username)
  await page.getByPlaceholder('请输入密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.waitForURL(base + '/')
  await page.getByRole('button', { name: '手动', exact: true }).waitFor()
}
async function noOverflow(label) {
  const widths = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
  assert.ok(widths.scroll <= widths.client + 1, `${label}: horizontal overflow ${JSON.stringify(widths)}`)
}
async function manual(description, amount = '12.34') {
  await goto('/')
  await page.getByRole('button', { name: '手动', exact: true }).click()
  const form = page.locator('form').filter({ hasText: '手动记账' })
  await form.getByLabel('金额（元）').fill(amount)
  // These wrapping labels include their select's option text in the accessible name.
  await form.getByLabel(/^分类/).selectOption(String(categories.food.id))
  await form.getByLabel(/^账户/).selectOption(String(account.id))
  await form.getByLabel('备注', { exact: true }).fill(description)
  today = await form.getByLabel('日期', { exact: true }).inputValue()
  return form
}
async function saved(description) {
  await page.locator('section.sheet').getByText(description, { exact: true }).waitFor()
  await page.locator('form').filter({ hasText: '手动记账' }).waitFor({ state: 'hidden' })
  await page.locator('.parsed').waitFor({ state: 'hidden' })
  assert.equal(rows(description).length, 1, `${description}: DB must contain exactly one row`)
}
async function successfulWrite(path, action, method = 'PUT') {
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === path && r.request().method() === method)
  await action()
  const res = await response
  const body = await okJSON(res)
  assert.equal(body.code, 0, body.message)
  return res.request().postDataJSON()
}
async function test(name, run) {
  try {
    await run()
    passed++
    console.log(`PASS ${name}`)
  } catch (error) {
    failures.push({ name, error: error.stack || String(error) })
    console.error(`FAIL ${name}: ${error.stack || error}`)
  } finally {
    for (const pending of openGates) pending.release()
    if (page && !page.isClosed()) await page.unrouteAll({ behavior: 'wait' })
  }
}
// The first POST genuinely goes through Vite to Fastify and commits, then its response
// is held/dropped. Retry is NOT mocked: the real unique client_id constraint is exercised.
async function interceptFirstSave(description, drop = false) {
  const hold = gate()
  const state = { count: 0, committed: false, bodies: [], results: [] }
  await page.route('**/api/transactions', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    try {
      const payload = route.request().postDataJSON()
      state.count++
      state.bodies.push(payload)
      const response = await route.fetch({ maxRetries: 0 })
      const body = await okJSON(response)
      assert.equal(body.code, 0, body.message)
      state.results.push(body)
      if (state.count === 1) {
        assert.equal(rows(description).length, 1, 'fault must happen AFTER commit')
        state.committed = true
        await hold.promise
        if (drop) {
          expectedAborts.add(route.request().url())
          return await route.abort('failed')
        }
      }
      await route.fulfill({ response })
    } catch (error) {
      asyncErrors.push(error.stack || String(error))
      await route.abort().catch(() => {})
    }
  })
  return { state, release: hold.release }
}

try {
  const { config } = await importLocal('server/src/config.ts')
  assert.equal(config.dbPath, ':memory:')
  assert.equal(config.aiApiKey, KEY)
  const helpers = await importLocal('server/tests/helpers.ts')
  const database = await importLocal('server/src/db/index.ts')
  closeDb = database.closeDb
  app = await helpers.buildApp()
  db = database.getDb()
  assert.equal(db.name, ':memory:')
  assert.ok(db.pragma('database_list').every((entry) => !entry.file), 'all databases must be in memory')
  await app.listen({ host: '127.0.0.1', port: 0 })
  const apiPort = app.server.address().port
  allowedPorts.add(apiPort)
  const credentials = await inject('POST', '/api/auth/login', { username: USER, password: PASSWORD }, null)
  adminToken = credentials.token
  account = await inject('POST', '/api/accounts', { name: '隔离回归账户', type: 'cash', asset_type: 'liquid', initial_balance: 100000 })
  const allCategories = (await inject('GET', '/api/categories')).items
  categories = {
    food: allCategories.find((c) => c.name === '餐饮' && c.type === 'expense'),
    travel: allCategories.find((c) => c.name === '交通' && c.type === 'expense'),
    shopping: allCategories.find((c) => c.name === '购物' && c.type === 'expense'),
    income: allCategories.find((c) => c.type === 'income'),
  }
  assert.ok(Object.values(categories).every(Boolean), 'seed categories available')
  await inject('PUT', '/api/admin/settings', { ai_api_key: KEY, ai_base_url: process.env.AI_BASE_URL, ai_model: 'synthetic-model' })

  const { createServer } = await importLocal('web/node_modules/vite/dist/node/index.js')
  const { default: vue } = await importLocal('web/node_modules/@vitejs/plugin-vue/dist/index.mjs')
  const { default: tailwind } = await importLocal('web/node_modules/@tailwindcss/vite/dist/index.mjs')
  // Vite treats port: 0 as its default 5173; explicitly choose an OS-assigned free port.
  const reservation = net.createServer()
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve) })
  const freePort = reservation.address().port
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()))
  vite = await createServer({
    root: join(ROOT, 'web'), configFile: false, envFile: false,
    cacheDir: join(TMP, 'vite-cache'), plugins: [vue(), tailwind()],
    resolve: { alias: { '@': join(ROOT, 'web/src') } },
    server: { host: '127.0.0.1', port: freePort, strictPort: true, hmr: false, proxy: { '/api': { target: `http://127.0.0.1:${apiPort}` } } },
  })
  await vite.listen()
  const webPort = vite.httpServer.address().port
  allowedPorts.add(webPort)
  base = `http://127.0.0.1:${webPort}`

  // All non-loopback Edge traffic (including browser background services) goes to a
  // local DENY proxy. No CONNECT tunnel or forwarding is implemented.
  proxy = http.createServer((_request, response) => { backgroundDenied++; response.writeHead(403); response.end() })
  proxy.on('connect', (_request, socket) => { backgroundDenied++; socket.end('HTTP/1.1 403 Forbidden\r\n\r\n') })
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve) })
  allowedPorts.add(proxy.address().port)
  const { chromium } = await importLocal('web/node_modules/playwright-core/index.mjs')
  const edgeBin = process.env.EDGE_BIN || '/usr/bin/microsoft-edge'
  if (!existsSync(edgeBin)) throw new Error(`找不到 Chromium 浏览器：${edgeBin}（可用 EDGE_BIN 指定）`)
  browser = await chromium.launch({
    executablePath: edgeBin, headless: true,
    env: { PATH: '/usr/bin:/bin', HOME: TMP, XDG_CONFIG_HOME: TMP, XDG_CACHE_HOME: TMP, LANG: 'C.UTF-8' },
    args: [
      `--proxy-server=http://127.0.0.1:${proxy.address().port}`, '--proxy-bypass-list=127.0.0.1',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      '--disable-background-networking', '--disable-component-update', '--disable-quic',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    ],
  })
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
  await context.route('**/*', async (route) => {
    // Also prevent the actual page from talking to unrelated local services.
    if (new URL(route.request().url()).origin !== base) {
      deniedBrowser.push(route.request().url())
      return route.abort('blockedbyclient')
    }
    await route.continue()
  })
  page = await context.newPage()
  page.setDefaultTimeout(15000)
  const anonymousAfterLogout = new Set()
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const location = message.location().url
    if (expectedAborts.has(location) && message.text() === 'Failed to load resource: net::ERR_FAILED') {
      observedAborts.add(location)
    } else if (/Failed to load resource: the server responded with a status of 401 \(Unauthorized\)/.test(message.text())) {
      // 401 是契约内的状态码（登录前探测、登出收尾请求），不是未捕获 JS 异常；
      // 认证行为由 UI 登录/换号断言与服务端审计覆盖。
      anonymousAfterLogout.add(new URL(location).pathname)
    } else consoleErrors.push(`${message.text()} @ ${location}`)
  })
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (['POST', 'PUT'].includes(request.method()) && ['/api/transactions', '/api/admin/settings', `/api/accounts/${account.id}`].includes(path)) {
      writes.push({ path, method: request.method(), payload: request.postDataJSON() })
    }
  })
  console.log(`ISOLATION db=:memory: API=127.0.0.1:${apiPort} Vite=${base} browser=Edge headless temporary context`)
  await goto('/login')
  await login()

  await test('manual normal: DOM submit, network payload, persisted cents and account delta', async () => {
    const before = savedAccount().balance
    const form = await manual('review-manual-normal')
    const payload = await successfulWrite('/api/transactions', () => form.getByRole('button', { name: '保存这一笔' }).click(), 'POST')
    await saved('review-manual-normal')
    assert.equal(payload.items.length, 1)
    assert.equal(payload.items[0].source, 'manual')
    assert.ok(payload.items[0].client_id)
    assert.equal(rows('review-manual-normal')[0].amount, 1234)
    assert.equal(savedAccount().balance, before - 1234)
    assert.equal(await form.count(), 0, 'successful save closes manual form')
  })

  await test('manual delayed double click: one POST/row, all form controls disabled', async () => {
    const form = await manual('review-manual-double', '23.45')
    const { state, release } = await interceptFirstSave('review-manual-double')
    await form.getByRole('button', { name: '保存这一笔' }).dblclick()
    await eventually(() => state.committed, 'delayed request committed')
    assert.equal(state.count, 1)
    // Playwright isDisabled() 不覆盖 fieldset 元素本身，直接读 DOM 属性。
    assert.equal(await form.locator('fieldset').evaluate((el) => el.disabled), true)
    // fieldset disabled 不改子控件的 disabled 属性；isEditable 反映实际可交互性。
    assert.equal(await form.getByLabel('金额（元）').isEditable(), false)
    assert.equal(await form.getByRole('button', { name: '关闭' }).isDisabled(), true)
    assert.equal(await form.getByRole('button', { name: '保存中…' }).isDisabled(), true)
    release()
    await saved('review-manual-double')
    assert.equal(state.count, 1)
  })

  await test('manual committed but response lost: unchanged retry reuses client_id and DB row', async () => {
    const form = await manual('review-manual-retry', '34.56')
    const before = savedAccount().balance
    const { state, release } = await interceptFirstSave('review-manual-retry', true)
    await form.getByRole('button', { name: '保存这一笔' }).click()
    await eventually(() => state.committed, 'lost-response request committed')
    release()
    await page.getByText('未能确认保存结果，请保持内容不变重试；修改前请先核对流水', { exact: true }).waitFor()
    assert.equal(await form.getByLabel('备注', { exact: true }).inputValue(), 'review-manual-retry')
    await form.getByRole('button', { name: '保存这一笔' }).click()
    await saved('review-manual-retry')
    assert.equal(state.count, 2)
    assert.equal(state.bodies[0].items[0].client_id, state.bodies[1].items[0].client_id)
    assert.equal(state.results[1].data.created.length, 0)
    assert.equal(state.results[1].data.duplicates.length, 1)
    assert.equal(savedAccount().balance, before - 3456)
  })

  await test('AI confirmation: double-click lock and lost-response retry (synthetic parse only)', async () => {
    await goto('/')
    await page.route('**/api/ai/parse', (route) => route.fulfill({ json: { code: 0, data: { items: [{
      type: 'expense', amount: 4567, description: 'review-ai-retry', date: today,
      category_id: categories.food.id, category_name: categories.food.name,
      category_icon: categories.food.icon, account_id: account.id, account_name: account.name,
    }] } } }))
    await page.getByPlaceholder('午饭 32，打车 15').fill('synthetic AI fixture')
    await page.getByRole('button', { name: '解析', exact: true }).click()
    const confirm = page.getByRole('button', { name: '确认入账', exact: true })
    const { state, release } = await interceptFirstSave('review-ai-retry', true)
    await confirm.dblclick()
    await eventually(() => state.committed, 'AI confirmation committed')
    assert.equal(state.count, 1)
    assert.equal(await confirm.isDisabled(), true)
    assert.equal(await page.locator('.parsed').getByRole('button', { name: '取消', exact: true }).isDisabled(), true)
    assert.equal(await page.getByPlaceholder('午饭 32，打车 15').isDisabled(), true)
    release()
    await page.getByText('未能确认保存结果，请保持内容不变重试；修改前请先核对流水', { exact: true }).waitFor()
    await confirm.click()
    await saved('review-ai-retry')
    assert.equal(state.count, 2)
    assert.equal(state.bodies[0].items[0].client_id, state.bodies[1].items[0].client_id)
    assert.equal(state.results[1].data.duplicates.length, 1)
    assert.equal(await page.locator('.parsed').count(), 0)
  })

  await test('account rename during concurrent ledger insert: no balance field/baseline overwrite', async () => {
    await goto('/settings')
    await page.getByRole('button').filter({ hasText: account.name }).click()
    const edit = page.locator('.am-edit')
    const before = savedAccount()
    assert.equal(Number(await edit.getByLabel('当前余额', { exact: true }).inputValue()), before.balance / 100)
    await edit.getByLabel('账户名称', { exact: true }).fill('隔离回归已改名')
    await inject('POST', '/api/transactions', { items: [{ client_id: randomUUID(), client_type: 'web', source: 'manual', type: 'expense', amount: 789, account_id: account.id, category_id: categories.food.id, description: 'review-concurrent-ledger', date: today }] })
    const payload = await successfulWrite(`/api/accounts/${account.id}`, () => edit.getByRole('button', { name: '保存', exact: true }).click())
    assert.equal(Object.hasOwn(payload, 'current_balance'), false)
    assert.equal(Object.hasOwn(payload, 'initial_balance'), false)
    const after = savedAccount()
    assert.equal(after.name, '隔离回归已改名')
    assert.equal(after.balance, before.balance - 789)
    assert.equal(after.balance_as_of_txn_id, before.balance_as_of_txn_id)
    await page.locator('.am-row-name').getByText('隔离回归已改名', { exact: true }).waitFor()
    account.name = after.name
  })

  await test('account balance changed back is omitted; genuine balance change is sent', async () => {
    await goto('/settings')
    await page.getByRole('button').filter({ hasText: account.name }).click()
    const edit = page.locator('.am-edit')
    const balance = edit.getByLabel('当前余额', { exact: true })
    const original = await balance.inputValue()
    await balance.fill('1.23')
    await balance.fill(original)
    const reverted = await successfulWrite(`/api/accounts/${account.id}`, () => edit.getByRole('button', { name: '保存', exact: true }).click())
    assert.equal(Object.hasOwn(reverted, 'current_balance'), false)
    await edit.waitFor({ state: 'hidden' })
    await page.getByRole('button').filter({ hasText: account.name }).click()
    await balance.fill('888.88')
    const changed = await successfulWrite(`/api/accounts/${account.id}`, () => edit.getByRole('button', { name: '保存', exact: true }).click())
    assert.equal(changed.current_balance, 88888)
    assert.equal(savedAccount().balance, 88888)
  })

  await test('AI settings model-only edit: empty key input, omitted PUT key, original key preserved', async () => {
    await goto('/admin?tab=ai')
    const keyInput = page.getByPlaceholder('不修改则留空')
    assert.equal(await keyInput.inputValue(), '')
    await page.getByText(`当前：${KEY.slice(0, 8)}***。未编辑则保留原密钥。`, { exact: false }).waitFor()
    await page.getByPlaceholder('gpt-4o-mini', { exact: true }).fill('synthetic-model-reviewed')
    const payload = await successfulWrite('/api/admin/settings', () => page.getByRole('button', { name: '保存设置', exact: true }).click())
    assert.equal(Object.hasOwn(payload, 'ai_api_key'), false)
    assert.equal(setting('ai_api_key'), KEY)
    assert.equal(setting('ai_model'), 'synthetic-model-reviewed')
    await page.reload({ waitUntil: 'networkidle' })
    assert.equal(await keyInput.inputValue(), '')
    assert.equal(await page.getByPlaceholder('gpt-4o-mini', { exact: true }).inputValue(), 'synthetic-model-reviewed')
  })

  await test('AI key explicit clear/replacement: only dirty input writes key, then resets', async () => {
    await goto('/admin?tab=ai')
    await page.getByRole('button', { name: '清空已保存密钥', exact: true }).click()
    await page.getByText('保存后将清空密钥。', { exact: true }).waitFor()
    const cleared = await successfulWrite('/api/admin/settings', () => page.getByRole('button', { name: '保存设置', exact: true }).click())
    assert.equal(cleared.ai_api_key, '')
    assert.equal(setting('ai_api_key'), '')
    await page.getByPlaceholder('不修改则留空').fill(KEY)
    const replaced = await successfulWrite('/api/admin/settings', () => page.getByRole('button', { name: '保存设置', exact: true }).click())
    assert.equal(replaced.ai_api_key, KEY)
    await eventually(async () => await page.getByPlaceholder('不修改则留空').inputValue() === '', 'successful key save clears input')
    const untouched = await successfulWrite('/api/admin/settings', () => page.getByRole('button', { name: '保存设置', exact: true }).click())
    assert.equal(Object.hasOwn(untouched, 'ai_api_key'), false)
    assert.equal(setting('ai_api_key'), KEY)
  })

  await test('CSV real file parse + desktop/mobile bulk category: preserve classified rows through DB', async () => {
    await goto('/import')
    const descriptions = ['review-import-餐厅', 'review-import-manual', 'review-import-empty', 'review-import-income']
    const csv = ['交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态', ...descriptions.map((description, i) => `${today} 12:00:00,商户消费,合成商户,${description},${i === 3 ? '收入' : '支出'},${i + 1}.11,现金,支付成功`)].join('\n')
    await page.locator('input[type=file]').setInputFiles({ name: 'synthetic-review.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
    const responsePromise = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/import/csv')
    await page.getByRole('button', { name: '解析文件', exact: true }).click()
    const parsed = await (await responsePromise).json()
    assert.equal(parsed.code, 0)
    assert.equal(parsed.data.parsed.length, 4)
    assert.equal(parsed.data.parsed[0].category_id, categories.food.id)
    assert.equal(parsed.data.parsed[0].category_auto, true)
    const selects = page.locator('table tbody tr select')
    await selects.nth(1).selectOption(String(categories.travel.id))
    await selects.nth(2).selectOption('')
    await selects.nth(3).selectOption('')
    const bulk = page.locator('select').filter({ has: page.locator('option', { hasText: '选择分类（应用到所有未分类的同类记录）' }) })
    await bulk.selectOption(String(categories.shopping.id))
    const expected = [String(categories.food.id), String(categories.travel.id), String(categories.shopping.id), '']
    assert.deepEqual(await selects.evaluateAll((els) => els.map((el) => el.value)), expected)
    await page.setViewportSize({ width: 375, height: 812 })
    const cards = page.locator('.sheet-row select')
    await cards.first().waitFor({ state: 'visible' })
    assert.deepEqual(await cards.evaluateAll((els) => els.map((el) => el.value)), expected)
    await bulk.selectOption(String(categories.income.id))
    expected[3] = String(categories.income.id)
    assert.deepEqual(await cards.evaluateAll((els) => els.map((el) => el.value)), expected)
    await noOverflow('375px import preview')
    const payload = await successfulWrite('/api/transactions', () => page.getByRole('button', { name: '确认导入 4 条', exact: true }).click(), 'POST')
    await page.getByRole('heading', { name: '导入完成', exact: true }).waitFor()
    assert.deepEqual(payload.items.map((item) => String(item.category_id)), expected)
    for (let i = 0; i < descriptions.length; i++) {
      assert.equal(rows(descriptions[i]).length, 1)
      assert.equal(String(rows(descriptions[i])[0].category_id), expected[i])
    }
    await noOverflow('375px import completion')
  })

  await test('375px manual key path: real save and no horizontal overflow', async () => {
    await page.setViewportSize({ width: 375, height: 812 })
    const form = await manual('review-mobile-manual', '6.78')
    await noOverflow('375px manual form')
    await form.getByRole('button', { name: '保存这一笔' }).click()
    await saved('review-mobile-manual')
    assert.equal(rows('review-mobile-manual')[0].amount, 678)
    await noOverflow('375px saved ledger')
  })

  await test('cluster reset: late old-user dashboard/portfolio cannot replace new-user DOM', async () => {
    await page.setViewportSize({ width: 1280, height: 900 })
    const invite = await inject('POST', '/api/admin/invite-codes', { max_uses: 1 })
    const second = await inject('POST', '/api/auth/register', { username: 'review_second', password: PASSWORD, invite_code: invite.code }, null)
    await inject('POST', '/api/accounts', { name: '第二用户合成账户', initial_balance: 32100 }, second.token)
    await goto('/ledger')
    await eventually(async () => !(await page.locator('.cluster-fresh').isDisabled()), 'initial cluster loaded')
    const oldGate = gate()
    const oldResponses = []
    const released = []
    for (const path of ['/api/stats/dashboard', '/api/assets/portfolio']) {
      await page.route(`**${path}`, async (route) => {
        try {
          const response = await route.fetch()
          oldResponses.push({ path, body: await response.json() })
          await oldGate.promise
          await route.fulfill({ response })
          released.push(path)
        } catch (error) { asyncErrors.push(String(error)); await route.abort().catch(() => {}) }
      }, { times: 1 })
    }
    await page.locator('.cluster-fresh').click()
    await eventually(() => oldResponses.length === 2, 'both old-user responses held')
    assert.notEqual(oldResponses.find((r) => r.path.endsWith('portfolio')).body.data.netWorth, 32100)
    // SPA links only: a full page reload would destroy Pinia and conceal this regression.
    await page.locator('.rail-nav a[href="/settings"]').click()
    await page.getByRole('button', { name: '退出登录', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '确定', exact: true }).click()
    // waitForURL 会因客户端路由切换时的 navigation abort 报 ERR_ABORTED；等路径本身更稳。
    await page.waitForFunction(() => location.pathname === '/login')
    await login('review_second')
    await page.locator('.rail-nav a[href="/ledger"]').click()
    const netValue = page.locator('.cluster-c1 .val-full')
    const expenseValue = page.locator('.cluster-c3 .val-full')
    const numeric = async (locator) => Number((await locator.innerText()).replace(/[^0-9.-]/g, ''))
    await eventually(async () => await numeric(netValue) === 321 && !(await page.locator('.cluster-fresh').isDisabled()), 'new-user fresh cluster DOM')
    assert.equal(await numeric(expenseValue), 0)
    oldGate.release()
    await eventually(() => released.length === 2, 'old responses released')
    await page.waitForLoadState('networkidle')
    assert.equal(await numeric(netValue), 321, 'late old portfolio must not leak assets')
    assert.equal(await numeric(expenseValue), 0, 'late old dashboard must not leak expense')
    assert.equal(await page.locator('.cluster-fresh').isDisabled(), false)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE user_id = ?').get(second.user.id).n, 0)
  })

  await test('browser console/page errors and egress audit', async () => {
    assert.deepEqual(asyncErrors, [], 'route handler errors')
    assert.deepEqual(pageErrors, [], 'uncaught browser JavaScript errors')
    assert.deepEqual(consoleErrors, [], 'unexpected browser console errors')
    assert.deepEqual(deniedNode, [], 'unexpected application Node egress attempts')
    assert.deepEqual(deniedBrowser, [], 'unexpected page egress attempts')
    assert.ok(observedAborts.size > 0, 'injected lost-response browser error was observed, not silently ignored')
    const txWrites = writes.filter((w) => w.path === '/api/transactions')
    assert.ok(txWrites.length >= 5, `real browser transaction requests captured (${txWrites.length})`)
    console.log(`AUDIT browser transaction POSTs=${txWrites.length}; unexpected JS/console errors=0; expected lost-response errors observed; external forwarding=0; browser background requests denied=${backgroundDenied}`)
  })
} catch (error) {
  failures.push({ name: 'setup/runtime', error: error.stack || String(error) })
  console.error(`FAIL setup/runtime: ${error.stack || error}`)
} finally {
  for (const pending of openGates) pending.release()
  // Close every resource even when launch/setup/assertion fails. No port killing or process-wide exit.
  for (const [name, close] of [
    ['browser', async () => { await browser?.close() }],
    ['Vite', async () => { await vite?.close() }],
    ['API', async () => { await app?.close() }],
    ['DB', async () => { closeDb?.() }],
    ['deny proxy', async () => {
      if (proxy?.listening) {
        proxy.closeAllConnections()
        await new Promise((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()))
      }
    }],
  ]) {
    try { await close() } catch (error) { failures.push({ name: `cleanup ${name}`, error: String(error) }) }
  }
  net.Socket.prototype.connect = originalConnect
  globalThis.fetch = originalFetch
  dotenv.config = originalDotenvConfig
  syncBuiltinESMExports()
  rmSync(TMP, { recursive: true, force: true })
  console.log(`RESULT ${passed} passed / ${failures.length} failed; browser/Vite/API/DB closed; temporary files removed`)
  process.exitCode = failures.length ? 1 : 0
}
