/**
 * 认证服务 - 注册/登录/用户信息
 */
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { getDb } from '../db/index.js'
import { config } from '../config.js'
import {
  insertDefaultExpenseCategories,
  insertDefaultIncomeCategories,
  insertDefaultAccounts,
} from '../db/schema.js'
import type { JwtPayload } from '../middleware/auth.js'

export interface RegisterInput {
  username: string
  password: string
  invite_code: string
  nickname?: string
}

export interface LoginInput {
  username: string
  password: string
}

export interface UserInfo {
  id: number
  username: string
  nickname: string | null
  role: string
}

interface UserRow {
  id: number
  username: string
  password_hash: string
  nickname: string | null
  role: string
  is_active: number
}

interface InviteCodeRow {
  id: number
  code: string
  max_uses: number
  used_count: number
  expires_at: string | null
}

/**
 * 签发 JWT（30 天有效期）
 */
function signToken(userId: number, role: string): string {
  return jwt.sign({ userId, role } as JwtPayload, config.jwtSecret, {
    expiresIn: '30d',
  })
}

/**
 * 注册：校验邀请码 → 创建用户 → 生成默认分类/账户 → 返回 JWT
 */
export function register(input: RegisterInput): { token: string; user: UserInfo } {
  const db = getDb()

  // 1. 校验邀请码
  const inviteCode = db
    .prepare(
      `SELECT id, code, max_uses, used_count, expires_at FROM invite_codes
       WHERE code = ? AND used_count < max_uses
       AND (expires_at IS NULL OR expires_at > datetime('now'))`,
    )
    .get(input.invite_code) as InviteCodeRow | undefined

  if (!inviteCode) {
    throw new AppError(2001, '邀请码无效、已用完或已过期')
  }

  // 2. 检查用户名是否已存在
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(input.username)
  if (existing) {
    throw new AppError(2002, '用户名已被注册')
  }

  // 3. 在事务内完成：创建用户 + 默认分类 + 默认账户 + 邀请码计数+1
  const passwordHash = bcrypt.hashSync(input.password, 10)

  const result = db.transaction(() => {
    // 创建用户
    const insertUser = db.prepare(
      `INSERT INTO users (username, password_hash, nickname, role) VALUES (?, ?, ?, 'user')`,
    )
    const userResult = insertUser.run(input.username, passwordHash, input.nickname || null)
    const userId = Number(userResult.lastInsertRowid)

    // 生成默认分类
    insertDefaultExpenseCategories(db, userId)
    insertDefaultIncomeCategories(db, userId)

    // 生成默认账户
    insertDefaultAccounts(db, userId)

    // 邀请码计数 +1
    db.prepare('UPDATE invite_codes SET used_count = used_count + 1 WHERE id = ?').run(
      inviteCode.id,
    )

    return {
      id: userId,
      username: input.username,
      nickname: input.nickname || null,
      role: 'user' as const,
    }
  })()

  const token = signToken(result.id, result.role)

  return { token, user: result }
}

/**
 * 登录：校验用户名密码 → 返回 JWT
 */
export function login(input: LoginInput): { token: string; user: UserInfo } {
  const db = getDb()

  const user = db
    .prepare('SELECT id, username, password_hash, nickname, role, is_active FROM users WHERE username = ?')
    .get(input.username) as UserRow | undefined

  if (!user) {
    throw new AppError(1004, '用户名或密码错误')
  }

  if (!user.is_active) {
    throw new AppError(1005, '账号已被禁用')
  }

  const valid = bcrypt.compareSync(input.password, user.password_hash)
  if (!valid) {
    throw new AppError(1004, '用户名或密码错误')
  }

  const token = signToken(user.id, user.role)

  return {
    token,
    user: {
      id: user.id,
      username: user.username,
      nickname: user.nickname,
      role: user.role,
    },
  }
}

/**
 * 获取当前用户信息
 */
export function getUserById(userId: number): UserInfo | null {
  const db = getDb()
  const user = db
    .prepare('SELECT id, username, nickname, role FROM users WHERE id = ? AND is_active = 1')
    .get(userId) as UserInfo | undefined
  return user || null
}

/**
 * 首次启动时创建管理员账户（幂等）
 */
export function ensureAdminUser(): void {
  const db = getDb()
  const admin = db.prepare('SELECT id FROM users WHERE role = ?').get('admin')
  if (admin) return

  const passwordHash = bcrypt.hashSync(config.adminPassword, 10)
  const result = db
    .prepare(
      `INSERT INTO users (username, password_hash, nickname, role) VALUES (?, ?, '管理员', 'admin')`,
    )
    .run(config.adminUsername, passwordHash)

  const adminId = Number(result.lastInsertRowid)

  // 为管理员也生成默认分类和账户
  insertDefaultExpenseCategories(db, adminId)
  insertDefaultIncomeCategories(db, adminId)
  insertDefaultAccounts(db, adminId)

  console.log(`[Auth] Admin user "${config.adminUsername}" created`)
}

/**
 * 应用错误类
 */
export class AppError extends Error {
  code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
    this.name = 'AppError'
  }
}
