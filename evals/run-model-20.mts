/** 真 DeepSeek 20 题：仅在具备用户自己的真 key 和公网访问时运行。
 * 运行：DEEPSEEK_API_KEY=... npm run eval:model:live
 * 缺 key / mock / 上游任一请求失败 => NOT RUN/PARTIAL + 非零；不生成虚构准确率。
 */
import type { ServerEnv } from '../apps/server/src/env';
import { MODEL_PROVIDER_DEFAULTS } from '@ai-workbench/shared';
import { evaluate20, score20 } from './model-20.mts';

async function main() {
  const key = (process.env.DEEPSEEK_API_KEY ?? '').trim();
  if (!key || key === 'mock' || key.startsWith('mock:')) {
    console.error('NOT RUN：没有真实 DEEPSEEK_API_KEY；离线评分桩不能冒充真模型准确率。');
    process.exitCode = 2; return;
  }
  if (process.env.DEEPSEEK_BASE_URL && process.env.DEEPSEEK_BASE_URL.replace(/\/+$/, '') !== 'https://api.deepseek.com') {
    console.error('NOT RUN：真 DeepSeek 评测只向官方 https://api.deepseek.com 发请求；本地/代理桩不可记为真模型准确率。');
    process.exitCode = 2; return;
  }
  const model = (process.env.EVAL_DEEPSEEK_MODEL ?? MODEL_PROVIDER_DEFAULTS.deepseek.model).trim();
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(model)) { console.error('NOT RUN：模型名非法'); process.exitCode = 2; return; }
  // 同一模型同一条件跑四组题。生产路由/委派/记忆/技能的提示词与工具 schema 仍照原代码使用。
  process.env.MODEL_ROUTING_ENABLED = '0';
  const env = { deepseekApiKey: key, deepseekBaseUrl: 'https://api.deepseek.com', deepseekModel: model } as ServerEnv;
  console.log(`DeepSeek 真模型 20 题（${model}，单线程；本脚本不执行写操作）`);
  const rows = await evaluate20(env);
  for (const r of rows) console.log(`${r.id} [${r.group}] expected=${r.expected} predicted=${r.predicted} ${r.error ? `ERROR=${r.error}` : r.correct ? '✓' : '✗'}`);
  const grade = score20(rows);
  if (!grade.complete) {
    console.error('PARTIAL / NOT RUN：至少一题网络/上游失败；不输出总准确率。请检查官方 API 访问、余额/限流并重跑全部 20 题。');
    process.exitCode = 1; return;
  }
  for (const [group, { correct, total }] of Object.entries(grade.byGroup))
    console.log(`${group}: ${correct}/${total} = ${(correct / total * 100).toFixed(0)}%`);
  console.log(`真实模型准确率: ${grade.correct}/20 = ${(grade.accuracy! * 100).toFixed(0)}%（${model}，${new Date().toISOString()}）`);
}
main().catch(() => { console.error('PARTIAL / NOT RUN：评测运行失败；没有可信的准确率。'); process.exitCode = 1; });
