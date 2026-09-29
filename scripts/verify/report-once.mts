/**
 * 形态⑤ 主动汇报（2026-09-27）· 验收
 *
 * 用户标准（docs/产品交互规格.md）：任务结束 → 一句话报结果进对话流。
 * 验收（真库 pglite + 真 app + 真加密）：
 *   - POST /agent/task/status {taskId, status:'done'} → 项目主会话多一条「✅ 任务完成：…」
 *   - 拆掉主动汇报 → 项目主会话没有新消息 → 必红
 * 反证：scripts/verify/report-revert-proof.py（拆主动汇报 → 没新消息 → 必红）
 *
 * 用法：npx tsx scripts/verify/report-once.mts
 */
import assert from 'node:assert/strict';
import { loadEnv } from '../../apps/server/src/env';
import { makeCipher } from '../../apps/server/src/crypto';
import { makePool, migrate } from '../../apps/server/src/db';
import { buildApp } from '../../apps/server/src/index';

let passes = 0;
let fails = 0;
const log = (...a: unknown[]) => console.log(a.map(String).join(' '));
const check = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  try {
    await fn();
    passes += 1;
    log(`  ✓ ${name}`);
  } catch (err) {
    fails += 1;
    log(`  ✗ ${name}`);
    log(`      ${(err as Error)?.message?.split('\n').slice(0, 4).join('\n      ') ?? String(err)}`);
  }
};

async function main(): Promise<void> {
  log('=== 形态⑤ 主动汇报 · 验收（真库 pglite + 真 app + 真加密）===');
  process.env.DATABASE_URL ??= 'pglite://memory';
  process.env.JWT_SECRET ??= 'verify-report-once-jwt';
  process.env.DATA_KEY ??= 'k'.repeat(64);
  process.env.PHONE_PEPPER ??= 'verify-report-once-pepper';
  process.env.SMS_MOCK ??= '1';

  const env = loadEnv();
  const cipher = makeCipher(env.dataKey);
  const pool = await makePool(env.databaseUrl);
  await migrate(pool);
  const app = await buildApp(env, pool, cipher);

  // 登录（SMS mock）
  const H = { 'content-type': 'application/json' };
  const phone = '137' + String(Date.now()).slice(-8);
  const sj = await app.inject({ method: 'POST', url: '/auth/sms/send', headers: H, payload: JSON.stringify({ phone }) });
  const code = (sj.json() as { mock_code?: string }).mock_code;
  const lj = await app.inject({ method: 'POST', url: '/auth/login/sms', headers: H, payload: JSON.stringify({ phone, code }) });
  const token = (lj.json() as { token?: string }).token;
  assert.ok(token, '登录失败');
  const auth = { ...H, authorization: `Bearer ${token}` };

  // 拿当前项目（登录流程自动建了默认项目）
  const projRes = await app.inject({ method: 'GET', url: '/projects', headers: auth });
  assert.ok(projRes.statusCode < 300, `拿项目失败：${projRes.statusCode} ${projRes.body}`);
  const projectId = (JSON.parse(projRes.body) as { currentProjectId: number }).currentProjectId;

  // 建一个会话（writeCollabToProjectChat 往项目最近会话写消息，没有会话就跳过）
  await pool.query('INSERT INTO conversations (project_id, title) VALUES ($1, \'汇报测试会话\')', [projectId]);

  const taskRes = await app.inject({
    method: 'POST',
    url: '/agent/task/start',
    headers: auth,
    payload: JSON.stringify({ goal: '查一下店铺数据' }),
  });
  assert.ok(taskRes.statusCode < 300, `建任务失败：${taskRes.statusCode} ${taskRes.body}`);
  const taskId = (JSON.parse(taskRes.body) as { taskId: number }).taskId;

  // 数一下项目主会话的消息数
  const countBefore = await pool.query(
    `SELECT COUNT(*)::int AS n FROM messages m JOIN conversations c ON m.conversation_id = c.id WHERE c.project_id = $1`,
    [projectId],
  );
  const before = countBefore.rows[0].n;

  await check('任务 done → 项目主会话多一条「✅ 任务完成：…」', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/agent/task/status',
      headers: auth,
      payload: JSON.stringify({ taskId, status: 'done' }),
    });
    assert.ok(res.statusCode === 200, `task/status done 失败：${res.statusCode} ${res.body}`);
    // 等一拍（fire-and-forget 的 writeCollabToProjectChat）
    await new Promise((r) => setTimeout(r, 300));
    const countAfter = await pool.query(
      `SELECT COUNT(*)::int AS n FROM messages m JOIN conversations c ON m.conversation_id = c.id WHERE c.project_id = $1`,
      [projectId],
    );
    const after = countAfter.rows[0].n;
    assert.ok(after > before, `项目主会话没有新消息（before=${before} after=${after}）—— 主动汇报没写进去`);
    const lastMsg = await pool.query(
      `SELECT m.id FROM messages m JOIN conversations c ON m.conversation_id = c.id WHERE c.project_id = $1 ORDER BY m.id DESC LIMIT 1`,
      [projectId],
    );
    const msgId = Number(lastMsg.rows[0].id);
    const encRow = await pool.query<{ content_enc: string }>(
      'SELECT content_enc FROM messages WHERE id = $1',
      [msgId],
    );
    const text = cipher.decryptText(encRow.rows[0].content_enc);
    assert.match(text, /任务完成/, `新消息不是「任务完成」：${text}`);
  });

  await check('failed 不汇报（只 done 才报结果）', async () => {
    const task2 = await app.inject({
      method: 'POST',
      url: '/agent/task/start',
      headers: auth,
      payload: JSON.stringify({ goal: '会失败的任务' }),
    });
    const tid2 = (JSON.parse(task2.body) as { taskId: number }).taskId;
    const countBefore2 = await pool.query(
      `SELECT COUNT(*)::int AS n FROM messages m JOIN conversations c ON m.conversation_id = c.id WHERE c.project_id = $1`,
      [projectId],
    );
    const before2 = countBefore2.rows[0].n;
    const res = await app.inject({
      method: 'POST',
      url: '/agent/task/status',
      headers: auth,
      payload: JSON.stringify({ taskId: tid2, status: 'failed' }),
    });
    assert.ok(res.statusCode === 200, `task/status failed 失败：${res.statusCode} ${res.body}`);
    await new Promise((r) => setTimeout(r, 300));
    const countAfter2 = await pool.query(
      `SELECT COUNT(*)::int AS n FROM messages m JOIN conversations c ON m.conversation_id = c.id WHERE c.project_id = $1`,
      [projectId],
    );
    const after2 = countAfter2.rows[0].n;
    assert.equal(after2, before2, `failed 不该汇报（before=${before2} after=${after2}）`);
  });

  log(`\n=== 结论：${passes} PASS / ${fails} FAIL ===`);
  process.exit(fails > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('验收脚本自身出错：', err);
  process.exit(1);
});
