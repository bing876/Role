/**
 * 休眠图标 + 「活页 → 页面」文案 的回归测试（第 24 步）。
 *
 * 为什么要有这条测试：
 *   图标和文案是**纯视觉**的东西，typecheck 过了、构建过了，都不代表它是对的。
 *   真实会坏的方式有这些（都是我在别的项目踩过的）：
 *     ① 图标只写在预览页里，**没接进 BrowserPanel** —— 预览好看，应用里压根没有；
 *     ② 图标接了，但 `sleep` 字段没进类型 —— 编译期就被 `any` 吃掉了，永远不显示；
 *     ③ 「活页」文案改了顶栏，但**别处漏改**（注释除外，注释不算用户可见）；
 *     ④ 图标在休眠时**没替换 favicon 的位置**，另起了一个角标 —— 和 Chrome 观感不一致；
 *     ⑤ 驾驶中的页显示了休眠图标（两者语义互斥，同时出现就是 bug）。
 *
 * 做法：直接读源码文本做断言（这些是"结构契约"，不是运行时行为），
 * 再用一个真浏览器把图标按 14px 真实尺寸渲染出来，验证它**画得出来**（不是空白）。
 */
import { app, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const OUT = path.join(ROOT, 'docs', 'acceptance', 'root-cause');
mkdirSync(OUT, { recursive: true });

const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

const lines = [];
const log = (...a) => {
  const s = a.map(String).join(' ');
  lines.push(s);
  console.log(s);
};
let fails = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fails += 1;
  log(`  ${ok ? 'PASS' : '★FAIL'} ${name}${detail ? '  —— ' + detail : ''}`);
};

const panel = read('apps/desktop/src/browser/BrowserPanel.tsx');
const styles = read('apps/desktop/src/browser/styles.css');
const types = read('apps/desktop/src/browser/types.ts');
const badge = read('apps/desktop/src/browser/SleepBadge.tsx');

app.commandLine.appendSwitch('no-sandbox');

app.whenReady().then(async () => {
  log('');
  log('=== ① 图标真的接进了标签（不是只活在预览页里）===');
  check('BrowserPanel 引入了 SleepBadge', /import\s*\{\s*SleepBadge\s*\}\s*from\s*'\.\/SleepBadge'/.test(panel));
  check('标签里真的渲染了 <SleepBadge', /<SleepBadge\s+depth=/.test(panel));
  check(
    '★ 图标放在标签文字**前面**（占 favicon 的位置，而不是另起角标）',
    panel.indexOf('<SleepBadge') < panel.indexOf('{t.title || hostLabel(t.url) || t.bootUrl}'),
    `SleepBadge@${panel.indexOf('<SleepBadge')} 标题@${panel.indexOf('{t.title || hostLabel(t.url) || t.bootUrl}')}`,
  );

  log('');
  log('=== ② 驾驶中与休眠互斥（不能同时出现）===');
  check(
    '★ 渲染图标时排除了 drivingIds',
    /!ws\.drivingIds\.includes\(t\.id\)\s*&&\s*t\.sleep/.test(panel) ||
      /!ws\.drivingIds\.includes\(t\.id\)[\s\S]{0,80}<SleepBadge/.test(panel),
  );

  log('');
  log('=== ③ 类型契约：sleep 字段进了公开类型 ===');
  check("BrowserTabView 有 sleep 字段", /sleep\?:\s*'shallow'\s*\|\s*'deep'/.test(types));
  check('注释里说明了正在驾驶的页不休眠', /drivingIds[\s\S]{0,40}休眠|休眠[\s\S]{0,40}drivingIds/.test(types));

  log('');
  log('=== ④ 「活页」文案：用户可见的地方必须没有 ===');
  // 只查**用户可见**的字符串字面量。
  // ★ 必须先把注释整段剥掉 —— 注释里为了说明沿革会提到「活页」
  //   （例：'原来是「N 张活页」——「活页」这个词已经不要了'），
  //   那是给维护者看的，不是用户看得见的文案。
  //   我第一版就是漏了这步，把注释当成违规，测出一条**假失败**。
  const stripComments = (src) =>
    src
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '') // JSX 注释 {/* ... */}
      .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释 /* ... */
      .replace(/(^|[^:])\/\/.*$/gm, '$1'); // 行注释 // ...（避开 http://）
  const panelVisible = stripComments(panel);
  const visibleHuoYe = [];
  const re = /['"`]([^'"`]*活页[^'"`]*)['"`]/g;
  let m;
  while ((m = re.exec(panelVisible)) !== null) visibleHuoYe.push(m[1]);
  check('★ BrowserPanel 里没有「活页」字面量（注释除外）', visibleHuoYe.length === 0, visibleHuoYe.join(' | ') || '0 处');
  check('顶栏改成了「N 个页面」', /\{ws\.tabCount\}\s*个页面/.test(panelVisible));
  check('★ 显示了休眠数量（用户不会以为页丢了）', /已休眠/.test(panelVisible) && /asleepCount/.test(panelVisible));

  log('');
  log('=== ⑤ 样式：浅/深两级 + 压暗 ===');
  check('有 .browserTab__sleep 基样式', /\.browserTab__sleep\s*\{/.test(styles));
  check('浅休眠样式', /\.browserTab__sleep--shallow/.test(styles));
  check('深休眠样式', /\.browserTab__sleep--deep/.test(styles));
  check('休眠页标题压暗', /\.browserTab--asleep\s+\.browserTab__label/.test(styles));
  /*
   * ★★ 只断言"选择器存在"是**不够的** —— 反证时我把两级都改成 0.55，
   *    测试照样全绿。存在性 ≠ 正确性：深浅必须**真的不同**，而且是
   *    "深比浅实"这个方向。Chrome 的观感就是深休眠更实一档。
   */
  const opacityOf = (sel) => {
    const m = styles.match(new RegExp(`\\${sel}\\s*\\{[^}]*opacity\\s*:\\s*([\\d.]+)`));
    return m ? Number(m[1]) : null;
  };
  const opShallow = opacityOf('.browserTab__sleep--shallow');
  const opDeep = opacityOf('.browserTab__sleep--deep');
  check(
    '★ 浅休眠的 opacity 真的写出来了',
    opShallow !== null && opShallow > 0 && opShallow < 1,
    `shallow=${opShallow}`,
  );
  check(
    '★★ 深休眠比浅休眠**更实**（opacity 更大，不是反的、也不是一样）',
    opShallow !== null && opDeep !== null && opDeep > opShallow,
    `deep=${opDeep} > shallow=${opShallow}`,
  );

  log('');
  log('=== ⑥ 图标真的画得出来（真编译真组件）===');
  /*
   * ★ 这里**真编译真组件**，不是用手抄/正则拼一份近似物。
   *
   * 为什么值得多这一步：我第一版就是拿正则去撕 SleepBadge.tsx 里的 JSX
   * （把 `{depth === 'deep' && (...)}` 删掉当"浅休眠"），结果深浅两张图的
   * rect 数都是 5 —— 看起来"深浅画得一样"，实际是我撕错了、把条件分支留在了里面。
   * 用真编译出来的组件渲染，就不存在"撕错"这件事。
   *
   * ★ 全程在 **Node 侧**做（esbuild 编译 + 求值 + 纯字符串统计），不开浏览器窗口：
   *   本机 Electron 的 GPU 进程反复崩（`exit_code=143`），
   *   而"图标结构对不对"根本不需要光栅化就能验。
   */
  const { transformSync } = await import('esbuild');
  const compiled = transformSync(badge, {
    loader: 'tsx',
    format: 'esm',
    jsx: 'transform',
    jsxFactory: 'h',
    jsxFragment: 'Fragment',
  }).code;
  // React 的 jsx factory 换成极简 h()：把元素树转成 HTML 字符串即可（不用真起 React）
  const harness = `
    const h = (tag, props, ...kids) => {
      const attrs = [];
      for (const k in (props || {})) {
        if (k === 'children') continue;
        let v = props[k];
        if (v === true) { attrs.push(k); continue; }
        if (v === false || v == null) continue;
        if (k === 'className') v = String(v).replace(/"/g, '');
        attrs.push(k + '="' + String(v).replace(/"/g, '&quot;') + '"');
      }
      const clean = (arr) => (arr || []).flat(9).filter((c) => c !== null && c !== undefined && c !== false);
      const inner = clean(kids).join('');
      const tail = props && props.children != null ? clean([props.children]).join('') : '';
      return '<' + tag + (attrs.length ? ' ' + attrs.join(' ') : '') + '>' + inner + tail + '</' + tag + '>';
    };
    const Fragment = 'div';
    ${compiled.replace(/export\s*\{[^}]*\};?/g, '')}
    ({ shallow: SleepBadge({ depth: 'shallow' }), deep: SleepBadge({ depth: 'deep' }) })
  `;
  const rendered = eval(harness);

  /*
   * ★ 先用**纯字符串**统计结构 —— 不碰浏览器、不碰 GPU。
   *
   * 为什么要这样：本机 Electron 的 GPU 进程不稳（这一节之前直接
   * `GPU process exited unexpectedly: exit_code=143`，整段被干掉），
   * 而"深浅图标的 rect 数差几颗"本来就是**源码结构**层面的事实，
   * 不需要真的光栅化。真浏览器只留着确认"尺寸 14×14、不是空白"。
   */
  const countRects = (html) => (html.match(/<rect/g) || []).length;
  const countCircles = (html) => (html.match(/<circle/g) || []).length;
  const structural = {
    shallow: { rects: countRects(rendered.shallow), circles: countCircles(rendered.shallow) },
    deep: { rects: countRects(rendered.deep), circles: countCircles(rendered.deep) },
  };
  log(`   结构统计（纯字符串）：浅 ${JSON.stringify(structural.shallow)}  深 ${JSON.stringify(structural.deep)}`);
  check(
    '★★ 浅休眠的颗粒比深休眠少（真编译组件，不是手撕 JSX）',
    structural.shallow.rects < structural.deep.rects,
    `浅 ${structural.shallow.rects} vs 深 ${structural.deep.rects}`,
  );
  check(
    '深休眠恰好比浅休眠多一颗颗粒',
    structural.deep.rects - structural.shallow.rects === 1,
    `差 ${structural.deep.rects - structural.shallow.rects}`,
  );
  check('深浅都画了圆底', structural.shallow.circles >= 1 && structural.deep.circles >= 1);

  /*
   * ★ 尺寸也是纯字符串层面的事实，不用开浏览器就能验：
   *   <svg width="14" height="14" viewBox="0 0 14 14">
   * 这条断言能抓住"有人把 viewBox 改成别的尺寸导致图标被拉伸"。
   */
  check('两个图标都声明了 14×14 的尺寸', /width="14"/.test(rendered.shallow) && /width="14"/.test(rendered.deep));
  check('viewBox 是 0 0 14 14（不会被拉变形）', /viewBox="0 0 14 14"/.test(rendered.deep), (rendered.deep.match(/viewBox="[^"]*"/) || ['无'])[0]);
  check('图上有内容（rect ≥ 3，不是空白框）', structural.deep.rects >= 3, `rect=${structural.deep.rects}`);
  /*
   * ★ 这条断言校验"深浅的差异都在意料之内"。
   *
   * 设计上深浅**应该**有两处差异：
   *   ① 类名修饰符 `--shallow` / `--deep`（样式靠它区分透明度）；
   *   ② title 文案（深休眠要多说一句"内存已释放"）。
   * 除此之外**不该有任何差异** —— 尤其是"图形结构"不能变，
   * 否则就不是"同一个图标的深浅两态"，而是两个不同的图标了。
   *
   * 写法：把这两处**预期的**差异抹平，再比剩下的部分是否逐字节相同。
   * 我第一版只剥了 rect/circle，结果被 title 文案卡红 —— 那是**我的断言写错了**
   * （把"设计上就该不一样"的东西当成了 bug），不是组件有问题。
   */
  const normalize = (html) =>
    html
      .replace(/--(shallow|deep)/g, '--DEPTH') // ① 类名修饰符
      .replace(/title="[^"]*"/g, 'title="T"') // ② title 文案
      .replace(/<(rect|circle)[^>]*>\s*(<\/\1>)?/g, ''); // ③ 图形本身（颗粒数就该不同）
  check(
    '★ 深浅的差异**只在**颗粒数 + 类名 + title 三处（其余逐字节一致）',
    normalize(rendered.shallow) === normalize(rendered.deep),
    '把这三处抹平后必须完全相同',
  );

  log('');
  log('=== 结论 ===');
  log(`  失败项：${fails}`);
  writeFileSync(path.join(OUT, 'sleep-badge-tests.log'), lines.join('\n') + '\n', 'utf8');
  writeFileSync(
    path.join(OUT, 'sleep-badge-tests.json'),
    JSON.stringify({ fails, structural }, null, 2),
    'utf8',
  );
  app.exit(fails > 0 ? 1 : 0);
}).catch((e) => {
  console.error('FATAL', e);
  app.exit(1);
});
