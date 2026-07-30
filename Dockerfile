# 多阶段构建 - 使用 Debian slim（better-sqlite3 prebuilt 直接可用）

# --- 前端构建 ---
FROM node:20-alpine AS web-builder
WORKDIR /app/web
RUN npm config set registry https://registry.npmmirror.com
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- 后端构建 ---
FROM node:20-slim AS server-builder
WORKDIR /app/server
RUN npm config set registry https://registry.npmmirror.com
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
RUN npx tsc
# 单独安装生产依赖
RUN rm -rf node_modules && npm ci --omit=dev

# --- 运行镜像 ---
FROM node:20-slim
WORKDIR /app

# 直接复制已下载好的 node_modules（含 prebuilt native addon）
COPY --from=server-builder /app/server/node_modules ./node_modules
COPY --from=server-builder /app/server/package.json ./

# 复制构建产物
COPY --from=server-builder /app/server/dist ./dist
COPY --from=web-builder /app/web/dist ./public

# 数据目录
RUN mkdir -p /app/data
VOLUME ["/app/data"]

# 环境变量
ENV PORT=3000
ENV DB_PATH=/app/data/bill.db
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "dist/app.js"]
