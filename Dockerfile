# 多阶段构建

# --- 前端构建 ---
FROM node:20-alpine AS web-builder
WORKDIR /app/web
# 使用淘宝镜像加速
RUN npm config set registry https://registry.npmmirror.com
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- 后端构建（含 native addon 编译） ---
FROM node:20-alpine AS server-builder
WORKDIR /app/server

# Alpine 换源加速 + 安装编译依赖
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories && \
    apk add --no-cache python3 make g++

# 使用淘宝镜像，跳过 prebuild 下载（直接本地编译更可控）
RUN npm config set registry https://registry.npmmirror.com

COPY server/package.json server/package-lock.json ./
RUN npm ci --build-from-source
COPY server/ ./
RUN npm run build

# 单独安装生产依赖
RUN rm -rf node_modules && npm ci --omit=dev --build-from-source

# --- 运行镜像 ---
FROM node:20-alpine
WORKDIR /app

# 直接复制已编译好的 node_modules
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
