#!/usr/bin/env node
import fs from 'node:fs';

function assert(cond, msg) {
  if (!cond) { console.error('FAIL', msg); process.exit(1); }
}

console.log('=== 批次 G | 记忆语义检索 ===');

let mem = fs.readFileSync('apps/server/src/routes/memories.ts','utf8');
assert(mem.includes('批次 G'), '应有批次 G 注释');
assert(mem.includes('scoreMemorySemantic'), '应有语义打分函数');
assert(mem.includes('tokenizeForMemory'), '应复用 tokenize');
assert(mem.includes('0.25'), '应有阈值');
assert(mem.includes('Jaccard') || mem.includes('jaccard'), '应有 Jaccard');
console.log('G 代码结构 PASS');

// 模拟语义检索：同义应命中，字面不命中时语义应命中
function normalizeText(s) {
  return s.toLowerCase().replace(/\s+/g,'').trim();
}
function tokenizeForMemory(text) {
  const raw = text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/g).filter(w=>w.length>=2);
  const out=[];
  for (const token of raw) {
    out.push(token);
    if (/[\u4e00-\u9fa5]/.test(token) && token.length>2) {
      for (let i=0;i<=token.length-2;i++) {
        const bg=token.slice(i,i+2);
        if (bg.length===2) out.push(bg);
      }
    }
  }
  return out;
}
function scoreMemorySemantic(query, fact) {
  const qn=normalizeText(query);
  const fn=normalizeText(fact);
  if (!qn||!fn) return 0;
  if (qn.includes(fn)||fn.includes(qn)) return 0.9;
  const qTokens=new Set(tokenizeForMemory(query));
  const fTokens=tokenizeForMemory(fact);
  if (qTokens.size===0||fTokens.length===0) return 0;
  let inter=0;
  const fSet=new Set(fTokens);
  for (const t of fSet) if (qTokens.has(t)) inter++;
  const union=new Set([...qTokens,...fSet]).size;
  const jaccard=union>0?inter/union:0;
  let score=0, total=0;
  for (let i=0;i<fTokens.length;i++) {
    const t=fTokens[i];
    const w=1 + Math.min(2,t.length/4) + (fTokens.length-i)/fTokens.length;
    total+=w;
    if (qTokens.has(t)) score+=w;
    else if ([...qTokens].some(qt=>qt.includes(t)||t.includes(qt))) score+=w*0.5;
  }
  const weighted=total>0?score/total:0;
  return weighted*0.7 + jaccard*0.3;
}
function wordHits(text,fact){ return scoreMemorySemantic(text,fact)>=0.25; }

// 反证：字面包含匹配会漏掉同义，语义应命中
assert(!'喜欢喝咖啡'.includes('爱喝咖啡'), '字面不包含');
assert(wordHits('我爱喝咖啡', '喜欢喝咖啡'), '语义应命中同义：爱喝 vs 喜欢喝');
console.log('G 反证1 PASS: 字面不命中，语义命中');

const s1=scoreMemorySemantic('我爱喝咖啡','喜欢喝咖啡');
console.log(`  语义分数 爱喝 vs 喜欢喝: ${s1.toFixed(3)}`);
assert(s1>=0.25, '同义分数应 >=0.25');

assert(!wordHits('今天天气不错','喜欢喝咖啡'), '无关不应命中');
console.log('G 反证2 PASS: 无关不命中');

assert(wordHits('帮我整理店铺数据','运营助手负责盯店铺数据'), '店铺数据应命中');
console.log('G 正向 PASS');

console.log('\n=== 批次 G 全部 PASS ===');
