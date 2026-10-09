/**
 * 认证路由集成测试
 * 覆盖: 注册、登录、获取用户信息、修改密码
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, teardownApp, loginAdmin, createUser, authHeaders } from '../helpers.js'

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

    it('should reject short username', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: 'ab', password: 'test123456', invite_code: 'X' },
      })
      expect(res.statusCode).toBe(400)
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
