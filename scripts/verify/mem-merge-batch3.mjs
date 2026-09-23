#!/usr/bin/env node
/**
 * 记忆合并第三批验收：整理统一
 * - memoryShared.ts 存在且收口提示词/JSON容错/写入
 * - agents.ts 和 memories.ts 都从 memoryShared import，不再各自为政
 * - 写入逻辑统一走 writeMemoryRow / writeTidyLayer
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

let fails = 0;
function ok(msg) { console.log(`PASS ${msg}`); }
function fail(msg) { console.error(`FAIL ${msg}`); fails += 1; }
function must(cond, msg) { cond ? ok(msg) : fail(msg); }

console.log('=== 记忆合并第三批验收：整理统一 ===');

const sharedPath = path.join(root, 'apps/server/src/memoryShared.ts');
must(fs.existsSync(sharedPath), 'memoryShared.ts 存在');
const sharedContent = fs.readFileSync(sharedPath, 'utf8');
must(sharedContent.includes('export function extractJsonLoose'), 'memoryShared 有 extractJsonLoose');
must(sharedContent.includes('export const EXTRACT_PROMPT'), 'memoryShared 有 EXTRACT_PROMPT');
must(sharedContent.includes('export const TIDY_PROMPT'), 'memoryShared 有 TIDY_PROMPT');
must(sharedContent.includes('export function looksLikeWorkRule'), 'memoryShared 有 looksLikeWorkRule');
must(sharedContent.includes('export async function writeMemoryRow'), 'memoryShared 有 writeMemoryRow');
must(sharedContent.includes('export async function writeTidyLayer'), 'memoryShared 有 writeTidyLayer');
must(sharedContent.includes("from './memoryNormalize'") || sharedContent.includes('memoryNormalize'), 'memoryShared 引入 memoryNormalize');
must(!sharedContent.includes("from '../crypto'"), 'memoryShared 不应从 ../crypto 引入（应是 ./crypto）');

const memPath = path.join(root, 'apps/server/src/routes/memories.ts');
const memContent = fs.readFileSync(memPath, 'utf8');
must(memContent.includes("from '../memoryShared'"), 'memories.ts 引入 memoryShared');
must(!memContent.includes('const EXTRACT_PROMPT ='), 'memories.ts 不再本地定义 EXTRACT_PROMPT');
must(!memContent.includes('const THEME_RULE_RE ='), 'memories.ts 不再本地定义 THEME_RULE_RE');
must(memContent.includes('writeMemoryRow'), 'memories.ts 使用 writeMemoryRow');
must(memContent.includes('extractJsonLoose'), 'memories.ts 使用 extractJsonLoose');

const agentsPath = path.join(root, 'apps/server/src/routes/agents.ts');
const agentsContent = fs.readFileSync(agentsPath, 'utf8');
must(agentsContent.includes("from '../memoryShared'"), 'agents.ts 引入 memoryShared');
must(!agentsContent.includes('const TIDY_PROMPT = ['), 'agents.ts 不再本地定义 TIDY_PROMPT');
must(agentsContent.includes('writeTidyLayer'), 'agents.ts 使用 writeTidyLayer');
must(agentsContent.includes('extractJsonLoose'), 'agents.ts 使用 extractJsonLoose');

const normalizePath = path.join(root, 'apps/server/src/memoryNormalize.ts');
const normalizeContent = fs.readFileSync(normalizePath, 'utf8');
must(!/^\s*import\s+/m.test(normalizeContent), 'memoryNormalize.ts 仍保持零 import');

console.log(`\n=== 结论：失败 ${fails} 项 ===`);
process.exit(fails > 0 ? 1 : 0);
