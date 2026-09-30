/**
 * CSP 守护（2026-09-29）· **为将来上 CSP 铺路，现在不激活**。
 *
 * ## 为什么写了脚本却不改 index.html
 *
 * 对抗性审查把 `index.html` 无 CSP 列为「仍未修的第 4 个洞」。调研后**决定暂不修**，
 * 理由不是懒，是这一步的**风险无法在本环境验证**：
 *
 *   ① 沙箱里没有真浏览器（无 Playwright/Puppeteer，`verify:electron` 明确不拉二进制），
 *      而现有 UI 验收跑在 jsdom 上 —— **jsdom 不执行 CSP**。也就是说，
 *      写错 CSP 的话，41 步验证链会全绿，而真机一开就白屏。这是最坏的失败形态。
 *   ② 本产品的核心是内嵌 `<webview>` 显示真实网页。CSP 的 `frame-src`/`default-src`
 *      与 Electron `<webview>` 的相互作用，我无法在此验证。写错 = 浏览器整列空白。
 *   ③ 渲染层其实已经硬化得很好了（见下），CSP 在这里是**纵深防御**，边际收益低。
 *
 * ## 渲染层已经关掉的真向量（2026-09-29 实测）
 *
 *   · 全仓 `apps/desktop/src` **零** `dangerouslySetInnerHTML`、**零** `.innerHTML`
 *     （MarkdownText.tsx 是手写的极简渲染器，注释里明说零依赖零 innerHTML）
 *   · `main.ts` 的 webPreferences：`contextIsolation: true` / `nodeIntegration: false` /
 *     `sandbox: true` / `webSecurity: true`
 *
 * ⇒ 结论：CSP 是"锦上添花"，不是"堵漏"。为一个无法验证的锦上添花去冒核心功能
 *    白屏的风险，不划算。
 *
 * ## 这个脚本干什么
 *
 * 它是一个**为将来准备的守卫**，现在跑是"无 CSP → 跳过"：
 *
 *   ① 若 `index.html` 里有 CSP meta → 读构建产物 `dist/index.html` + `dist/assets/*`，
 *      **逐个资源**核对 CSP 是否放行。漏一个就红。
 *     （这一条正是"jsdom 抓不到、真机白屏"的那个盲区 —— 静态对账能抓到。）
 *   ② 若 CSP 放行了**远程** `script-src` / `style-src` → 红。那是把洞又挖开了。
 *   ③ 若 CSP 缺 `object-src 'none'` 或 `base-uri` → 红（这两个几乎零误伤风险）。
 *
 * 反证口径：往 CSP 里塞一个 `https:` 到 script-src → ② 红；
 *           把 script-src 删到不放行 `./assets/*.js` → ① 红。
 *
 * 用法：npx tsx scripts/verify/csp-conformance.mts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const { execFileSync } = req('node:child_process') as typeof import('node:child_process');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');

let pass = 0;
const ok = (name: string): void => {
  pass += 1;
  console.log(`  PASS ${name}`);
};

/** 从 HTML 里取出第一个 <meta http-equiv="Content-Security-Policy"> 的 content */
function readCsp(html: string): string | null {
  const m = /<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/i.exec(html);
  if (!m) return null;
  // ★ 必须先试双引号再试单引号，且**不能**用 `[^"']*`：
  //   CSP 的值里全是单引号关键字（'self' 'unsafe-inline' 'none'），
  //   `[^"']*` 会在第一个单引号处截断，拿到 `default-src ` 就没了。
  //   （2026-09-29 第一版就踩了这个坑：正确的 CSP 被判成"拦掉了 script"。）
  const c = /content="([^"]*)"/i.exec(m[0]) ?? /content='([^']*)'/i.exec(m[0]);
  return c ? c[1] : null;
}

/** 极简 CSP directive 解析：`script-src a b; default-src c` → Map */
function parseDirectives(csp: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of csp.split(';').map((s) => s.trim()).filter(Boolean)) {
    const bits = part.split(/\s+/).filter(Boolean);
    if (bits.length === 0) continue;
    out.set(bits[0].toLowerCase(), bits.slice(1));
  }
  return out;
}

/** 判断一个 URL 是否被某个 directive 的 source list 放行（够用的近似实现） */
function allows(url: string, sources: string[], pageIsFile: boolean): boolean {
  if (sources.includes("'unsafe-inline'") && url.startsWith('inline:')) return true;
  if (sources.includes("'none'")) return false;
  // scheme-source
  for (const s of sources) {
    if (s.endsWith(':') && url.startsWith(s)) return true;
    if (s === 'data:' && url.startsWith('data:')) return true;
    if (s === 'blob:' && url.startsWith('blob:')) return true;
  }
  // host-source，可能是带通配的
  for (const s of sources) {
    if (s.includes('://')) {
      // 形式如 http://127.0.0.1:* / https:／／*
      const [scheme, rest] = s.split('://');
      if (!url.startsWith(scheme + '://')) continue;
      if (rest === '*') return true;
      const hostPart = rest.split(':')[0];
      const portWild = rest.includes(':*');
      const urlHostPort = url.slice(scheme.length + 3);
      const urlHost = urlHostPort.split(':')[0].split('/')[0];
      if (portWild && urlHost === hostPart) return true;
      if (urlHostPort.startsWith(rest)) return true;
    }
  }
  if (sources.includes("'self'")) {
    // file:// 页面 + 相对路径资源：'self' 对 file: origin 不可靠，所以另外认 file:
    if (url.startsWith('file:') && pageIsFile) return true;
    if (url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1')) return true;
  }
  return false;
}

function main(): void {
  const htmlPath = path.join(DESKTOP, 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const csp = readCsp(html);

  if (!csp) {
    console.log('  （index.html 没有 CSP meta —— 当前状态：未激活，跳过对账）');
    console.log('  （要激活：把 docs/archive/2026-09/docs-root/对抗性审查报告-20260929.md §七 的策略粘进去，本脚本立刻开始把关）');
    console.log(`\n=== 结论：0 PASS / 0 FAIL（无 CSP，跳过）===`);
    return;
  }

  const dirs = parseDirectives(csp);
  console.log(`  CSP：${csp.slice(0, 160)}${csp.length > 160 ? '…' : ''}`);

  // ---- ① 构建产物里的每个资源都必须被放行 ----
  const distHtmlPath = path.join(DESKTOP, 'dist', 'index.html');
  if (!fs.existsSync(distHtmlPath)) {
    console.log('  （没有 dist/index.html：先跑 npm run build:renderer -w @ai-workbench/desktop，跳过）');
    console.log(`\n=== 结论：0 PASS / 0 FAIL（无构建产物，跳过）===`);
    return;
  }
  const distHtml = fs.readFileSync(distHtmlPath, 'utf8');

  // 从构建后的 HTML 里抽出每个资源 URL（script src / link href）
  const assets: Array<{ kind: string; url: string }> = [];
  for (const m of distHtml.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
    assets.push({ kind: 'script', url: m[1] });
  }
  for (const m of distHtml.matchAll(/<link[^>]+href=["']([^"']+)["']/gi)) {
    assets.push({ kind: 'style', url: m[1] });
  }
  // 内联脚本（构建产物里可能保留）
  const inlineScripts = (distHtml.match(/<script(?![^>]+src=)[^>]*>/gi) ?? []).length;
  if (inlineScripts > 0) assets.push({ kind: 'script', url: 'inline:' });

  // CSS 里引用的字体等
  const cssDir = path.join(DESKTOP, 'dist', 'assets');
  if (fs.existsSync(cssDir)) {
    for (const f of fs.readdirSync(cssDir)) {
      if (!f.endsWith('.css')) continue;
      const css = fs.readFileSync(path.join(cssDir, f), 'utf8');
      for (const m of css.matchAll(/url\((["']?)([^)"']+)\1\)/gi)) {
        assets.push({ kind: 'font/img', url: m[2] });
      }
    }
  }

  assert.ok(assets.length > 0, '构建产物里一个资源都没解析到 —— 解析器坏了，这是假绿');
  for (const a of assets) {
    const directive = a.kind === 'script' ? 'script-src' : a.kind === 'style' ? 'style-src' : 'font-src';
    const sources = dirs.get(directive) ?? dirs.get('default-src') ?? [];
    const resolved = a.url.startsWith('inline:') ? a.url : a.url.startsWith('/') ? `file:${a.url}` : `file:${a.url.replace(/^\.\//, '/')}`;
    assert.ok(
      allows(resolved, sources, true),
      `CSP 拦掉了构建产物里的 ${a.kind}：${a.url}（directive=${directive} sources=[${sources.join(' ')}]）`,
    );
  }
  ok(`构建产物全部 ${assets.length} 个资源都被 CSP 放行（不会白屏）`);

  // ---- ② 不许放行远程 script / style ----
  for (const d of ['script-src', 'style-src']) {
    const sources = dirs.get(d) ?? dirs.get('default-src') ?? [];
    const remote = sources.filter((s) => /^https?:$/i.test(s) || /:\/\/./.test(s));
    assert.deepEqual(remote, [], `${d} 放行了远程来源（${remote.join(' ')}）—— 把洞又挖开了`);
  }
  ok('CSP 没有放行任何远程 script-src / style-src');

  // ---- ③ 两个几乎零误伤风险的硬要求 ----
  const objSrc = dirs.get('object-src') ?? dirs.get('default-src') ?? [];
  assert.ok(objSrc.includes("'none'"), `object-src 必须是 'none'，实际 [${objSrc.join(' ')}]`);
  ok("object-src 'none'（禁 plugin 内容）");
  assert.ok(dirs.has('base-uri'), '必须有 base-uri（防 <base> 注入把相对资源指到别处）');
  ok('base-uri 已设置（防 <base> 注入）');

  console.log(`\n=== 结论：${pass} PASS / 0 FAIL ===`);
}

main();
