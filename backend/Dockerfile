# rag-kb 后端镜像：适配层 + dsh 运行时 + 沙箱执行环境（构建上下文 = 仓库根 rag-harness-sdk/）
#
# 沙箱环境预装（内网部署运行期不可 pip/apt 安装，全部构建期打入镜像）：
#   - bubblewrap：dsh 沙箱（bash-sandbox 工具）在 Linux 上的执行隔离依赖
#   - python3 + 文档处理库：python-docx(Word) / python-pptx(PPT) / openpyxl+pandas(Excel)
#     / markdown(MD) / beautifulsoup4+lxml(HTML) / Pillow+matplotlib(图片与图表)
#   - libreoffice（writer/calc/impress 无头）：文档格式互转（docx/pptx/xlsx/pdf）
#   - fonts-noto-cjk：中文字体（生成中文文档/幻灯片必备，缺失会渲染为豆腐块）
#   - pandoc：Markdown 与 docx 互转
FROM node:24-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

WORKDIR /app/backend

# 先装依赖（锁文件含 overrides：@deepseek-ai/dsh 家族钉回 0.1.6-alpha.1，避免 alpha.2 漂移；
# registry 用国内镜像，避免构建容器无法直连官方源）
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit --registry=https://registry.npmmirror.com

# 沙箱与文档处理系统依赖（--no-install-recommends 控制体积；中文字体必须保留）
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl procps zip unzip \
      bubblewrap \
      python3 python3-pip \
      pandoc \
      fonts-noto-cjk \
      libreoffice-writer libreoffice-calc libreoffice-impress \
    && rm -rf /var/lib/apt/lists/*

# Python 文档处理库（Debian 13 为 PEP 668 受管环境，系统级安装需 --break-system-packages；
# pip 用清华镜像，避免构建容器无法直连官方源）
RUN pip3 install --break-system-packages --no-cache-dir \
      -i https://pypi.tuna.tsinghua.edu.cn/simple \
      python-docx python-pptx openpyxl pandas matplotlib \
      beautifulsoup4 lxml markdown Pillow

# 适配层与 dsh 运行时（dsh/home 的 settings/profiles 与插件；.env 不进镜像，由 compose 注入）
COPY backend/index.js ./
COPY backend/portal-session.mjs ./
COPY backend/voice-proxy.mjs ./
COPY backend/answer-actions.mjs ./
COPY backend/dsh /app/backend/dsh

ENV NODE_ENV=production
EXPOSE 3088

# HEALTHCHECK 走 /api/health（免认证端点，不依赖模型与知识库）
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
  CMD curl -fsS --noproxy '*' http://127.0.0.1:3088/api/health || exit 1

CMD ["node", "index.js"]
