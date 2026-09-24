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

