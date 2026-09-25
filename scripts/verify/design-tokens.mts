/**
 * 批次 M-2 · M1' 设计令牌 —— 验收：三个设计 CSS 落位，且对当前 DOM **零视觉改动**。
 *
 * 「零视觉改动」的可证口径（本沙箱无显示环境，CSS 断言走源码层 —— 与 M0 ⑦ 样式红线同一口径）：
 *   设计 CSS 里**唯一可能打中当前 DOM** 的规则只有三类，本脚本把它们逐条钉死：
 *   ① 99-theme 的四条列规则（.rail/.sidebar/.main-area/.frame-internal-stroke，都带 !important）
 *      → 必须全部 scoped 在 `.frame ` 之下；当前 DOM 没有 .frame 元素 → 打不中；
 *   ② 02-base 的选择器 ∈ {body.viewport（打不中）} ∪ M7' 桌面原语白名单（有意打中,值同旧规则）；
 *   ③ 01-tokens 只有 :root / * / 元素族 / @font-face，无类选择器 → 且 `*{box-sizing:border-box}`
 *      与 99-theme M7' 基座块同值 → 盒模型单一来源。
 * M9' 收口后另钉：零残留（styles.css 已删,design/index.css 是唯一入口）、原版部分的逐字节保真
 * （M1' 机械适配：99-theme 的 .frame 前缀 + 头部说明;M7' 文件尾文档化扩展块）、
 * 字体文件与原版同 sha256。
 *
 * 用法：npx tsx scripts/verify/design-tokens.mts
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '../..');
const WB = join(REPO, 'workbench-ui', 'src');
const DG = join(REPO, 'apps', 'desktop', 'src', 'design');

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(id: string, fn: () => void): void {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${id}`);
  } catch (err) {
    fail += 1;
    const msg = (err as Error).message ?? String(err);
    failures.push(`${id} — ${msg.split('\n')[0]}`);
    console.log(`  ✗ ${id}\n      ${msg.split('\n').slice(0, 3).join('\n      ')}`);
  }
}
/**
 * ★ 读文件时**必须先归一 CRLF → LF**（2026-09-25 修）。
 *
 * 本仓 `core.autocrlf=true` 且根目录没有 `.gitattributes` ⇒ 工作区里**同一个仓库的两份文件
 * 可能行尾不同**：经 checkout/merge 落盘的是 CRLF，而由工具直接写出的仍是 LF。
 * 于是「拿两边原始字节比对」的判定会**假红**，且只在 Windows 上出现、在 LF 检出上永远绿
 * —— 最坏的一种测试：本机红、CI 绿，让人怀疑代码而不是怀疑测试。
 *
 * 实测：归一前 02-base / 99-theme 两条 FAIL；归一后两条 PASS，代码零改动。
 * 另外 `theme.slice(0, iT).replace(/\n$/, '')` 这类「只剥一个 \n」的写法在 CRLF 下会
 * **留下一个孤立的 `\r`**，所以归一必须在这里做，不能靠各判定自己补。
 */
const read = (p: string): string => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const assert = (cond: unknown, msg: string): asserts cond => {
  if (!cond) throw new Error(msg);
};

console.log('');
console.log("=== M1' · 设计令牌（01-tokens + 02-base + 99-theme）· 零视觉改动验收 ===");

const main = read(join(REPO, 'apps', 'desktop', 'src', 'main.tsx'));
const index = read(join(DG, 'index.css'));
const tokens = read(join(DG, '01-tokens.css'));
const base = read(join(DG, '02-base.css'));
const theme = read(join(DG, '99-theme.css'));

// ---------------------------------------------------------------- 入口与顺序
/**
 * M9' 收口：styles.css 已整体删除 —— 设计 CSS 是唯一入口。
 * 检查升级为**零残留**：main.tsx 不许再 import 它、文件不许再存在
 * （任何一块旧规则想回来，都得先让文件复活 → 这里立刻红）。
 */
check('main.tsx：design/index.css 是唯一 CSS 入口,styles.css 零残留（M9\' 收口）', () => {
  const iDesign = main.indexOf("import './design/index.css'");
  const iStyles = main.indexOf("import './styles.css'");
  assert(iDesign >= 0, 'main.tsx 没有 import design/index.css');
  assert(iStyles < 0, 'main.tsx 还在 import styles.css（M9\' 没删干净?）');
  assert(
    !existsSync(join(REPO, 'apps', 'desktop', 'src', 'styles.css')),
    'styles.css 文件又出现了（M9\' 已删;旧规则想回来先得让文件复活）',
  );
});

check('design/index.css：01-tokens → 02-base → 99-theme 严格按序（与设计基准一致，禁止重排）', () => {
  const seq = ['01-tokens.css', '02-base.css', '99-theme.css'];
  let pos = -1;
  for (const f of seq) {
    const i = index.indexOf(`'./${f}'`, pos + 1);
    assert(i >= 0, `index.css 缺 ${f} 或顺序错了（当前内容：${JSON.stringify(index.slice(0, 200))}）`);
    pos = i;
  }
});

// ---------------------------------------------------------------- 逐字节保真
check('01-tokens.css 与 workbench-ui 原版逐字节一致', () => {
  const orig = read(join(WB, 'styles', '01-tokens.css'));
  assert(tokens === orig, "01-tokens.css 与原版不一致（M1' 不允许任何改动，含字体路径——相对路径两边同构）");
});

/**
 * 02-base 的 M7' 扩展是**有穷枚举**的：文件尾追加一段桌面共享 UI 原语
 * （.btn 系 / .small / .buttons-row，从旧 styles.css 原值迁入）。
 * 验收做法 = 剥掉 M7' 块后必须与原版逐字节一致 —— 原版部分多一个字节都红。
 */
const M7_BASE_MARKER = "/* ============ 批次 M-7'：桌面共享 UI 原语";
check('02-base.css = 原版 + M7\u2019桌面原语块（剥块后逐字节一致）', () => {
  const orig = read(join(WB, 'styles', '02-base.css'));
  const i = base.indexOf(M7_BASE_MARKER);
  assert(i >= 0, '02-base 缺 M7\u2019 原语块标记（.btn/.small/.buttons-row 没随组件走?）');
  // M7' 追加以单个空行开头 —— 只剥那一个 \n，原版尾部字节必须原样
  const head = base.slice(0, i).replace(/\n$/, '');
  assert(head === orig, "02-base 的原版部分与 workbench-ui 不一致（M1' 部分不许动）");
});

/**
 * 99-theme 的机械适配是**有穷枚举**的：头部加一段说明 + 四条列规则加 `.frame ` 前缀。
 * 验收做法 = 机械逆映射回去（剥说明、去前缀）后必须与原版逐字节一致 —— 多改一个字节都红。
 */
const M7_THEME_MARKER = "/* ============ 批次 M-7'：桌面浅色基座";
check('99-theme.css 逆映射（去说明 + 去 4 个 .frame 前缀 + 剥 M7\u2019基座块）后与原版逐字节一致', () => {
  const orig = read(join(WB, 'styles', '99-theme.css'));
  // M7' 基座块（:root 变量 + reset + body）在文件尾 —— 先剥掉，再做 M1' 逆映射
  const iT = theme.indexOf(M7_THEME_MARKER);
  assert(iT >= 0, '99-theme 缺 M7\u2019 桌面基座块（:root 变量/reset/body 没归位?）');
  // M7' 追加以单个空行开头 —— 只剥那一个 \n（原版 99-theme 尾无换行）
  const themeM1 = theme.slice(0, iT).replace(/\n$/, '');
  // 头部注释块各自剥到第一个 */（M1' 只许在注释块内加说明）
  const iMine = themeM1.indexOf('*/');
  const iOrig = orig.indexOf('*/');
  assert(iMine >= 0 && iOrig >= 0, '99-theme 头部注释块找不到 */');
  let back = themeM1.slice(iMine + 2);
  const origBody = orig.slice(iOrig + 2);
  // 头部说明必须保留原版设计文档的三行核心（不许删设计信息）
  for (const line of ['· 工作台描边', '· 三列背景', '还原设计稿 / 换配色，只动这一组变量即可']) {
    assert(theme.slice(0, iMine).includes(line), `99-theme 头部说明丢了原版设计文档：${line}`);
  }
  // 去 4 个前缀（只许这 4 处带 .frame 前缀）
  for (const [now, was] of [
    ['.frame .rail{', '.rail{'],
    ['.frame .sidebar{', '.sidebar{'],
    ['.frame .main-area{', '.main-area{'],
    ['.frame .frame-internal-stroke{', '.frame-internal-stroke{'],
  ] as const) {
    assert(back.includes(now), `99-theme 缺少文档化的 scoped 规则 ${now}`);
    back = back.replace(now, was);
  }
  assert(back === origBody, "去前缀后仍与原版不一致 —— 99-theme 的改动超出 M1' 文档化的机械适配");
});

// ---------------------------------------------------------------- 隔离：打不中当前 DOM
check('99-theme：.rail/.sidebar/.main-area/.frame-internal-stroke 规则全部 scoped 在 .frame 下（旧 aside.sidebar 打不中）', () => {
  const stripped = theme.replace(/\/\*[\s\S]*?\*\//g, '');
  const selRe = /([^{}]+)\{/g;
  let m: RegExpExecArray | null;
  const offenders: string[] = [];
  while ((m = selRe.exec(stripped)) !== null) {
    const sels = m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const s of sels) {
      for (const cls of ['rail', 'sidebar', 'main-area', 'frame-internal-stroke']) {
        // 选择器“等于”该类的裸规则（可带 :root 无关；这里只看纯类）
        if (s === `.${cls}`) offenders.push(s);
      }
    }
  }
  assert(offenders.length === 0, `存在未 scoped 的列规则（会直接打中旧 DOM）：${offenders.join(', ')}`);
});

/**
 * 02-base 能命中当前 DOM 的选择器是**有穷枚举**的：
 *   · body.viewport —— 当前 body 无 viewport 类 → 打不中；
 *   · M7' 桌面原语（.btn 系 / .small / .buttons-row）—— 有意打中（值与旧
 *     styles.css 相同，旧规则已删），白名单钉死，多一个选择器都红。
 */
const M7_BASE_SELECTORS = new Set([
  'body.viewport',
  '.btn', '.btn:hover', '.btn--go', '.btn--pending', '.btn--pending:hover',
  '.small', '.buttons-row',
]);
check('02-base：选择器 ∈ {body.viewport} ∪ M7\u2019桌面原语白名单', () => {
  const stripped = base.replace(/\/\*[\s\S]*?\*\//g, '');
  const selRe = /([^{}]+)\{/g;
  let m: RegExpExecArray | null;
  while ((m = selRe.exec(stripped)) !== null) {
    for (const s of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
      assert(M7_BASE_SELECTORS.has(s), `02-base 出现计划外选择器：${s}（M7' 白名单之外）`);
    }
  }
});

check('01-tokens：无类选择器（只有 :root / * / 元素族 / @font-face）', () => {
  const stripped = tokens.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@font-face\s*\{[^{}]*\}/g, '');
  const selRe = /([^{}@]+)\{/g;
  let m: RegExpExecArray | null;
  while ((m = selRe.exec(stripped)) !== null) {
    for (const s of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
      assert(!s.includes('.'), `01-tokens 出现类选择器 ${s}（M1' 的令牌层不许带类钩子）`);
    }
  }
});

/**
 * M7' 后盒模型的单一来源：01-tokens 的 *{box-sizing} 与 99-theme M7' 基座块的
 * *{box-sizing} 同值（border-box）。旧 styles.css 的那条已随基座块搬走（M9' 删文件）。
 */
check('01-tokens 与 99-theme 的 *{box-sizing} 同值 border-box（盒模型单一来源）', () => {
  assert(tokens.includes('box-sizing: border-box'), '01-tokens 缺 *{box-sizing:border-box}（与原版不符？）');
  const themeM7 = theme.slice(theme.indexOf(M7_THEME_MARKER));
  assert(/box-sizing\s*:\s*border-box/.test(themeM7), "99-theme M7\u2019基座块里没有 *{box-sizing:border-box} —— 盒模型来源断了");
});

// ---------------------------------------------------------------- 字体
check('inter-latin.woff2 与 workbench-ui 原版同 sha256（@font-face 相对路径 ../assets/fonts 两边同构）', () => {
  const a = createHash('sha256').update(readFileSync(join(REPO, 'apps', 'desktop', 'src', 'assets', 'fonts', 'inter-latin.woff2'))).digest('hex');
  const b = createHash('sha256').update(readFileSync(join(WB, 'assets', 'fonts', 'inter-latin.woff2'))).digest('hex');
  assert(a === b, `字体 sha256 不一致：${a.slice(0, 12)} vs ${b.slice(0, 12)}`);
});

console.log('');
console.log('=== 结论 ===');
console.log(`  ${pass} PASS / ${fail} FAIL`);
if (fail > 0) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exitCode = 1;
}
