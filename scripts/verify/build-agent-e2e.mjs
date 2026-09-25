/**
 * QA-02 | 对话式建智能体"说一次就建好" —— 真机端到端(真后端 + 桩模型 + PGlite 文件库)
 * ==========================================================================================
 *   npm run verify:build-agent   （自动 build server + 自己起桩模型/后端,跑完自己收）
 *
 * 用户拍板(QA-02,2026-09-25):建智能体去掉二次确认,**发「建一个销售助手」一次就建好、
 * 不再问确认**。这条验收从 HTTP 入口打进去、回库里(经 /agents)查 —— 只看源码不算数。
 *
 * 环境:PGlite 文件库(沙箱没有真 PostgreSQL;持久化不可靠的问题归 QA-09,本测试不需要重启)。
 * 桩模型只替"上游 LLM",不替任何本项目代码:登录/建号/路由/落库/名单全是真的。
 *
 * 用例:
 *   T1 发「建一个销售助手」→ **一次请求**的回话就含「已建好」+ 名字,全程不出现「确认就建」,
 *      随后 /agents 里真的多了这一个智能体(数量 +1、名字对得上)。
 *   T2 问句「建一个智能体是什么意思」→ 不建(agent 数量不变),正常回落 LLM(桩模型有回话)。
 *   T3 无关键词「今天天气不错」→ 不建,回落 LLM。
 *   T4 规格 C1(2026-09-25):「创建小美，帮我盯店铺数据」任意名字 → 立刻建好 + meta 带 newAgent
 *      (左栏即现真名字的数据源)+ 默认人设且 duty 从原话提取。
 *   T5 任务对象「帮我建个文件夹」→ 不建(是活,不是同事)。
 *   T6 非名词「我需要帮助」→ 不建(不能建出叫「帮助」的同事)。
 *
 * 用法:node scripts/verify/build-agent-e2e.mjs
 */
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const randomHex = (n) => randomBytes(n).toString('hex');

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');

const PORT = Number(process.env.PORT || 8795);
const STUB_PORT = Number(process.env.STUB_PORT || 8899);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = `/tmp/build-agent-e2e-${process.pid}`;
const DB_URL = `pglite://${TMP}/db`;
const LOG_PATH = `${TMP}/server.log`;

let pass = 0;
let fail = 0;
const failures = [];
function chk(id, ok, detail = '') {
  if (ok) pass += 1;
  else {
    fail += 1;
    failures.push(`${id} — ${detail}`.trim());
  }
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id}${detail ? ' — ' + detail : ''}`);
  return Boolean(ok);
}

// ------------------------------------------------------------------ HTTP
async function api(path, { method = 'GET', token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}

/** SSE 流:收集 meta / 全部 delta 拼接 / done */
async function chatStream(token, body) {
  const res = await fetch(`${BASE}/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const lines = text.split('\n');
  let meta = null;
  let deltaText = '';
  let done = null;
  for (const ln of lines) {
    const d = ln.startsWith('data:') ? ln.slice(5).trim() : null;
    if (!d || d === '[DONE]') continue;
    let json;
    try { json = JSON.parse(d); } catch { continue; }
    if (json && json.conversationId !== undefined && json.userMessageId !== undefined) meta = json;
    if (json && typeof json.delta === 'string') deltaText += json.delta;
    if (json && json.contentLength !== undefined && json.searches !== undefined) done = json;
  }
  return { status: res.status, meta, deltaText, done, raw: text };
}

// ------------------------------------------------------------------ 桩模型
function startStub() {
  return new Promise((resolveP, rejectP) => {
    const srv = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        const replyText = '【桩模型】收到。';
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 'stub', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: replyText }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: 'stub', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    srv.listen(STUB_PORT, '127.0.0.1', () => resolveP(srv));
    srv.on('error', rejectP);
  });
}

// ------------------------------------------------------------------ 服务端
function startServer() {
  mkdirSync(TMP, { recursive: true });
  writeFileSync(LOG_PATH, '');
  const out = createWriteStream(LOG_PATH, { flags: 'a' });
  const server = spawn(process.execPath, ['dist/index.js'], {
    cwd: resolve(repo, 'apps/server'),
    env: {
      ...process.env,
      PORT: String(PORT),
      // 每次跑随机生成(库里也是新的,不存在"换 key 登录不上"的问题)
      JWT_SECRET: randomHex(32),
      DATA_KEY: randomHex(32),
      PHONE_PEPPER: randomHex(32),
      DATABASE_URL: DB_URL,
      DEEPSEEK_API_KEY: 'stub-key-not-real',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${STUB_PORT}/v1`,
      DEEPSEEK_MODEL: 'stub-model',
      TAVILY_API_KEY: '',
      SMS_MOCK: '1',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.pipe(out, { end: false });
  server.stderr.pipe(out, { end: false });
  return server;
}

async function waitHealth(deadlineMs = 60000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return await r.json();
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  const tail = existsSync(LOG_PATH) ? readFileSync(LOG_PATH, 'utf8').slice(-1500) : '(无日志)';
  throw new Error(`后端没起来,日志尾部:\n${tail}`);
}

// ------------------------------------------------------------------ 登录
async function waitForSmsCode(phone, sinceBytes) {
  const deadline = Date.now() + 25000;
  const tail = `→ ${phone.slice(0, 3)}****${phone.slice(7)} 验证码 `;
  while (Date.now() < deadline) {
    const text = existsSync(LOG_PATH) ? readFileSync(LOG_PATH, 'utf8').slice(sinceBytes) : '';
    const idx = text.lastIndexOf(tail);
    if (idx >= 0) {
      const code = text.slice(idx + tail.length, idx + tail.length + 6);
      if (/^\d{6}$/.test(code)) return code;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`没在服务端日志里等到验证码`);
}

// ------------------------------------------------------------------ 主流程
const phone = '18600003344';
let serverProc = null;
let stubSrv = null;

async function main() {
  console.log('');
  console.log('=== QA-02 · 建智能体"说一次就建好" e2e(真后端 + 桩模型 + PGlite 文件库) ===');
  console.log(`  后端 :${PORT}  桩模型 :${STUB_PORT}  库 ${DB_URL}`);

  stubSrv = await startStub();
  serverProc = startServer();
  await waitHealth();
  console.log('  后端已就绪');

  const sinceBytes = readFileSync(LOG_PATH, 'utf8').length;
  const send = await api('/auth/sms/send', { method: 'POST', body: { phone } });
  if (send.status !== 200) throw new Error(`发验证码失败 HTTP ${send.status}:${send.text.slice(0, 200)}`);
  const code = await waitForSmsCode(phone, sinceBytes);
  const login = await api('/auth/login/sms', { method: 'POST', body: { phone, code } });
  const token = login.json?.token ?? login.json?.session?.token ?? null;
  if (!token) throw new Error(`登录失败:${login.text.slice(0, 300)}`);
  console.log('  登录成功(新号)');

  const proj = (await api('/projects', { token })).json?.currentProjectId ?? null;
  const list0 = await api(`/agents?projectId=${proj}`, { token });
  const agents0 = list0.json?.agents ?? [];
  const xiaozhu = agents0.find((a) => a.kind === 'assistant');
  if (!xiaozhu) throw new Error(`新号没有自带的小助:${JSON.stringify(list0.json).slice(0, 300)}`);
  const count0 = agents0.length;
  console.log(`  项目 #${proj} 现有智能体 ${count0} 个,小助 #${xiaozhu.id}`);

  // ---------------- T1 一次就建好 ----------------
  const r1 = await chatStream(token, { agentId: xiaozhu.id, message: '建一个销售助手' });
  chk('T1-a 请求成功,拿到 SSE 流(meta + done)', r1.status === 200 && !!r1.meta && !!r1.done,
    `status=${r1.status} meta=${JSON.stringify(r1.meta)?.slice(0, 120)}`);
  chk('T1-b 回话就是"已建好「销售助手」…"(不是问确认)', /已建好「销售助手」/.test(r1.deltaText),
    `回话:${r1.deltaText.slice(0, 120)}`);
  chk('T1-c 全程不出现"确认就建"(二次确认已撤)', !r1.raw.includes('确认就建') && !r1.deltaText.includes('确认'),
    `raw 片段:${r1.raw.slice(0, 80)}`);
  const list1 = await api(`/agents?projectId=${proj}`, { token });
  const agents1 = list1.json?.agents ?? [];
  const sales = agents1.filter((a) => a.name === '销售助手');
  chk('T1-d 库里真的多了"销售助手"(数量 +1,名字对)', agents1.length === count0 + 1 && sales.length === 1,
    `数量 ${count0}→${agents1.length},名字 ${JSON.stringify(agents1.map((a) => a.name))}`);

  // ---------------- T2 问句不建 ----------------
  const r2 = await chatStream(token, { agentId: xiaozhu.id, message: '建一个智能体是什么意思' });
  const list2 = await api(`/agents?projectId=${proj}`, { token });
  chk('T2 问句「建一个智能体是什么意思」→ 不建,回落 LLM(桩模型有回话)',
    (list2.json?.agents ?? []).length === count0 + 1 && r2.status === 200 && r2.deltaText.length > 0,
    `数量=${(list2.json?.agents ?? []).length} 回话:${r2.deltaText.slice(0, 60)}`);

  // ---------------- T3 无关键词不建 ----------------
  const r3 = await chatStream(token, { agentId: xiaozhu.id, message: '今天天气不错' });
  const list3 = await api(`/agents?projectId=${proj}`, { token });
  chk('T3 无关键词「今天天气不错」→ 不建,回落 LLM',
    (list3.json?.agents ?? []).length === count0 + 1 && r3.status === 200 && r3.deltaText.length > 0,
    `数量=${(list3.json?.agents ?? []).length} 回话:${r3.deltaText.slice(0, 60)}`);

  // ---------------- T4 规格 C1:任意名字「创建小美」→ 立刻建好 + meta 带 newAgent(左栏数据源) ----------------
  const r4 = await chatStream(token, { agentId: xiaozhu.id, message: '创建小美，帮我盯店铺数据' });
  const list4 = await api(`/agents?projectId=${proj}`, { token });
  const agents4 = list4.json?.agents ?? [];
  const meimu = agents4.find((a) => a.name === '小美');
  chk('T4-a 「创建小美，帮我盯店铺数据」→ 库里真多出「小美」(数量 +1,任意名字,不要求角色词)',
    agents4.length === count0 + 2 && meimu !== undefined,
    `数量 ${count0 + 1}→${agents4.length} 名字 ${JSON.stringify(agents4.map((a) => a.name))}`);
  chk('T4-b SSE meta 带 newAgent(id/name/persona,左栏即现真名字的数据源)',
    !!r4.meta?.newAgent && Number(r4.meta.newAgent.id) === Number(meimu?.id) && r4.meta.newAgent?.name === '小美',
    `meta.newAgent=${JSON.stringify(r4.meta?.newAgent)?.slice(0, 160)}`);
  chk('T4-c 新智能体带默认人设(who/tone 非空,立刻能聊)且 duty 从原话提取',
    !!meimu?.persona && typeof meimu.persona.duty === 'string' && meimu.persona.duty.includes('盯店铺数据')
      && !!(meimu.persona.who && meimu.persona.tone),
    `persona=${JSON.stringify(meimu?.persona)?.slice(0, 160)}`);

  // ---------------- T5 任务对象不建(「帮我建个文件夹」是活,不是同事) ----------------
  const r5 = await chatStream(token, { agentId: xiaozhu.id, message: '帮我建个文件夹' });
  const list5 = await api(`/agents?projectId=${proj}`, { token });
  chk('T5 任务对象「帮我建个文件夹」→ 不建,回落 LLM',
    (list5.json?.agents ?? []).length === count0 + 2 && r5.status === 200 && r5.deltaText.length > 0,
    `数量=${(list5.json?.agents ?? []).length} 回话:${r5.deltaText.slice(0, 60)}`);

  // ---------------- T6 非名词不建(「我需要帮助」不能建出叫「帮助」的同事) ----------------
  const r6 = await chatStream(token, { agentId: xiaozhu.id, message: '我需要帮助' });
  const list6 = await api(`/agents?projectId=${proj}`, { token });
  chk('T6 非名词「我需要帮助」→ 不建,回落 LLM',
    (list6.json?.agents ?? []).length === count0 + 2 && r6.status === 200 && r6.deltaText.length > 0,
    `数量=${(list6.json?.agents ?? []).length} 回话:${r6.deltaText.slice(0, 60)}`);

  console.log('');
  console.log('=== 结论 ===');
  console.log(`  ${pass} PASS / ${fail} FAIL`);
  if (fail > 0) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    if (existsSync(LOG_PATH)) {
      console.log('  --- 服务端日志尾部 ---');
      console.log(readFileSync(LOG_PATH, 'utf8').slice(-2000));
    }
  }
  process.exitCode = fail > 0 ? 1 : 0;
}

main()
  .catch((err) => {
    console.error('FATAL', err.message ?? String(err));
    if (existsSync(LOG_PATH)) {
      console.log('  --- 服务端日志尾部 ---');
      console.log(readFileSync(LOG_PATH, 'utf8').slice(-2000));
    }
    process.exitCode = 2;
  })
  .finally(() => {
    try { if (serverProc) { spawnSync('taskkill', ['/F', '/T', '/PID', String(serverProc.pid)], { stdio: 'ignore' }); serverProc.kill('SIGKILL'); } } catch { /* */ }
    try { serverProc?.kill('SIGKILL'); } catch { /* */ }
    try { stubSrv?.close(); } catch { /* */ }
    try { rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
    process.exit(process.exitCode ?? 0);
  });
