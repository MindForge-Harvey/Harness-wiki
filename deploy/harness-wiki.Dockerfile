FROM node:24-slim AS frontend
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY frontend/ ./
RUN npm run build -- --base=/harness-wiki/

FROM node:24-slim
RUN sed -i 's|http://deb.debian.org|http://mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources && \
    apt-get -o Acquire::http::Timeout=30 -o Acquire::Retries=3 update && \
    apt-get -o Acquire::http::Timeout=30 -o Acquire::Retries=3 install -y --no-install-recommends nginx ca-certificates zstd && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit
COPY backend/index.js backend/portal-session.mjs backend/answer-actions.mjs backend/session-ownership.mjs backend/import-legacy-sessions.mjs backend/chat-attachments.mjs ./
COPY backend/skills-store.mjs ./
COPY backend/starter-skills.mjs ./
COPY backend/starter-skills ./starter-skills
COPY backend/dsh ./dsh
RUN mkdir -p dsh/home/profiles/rag-kb/node_modules && \
    ln -s /app/backend/dsh/dsh-knowledge dsh/home/profiles/rag-kb/node_modules/dsh-knowledge && \
    ln -s /app/backend/dsh/plugin-approval-bridge dsh/home/profiles/rag-kb/node_modules/kb-approval-bridge
COPY --from=frontend /build/frontend/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/nginx.conf
COPY deploy/start.mjs /app/deploy/start.mjs
ENV NODE_ENV=production
WORKDIR /app
EXPOSE 80
CMD ["node", "/app/deploy/start.mjs"]
