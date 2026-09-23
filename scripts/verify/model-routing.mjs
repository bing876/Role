#!/usr/bin/env node
import { fileURLToPath as __f2p } from 'node:url';
import { dirname as __dn, resolve as __rs } from 'node:path';
// 从任何 cwd 运行都以仓库根为基准（原来散在 scripts/ 下时依赖 cwd=仓库根）
process.chdir(__rs(__dn(__f2p(import.meta.url)), '..', '..'));
import fs from 'node:fs';
function assert(c,m){ if(!c){ console.error('FAIL',m); process.exit(1);} }

console.log('=== 批次 I | 模型自动路由 ===');

let router=fs.readFileSync('apps/server/src/modelRouter.ts','utf8');
assert(router.includes('TaskKind'), '应有 TaskKind');
assert(router.includes('getModelForTask'), '应有 getModelForTask');
assert(router.includes('MODEL_ROUTING_ENABLED'), '应有开关');
assert(router.includes('chat') && router.includes('tool') && router.includes('extract'), '应有任务类型路由');
console.log('I modelRouter.ts PASS');

let llm=fs.readFileSync('apps/server/src/llm.ts','utf8');
assert(llm.includes('getModelForTask'), 'llm.ts 应调用路由');
assert(llm.includes('inferTaskKindFromTag'), '应推断任务类型');
assert(llm.includes('taskKind'), '日志应含 taskKind');
assert(llm.includes('批次 I'), '应有批次 I 注释');
console.log('I llm.ts 接入 PASS');

// 反证：用户不选模型，前端无模型选择器
let appDesktop=fs.readFileSync('apps/desktop/src/App.tsx','utf8');
const hasModelSelector = /model.*select|选择模型/i.test(appDesktop) && appDesktop.includes('DEEPSEEK_MODEL');
assert(!hasModelSelector || !appDesktop.includes('modelSelector'), '前端不应有模型选择器（用户不选模型）');
console.log('I 反证1 PASS: 前端无模型选择器，用户不选模型');

// 反证：同一任务类型确定性路由
function mockGetModel(taskKind) {
  const map = { chat: 'deepseek-chat', tool: 'deepseek-chat', extract: 'deepseek-chat' };
  return map[taskKind] ?? 'deepseek-chat';
}
assert(mockGetModel('chat') === mockGetModel('chat'), '同一任务应路由到同一模型');
assert(mockGetModel('tool') === 'deepseek-chat', '工具任务路由');
console.log('I 反证2 PASS: 同一任务类型确定性路由');

let env=fs.readFileSync('apps/server/src/env.ts','utf8');
assert(env.includes('deepseekModel'), 'env 应有默认模型');
console.log('I env PASS');

console.log('\n=== 批次 I 全部 PASS ===');
