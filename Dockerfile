# 多阶段构建 - 使用 Debian slim（better-sqlite3 prebuilt 直接可用）

# --- 前端构建 ---
FROM node:20-alpine AS web-builder
WORKDIR /app/web
ARG NPM_PROXY=""
RUN npm config set registry https://registry.npmmirror.com && \
    if [ -n "$NPM_PROXY" ]; then npm config set proxy $NPM_PROXY && npm config set https-proxy $NPM_PROXY; fi
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- 后端构建 ---
FROM node:20-slim AS server-builder
WORKDIR /app/server
ARG NPM_PROXY=""
RUN npm config set registry https://registry.npmmirror.com && \
    if [ -n "$NPM_PROXY" ]; then npm config set proxy $NPM_PROXY && npm config set https-proxy $NPM_PROXY; fi
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
RUN npx tsc
# 单独安装生产依赖（生产依赖也需要代理下载）
RUN rm -rf node_modules && npm ci --omit=dev

# --- 运行镜像 ---
FROM node:20-slim
WORKDIR /app

# 直接复制已下载好的 node_modules（含 prebuilt native addon）
COPY --from=server-builder /app/server/node_modules ./node_modules
COPY --from=server-builder /app/server/package.json ./

# 复制构建产物
COPY --from=server-builder /app/server/dist ./dist
# 通知规则内容真源（进 git，运行时只读；改文件 + 重启即发布新版本）
COPY --from=server-builder /app/server/config ./config
COPY --from=web-builder /app/web/dist ./public

# 数据目录
RUN mkdir -p /app/data
VOLUME ["/app/data"]

# 环境变量
ENV PORT=3000
ENV DB_PATH=/app/data/bill.db
ENV RULES_PATH=/app/config/rules.json
ENV NODE_ENV=production

EXPOSE 3000

# 健康检查：探自身 /health（node 20 自带 fetch；基础镜像里没有 curl/wget）。
# 容器重启策略是 unless-stopped，没有 HEALTHCHECK 时重启只能靠进程退出。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/app.js"]
