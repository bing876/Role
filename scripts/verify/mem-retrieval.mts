/**
 * 批次 G | 记忆检索（收尾 4 正名：模糊字面匹配，不是语义检索）
 *
 * 和旧版（verify_mem_semantic.mjs）的区别：旧版在脚本里**抄了一份**打分函数再测它，
 * 生产代码怎么改它都 PASS。这里直接 import 生产函数 __test_scoreMemoryFuzzy。
 *
 * 断言分三类：
 *   ① 命名诚实：函数叫 scoreMemoryFuzzy，注释明说「不是语义检索」，源码里不再自称语义/嵌入
 *   ② 真实改进（相对 main 上的旧 wordHits）：共享 3 字短片段也能命中
 *   ③ 诚实的局限（钉死）：零字面重叠的真同义**必须 miss** ——
 *      哪天真接了 embedding、这条翻成命中，说明该把名字和本脚本一起改回「语义」了。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { __test_scoreMemoryFuzzy as score } from '../../apps/server/src/routes/memories';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const THRESHOLD = 0.25;
let fails = 0;
const check = (c: boolean, m: string) => {
  console.log(`${c ? 'PASS' : 'FAIL'} ${m}`);
  if (!c) fails++;
};
const hit = (q: string, f: string) => score(q, f) >= THRESHOLD;

console.log('=== 批次 G | 记忆检索：模糊字面匹配（收尾 4 正名） ===');

// ① 命名诚实 —— 先剥注释再断言「源码里不该有 X」
const src = fs.readFileSync(path.join(ROOT, 'apps/server/src/routes/memories.ts'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
check(/function scoreMemoryFuzzy\(/.test(code), '生产函数名为 scoreMemoryFuzzy');
check(!/scoreMemorySemantic/.test(code), '代码里（剥注释后）不再有 scoreMemorySemantic');
check(src.includes('不是语义检索'), '注释明确标注「不是语义检索」');
const chief = fs.readFileSync(path.join(ROOT, 'apps/server/src/orchestrator/chiefOfStaff.ts'), 'utf8');
const chiefCode = chief.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
check(!/'embedding'|routeByEmbedding|scoreDutyEmbedding|嵌入相似度/.test(chiefCode), '批次 C 路由代码里（剥注释后）不再自称 embedding / 嵌入');

// ② 真实改进：main 上旧 wordHits 只认「整句包含」或「≥4 字片段包含」
const s1 = score('我爱喝咖啡', '喜欢喝咖啡');
check(s1 >= THRESHOLD, `共享 3 字短片段「喝咖啡」→ 命中（${s1.toFixed(2)}；旧 wordHits 这条是 miss）`);
check(hit('帮我整理店铺数据', '运营助手负责盯店铺数据'), '共享词「店铺数据」→ 命中');

// ③ 诚实的局限：这是字面匹配，真同义但零字面重叠必须 miss
const s2 = score('我爱喝拿铁', '喜欢喝咖啡');
check(s2 < THRESHOLD, `真同义零重叠「拿铁」vs「咖啡」→ miss（${s2.toFixed(2)}）—— 证明它不是语义检索`);
check(!hit('今天天气不错', '喜欢喝咖啡'), '无关 → miss');

console.log(`\n=== 结论：失败 ${fails} 项 ===`);
process.exit(fails > 0 ? 1 : 0);
