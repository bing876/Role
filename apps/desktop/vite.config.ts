import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],

  // 打包产物由 Electron 用 file:// 加载，必须走相对路径，否则资源 404
  base: './',

  server: {
    host: '0.0.0.0',
    port: 5173,
    // 端口被占用时直接报错，避免 Electron 等错地址
    strictPort: true,
    allowedHosts: true,
    /**
     * 批次 J：渲染进程要 import `packages/shared/src/mention.ts` 的**源码**
     * （@点名 解析两端同一份实现；按包名引值会去解 shared/dist，平白多一个「先 build 再起 dev」的前置）。
     * 那个文件在 vite root（apps/desktop）之外，所以把允许范围显式放到仓库根 ——
     * Vite 一般能自己找到 workspace 根，但「一般能」不该是 dev 起不起得来的前提。
     */
    fs: { allow: ['../..'] },
    proxy: {
      '/health': 'http://127.0.0.1:8787',
      '/auth': 'http://127.0.0.1:8787',
      '/chat': 'http://127.0.0.1:8787',
      '/agent': 'http://127.0.0.1:8787',
      '/projects': 'http://127.0.0.1:8787',
      '/agents': 'http://127.0.0.1:8787',
      '/memory': 'http://127.0.0.1:8787',
      '/knowledge': 'http://127.0.0.1:8787',
    },
  },

  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});

