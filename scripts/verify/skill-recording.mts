/**
 * G4（2026-09-26）· 技能录制（成功且用过工具的任务 → 确认卡 → 确认才入库）· 验收
 *
 * 用户标准：
 *   - 任务成功且用了工具后，把「工具序列+触发条件+决策要点」存成技能（加密,走现有 skills 表）
 *   - 不静默生效：对话流转确认卡「要把这次存成技能吗」,确认才入库（同 memories pending 口径）
 *   - 复用：既有 buildSkillBlock 按 trigger 注入,trigger_condition 从原任务（goal）推导
 * 验收：成功任务→出确认卡→确认→skills 真有加密行→同类新任务注入该技能；
 *       没确认/拒绝 → 永不注入；没用工具 → 不录；重复跑同任务 → 不刷第二张卡。真库可复现。
 *
 * 用法：npx tsx scripts/verify/skill-recording.mts
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  log('=== G4 · 技能录制 · 验收（真库 pglite + 真 app + 真加密,不配 LLM key→收尾走兜底）===');

  process.env.DATABASE_URL ??= 'pglite://memory';
  process.env.JWT_SECRET ??= 'verify-skill-recording-jwt';
  process.env.DATA_KEY ??= 'k'.repeat(64);
  process.env.PHONE_PEPPER ??= 'verify-skill-recording-pepper';
  process.env.SMS_MOCK ??= '1';
  delete process.env.DEEPSEEK_API_KEY; // 不收尾整理/记忆提取的模型调用,收尾走兜底
  delete process.env.DEEPSEEK_BASE_URL;
  const env = loadEnv();
  const cipher = makeCipher(env.dataKey);
  const pool = makePool('pglite://memory');
  await migrate(pool);
  const app = await buildApp(env, pool, cipher);
  const H = { 'content-type': 'application/json' };

  const login = async (phone: string): Promise<{ token: string; userId: number; projectId: number }> => {
    const sj = await app.inject({ method: 'POST', url: '/auth/sms/send', headers: H, payload: JSON.stringify({ phone }) });
    const code = (sj.json() as { mock_code?: string }).mock_code;
    const lj = await app.inject({ method: 'POST', url: '/auth/login/sms', headers: H, payload: JSON.stringify({ phone, code }) });
    const token = (lj.json() as { token?: string }).token;
    assert.ok(token, '登录失败');
    // userId 从 JWT sub 解（users 表只存 phone_hash/phone_enc,不存明文手机号）
    const userId = Number(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).sub);
    const proj = (await app.inject({ method: 'GET', url: '/projects', headers: { ...H, authorization: `Bearer ${token}` } })).json() as { currentProjectId: number };
    return { token, userId, projectId: proj.currentProjectId };
  };

  const u1 = await login('138' + String(Date.now()).slice(-8));
  const AH = { ...H, authorization: `Bearer ${u1.token}` };

  // 项目主会话（技能确认卡的落点；driver 场景下就是用户正在用的那个对话流）
  await pool.query('INSERT INTO conversations (project_id, agent_id, title) VALUES ($1, NULL, $2)', [u1.projectId, '主会话']);
  const convId = Number((await pool.query('SELECT id FROM conversations WHERE project_id=$1 ORDER BY id DESC LIMIT 1', [u1.projectId])).rows[0].id);
  log(`  用户 #${u1.userId} / 项目 #${u1.projectId} / 主会话 #${convId}`);

  const task = async (goal: string, steps: string[], done?: { summary?: string; document_title?: string }): Promise<number> => {
    const s = await app.inject({ method: 'POST', url: '/agent/task/start', headers: AH, payload: JSON.stringify({ goal }) });
    assert.equal(s.statusCode, 200, `task/start 失败：${s.body.slice(0, 120)}`);
    const taskId = Number((s.json() as { taskId: number }).taskId);
    for (const sum of steps) {
      const r = await app.inject({ method: 'POST', url: '/agent/task/step', headers: AH, payload: JSON.stringify({ taskId, summary: sum, ok: true }) });
      assert.equal(r.statusCode, 200, `task/step 失败：${r.body.slice(0, 120)}`);
    }
    if (done) {
      const f = await app.inject({ method: 'POST', url: '/agent/task/finish', headers: AH, payload: JSON.stringify({ taskId, ...done }) });
      assert.equal(f.statusCode, 200, `task/finish 失败：${f.body.slice(0, 160)}`);
    } else {
      const st = await app.inject({ method: 'POST', url: '/agent/task/status', headers: AH, payload: JSON.stringify({ taskId, status: 'done' }) });
      assert.equal(st.statusCode, 200, `task/status 失败：${st.body.slice(0, 120)}`);
    }
    return taskId;
  };

  /** 轮询等 fire-and-forget 的录制落库（不写死 sleep,落库即返回） */
  const waitForPending = async (goal: string): Promise<{ id: number } | null> => {
    for (let i = 0; i < 100; i++) {
      const r = await pool.query<{ id: string }>(
        `SELECT id FROM skills WHERE user_id=$1 AND trigger_condition=$2 AND status='pending' ORDER BY id DESC LIMIT 1`,
        [u1.userId, goal.slice(0, 500)],
      );
      if (r.rowCount === 1) return { id: Number(r.rows[0].id) };
      await sleep(50);
    }
    return null;
  };
  const cardTexts = async (): Promise<string[]> => {
    const r = await pool.query<{ content_enc: string }>(
      `SELECT content_enc FROM messages WHERE conversation_id=$1 AND role='assistant' ORDER BY id`,
      [convId],
    );
    return r.rows.map((x) => { try { return cipher.decryptText(x.content_enc); } catch { return ''; } });
  };
  const skillCount = async (status: string) =>
    Number((await pool.query('SELECT count(*)::int AS n FROM skills WHERE user_id=$1 AND status=$2', [u1.userId, status])).rows[0].n);

  log('');
  log('--- ① 主链路：成功+用过工具 → pending 加密行 + 对话流确认卡 ---');
  // goal 无分隔符 → buildSkillBlock 的字面匹配整句当一个触发词；「再来一次」类消息带整句即命中
  const goalA = '搜索竞品咖啡店价格';
  const reaskA = '搜索竞品咖啡店价格,这次把瑞幸也算进去';
  const stepsA = ['步 1：打开 https://coffee-a.com/menu', '步 2：点击「按价格排序」', '步 3：输入「拿铁 价格」（长度 6）'];
  const tA = await task(goalA, stepsA, { summary: '3 家价格对比完成,已写入表格', document_title: '竞品价格对比' });
  const pendA = await waitForPending(goalA);
  await check('完成的任务录成了 pending 技能（status=pending,不静默生效）', () => {
    assert.ok(pendA, `等 5s 库里没有 pending 技能行（goal=${goalA}）`);
  });
  const rowA = pendA ? await pool.query<any>(`SELECT * FROM skills WHERE id=$1`, [pendA.id]) : { rows: [] };
  const a = rowA.rows[0];
  await check('触发条件=任务目标（trigger_condition 明文用于匹配,trigger_enc 密文同存）', () => {
    assert.ok(a, '无技能行可验');
    assert.equal(a.trigger_condition, goalA, `trigger_condition 应为 goal,实际 ${a.trigger_condition}`);
    assert.ok(String(a.trigger_enc).startsWith('gcm$'), 'trigger_enc 不是密文');
    assert.equal(cipher.decryptText(a.trigger_enc), goalA, 'trigger_enc 解回应=goal');
  });
  await check('工具序列加密落 steps_enc（=任务步骤账本：脱敏后原样,解回可数）', async () => {
    assert.ok(a, '无技能行可验');
    assert.ok(String(a.steps_enc).startsWith('gcm$'), 'steps_enc 不是密文');
    const steps = JSON.parse(cipher.decryptText(a.steps_enc)) as string[];
    // 步骤进库前过 scrubStepSummary（引号里的输入原文会脱敏）—— 录制的序列必须与任务账本**逐字一致**
    const taskSteps = (await pool.query<{ payload: { steps?: string[] } }>('SELECT payload FROM tasks WHERE id=$1', [tA])).rows[0].payload.steps ?? [];
    assert.deepEqual(steps, taskSteps, `steps 解回应=任务账本,实际 ${JSON.stringify(steps)}`);
    assert.equal(steps.length, 3, '应是 3 个工具步');
  });
  await check('决策要点=驾驶员 done 结论（decision_rules_enc）+ 产出=文档标题（output_requirements_enc）', () => {
    assert.ok(a, '无技能行可验');
    assert.equal(cipher.decryptText(a.decision_rules_enc), '3 家价格对比完成,已写入表格', 'decision_rules 解回应=done 结论');
    assert.equal(cipher.decryptText(a.output_requirements_enc), '竞品价格对比', 'output 解回应=文档标题');
    assert.equal(Number(a.project_id), u1.projectId, '技能应挂任务的项目');
  });
  await check('对话流出了【协同·技能】确认卡（含「要把这次存成技能吗」+ 待确认技能 #id）,库里是密文', async () => {
    const texts = await cardTexts();
    const card = texts.find((t) => t.startsWith('【协同·技能】'));
    assert.ok(card, `主会话里没有【协同·技能】卡：${JSON.stringify(texts).slice(0, 200)}`);
    assert.ok(card.includes('要把这次存成技能吗'), `卡里没问确认：${card}`);
    assert.ok(card.includes(`技能 #${pendA!.id}`), `卡里没带待确认技能 id：${card}`);
    const raw = (await pool.query<{ content_enc: string }>('SELECT content_enc FROM messages WHERE conversation_id=$1 AND role=\'assistant\' ORDER BY id DESC LIMIT 1', [convId])).rows[0];
    assert.ok(String(raw.content_enc).startsWith('gcm$'), '卡片消息在库里不是密文');
  });
  await check('未确认前：GET /skills 列表里没有它（只列 active）', async () => {
    const list = ((await app.inject({ method: 'GET', url: `/skills?projectId=${u1.projectId}`, headers: AH })).json()) as { skills: { name: string }[] };
    assert.ok(!list.skills.some((s) => s.name === goalA.slice(0, 60)), `pending 不该出现在列表：${JSON.stringify(list.skills)}`);
  });
  await check('未确认前：buildSkillBlock 不注入（同类新任务也不影响行为）', async () => {
    const { block } = await buildSkillBlock(pool, cipher, u1.userId, u1.projectId, reaskA);
    assert.equal(block, '', `pending 不该被注入：${block.slice(0, 120)}`);
  });

  log('');
  log('--- ② 确认 → active → 同类新任务注入该技能 ---');
  await check('POST /skills/confirm {id} → active', async () => {
    const r = await app.inject({ method: 'POST', url: '/skills/confirm', headers: AH, payload: JSON.stringify({ id: pendA!.id }) });
    assert.equal(r.statusCode, 200, `confirm 失败：${r.statusCode} ${r.body.slice(0, 120)}`);
    assert.equal((r.json() as { status?: string }).status, 'active');
    const st = (await pool.query('SELECT status FROM skills WHERE id=$1', [pendA!.id])).rows[0].status;
    assert.equal(st, 'active', `库状态应为 active,实际 ${st}`);
  });
  await check('确认后：buildSkillBlock 按 trigger 注入该技能（步骤+决策规则都在块里）', async () => {
    const { block, matched } = await buildSkillBlock(pool, cipher, u1.userId, u1.projectId, reaskA);
    assert.ok(block.includes('搜索竞品咖啡店价格'), `块里应有技能内容：${block.slice(0, 120)}`);
    assert.ok(block.includes('按价格排序'), '块里应有工具序列内容');
    assert.ok(block.includes('3 家价格对比完成'), '块里应有决策要点');
    assert.equal(matched.length, 1, `应命中 1 个技能,实际 ${matched.length}`);
  });
  await check('确认后：GET /skills 列表出现该技能', async () => {
    const list = ((await app.inject({ method: 'GET', url: `/skills?projectId=${u1.projectId}`, headers: AH })).json()) as { skills: { name: string; steps: string[] }[] };
    const s = list.skills.find((x) => x.name === goalA.slice(0, 60));
    assert.ok(s, `列表里没出现：${JSON.stringify(list.skills.map((x) => x.name))}`);
    assert.equal(s!.steps.length, 3, '列表里技能应带 3 步');
  });

  log('');
  log('--- ③ 闸：重复跑不刷卡 / 没用工具不录 / 拒绝不注入 / 别人的动不了 ---');
  await check('重复跑同一任务 → 不录第二行、不刷第二张卡（去重闸）', async () => {
    const cardsBefore = (await cardTexts()).filter((t) => t.startsWith('【协同·技能】')).length;
    await task(goalA, stepsA, { summary: '再跑一遍', document_title: '竞品价格对比' });
    await sleep(400); // 给去重后的「不录」留时间（这里验的是**没有**新东西）
    assert.equal(await skillCount('pending'), 0, `重复跑后又冒出 pending：${await skillCount('pending')}`);
    const cardsAfter = (await cardTexts()).filter((t) => t.startsWith('【协同·技能】')).length;
    assert.equal(cardsAfter, cardsBefore, `确认卡从 ${cardsBefore} 变成 ${cardsAfter}（刷卡了）`);
  });
  await check('没用工具的任务（只有收尾步）→ 不录技能、不出卡', async () => {
    const cardsBefore = (await cardTexts()).filter((t) => t.startsWith('【协同·技能】')).length;
    const goalB = '整理本周排班表';
    await task(goalB, ['收尾：排班记在脑子里,没动工具'], { summary: '已整理' });
    const pend = await waitForPending(goalB);
    assert.equal(pend, null, `没动工具不该录技能,却有 pending #${pend?.id}`);
    const cardsAfter = (await cardTexts()).filter((t) => t.startsWith('【协同·技能】')).length;
    assert.equal(cardsAfter, cardsBefore, '没动工具却出了确认卡');
  });
  const u2 = await login('139' + String(Date.now()).slice(-8));
  const AH2 = { ...H, authorization: `Bearer ${u2.token}` };
  const goalC = '查一下明天飞深圳的机票价格';
  await task(goalC, ['步 1：打开 https://flight.example.com', '步 2：点击「明天」'], { summary: '价格已查' });
  const pendC = await waitForPending(goalC);
  await check('别人的账号 confirm 别人的 pending → 404（归属闸）', async () => {
    assert.ok(pendC, '任务 C 没录上 pending,后断没法验');
    const r = await app.inject({ method: 'POST', url: '/skills/confirm', headers: AH2, payload: JSON.stringify({ id: pendC!.id }) });
    assert.equal(r.statusCode, 404, `别人的 confirm 应 404,实际 ${r.statusCode} ${r.body.slice(0, 100)}`);
  });
  await check('本人 reject → rejected（留痕不删,永不注入）', async () => {
    const r = await app.inject({ method: 'POST', url: '/skills/reject', headers: AH, payload: JSON.stringify({ id: pendC!.id }) });
    assert.equal(r.statusCode, 200, `reject 失败：${r.statusCode} ${r.body.slice(0, 100)}`);
    const st = (await pool.query('SELECT status FROM skills WHERE id=$1', [pendC!.id])).rows[0].status;
    assert.equal(st, 'rejected', `应为 rejected,实际 ${st}`);
    const { block } = await buildSkillBlock(pool, cipher, u1.userId, u1.projectId, '帮我查明天飞深圳的机票价格');
    assert.equal(block, '', 'rejected 的技能不该被注入');
  });
  await check('重复 confirm（已不是 pending）→ 404（幂等,如实报错）', async () => {
    const r = await app.inject({ method: 'POST', url: '/skills/confirm', headers: AH, payload: JSON.stringify({ id: pendC!.id }) });
    assert.equal(r.statusCode, 404, `重复 confirm 应 404,实际 ${r.statusCode}`);
  });

  log('');
  log('--- ④ 不破坏：手动 POST /skills（teach-a-task）照旧直接 active ---');
  await check('手动教学技能直接 active,立即可注入（旧行为不 regress）', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/skills',
      headers: AH,
      payload: JSON.stringify({ name: '周报汇总', triggerCondition: '周报,汇总,本周数据', steps: ['拉本周数据', '按模块归类', '输出周报'] }),
    });
    assert.equal(r.statusCode, 200, `POST /skills 失败：${r.statusCode} ${r.body.slice(0, 120)}`);
    assert.equal((r.json() as { skill: { status: string } }).skill.status, 'active', `手动教学应直接 active,实际 ${(r.json() as { skill: { status: string } }).skill.status}`);
    const { block } = await buildSkillBlock(pool, cipher, u1.userId, u1.projectId, '把本周数据做个周报汇总');
    assert.ok(block.includes('周报汇总'), `手动技能应立即可注入：${block.slice(0, 100)}`);
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
