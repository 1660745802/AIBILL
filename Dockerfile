# 多阶段构建

# --- 前端构建 ---
FROM node:20-alpine AS web-builder
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- 后端构建 ---
FROM node:20-alpine AS server-builder
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
RUN npm run build

# --- 运行镜像 ---
FROM node:20-alpine
WORKDIR /app

# 安装生产依赖
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

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
