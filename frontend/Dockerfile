# 构建 Vite 前端
FROM node:20-alpine AS build

# 构建时可通过 --build-arg VITE_BASE=/rag-harness/ 指定子路径前缀；
# 默认 / 兼容端口隔离方案（外层 nginx 直接转发到 8080）。
ARG VITE_BASE=/
ENV VITE_BASE=${VITE_BASE}

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json
COPY package*.json ./

# 使用锁文件安装完整构建依赖（registry 用国内镜像，避免构建容器无法直连官方源）
RUN npm ci --registry=https://registry.npmmirror.com

# 复制应用代码
COPY . .

# 构建应用
RUN npm run build

# 使用 nginx 提供静态首页
FROM nginx:alpine

# 复制构建后的文件到 nginx 目录
COPY --from=build /app/dist /usr/share/nginx/html

# 复制 nginx 配置文件（可选）
COPY nginx.conf /etc/nginx/nginx.conf

# 暴露 nginx 监听端口
EXPOSE 80

# 启动 nginx
CMD ["nginx", "-g", "daemon off;"]
