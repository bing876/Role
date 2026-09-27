/** 20 题评分机制离线自检：假上游只给固定答案，不算「模型准确率」。
 * 真脚本 evals/run-model-20.mts 在无真实 DeepSeek key 时必须 NOT RUN/非零。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ServerEnv } from '../../apps/server/src/env';
import { EVAL_CASES, evaluate20, score20 } from '../../evals/model-20.mts';

async function main() {
  assert.equal(EVAL_CASES.length, 20);
  const seen: Array<{ body: any; auth: string }> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => raw += c);
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/chat/completions') { res.writeHead(404).end(); return; }
      const body = JSON.parse(raw);
      const item = EVAL_CASES[seen.length];
      seen.push({ body, auth: String(req.headers.authorization ?? '') });
      if (!item) { res.writeHead(500).end(); return; }
      let message: Record<string, unknown>;
      if (item.group === 'routing') {
        const choice = item.expected === 'none' ? 'none' : Number(item.expected.slice('route:'.length));
        message = { content: JSON.stringify({ choice, reason: '离线评分桩' }) };
      } else if (item.group === 'memory') {
        const [type] = item.expected.split(':');
        const items = item.expected === 'none' ? [] : [{ type, needs_confirm: type !== 'preference',
          content: type === 'decision' ? '以后所有报告都用表格' : '以后回答请尽量简短' }];
        message = { content: JSON.stringify({ items }) };
      } else {
        const [name, to] = item.expected.split(':');
        const args = name === 'delegate' ? { to, task: '完成这项工作' } : name === 'revise_skill' ?
          { skill_id: Number(to), approval_boundary: '先征求确认' } : name === 'teach_skill' ?
          { name: '周报三段式', trigger_condition: '周报', steps: ['先核查', '再总结'] } : { reason: 'need_user' };
        message = { tool_calls: [{ id: `offline_${item.id}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const env = { deepseekApiKey: 'offline-fixture-key', deepseekBaseUrl: base, deepseekModel: 'offline-fixture-model' } as ServerEnv;
    const rows = await evaluate20(env);
    const grade = score20(rows);
    assert.ok(grade.complete && grade.correct === 20 && grade.total === 20, '评分桩的预置答案必须逐题对齐');
    assert.equal(seen.length, 20);
    for (let i = 0; i < seen.length; i++) {
      const item = EVAL_CASES[i]; const call = seen[i];
      assert.equal(call.auth, 'Bearer offline-fixture-key');
      assert.equal(call.body.model, 'offline-fixture-model');
      if (item.group === 'routing') {
        assert.match(call.body.messages[0].content, /候选智能体/);
        assert.equal(call.body.response_format?.type, 'json_object');
      } else if (item.group === 'memory') {
        assert.match(call.body.messages[0].content, /记忆保管员/);
        assert.equal(call.body.response_format?.type, 'json_object');
      } else {
        assert.equal(call.body.tool_choice, 'required');
        assert.ok(call.body.tools.some((t: any) => t.function.name === (item.group === 'skills' ? 'teach_skill' : 'delegate')));
      }
    }
    console.log('  ✓ 20 个生产请求经 llmFetch 发真 HTTP（本地协议桩），四组每组 5，题库/工具/提示词不缺失');
    const wrong = rows.map((r, i) => i === 3 || i === 17 ? { ...r, predicted: 'wrong-answer', correct: false } : r);
    const degraded = score20(wrong);
    assert.equal(degraded.correct, 18); assert.equal(degraded.byGroup.routing.correct, 4);
    assert.equal(degraded.byGroup.skills.correct, 4);
    assert.equal(degraded.accuracy, 0.9);
    console.log('  ✓ 故意换错两题：得分确实由 20 降到 18，按组计数不串');
    const partial = score20(rows.map((r, i) => i === 9 ? { ...r, predicted: 'unavailable', error: 'HTTP_429', correct: false } : r));
    assert.equal(partial.complete, false); assert.equal(partial.accuracy, null);
    assert.throws(() => score20(rows.slice(0, 19)), /缺失/);
    console.log('  ✓ HTTP 失败/少一题不输出准确率，不能把未跑完伪装成 20 题结果');
    console.log('20题离线评分机制 PASS 3 / FAIL 0 —— 预置答案不是模型预测，绝不作为真实准确率。');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}
main().catch((e) => { console.error('离线评分机制失败：', (e as Error).message); process.exitCode = 1; });
