# rag-kb 后端镜像：适配层 + dsh 运行时（构建上下文 = 仓库根 rag-harness-sdk/）
FROM node:24-slim

# SDK 会话日志使用多帧 Zstandard；历史消息读取需要 zstd CLI。
RUN apt-get update && apt-get install -y --no-install-recommends zstd python3 python3-venv && apt-get clean

# 仅安装冻结规则编译器的运行依赖，不包含绘图/评测模型等研究依赖。
COPY backend/dsh/dsh-wireless/compiler-requirements.txt /tmp/wireless-requirements.txt
RUN python3 -m venv /opt/wireless-python && /opt/wireless-python/bin/pip install --no-cache-dir -r /tmp/wireless-requirements.txt
ENV WIRELESS_PYTHON=/opt/wireless-python/bin/python

WORKDIR /app/backend

# 先装依赖（锁文件含 overrides：@deepseek-ai/dsh 家族钉回 0.1.6-alpha.1，避免 alpha.2 漂移）
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit

# 适配层与 dsh 运行时（dsh/home 的 settings/profiles 与插件；.env 不进镜像，由 compose 注入）
COPY backend/index.js backend/integrations.js ./
COPY backend/harness /app/backend/harness
COPY backend/dsh /app/backend/dsh
COPY skills /app/skills

ENV NODE_ENV=production
EXPOSE 3088

CMD ["node", "index.js"]
