/**
 * Test setup: create a Fastify app with in-memory SQLite for each test suite
 */
import Fastify, { type FastifyInstance } from 'fastify'
import Database from 'better-sqlite3'
import { vi } from 'vitest'

// Override config before any app code loads
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long'
process.env.ADMIN_PASSWORD = 'testadmin123'
process.env.ADMIN_USERNAME = 'admin'
process.env.DB_PATH = ':memory:'
