/**
 * 收尾 9 | 修 3 真 `kill -9` 测试 —— **被杀 / 被重启的那个进程**（worker）。
 *
 * 它跑的是**生产代码本身**（不是副本、不是逻辑模拟）：
 *   `startLoop` / `advance` / `ingestToolResult`（toolLoop.ts）+
 *   `saveCheckpoint` / `restoreLoops` / `checkpointToSession`（orchestrator/checkpoint.ts）+
 *   真 PGlite 文件库（跨进程重启持久化）+ `llm.ts` 的 mock 模型（`ENABLE_DEV_MOCK_LLM=1`，
 *   生产里真有的那条路径，保证工具调用序列确定：open_url → read_page → stop）。
 *
 * 两种模式（由驱动脚本 `loop-kill9-db.mjs` 分别拉起两个进程）：
 *
 *   run     建循环 → advance 拿到第一个工具调用（open_url）→ **模拟桌面执行**（把
 *           `callId\t工具\turl` 追加进 executed.log —— 这就是"工具被执行"的可计数副作用）
 *           → 写 marker.json（告诉驱动"我已经执行完、结果还没喂回服务端"）
 *           → 睡 5 秒（**这就是 kill 窗口**：工具已执行、结果未落库）。
 *           如果 5 秒后没被杀（驱动出故障时兜底），自己把结果喂回去再退出。
 *
 *   resume  重启后的新进程：`restoreLoops` 从库恢复循环 → 把桌面**手里那份结果**喂回
 *           `advance` → 验历史一致性（回执的 tool_call_id 必须对得上原来那个 callId，
 *           不能是 `call_<step>` 兜底的孤儿）→ 继续把剩下的步走完（read_page → stop）。
 *
 *   ★ 为什么"桌面执行"由 worker 模拟：生产里工具在 Electron 主进程执行，服务端拿不到
 *     执行结果 —— 本测试要的是"**服务端这一侧**在崩溃重启后不得让同一个工具再被执行一次"。
 *     驱动脚本对 executed.log 的断言（open_url 恰好一行）就是端到端的"没被执行第二次"。
 *
 * 用法：node --import tsx scripts/verify/loop-kill9-worker.mts <run|resume> <workdir>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const mode = process.argv[2] as 'run' | 'resume';
const workdir = process.argv[3];
if (mode !== 'run' && mode !== 'resume' || !workdir) {
  console.error('用法：loop-kill9-worker.mts <run|resume> <workdir>');
  process.exit(2);
}
const dbPath = path.join(workdir, 'db');
const executedLog = path.join(workdir, 'executed.log');
const markerPath = path.join(workdir, 'marker.json');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const die = (tag: string, code: number): never => {
  console.log(`${tag}`);
  process.exit(code);
};

/** 记录一次"工具被执行"（生产里发生在桌面，这里按 callId 记账 —— 驱动靠它数执行次数） */
function recordExecution(callId: string, name: string, url: string): void {
  fs.appendFileSync(executedLog, `${callId}\t${name}\t${url}\n`, 'utf8');
}

async function main(): Promise<void> {
  // 生产代码（与 apps/server 完全同一份）
  const { makePool, migrate } = await import('../../apps/server/src/db');
  const { makeCipher } = await import('../../apps/server/src/crypto');
  const { loadEnv } = await import('../../apps/server/src/env');
  const { startLoop, advance, getLoop, restoreLoopFromCheckpoint, setCheckpointDeps } = await import(
    '../../apps/server/src/toolLoop'
  );
  const { restoreLoops } = await import('../../apps/server/src/orchestrator/checkpoint');

  const pool = makePool(`pglite://${dbPath}`);
  await migrate(pool);
  const cipher = makeCipher('a'.repeat(64));
  setCheckpointDeps(pool, cipher);
  const env = loadEnv();
  /** 循环挂在 user 1 上（loop_checkpoints.user_id 有外键）—— 与 task-encryption-pglite 同一套前置数据 */
  await pool.query(`INSERT INTO users (id, xyz_id, phone_hash) VALUES (1,'x1','h1') ON CONFLICT (id) DO NOTHING`);

  if (mode === 'run') {
    const s = startLoop(env, {
      userId: 1,
      agentId: null,
      conversationId: null,
      wcId: null,
      goal: '打开 https://example.com 看天气',
      pageUrl: 'https://example.com',
      state: null,
    });
    const d1 = await advance(env, s, null);
    if (d1.kind !== 'tool') {
      die(`RUN-FAIL first-decision-not-tool kind=${d1.kind}`, 1);
    }
    const call = (d1 as { call: { id: string; name: string; args?: { url?: string } } }).call;
    /**
     * 等「下发前落库」真的写完（生产里那次 save 是 fire-and-forget）。
     * 正常流程：等到 pending_call_id = 这个 callId 才继续（保证验收窗口是稳定的）；
     * 若修 3 被打回去（M1 反证）：等不到就放行 —— 验收会在"pending 没落库"上红，不假绿。
     */
    for (let i = 0; i < 200; i++) {
      const r = await pool.query('SELECT pending_call_id FROM loop_checkpoints WHERE id=$1', [s.id]);
      const row = r.rows && (r.rows as { pending_call_id?: string | null }[])[0];
      if (row && row.pending_call_id === call.id) break;
      await sleep(50);
    }
    // 桌面侧执行这个工具（副作用记账）
    recordExecution(call.id, call.name, call.args?.url ?? '');
    // 告诉驱动：工具已执行、结果**还没**喂回服务端 —— 从这里到结果落库之间就是 kill 窗口
    fs.writeFileSync(
      markerPath,
      JSON.stringify({ loopId: s.id, callId: call.id, tool: call.name, url: call.args?.url ?? '' }),
      'utf8',
    );
    console.log(`RUN-DISPATCHED loop=${s.id} call=${call.id} tool=${call.name}`);
    // kill 窗口（驱动在这 5 秒里 kill -9）
    await sleep(5000);
    // 兜底：没被杀 —— 自己把结果喂回去，证明"不被杀时一切正常"
    const d2 = await advance(env, s, { ok: true, detail: '页面已打开', page: { url: call.args?.url ?? '' } });
    console.log(`SURVIVED after-sleep next-kind=${d2.kind}`);
    process.exit(d2.kind === 'tool' ? 0 : 1);
  }

  // ---- resume：重启后的新进程 ----
  const restored = await restoreLoops(pool, (p) => {
    restoreLoopFromCheckpoint(p);
  }, cipher);
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as {
    loopId: string;
    callId: string;
    tool: string;
    url: string;
  };
  const s = getLoop(marker.loopId);
  if (!s) {
    die(`RESUME-FAIL loop-missing restored=${restored}（崩溃后循环整个丢了）`, 3);
  }
  // 把桌面手里那份结果喂回（就是 kill 前执行完、没来得及落库的那份）
  const d2 = await advance(env, s, { ok: true, detail: '页面已打开', page: { url: marker.url, title: 'Example' } });
  /**
   * ★ 历史一致性：回执的 tool_call_id 必须对得上**原来那个** callId。
   *   修 3 丢了（pendingCallId 没恢复）的话，这里会落一条 `call_<step>` 兜底的**孤儿**回执
   *   —— assistant.tool_calls 与 tool 回执对不上，喂给模型的对话就是自相矛盾的。
   */
  const toolMsgs = s.messages.filter((m: { role?: string }) => m.role === 'tool');
  const lastTool = toolMsgs[toolMsgs.length - 1] as { tool_call_id?: string } | undefined;
  if (!lastTool || lastTool.tool_call_id !== marker.callId) {
    die(
      `RESUME-FAIL receipt-mismatch 期望=${marker.callId} 实际=${lastTool?.tool_call_id ?? '（没有 tool 消息）'}`,
      4,
    );
  }
  /**
   * 把恢复后 + 喂回结果后的 executedToolIds 原样打出来，由驱动断言：
   * 它必须含**原来的 call id**，且里面**不许出现工具名**（名字混进来 = 修 3 的列被污染，
   * 跨重启去重形同虚设 —— 收尾 9 验收抓到的那个缺陷）。
   */
  console.log(`RESUME-EXECUTED ${JSON.stringify((s as { executedToolIds?: string[] }).executedToolIds ?? [])}`);
  if (d2.kind !== 'tool') {
    die(`RESUME-FAIL unexpected-decision kind=${d2.kind}（正常应当继续下一格 read_page）`, 5);
  }
  const call2 = (d2 as { call: { id: string; name: string; args?: { url?: string } } }).call;
  if (call2.id === marker.callId) {
    die(`RESUME-FAIL redispatch-same-call ${call2.id}（同一个 call 被重新下发 = 工具要执行第二次）`, 6);
  }
  // 继续走完剩下的步：执行 read_page → 喂回 → 应当 stop(done)
  recordExecution(call2.id, call2.name, call2.args?.url ?? '');
  const d3 = await advance(env, s, { ok: true, detail: '页面已读取', page: { url: marker.url } });
  if (d3.kind !== 'done') {
    die(`RESUME-FAIL not-done kind=${d3.kind}`, 7);
  }
  console.log(`RESUME-OK restored=${restored} first=${marker.tool} next=${call2.name} final=done`);
  process.exit(0);
}

main().catch((err) => {
  console.error('WORKER-ERROR', (err as Error).message);
  process.exit(1);
});
