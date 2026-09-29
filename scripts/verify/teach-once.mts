/**
 * 形态② 教一遍（2026-09-27）· 验收
 *
 * 用户标准（docs/产品交互规格.md）：
 *   说「教你一遍」/点「教」→ 页上操作一遍 → 录动作序列 → 生成技能卡 → 之后一句话回放成功。
 * 验收（真库 pglite + 真 app + 真加密,不配 LLM key→回放不依赖模型）：
 *   - POST /skills/teach（动作序列）→ 技能卡（直接 active；steps = 动作序列落成的步骤,加密）
 *   - 之后一句话命中触发条件 → buildSkillBlock 注入该技能（回放成功,录制的步骤都在块里）
 *   - 没录到动作 → 400 不生成卡（别造假卡）
 * 反证：scripts/verify/teach-revert-proof.py（拆录制闸 → 卡没有步骤 → 回放不出东西 → 必红）
 *
 * 用法：npx tsx scripts/verify/teach-once.mts
 */
import assert from 'node:assert/strict';
import { loadEnv } from '../../apps/server/src/env';
import { makeCipher } from '../../apps/server/src/crypto';
import { makePool, migrate } from '../../apps/server/src/db';
import { buildApp } from '../../apps/server/src/index';
import { buildSkillBlock } from '../../apps/server/src/orchestrator/skills';

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
  log('=== 形态② 教一遍 · 验收（真库 pglite + 真 app + 真加密）===');
  process.env.DATABASE_URL ??= 'pglite://memory';
  process.env.JWT_SECRET ??= 'verify-teach-once-jwt';
  process.env.DATA_KEY ??= 'k'.repeat(64);
  process.env.PHONE_PEPPER ??= 'verify-teach-once-pepper';
  process.env.SMS_MOCK ??= '1';
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_BASE_URL;
  const env = loadEnv();
  const cipher = makeCipher(env.dataKey);
  const pool = makePool('pglite://memory');
  await migrate(pool);
  const app = await buildApp(env, pool, cipher);
  const H = { 'content-type': 'application/json' };

  // 登录（拿 token + userId + 项目）
  const phone = '137' + String(Date.now()).slice(-8);
  const sj = await app.inject({ method: 'POST', url: '/auth/sms/send', headers: H, payload: JSON.stringify({ phone }) });
  const code = (sj.json() as { mock_code?: string }).mock_code;
  const lj = await app.inject({ method: 'POST', url: '/auth/login/sms', headers: H, payload: JSON.stringify({ phone, code }) });
  const token = (lj.json() as { token?: string }).token;
  assert.ok(token, '登录失败');
  const userId = Number(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).sub);
  const proj = (await app.inject({ method: 'GET', url: '/projects', headers: { ...H, authorization: `Bearer ${token}` } })).json() as { currentProjectId: number };
  const AH = { ...H, authorization: `Bearer ${token}` };
  const projectId = proj.currentProjectId;

  // 用户在页上操作一遍 → 录下来的动作序列（「教一遍」的录制产物）
  const actions = [
    { type: 'click', detail: '点击登录按钮' },
    { type: 'input', detail: '在搜索框输入咖啡店' },
    { type: 'click', detail: '点击按价格排序' },
  ];

  log('');
  log('--- ① 教一遍：动作序列 → 技能卡（录制落 steps,加密）---');
  let skillId = 0;
  await check('POST /skills/teach（动作序列）→ 技能卡（用户明确教 → 直接 active）', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/skills/teach',
      headers: AH,
      payload: JSON.stringify({ projectId, name: '咖啡店比价', triggerCondition: '咖啡店 比价 价格', actions }),
    });
    assert.equal(r.statusCode, 200, `teach 失败：${r.statusCode} ${r.body.slice(0, 160)}`);
    const j = r.json() as { skill: { id: number; status: string; steps: string[] }; recorded: number };
    assert.equal(j.skill.status, 'active', `教一遍应直接 active,实际 ${j.skill.status}`);
    assert.equal(j.recorded, 3, `应录 3 条动作,实际 ${j.recorded}`);
    skillId = j.skill.id;
    assert.ok(skillId > 0, '技能卡没有 id');
  });
  await check('技能卡的 steps = 动作序列落成的步骤（人话）,且加密落库（不存明文）', async () => {
    const row = (await pool.query<{ steps_enc: string }>('SELECT steps_enc FROM skills WHERE id=$1', [skillId])).rows[0];
    assert.ok(row, '没有技能行');
    assert.ok(String(row.steps_enc).startsWith('gcm$'), 'steps_enc 不是密文');
    const steps = JSON.parse(cipher.decryptText(row.steps_enc)) as string[];
    assert.equal(steps.length, 3, `应 3 步,实际 ${steps.length}`);
    assert.ok(steps[0].includes('点击登录按钮'), `第 1 步应是「点击登录」：${steps[0]}`);
    assert.ok(steps[1].includes('搜索框输入咖啡店'), `第 2 步应是「输入咖啡店」：${steps[1]}`);
    assert.ok(steps[2].includes('按价格排序'), `第 3 步应是「按价格排序」：${steps[2]}`);
  });

  log('');
  log('--- ② 一句话回放：命中触发条件 → buildSkillBlock 注入该技能 ---');
  await check('一句话命中触发条件 → 回放注入（录制的步骤都在块里）', async () => {
    const { block, matched } = await buildSkillBlock(pool, cipher, userId, projectId, '帮我比一下咖啡店的价格');
    assert.equal(matched.length, 1, `应命中 1 个技能,实际 ${matched.length}`);
    assert.ok(block.includes('咖啡店比价'), `块里应有技能名：${block.slice(0, 120)}`);
    assert.ok(block.includes('点击登录按钮'), `块里应有录制的第 1 步：${block.slice(0, 160)}`);
    assert.ok(block.includes('按价格排序'), `块里应有录制的第 3 步：${block.slice(0, 160)}`);
  });
  await check('GET /skills 列表出现这张教出来的卡（带 3 步）', async () => {
    const list = ((await app.inject({ method: 'GET', url: `/skills?projectId=${projectId}`, headers: AH })).json()) as { skills: { name: string; steps: string[] }[] };
    const s = list.skills.find((x) => x.name === '咖啡店比价');
    assert.ok(s, `列表里没出现：${JSON.stringify(list.skills.map((x) => x.name))}`);
    assert.equal(s!.steps.length, 3, '列表里技能应带 3 步');
  });

  log('');
  log('--- ③ 闸：没录到动作 → 不生成卡（别造假卡）/ 缺必填 → 400 ---');
  await check('空动作序列 → 400,不生成技能卡', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/skills/teach',
      headers: AH,
      payload: JSON.stringify({ projectId, name: '空技能', triggerCondition: '空', actions: [] }),
    });
    assert.equal(r.statusCode, 400, `空动作应 400,实际 ${r.statusCode} ${r.body.slice(0, 120)}`);
    const cnt = Number((await pool.query('SELECT count(*)::int n FROM skills WHERE name=$1', ['空技能'])).rows[0].n);
    assert.equal(cnt, 0, '空动作却生成了技能卡');
  });
  await check('缺 name/trigger → 400', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/skills/teach',
      headers: AH,
      payload: JSON.stringify({ actions: [{ type: 'click', detail: '点击 X' }] }),
    });
    assert.equal(r.statusCode, 400, `缺必填应 400,实际 ${r.statusCode}`);
  });

  await app.close();
  log('');
  log(`=== 结论：${passes} PASS / ${fails} FAIL ===`);
  process.exit(fails ? 1 : 0);
}

main().catch((err) => {
  console.error('验收脚本自身出错：', err);
  process.exit(1);
});
