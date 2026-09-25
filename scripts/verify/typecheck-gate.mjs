/**
 * 批次 L 补丁(QA-01)| typecheck 门禁的"接线检查":
 * 编译过了还不够 —— 还有一处曾经被漏掉的**运行时空值**要钉住:
 * chat.ts 调 createRoutineFromMessage 时,turnSpeakerId 可为 null,
 * 必须有判空守卫(空 → 回落 LLM),否则类型修好了、运行时照样把 null 塞进去。
 *
 * 用法:node scripts/verify/typecheck-gate.mjs(在 verify:typecheck 的 tsc 全绿之后跑)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const chat = fs.readFileSync(path.join(here, '../../apps/server/src/routes/chat.ts'), 'utf8');

let fails = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fails += 1;
    console.log(`  ✗ ${name}`);
    console.log(`      ${(err.message ?? String(err)).split('\n').slice(0, 3).join('\n      ')}`);
  }
};

console.log('');
console.log('=== typecheck 门禁 · chat.ts 接线检查 ===');

check('routine 块对 turnSpeakerId 判空(空 → 不建,回落 LLM)', () => {
  const block = chat.slice(chat.indexOf('批次 L 片 2'));
  const guard = block.match(/if \(([^)]*turnSpeakerId[^)]*)\)/);
  if (!guard) throw new Error('routine 块里没有 turnSpeakerId 的判空守卫');
  if (!guard[1].includes('turnSpeakerId !== null') && !guard[1].includes('turnSpeakerId != null')) {
    throw new Error(`守卫条件不对:${guard[1]}`);
  }
});

check('判空守卫在 createRoutineFromMessage 调用之前(不是调完再判)', () => {
  const block = chat.slice(chat.indexOf('批次 L 片 2'));
  const idxGuard = block.indexOf('turnSpeakerId !== null');
  const idxCall = block.indexOf('createRoutineFromMessage');
  if (idxGuard === -1 || idxCall === -1 || idxGuard > idxCall) {
    throw new Error(`guard@${idxGuard} call@${idxCall}(守卫必须在调用前)`);
  }
});

console.log('');
console.log('=== 结论 ===');
console.log(`  失败项:${fails}`);
process.exit(fails > 0 ? 1 : 0);
