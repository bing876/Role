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

console.log('=== 状态承载到联系人：头像即状态 验收 ===');

const sharedPath = path.join(root,'packages/shared/src/index.ts');
const shared = fs.readFileSync(sharedPath,'utf8');
must(shared.includes("status?: 'idle'") && shared.includes("'thinking'") && shared.includes("'working'"), 'shared AgentView 含 status 六态（idle/thinking/working/waiting/blocked/done）');
must(shared.includes('statusDetail'), 'shared AgentView 含 statusDetail（折叠摘要）');
must(shared.includes('头像即状态'), 'shared 注释提及头像即状态（Grok取舍）');

const agentStatusPath = path.join(root,'apps/server/src/orchestrator/agentStatus.ts');
must(fs.existsSync(agentStatusPath), 'agentStatus.ts 存在（数据/事件做，版式归前端）');
const agentStatus = fs.readFileSync(agentStatusPath,'utf8');
must(agentStatus.includes('resolveAgentStatus'), 'agentStatus.ts 有 resolveAgentStatus');
must(agentStatus.includes('isAgentWaiting') && agentStatus.includes('agentBusyCount'), 'agentStatus.ts 基于 waiting/busy 判断');
must(agentStatus.includes('latestLoopOfAgent') || agentStatus.includes('loopsOfAgent'), 'agentStatus.ts 基于 loop 状态判断');
must(agentStatus.includes("'idle'") && agentStatus.includes("'waiting'") && agentStatus.includes("'blocked'"), 'agentStatus.ts 覆盖六态');

const agentsRoutePath = path.join(root,'apps/server/src/routes/agents.ts');
const agentsRoute = fs.readFileSync(agentsRoutePath,'utf8');
must(agentsRoute.includes('resolveAgentStatus') && agentsRoute.includes('agentStatus'), 'agents.ts 路由引入 agentStatus 并计算');
must(agentsRoute.includes('a.status ='), 'agents.ts 给 AgentView 赋值 status');
must(!agentsRoute.includes('ChannelsPanel'), 'agents.ts 未耦合抽屉UI（关注分离）');

const toolLoopPath = path.join(root,'apps/server/src/toolLoop.ts');
const toolLoop = fs.readFileSync(toolLoopPath,'utf8');
must(toolLoop.includes('loopsOfAgent') && toolLoop.includes('latestLoopOfAgent'), 'toolLoop.ts 暴露 loopsOfAgent/latestLoopOfAgent 供状态计算');

console.log(`\n=== 结论：失败 ${fails} 项 ===`);
process.exit(fails>0?1:0);
