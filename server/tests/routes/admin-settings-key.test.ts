import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import Fastify, { type FastifyInstance } from 'fastify'

// This suite tests settings only. Authentication is covered by separate suites;
// no production configuration, DB, credentials, or external requests are loaded.
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('../../src/db/index.js', () => ({ getDb: () => state.db }))
vi.mock('../../src/middleware/auth.js', () => ({ authMiddleware: vi.fn() }))
import { adminSettingsRoutes } from '../../src/routes/admin/settings.js'

describe('admin settings: masked API key round trip', () => {
  let app: FastifyInstance
  beforeEach(async () => {
    state.db = new Database(':memory:')
    state.db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)')
    state.db.prepare('INSERT INTO settings(key, value) VALUES (?, ?)').run('ai_api_key', 'test-key-original')
    state.db.prepare('INSERT INTO settings(key, value) VALUES (?, ?)').run('ai_model', 'original-model')
    app = Fastify()
    await app.register(adminSettingsRoutes)
    await app.ready()
  })
  afterEach(async () => { await app.close(); state.db.close() })
  const value = (key: string) => state.db.prepare('SELECT value FROM settings WHERE key = ?').get(key).value
  const put = (payload: Record<string, string>) => app.inject({ method: 'PUT', url: '/api/admin/settings', payload })

  it('rejects the known GET mask without partially applying other settings', async () => {
    const read = (await app.inject({ method: 'GET', url: '/api/admin/settings' })).json()
    expect(read.data.ai_api_key).toBe('test-key***')
    const response = await put({ ...read.data, ai_model: 'changed-model' })
    expect(response.statusCode).toBe(400)
    expect(response.json().code).not.toBe(0)
    expect(value('ai_api_key')).toBe('test-key-original')
    expect(value('ai_model')).toBe('original-model')
  })
  it('leaves the key unchanged when only the model is sent', async () => {
    expect((await put({ ai_model: 'new-model' })).statusCode).toBe(200)
    expect(value('ai_api_key')).toBe('test-key-original')
    expect(value('ai_model')).toBe('new-model')
  })
  it.each(['replacement***valid', 'new-key-***', ''])('accepts an explicit replacement or clearing: %j', async (key) => {
    expect((await put({ ai_api_key: key })).statusCode).toBe(200)
    expect(value('ai_api_key')).toBe(key)
  })
})
