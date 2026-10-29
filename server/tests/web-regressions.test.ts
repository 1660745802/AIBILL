import { describe, it, expect, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

// 该文件验证 Web 组件行为；服务端单独安装时跳过，避免 server 测试依赖 web/node_modules。
const webModules = fileURLToPath(new URL('../../web/node_modules/', import.meta.url))
const webDepsReady = existsSync(`${webModules}vue/package.json`) &&
  existsSync(`${webModules}@vue/compiler-sfc/package.json`)
if (!webDepsReady) console.warn('[web-regressions] skip: web/node_modules 未安装')

const webRequire = webDepsReady ? createRequire(new URL('../../web/package.json', import.meta.url)) : null
const vue = webDepsReady ? webRequire!('vue') : null
const { parse, compileScript } = webDepsReady
  ? webRequire!('@vue/compiler-sfc')
  : { parse: null, compileScript: null }
const webRoot = new URL('../../web/src/', import.meta.url)
const describeWeb = webDepsReady ? describe : describe.skip
const ok = (data: any = {}) => ({ data: { code: 0, data } })
function deferred() {
  let resolve!: (value: any) => void
  let reject!: (reason: any) => void
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function harness() {
  const api = { get: vi.fn().mockResolvedValue(ok({ items: [] })), post: vi.fn().mockResolvedValue(ok()), put: vi.fn().mockResolvedValue(ok()) }
  const toast = { success: vi.fn(), error: vi.fn(), warning: vi.fn() }
  let sequence = 0
  const imports: Record<string, any> = {
    vue: { ...vue!, onMounted: () => {} },
    pinia: { defineStore: (_name: string, setup: Function) => setup },
    '@/api/index': { default: api },
    '@/composables/useToast': { useToast: () => toast },
    '@/utils/date': { today: () => '2026-07-01' },
    '@/utils/uuid': { generateUUID: () => `test-id-${++sequence}` },
    '@/stores/cluster': { useClusterStore: () => ({ load: vi.fn() }) },
    '@/composables/useQuickEntry': { useQuickEntry: () => ({ state: vue.reactive({ open: false }), close: vi.fn() }) },
  }
  function load(file: string, props: any = {}, emit = vi.fn()) {
    const filename = fileURLToPath(new URL(file, webRoot))
    let source = readFileSync(filename, 'utf8')
    if (file.endsWith('.vue')) source = compileScript!(parse!(source, { filename }).descriptor, { id: 'regression' }).content
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    const module = { exports: {} as any }
    new Function('require', 'module', 'exports', js)((id: string) => {
      if (imports[id]) return imports[id]
      if (id.endsWith('.vue')) return { default: {} }
      throw new Error(`Unmocked import: ${id}`)
    }, module, module.exports)
    return file.endsWith('.vue') ? module.exports.default.setup(props, { expose() {}, emit }) : module.exports
  }
  return { api, toast, load }
}
const bill = (extra: any = {}) => ({ type: 'expense', amount: 1200, category_id: 1, description: 'test bill', date: '2026-07-01', ...extra })

describeWeb('Web audit regressions: settings and account updates', () => {
  it('omits the masked key until explicitly edited, supports replacement and clearing', async () => {
    const { api, load } = harness()
    api.get.mockResolvedValue(ok({ ai_api_key: 'test-key***', ai_model: 'old' }))
    const panel = load('components/admin/AdminAiPanel.vue')
    await panel.fetchSettings()
    expect(panel.apiKey?.value).toBe('')
    panel.globalSettings.value.ai_model = 'new'
    await panel.saveSettings()
    expect(api.put.mock.calls[0][1]).not.toHaveProperty('ai_api_key')
    panel.apiKey.value = 'replacement***valid'
    panel.apiKeyEdited.value = true
    await panel.saveSettings()
    expect(api.put.mock.calls[1][1].ai_api_key).toBe('replacement***valid')
    panel.apiKey.value = ''
    panel.apiKeyEdited.value = true
    await panel.saveSettings()
    expect(api.put.mock.calls[2][1].ai_api_key).toBe('')
  })

  it.each(['name', 'icon', 'type', 'reverted balance'])('does not reset the balance baseline for %s', async (change) => {
    const { api, load } = harness()
    const form = load('components/AccountManager.vue')
    form.startEdit({ id: 1, name: 'account', icon: 'A', current_balance: 12345, asset_type: 'liquid' })
    if (change === 'name') form.editName.value = 'renamed'
    if (change === 'icon') form.editIcon.value = 'B'
    if (change === 'type') form.editType.value = 'savings'
    if (change === 'reverted balance') { form.editBalance.value = '500'; form.editBalance.value = '123.450' }
    await form.saveEdit()
    expect(api.put.mock.calls[0][1]).not.toHaveProperty('current_balance')
  })

  it('includes a genuinely edited balance in cents', async () => {
    const { api, load } = harness()
    const form = load('components/AccountManager.vue')
    form.startEdit({ id: 1, name: 'account', current_balance: 12345 })
    form.editBalance.value = '99.99'
    await form.saveEdit()
    expect(api.put.mock.calls[0][1].current_balance).toBe(9999)
  })
})

describeWeb('Web audit regressions: transaction submission', () => {
  it('locks manual submissions synchronously, including AI confirmation', async () => {
    const { api, load } = harness()
    const home = load('views/Home.vue')
    const pending = deferred()
    api.post.mockReturnValue(pending.promise)
    const first = home.handleManualSubmit(bill())
    const repeated = home.handleManualSubmit(bill())
    const ai = home.handleConfirm([bill()])
    const requests = api.post.mock.calls.length
    pending.resolve(ok())
    await Promise.all([first, repeated, ai])
    expect(requests).toBe(1)
    expect(home.confirming.value).toBe(false)
  })

  it.each(['manual', 'ai'])('%s retries reuse IDs; edited or confirmed drafts get new IDs', async (kind) => {
    const { api, load } = harness()
    const home = load('views/Home.vue')
    const submit = (item: any) => kind === 'manual' ? home.handleManualSubmit(item) : home.handleConfirm([item])
    api.post.mockRejectedValue(new Error('response lost after commit'))
    await submit(bill())
    await submit(bill())
    const id = (n: number) => api.post.mock.calls[n][1].items[0].client_id
    expect(id(1)).toBe(id(0))
    await submit(bill({ amount: 1300 }))
    expect(id(2)).not.toBe(id(1))
    api.post.mockResolvedValue(ok())
    await submit(bill({ amount: 1300 }))
    expect(id(3)).toBe(id(2))
    await submit(bill({ amount: 1300 }))
    expect(id(4)).not.toBe(id(3))
  })

  it('preserves unchanged AI row IDs if a failed batch is edited or a row is removed', async () => {
    const { api, load } = harness()
    const home = load('views/Home.vue')
    api.post.mockRejectedValue(new Error('response lost'))
    await home.handleConfirm([bill(), bill({ amount: 2200 })])
    await home.handleConfirm([bill({ amount: 2200 })])
    expect(api.post.mock.calls[1][1].items[0].client_id).toBe(api.post.mock.calls[0][1].items[1].client_id)
  })

  it.each(['manual', 'ai'])('%s cancellation ends the operation and allows an identical new bill', async (kind) => {
    const { api, load } = harness()
    const home = load('views/Home.vue')
    const submit = () => kind === 'manual' ? home.handleManualSubmit(bill()) : home.handleConfirm([bill()])
    api.post.mockRejectedValue(new Error('response lost'))
    await submit()
    if (kind === 'manual') { home.cancelManual(); home.openManual() }
    else home.resetComposer()
    await submit()
    expect(api.post.mock.calls[1][1].items[0].client_id).not.toBe(api.post.mock.calls[0][1].items[0].client_id)
  })

  it('keeps an unconfirmed draft and its ID on a nonzero business code', async () => {
    const { api, load } = harness()
    const home = load('views/Home.vue')
    home.showManual.value = true
    api.post.mockResolvedValue({ data: { code: 2000, message: 'rejected' } })
    await home.handleManualSubmit(bill())
    expect(home.showManual.value).toBe(true)
    await home.handleManualSubmit(bill())
    expect(api.post.mock.calls[1][1].items[0].client_id).toBe(api.post.mock.calls[0][1].items[0].client_id)
  })

  it('passes loading to ManualForm, whose handler and submit button respect it', () => {
    const { load } = harness()
    const emit = vi.fn()
    const form = load('components/ManualForm.vue', { loading: true }, emit)
    form.amount.value = '12'
    form.categoryId.value = 1
    form.handleSubmit()
    expect(emit).not.toHaveBeenCalled()
    const home = readFileSync(new URL('views/Home.vue', webRoot), 'utf8')
    expect(home).toMatch(/<ManualForm\b[^>]*:loading="confirming"/)
    const manual = readFileSync(new URL('components/ManualForm.vue', webRoot), 'utf8')
    expect(manual).toMatch(/<button\b[^>]*type="submit"[^>]*:disabled="(?:props\.)?loading"/)
  })
})

describeWeb('Web audit regressions: reset generation', () => {
  it.each(['success', 'failure', 'business failure'])('ignores old %s and finally while new load is in flight', async (outcome) => {
    const { api, load } = harness()
    const store = load('stores/cluster.ts').useClusterStore()
    const oldDash = deferred(), oldPortfolio = deferred(), newDash = deferred(), newPortfolio = deferred()
    api.get.mockReturnValueOnce(oldPortfolio.promise).mockReturnValueOnce(oldDash.promise)
      .mockReturnValueOnce(newPortfolio.promise).mockReturnValueOnce(newDash.promise)
    const first = store.load()
    store.reset()
    expect(store.loading.value).toBe(false)
    const second = store.load()
    expect(api.get).toHaveBeenCalledTimes(4)
    if (outcome === 'success') { oldDash.resolve(ok({ owner: 'old' })); oldPortfolio.resolve(ok({ owner: 'old' })) }
    else if (outcome === 'failure') { oldDash.reject(new Error('old')); oldPortfolio.reject(new Error('old')) }
    else { oldDash.resolve({ data: { code: 1, message: 'old' } }); oldPortfolio.resolve({ data: { code: 1 } }) }
    await first
    expect(store.data.value).toBeNull()
    expect(store.portfolio.value).toBeNull()
    expect(store.updatedAt.value).toBeNull()
    expect(store.error.value).toBe('')
    expect(store.portfolioState.value).toBe('pending')
    expect(store.loading.value).toBe(true)
    newDash.resolve(ok({ owner: 'new' })); newPortfolio.resolve(ok({ owner: 'new' }))
    await second
    expect(store.data.value.owner).toBe('new')
    expect(store.portfolio.value.owner).toBe('new')
    expect(store.loading.value).toBe(false)
  })

  it('a late old success cannot overwrite new cached data, and reset bypasses cache', async () => {
    const { api, load } = harness()
    const store = load('stores/cluster.ts').useClusterStore()
    const oldDash = deferred(), oldPortfolio = deferred()
    api.get.mockReturnValueOnce(oldPortfolio.promise).mockReturnValueOnce(oldDash.promise)
    const first = store.load()
    store.reset()
    api.get.mockResolvedValue(ok({ owner: 'new' }))
    await store.load()
    oldDash.resolve(ok({ owner: 'old' })); oldPortfolio.resolve(ok({ owner: 'old' }))
    await first
    expect(store.data.value.owner).toBe('new')
    expect(store.portfolio.value.owner).toBe('new')
    store.reset()
    await store.load()
    expect(api.get).toHaveBeenCalledTimes(6)
  })
})

describeWeb('Web audit regressions: CSV import', () => {
  function importer() {
    const h = harness()
    const flow = h.load('composables/useBillImport.ts').useBillImport()
    flow.categories.value = [{ id: 1, name: 'Food', icon: 'A', type: 'expense' }, { id: 2, name: 'Travel', icon: 'B', type: 'expense' }, { id: 3, name: 'Salary', icon: 'C', type: 'income' }]
    return { ...h, flow }
  }
  it('bulk categorization only changes unclassified rows of the same type', () => {
    const { flow } = importer()
    flow.previewItems.value = [bill({ category_id: null }), bill({ category_id: 2, category_auto: true }), bill({ category_id: 2, category_auto: false }), bill({ type: 'income', category_id: null }), bill({ type: 'transfer', category_id: null })]
    const unchanged = JSON.parse(JSON.stringify(flow.previewItems.value.slice(1)))
    flow.bulkSetCategory('1')
    expect(flow.previewItems.value[0].category_id).toBe(1)
    expect(flow.previewItems.value.slice(1)).toEqual(unchanged)
  })

  it('retries identical rows with stable IDs, but assigns a new ID after an edit', async () => {
    const { api, flow } = importer()
    flow.previewItems.value = [bill(), bill()]
    api.post.mockRejectedValue(new Error('response lost'))
    await flow.submit()
    await flow.submit()
    const ids = (n: number) => api.post.mock.calls[n][1].items.map((i: any) => i.client_id)
    expect(ids(1)).toEqual(ids(0))
    expect(new Set(ids(0)).size).toBe(2)
    flow.setItemCategory(flow.previewItems.value[0], '2')
    await flow.submit()
    expect(ids(2)[0]).not.toBe(ids(1)[0])
    expect(ids(2)[1]).toBe(ids(1)[1])
  })

  it('keeps partially confirmed imports retryable and reuses IDs in every chunk', async () => {
    const { api, flow } = importer()
    flow.previewItems.value = Array.from({ length: 101 }, (_, i) => bill({ description: `row-${i}` }))
    api.post.mockResolvedValueOnce(ok({ created: Array(100).fill({}), duplicates: [] }))
      .mockRejectedValueOnce(new Error('last chunk response lost'))
    await flow.submit()
    expect(flow.imported.value).toBe(false)
    expect(flow.importResult.value).toEqual({ success: 100, failed: 1, failedItems: [100] })
    expect(flow.error.value).toContain('未能确认')
    api.post.mockImplementation(async (_url: string, body: any) => ok({ created: [], duplicates: body.items }))
    await flow.submit()
    expect(api.post.mock.calls[2][1]).toEqual(api.post.mock.calls[0][1])
    expect(api.post.mock.calls[3][1]).toEqual(api.post.mock.calls[1][1])
    expect(flow.importResult.value).toMatchObject({ success: 101, failed: 0 })
    expect(flow.imported.value).toBe(true)
  })

  it('snapshots all chunk contents before waiting for the first response', async () => {
    const { api, flow } = importer()
    flow.previewItems.value = Array.from({ length: 101 }, () => bill())
    const pending = deferred()
    api.post.mockReturnValueOnce(pending.promise)
    const first = flow.submit()
    flow.previewItems.value[100].amount = 9999
    pending.resolve(ok())
    await first
    expect(api.post.mock.calls[1][1].items[0].amount).toBe(1200)
  })

  it('locks CSV submission and counts server-confirmed duplicates as success on retry', async () => {
    const { api, flow } = importer()
    flow.previewItems.value = [bill()]
    const pending = deferred()
    api.post.mockReturnValueOnce(pending.promise)
    const first = flow.submit()
    await flow.submit()
    expect(api.post).toHaveBeenCalledTimes(1)
    pending.resolve(ok({ created: [], duplicates: [bill()] }))
    await first
    expect(flow.importResult.value).toMatchObject({ success: 1, failed: 0 })
  })
})
