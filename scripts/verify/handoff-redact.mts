/**
 * 收尾 8 | `handoffs/*.md` 与 `board.md` **落盘前**过 `redactForStorage` —— 验收。
 *
 * ★ 它测的是**生产代码本身**：直接 import `apps/server/src/orchestrator/handoff.ts`
 *   （`writeHandoffFile` / `appendBoardWithLock` / `updateHandoffStatus`），库是 PGlite
 *   （真 PostgreSQL 编译成 WASM —— board 的 `board_locks` 行锁要真跑），
 *   交接目录用 `HANDOFF_ROOT` 指到临时目录（免得往仓库里写数据）。
 *
 * 验的五件事（为什么是这五件）：
 *   ① **委派文件**：目标 / 输入 / 产出要求 / 审批边界 / 双方名字里的敏感值，落到磁盘上必须是掩码；
 *   ② **board.md**：那一行摘要（`task.slice(0, 80)`）里的敏感值同样不许落盘；
 *   ③ **追加的进度与结论**：`updateHandoffStatus` 的 `extra` 是子循环原样报上来的（最容易夹带），
 *      追加进去的内容也必须已脱敏；
 *   ④ **不许涂花**：正常的人话、路径 `handoff://7/5.md`、时间戳、id 一律原样留着 ——
 *      过度脱敏会让交接文件失去意义（这条是防"为了绿把整段抹掉"）；
 *   ⑤ **口径一致**：同一句话在频道正文（`channels.ts`）里怎么被抹，在交接文件里就该怎么被抹
 *      （直接对拍两个函数的输出，防止两边各写一套）。
 *
 * 反证：`scripts/verify/handoff-redact-revert-proof.py`（把三处脱敏任一处拆掉 → 本脚本必须红）。
 * 用法：npx tsx scripts/verify/handoff-redact.mts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { makePool, migrate } from '../../apps/server/src/db';
import { redactForStorage } from '../../apps/server/src/orchestrator/redact';
import {
  writeHandoffFile,
  readHandoffFile,
  readBoard,
  appendBoardWithLock,
  updateHandoffStatus,
  getHandoffDir,
  getHandoffPath,
} from '../../apps/server/src/orchestrator/handoff';

let passes = 0;
let fails = 0;
const log = (...a: unknown[]): void => console.log(a.map(String).join(' '));
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passes += 1;
      log(`  ✓ ${name}`);
    })
    .catch((err: unknown) => {
      fails += 1;
      log(`  ✗ ${name}`);
      log(`      ${(err as Error).message.split('\n').slice(0, 4).join('\n      ')}`);
    });
}

/** 敏感样本（每条对应掩码表里的一个形态；都是**真会被用户/模型写进任务里**的写法） */
const SAMPLES = {
  password: '密码是 Zx9!secret',
  card: '银行卡 6222 0212 3456 7890',
  idcard: '身份证 110101199003071234',
  otp: '验证码 8421',
  longdigits: '订单号 1234567890123456789012345',
} as const;

/** 这些值的**原文**一个都不许出现在磁盘上 */
const FORBIDDEN: string[] = [
  'Zx9!secret',
  '6222 0212 3456 7890',
  '6222021234567890',
  '110101199003071234',
  '1234567890123456789012345',
];

async function main(): Promise<void> {
  /** 临时交接目录：绝不往仓库 data/ 里写 */
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-redact-'));
  process.env.HANDOFF_ROOT = root;
  const PROJECT = 77;

  log('');
  log('=== 收尾 8 · 交接文件与 board 落盘前的脱敏 ===');
  log(`（临时交接目录：${root}）`);

  const pool = makePool('pglite://memory') as unknown as Pool;
  await migrate(pool);
  /**
   * `board_locks.project_id` 有外键（锁行必须挂在真项目上）—— 先建账号与项目。
   * 这不是"为了让测试过"：生产里锁行本来就是在真项目上开的，桩库也要给同一形状。
   */
  await pool.query(`INSERT INTO users (id, xyz_id, phone_hash) VALUES (1,'x1','h1') ON CONFLICT (id) DO NOTHING`);
  await pool.query(
    `INSERT INTO projects (id, user_id, name, is_default) VALUES ($1,1,'脱敏验收项目',true) ON CONFLICT (id) DO NOTHING`,
    [PROJECT],
  );

  // ------------------------------------------------------------------ ①
  log('');
  log('--- ① 委派文件：目标 / 输入 / 产出要求 / 审批边界 / 双方名字 ---');
  await check('五个字段里的敏感值都落成了掩码，原文一个字都不在文件里', () => {
    const file = writeHandoffFile(PROJECT, 5, {
      delegationId: 5,
      jobId: 'job-1',
      projectId: PROJECT,
      fromAgentId: 97,
      fromAgentName: '小助（密码是 Zx9!secret）',
      toAgentId: 98,
      toAgentName: '卡布',
      goal: `帮我把这个号绑一下：${SAMPLES.card}`,
      input: `账号资料：${SAMPLES.idcard}`,
      outputRequire: `核对完回我一句就行；${SAMPLES.longdigits}`,
      approvalBoundary: `不许外发；${SAMPLES.password}`,
      status: 'running',
      createdAt: '2026-09-25T00:00:00.000Z',
      deadlineAt: '2026-09-25T01:00:00.000Z',
    });
    const text = fs.readFileSync(file, 'utf8');
    for (const bad of FORBIDDEN) {
      assert.ok(!text.includes(bad), `磁盘上是原文！交接文件里出现了「${bad}」`);
    }
    assert.match(text, /\[已脱敏·card·\d+字\]/, '银行卡那条没被抹（掩码格式应与 redactForStorage 一致）');
    /**
     * ★ 18 位身份证在掩码表里会**先被 `card` 吃掉**（card 覆盖 13~20 位，`idcard` 只兜 18 位带 X 的写法）——
     *   所以这里钉的是"值没了 + 有一位数掩码"，具体 tag 由共享的 redact 模块决定（那边有自己的验收）。
     */
    assert.match(text, /\[已脱敏·(?:card|idcard)·18字\]/, '身份证那串没被抹成 18 字掩码');
    assert.match(text, /\[已脱敏·password·\d+字\]/, '密码那条没被抹');
    assert.match(text, /\[已脱敏·longdigits·\d+字\]/, '超长数字串那条没被抹');
    // 读回来的接口也要拿到同一份（别让"读"走另一条路）
    assert.equal(readHandoffFile(PROJECT, 5), text, 'readHandoffFile 读到的与文件不一致');
  });

  await check('★ 不许涂花：正常的人话 / 路径 / id / 时间戳原样留着', () => {
    const text = readHandoffFile(PROJECT, 5) ?? '';
    assert.match(text, /帮我把这个号绑一下/, '正常的目标描述被涂掉了（过度脱敏 = 交接文件失去意义）');
    assert.match(text, /- delegationId: 5/, 'delegationId 被涂了');
    assert.match(text, /- 去向: 卡布 \(#98\)/, '去向的名字/id 被涂了');
    assert.match(text, /- 创建: 2026-09-25T00:00:00\.000Z/, '时间戳被涂了');
    assert.match(text, /handoff:\/\/77\/5\.md/, '路径（委派消息只传它）被涂了');
  });

  // ------------------------------------------------------------------ ②
  log('');
  log('--- ② board.md：那一行摘要是用户原话的截断，同样不许带原文 ---');
  await check('board 追加行里的敏感值已脱敏，结构（时间 / #id / A→B / 路径）还在', async () => {
    await appendBoardWithLock(
      pool,
      PROJECT,
      97,
      `- [2026-09-25T00:00:00.000Z] #5 小助→卡布: 帮我把这个号绑一下：${SAMPLES.card} (handoff://${PROJECT}/5.md)`,
    );
    const board = readBoard(PROJECT);
    for (const bad of FORBIDDEN) {
      assert.ok(!board.includes(bad), `board.md 里是原文：「${bad}」`);
    }
    assert.match(board, /\[已脱敏·card·\d+字\]/, 'board 那行没被抹');
    assert.match(board, /#项目 77 交接板|# 项目 77 交接板/, 'board 的表头结构没了');
    assert.match(board, /小助→卡布/, 'board 那行的人名结构没了（过度脱敏）');
    assert.match(board, /\(handoff:\/\/77\/5\.md\)/, 'board 那行的路径没了（过度脱敏）');
  });

  // ------------------------------------------------------------------ ③
  log('');
  log('--- ③ 追加的进度 / 结论：子循环原样报上来的那一串 ---');
  await check('进度与结论里的敏感值都脱敏了，状态行本身照旧可读', () => {
    updateHandoffStatus(PROJECT, 5, 'running', `进度 3: 已经拿到 ${SAMPLES.idcard}`);
    updateHandoffStatus(PROJECT, 5, 'done', `结论：可以绑，用的验证码 8421`);
    const text = readHandoffFile(PROJECT, 5) ?? '';
    for (const bad of FORBIDDEN) {
      assert.ok(!text.includes(bad), `追加内容里是原文：「${bad}」`);
    }
    assert.ok(!text.includes('8421'), '「验证码 8421」的值还在（otp 那条没被抹）');
    assert.match(text, /\[已脱敏·(?:card|idcard)·18字\]/, '追加的身份证没被抹');
    assert.match(text, /- 状态: done/, '状态行没被正确更新（脱敏把它一起改掉了？）');
    assert.match(text, /## 更新 20\d\d-/, '追加段落的时间戳没了');
  });

  // ------------------------------------------------------------------ ④
  log('');
  log('--- ④ 口径一致：同一句话，频道正文与交接文件的脱敏结果必须一样 ---');
  await check('对拍 redactForStorage：交接文件里的掩码与它逐字一致', () => {
    const sample = `帮我把这个号绑一下：${SAMPLES.card}，${SAMPLES.longdigits}，还有 ${SAMPLES.password}`;
    const expected = redactForStorage(sample);
    writeHandoffFile(PROJECT, 6, {
      delegationId: 6,
      projectId: PROJECT,
      fromAgentId: 97,
      fromAgentName: '小助',
      toAgentId: 98,
      toAgentName: '卡布',
      goal: sample,
      status: 'running',
      createdAt: '2026-09-25T00:00:00.000Z',
    });
    const text = readHandoffFile(PROJECT, 6) ?? '';
    assert.ok(
      text.includes(expected),
      `交接文件里的那段与 redactForStorage 的输出不一致（两边各写了一套？）\n      期望包含：${expected}`,
    );
  });

  // ------------------------------------------------------------------ ⑤
  log('');
  log('--- ⑤ 目录与文件确实落在 HANDOFF_ROOT 下（别写进仓库） ---');
  await check('交接目录就是临时目录，仓库 data/ 里没有多出东西', () => {
    assert.ok(getHandoffDir(PROJECT).startsWith(root), `交接目录没走 HANDOFF_ROOT：${getHandoffDir(PROJECT)}`);
    assert.ok(fs.existsSync(getHandoffPath(PROJECT, 5)), '委派文件没写出来');
    assert.ok(!path.resolve(getHandoffDir(PROJECT)).includes(path.join('apps', 'server', 'data')), '写进仓库 data/ 了');
  });

  log('');
  log('=== 结论 ===');
  log(`  ${passes} PASS / ${fails} FAIL`);
  fs.rmSync(root, { recursive: true, force: true });
  await pool.end().catch(() => undefined);
  process.exit(fails > 0 ? 1 : 0);
}

void main();
