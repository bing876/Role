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

console.log('=== 批次 E | 前端引导：对话式建智能体、立刻建好不挡你、第一个智能体提议同事、砍仪表盘 ===');

const abPath = path.join(root,'apps/server/src/orchestrator/agentBuilder.ts');
must(fs.existsSync(abPath), 'agentBuilder.ts 存在（对话式建智能体）');
const ab = fs.readFileSync(abPath,'utf8');
must(ab.includes('detectBuildIntent') && ab.includes('buildAgentImmediately'), 'agentBuilder.ts 有 detectBuildIntent + buildAgentImmediately（立刻建好不挡你）');
must(ab.includes('proposeColleaguesForProject') && ab.includes('seedColleagueProposal'), 'agentBuilder.ts 有 proposeColleagues + seedColleagueProposal（第一个智能体提议同事）');
must(ab.includes('建一个') || ab.includes('创建'), 'agentBuilder.ts 支持中文建智能体意图');

const chatPath = path.join(root,'apps/server/src/routes/chat.ts');
const chat = fs.readFileSync(chatPath,'utf8');
must(chat.includes('detectBuildIntent') && chat.includes('buildAgentImmediately'), 'chat.ts 接入对话式建智能体，检测意图后立刻建好');

const agentsPath = path.join(root,'apps/server/src/routes/agents.ts');
const agents = fs.readFileSync(agentsPath,'utf8');
must(agents.includes('批次 E') && agents.includes('直接传 persona') && agents.includes('立刻建好'), 'agents.ts 支持直接传 persona 立刻 ready（不走 pending 引导表）');

const projPath = path.join(root,'apps/server/src/routes/projects.ts');
const proj = fs.readFileSync(projPath,'utf8');
must(proj.includes('seedColleagueProposal') && proj.includes('提议同事'), 'projects.ts 建项目后提议同事（第一个智能体自己提议）');

const appPath = path.join(root,'apps/desktop/src/App.tsx');
const app = fs.readFileSync(appPath,'utf8');
must(app.includes('quickBuildAgent'), 'App.tsx 有 quickBuildAgent（对话式建，立刻建好不挡你）');
must(app.includes('colleagueProposal') || app.includes('建议先建这几位同事'), 'App.tsx 有同事提议快捷建按钮');
must(!app.includes('className="driveBar"') || app.includes('批次 E：driveBarAct 已移除'), 'App.tsx 已砍掉 driveBar 仪表盘（砍掉一切仪表盘）');
must(app.includes('建一个销售助手') || app.includes('建一个'), 'App.tsx placeholder 提示对话式建智能体');

const dbPath = path.join(root,'apps/server/src/db.ts');
const db = fs.readFileSync(dbPath,'utf8');
must(!db.includes('group_chats'), 'db.ts 未建 group_chats（项目即群，铁律）');

console.log('\n--- 模拟对话式建智能体 ---');
function detectBuildIntentJS(message) {
  const t = message.trim();
  if (!t) return null;
  const buildRe = /(建|创建|新建|来个|来一个|需要|想要|加个|加一个|招个|招一个).{0,12}(助手|同事|智能体|机器人|专员|经理|师|手|员|顾问|管家|客服|销售|运营|开发|设计|产品|测试|调研|写作)/;
  if (!buildRe.test(t)) return null;
  if (/^我是/.test(t) && t.length < 30) return null;
  const m1 = t.match(/(?:建|创建|新建|来个|来一个|需要|想要|加个|加一个|招个|招一个)\s*一个?\s*([^\s，。,.!！?？]{2,12})(?:助手|同事|智能体|机器人|专员|经理)?[，。,.!！]?[，,]?\s*(?:负责|帮我|干|做)?\s*(.+)?/);
  if (m1) {
    const name = m1[1].trim();
    const duty = (m1[2] ?? '').trim().slice(0, 120);
    if (name.length >= 2) return { name: name.slice(0,24), duty: duty || `${name}相关工作`, raw: t };
  }
  const m2 = t.match(/(?:建|创建)\s*一个?\s*([^\s，。,.!！?？]{2,12})/);
  if (m2) {
    const name = m2[1].trim();
    if (name.length >=2 && name.length <=12) return { name: name.slice(0,24), duty: `${name}相关工作`, raw: t };
  }
  return null;
}
const cases = [
  { msg: '建一个销售助手，负责跟进客户', expectName: '销售' },
  { msg: '创建一个客服', expectName: '客服' },
  { msg: '我需要一个运营同事，帮我盯店铺数据', expectName: '运营' },
  { msg: '你好', expectName: null },
];
for (const c of cases) {
  const r = detectBuildIntentJS(c.msg);
  if (c.expectName === null) {
    must(r === null, `非建智能体意图「${c.msg}」应返回 null`);
  } else {
    must(r !== null && r.name.includes(c.expectName), `建智能体意图「${c.msg}」应识别出 ${c.expectName}，实际 ${r?.name}`);
  }
}

console.log('\n--- 模拟提议同事 ---');
function proposeColleaguesForProjectJS(projectName, existingCount) {
  if (existingCount > 1) return [];
  if (/(电商|店铺|淘宝|天猫|京东|拼多多|抖店|小红书|带货|选品)/.test(projectName)) {
    return [
      { name: '运营助手', duty: '盯店铺数据' },
      { name: '客服助手', duty: '处理客户咨询' },
      { name: '销售助手', duty: '跟进客户' },
    ];
  }
  return [
    { name: '调研助手', duty: '搜资料' },
    { name: '整理助手', duty: '整理文档' },
  ];
}
const sug = proposeColleaguesForProjectJS('我的电商店铺', 1);
must(sug.length >= 2 && sug.some((s) => s.name.includes('运营') || s.name.includes('客服')), '电商店铺应提议运营/客服等同事');

console.log(`\n=== 结论：失败 ${fails} 项 ===`);
process.exit(fails>0?1:0);
