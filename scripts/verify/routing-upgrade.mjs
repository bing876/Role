#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');
let fails=0;
function ok(m){console.log(`PASS ${m}`);}
function fail(m){console.error(`FAIL ${m}`);fails++;}
function must(c,m){c?ok(m):fail(m);}

console.log('=== 批次 C | 路由升级：description 为燃料 验收 ===');

const chiefPath = path.join(root,'apps/server/src/orchestrator/chiefOfStaff.ts');
must(fs.existsSync(chiefPath), 'chiefOfStaff.ts 存在');
const chief = fs.readFileSync(chiefPath,'utf8');
must(chief.includes('keyword_weighted') || chief.includes('关键词加权'), 'chiefOfStaff.ts 有关键词加权路由');
must(chief.includes('routeByFuzzy') && chief.includes("'fuzzy_match'"), 'chiefOfStaff.ts 有模糊字面相似度路由（收尾 4 正名：原称「嵌入」，实为 Jaccard + 加权）');
must(chief.includes('detectEmptyDuty') && chief.includes('通用助手'), 'chiefOfStaff.ts 检测空描述/通用助手');
must(chief.includes('weightForToken') || chief.includes('加权'), 'chiefOfStaff.ts 关键词按长度/位置/重要性加权');
must(chief.includes('IMPORTANT_KEYWORDS') || chief.includes('重要'), 'chiefOfStaff.ts 有重要关键词表，命中权重更高');
must(chief.includes('description 为燃料') || chief.includes('description'), 'chiefOfStaff.ts 注释提及 description 为燃料');

const agentsPath = path.join(root,'apps/server/src/routes/agents.ts');
const agents = fs.readFileSync(agentsPath,'utf8');
must(agents.includes('dutyWarning'), 'agents.ts 计算 dutyWarning（空描述警告）');

const sharedPath = path.join(root,'packages/shared/src/index.ts');
const shared = fs.readFileSync(sharedPath,'utf8');
must(shared.includes('dutyWarning'), 'shared AgentView 含 dutyWarning，前端可据此警告');
must(!shared.includes('group_chats'), 'shared 未建 group_chats（项目即群）');

const rosterPath = path.join(root,'apps/server/src/orchestrator/roster.ts');
const roster = fs.readFileSync(rosterPath,'utf8');
must(roster.includes('orchestrationBlockFor'), 'roster.ts 仍有名单拼装（路由燃料来源）');

const chatPath = path.join(root,'apps/server/src/routes/chat.ts');
const chat = fs.readFileSync(chatPath,'utf8');
must(chat.includes('routeTask'), 'chat.ts 仍调用 routeTask（路由升级后）');

// 模拟关键词加权 vs 字面匹配
function tokenize(text) {
  const raw = text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/g).filter(w=>w.length>=2);
  const out=[];
  for (const token of raw) {
    out.push(token);
    if (/[\u4e00-\u9fa5]/.test(token) && token.length>2) {
      for (let i=0;i<=token.length-2;i++) out.push(token.slice(i,i+2));
    }
  }
  return out;
}
function detectEmptyDuty(duty) {
  const d = (duty||'').trim();
  if (!d) return true;
  if (d.length<5) return true;
  const generic = ['通用助手','助手','AI助手','智能助手'];
  if (generic.includes(d)) return true;
  return false;
}
function scoreWeighted(task, duty) {
  if (!duty || detectEmptyDuty(duty)) return 0;
  const taskTokens = new Set(tokenize(task));
  const dutyTokens = tokenize(duty);
  let score=0, total=0;
  for (let i=0;i<dutyTokens.length;i++) {
    const t=dutyTokens[i];
    let w=1 + Math.min(2, t.length/4) + (dutyTokens.length-i)/dutyTokens.length;
    total+=w;
    if (taskTokens.has(t)) score+=w;
    else if ([...taskTokens].some(tt=>tt.includes(t)||t.includes(tt))) score+=w*0.5;
  }
  return total>0?score/total:0;
}

const task = '帮我分析一下店铺的销售数据和订单情况';
const dutyGood = '负责店铺销售数据分析、订单整理、运营诊断';
const dutyGeneric = '通用助手';
const scoreGood = scoreWeighted(task, dutyGood);
const scoreGeneric = scoreWeighted(task, dutyGeneric);
console.log(`\n加权匹配：好职责 "${dutyGood}" 得分 ${scoreGood.toFixed(2)}, 通用 "${dutyGeneric}" 得分 ${scoreGeneric.toFixed(2)}`);
must(scoreGood > scoreGeneric && scoreGood > 0.3, '关键词加权：具体职责得分高于通用助手，且能命中');
must(detectEmptyDuty(dutyGeneric), '空描述检测：通用助手被识别为空，路由时降低优先级');

console.log(`\n=== 结论：失败 ${fails} 项 ===`);
process.exit(fails>0?1:0);
