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

console.log('=== 上下文压缩：toolLoop 只增不减，长任务必爆 验收 ===');

const compressPath = path.join(root,'apps/server/src/orchestrator/contextCompress.ts');
must(fs.existsSync(compressPath), 'contextCompress.ts 存在（数据/事件做，学习内核前置）');
const compress = fs.readFileSync(compressPath,'utf8');
must(compress.includes('compressIfNeeded') && compress.includes('compressSession'), 'contextCompress.ts 有 compressIfNeeded/compressSession');
must(compress.includes('KEEP_RECENT') || compress.includes('最近'), 'contextCompress.ts 保留最近 N 步完整记录');
must(compress.includes('【上下文压缩') || compress.includes('上下文压缩'), 'contextCompress.ts 含压缩标记（折叠摘要）');
must(compress.includes('estimateTokens') || compress.includes('token'), 'contextCompress.ts 估算 token，防止爆');

const toolLoopPath = path.join(root,'apps/server/src/toolLoop.ts');
const toolLoop = fs.readFileSync(toolLoopPath,'utf8');
must(toolLoop.includes('compressIfNeeded') && toolLoop.includes('contextCompress'), 'toolLoop.ts 引入并调用 compressIfNeeded');
must(toolLoop.includes('上下文压缩') || toolLoop.includes('只增不减'), 'toolLoop.ts 注释提及上下文压缩/只增不减');

const totalPlanPath = path.join(root,'docs/智能体协同-总计划.md');
const plan = fs.readFileSync(totalPlanPath,'utf8');
must(plan.includes('上下文压缩') || plan.includes('toolLoop'), '总计划提及上下文压缩');

console.log(`\n=== 结论：失败 ${fails} 项 ===`);
process.exit(fails>0?1:0);
