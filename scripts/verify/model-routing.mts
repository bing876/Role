/**
 * 批次 I + 收尾 7 | 模型自动路由 —— 验收（跑**生产代码本体**，不是源码文本、不是 mock）
 * ==================================================================================
 *
 *   npm run verify:routing        （已挂进 npm run verify 主链的 verify:batches 里）
 *
 * ★ 为什么整份重写（2026-09-24，收尾 7）：
 *   旧版这份脚本干了两件不该干的事 ——
 *     ① 只 `readFileSync` + `includes('getModelForTask')`，即「源码里出现过这个名字」就算过；
 *     ② 「确定性路由」那条反证用的是脚本里自己写的 `mockGetModel()`，
 *        **测的是副本**，产品代码怎么改它都绿。
 *   结果就是批次 I 的空转没被验出来：`case 'chat'` 的简单/复杂两个分支 `model` 都返回 `chatModel`，
 *   只有 `reason` 写着「路由到推理模型」—— 日志像路由了，实际一次都没换过模型。
 *   用户 2026-09-24 拍板「真路由」，这份脚本随之改成 import 真的 `getModelForTask` 逐个断言。
 *
 * ★ 断言口径：一律比对**返回的 model / reason 字段**，不看源码里有没有某个字符串
 *   （接线那两条除外，它们本来就只验「谁调谁」，并且写清了为什么只能这么验）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getModelForTask, inferTaskKindFromTag } from '../../apps/server/src/modelRouter';
import type { ModelConfig, TaskKind } from '../../apps/server/src/modelRouter';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passes = 0;
let fails = 0;
const log = (...a: unknown[]) => console.log(a.map(String).join(' '));

function check(label: string, fn: () => void): void {
  try {
    fn();
    passes += 1;
    log(`  PASS ${label}`);
  } catch (err) {
    fails += 1;
    log(`  ★FAIL ${label}  —— ${(err as Error).message}`);
  }
}

/** 只造路由真正读的三格（ServerEnv 其余字段与本模块无关；用 as never 免掉整份 env 的构造） */
const ENV = { deepseekApiKey: 'sk-test', deepseekBaseUrl: 'https://api.example', deepseekModel: 'deepseek-chat' } as never;

/** 环境变量是进程级的：每段用完必须还原，否则后面的段会被前面污染（假绿/假红都从这里来） */
const ROUTING_VARS = [
  'MODEL_ROUTING_ENABLED',
  'DEEPSEEK_MODEL_CHAT',
  'DEEPSEEK_MODEL_CHAT_COMPLEX',
  'DEEPSEEK_MODEL_TOOL',
  'DEEPSEEK_MODEL_EXTRACT',
  'DEEPSEEK_MODEL_SEARCH',
  'DEEPSEEK_MODEL_WORKER',
  'DEEPSEEK_MODEL_DELEGATE',
];
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved = ROUTING_VARS.map((k) => [k, process.env[k]] as const);
  try {
    for (const k of ROUTING_VARS) delete process.env[k];
    for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const SIMPLE = '你好';
const COMPLEX = '帮我分析这组数据并出一份报告';
const PLAIN = '今天天气怎么样啊';
const route = (kind: TaskKind, text?: string): ModelConfig => getModelForTask(ENV, kind, text) as ModelConfig;

log('=== 批次 I · 模型自动路由（收尾 7：简单/复杂真路由）===');

// ------------------------------------------------------------------ ① 真路由：两者必须选出不同的模型
log('');
log('--- ① 配了 DEEPSEEK_MODEL_CHAT_COMPLEX → 简单与复杂**真的**走不同模型（这条就是「空转」的反面）---');
withEnv({ DEEPSEEK_MODEL_CHAT: 'fast-chat', DEEPSEEK_MODEL_CHAT_COMPLEX: 'deep-reasoner' }, () => {
  const s = route('chat', SIMPLE);
  const c = route('chat', COMPLEX);
  const p = route('chat', PLAIN);
  log(`      简单「${SIMPLE}」→ ${s.model}（${s.reason}）`);
  log(`      复杂「${COMPLEX}」→ ${c.model}（${c.reason}）`);
  log(`      其余「${PLAIN}」→ ${p.model}（${p.reason}）`);
  check('①-1：简单闲聊走 DEEPSEEK_MODEL_CHAT', () => assert.equal(s.model, 'fast-chat'));
  check('①-2：★复杂闲聊走 DEEPSEEK_MODEL_CHAT_COMPLEX（不是同一个模型 —— 旧代码这里返回的还是 CHAT）', () => {
    assert.equal(c.model, 'deep-reasoner');
  });
  check('①-3：两者选出的 model **不相等**（把「空转」直接写成断言）', () => {
    assert.notEqual(s.model, c.model, '简单与复杂选出了同一个模型：路由是空的');
  });
  check('①-4：既不简单也不复杂的闲聊仍走 CHAT（不误判成复杂去烧贵模型）', () => {
    assert.equal(p.model, 'fast-chat');
    assert.equal(p.reason, '简单闲聊，路由到快速模型'); // 8 字 < 10 → 判定为简单
  });
  check('①-5：reason 与实际选出的模型一致（说「推理模型」就真的换了，不许嘴上路由）', () => {
    assert.match(c.reason, /推理模型/);
    assert.notEqual(c.model, s.model);
  });
  check('①-6：路由不许顺手改密钥与地址（三格都原样透传）', () => {
    for (const r of [s, c, p]) {
      assert.equal(r.apiKey, 'sk-test');
      assert.equal(r.baseUrl, 'https://api.example');
      assert.equal(r.taskKind, 'chat');
    }
  });
});

// ------------------------------------------------------------------ ② 没配 complex：如实回落
log('');
log('--- ② 没配 DEEPSEEK_MODEL_CHAT_COMPLEX → 回落到 CHAT，且 reason **如实说回落** ---');
withEnv({ DEEPSEEK_MODEL_CHAT: 'fast-chat' }, () => {
  const c = route('chat', COMPLEX);
  log(`      复杂 → ${c.model}（${c.reason}）`);
  check('②-1：回落到 CHAT（没有第二个模型可用时唯一诚实的行为，且不报错）', () => assert.equal(c.model, 'fast-chat'));
  check('②-2：★reason 不许再声称「路由到推理模型」（那就是本批要修的空转）', () => {
    assert.ok(!/路由到推理模型/.test(c.reason), `reason 还在撒谎：${c.reason}`);
    assert.match(c.reason, /未配 DEEPSEEK_MODEL_CHAT_COMPLEX/);
    assert.match(c.reason, /回落/);
  });
});
withEnv({ DEEPSEEK_MODEL_CHAT: '   ', DEEPSEEK_MODEL_CHAT_COMPLEX: '  ' }, () => {
  const c = route('chat', COMPLEX);
  const s = route('chat', SIMPLE);
  check('②-3：环境变量是空白串等于没配（trim 后为空 → 回落 env.deepseekModel，不会把空格当模型名发出去）', () => {
    assert.equal(c.model, 'deepseek-chat');
    assert.equal(s.model, 'deepseek-chat');
  });
});

// ------------------------------------------------------------------ ③ 确定性
log('');
log('--- ③ 确定性：同一任务类型 + 同一正文，连续调用结果完全一致 ---');
withEnv({ DEEPSEEK_MODEL_CHAT: 'fast-chat', DEEPSEEK_MODEL_CHAT_COMPLEX: 'deep-reasoner' }, () => {
  const runs = Array.from({ length: 5 }, () => JSON.stringify(route('chat', COMPLEX)));
  const runsSimple = Array.from({ length: 5 }, () => JSON.stringify(route('chat', SIMPLE)));
  check('③-1：复杂闲聊连跑 5 次，model/reason 逐次相同（不许轮询、不许随机）', () => {
    assert.equal(new Set(runs).size, 1, runs.join(' | '));
  });
  check('③-2：简单闲聊同样稳定', () => assert.equal(new Set(runsSimple).size, 1));
  check('③-3：与正文无关的任务类型（tool）不看正文，同 kind 恒定', () => {
    assert.equal(route('tool', '分析').model, route('tool', '你好').model);
  });
});

// ------------------------------------------------------------------ ④ 其余任务类型各走自己的变量
log('');
log('--- ④ 其余任务类型各走自己的环境变量；没配则回落 env.deepseekModel ---');
withEnv(
  {
    DEEPSEEK_MODEL_CHAT: 'm-chat',
    DEEPSEEK_MODEL_TOOL: 'm-tool',
    DEEPSEEK_MODEL_EXTRACT: 'm-extract',
    DEEPSEEK_MODEL_SEARCH: 'm-search',
    DEEPSEEK_MODEL_WORKER: 'm-worker',
    DEEPSEEK_MODEL_DELEGATE: 'm-delegate',
  },
  () => {
    const want: Array<[TaskKind, string]> = [
      ['tool', 'm-tool'],
      ['extract', 'm-extract'],
      ['search', 'm-search'],
      ['worker', 'm-worker'],
      ['delegate', 'm-delegate'],
    ];
    log(`      ${want.map(([k, m]) => `${k}=${route(k, 'x').model}(${m})`).join('  ')}`);
    check('④-1：每一类都走自己的变量（互不串号）', () => {
      for (const [k, m] of want) assert.equal(route(k, 'x').model, m, `${k} 没走自己的变量`);
    });
    check('④-2：五类的 reason 各不相同且说明了为什么用它（日志要能解释这次选择）', () => {
      const reasons = want.map(([k]) => route(k, 'x').reason);
      assert.equal(new Set(reasons).size, want.length, reasons.join(' | '));
    });
  },
);
withEnv({}, () => {
  check('④-3：一个变量都没配 → 全部回落 env.deepseekModel（默认行为不变）', () => {
    for (const k of ['chat', 'tool', 'extract', 'search', 'worker', 'delegate'] as TaskKind[]) {
      assert.equal(route(k, COMPLEX).model, 'deepseek-chat', `${k} 没回落`);
    }
  });
  check('④-4：未知 taskKind（default）也回落，且 reason 说明是默认路由', () => {
    const d = route('default', 'x');
    assert.equal(d.model, 'deepseek-chat');
    assert.equal(d.taskKind, 'default');
    assert.match(d.reason, /默认路由/);
  });
});

// ------------------------------------------------------------------ ⑤ 总开关
log('');
log('--- ⑤ MODEL_ROUTING_ENABLED=0 → 一律回默认模型（逃生阀必须真的能关掉路由）---');
withEnv(
  { MODEL_ROUTING_ENABLED: '0', DEEPSEEK_MODEL_CHAT: 'fast-chat', DEEPSEEK_MODEL_CHAT_COMPLEX: 'deep-reasoner', DEEPSEEK_MODEL_TOOL: 'm-tool' },
  () => {
    const c = route('chat', COMPLEX);
    const t = route('tool', 'x');
    log(`      chat → ${c.model}（${c.reason}）  tool → ${t.model}`);
    check('⑤-1：关掉之后连配好的 CHAT_COMPLEX / TOOL 都不走，一律 env.deepseekModel', () => {
      assert.equal(c.model, 'deepseek-chat');
      assert.equal(t.model, 'deepseek-chat');
    });
    check('⑤-2：taskKind 归 default、reason 如实说「路由关闭」', () => {
      assert.equal(c.taskKind, 'default');
      assert.match(c.reason, /路由关闭/);
    });
  },
);
withEnv({ MODEL_ROUTING_ENABLED: '1', DEEPSEEK_MODEL_CHAT_COMPLEX: 'deep-reasoner' }, () => {
  check('⑤-3：显式 =1 与不配一样都是「开」（默认开启，不许反过来）', () => {
    assert.equal(route('chat', COMPLEX).model, 'deep-reasoner');
  });
});

// ------------------------------------------------------------------ ⑥ tag → taskKind
log('');
log('--- ⑥ inferTaskKindFromTag：调用点只有 llm.ts 的 tag，映射错了整条路由就选错模型 ---');
{
  const cases: Array<[string, TaskKind]> = [
    ['chat/stream', 'chat'],
    ['POST /chat/stream', 'chat'],
    ['agent/loop/next', 'tool'],
    ['agent/loop/next-action', 'tool'],
    ['tool:click', 'tool'],
    ['memories/extract', 'extract'],
    ['tavily/search', 'search'],
    ['worker/run', 'worker'],
    ['delegate/task', 'delegate'],
    ['whatever/else', 'default'],
    ['', 'default'],
  ];
  log(`      ${cases.map(([t, k]) => `${t}→${inferTaskKindFromTag(t)}${inferTaskKindFromTag(t) === k ? '' : '★'}`).join('  ')}`);
  check('⑥-1：每个 tag 都落到期望的 taskKind（大小写不敏感）', () => {
    for (const [tag, want] of cases) assert.equal(inferTaskKindFromTag(tag), want, `${tag} 应归 ${want}`);
  });
  check('⑥-2：大小写与前后缀不影响判定（tag 是各调用点自己写的，形状不受控）', () => {
    assert.equal(inferTaskKindFromTag('CHAT/Stream'), 'chat');
    assert.equal(inferTaskKindFromTag('  Agent/Loop/NEXT  '), 'tool');
  });
}

// ------------------------------------------------------------------ ⑦ 简单/复杂的判定边界（从 reason 观察）
log('');
log('--- ⑦ 简单/复杂判定的边界：从返回的 reason 反推（判定函数不导出，就走公开出口验）---');
withEnv({ DEEPSEEK_MODEL_CHAT: 'fast-chat', DEEPSEEK_MODEL_CHAT_COMPLEX: 'deep-reasoner' }, () => {
  const reasonOf = (t: string): string => route('chat', t).reason;
  /**
   * ★ 这两组样本把**既有启发式的优先级**如实钉住（收尾 7 没动判定，只让路由真的换模型）：
   *   `isSimple` 先判，它的两条规则是「以问候语开头」或「**去空白后 < 10 字**」；
   *   所以 `做个对比报告`（6 字，含「对比/报告」）判**简单** —— 短句优先于关键词。
   *   这不是本批引入的行为，是批次 I 原来就有的取舍；把它写成断言，
   *   将来谁要改成「关键词优先」，会先看到这里、有意识地改（而不是悄悄漂）。
   */
  const samples = [
    ['你好', /简单/],
    ['您好，请问', /简单/],
    ['hi', /简单/],
    ['谢谢', /简单/],
    ['短句子', /简单/], // < 10 字
    ['做个对比报告', /简单/], // 6 字：短句优先于「对比/报告」关键词（既有启发式）
    ['帮我分析这份数据', /简单/], // 8 字：同上
    ['帮我分析这一份季度数据', /推理模型/], // 11 字 + 关键词 → 复杂
    ['做个对比报告，覆盖三个季度', /推理模型/],
    ['全面调研一下这个市场', /推理模型/],
    ['今天天气怎么样啊', /简单/],
  ] as Array<[string, RegExp]>;
  log(`      ${samples.map(([t, re]) => `${t}→${reasonOf(t)}`).join('  |  ')}`);
  check('⑦-1：问候/致谢/短句判为简单；**≥10 字且**含「分析/对比/报告/调研/全面」才判复杂', () => {
    for (const [t, re] of samples) assert.match(reasonOf(t), re, `「${t}」的判定不符（reason=${reasonOf(t)}）`);
  });
  check('⑦-2：空正文不猜难度（走「闲聊任务」，既不装简单也不装复杂）', () => {
    assert.equal(reasonOf(''), '闲聊任务');
    assert.equal(route('chat', '').model, 'fast-chat');
  });
  check('⑦-3：问候语开头优先（`你好，帮我分析这组数据` 判简单 —— isSimple 的第一条规则先命中）', () => {
    assert.match(reasonOf('你好，帮我分析这组数据'), /简单/);
  });
  check('⑦-4：★同一句话只因**长度**跨过 10 字就从简单变复杂（把既有启发式的边界钉死，改优先级的人会先红）', () => {
    assert.match(reasonOf('做个对比报告'), /简单/); // 6 字
    assert.match(reasonOf('做个对比报告，覆盖三个季度'), /推理模型/); // 13 字
    assert.notEqual(route('chat', '做个对比报告').model, route('chat', '做个对比报告，覆盖三个季度').model);
  });
});

// ------------------------------------------------------------------ ⑧ 接线：llm.ts 真的用路由结果
log('');
log('--- ⑧ 接线：llm.ts 用的是路由**返回的**那三格，不是 env.deepseekModel（防「路由存在但没接上」）---');
{
  const llm = read('apps/server/src/llm.ts');
  /**
   * 这两条只能验源码文本 —— 「谁调谁」这件事没有别的可执行出口（跑一次真 llm 要外部模型）。
   * 但它们验的不是「出现过某个名字」，而是**赋值链**：路由结果必须真的流到发请求用的那三个变量上。
   */
  check('⑧-1：llm.ts 把 routed.model / baseUrl / apiKey 赋给实际发请求用的那三个变量', () => {
    assert.ok(/const taskKind = inferTaskKindFromTag\(opts\.tag\);/.test(llm), '没有从 tag 推 taskKind');
    assert.ok(/const routed = getModelForTask\(env, taskKind, lastUserMsg\);/.test(llm), '没有调路由');
    assert.ok(/const effectiveModel = routed\.model;/.test(llm), 'effectiveModel 不是路由给的');
    assert.ok(/const effectiveBaseUrl = routed\.baseUrl;/.test(llm), 'baseUrl 不是路由给的');
    assert.ok(/const effectiveApiKey = routed\.apiKey;/.test(llm), 'apiKey 不是路由给的');
    assert.ok(/const modelToUse = effectiveModel;/.test(llm), '发请求那一步没接上路由结果');
  });
  check('⑧-2：判定复杂/简单用的正文是**最后一条 user 消息**（不是整段历史，也不是 tag）', () => {
    assert.ok(/const lastUserMsg = \[\.\.\.messages\]\.reverse\(\)\.find\(\(m\) => m\.role === 'user'\)\?\.content \?\? '';/.test(llm));
    assert.ok(/getModelForTask\(env, taskKind, lastUserMsg\)/.test(llm));
  });
  check('⑧-3：日志里带 taskKind + model + reason（这条路由唯一的可观测出口，缺一个就没法排查「为什么走了这个模型」）', () => {
    assert.ok(/taskKind=\$\{taskKind\}/.test(llm) && /model=\$\{effectiveModel\}/.test(llm) && /reason=\$\{routed\.reason\}/.test(llm));
  });
  check('⑧-4：★不许有「拿 env.deepseekModel 覆盖路由结果」的回头路（那等于把路由架空）', () => {
    assert.ok(!/const modelToUse = env\.deepseekModel/.test(llm), 'modelToUse 又指回 env.deepseekModel 了');
    assert.ok(!/effectiveModel = env\.deepseekModel/.test(llm));
  });
}

// ------------------------------------------------------------------ ⑨ 用户不选模型
log('');
log('--- ⑨ 反证：用户不选模型（前端没有模型选择器，也不该出现模型环境变量名）---');
{
  const app = read('apps/desktop/src/App.tsx');
  check('⑨-1：桌面没有模型选择器（用户不选模型是本批的设计前提）', () => {
    assert.ok(!/modelSelector|选择模型|模型选择/.test(app), '桌面出现了模型选择器');
    assert.ok(!/DEEPSEEK_MODEL/.test(app), '桌面源码里出现了模型环境变量名（模型是后端的事）');
  });
  check('⑨-2：路由只在服务端（shared / 桌面都没有第二份路由实现）', () => {
    const dup: string[] = [];
    for (const rel of ['packages/shared/src/index.ts', 'apps/desktop/src/App.tsx']) {
      if (/getModelForTask|DEEPSEEK_MODEL_CHAT_COMPLEX/.test(read(rel))) dup.push(rel);
    }
    assert.deepEqual(dup, []);
  });
}

log('');
log(`=== 批次 I 模型路由：PASS ${passes} / FAIL ${fails} ===`);
process.exit(fails > 0 ? 1 : 0);
