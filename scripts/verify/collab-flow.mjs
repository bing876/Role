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

console.log('=== 无感核心：协同进对话流 + 删内部频道抽屉 验收 ===');

const appPath = path.join(root,'apps/desktop/src/App.tsx');
const appContent = fs.readFileSync(appPath,'utf8');
// 去注释后再检查，避免注释里的残留误判
const appNoComment = appContent.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*$/gm,'');

must(!appNoComment.includes('ChannelsPanel'), 'App.tsx 源码已无 ChannelsPanel（抽屉已删）');
must(!appNoComment.includes('showChannels'), 'App.tsx 已无 showChannels 状态');
must(!appNoComment.includes('内部频道'), 'App.tsx 已无「内部频道」按钮文案');
must(!appNoComment.includes('channelsPanel'), 'App.tsx 已无 channelsPanel 引用');

const delegationPath = path.join(root,'apps/server/src/orchestrator/delegation.ts');
const delegationContent = fs.readFileSync(delegationPath,'utf8');
must(delegationContent.includes('collabChat') || delegationContent.includes('writeCollab'), 'delegation.ts 引入 collabChat（协同进对话流）');
must(delegationContent.includes('writeCollabBoth') || delegationContent.includes('writeCollabToAgentChat'), 'delegation.ts 调用写对话流');
must(delegationContent.includes('collab') || collabContent.includes('【协同'), '协同标记存在（delegation 或 collabChat 含【协同】）');
must(delegationContent.includes('对话流') || delegationContent.includes('协同进对话流'), 'delegation.ts 注释含对话流');

const collabPath = path.join(root,'apps/server/src/orchestrator/collabChat.ts');
must(fs.existsSync(collabPath), 'collabChat.ts 存在（数据/事件做）');
const collabContent = fs.readFileSync(collabPath,'utf8');
must(collabContent.includes('writeCollabToAgentChat'), 'collabChat.ts 有 writeCollabToAgentChat');
must(collabContent.includes('messages') && collabContent.includes('conversation_id'), 'collabChat.ts 写入 messages 表（进对话流）');
must(collabContent.includes('【协同'), 'collabChat.ts 构建【协同】文本');

const dbPath = path.join(root,'apps/server/src/db.ts');
const dbContent = fs.readFileSync(dbPath,'utf8');
must(dbContent.includes('agent_channels'), 'db.ts 仍保留 agent_channels 表（数据层保留）');
must(dbContent.includes('agent_delegations'), 'db.ts 仍保留 agent_delegations 表');

const channelsRoutePath = path.join(root,'apps/server/src/routes/channels.ts');
must(fs.existsSync(channelsRoutePath), 'channels.ts 路由仍存在（只读接口保留，数据可查）');

console.log(`\n=== 结论：失败 ${fails} 项 ===`);
process.exit(fails>0?1:0);
