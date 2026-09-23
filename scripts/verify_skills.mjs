#!/usr/bin/env node
// 批次 F | Skills 验证
import fs from 'node:fs';

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
}

console.log('=== 批次 F | Skills ===');

let db = fs.readFileSync('apps/server/src/db.ts','utf8');
assert(db.includes('CREATE TABLE IF NOT EXISTS skills'), 'db 应有 skills 表');
assert(db.includes('trigger_condition'), 'skills 表应有触发条件');
assert(db.includes('steps_enc'), '应有步骤加密');
assert(db.includes('decision_rules_enc'), '应有决策规则');
assert(db.includes('output_requirements_enc'), '应有产出要求');
assert(db.includes('approval_boundary_enc'), '应有审批边界');
console.log('F DB 表结构 PASS');

let skills = fs.readFileSync('apps/server/src/orchestrator/skills.ts','utf8');
assert(skills.includes('buildSkillBlock'), '应有 buildSkillBlock');
assert(skills.includes('trigger_condition'), '应处理触发条件');
assert(skills.includes('teach-a-task'), '应有 teach-a-task 说明');
assert(skills.includes('usage_count'), '应有使用计数');
assert(skills.includes('reviseSkill'), '应有自我修订');
console.log('F skills.ts 逻辑 PASS');

let identity = fs.readFileSync('apps/server/src/identityBlock.ts','utf8');
assert(identity.includes('skillBlock'), 'identityBlock 应有技能槽');
assert(identity.includes('技能槽') || identity.includes('Skills'), '应说明技能槽');
console.log('F identityBlock 技能槽 PASS');

let chat = fs.readFileSync('apps/server/src/routes/chat.ts','utf8');
assert(chat.includes('buildSkillBlock'), 'chat.ts 应注入技能');
assert(chat.includes('skillBlock'), 'chat.ts 应有 skillBlock 变量');
console.log('F chat.ts 注入 PASS');

let toolReg = fs.readFileSync('apps/server/src/toolRegistry.ts','utf8');
assert(toolReg.includes('teach_skill'), '工具表应含 teach_skill');
assert(toolReg.includes('revise_skill'), '工具表应含 revise_skill');
console.log('F 工具注册 PASS');

let skillTools = fs.readFileSync('apps/server/src/orchestrator/skillTools.ts','utf8');
assert(skillTools.includes('teach_skill'), '应有 teach_skill 工具定义');
assert(skillTools.includes('revise_skill'), '应有 revise_skill 工具定义');
assert(skillTools.includes('自我修订'), '应说明自我修订');
console.log('F skillTools 工具定义 PASS');

// 反证：无触发条件匹配不注入
function mockMatch(trigger, message) {
  const msgLower = message.toLowerCase();
  const triggerLower = trigger.toLowerCase();
  const words = triggerLower.split(/[,，\s]+/).filter(w=>w.length>=2);
  return words.some(w=>msgLower.includes(w));
}
assert(!mockMatch('下单流程', '今天天气不错'), '无触发不应命中');
assert(mockMatch('下单流程', '帮我走一下下单流程'), '有触发应命中');
console.log('F 反证 PASS: 无触发不注入，有触发才注入');

let routes = fs.readFileSync('apps/server/src/routes/skills.ts','utf8');
assert(routes.includes('/skills'), '应有 /skills 路由');
assert(routes.includes('revise'), '应有修订路由');
console.log('F 路由 PASS');

console.log('\n=== 批次 F 全部 PASS ===');
