import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // 适配层（SSE 聊天 / 审批 / 反馈 / kb 透传）
      "/api": {
        target: process.env.VITE_RAG_SERVER_TARGET || "http://127.0.0.1:3088",
        changeOrigin: false,
        ws: true,
      },
    },
  },
  build: {
    sourcemap: true,
    // A data: worklet would be blocked by the production script-src 'self' policy.
    assetsInlineLimit: filePath => filePath.endsWith('pcm-capture-worklet.js') ? false : undefined,
  },
});
