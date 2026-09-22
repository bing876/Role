/**
 * 多智能体编排 · **内部频道面板**的渲染验收。
 *
 * ★ 为什么要这一层：`vite build` 通过只证明「能编译能打包」，
 *   证明不了这个面板**真的渲染出来、真的把服务端的数据画到屏幕上**。
 *   需求 2 的后半句是「用户可以查看这个交流过程」—— 界面上读不到就等于没做完，
 *   所以这里起一个**真实服务端**（pglite + Fastify，真监听端口），
 *   用 jsdom 渲染**真实的 `ChannelsPanel`**（不是抄一份），再断言 DOM。
 *
 * 逐条对着「不能出的事」：
 *   ① 频道列表画出对方名字 + 最后一句预览；
 *   ② 选中后画出**解密后的正文**（派活 / 交活两类都在）；
 *   ③ 委派记录画出状态；**超时那条要显眼地写出原因**（「不假装完成」在界面上的落点）；
 *   ④ 面板里**没有任何输入框** —— 只读不是一句注释，是 DOM 里真的查不到 input/textarea；
 *   ⑤ 后端挂了要**如实报错**，不能白屏。
 *
 * 用法：npx tsx scripts/verify/orc-channels-ui.mts
 * （内部用 esbuild 把 .tsx 测试打成一个 CJS 包再跑 —— CSS 导入置空，其余照真实打包走）
 */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

async function main(): Promise<void> {
  /**
   * ★ 产物必须落在**仓库内**（这里用 `node_modules/.cache/`，本来就被 git 忽略）。
   *   打到 `/tmp` 的话 Node 从那里向上找 `node_modules` 会一路找到根目录也找不到 `react`
   *   —— 报 `ERR_MODULE_NOT_FOUND`。放在仓库里，解析就能正常走到 `<repo>/node_modules`。
   */
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const outDir = join(repoRoot, 'node_modules', '.cache', 'orc-ui');
  mkdirSync(outDir, { recursive: true });
  const outfile = join(outDir, 'ui-test.mjs');

  await build({
    entryPoints: [new URL('./orc-channels-ui.run.tsx', import.meta.url).pathname],
    bundle: true,
    platform: 'node',
    // ★ 必须 esm：测试里用了顶层 await（jsdom 全局要在 import react-dom **之前**铺好，
    //   所以那些 import 只能动态写在顶层）。CJS 不支持顶层 await。
    format: 'esm',
    target: 'node20',
    jsx: 'automatic',
    outfile,
    // CSS 是纯副作用导入：置空即可（真实打包由 vite 处理，已在 build:renderer 里验过）
    loader: { '.css': 'empty' },
    /**
     * ★ 所有**包**依赖一律 external，只打包仓库自己的源码（相对路径那些）。
     *
     *   为什么不能把依赖打进来：`jsonwebtoken → jws → safe-buffer` 这条链是 CJS，
     *   卷进 ESM 产物后它的 `require('buffer')` 就变成 esbuild 那句
     *   `Dynamic require of "buffer" is not supported` 直接抛。
     *   external 之后由 Node 原生解析，CJS/ESM 各自按自己的规矩来，就不会有这个问题。
     *   （顺带也避免了「两份 React」—— 那会让 hooks 直接报错。）
     */
    packages: 'external',
    logLevel: 'warning',
  });

  await import(pathToFileURL(outfile).href);
}

void main();
