/**
 * Test helpers: build Fastify app + utility functions
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { initDb, closeDb, getDb } from '../src/db/index.js'
import { registerRoutes } from '../src/routes/index.js'
import { ensureAdminUser } from '../src/services/auth.service.js'

export async function buildApp(): Promise<FastifyInstance> {
  // Use a fresh in-memory DB each time
  process.env.DB_PATH = ':memory:'

  // Re-init DB (in-memory is fresh each call if we close first)
  try { closeDb() } catch { /* first time */ }
  initDb()
  ensureAdminUser()

  const app = Fastify({ logger: false })
  await registerRoutes(app)
  await app.ready()
  return app
}

export async function teardownApp(app: FastifyInstance): Promise<void> {
  await app.close()
  closeDb()
}

/**
 * Login as admin and return the JWT token
 */
export async function loginAdmin(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'testadmin123' },
  })
  const body = JSON.parse(res.payload)
  return body.data.token
}

/**
 * Create an invite code (as admin) and register a new user, return token
 */
export async function createUser(app: FastifyInstance, username: string, password = 'test123456'): Promise<string> {
  const adminToken = await loginAdmin(app)

  // Create invite code
  const codeRes = await app.inject({
    method: 'POST',
    url: '/api/admin/invite-codes',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { max_uses: 1 },
  })
  const inviteCode = JSON.parse(codeRes.payload).data.code

  // Register user
  const regRes = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password, invite_code: inviteCode },
  })
  const regBody = JSON.parse(regRes.payload)
  return regBody.data.token
}

/**
 * Inject helper with auth
 */
export function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}
