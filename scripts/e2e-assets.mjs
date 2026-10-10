#!/usr/bin/env node
/**
 * 资产工作台端到端检查
 *
 * 为什么不在 vitest 里：单元/路由测试只能验「函数返回对不对」，
 * 验不了「页面上有没有这个入口」「清空输入框后 DOM 回滚没有」这类事。
 * 下面这些真实缺陷**全部**是单测绿的情况下存在的：
 *   - 持仓入口藏在「账户设置 → 展开行 → 类型下拉」后面，新用户永远看不到
 *   - 行情抓取函数写好了却没有调用者 → 生产永远「未取到价」
 *   - 清空股数后输入框显示空、库里其实还是 10000
 *   - 补录历史日期把今天所有账户的值覆盖到过去
 *
 * 用法：
 *   node scripts/e2e-assets.mjs
 *
 * 环境变量（都有默认值，一般不用管）：
 *   DB_PATH     临时库；默认从 ~/.bill/bill.db 复制一份，没有则用全新库
 *   API_PORT    临时后端端口，默认 3300
 *   WEB_PORT    临时前端端口，默认 5399
 *   ADMIN_PASSWORD  没给就读仓库根目录的 .env
 *   CHROME_PATH playwright 的 chromium 可执行文件路径
 *
 * 它**只读**生产库（复制一份出来用），跑完把临时栈和临时库都删掉。
 */
import { spawn, execSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const API_PORT = Number(process.env.API_PORT || 3300)
const WEB_PORT = Number(process.env.WEB_PORT || 5399)
const TMP = mkdtempSync(join(tmpdir(), 'bill-e2e-'))
const DB = process.env.DB_PATH || join(TMP, 'bill.db')
const PROD_DB = join(homedir(), '.bill', 'bill.db')

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD ||
  (() => {
    const envFile = join(ROOT, '.env')
    if (!existsSync(envFile)) return ''
    const m = readFileSync(envFile, 'utf8').match(/^ADMIN_PASSWORD=(.*)$/m)
    return m ? m[1].trim() : ''
  })()

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const base = join(homedir(), '.cache', 'ms-playwright')
  if (!existsSync(base)) return undefined
  const candidates = execSync(`ls -d ${base}/chromium-*/chrome-linux64/chrome 2>/dev/null || true`)
    .toString().trim().split('\n').filter(Boolean)
  return candidates[0]
}

/**
 * playwright 解析：仓库根目录没有 package.json，所以裸 import 解析不到。
 * 依次尝试 全局 / web/node_modules，都失败就给一句可执行的安装指引。
 * 用 playwright-core：它不带浏览器（几 MB），配合已有的 chromium 用即可。
 */
async function loadPlaywright() {
  const tries = [
    'playwright',
    'playwright-core',
    pathToFileURL(join(ROOT, 'web', 'node_modules', 'playwright-core', 'index.js')).href,
    pathToFileURL(join(ROOT, 'web', 'node_modules', 'playwright', 'index.js')).href,
  ]
  for (const spec of tries) {
    try {
      const mod = await import(spec)
      // playwright-core 是 CJS：ESM 动态 import 后导出挂在 .default 上
      const chromium = mod.chromium ?? mod.default?.chromium
      if (chromium) return { chromium }
    } catch { /* 试下一个 */ }
  }
  console.error('缺 playwright。任选一种装法：')
  console.error('  cd web && npm i -D playwright-core      # 小；用系统已有的 chromium（设 CHROME_PATH）')
  console.error('  npm i -g playwright && npx playwright install chromium')
  process.exit(2)
}

const procs = []

/**
 * 按端口杀进程。
 * 为什么不能只靠 procs 里的 pid：脚本被 SIGKILL/外部打断时 cleanup 不执行，
 * 上一轮的临时栈会留下来占着端口，下一次跑就起不来（而且很难看出原因）。
 * 也不要提醒自己用 `pkill -f <模式>` —— 那个模式会匹配到调用者自己的命令行，
 * 把自己也杀掉（真踩过）。
 */
function killPort(port) {
  try {
    const out = execSync(`ss -tlnpH 2>/dev/null | grep ':${port} ' || true`).toString()
    const pid = out.match(/pid=(\d+)/)?.[1]
    if (pid) process.kill(Number(pid), 'SIGTERM')
  } catch { /* 端口没被占用 */ }
}

function cleanup() {
  for (const p of procs) { try { process.kill(-p.pid) } catch { try { p.kill() } catch {} } }
  // 兜一层：按端口再清一次，覆盖 detached 子进程没跟着走的情况
  killPort(API_PORT)
  killPort(WEB_PORT)
  try { rmSync(TMP, { recursive: true, force: true }) } catch {}
  try { rmSync(join(ROOT, 'web', 'vite.e2e.config.ts'), { force: true }) } catch {}
}
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(130) })

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitPort(port, timeoutMs = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/accounts`)
      if (r.status) return true
    } catch { /* 还没起来 */ }
    await wait(400)
  }
  return false
}

let pass = 0, fail = 0
const ok = (c, msg) => { c ? pass++ : fail++; console.log(`${c ? '  ✅' : '  ❌'} ${msg}`) }
function section(t) { console.log(`\n${t}`) }

async function main() {
  if (!ADMIN_PASSWORD) {
    console.error('缺 ADMIN_PASSWORD：设环境变量，或在仓库根目录的 .env 里填')
    process.exit(2)
  }

  /* ── 起临时栈（先清掉上一次的残留，端口要真空出来） ── */
  killPort(API_PORT)
  killPort(WEB_PORT)
  await wait(1200)
  if (!existsSync(DB) && existsSync(PROD_DB)) {
    execSync(`cp ${PROD_DB} ${DB}`)
    for (const suf of ['-wal', '-shm']) rmSync(DB + suf, { force: true })
  }
  const serverLog = join(TMP, 'server.log')
  const srv = spawn('npx', ['tsx', 'src/app.ts'], {
    cwd: join(ROOT, 'server'),
    env: {
      ...process.env,
      PORT: String(API_PORT),
      DB_PATH: DB,
      JWT_SECRET: 'e2e-assets-secret-key-at-least-32-chars',
      ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
      ADMIN_PASSWORD,
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  procs.push(srv)
  writeFileSync(serverLog, '')
  srv.stdout.on('data', (d) => writeFileSync(serverLog, String(d), { flag: 'a' }))

  // 临时 vite：同源代理到临时后端，用仓库里真实的 vite 配置骨架
  const viteCfg = join(ROOT, 'web', 'vite.e2e.config.ts')
  writeFileSync(viteCfg, `import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { port: ${WEB_PORT}, host: '127.0.0.1', proxy: { '/api': { target: 'http://127.0.0.1:${API_PORT}', changeOrigin: true } } },
})
`)
  const web = spawn('npx', ['vite', '--config', 'vite.e2e.config.ts'], {
    cwd: join(ROOT, 'web'), detached: true, stdio: 'ignore',
  })
  procs.push(web)

  if (!(await waitPort(API_PORT))) {
    console.error(`后端没起来（端口 ${API_PORT} 可能被占）。日志：` + serverLog)
    console.error(readFileSync(serverLog, 'utf8').slice(-1500))
    process.exit(1)
  }
  await wait(2500)

  /* ── 浏览器 ── */
  const { chromium } = await loadPlaywright()
  const browser = await chromium.launch({ executablePath: chromePath() })
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e).split('\n')[0]))
  const body = () => page.textContent('body')
  const B = `http://127.0.0.1:${WEB_PORT}`

  await page.goto(`${B}/login`, { waitUntil: 'networkidle' })
  await page.fill('input[type=text]', process.env.ADMIN_USERNAME || 'admin')
  await page.fill('input[type=password]', ADMIN_PASSWORD)
  await page.click('form button')
  await wait(2000)
  if (!page.url().startsWith(B)) { console.error('登录失败：' + page.url()); process.exit(1) }

  /* 可重入：先把所有账户重置为活期，保证起点干净 */
  section('【0】重置到干净起点')
  const accs = await page.evaluate(async () => {
    const r = await fetch('/api/accounts', { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } })
    return ((await r.json()).data?.items ?? []).map((a) => ({ id: a.id, name: a.name }))
  })
  for (const a of accs) {
    await page.evaluate(async (id) => {
      await fetch('/api/assets/accounts/' + id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
        body: JSON.stringify({ asset_type: 'liquid' }),
      })
    }, a.id)
  }
  ok(accs.length > 0, `已把 ${accs.length} 个账户重置为活期`)

  section('【1】入口：不依赖隐藏前置')
  await page.goto(`${B}/assets`, { waitUntil: 'networkidle' }); await wait(2200)
  ok(await page.locator('a[href="/investments"]').count() === 0, '没有理财账户时「投资」不出现')
  // 账户类型现在在账户列表的行内展开（不再有单独的「账户设置」列表）
  await page.locator('.acct-row button.acct-id-btn').filter({ hasText: accs[0].name }).first().click(); await wait(500)
  await page.locator('select.field').first().selectOption('investment'); await wait(300)
  await page.locator('button:has-text("保存类型")').first().click(); await wait(2500)
  ok(await page.locator('a[href="/investments"]').count() > 0, '标成理财投资后「投资」立刻出现（不用刷新）')
  ok(await page.locator('a[href="/investments"].sheet-row').count() > 0, '资产页有「投资持仓与盈亏」入口行')

  section('【2】投资页：配持仓')
  await page.goto(`${B}/investments`, { waitUntil: 'networkidle' }); await wait(2200)
  const t1 = await body()
  ok(t1.includes(accs[0].name), '按理财账户分段')
  await page.locator('input[aria-label="新持仓代码"]').first().fill('518880')
  await page.locator('input[aria-label="新持仓股数"]').first().fill('10000')
  await page.locator('button:has-text("添加持仓")').first().click(); await wait(2000)
  const t2 = await body()
  ok(t2.includes('518880') || t2.includes('未取到价'), '持仓添加成功')
  // 新增持仓现在会**自动取价**，所以正常路径应当看到现价，而不是「未取到价」。
  // 断网/接口挂了才回落到「未取到价」——两条都接受，但绝不能是 0。
  const hasPrice = /518880[\s\S]{0,200}现价\s*\d/.test(t2) || /现价\s*\d[\s\S]{0,200}518880/.test(t2)
  const hasNoQuote = t2.includes('未取到价')
  ok(hasPrice || hasNoQuote, hasPrice ? '新增持仓自动取到价（不用手动刷新）' : '断网时回落「未取到价」，不是 0')
  ok(!/市值\s*¥?0(\.00)?\b/.test(t2), '行情缺失也绝不显示 0（0 会被读成归零了）')
  ok(!t2.includes('先记一次现金'), '没有「先记一次现金」这种前置要求（不填就是 0）')

  section('【3】股数：清空与非法输入都要回滚')
  const qRow = page.locator('input[aria-label$="的股数"]').first()
  const before = await qRow.inputValue()
  await qRow.fill(''); await qRow.blur(); await wait(1500)
  ok((await qRow.inputValue()) === before, `清空后回滚到真实值（"${before}"）— 空值不是 0 股`)
  await qRow.fill('-5'); await qRow.blur(); await wait(1500)
  ok((await qRow.inputValue()) === before, '负数被拒并回滚')

  section('【4】账户：一个列表管余额 + 类型，保存按需出现')
  await page.goto(`${B}/assets`, { waitUntil: 'networkidle' }); await wait(2200)
  ok(await page.locator('.acct-row').count() > 0, '账户列表渲染')
  // 同一批账户只该出现一次（以前「各账户余额」和「账户设置」各列一遍）
  ok(await page.locator('.acct-row').count() === accs.length, `账户只列一遍（${accs.length} 行）`)
  ok(!(await page.locator('input[type="date"]').count()), '没有日期选择（不强调「记录到某天」）')
  ok(!(await page.getByText('记录今日').count()), '没有「记录今日」这种仪式措辞')

  // 新设计：主数字是**账户总价值**（只读），现金输入收进行内展开、离开即存。
  // 不再有整页的「保存」按钮（.acct-foot）——一行一存。
  ok(!(await page.locator('.acct-foot').count()), '没有整页保存按钮（一行一存）')
  ok(await page.locator('.acct-sum').count() > 0, '有「合计」，且与仪表盘净资产同口径')

  // 展开某一行：应出现「现金」输入框（设计契约）。
  // 保存时序由服务端测试覆盖（account-balance-model.test.ts），这里只验 UI 结构。
  const nRows = await page.locator('button.acct-id-btn').count()
  ok(nRows > 0, '账户行可点开')
  let cash = page.locator('input[aria-label$=" 现金"]').first()
  if ((await cash.count()) === 0) {
    await page.locator('button.acct-id-btn').first().click(); await wait(700)
    cash = page.locator('input[aria-label$=" 现金"]').first()
  }
  ok(await cash.count() > 0, '展开后有「现金」输入框')
  ok(await cash.count() > 0 && await cash.getAttribute('placeholder') === '0.00', '空现金的占位是 0.00')

  section('【5】口径一致性')
  await page.goto(`${B}/overview`, { waitUntil: 'networkidle' }); await wait(2200)
  const t5 = await body()
  ok(!t5.includes('还没有账户'), '有账户但没记余额时，不说「还没有账户」')

  console.log('\n════════════════════════════════')
  console.log(`  ${pass} 通过 / ${fail} 失败`)
  console.log(`  JS 错误: ${errs.length ? errs.slice(0, 3).join(' | ') : '无'}`)
  console.log(`  后端日志: ${serverLog}`)
  console.log('════════════════════════════════')

  await browser.close()

  /*
   * 必须显式 exit，不能只设 exitCode。
   * 后端是用 'pipe' 起的、我们还挂着 stdout 的监听，那个句柄会让事件循环
   * 一直活着 → 进程不退出 → `exit` 钩子里的 cleanup 永远不执行 →
   * 打印完「23 通过 / 0 失败」之后把临时栈和临时库全留在机器上。
   * （实测踩过：脚本报成功，端口上却还蹲着两个进程。）
   */
  process.exit(fail > 0 || errs.length > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
