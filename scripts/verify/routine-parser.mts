/**
 * 批次 L 片 1 | routineParser 纯解析 —— 验收(跑**生产代码本身** `parseRoutineIntent`)
 *
 * 要验的事:
 *   ① 两类句式能解析出 { agentName, taskTemplate, triggerType, triggerConfig } + 自动 name/description;
 *   ② 时刻口径:数字/中文数字/时段(下午+12)/点半/N分/只说时段(默认时刻)/完全没说(默认 09:00);
 *   ③ 间隔口径:每N分钟/每N小时/半小时/一小时,<5 分钟拒;
 *   ④ 反证①:问句「怎么设定期任务?」不建;无关键词回落 LLM(= null);
 *   ⑤ 反证②:普通聊天含"每天"不误建;建**智能体**的话不抢(批次 E 的领地);
 *   ⑥ 确定性 + 字段约束(name≤80、description 含原句)。
 *
 * 用法:npx tsx scripts/verify/routine-parser.mts
 */
import assert from 'node:assert/strict';
import { parseRoutineIntent } from '../../apps/server/src/orchestrator/routineParser';

let passes = 0;
let fails = 0;
const log = (...a: unknown[]): void => console.log(a.map(String).join(' '));
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passes += 1;
    log(`  ✓ ${name}`);
  } catch (err) {
    fails += 1;
    log(`  ✗ ${name}`);
    log(`      ${(err as Error).message.split('\n').slice(0, 4).join('\n      ')}`);
  }
}

function dump(r: ReturnType<typeof parseRoutineIntent>): string {
  return r ? JSON.stringify({ agentName: r.agentName, task: r.taskTemplate, type: r.triggerType, cfg: r.triggerConfig, name: r.name }) : 'null';
}

async function main(): Promise<void> {
  log('');
  log('=== 批次 L 片 1 · routineParser 纯解析 验收 ===');
  log('');
  log('--- ① F1 祈使族:让/请/叫/安排 + [名字] + 节奏 + 任务 ---');

  await check('「让运营助手每天9点检查店铺数据」→ cron 09:00,agent=运营助手', () => {
    const r = parseRoutineIntent('让运营助手每天9点检查店铺数据');
    assert.ok(r, dump(r));
    assert.equal(r.agentName, '运营助手');
    assert.equal(r.triggerType, 'cron');
    assert.deepEqual(r.triggerConfig, { hour: 9, minute: 0 });
    assert.equal(r.taskTemplate, '检查店铺数据');
  });

  await check('「请客服每天早上八点处理退款咨询」→ 中文数字 08:00,agent=客服', () => {
    const r = parseRoutineIntent('请客服每天早上八点处理退款咨询');
    assert.ok(r, dump(r));
    assert.equal(r.agentName, '客服');
    assert.deepEqual(r.triggerConfig, { hour: 8, minute: 0 });
    assert.equal(r.taskTemplate, '处理退款咨询');
  });

  await check('「让数据员每天下午3点30汇总本周报表」→ 下午+12 → 15:30', () => {
    const r = parseRoutineIntent('让数据员每天下午3点30汇总本周报表');
    assert.ok(r, dump(r));
    assert.deepEqual(r.triggerConfig, { hour: 15, minute: 30 });
    assert.equal(r.taskTemplate, '汇总本周报表');
  });

  await check('「让夜值凌晨两点巡检服务器日志」→ 02:00', () => {
    const r = parseRoutineIntent('让夜值凌晨两点巡检服务器日志');
    assert.ok(r, dump(r));
    assert.equal(r.agentName, '夜值');
    assert.deepEqual(r.triggerConfig, { hour: 2, minute: 0 });
    assert.equal(r.taskTemplate, '巡检服务器日志');
  });

  await check('「让运营每30分钟刷新一次店铺页面」→ interval 30', () => {
    const r = parseRoutineIntent('让运营每30分钟刷新一次店铺页面');
    assert.ok(r, dump(r));
    assert.equal(r.triggerType, 'interval');
    assert.deepEqual(r.triggerConfig, { intervalMinutes: 30 });
    assert.equal(r.taskTemplate, '刷新一次店铺页面');
  });

  await check('「让采购每90分钟核对一次报价单」→ interval 90', () => {
    const r = parseRoutineIntent('让采购每90分钟核对一次报价单');
    assert.ok(r, dump(r));
    assert.deepEqual(r.triggerConfig, { intervalMinutes: 90 });
  });

  await check('「让仓管每隔一小时检查一次库存」→ interval 60(中文"一小时")', () => {
    const r = parseRoutineIntent('让仓管每隔一小时检查一次库存');
    assert.ok(r, dump(r));
    assert.equal(r.triggerType, 'interval');
    assert.deepEqual(r.triggerConfig, { intervalMinutes: 60 });
  });

  log('');
  log('--- ② F2 节奏起头族(必须紧跟"提醒我/帮我/替我/给我") ---');

  await check('「每天晚上10点半提醒我复盘今天」→ 22:30,agent=null', () => {
    const r = parseRoutineIntent('每天晚上10点半提醒我复盘今天');
    assert.ok(r, dump(r));
    assert.equal(r.agentName, null);
    assert.deepEqual(r.triggerConfig, { hour: 22, minute: 30 });
    assert.equal(r.taskTemplate, '复盘今天');
  });

  await check('「每天9点提醒我喝水」→ 09:00,task=喝水', () => {
    const r = parseRoutineIntent('每天9点提醒我喝水');
    assert.ok(r, dump(r));
    assert.deepEqual(r.triggerConfig, { hour: 9, minute: 0 });
    assert.equal(r.taskTemplate, '喝水');
  });

  await check('「每天中午提醒我喝水」→ 只说"中午" → 默认 12:00(timeDefaulted)', () => {
    const r = parseRoutineIntent('每天中午提醒我喝水');
    assert.ok(r, dump(r));
    assert.deepEqual(r.triggerConfig, { hour: 12, minute: 0 });
    assert.equal(r.timeDefaulted, true);
  });

  await check('「每天晚上提醒我复盘工作」→ 只说"晚上" → 默认 21:00(不是 09:00)', () => {
    const r = parseRoutineIntent('每天晚上提醒我复盘工作');
    assert.ok(r, dump(r));
    assert.deepEqual(r.triggerConfig, { hour: 21, minute: 0 });
    assert.equal(r.timeDefaulted, true);
  });

  await check('「让助手每天检查店铺数据」→ 完全没说时刻 → 默认 09:00,description 如实写"默认"', () => {
    const r = parseRoutineIntent('让助手每天检查店铺数据');
    assert.ok(r, dump(r));
    assert.deepEqual(r.triggerConfig, { hour: 9, minute: 0 });
    assert.equal(r.timeDefaulted, true);
    assert.match(r.description, /默认/);
  });

  log('');
  log('--- ③ name/description 自动生成(身份/名字生成) ---');

  await check('name = 节奏标签·任务(≤80);description = 自然语言创建:原句(≤300)', () => {
    const r = parseRoutineIntent('让运营助手每天9点检查店铺数据');
    assert.ok(r);
    assert.ok(r.name.length > 0 && r.name.length <= 80, `name 超长:${r.name}`);
    assert.match(r.name, /^每天 09:00·检查店铺数据$/);
    assert.ok(r.description.length <= 300);
    assert.match(r.description, /^自然语言创建:让运营助手每天9点检查店铺数据$/);
  });

  await check('确定性:同一句解析两次,结果逐字段一致', () => {
    const a = parseRoutineIntent('请客服每天早上八点处理退款咨询');
    const b = parseRoutineIntent('请客服每天早上八点处理退款咨询');
    assert.deepEqual(a, b);
  });

  log('');
  log('--- ④ 反证①:问句不建、无关键词回落 LLM(= null) ---');

  await check('「怎么设定期任务?」→ null(问句不建)', () => {
    assert.equal(parseRoutineIntent('怎么设定期任务?'), null);
  });

  await check('「如何创建一个例行提醒」→ null', () => {
    assert.equal(parseRoutineIntent('如何创建一个例行提醒'), null);
  });

  await check('「怎么让运营助手每天9点检查数据」→ null(问句挡在 F1 前面,不能因为句里有"让…每天…"就建)', () => {
    assert.equal(parseRoutineIntent('怎么让运营助手每天9点检查数据'), null);
  });

  await check('「让运营助手每天9点检查数据可以吗?」→ null(带"吗"是问句,不是祈使)', () => {
    assert.equal(parseRoutineIntent('让运营助手每天9点检查数据可以吗?'), null);
  });

  await check('「今天天气不错」→ null(无关键词,回落 LLM)', () => {
    assert.equal(parseRoutineIntent('今天天气不错'), null);
  });

  await check('「把这份数据整理一下」→ null(一次性任务,没有节奏,归 LLM/任务流)', () => {
    assert.equal(parseRoutineIntent('把这份数据整理一下'), null);
  });

  log('');
  log('--- ⑤ 反证②:闲聊含"每天"不误建;建智能体的话不抢 ---');

  await check('「我每天早上都喝咖啡」→ null(陈述句,不是设任务)', () => {
    assert.equal(parseRoutineIntent('我每天早上都喝咖啡'), null);
  });

  await check('「每天早上喝咖啡」→ null(句首"每天"但后面不是"提醒我/帮我"族,是闲聊)', () => {
    assert.equal(parseRoutineIntent('每天早上喝咖啡'), null);
  });

  await check('「我们每天9点例会」→ null', () => {
    assert.equal(parseRoutineIntent('我们每天9点例会'), null);
  });

  await check('「你每天几点下班」→ null(问句)', () => {
    assert.equal(parseRoutineIntent('你每天几点下班'), null);
  });

  await check('「建一个销售助手」→ null(批次 E 建智能体的领地,不抢)', () => {
    assert.equal(parseRoutineIntent('建一个销售助手'), null);
  });

  await check('「请建一个每天9点检查数据的助手」→ null(建**智能体**的话,不是建 routine)', () => {
    assert.equal(parseRoutineIntent('请建一个每天9点检查数据的助手'), null);
  });

  await check('「让运营助手检查店铺数据」→ null(没有节奏,不是定时任务)', () => {
    assert.equal(parseRoutineIntent('让运营助手检查店铺数据'), null);
  });

  await check('「让一个每天9点检查数据的助手来」→ null(点名的"智能体"是虚词"一个")', () => {
    assert.equal(parseRoutineIntent('让一个每天9点检查数据的助手来'), null);
  });

  await check('「每分钟检查一次」→ null(< 5 分钟低于 computeNextRun 下限,照建就是骗人)', () => {
    assert.equal(parseRoutineIntent('让巡检每分钟检查一次'), null);
  });

  log('');
  log('--- ⑥ 守卫边界(裸时刻/一次性/误建防线) ---');

  await check('「让X明天9点检查数据」→ null(明天 = 单次,不是定期)', () => {
    assert.equal(parseRoutineIntent('让X明天9点检查数据'), null);
  });

  await check('「让夜值今晚两点巡检」→ null(今晚 = 单次)', () => {
    assert.equal(parseRoutineIntent('让夜值今晚两点巡检'), null);
  });

  await check('「让助手把9点的会取消」→ null(句里的"9点"是任务的一部分,不是节奏)', () => {
    assert.equal(parseRoutineIntent('让助手把9点的会取消'), null);
  });

  await check('「让X9点前交报告」→ null("9点前" = 截止时间,不是日程)', () => {
    assert.equal(parseRoutineIntent('让X9点前交报告'), null);
  });

  await check('「让每天9点的例会改到10点」→ null(改会时间,不是建任务)', () => {
    assert.equal(parseRoutineIntent('让每天9点的例会改到10点'), null);
  });

  await check('「让检查员每天9点核对数据」→ 建(岗位名"检查员"含动词,按名字放行)', () => {
    const r = parseRoutineIntent('让检查员每天9点核对数据');
    assert.ok(r);
    assert.equal(r.agentName, '检查员');
    assert.deepEqual(r.triggerConfig, { hour: 9, minute: 0 });
  });

  await check('「叫小美每半小时看一眼店铺」→ interval 30(动词"叫"也算祈使)', () => {
    const r = parseRoutineIntent('叫小美每半小时看一眼店铺');
    assert.ok(r);
    assert.equal(r.agentName, '小美');
    assert.deepEqual(r.triggerConfig, { intervalMinutes: 30 });
  });

  log('');
  log('=== 结论 ===');
  log(`  ${passes} PASS / ${fails} FAIL`);
  process.exit(fails > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL', (err as Error).message);
  process.exit(2);
});
