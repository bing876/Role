/**
 * QA-27 | 全仓审计钉:`tasks` 表 payload 列的**全部写入点**,不许长出新的明文口子。
 *
 * 审计结论(2026-09-25,人工过全仓 grep 后由本脚本钉死):写点共 5 处 ——
 *   [A1] routes/agent.ts  /agent/task/start   INSERT,payload = { steps: [] }(空,无用户文本);
 *   [A2] routes/agent.ts  /agent/task/step    UPDATE,summary 先过 scrubStepSummary(值形态脱敏),
 *       动态反例由 task-encryption-pglite.mts ⑤-B 六条钉住;桌面端目前**没有**该接口的调用方
 *       (全仓只有服务端路由定义),服务端脱敏就是唯一闸;
 *   [A3] routes/agent.ts  /agent/task/finish  UPDATE,payload 只 spread 既有 payload
 *       (payloadWithoutGoal 摘 goal),doc 属 payload.doc.* 已知缺口(不在 steps 口径内);
 *   [B1] db.ts  回填(情形 1):旧行 payload.goal → goal_enc 加密,payload 只**复制既有行并
 *       delete goal** —— 不引入新用户文本;
 *   [B2] db.ts  回填(情形 2):同上,清明文副本。
 *   注:旧行里**已有的**明文 steps 属"旧明文列暂不 drop、全表回填推迟"的拍板范围,不在本钉口径。
 *
 * 谁加了第 6 处写点 / 谁把 scrub 摘了 / 谁让 start 的 steps 非空 / 谁让回填抄回 goal → 全红。
 * 用法:node scripts/verify/payload-steps-audit.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = path.join(here, '../../apps/server/src');
const agent = fs.readFileSync(path.join(serverSrc, 'routes/agent.ts'), 'utf8');
const agentLines = agent.split('\n');
const db = fs.readFileSync(path.join(serverSrc, 'db.ts'), 'utf8');
const dbLines = db.split('\n');

let fails = 0;
function check(name, fn, extra = '') {
  try {
    fn();
    console.log(`  ✓ ${name}${extra ? '\n      ' + extra : ''}`);
  } catch (err) {
    fails += 1;
    console.log(`  ✗ ${name}`);
    console.log(`      ${(err.message ?? String(err)).split('\n').slice(0, 4).join('\n      ')}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

console.log('');
console.log('=== QA-27 · tasks.payload 写入点全审计(共应 5 处) ===');

// ---------------------------------------------------------------- 枚举
const findSites = (lines) => {
  const inserts = [], updates = [];
  lines.forEach((ln, i) => {
    if (/INSERT INTO tasks/.test(ln)) inserts.push(i + 1);
    if (/UPDATE tasks/.test(ln) && /payload\s*=\s*\$\d+::jsonb/.test(ln)) updates.push(i + 1);
  });
  return { inserts, updates };
};
const a = findSites(agentLines);
const b = findSites(dbLines);
check(`[枚举] agent.ts: INSERT ${a.inserts.join(',')} + payload UPDATE ${a.updates.join(',')} (=3)` +
  `;db.ts: 回填 UPDATE ${b.updates.join(',')} (=2);INSERT ${b.inserts.length}(应 0)`, () => {
  assert(a.inserts.length === 1 && a.updates.length === 2, `agent.ts 写点数量变了:INSERT ${a.inserts} UPDATE ${a.updates}`);
  assert(b.updates.length === 2 && b.inserts.length === 0, `db.ts 写点数量变了:INSERT ${b.inserts} UPDATE ${b.updates}`);
});

// ---------------------------------------------------------------- [A1] start 恒空
check('[A1] /agent/task/start 的 payload 恒为 { steps: [] }(不夹带用户文本)', () => {
  const block = agentLines.slice(a.inserts[0] - 3, a.inserts[0] + 3).join('\n');
  assert(block.includes("JSON.stringify({ steps: [] })"), `INSERT 附近 payload 不是空 steps:\n${block}`);
});

// ---------------------------------------------------------------- [A2] step 过 scrub
check('[A2] /agent/task/step 的 summary 赋值走了 scrubStepSummary(脱敏闸没被摘)', () => {
  const ln = a.updates[0];
  let found = null;
  for (let i = ln; i >= 0 && i >= ln - 40; i--) {
    if (/const summary = /.test(agentLines[i]) && /scrubStepSummary/.test(agentLines[i])) { found = i + 1; break; }
  }
  assert(found, `UPDATE(payload) 前 40 行内找不到"summary 赋值过 scrubStepSummary"(agent.ts:${ln} 附近)—— 脱敏闸被摘了?`);
  return found;
});

// ---------------------------------------------------------------- [A3] finish 只 spread
check('[A3] /agent/task/finish 的 payload 只 spread 既有 payload(不新增用户文本字面量)', () => {
  const block = agentLines.slice(a.updates[1] - 4, a.updates[1] + 4).join('\n');
  assert(/\{\s*\.\.\.payload\s*,\s*doc:/.test(block), `finish 的 payload 不是 spread 既有 payload:\n${block}`);
});

// ---------------------------------------------------------------- [B1/B2] 回填只"复制并删 goal"
for (let k = 0; k < b.updates.length; k++) {
  const ln = b.updates[k];
  check(`[B${k + 1}] db.ts:${ln} 回填 UPDATE 前必须有 delete rest.goal(只复制既有 payload,不抄回 goal)`, () => {
    const block = dbLines.slice(ln - 12, ln + 2).join('\n');
    assert(block.includes('delete rest.goal'), `回填 UPDATE 前 12 行内没有 "delete rest.goal" —— 会抄回明文 goal:\n${block.slice(-300)}`);
  });
}

// ---------------------------------------------------------------- 全仓交叉
check('[交叉] 全仓再扫:tasks 写点文件只允许 {routes/agent.ts, db.ts}', () => {
  const files = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (!/\.(ts|mts)$/.test(e.name)) continue;
      const t = fs.readFileSync(p, 'utf8');
      if (/INSERT INTO tasks/.test(t) || /UPDATE tasks[^\n]*payload/.test(t)) files.add(p);
    }
  };
  walk(serverSrc);
  for (const p of files) {
    // ★ 必须归一成 `/`（2026-09-25 修）：`path.relative` 在 Windows 返回 `routes\agent.ts`，
    //   而下面的白名单是 `/` 拼的 ⇒ 在 Windows 上**永远红**（Linux/macOS 绿）。
    //   这是「测试只在本机红」的典型形状 —— 会让人去怀疑代码，而不是怀疑测试。
    const rel = path.relative(serverSrc, p).split(path.sep).join('/');
    assert(rel === 'routes/agent.ts' || rel === 'db.ts', `发现新的 tasks 写点:${rel} —— 新口子必须先过脱敏审计`);
  }
});

console.log('');
console.log('=== 结论 ===');
console.log(`  失败项:${fails}`);
process.exit(fails > 0 ? 1 : 0);
