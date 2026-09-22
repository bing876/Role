/**
 * 多智能体编排 · S3 验收：**后台子任务登记表**（生命周期 / 上限 / 超时 / 名额）。
 *
 * 要证明的事（每一条都对着用户提的安全要求）：
 *   ① 生命周期：创建 → 有结果 → **只投递一次** → 从表里彻底消失（= 临时工「用完即销毁」）；
 *   ② 超时熔断：到点自动 `cancel('timeout')`、`done` 被 resolve、计数 +1 —— **不会永久挂着**；
 *   ③ 上限：全局 job 上限拒收（费用闸）；每循环累计计数在 job 删除后**仍然保留**（上限是「累计」）；
 *   ④ 名额闸（用户要求 1）：正在等结果的智能体查得到、释放得掉；
 *      且「迟到的超时」不会把**新一次**委派的名额误放掉（带 delegationId 才释放）；
 *   ⑤ 并发面：一个智能体同时接的活数进出正确；
 *   ⑥ 级联取消：发起方循环被停 → 它名下的 job 全被取消（不留后台烧 token）。
 *
 * 纯内存、毫秒级，不碰库、不碰网络。
 * 用法：npx tsx scripts/verify/orc-registry.mts
 */
import assert from 'node:assert/strict';
import {
  DELEGATE_TIMEOUT_MS_MAX,
  DELEGATE_TIMEOUT_MS_MIN,
  ORCH_DEFAULTS,
  resolveOrchestratorEnv,
} from '../../apps/server/src/env';
import {
  agentBusyCount,
  cancelJobsOfAgent,
  cancelJobsOfLoop,
  clearAgentBusy,
  clearAgentWaiting,
  createJob,
  getJob,
  initRegistry,
  isAgentWaiting,
  jobOfLoop,
  jobStats,
  liveJobCount,
  loopWorkerCount,
  markAgentBusy,
  markAgentWaiting,
  markResultReady,
  resetRegistryForTest,
  slotSnapshot,
  waitingAgentDelegation,
  type CreateJobInput,
} from '../../apps/server/src/orchestrator/registry';

let fails = 0;
let passes = 0;
const log = (...a: string[]) => console.log(a.map(String).join(' '));
const check = (name: string, fn: () => void | Promise<void>) =>
  Promise.resolve()
    .then(fn)
    .then(() => {
      passes += 1;
      log(`  PASS ${name}`);
    })
    .catch((err) => {
      fails += 1;
      log(`  ★FAIL ${name}  —— ${(err as Error)?.message ?? String(err)}`);
    });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 造一个 job 的最小入参（onCancel 由用例自己给，好断言「谁被取消了」） */
function jobInput(over: Partial<CreateJobInput> = {}): CreateJobInput {
  return {
    kind: 'workers',
    userId: 1,
    projectId: 1,
    ownerLoopId: 'loop_a',
    ownerAgentId: 11,
    budgetMs: 60_000,
    workerCount: 3,
    onCancel: () => undefined,
    ...over,
  };
}

async function main(): Promise<void> {
  log('=== 多智能体编排 · S3 登记表验收 ===');

  // ---------------------------------------------------------------- ① 配置解析
  log('');
  log('--- ① 配置解析（默认值 + 夹逼，配歪了也不能变成「无限等」） ---');
  await check('一个环境变量都不写 = 全套默认值', () => {
    assert.deepEqual(resolveOrchestratorEnv({}), ORCH_DEFAULTS);
    assert.equal(ORCH_DEFAULTS.delegateTimeoutMs, 600_000, '委派超时默认必须是 10 分钟（用户拍板）');
  });
  await check('DELEGATE_TIMEOUT_MS 配成 2 秒被夹到下限（不会 1 秒就熔断）', () => {
    assert.equal(resolveOrchestratorEnv({ DELEGATE_TIMEOUT_MS: '2000' }).delegateTimeoutMs, DELEGATE_TIMEOUT_MS_MIN);
  });
  await check('DELEGATE_TIMEOUT_MS 配成天文数字被夹到 30 分钟（不会无限等）', () => {
    assert.equal(
      resolveOrchestratorEnv({ DELEGATE_TIMEOUT_MS: '999999999' }).delegateTimeoutMs,
      DELEGATE_TIMEOUT_MS_MAX,
    );
  });
  await check('一票否决开关 ORCHESTRATION_TOOLS=0 生效', () => {
    assert.equal(resolveOrchestratorEnv({ ORCHESTRATION_TOOLS: '0' }).enabled, false);
    assert.equal(resolveOrchestratorEnv({ ORCHESTRATION_TOOLS: '1' }).enabled, true);
  });
  await check('WORKER_MAX_SEARCH_ROUNDS=0 是合法值（= 纯推理不联网，不吃默认 2）', () => {
    assert.equal(resolveOrchestratorEnv({ WORKER_MAX_SEARCH_ROUNDS: '0' }).workerMaxSearchRounds, 0);
    assert.equal(resolveOrchestratorEnv({}).workerMaxSearchRounds, 2);
  });
  await check('AGENT_LOOP_WEB_SEARCH=0 关掉主循环的搜索（唯一的行为变更项可回滚）', () => {
    assert.equal(resolveOrchestratorEnv({ AGENT_LOOP_WEB_SEARCH: '0' }).agentLoopWebSearch, false);
    assert.equal(resolveOrchestratorEnv({}).agentLoopWebSearch, true);
  });
  await check('上限类配成 0/负数/垃圾一律回落默认值', () => {
    const r = resolveOrchestratorEnv({ ORCH_MAX_LIVE_JOBS: '0', WORKER_MAX_PER_CALL: '-3', WORKER_CONCURRENCY: 'abc' });
    assert.equal(r.maxLiveJobs, ORCH_DEFAULTS.maxLiveJobs);
    assert.equal(r.workerMaxPerCall, ORCH_DEFAULTS.workerMaxPerCall);
    assert.equal(r.workerConcurrency, ORCH_DEFAULTS.workerConcurrency);
  });

  // ---------------------------------------------------------------- ② 生命周期
  log('');
  log('--- ② 生命周期：创建 → 投递一次 → 彻底销毁 ---');
  resetRegistryForTest();
  initRegistry({ ...ORCH_DEFAULTS });

  const cancelCalls: string[] = [];
  const created = createJob(jobInput({ onCancel: (r) => cancelCalls.push(r) }));
  await check('创建成功且登记在册', () => {
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error('createJob 失败了');
    assert.equal(liveJobCount(), 1);
    assert.equal(getJob(created.job.id)?.kind, 'workers');
    assert.equal(jobStats().workersSpawned, 3, 'workersSpawned 要按派出的人数累计');
  });
  await check('发起方循环能查到自己挂着的 job（GET /agent/loop/job 的依据）', () => {
    if (!created.ok) throw new Error('no job');
    assert.equal(jobOfLoop('loop_a')?.id, created.job.id);
  });
  await check('markResultReady 第一次 true、第二次 false（**只投递一次**，防重复回执）', () => {
    if (!created.ok) throw new Error('no job');
    assert.equal(markResultReady(created.job.id), true);
    assert.equal(markResultReady(created.job.id), false);
  });
  await check('完成后 job 从表里彻底消失（临时工「用完即销毁」）+ 循环不再挂着', async () => {
    if (!created.ok) throw new Error('no job');
    await created.job.done; // 结束即 resolve —— 子循环 runner 就靠它
    assert.equal(getJob(created.job.id), null);
    assert.equal(liveJobCount(), 0);
    assert.equal(jobOfLoop('loop_a'), null);
    assert.deepEqual(cancelCalls, [], '正常完成不该触发取消动作');
  });

  // ---------------------------------------------------------------- ③ 超时熔断
  log('');
  log('--- ③ 超时熔断（用户要求 2：不能卡死） ---');
  resetRegistryForTest();
  initRegistry({ ...ORCH_DEFAULTS });
  {
    const cancels: string[] = [];
    const c = createJob(jobInput({ budgetMs: 1_000, onCancel: (r) => cancels.push(r) }));
    if (!c.ok) throw new Error('createJob 失败');
    let resolved = false;
    void c.job.done.then(() => {
      resolved = true;
    });
    await check('到点自动 cancel("timeout") + done 被 resolve + 计数 +1', async () => {
      assert.equal(cancels.length, 0, '还没到点不该取消');
      await sleep(1_300);
      assert.deepEqual(cancels, ['timeout']);
      assert.equal(resolved, true, 'done 必须 resolve —— 否则等它的人会永久挂着');
      assert.equal(jobStats().timeouts, 1);
      assert.equal(liveJobCount(), 0, '超时后 job 必须离表');
    });
    await check('超时后再 markResultReady 返回 false（迟到的结果不会伪造回执）', () => {
      assert.equal(markResultReady(c.job.id), false);
    });
  }

  // ---------------------------------------------------------------- ④ 上限
  log('');
  log('--- ④ 上限（费用闸） ---');
  resetRegistryForTest();
  initRegistry({ ...ORCH_DEFAULTS, maxLiveJobs: 2 });
  await check('全局 job 上限到了就拒收 too_many_jobs', () => {
    assert.equal(createJob(jobInput({ ownerLoopId: 'l1' })).ok, true);
    assert.equal(createJob(jobInput({ ownerLoopId: 'l2' })).ok, true);
    const third = createJob(jobInput({ ownerLoopId: 'l3' }));
    assert.equal(third.ok, false);
    if (!third.ok) assert.equal(third.reason, 'too_many_jobs');
  });
  await check('每循环累计计数在 job 删除后仍然保留（上限是「累计」不是「并发」）', () => {
    resetRegistryForTest();
    initRegistry({ ...ORCH_DEFAULTS });
    const a = createJob(jobInput({ ownerLoopId: 'lx', workerCount: 5 }));
    const b = createJob(jobInput({ ownerLoopId: 'lx', workerCount: 2 }));
    assert.equal(loopWorkerCount('lx'), 2, '两次 spawn_workers 调用');
    if (a.ok) markResultReady(a.job.id);
    if (b.ok) markResultReady(b.job.id);
    assert.equal(liveJobCount(), 0);
    assert.equal(loopWorkerCount('lx'), 2, 'job 已销毁，累计计数必须还在');
    assert.equal(jobStats().workersSpawned, 7, '5 + 2 个临时工');
  });

  // ---------------------------------------------------------------- ⑤ 名额闸
  log('');
  log('--- ⑤ 名额闸（用户要求 1：等结果的智能体不能被拉去处理新委派） ---');
  resetRegistryForTest();
  initRegistry({ ...ORCH_DEFAULTS });
  await check('登记「在等」后查得到，且记得是哪一次委派', () => {
    assert.equal(isAgentWaiting(21), false);
    markAgentWaiting(21, 1001);
    assert.equal(isAgentWaiting(21), true);
    assert.equal(waitingAgentDelegation(21), 1001);
    assert.deepEqual(slotSnapshot().waiting, [21]);
  });
  await check('带 delegationId 的释放只放开**那一次**（迟到的超时不会误放新名额）', () => {
    // 22 先等 2001，2001 有了结果、它又发起了 2002 —— 名额表现在记的是 2002
    markAgentWaiting(22, 2001);
    markAgentWaiting(22, 2002);
    assert.equal(waitingAgentDelegation(22), 2002);
    // 这时 2001 的超时才姗姗来迟 —— 不许把 2002 的名额放掉
    clearAgentWaiting(22, 2001);
    assert.equal(isAgentWaiting(22), true, '迟到释放必须被忽略');
    assert.equal(waitingAgentDelegation(22), 2002, '在等的仍是新那一次');
    // 对上号了才释放
    clearAgentWaiting(22, 2002);
    assert.equal(isAgentWaiting(22), false);
  });
  await check('不带 delegationId = 无条件释放（用户叫停 / 循环作废走这条）', () => {
    markAgentWaiting(23, 3001);
    clearAgentWaiting(23);
    assert.equal(isAgentWaiting(23), false);
  });
  await check('被委派方名额进出正确（并发面：一个智能体同时只接 N 件）', () => {
    assert.equal(agentBusyCount(31), 0);
    markAgentBusy(31);
    assert.equal(agentBusyCount(31), 1);
    markAgentBusy(31);
    assert.equal(agentBusyCount(31), 2);
    clearAgentBusy(31);
    assert.equal(agentBusyCount(31), 1);
    clearAgentBusy(31);
    assert.equal(agentBusyCount(31), 0);
    clearAgentBusy(31); // 多放一次不该变负数
    assert.equal(agentBusyCount(31), 0);
    assert.deepEqual(slotSnapshot().busy, []);
  });

  // ---------------------------------------------------------------- ⑥ 级联取消
  log('');
  log('--- ⑥ 级联取消（用户按「停」不能把子任务留在后台烧 token） ---');
  resetRegistryForTest();
  initRegistry({ ...ORCH_DEFAULTS });
  {
    const cancels: string[] = [];
    createJob(jobInput({ ownerLoopId: 'stopme', ownerAgentId: 41, onCancel: (r) => cancels.push(`loop:${r}`) }));
    createJob(
      jobInput({ ownerLoopId: 'other', ownerAgentId: 42, kind: 'delegate', workerCount: 0, onCancel: (r) => cancels.push(`other:${r}`) }),
    );
    await check('cancelJobsOfLoop 只取消那一条循环名下的', () => {
      assert.equal(cancelJobsOfLoop('stopme', 'user_stop'), 1);
      assert.deepEqual(cancels, ['loop:user_stop']);
      assert.equal(liveJobCount(), 1, '别的路的 job 不受影响');
    });
    await check('cancelJobsOfAgent 取消该智能体名下（作为发起方）的全部', () => {
      assert.equal(cancelJobsOfAgent(42, 'agent_stop'), 1);
      assert.equal(liveJobCount(), 0);
      assert.deepEqual(cancels, ['loop:user_stop', 'other:agent_stop']);
    });
  }

  log('');
  log('=== 结论 ===');
  log(`  ${passes} PASS / ${fails} FAIL`);
  if (fails > 0) process.exitCode = 1;
}

void main();
