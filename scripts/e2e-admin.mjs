#!/usr/bin/env node
/**
 * 管理面板端到端冒烟
 *
 * 为什么需要它：`views/Admin.vue`（2065 行）拆成「壳 + 10 个 panel module」后，
 * 静态检查（vue-tsc / vite build）能保证类型与编译，但**保证不了运行时**——
 * panel 的 `onMounted` 拉数、`v-if` 切换、以及壳与 panel 的 `@navigate` 接线
 * 只有真浏览器里跑一遍才算验过。本脚本用与 `e2e-assets.mjs` 同一套基建
 * （临时库 + 临时后端 + 临时 vite + playwright-core + 系统 chromium）。
 *
 * 用法：
 *   DB_PATH=/tmp/admin-e2e.db ADMIN_PASSWORD=xxx \
 *   CHROME_PATH="C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" \
 *   node scripts/e2e-admin.mjs
 *
 * 抓两类失败：
 *   1. 任一 tab 渲染后**缺**它自己的关键文案（panel 没挂上 / import 坏了）；
 *   2. 浏览器 **pageerror** 或 **console error**（模板引用错、请求处理抛错）。
 *
 * 它**只读**生产库（默认全新临时库；给了 DB_PATH 就用它），跑完清掉临时栈与临时库。
 */
import { spawn, execSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const API_PORT = Number(process.env.API_PORT || 3400)
const WEB_PORT = Number(process.env.WEB_PORT || 5499)
const TMP = mkdtempSync(join(tmpdir(), 'admin-e2e-'))
const DB = process.env.DB_PATH || join(TMP, 'bill.db')

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-e2e-pass-123'

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  for (const p of [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ]) {
    if (existsSync(p)) return p
  }
  return undefined
}

async function loadPlaywright() {
  for (const spec of [
    'playwright',
    'playwright-core',
    pathToFileURL(join(ROOT, 'web', 'node_modules', 'playwright-core', 'index.js')).href,
  ]) {
    try {
      const mod = await import(spec)
      const chromium = mod.chromium ?? mod.default?.chromium
      if (chromium) return { chromium }
    } catch { /* 试下一个 */ }
  }
  console.error('缺 playwright-core：cd web && npm i --no-save --no-package-lock playwright-core')
  process.exit(2)
}

const procs = []

/** 按端口杀进程（Windows 用 netstat/taskkill）。上一次被打断时的残留会占着端口。 */
function killPort(port) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr :${port}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
      const pids = new Set([...out.matchAll(/LISTENING\s+(\d+)/g)].map((m) => m[1]))
      for (const pid of pids) { try { execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' }) } catch {} }
    } else {
      const out = execSync(`ss -tlnpH 2>/dev/null | grep ':${port} ' || true`).toString()
      const pid = out.match(/pid=(\d+)/)?.[1]
      if (pid) process.kill(Number(pid), 'SIGTERM')
    }
  } catch { /* 端口没被占用 */ }
}

function cleanup() {
  for (const p of procs) {
    try {
      if (process.platform === 'win32') execSync(`taskkill /pid ${p.pid} /T /F`, { stdio: 'ignore' })
      else process.kill(-p.pid)
    } catch { try { p.kill() } catch {} }
  }
  killPort(API_PORT)
  killPort(WEB_PORT)
  try { rmSync(TMP, { recursive: true, force: true }) } catch {}
  try { rmSync(join(ROOT, 'web', 'vite.admin-e2e.config.ts'), { force: true }) } catch {}
}
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(130) })

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitPort(port, timeoutMs = 40000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/accounts`); if (r.status) return true } catch { /* not up */ }
    await wait(400)
  }
  return false
}

let pass = 0, fail = 0
const ok = (c, msg) => { c ? pass++ : fail++; console.log(`${c ? '  ✅' : '  ❌'} ${msg}`) }

/** 每个 tab：侧栏文案 + 该 panel 必须出现的「自己的」标记文案。 */
const TABS = [
  { key: 'overview', label: '概览', marker: '需要处理' },
  { key: 'users', label: '用户与邀请码', marker: '用户管理' },
  { key: 'quality', label: '解析质量', marker: 'AI 解析质量' },
  { key: 'triage', label: '未解析裁决', marker: '未解析裁决' },
  { key: 'samples', label: '被拦样本', marker: '被拦样本' },
  { key: 'automation', label: '自动化对照', marker: '自动化对照' },
  { key: 'rules', label: '通知规则', marker: '真源与发布' },
  { key: 'ai', label: 'AI 设置', marker: 'AI 模型配置' },
  { key: 'logs', label: '系统日志', marker: '系统日志' },
  { key: 'release', label: 'App 更新', marker: '当前激活版本' },
]

async function main() {
  const serverLog = join(TMP, 'server.log')
  /* 先把上一轮的残留从端口上清掉（否则新栈起不来）。 */
  killPort(API_PORT)
  killPort(WEB_PORT)
  await wait(1200)
  // shell:true —— Windows 上 npx 是 npx.cmd，不经 shell 直接 spawn 会 ENOENT。
  const srv = spawn('npx', ['tsx', 'src/app.ts'], {
    cwd: join(ROOT, 'server'),
    shell: true,
    env: {
      ...process.env,
      PORT: String(API_PORT),
      DB_PATH: DB,
      JWT_SECRET: 'admin-e2e-secret-key-at-least-32-chars',
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD,
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  procs.push(srv)
  writeFileSync(serverLog, '')
  srv.stdout.on('data', (d) => writeFileSync(serverLog, String(d), { flag: 'a' }))
  srv.stderr.on('data', (d) => writeFileSync(serverLog, String(d), { flag: 'a' }))

  const viteCfg = join(ROOT, 'web', 'vite.admin-e2e.config.ts')
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
  const web = spawn('npx', ['vite', '--config', 'vite.admin-e2e.config.ts'], {
    cwd: join(ROOT, 'web'), shell: true, detached: true, stdio: 'ignore',
  })
  procs.push(web)

  if (!(await waitPort(API_PORT))) {
    console.error('后端没起来。日志尾部：\n' + readFileSync(serverLog, 'utf8').slice(-1500))
    process.exit(1)
  }
  await wait(3500) // vite 首次冷启动

  const { chromium } = await loadPlaywright()
  const browser = await chromium.launch({ executablePath: chromePath() })
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage()
  const errs = []
  const unauth = []
  page.on('response', (r) => { if (r.status() === 401 && r.url().includes('/api/')) unauth.push(r.url().replace(B, '')) })
  page.on('pageerror', (e) => errs.push('pageerror: ' + String(e).split('\n')[0]))
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const t = m.text()
    // 忽略 vite HMR / favicon / 未登录时的 401 探测（app 启动期的 auth bootstrap，非本页缺陷）
    if (/favicon|\[vite\]|WebSocket/.test(t)) return
    if (/401 \(Unauthorized\)/.test(t)) return
    errs.push('console: ' + t.slice(0, 160))
  })
  const B = `http://127.0.0.1:${WEB_PORT}`

  console.log('【登录】')
  await page.goto(`${B}/login`, { waitUntil: 'networkidle' })
  await page.fill('input[type=text]', 'admin')
  await page.fill('input[type=password]', ADMIN_PASSWORD)
  await page.click('form button')
  await wait(2000)
  if (!page.url().startsWith(B) || page.url().includes('/login')) {
    console.error('登录失败：' + page.url())
    process.exit(1)
  }
  ok(true, '管理员登录成功')

  console.log('\n【就位 /admin】')
  await page.goto(`${B}/admin`, { waitUntil: 'networkidle' })
  await wait(2500)
  ok((await page.locator('.admin-nav-item').count()) === TABS.length, `侧栏 ${TABS.length} 个 tab 全在`)

  console.log('\n【逐个 tab：点击侧栏 → panel 挂载 → 关键文案 + 无报错】')
  for (const t of TABS) {
    const before = errs.length
    await page.locator('.admin-nav-item', { hasText: t.label }).first().click()
    await wait(1800)
    const body = await page.textContent('body')
    ok(body.includes(t.marker), `${t.key}：渲染「${t.marker}」`)
    ok(page.url().includes(`tab=${t.key}`), `${t.key}：URL 落 ?tab=${t.key}`)
    ok(errs.length === before, `${t.key}：无新增 JS 报错`)
  }

  console.log('\n【深链刷新（?tab=release）应直接挂载该 panel】')
  await page.goto(`${B}/admin?tab=release`, { waitUntil: 'networkidle' })
  await wait(1800)
  ok((await page.textContent('body')).includes('当前激活版本'), '深链 release 直接渲染')

  // ── 被拦样本：切来源**布局必须不跳**（曾因「筛选和标题挤一行 + `.field{width:100%}` 压过 `w-*`」→ 竖排且左移）──
  console.log('\n【被拦样本：切换来源布局不跳】')
  const measureSamples = () => page.evaluate(() => {
    const g = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    }
    return { src: g('[data-testid=samples-src]'), filters: g('[data-testid=samples-filters]') }
  })
  await page.goto(`${B}/admin?tab=samples`, { waitUntil: 'networkidle' }); await wait(1800)
  const geoCapture = await measureSamples()
  await page.getByRole('tab', { name: '服务端预筛挡下' }).click(); await wait(1800)
  const geoPrefilter = await measureSamples()
  ok(
    JSON.stringify(geoCapture) === JSON.stringify(geoPrefilter),
    `切来源表头不跳（几何一致：${JSON.stringify(geoCapture)}）`,
  )
  ok(geoCapture.filters.h <= 56, `筛选排成一行（filters.h=${geoCapture.filters.h}；竖排会 >150）`)
  await page.getByRole('tab', { name: '客户端采样' }).click(); await wait(1200)

  console.log('\n════════════════════════════════')
  console.log(`  ${pass} 通过 / ${fail} 失败`)
  console.log(`  JS 报错: ${errs.length ? errs.slice(0, 5).join(' | ') : '无'}`)
  console.log(`  401 探测（已忽略）: ${unauth.length ? [...new Set(unauth)].join(' | ') : '无'}`)
  console.log(`  后端日志: ${serverLog}`)
  console.log('════════════════════════════════')

  await browser.close()
  process.exit(fail > 0 || errs.length > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
