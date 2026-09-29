/**
 * 交互对齐片(2026-09-26) · **聊天流只放"回答",过程轨迹一律不进对话流** —— 验收网。
 *
 * 用户报的症状:执行中主对话流里出现「步骤墙」(`**步骤 1**：…`、`🎉 任务完成`、`> ℹ️ …`、
 * `💬 用户补充指令：…`),而且同一句话还会**再出现一次**(既作为事件渲染、又作为 delta 落进气泡)。
 *
 * 本脚本钉的就是那条口径(`apps/server/src/chatDelta.ts`):
 *   · 只有 `say`(模型对用户说的话)才写进聊天长连的 `delta`;
 *   · `tool` / `done` / `ask` / `ask(job_pending)` / `stopped` / `paused` **一律 null**
 *     —— 它们只走结构化事件(`step`/`note`/`ask`/`done`/`stopped`),由桌面放进轨迹抽屉。
 *
 * 用法:`npm run verify:chat-trace`
 */
import { chatDeltaFor } from '../../apps/server/src/chatDelta';

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
};

console.log('=== 交互对齐片 · 聊天流 delta 口径（只有 say 进对话流）===');

const call = { name: 'open_url', args: { url: 'https://example.com' } } as never;

/** 每一步"过程轨迹"的决策：都不许进聊天流 */
const TRACE_DECISIONS: Array<[string, unknown]> = [
  ['tool（每一步工具调用）', { kind: 'tool', call, step: 1 }],
  ['done（任务收尾）', { kind: 'done', summary: '已经买好了', document_title: 't', document_outline: [], step: 9 }],
  ['ask（要人帮忙）', { kind: 'ask', reason: 'need_info', question: '验证码是多少？', step: 3 }],
  ['ask / job_pending（等同事交活）', { kind: 'ask', reason: 'job_pending', question: '在等研究员', step: 4, jobId: 'j1' }],
  ['stopped（这一路停了）', { kind: 'stopped', reason: 'user', step: 2 }],
  ['paused（被用户挂起）', { kind: 'paused', reason: 'user_paused', step: 2 }],
];

for (const [name, d] of TRACE_DECISIONS) {
  const got = chatDeltaFor(d as never);
  check(
    `${name} → 不进聊天流（null）`,
    got === null,
    `实际返回了 ${JSON.stringify(got)} —— 这会把过程轨迹写成助手气泡里的「步骤墙」，并与事件渲染重复一遍`,
  );
}

/** 唯一该进聊天流的一种：模型对用户说的话 */
const sayDelta = chatDeltaFor({ kind: 'say', text: '我看了三家店，最便宜的是这家。', step: 5 } as never);
check(
  'say（模型对用户说的话）→ 进聊天流',
  typeof sayDelta === 'string' && sayDelta.includes('我看了三家店'),
  `实际：${JSON.stringify(sayDelta)}`,
);

/** 反证自检：把口径改回"步骤也进聊天流"，上面的断言必须能咬住 */
const oldStyle = chatDeltaFor({ kind: 'tool', call, step: 1 } as never);
check(
  '★ 口径自检：tool 决策绝不可能是字符串（否则 7 条断言形同虚设）',
  oldStyle === null,
  `tool 决策返回了字符串：${JSON.stringify(oldStyle)}`,
);

console.log('');
console.log('=== 结论 ===');
console.log(`  ${pass} PASS / ${fail} FAIL`);
if (fail > 0) process.exitCode = 1;
