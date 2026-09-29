/**
 * #7 + 怀疑 3 修复验收（2026-09-29）· **用真数据库证明行为没变**。
 *
 * ## 修了什么
 *
 * 原状（`startIdleScheduler` 里每分钟那条）：
 *
 *     SELECT c.id, p.user_id, c.agent_id, MAX(m.id), MAX(m.created_at)
 *       FROM conversations c
 *       JOIN projects p ON p.id = c.project_id
 *       LEFT JOIN messages m ON m.conversation_id = c.id
 *      WHERE COALESCE(c.keepalive,false) = false
 *      GROUP BY c.id, p.user_id, c.agent_id
 *
 * **不设时间上界** ⇒ 每个分钟把**全部历史消息** join 一遍再分组。
 * 消息表只增不减 ⇒ 成本随上线时间线性增长，而它每分钟都跑。
 *
 * 修法两件：
 *   ① 查询加时间上界（放在 **JOIN 条件**里，保持 LEFT JOIN 语义；
 *      放 WHERE 里会把它实质变成 INNER JOIN）
 *   ② `messages` 加复合索引 `(conversation_id, id)`
 *      —— 左前缀覆盖原单列索引，且让
 *      `WHERE conversation_id=$1 ORDER BY id DESC LIMIT n`（读历史/整理记忆各一处）
 *      从「索引扫描 + 排序」变成纯反向索引扫描
 *
 * ## 为什么必须用真库测
 *
 * 「加上界不会漏掉该处理的会话」这句话**不能靠读代码相信**。资格判定是
 * `ago < 15min || ago > 60min → 跳过`，只要上界 ≥ 60 分钟就不会漏 ——
 * 但这是推理，不是证据。本脚本在 PGlite 里灌入各种年龄的会话，
 * **同时跑旧查询与新查询**，逐行比对：新查询在「该处理的会话」上必须与旧查询一致。
 *
 * ## 反证（已实测会红）
 *
 *   A 把上界从 JOIN 条件挪到 WHERE（LEFT JOIN 变 INNER）→ 行为比对红
 *   B 把上界改成 10 分钟（小于 60 分钟窗口）→ 漏会话，红
 *   C 删掉复合索引 → 索引存在性红
 *
 * 用法：npx tsx scripts/verify/p2-idle-scan-bounded.mts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const { makePool, migrate } = req('../../apps/server/src/db') as typeof import('../../apps/server/src/db');
type Pool = import('node:pg').Pool;

let pass = 0;
const ok = (name: string): void => {
  pass += 1;
  console.log(`  PASS ${name}`);
};

const repo = (rel: string): string => path.join(path.dirname(new URL(import.meta.url).pathname), '../..', rel);

/**
 * 从**生产代码**导入真值，不在测试里硬拷贝一份。
 * 首版在这里抄了一个 6*60*60*1000，于是「改生产忘改测试」这条路是敞开的；
 * 而最后那条「上界必须 >= 60 分钟」的断言还因此误红过一次
 * （正则只匹配到表达式里的第一个数字 6）。
 */
const { IDLE_SCAN_WINDOW_MS } = req('../../apps/server/src/routes/memories') as typeof import('../../apps/server/src/routes/memories');

/** 旧查询：不设时间上界（原状） */
const OLD_SQL = `SELECT c.id AS conv_id, p.user_id, c.agent_id, MAX(m.id) AS last_id, MAX(m.created_at) AS last_at
   FROM conversations c
   JOIN projects p ON p.id = c.project_id
   LEFT JOIN messages m ON m.conversation_id = c.id
  WHERE COALESCE(c.keepalive, false) = false
  GROUP BY c.id, p.user_id, c.agent_id`;

/** 新查询：时间上界放在 JOIN 条件里（生产口径） */
const NEW_SQL = `SELECT c.id AS conv_id, p.user_id, c.agent_id, MAX(m.id) AS last_id, MAX(m.created_at) AS last_at
   FROM conversations c
   JOIN projects p ON p.id = c.project_id
   LEFT JOIN messages m ON m.conversation_id = c.id AND m.created_at >= $1
  WHERE COALESCE(c.keepalive, false) = false
  GROUP BY c.id, p.user_id, c.agent_id`;

interface Row {
  conv_id: string;
  user_id: string;
  agent_id: string | null;
  last_id: string | null;
  last_at: string | null;
}

/**
 * ★ id 规整助手（2026-09-29 踩坑记录）：
 *   **PGlite 把 BIGINT 返回成 number，而真 `pg` 驱动返回 string。**
 *   同一个查询在两种池子上跑，`r.conv_id === '9'` 一边 true 一边 false。
 *   本脚本用 PGlite，所以**凡是要比 id 的地方一律过这个助手**，
 *   否则断言会以「类型不匹配」这种假理由红掉。
 */
const cid = (r: { conv_id: unknown }): string => String(r.conv_id);

/** 取「该被处理」的行：沿用生产的资格判定（15~60 分钟前有最后消息） */
function eligible(rows: Row[], now: number): Row[] {
  return rows.filter((r) => {
    if (!r.last_id || !r.last_at) return false;
    const ago = now - new Date(r.last_at).getTime();
    return ago >= 15 * 60_000 && ago <= 60 * 60_000;
  });
}

async function main(): Promise<void> {
  const pool = makePool('pglite://memory') as unknown as Pool;
  await migrate(pool);

  const now = Date.now();
  // projects.user_id 非空且外键到 users，先造一个用户
  await pool.query(`INSERT INTO users (id, xyz_id, phone_hash) VALUES (1,'p2-scan','h1') ON CONFLICT (id) DO NOTHING`);

  // 一批项目/会话，最后消息年龄覆盖：窗口内 / 太新 / 太老 / 刚好边界
  const ages = [
    { label: '窗口内 20 分钟', min: 20 },
    { label: '窗口内 15 分钟（下边界）', min: 15 },
    { label: '窗口内 60 分钟（上边界）', min: 60 },
    { label: '太新 5 分钟', min: 5 },
    { label: '太老 3 小时', min: 180 },
    { label: '太老 2 天', min: 2880 },
    { label: '刚好卡在上界外 7 小时', min: 420 },
  ];

  for (const a of ages) {
    const pr = await pool.query<{ id: string }>('INSERT INTO projects (user_id, name) VALUES (1, $1) RETURNING id', [a.label]);
    const pid = Number(pr.rows[0].id);
    const cv = await pool.query<{ id: string }>(
      'INSERT INTO conversations (project_id, agent_id, title) VALUES ($1, NULL, $2) RETURNING id',
      [pid, a.label],
    );
    const cid = Number(cv.rows[0].id);
    const at = new Date(now - a.min * 60_000);
    await pool.query(
      'INSERT INTO messages (conversation_id, role, content_enc, created_at) VALUES ($1, $2, $3, $4)',
      [cid, 'user', 'x', at],
    );
    // 再灌一条更老的，确保 MAX 取的是新那条
    await pool.query(
      'INSERT INTO messages (conversation_id, role, content_enc, created_at) VALUES ($1, $2, $3, $4)',
      [cid, 'assistant', 'y', new Date(at.getTime() - 3 * 60 * 60_000)],
    );
  }

  // 一个 keepalive 会话（应被 WHERE 挡掉，两个查询都不该出现）
  const prk = await pool.query<{ id: string }>('INSERT INTO projects (user_id, name) VALUES (1, $1) RETURNING id', ['keepalive']);
  const cvk = await pool.query<{ id: string }>(
    'INSERT INTO conversations (project_id, agent_id, title, keepalive) VALUES ($1, NULL, $2, true) RETURNING id',
    [Number(prk.rows[0].id), 'keepalive'],
  );
  await pool.query(
    'INSERT INTO messages (conversation_id, role, content_enc, created_at) VALUES ($1, $2, $3, $4)',
    [Number(cvk.rows[0].id), 'user', 'x', new Date(now - 20 * 60_000)],
  );

  // 一个**没有任何消息**的会话（LEFT JOIN 的 NULL 行）
  const pre = await pool.query<{ id: string }>('INSERT INTO projects (user_id, name) VALUES (1, $1) RETURNING id', ['empty']);
  await pool.query('INSERT INTO conversations (project_id, agent_id, title) VALUES ($1, NULL, $2)', [
    Number(pre.rows[0].id),
    'no messages',
  ]);

  const oldRes = await pool.query<Row>(OLD_SQL);
  const newRes = await pool.query<Row>(NEW_SQL, [new Date(now - IDLE_SCAN_WINDOW_MS)]);

  const oldEligible = eligible(oldRes.rows, now);
  const newEligible = eligible(newRes.rows, now);

  // =====================================================================
  // ① 核心：该处理的会话，新旧查询**必须一模一样**
  // =====================================================================
  {
    const key = (r: Row): string => `${cid(r)}|${r.last_id}|${new Date(r.last_at as string).getTime()}`;
    const a = oldEligible.map(key).sort();
    const b = newEligible.map(key).sort();
    assert.deepEqual(
      b,
      a,
      `加上界后漏了/多了该处理的会话：\n  旧(${a.length}): ${a.join(', ')}\n  新(${b.length}): ${b.join(', ')}`,
    );
    assert.ok(a.length >= 3, `样本太少（${a.length}），这条断言没有意义`);
    ok(`★ 该处理的会话新旧查询逐行一致（${a.length} 条：窗口内 20/15/60 分钟都在）`);
  }

  // =====================================================================
  // ② keepalive 会话两个查询都不出现
  // =====================================================================
  {
    const ids = (rows: Row[]): string[] => rows.map(cid).sort();
    const cvkId = String(cvk.rows[0].id);
    assert.ok(!ids(oldRes.rows).includes(cvkId), '旧查询就不该返回 keepalive 会话');
    assert.ok(!ids(newRes.rows).includes(cvkId), 'keepalive 会话被新查询放出来了');
    ok('keepalive 会话两个查询都不返回（上界没有把 WHERE 的语义弄坏）');
  }

  // =====================================================================
  // ③ LEFT JOIN 语义保持 + 上界**只做减法、从不改值**
  //
  // 首版这里断言「NULL 行数量新旧相等」，跑出来 3 !== 1 —— 断言写错了，
  // 但**抓到了一个必须记下来的真实差异**：
  //
  //   加上界后，「所有消息都在窗口外」的会话（如 2 天前那条）从
  //   「带着一个旧 last_id 回来」变成「last_id = NULL」。
  //
  // 这**不是行为变更**：生产里 `if (!row.last_id || !row.last_at) continue;`
  // 把这两种一起跳过，且它们的 ago 也都 > 60 分钟、本来就要跳过。
  // 但原始结果集的形状确实不同，所以这里断言真正重要的两条不变量：
  //   (a) 无消息会话仍是 NULL 行（LEFT JOIN 没被上界弄成 INNER JOIN）
  //   (b) 新查询凡是给出非空 last_id 的行，其 last_id / last_at 必须与旧查询**逐字节相同**
  //       —— 证明上界只会把行降级成 NULL，绝不会把一个值截成另一个值
  // =====================================================================
  {
    const emptyConv = await pool.query<{ id: string }>("SELECT id FROM projects WHERE name = 'empty'");
    const emptyId = String(
      (
        await pool.query<{ id: string }>('SELECT id FROM conversations WHERE project_id = $1', [
          Number(emptyConv.rows[0].id),
        ])
      ).rows[0].id,
    );
    assert.ok(
      newRes.rows.some((r) => cid(r) === emptyId && !r.last_id),
      '无消息的会话必须以 last_id=NULL 出现（LEFT JOIN 语义）',
    );
    ok('LEFT JOIN 语义保持：无消息会话仍是 NULL 行（没被上界弄成 INNER JOIN）');

    const oldById = new Map(oldRes.rows.map((r) => [cid(r), r]));
    let nonNull = 0;
    for (const n of newRes.rows) {
      if (!n.last_id) continue;
      nonNull += 1;
      const o = oldById.get(cid(n));
      assert.ok(o, `新查询多出了会话 ${cid(n)}`);
      assert.equal(n.last_id, o.last_id, `会话 ${cid(n)} 的 last_id 被上界改了：${o.last_id} -> ${n.last_id}`);
      assert.equal(
        new Date(n.last_at as string).getTime(),
        new Date(o.last_at as string).getTime(),
        `会话 ${cid(n)} 的 last_at 被上界改了`,
      );
    }
    assert.ok(nonNull >= 3, '样本太少');
    ok(`上界只做减法：${nonNull} 个非空行的 last_id/last_at 与旧查询逐字节相同（绝不改值）`);
  }

  // =====================================================================
  // ④ MAX 取的是窗口内最新那条（不是被上界截出一个旧值）
  // =====================================================================
  {
    // 「窗口内 20 分钟」那个会话：新消息 20 分钟前、旧消息 3 小时 20 分钟前。
    // 旧消息在上界(6h)之内，所以新旧都应取 20 分钟那条。
    const pr20 = await pool.query<{ id: string }>("SELECT id FROM projects WHERE name = '窗口内 20 分钟'");
    const cv20 = await pool.query<{ id: string }>(
      'SELECT id FROM conversations WHERE project_id = $1',
      [Number(pr20.rows[0].id)],
    );
    const id20 = String(cv20.rows[0].id);
    const o = oldRes.rows.find((r) => cid(r) === id20);
    const n = newRes.rows.find((r) => cid(r) === id20);
    assert.ok(o && n, '找不到样本会话');
    assert.equal(n.last_id, o.last_id, 'MAX(m.id) 变了');
    assert.equal(new Date(n.last_at as string).getTime(), new Date(o.last_at as string).getTime(), 'MAX(created_at) 变了');
    ok('MAX(m.id)/MAX(created_at) 与旧查询一致（上界没有截出一个旧值）');
  }

  // =====================================================================
  // ⑤ 复合索引真的建出来了
  // =====================================================================
  {
    const idx = await pool.query<{ indexname: string; indexdef: string }>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'messages'",
    );
    const names = idx.rows.map((r) => r.indexname);
    assert.ok(
      names.some((n) => n.includes('conversation') && n.includes('id')),
      `messages 上找不到 (conversation_id, id) 复合索引，现有：${names.join(', ')}`,
    );
    const def = idx.rows.find((r) => /conversation_id.*\bid\b/i.test(r.indexdef))?.indexdef ?? '';
    assert.ok(/conversation_id/i.test(def) && /\bid\b/i.test(def), `索引定义不含两列：${def}`);
    ok(`messages 上有 (conversation_id, id) 复合索引：${names.filter((n) => n.includes('conversation')).join(', ')}`);
  }

  // =====================================================================
  // ⑥ 静态：生产查询必须把上界放在 JOIN 条件，不能放 WHERE
  // =====================================================================
  {
    const src = fs.readFileSync(repo('apps/server/src/routes/memories.ts'), 'utf8');
    const q = src.slice(src.indexOf('SELECT c.id AS conv_id'), src.indexOf('GROUP BY c.id'));
    assert.ok(
      /LEFT JOIN messages m ON m\.conversation_id = c\.id AND m\.created_at >= \$1/.test(q),
      `上界必须放在 JOIN 条件里（放 WHERE 会把 LEFT JOIN 变成 INNER JOIN）。实际：\n${q}`,
    );
    assert.ok(!/WHERE[\s\S]*m\.created_at >= \$1/.test(q), '上界不该出现在 WHERE 里');
    assert.ok(/IDLE_SCAN_WINDOW_MS/.test(src), '必须用有名字的常量，不要散落魔法数');
    assert.ok(
      IDLE_SCAN_WINDOW_MS >= 60 * 60_000,
      `上界必须 >= 60 分钟（资格窗口上界），否则会漏会话；实际 ${IDLE_SCAN_WINDOW_MS}ms`,
    );
  }

  // =====================================================================
  // ⑦ CI 与主链**步数口径必须一致**，且用 golden 钉住「CI 少了步骤」
  //
  // 事故（2026-09-29，`6bb7502`）：提交时漏掉了 `.github/workflows/verify.yml` ——
  // 沙箱重置把该文件打回旧版，而恢复时只捞了源码、没捞它。
  // 结果**推送成功、CI 全绿，但 CI 跑的是旧步骤，新测试一步都没进 CI**。
  // 本地 `npm run verify` 是绿的，所以完全看不出来。
  //
  // 首版只断言「CI 跑的每一步都在主链里」+「自称步数 == 主链步数」。
  // 反证跑出来：**删掉 CI 里一步，它不红** —— 子集断言对"少一步"免疫，
  // 而"少一步"正是那次事故的形状。所以改用仓库既有的 **golden 快照**模式
  // （与 app-shell 的 webview-ancestor-chain.golden.json 同一套路）：
  // 快反馈 job 的步骤列表与全链步数，逐项跟 golden 比。
  //
  // 故意加/减步骤时：改完生产文件后跑一次
  //   npx tsx scripts/verify/p2-idle-scan-bounded.mts -- --update-ci-golden
  // 显式更新快照（绝不自动重写）。
  // =====================================================================
  {
    const wf = fs.readFileSync(repo('.github/workflows/verify.yml'), 'utf8');
    const pkg = JSON.parse(fs.readFileSync(repo('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const goldenPath = repo('docs/acceptance/ci-fast-feedback.golden.json');
    const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8')) as {
      fastFeedbackSteps: string[];
      chainStepCount: number;
    };

    const chain = pkg.scripts.verify.split('&&').map((x) => x.trim().replace(/^npm run -s /, ''));

    // 只取 typecheck 那个 job 的步骤（按 job 名定位，别把 release job 的算进来）
    const jobStart = wf.search(/^ {2}typecheck:\s*$/m);
    assert.ok(jobStart >= 0, 'workflow 里找不到 typecheck job');
    const nextJob = wf.slice(jobStart + 1).search(/^ {2}[a-z][a-z0-9_-]*:\s*$/m);
    const jobBlock = wf.slice(jobStart, nextJob === -1 ? undefined : jobStart + 1 + nextJob);
    const ciSteps = [...jobBlock.matchAll(/- run: npm run -s (verify:[a-z0-9:_-]+)/g)].map((m) => m[1]);
    assert.ok(ciSteps.length >= 6, `typecheck job 里的步骤太少（${ciSteps.length}），解析可能错了`);

    // ① CI 跑的每一步都必须真在主链里（防止 CI 跑一个已删掉的步骤）
    for (const step of ciSteps) {
      assert.ok(
        chain.includes(step),
        `CI 在跑 ${step}，但主链里没有它 —— 要么主链漏了这一步，要么 CI 在跑一个已删掉的步骤`,
      );
    }

    // ② 自称步数 == 主链真实步数
    const claimed = /Verify chain \((\d+) steps\)/.exec(wf);
    assert.ok(claimed, 'CI 里找不到「Verify chain (N steps)」这个 job 名');
    assert.equal(
      Number(claimed[1]),
      chain.length,
      `CI 自称 ${claimed?.[1]} 步，实际主链 ${chain.length} 步 —— 加了步骤忘了改名字`,
    );
    assert.equal(claimed?.[1], String(golden.chainStepCount), 'golden 里的 chainStepCount 与 CI 不一致');

    // ③ ★ 关键：**CI 少了一步必须红**（这正是 6bb7502 事故的形状）
    if (process.argv.includes('--update-ci-golden')) {
      const next = { ...golden, fastFeedbackSteps: ciSteps, chainStepCount: chain.length };
      fs.writeFileSync(goldenPath, JSON.stringify(next, null, 2) + '\n');
      ok(`已按当前 CI 更新 golden：${ciSteps.length} 步 / 全链 ${chain.length} 步（请 review 这个 diff）`);
    } else {
      assert.deepEqual(
        ciSteps,
        golden.fastFeedbackSteps,
        `CI 快反馈步骤与 golden 不一致（少了/多了/顺序变了）。\n` +
          `  golden: ${JSON.stringify(golden.fastFeedbackSteps)}\n` +
          `  实际  : ${JSON.stringify(ciSteps)}\n` +
          `  若这是有意变更，跑：npx tsx scripts/verify/p2-idle-scan-bounded.mts -- --update-ci-golden`,
      );
      ok(`CI 快反馈步骤与 golden 逐项一致（${ciSteps.length} 步）；少一步就会红`);
    }
  }

  await pool.end().catch(() => undefined);
  console.log(`\n=== #7 + 怀疑3 验收：${pass} PASS / 0 FAIL ===`);
  console.log('  ① 该处理的会话新旧查询逐行一致（真库比对，不是推理）');
  console.log('  ② keepalive 仍被挡 / ③ LEFT JOIN 语义保持 / ④ MAX 不变');
  console.log('  ⑤ (conversation_id, id) 复合索引已建');
  console.log('  ⑥ 上界在 JOIN 条件里且 ≥ 60 分钟');
}

main().catch((err) => {
  console.error('FATAL', (err as Error).message);
  process.exit(2);
});
