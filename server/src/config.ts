import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config();

export interface AppConfig {
  port: number;
  jwtSecret: string;
  adminUsername: string;
  adminPassword: string;
  aiBaseUrl: string;
  aiApiKey: string;
  aiModel: string;
  dbPath: string;
  corsOrigins: string[];
  updatesDir: string;
}

/**
 * 已知的**占位**密钥/口令（.env.example、docker-compose.yml 默认值、本文件兜底值）。
 * 启动时据此告警：这几串是公开的，等于没配。
 * 单独放在这里是因为 compose 的兜底值和 config 的兜底值**不是同一个串**，
 * 只比对自己那一串，会让「走 docker-compose 部署但忘了改密钥」这类最常见的
 * 误配一声不响地放过去。新增默认值时同步加进来。
 */
export const PLACEHOLDER_JWT_SECRETS: readonly string[] = [
  'your-random-secret-at-least-32-chars',
  'please-change-this-secret-in-production',
];
export const PLACEHOLDER_ADMIN_PASSWORDS: readonly string[] = ['changeme123'];

// PORT 兜底：非整数 / 越界一律回落 3000，否则 NaN 会一路传到 app.listen。
const rawPort = (process.env.PORT ?? '').trim();
const parsedPort = Number.parseInt(rawPort, 10);
const port =
  Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : 3000;
if (rawPort !== '' && rawPort !== String(port)) {
  console.warn(`[Config] PORT=${rawPort} 非法，已回退到 ${port}`);
}

export const config: AppConfig = {
  port,
  jwtSecret: process.env.JWT_SECRET || 'your-random-secret-at-least-32-chars',
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'changeme123',
  aiBaseUrl: process.env.AI_BASE_URL || 'https://api.openai.com/v1',
  aiApiKey: process.env.AI_API_KEY || 'sk-your-key',
  aiModel: process.env.AI_MODEL || 'gpt-4o-mini',
  dbPath: process.env.DB_PATH || './data/bill.db',
  corsOrigins: (process.env.CORS_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  updatesDir: process.env.UPDATES_DIR || path.join(process.cwd(), 'data', 'updates'),
};
