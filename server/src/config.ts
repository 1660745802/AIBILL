import dotenv from 'dotenv';

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
}

export const config: AppConfig = {
  port: parseInt(process.env.PORT || '3000', 10),
  jwtSecret: process.env.JWT_SECRET || 'your-random-secret-at-least-32-chars',
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'changeme123',
  aiBaseUrl: process.env.AI_BASE_URL || 'https://api.openai.com/v1',
  aiApiKey: process.env.AI_API_KEY || 'sk-your-key',
  aiModel: process.env.AI_MODEL || 'gpt-4o-mini',
  dbPath: process.env.DB_PATH || './data/bill.db',
};
