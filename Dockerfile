# 多阶段构建

# --- 前端构建 ---
FROM node:20-alpine AS web-builder
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- 后端构建（含 native addon 编译） ---
FROM node:20-alpine AS server-builder
WORKDIR /app/server

# better-sqlite3 需要编译环境
RUN apk add --no-cache python3 make g++

COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
RUN npm run build

# 单独安装生产依赖（用于最终镜像，避免携带 devDependencies）
RUN rm -rf node_modules && npm ci --omit=dev

# --- 运行镜像 ---
FROM node:20-alpine
WORKDIR /app

# 直接复制已编译好的 node_modules（包含 native addon）
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
