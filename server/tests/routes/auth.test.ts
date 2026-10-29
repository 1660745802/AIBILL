/**
 * 认证路由集成测试
 * 覆盖: 注册、登录、获取用户信息、修改密码
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { buildApp, teardownApp, loginAdmin, createUser, authHeaders } from '../helpers.js'
import { getDb } from '../../src/db/index.js'
import { config } from '../../src/config.js'
import { ensureAdminUser, register, changePassword, adminResetPassword } from '../../src/services/auth.service.js'

describe('Auth Routes', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp()
  })

  afterAll(async () => {
    await teardownApp(app)
  })

  describe('POST /api/auth/login', () => {
    it('should login admin with correct credentials', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'testadmin123' },
      })
      const body = JSON.parse(res.payload)
      expect(res.statusCode).toBe(200)
      expect(body.code).toBe(0)
      expect(body.data.token).toBeTruthy()
      expect(body.data.user.role).toBe('admin')
    })

    it('should reject wrong password', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'wrongpassword' },
      })
      const body = JSON.parse(res.payload)
      expect(res.statusCode).toBe(401)
      expect(body.code).toBe(1004)
    })

    it('should reject non-existent user', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'nobody', password: 'whatever' },
      })
      expect(res.statusCode).toBe(401)
    })
  })

  describe('POST /api/auth/register', () => {
    it('should register a new user with valid invite code', async () => {
      const token = await createUser(app, 'testuser1')
      expect(token).toBeTruthy()
    })

    it('should reject duplicate username', async () => {
      const adminToken = await loginAdmin(app)
      const codeRes = await app.inject({
        method: 'POST',
        url: '/api/admin/invite-codes',
        headers: authHeaders(adminToken),
        payload: { max_uses: 1 },
      })
      const code = JSON.parse(codeRes.payload).data.code

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: 'testuser1', password: 'test123456', invite_code: code },
      })
      const body = JSON.parse(res.payload)
      expect(res.statusCode).toBe(400)
      expect(body.code).toBe(2002)
    })

    it('should reject invalid invite code', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: 'newuser', password: 'test123456', invite_code: 'INVALID' },
      })
      const body = JSON.parse(res.payload)
      expect(res.statusCode).toBe(400)
      expect(body.code).toBe(2001)
    })

    it('邀请码边界：恰好用完 / 恰好过期（昨日）/ 无过期时间', async () => {
      const adminToken = await loginAdmin(app)
      const mk = async (payload: Record<string, unknown>) => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/admin/invite-codes',
          headers: authHeaders(adminToken),
          payload,
        })
        return JSON.parse(res.payload).data.code as string
      }
      const register = (username: string, code: string) =>
        app.inject({
          method: 'POST',
          url: '/api/auth/register',
          payload: { username, password: 'test123456', invite_code: code },
        })

      // max_uses=1：第一个人成功，第二个被拒（“恰好用完”就是失效点）
      const single = await mk({ max_uses: 1 })
      expect((await register('invite_once', single)).statusCode).toBe(200)
      const second = await register('invite_twice', single)
      expect(second.statusCode).toBe(400)
      expect(JSON.parse(second.payload).code).toBe(2001)
      // 而且第二个用户一行都没建（整个事务回滚）
      const users = getDb().prepare('SELECT COUNT(*) c FROM users WHERE username = ?').get('invite_twice') as { c: number }
      expect(users.c).toBe(0)

      // 无过期时间：可用
      const never = await mk({ max_uses: 1, expires_at: null })
      expect((await register('invite_no_expiry', never)).statusCode).toBe(200)

      // 过期日期（昨天）：失效
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
      const expired = await mk({ max_uses: 5, expires_at: yesterday })
      const expiredRes = await register('invite_expired', expired)
      expect(expiredRes.statusCode).toBe(400)
      expect(JSON.parse(expiredRes.payload).code).toBe(2001)
    })

    it('should reject short username', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: 'ab', password: 'test123456', invite_code: 'X' },
      })
      expect(res.statusCode).toBe(400)
    })
  })

  describe('新密码的 bcrypt UTF-8 字节边界', () => {
    const prefix = '汉'.repeat(24)
    const overlong = [`${prefix}A`, `${prefix}B`]
    const error = { code: 2000, data: null, message: '密码的 UTF-8 编码不能超过72字节' }

    it('24汉字+A/B 会被 bcrypt 截断为同一密码，注册必须均拒绝且不消耗邀请码', async () => {
      expect(Buffer.byteLength(prefix, 'utf8')).toBe(72)
      expect(bcrypt.compareSync(overlong[1], bcrypt.hashSync(overlong[0], 4))).toBe(true)
      const adminToken = await loginAdmin(app)
      const code = (await app.inject({
        method: 'POST', url: '/api/admin/invite-codes', headers: authHeaders(adminToken), payload: { max_uses: 2 },
      })).json().data.code
      for (const [i, password] of overlong.entries()) {
        const username = `byte_reject_${i}`
        const res = await app.inject({
          method: 'POST', url: '/api/auth/register', payload: { username, password, invite_code: code },
        })
        expect(res.statusCode).toBe(400)
        expect(res.json()).toEqual(error)
        // 服务直接调用也不能绕过字节边界。
        expect(() => register({ username, password, invite_code: code })).toThrow(/72字节/)
        expect(getDb().prepare('SELECT id FROM users WHERE username = ?').get(username)).toBeUndefined()
      }
      expect(getDb().prepare('SELECT used_count FROM invite_codes WHERE code = ?').get(code)).toEqual({ used_count: 0 })
    })

    it.each([prefix, 'é'.repeat(36)])('合法72字节 Unicode 新密码可注册并登录（%#）', async (password) => {
      const username = password === prefix ? 'byte_boundary_cjk' : 'byte_boundary_utf8'
      expect(Buffer.byteLength(password, 'utf8')).toBe(72)
      const token = await createUser(app, username, password)
      expect(token).toBeTruthy()
      expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } })).statusCode).toBe(200)
    })

    it('改密与管理员重置拒绝超长新密码，失败不改哈希/token_version；合法 Unicode 可写', async () => {
      const username = 'byte_password_write'
      const token = await createUser(app, username)
      const adminToken = await loginAdmin(app)
      const db = getDb()
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as { id: number; password_hash: string; token_version: number }
      const row = () => db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)
      const before = row()
      for (const new_password of overlong) {
        for (const url of ['/api/auth/password', `/api/admin/users/${user.id}/reset-password`]) {
          const res = await app.inject({
            method: 'PUT', url, headers: authHeaders(url.startsWith('/api/admin') ? adminToken : token),
            payload: { old_password: 'test123456', new_password },
          })
          expect(res.statusCode).toBe(400)
          expect(res.json()).toEqual(error)
          expect(row()).toEqual(before)
        }
        expect(() => changePassword(user.id, 'test123456', new_password)).toThrow(/72字节/)
        expect(() => adminResetPassword(user.id, new_password)).toThrow(/72字节/)
        expect(row()).toEqual(before)
      }
      expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: authHeaders(token) })).statusCode).toBe(200)
      const changed = await app.inject({
        method: 'PUT', url: '/api/auth/password', headers: authHeaders(token),
        payload: { old_password: 'test123456', new_password: prefix },
      })
      expect(changed.statusCode).toBe(200)
      expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: prefix } })).statusCode).toBe(200)
      const resetPassword = '界'.repeat(23) + 'abc'
      expect((await app.inject({
        method: 'PUT', url: `/api/admin/users/${user.id}/reset-password`, headers: authHeaders(adminToken),
        payload: { new_password: resetPassword },
      })).statusCode).toBe(200)
      expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: resetPassword } })).statusCode).toBe(200)
      expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: authHeaders(changed.json().data.token) })).statusCode).toBe(401)
    })

    it('历史超长密码仍可登录、比对旧密码后更换为合法密码', async () => {
      // 模拟修复前的存量哈希；不可通过新写入口创建。
      getDb().prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
        .run('legacy_long_password', bcrypt.hashSync(overlong[0], 4))
      const login = await app.inject({
        method: 'POST', url: '/api/auth/login', payload: { username: 'legacy_long_password', password: overlong[0] },
      })
      expect(login.statusCode).toBe(200)
      const changed = await app.inject({
        method: 'PUT', url: '/api/auth/password', headers: authHeaders(login.json().data.token),
        payload: { old_password: overlong[0], new_password: '新的合法密码123' },
      })
      expect(changed.statusCode).toBe(200)
      expect((await app.inject({
        method: 'POST', url: '/api/auth/login', payload: { username: 'legacy_long_password', password: '新的合法密码123' },
      })).statusCode).toBe(200)
    })

    it('首次管理员写密码也校验字节边界，但已有管理员不受环境中旧密码影响', () => {
      const db = getDb()
      const original = { username: config.adminUsername, password: config.adminPassword }
      const rollback = new Error('rollback seed test')
      try {
        config.adminPassword = overlong[0]
        expect(() => ensureAdminUser()).not.toThrow() // 已有管理员：不重置、不校验旧配置
        expect(() => db.transaction(() => {
          db.prepare("UPDATE users SET role = 'user' WHERE role = 'admin'").run()
          config.adminUsername = 'unicode_seed'
          for (const password of overlong) {
            config.adminPassword = password
            expect(() => ensureAdminUser()).toThrow(/72字节/)
            expect(db.prepare('SELECT id FROM users WHERE username = ?').get(config.adminUsername)).toBeUndefined()
          }
          config.adminPassword = prefix
          ensureAdminUser()
          const admin = db.prepare('SELECT password_hash FROM users WHERE username = ?').get(config.adminUsername) as { password_hash: string }
          expect(bcrypt.compareSync(prefix, admin.password_hash)).toBe(true)
          throw rollback
        })()).toThrow(rollback)
      } finally {
        config.adminUsername = original.username
        config.adminPassword = original.password
      }
    })
  })

  describe('GET /api/auth/me', () => {
    it('should return user info with valid token', async () => {
      const token = await loginAdmin(app)
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: authHeaders(token),
      })
      const body = JSON.parse(res.payload)
      expect(res.statusCode).toBe(200)
      expect(body.data.user.username).toBe('admin')
    })

    it('should reject request without token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
      })
      expect(res.statusCode).toBe(401)
    })
  })

  describe('PUT /api/auth/password', () => {
    it('should change password with correct old password', async () => {
      const token = await createUser(app, 'pwduser')
      const res = await app.inject({
        method: 'PUT',
        url: '/api/auth/password',
        headers: authHeaders(token),
        payload: { old_password: 'test123456', new_password: 'newpassword123' },
      })
      const body = JSON.parse(res.payload)
      expect(res.statusCode).toBe(200)
      expect(body.code).toBe(0)
    })

    it('should reject wrong old password', async () => {
      const token = await createUser(app, 'pwduser2')
      const res = await app.inject({
        method: 'PUT',
        url: '/api/auth/password',
        headers: authHeaders(token),
        payload: { old_password: 'wrongold', new_password: 'newpassword123' },
      })
      expect(res.statusCode).toBe(400)
    })

    it('should return a new token and keep the current device logged in', async () => {
      const token = await createUser(app, 'pwduser3')
      const res = await app.inject({
        method: 'PUT',
        url: '/api/auth/password',
        headers: authHeaders(token),
        payload: { old_password: 'test123456', new_password: 'newpassword456' },
      })
      const body = JSON.parse(res.payload)
      expect(body.code).toBe(0)
      // 回归：改密会 bump token_version 使旧 token 失效，必须换发新 token，
      // 否则用户刚看到“修改成功”就被静默踢回登录页
      expect(body.data?.token).toBeTruthy()
      expect(body.data.token).not.toBe(token)

      // 新 token 可用
      const meRes = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: authHeaders(body.data.token),
      })
      expect(meRes.statusCode).toBe(200)
      expect(JSON.parse(meRes.payload).code).toBe(0)

      // 旧 token 已失效（其他设备需重新登录）
      const oldRes = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: authHeaders(token),
      })
      expect(oldRes.statusCode).toBe(401)
      expect(JSON.parse(oldRes.payload).code).toBe(1006)
    })

    it('should not issue a new token when the old password is wrong', async () => {
      const token = await createUser(app, 'pwduser4')
      const res = await app.inject({
        method: 'PUT',
        url: '/api/auth/password',
        headers: authHeaders(token),
        payload: { old_password: 'nope', new_password: 'newpassword456' },
      })
      const body = JSON.parse(res.payload)
      expect(res.statusCode).toBe(400)
      expect(body.data).toBeNull()

      // 原 token 不受影响
      const meRes = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: authHeaders(token),
      })
      expect(meRes.statusCode).toBe(200)
    })
  })
})
