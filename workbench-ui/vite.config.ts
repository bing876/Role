import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig(({ mode }) => {
  // mode === 'single'  →  产出自包含 index.html（CSS/JS/图片/字体全部内联，可双击打开、可离线、可直发）
  // 其它模式           →  常规多文件产物（dist/index.html + dist/assets/*），供正式部署
  const isSingle = mode === 'single';

  return {
    plugins: [react(), ...(isSingle ? [viteSingleFile()] : [])],

    server: { port: 5273, strictPort: false },

    build: {
      outDir: isSingle ? 'dist-single' : 'dist',
      sourcemap: false,
      cssCodeSplit: false,
      // 单文件模式：一张图都不留成外部文件 —— 头像池 25 张 + CSS 图 14 张 + woff2 字体全部内联
      assetsInlineLimit: isSingle ? 100_000_000 : 4096,
      chunkSizeWarningLimit: 4000,

      // ★ 单文件必须输出「经典脚本」而不是 <script type="module">：
      //   file:// 协议下 module 脚本的 origin 是 null，会被 CORS 拦截而完全不执行，
      //   表现为「双击打开 = 白屏，什么都没加载」。改成 iife 后 file:// 能正常跑。
      ...(isSingle
        ? {
            target: 'es2019',
            modulePreload: false,
            rollupOptions: {
              output: { format: 'iife' as const, inlineDynamicImports: true },
            },
          }
        : {}),
    },
  };
});
