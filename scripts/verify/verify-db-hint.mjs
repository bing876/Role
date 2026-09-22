// verify-db-hint.mjs —— 验证「数据库连不上」的指引已改成本机可用的动作。
//
// 为什么需要：服务端 8 个 route 都回同一句「先跑 docker compose…」，但本机
// 没有可用的 Docker（PG 是便携包），照做的用户只会更困惑。渲染层统一换成
// 指向 start-dev.cmd 的指引。
//
// 断言钉在**压缩后必然还在**的东西上（见 MEMORY.md 第三节）：
//   · 用户可见文案字符串（就是字面量）
// 不钉函数名（dbHint 会被 vite 改名）。
//
// 用法：node scripts/verify/verify-db-hint.mjs
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const SRC = path.join(REPO, 'apps', 'desktop', 'src', 'App.tsx');

const FAILS = [];
const PASSES = [];
function check(name, cond, detail = '') {
  (cond ? PASSES : FAILS).push(name + (detail ? `  [${detail}]` : ''));
}

const raw = fs.readFileSync(SRC, 'utf8');

// ★ 必须先剥掉注释再断言 —— 否则会踩「注释里提到了旧文案」这个假警报
//   （MEMORY.md 第八节：「查用户可见文案要用渲染层 + 剥注释」）。
function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // 行注释（避开 URL 里的 //）
}
const src = stripComments(raw);

// ---------- 1) 源码层：老的、跑不通的指引必须消失 ----------
check('源码（剥注释后）已不含 "先起库（npm run db:up）" 的老文案',
  !src.includes('先起库（npm run db:up）'));
check('源码（剥注释后）已不含 "先跑 docker compose" 的老文案',
  !src.includes('先跑 docker compose'));
// 反证用：注释里确实提过（说明断言是在剥了注释之后才成立的，不是碰巧）
check('（自查）原文件注释里确实出现过该字样 —— 证明上面那条是靠剥注释才通过的',
  raw.includes('先跑 docker compose'));

// ---------- 2) 源码层：新指引必须存在 ----------
check('新增了指向 start-dev.cmd 的指引',
  src.includes('start-dev.cmd'));
check('明确说了「双击仓库根目录」',
  /双击仓库根目录的 start-dev\.cmd/.test(src));

// ---------- 3) 替换函数存在且覆盖「数据库连不上」 ----------
check('存在把服务端 docker 文案换掉的逻辑',
  /数据库连不上/.test(src) && /dbHint/.test(src));

// ---------- 4) 限流提示已加上（429 那句「太频繁」） ----------
check('429「太频繁」被单独解释成防刷限制',
  src.includes('太频繁') && src.includes('防刷限制'));

// ---------- 5) 验证码提示不再让用户去翻终端 ----------
check('验证码提示指向「AI工作台-服务端」窗口',
  src.includes('AI工作台-服务端'));

// ---------- 6) 关键：确保没有把「数据库连不上」这句话从代码里删干净 ----------
// dbHint 必须能认出服务端那句话，所以这个子串必须保留在代码里。
check('保留了「数据库连不上」这个匹配子串（否则 dbHint 永远不触发）',
  src.includes('数据库连不上'));

console.log('=== verify-db-hint ===');
for (const p of PASSES) console.log('  ✓ ' + p);
for (const f of FAILS) console.log('  ✗ ' + f);
console.log(`\n通过 ${PASSES.length} / 失败 ${FAILS.length}`);
process.exit(FAILS.length ? 1 : 0);
