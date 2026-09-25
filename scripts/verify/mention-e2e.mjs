/**
 * 批次 J · J5 | @点名换人 · **真机端到端**（真后端 + 真 Postgres + 桩模型，打的就是桌面那条接口）
 * ==========================================================================================
 *
 *   npm run verify:mention:e2e      （需要：真库在跑 + apps/server/dist 是本次代码 build 出来的）
 *
 * ★ 为什么解析器（J1）、决定层（J3）、渲染层（J4）都绿了还要这一层：
 *   那三层都不经过 `routes/chat.ts` + 真库 —— 而本批次改的恰恰是「谁开口」这件事**怎么落到库里、
 *   怎么从 /chat/history 回来、怎么进 SSE meta**。这些只有从 HTTP 入口打进去、再回库里查才算证明。
 *   （用户的规矩：DB 验收一律走真库，不做「只看源码」的验收。）
 *
 * ★ 为什么用**桩模型**而不是真模型：
 *   1. R-C 要证明的是「**模型实际收到的正文**里没有 @名字」—— 只有把上游请求原样截下来才证明得了，
 *      真模型的回复内容抖动，证明不了它收到了什么；
 *   2. R-A（忙）与 R-C 边界（只写了 @名字）这两轮**根本不该调模型**，桩这边「请求数 = 0」就是铁证；
 *   3. 不烧 token、不依赖外网、可重复跑（反证脚本要反复注入反复跑）。
 *   桩只替「上游模型」，**不替**任何本项目代码：路由、解析、决定、落库、历史全是真的。
 *
 * ★ T10 验的是用户 2026-09-24 的两项拍板在服务端真的落地了：
 *   决策1（per_round）@ 只换这一轮谁开口、**不改会话归属**；
 *   决策2（allow_with_owner）点名轮**允许**进工具循环，但循环主人仍是会话自己那位。
 *   任务轮那条 SSE 是**故意不关**的长连（等主进程一步步推 step/note/result），所以 T10 用 `stopAfter`
 *   拿到 loop 那一帧就收摊，随后自己调 `/agent/loop/stop` 把循环停掉，不留活循环。
 *
 * ★ 忙碌状态怎么造：`POST /agent/loop/start` 给被点名者建一条真循环 ——
 *   它就是生产里让一个智能体变忙的那条路（resolveAgentStatus 看的就是这张循环表 + registry 名额表），
 *   不是测试专用的假标记。
 *
 * 数据策略：全程只用一个**本次新建的测试账号**（手机号在库里挑一个没被占的），
 * 跑完整体删除（users 级联），活库里既有账号一行不碰。
 *
 * 用法：
 *   node scripts/verify/mention-e2e.mjs                       # 自己起桩模型 + 后端，跑完自己收
 *   DATABASE_URL=postgres://... node scripts/verify/mention-e2e.mjs
 *   BASE=http://127.0.0.1:8794 node ... --no-spawn            # 复用已起的后端（必须是本次代码）
 *   node ... --only=T1,T3                                     # 只跑指定用例（反证注入时省时间）
 */
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const require = createRequire(resolve(repo, 'node_modules/'));

const args = process.argv.slice(2);
const noSpawn = args.includes('--no-spawn');
const onlyArg = (args.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length);
const only = onlyArg ? new Set(onlyArg.split(',').map((x) => x.trim()).filter(Boolean)) : null;

const PORT = Number(process.env.PORT || 8794);
const BASE = process.env.BASE || `http://127.0.0.1:${PORT}`;
const STUB_PORT = Number(process.env.STUB_PORT || 8898);
const OUT_DIR = resolve(repo, 'docs/acceptance/mention');
const LOG_PATH = resolve(OUT_DIR, `server-${PORT}.log`);
const STUB_LOG = resolve(OUT_DIR, 'stub-llm-requests.jsonl');
const OUT_PATH = resolve(OUT_DIR, 'mention-e2e.json');

// ------------------------------------------------------------------ 结果收集
let pass = 0;
let fail = 0;
const failures = [];
const evidence = {};

function section(t) {
  console.log(`\n===== ${t} =====`);
}
function chk(id, ok, detail = '') {
  if (ok) pass += 1;
  else {
    fail += 1;
    failures.push(`${id} — ${detail}`.trim());
  }
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id}${detail ? ' — ' + detail : ''}`);
  return Boolean(ok);
}
function ev(caseId, obj) {
  evidence[caseId] = { ...(evidence[caseId] ?? {}), ...obj };
}

// ------------------------------------------------------------------ 环境
function envOf() {
  const p = resolve(repo, 'apps/server/.env');
  if (!existsSync(p)) throw new Error('缺 apps/server/.env（DATABASE_URL / JWT_SECRET / DATA_KEY / PHONE_PEPPER 都在里面）');
  const out = {};
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}
const ENV = envOf();
/** 库地址：默认用 .env 里那个；验收跑的是**真库**（本次用的是 55432 上的 verifydb），可用环境变量覆盖 */
const DB_URL = process.env.DATABASE_URL || ENV.DATABASE_URL;
if (!DB_URL) throw new Error('没有 DATABASE_URL');
if (!ENV.JWT_SECRET || !ENV.DATA_KEY || !ENV.PHONE_PEPPER) throw new Error('.env 缺 JWT_SECRET / DATA_KEY / PHONE_PEPPER');

const { Client: PgClient } = require('pg');
const live = new PgClient({ connectionString: DB_URL });

function phoneHash(phone) {
  return createHmac('sha256', ENV.PHONE_PEPPER).update(phone, 'utf8').digest('hex');
}
const CANDIDATES = ['18600002567', '18600002789', '18600002890', '18600002901', '18600002912'];

// ------------------------------------------------------------------ HTTP
async function api(path, { method = 'GET', token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 就留 null */
  }
  return { status: res.status, json, text };
}

/**
 * 打一次 /chat/stream，把 SSE 完整读回来（与桌面同一条接口、同一种读法）。
 *
 * `stopAfter(ev)`：**看到这一帧就收摊**（cancel reader + abort fetch），返回已经收到的事件。
 * 为什么需要：任务轮（isTaskMode）那条分支是**故意不关**的长连（registerLoopSse 之后直接 return，
 * 等主进程一步一步把 step/note/result 推回来）。验收脚本没有主进程去驱动它，
 * 干等就是 60 秒超时 + 一条活循环留在内存里。T10 要验的是「有没有发车、发给谁」，
 * 拿到 loop 那一帧就够了 —— 拿到就停，随后自己调 /agent/loop/stop 收拾干净。
 */
async function chatStream(token, body, { timeoutMs = 60000, stopAfter = null } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const events = [];
  let text = '';
  let status = 0;
  let raw = '';
  try {
    const res = await fetch(`${BASE}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    status = res.status;
    if (!res.body) {
      raw = await res.text().catch(() => '');
      return { status, events, text, raw };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split(/\r?\n\r?\n/);
      buf = parts.pop() ?? '';
      for (const block of parts) {
        const lines = block.split(/\r?\n/);
        const evLine = lines.find((l) => l.startsWith('event:'));
        const dataLine = lines.find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        const evName = evLine ? evLine.slice(6).trim() : null;
        let json = null;
        try {
          json = JSON.parse(dataLine.slice(5).trim());
        } catch {
          /* 坏帧忽略 */
        }
        events.push({ ev: evName, json });
        if (json && typeof json.delta === 'string') text += json.delta;
        // 任务轮的长连：拿到想要的那一帧就收摊（见函数头注释）
        if (typeof stopAfter === 'function' && stopAfter({ ev: evName, json })) {
          try { await reader.cancel(); } catch { /* 已经断了就算了 */ }
          ac.abort();
          return { status, events, text, raw, stoppedEarly: true };
        }
      }
    }
  } catch (e) {
    raw = `读取流失败：${e?.message ?? e}`;
  } finally {
    clearTimeout(timer);
  }
  return { status, events, text, raw };
}

const metaOf = (r) => r.events.find((e) => e.ev === 'meta')?.json ?? null;
const mentionOf = (r) => metaOf(r)?.mention ?? null;
const doneOf = (r) => [...r.events].reverse().find((e) => e.ev === 'done')?.json ?? null;
const hasLoop = (r) => r.events.some((e) => e.ev === 'loop');

async function history(token, conversationId) {
  const r = await api(`/chat/history?conversationId=${conversationId}`, { token });
  return Array.isArray(r.json?.messages) ? r.json.messages : [];
}
const lastAssistant = (msgs) => [...msgs].reverse().find((m) => m.role === 'assistant') ?? null;
const lastUser = (msgs) => [...msgs].reverse().find((m) => m.role === 'user') ?? null;

// ------------------------------------------------------------------ 桩模型
/** 桩收到的每一次上游请求（原样留着 —— R-C 的证据就在这里面） */
const stubReqs = [];
let stubServer = null;

function startStub() {
  return new Promise((ok, bad) => {
    stubServer = createServer((req, res) => {
      if (req.method !== 'POST' || !String(req.url).endsWith('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'stub: 只服务 POST */chat/completions' }));
        return;
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let j = {};
        try {
          j = JSON.parse(body || '{}');
        } catch {
          /* 坏体也记下来，好排查 */
        }
        const n = stubReqs.length + 1;
        const rec = {
          n,
          at: Date.now(),
          url: req.url,
          model: j.model ?? null,
          stream: Boolean(j.stream),
          tools: Array.isArray(j.tools) ? j.tools.length : 0,
          messages: Array.isArray(j.messages) ? j.messages : [],
        };
        stubReqs.push(rec);
        try {
          appendFileSync(STUB_LOG, `${JSON.stringify(rec)}\n`);
        } catch {
          /* 记不上不影响验收 */
        }
        const replyText = `【桩回复#${n}】收到，这一轮由我答。`;
        if (rec.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          res.write(
            `data: ${JSON.stringify({
              id: 'stub',
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: { role: 'assistant', content: replyText }, finish_reason: null }],
            })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({
              id: 'stub',
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            })}\n\n`,
          );
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'stub',
              object: 'chat.completion',
              choices: [{ index: 0, message: { role: 'assistant', content: replyText }, finish_reason: 'stop' }],
            }),
          );
        }
      });
    });
    stubServer.on('error', bad);
    stubServer.listen(STUB_PORT, '127.0.0.1', () => ok());
  });
}

/** 桩这边「从第 since 条之后」收到的请求（每个用例前取一次 length，就能算出这轮调了几次模型） */
const stubSince = (since) => stubReqs.slice(since);
/** 一次请求里最后一条 user 消息的正文 —— 这就是「模型实际看到的那句话」 */
const lastUserOf = (rec) => [...(rec?.messages ?? [])].reverse().find((m) => m.role === 'user')?.content ?? null;
const systemOf = (rec) => (rec?.messages ?? []).find((m) => m.role === 'system')?.content ?? '';

// ------------------------------------------------------------------ 起后端
let server = null;
let serverLogBytes = 0;

async function startServer() {
  const occupied = await fetch(`${BASE}/health`).then(() => true).catch(() => false);
  if (occupied) {
    if (!noSpawn) throw new Error(`${BASE} 已经有服务在监听（先关掉，或加 --no-spawn 复用它）`);
    return null;
  }
  if (noSpawn) throw new Error(`--no-spawn 但 ${BASE} 上没有服务`);
  if (!existsSync(resolve(repo, 'apps/server/dist/index.js'))) {
    throw new Error('缺 apps/server/dist/index.js —— 先跑 npm run build -w @ai-workbench/server（验收必须打在本次代码上）');
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const out = createWriteStream(LOG_PATH, { flags: 'w' });
  server = spawn(process.execPath, ['dist/index.js'], {
    cwd: resolve(repo, 'apps/server'),
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL: DB_URL,
      /** 上游一律指向桩：模型名/key 都是假的，真联网一个字节都出不去 */
      DEEPSEEK_API_KEY: 'stub-key-not-real',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${STUB_PORT}/v1`,
      DEEPSEEK_MODEL: 'stub-model',
      TAVILY_API_KEY: '',
      SMS_MOCK: '1',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.pipe(out);
  server.stderr.pipe(out);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) {
        serverLogBytes = readFileSync(LOG_PATH, 'utf8').length;
        return await r.json();
      }
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`后端 ${BASE} 60 秒没起来，看日志 ${LOG_PATH}`);
}

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
  throw new Error(`没在服务端日志里等到验证码（日志：${LOG_PATH}）`);
}

// ------------------------------------------------------------------ 账号与清理
async function pickFreePhone() {
  for (const phone of CANDIDATES) {
    const hash = phoneHash(phone);
    const r = await live.query('SELECT id FROM users WHERE phone_hash = $1', [hash]);
    if (r.rowCount > 0) continue;
    await live.query('DELETE FROM sms_codes WHERE phone_hash = $1', [hash]);
    return phone;
  }
  throw new Error('候选测试手机号在库里都已被占用，换一批');
}

let testUserId = null;
let loopToStop = null;

async function cleanup() {
  const out = { removedUser: false, note: '' };
  try {
    if (loopToStop && tokenGlobal) {
      await api('/agent/loop/stop', { method: 'POST', token: tokenGlobal, body: { loopId: loopToStop, reason: 'verify_cleanup' } }).catch(() => null);
    }
    if (testUserId) {
      const r = await live.query('DELETE FROM users WHERE id = $1', [testUserId]);
      out.removedUser = r.rowCount === 1;
    }
    if (server) {
      try {
        server.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      if (process.platform === 'win32' && server.pid) {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(server.pid)], { stdio: 'ignore' });
      }
      server = null;
    }
    if (stubServer) {
      await new Promise((r) => stubServer.close(r));
      stubServer = null;
    }
    await live.end().catch(() => null);
  } catch (e) {
    out.note = String(e?.message ?? e);
  }
  return out;
}

// ------------------------------------------------------------------ 主流程
let tokenGlobal = null;

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(STUB_LOG, '');
  await live.connect();
  await startStub();
  const health = await startServer();
  section('环境');
  console.log(`  后端 ${BASE}（${health ? '本次自己起的' : '复用外部'}）  桩模型 127.0.0.1:${STUB_PORT}`);
  console.log(`  库 ${DB_URL.replace(/:[^:@/]*@/, ':***@')}`);

  // ---------------- 建号登录 ----------------
  const phone = await pickFreePhone();
  const sinceBytes = existsSync(LOG_PATH) ? readFileSync(LOG_PATH, 'utf8').length : 0;
  const send = await api('/auth/sms/send', { method: 'POST', body: { phone } });
  if (send.status !== 200) throw new Error(`发验证码失败 HTTP ${send.status}：${send.text.slice(0, 200)}`);
  const code = await waitForSmsCode(phone, sinceBytes);
  const login = await api('/auth/login/sms', { method: 'POST', body: { phone, code } });
  const token = login.json?.token ?? login.json?.session?.token ?? null;
  tokenGlobal = token;
  if (!token) throw new Error(`登录失败：${login.text.slice(0, 300)}`);
  const userRow = await live.query('SELECT id FROM users WHERE phone_hash = $1', [phoneHash(phone)]);
  testUserId = Number(userRow.rows[0]?.id);
  console.log(`  测试账号 #${testUserId}（${phone.slice(0, 3)}****${phone.slice(7)}）—— 跑完整体删除`);

  // ---------------- 名单：小助 + 三个自建同事 ----------------
  // ★ GET /agents 不带 projectId 会回**所有项目**的智能体（服务端就是这么写的），
  //   验收要的是「当前项目那一份名单」，所以显式带上项目号 —— 与桌面 App.tsx 同一个口径。
  const proj0 = (await api('/projects', { token })).json?.currentProjectId ?? null;
  const list0 = await api(`/agents?projectId=${proj0}`, { token });
  const xiaozhu = (list0.json?.agents ?? []).find((a) => a.kind === 'assistant') ?? null;
  if (!xiaozhu) throw new Error(`新号没有自带的小助：${JSON.stringify(list0.json).slice(0, 300)}`);
  const creator = (list0.json?.agents ?? []).find((a) => a.canCreateAgents) ?? xiaozhu;

  const toCreate = [
    { name: '研究员', duty: '做行业与竞品调研，找资料并给结论' },
    { name: '文案', duty: '写商品文案与公众号推文' },
    { name: '数据分析', duty: '看店铺数据、算转化率、出周报' },
  ];
  const made = {};
  for (const c of toCreate) {
    const r = await api('/agents', { method: 'POST', token, body: { asAgentId: creator.id, name: c.name, duty: c.duty } });
    const a = r.json?.agent;
    if (!a?.id) throw new Error(`建「${c.name}」失败 HTTP ${r.status}：${r.text.slice(0, 200)}`);
    made[c.name] = a;
  }
  const XZ = xiaozhu.id;
  const YJ = made['研究员'].id;
  const WA = made['文案'].id;
  const SJ = made['数据分析'].id;
  console.log(`  名单：小助#${XZ}、研究员#${YJ}、文案#${WA}、数据分析#${SJ}`);
  ev('setup', { xiaozhu: XZ, yanjiuyuan: YJ, wenan: WA, shuju: SJ, phone: `${phone.slice(0, 3)}****${phone.slice(7)}` });

  // ---------------- T0：先跟小助聊一轮，把会话立起来（也证明「换人之前」发言人是小助） ----------------
  section('T0 基线：会话中途之前，发言人就是小助');
  if (!only || only.has('T0')) {
    const before = stubReqs.length;
    const r0 = await chatStream(token, { agentId: XZ, message: '你好，我们先随便聊聊' });
    const m0 = mentionOf(r0);
    const convA = metaOf(r0)?.conversationId ?? null;
    chk('T0.1 第一轮 200 且拿到了会话号', r0.status === 200 && Number.isInteger(convA), `status=${r0.status} conv=${convA}`);
    chk('T0.2 没写 @ → meta.mention.kind = none（字段恒在，界面不用判空）', m0?.kind === 'none', JSON.stringify(m0));
    chk('T0.3 没写 @ → hits 为空、发言人仍是小助', Array.isArray(m0?.hits) && m0.hits.length === 0 && m0?.speakerAgentId === XZ);
    chk('T0.4 模型收到的正文与用户输入**逐字相同**（没点名时一个字都不动）', lastUserOf(stubSince(before)[0]) === '你好，我们先随便聊聊', JSON.stringify(lastUserOf(stubSince(before)[0])));
    const h0 = await history(token, convA);
    const a0 = lastAssistant(h0);
    chk('T0.5 库里这条助手消息记了发言人 = 小助（speaker_agent_id 真的落库了）', a0?.speaker?.id === XZ, JSON.stringify(a0?.speaker));
    chk('T0.6 历史回来的发言人名字 = 小助（LEFT JOIN 出名字，不是只给个 id）', a0?.speaker?.name === '小助', JSON.stringify(a0?.speaker));
    const u0 = lastUser(h0);
    chk('T0.7 用户行**不带** speaker（用户不是智能体，硬塞一个 id 就是造假）', u0 && u0.speaker === undefined, JSON.stringify(u0));
    ev('T0', { conversationId: convA, assistantSpeaker: a0?.speaker ?? null, modelSaw: lastUserOf(stubSince(before)[0]) });
    globalThis.__convA = convA;
  }

  const convA = globalThis.__convA ?? metaOf(await chatStream(token, { agentId: XZ, message: '继续' }))?.conversationId ?? null;

  // ---------------- T1：会话中途 @ 别人（拍板2 + R-C + 换人 + 落库 + 历史） ----------------
  section('T1 会话中途点名换人：@研究员 @文案 …（第一个才是发言人）');
  if (!only || only.has('T1')) {
    const before = stubReqs.length;
    const msg = '@研究员 @文案 帮我看看这组数据';
    const r = await chatStream(token, { conversationId: convA, message: msg });
    const m = mentionOf(r);
    const reqs = stubSince(before);
    chk('T1.1 200 且有回复', r.status === 200 && r.text.length > 0, `status=${r.status} text=${r.text.slice(0, 40)}`);
    chk('T1.2 meta.mention.kind = switch（会话中途也能换人，不受「新会话才路由」限制）', m?.kind === 'switch', JSON.stringify(m));
    chk('T1.3 拍板2：发言人 = **第一个**命中（研究员），第二个只进 hits', m?.speakerAgentId === YJ && metaOf(r)?.agentId === YJ, JSON.stringify({ sp: m?.speakerAgentId, meta: metaOf(r)?.agentId }));
    chk('T1.4 hits 两个都在、顺序与用户写的一致', JSON.stringify((m?.hits ?? []).map((h) => h.agentId)) === JSON.stringify([YJ, WA]), JSON.stringify(m?.hits));
    chk('T1.5 这一轮只调了一次模型', reqs.length === 1, `桩收到 ${reqs.length} 次`);
    chk('T1.6 ★R-C：**模型实际收到的正文**里没有 @名字（库里存的是原文，两件事分开）', lastUserOf(reqs[0]) === '帮我看看这组数据', JSON.stringify(lastUserOf(reqs[0])));
    const sys = systemOf(reqs[0]);
    chk('T1.7 系统提示词换成了被点名者的人设（提到研究员，且不再是「你是小助」）', sys.includes('研究员') && !sys.includes('你是「小助」'), sys.slice(0, 80));
    chk('T1.8 这一轮没有 loop 事件 —— 因为「帮我看看这组数据」不是页面任务（**不是**因为点了名：见 T10，点名轮该发车照样发车）', !hasLoop(r));
    const h = await history(token, convA);
    const a = lastAssistant(h);
    const u = lastUser(h);
    chk('T1.9 库里这条助手消息的发言人 = 研究员（speaker_agent_id 落库）', a?.speaker?.id === YJ, JSON.stringify(a?.speaker));
    chk('T1.10 历史回来的名字 = 研究员（口径与同事名单一致：persona.name 优先）', a?.speaker?.name === '研究员', JSON.stringify(a?.speaker));
    chk('T1.11 用户行存的是**原文**（含 @名字 —— 气泡要显示用户真打了什么）', u?.text === msg, JSON.stringify(u?.text));
    chk('T1.12 同一条会话里，换人之前那句的发言人仍是小助（两句归属不同 = 换人这件事看得出来）', (() => {
      const assistants = h.filter((x) => x.role === 'assistant');
      const prev = assistants.length >= 2 ? assistants[assistants.length - 2] : null;
      return prev?.speaker?.id === XZ;
    })(), JSON.stringify(h.filter((x) => x.role === 'assistant').map((x) => x.speaker)));
    ev('T1', {
      message: msg,
      mention: m,
      modelSaw: lastUserOf(reqs[0]),
      systemHead: sys.slice(0, 120),
      storedUserText: u?.text ?? null,
      assistantSpeaker: a?.speaker ?? null,
      prevAssistantSpeaker: h.filter((x) => x.role === 'assistant').slice(-2, -1)[0]?.speaker ?? null,
    });
  }

  // ---------------- T2：R-B @ 自己 ----------------
  section('T2 R-B：@ 的就是当前发言人（小助）→ 视作没写 @');
  if (!only || only.has('T2')) {
    const before = stubReqs.length;
    const r = await chatStream(token, { conversationId: convA, message: '@小助 你觉得呢' });
    const m = mentionOf(r);
    const reqs = stubSince(before);
    chk('T2.1 不报错：200 且照常答话', r.status === 200 && r.text.length > 0, `status=${r.status} raw=${r.raw.slice(0, 60)}`);
    chk('T2.2 kind = self（不是 switch，也不是 error）', m?.kind === 'self', JSON.stringify(m));
    chk('T2.3 发言人没变（仍是会话原来的小助 —— 没有「重新路由到自己」这种多余动作）', m?.speakerAgentId === XZ && metaOf(r)?.agentId === XZ, JSON.stringify({ sp: m?.speakerAgentId, meta: metaOf(r)?.agentId }));
    chk('T2.4 R-C 照样生效：模型收到的正文里没有 @小助', reqs.length === 1 && lastUserOf(reqs[0]) === '你觉得呢', JSON.stringify(lastUserOf(reqs[0])));
    const h = await history(token, convA);
    chk('T2.5 库里这句的发言人仍是小助', lastAssistant(h)?.speaker?.id === XZ, JSON.stringify(lastAssistant(h)?.speaker));
    ev('T2', { mention: m, modelSaw: lastUserOf(reqs[0]), assistantSpeaker: lastAssistant(h)?.speaker ?? null });
  }

  // ---------------- T3：R-A 忙 ----------------
  section('T3 R-A：被点名者正在跑循环（真忙）→ 不静默改派，回一句人话');
  if (!only || only.has('T3')) {
    const loop = await api('/agent/loop/start', { method: 'POST', token, body: { agentId: YJ, goal: '把这份行业资料整理成结论' } });
    const loopId = loop.json?.loopId ?? null;
    loopToStop = loopId;
    chk('T3.0 前置：给研究员建了一条真循环（生产里让它变忙的就是这条路）', Boolean(loopId), JSON.stringify(loop.json).slice(0, 160));

    const before = stubReqs.length;
    const msg = '@研究员 再看一眼那份数据';
    const r = await chatStream(token, { conversationId: convA, message: msg });
    const m = mentionOf(r);
    const reqs = stubSince(before);
    chk('T3.1 kind = busy（服务端认出它正忙）', m?.kind === 'busy', JSON.stringify(m));
    chk('T3.2 ★没有静默改派：发言人不是研究员', m?.speakerAgentId !== YJ, JSON.stringify(m?.speakerAgentId));
    chk('T3.3 ★这一轮**一次模型都没调**（告知是服务端自己说的，不冒充模型）', reqs.length === 0, `桩收到 ${reqs.length} 次`);
    chk('T3.4 回复流里就是那句告知：说了它在做什么', /研究员/.test(r.text) && /(正在|手上|忙|等)/.test(r.text), r.text.slice(0, 120));
    chk('T3.5 告知里给了两条路：等它 / 换人（R-A 要求「询问是否等待或改派」）', /等/.test(r.text) && /(别的智能体|换)/.test(r.text), r.text.slice(0, 200));
    chk('T3.6 meta.notice 与流里的正文一致（界面对账用，不含用户正文）', typeof m?.notice === 'string' && m.notice === r.text, JSON.stringify(m?.notice)?.slice(0, 80));
    chk('T3.7 没有发车（没 loop 事件）', !hasLoop(r));
    const h = await history(token, convA);
    const a = lastAssistant(h);
    chk('T3.8 告知也落库了，且发言人**不是**那个正忙的（不让它替自己开口）', a?.text === r.text && a?.speaker?.id !== YJ, JSON.stringify({ sp: a?.speaker, text: (a?.text ?? '').slice(0, 40) }));
    chk('T3.9 用户行仍存原文（含 @研究员）', lastUser(h)?.text === msg, JSON.stringify(lastUser(h)?.text));
    ev('T3', { loopId, mention: m, replyText: r.text, stubCalls: reqs.length, storedSpeaker: a?.speaker ?? null });

    // 释放之后再点一次：证明拦住它的确实是「忙」
    await api('/agent/loop/stop', { method: 'POST', token, body: { loopId, reason: 'verify_done' } });
    loopToStop = null;
    await new Promise((r2) => setTimeout(r2, 300));
    const before2 = stubReqs.length;
    const r2 = await chatStream(token, { conversationId: convA, message: msg });
    const m2 = mentionOf(r2);
    chk('T3.10 反例：循环停掉之后同一条消息就能换人（不是把研究员永久拉黑）', m2?.kind === 'switch' && m2?.speakerAgentId === YJ && stubSince(before2).length === 1, JSON.stringify(m2));
    ev('T3', { afterStop: m2 });
  }

  // ---------------- T4：R-C 边界（只写了 @名字） ----------------
  section('T4 R-C 边界：整条只写了 @数据分析 → 反问要做什么，不调模型');
  if (!only || only.has('T4')) {
    const before = stubReqs.length;
    const r = await chatStream(token, { conversationId: convA, message: '@数据分析' });
    const m = mentionOf(r);
    chk('T4.1 kind = empty', m?.kind === 'empty', JSON.stringify(m));
    chk('T4.2 ★一次模型都没调（拿空正文去问模型只会得到废话）', stubSince(before).length === 0, `桩收到 ${stubSince(before).length} 次`);
    chk('T4.3 反问里点了名、并要用户补一句要做什么', /数据分析/.test(r.text) && /(做什么|要做的事)/.test(r.text), r.text.slice(0, 120));
    const h = await history(token, convA);
    chk('T4.4 这句反问由**被点名者自己**开口（它此刻不忙，最自然）', lastAssistant(h)?.speaker?.id === SJ, JSON.stringify(lastAssistant(h)?.speaker));
    chk('T4.5 用户行存原文（就是那个光秃秃的 @数据分析）', lastUser(h)?.text === '@数据分析', JSON.stringify(lastUser(h)?.text));
    ev('T4', { mention: m, replyText: r.text, stubCalls: stubSince(before).length, speaker: lastAssistant(h)?.speaker ?? null });
  }

  // ---------------- T5：拍板1（@ 与名字之间有空格） ----------------
  section('T5 拍板1：@ 与名字之间有空格 → 不算点名');
  if (!only || only.has('T5')) {
    const before = stubReqs.length;
    const msg = '@ 研究员 你好';
    const r = await chatStream(token, { conversationId: convA, message: msg });
    const m = mentionOf(r);
    const reqs = stubSince(before);
    chk('T5.1 kind = none（不换人）', m?.kind === 'none', JSON.stringify(m));
    chk('T5.2 发言人仍是会话原来的小助', m?.speakerAgentId === XZ, JSON.stringify(m?.speakerAgentId));
    chk('T5.3 hits 为空（那个 @ 根本没被当成点名）', (m?.hits ?? []).length === 0, JSON.stringify(m?.hits));
    chk('T5.4 正文**原样**交给模型（没点名就不动用户一个字，连空白都不收拾）', reqs.length === 1 && lastUserOf(reqs[0]) === msg, JSON.stringify(lastUserOf(reqs[0])));
    const h = await history(token, convA);
    chk('T5.5 库里这句的发言人还是小助', lastAssistant(h)?.speaker?.id === XZ, JSON.stringify(lastAssistant(h)?.speaker));
    ev('T5', { message: msg, mention: m, modelSaw: lastUserOf(reqs[0]) });
  }

  // ---------------- T6：邮箱里的 @ ----------------
  section('T6 邮箱里的 @ 不算点名（foo@研究员.com）');
  if (!only || only.has('T6')) {
    const before = stubReqs.length;
    const msg = '把结论发到 foo@研究员.com 谢谢';
    const r = await chatStream(token, { conversationId: convA, message: msg });
    const m = mentionOf(r);
    chk('T6.1 kind = none（域名里那个 @ 不是点名）', m?.kind === 'none', JSON.stringify(m));
    chk('T6.2 正文原样交给模型', lastUserOf(stubSince(before)[0]) === msg, JSON.stringify(lastUserOf(stubSince(before)[0])));
    chk('T6.3 发言人没变', m?.speakerAgentId === XZ);
    ev('T6', { message: msg, mention: m });
  }

  // ---------------- T7：跨项目点不到 ----------------
  section('T7 规则4：切到别的项目 → 原项目的人点不到（名单按项目算）');
  if (!only || only.has('T7')) {
    // 建项目2 之前先记下项目1 的号（POST /projects 会把新项目设成当前，之后就分不清了）
    const proj1 = (await api('/projects', { token })).json?.currentProjectId ?? null;
    const p2 = await api('/projects', { method: 'POST', token, body: { name: '第二项目' } });
    const proj2 = p2.json?.project?.id ?? null;
    const curAfter = (await api('/projects', { token })).json?.currentProjectId ?? null;
    chk('T7.0a 前置：建了项目2 之后，当前项目确实切到了项目2（名单该跟着换）', curAfter === proj2 && proj2 !== proj1, JSON.stringify({ proj1, proj2, curAfter }));
    chk('T7.0 前置：第二个项目建好了', Number.isInteger(proj2), JSON.stringify(p2.json).slice(0, 160));
    // 新项目里建一个「外协」，它只属于项目 2
    const list2 = await api(`/agents?projectId=${proj2}`, { token });
    const creator2 = (list2.json?.agents ?? []).find((a) => a.canCreateAgents) ?? null;
    let waixie = null;
    if (creator2) {
      const rr = await api('/agents', { method: 'POST', token, body: { asAgentId: creator2.id, name: '外协', duty: '对接外部供应商' } });
      waixie = rr.json?.agent ?? null;
    }
    chk('T7.0b 前置：项目2 里有了「外协」（projectId 必须是项目2，否则这条用例验不到跨项目）', Boolean(waixie?.id) && waixie?.projectId === proj2, JSON.stringify({ id: waixie?.id, projectId: waixie?.projectId, proj2 }));

    // 此刻当前项目 = 项目2；拿项目1 的会话去点项目1 的人 → 点不到
    const before = stubReqs.length;
    const r = await chatStream(token, { conversationId: convA, message: '@小助 你在吗' });
    const m = mentionOf(r);
    chk('T7.1 当前项目是项目2 时，@小助（项目1 的人）不命中 → kind = none', m?.kind === 'none', JSON.stringify(m));
    chk('T7.2 名单外的名字进了 unknown（排查「@ 了没反应」的证据，不影响路由）', (m?.unknown ?? []).includes('小助'), JSON.stringify(m?.unknown));
    chk('T7.3 没换人：发言人仍是这条会话本来的小助', m?.speakerAgentId === XZ, JSON.stringify(m?.speakerAgentId));
    chk('T7.4 正文原样交给模型（没命中就不剥）', lastUserOf(stubSince(before)[0]) === '@小助 你在吗', JSON.stringify(lastUserOf(stubSince(before)[0])));

    // 切回项目1，再点「外协」（项目2 的人）→ 同样点不到
    // ★ POST 必须带个空对象：Fastify 对「content-type: application/json + 空 body」直接 400，
    //   第一版就是这里静默失败 —— 当前项目没切回来，后面两条断言全红（红的是脚本，不是产品）。
    const act = proj1 === null ? null : await api(`/projects/${proj1}/activate`, { method: 'POST', token, body: {} });
    chk('T7.6a 前置：切回项目1 成功（currentProjectId 真的变回来了）', (act?.json?.project?.id ?? null) === proj1, JSON.stringify(act?.json ?? act?.status));
    const before2 = stubReqs.length;
    const r2 = await chatStream(token, { conversationId: convA, message: `@外协 来一下` });
    const m2 = mentionOf(r2);
    chk('T7.5 切回项目1 后，@外协（项目2 的人）不命中 → kind = none', m2?.kind === 'none', JSON.stringify(m2));
    chk('T7.6 同上，unknown 里记着「外协」', (m2?.unknown ?? []).includes('外协'), JSON.stringify(m2?.unknown));
    // 切回项目1 之后，项目1 的人重新点得到（证明是「按项目」而不是「点名功能坏了」）
    const before3 = stubReqs.length;
    const r3 = await chatStream(token, { conversationId: convA, message: '@文案 换你来看' });
    const m3 = mentionOf(r3);
    chk('T7.7 反例：切回项目1 之后 @文案 又能换人（不是把点名功能整个关掉了）', m3?.kind === 'switch' && m3?.speakerAgentId === WA && stubSince(before3).length === 1, JSON.stringify(m3));
    ev('T7', { proj1, proj2, waixie: waixie?.id ?? null, inProj2: m, backInProj1: m2, switchAgain: m3, stubCallsT7_4: stubSince(before2).length });
  }

  // ---------------- T8：老数据（speaker_agent_id 为 NULL） ----------------
  section('T8 老数据：speaker_agent_id 为 NULL 的行 → 历史回 undefined（不猜、不冒充）');
  if (!only || only.has('T8')) {
    const h0 = await history(token, convA);
    const target = [...h0].reverse().find((x) => x.role === 'assistant' && x.speaker?.id) ?? null;
    chk('T8.0 前置：找到一条有发言人的助手消息用来「变老」', Boolean(target?.id), JSON.stringify(target?.speaker));
    if (target) {
      // 直接把它改成「本批次之前入库」的样子：speaker_agent_id = NULL（正文密文一个字节不动）
      await live.query('UPDATE messages SET speaker_agent_id = NULL WHERE id = $1', [target.id]);
      const h1 = await history(token, convA);
      const row = h1.find((x) => x.id === target.id) ?? null;
      chk('T8.1 历史里这一行的 speaker 是 undefined（不是 null、不是 0、不是当前智能体）', row && row.speaker === undefined, JSON.stringify(row?.speaker));
      chk('T8.2 正文一个字没变（改的是发言人归属，不是内容）', row?.text === target.text);
      chk('T8.3 库里那一列真的是 NULL（不是被接口抹掉的）', (await live.query('SELECT speaker_agent_id FROM messages WHERE id=$1', [target.id])).rows[0]?.speaker_agent_id === null);
      ev('T8', { messageId: target.id, before: target.speaker, after: row?.speaker ?? 'undefined' });
    }
  }

  // ---------------- T9：整条会话的归属账 ----------------
  section('T9 收账：库里这条会话的发言人分布，与这几轮的裁决逐条对得上');
  if (!only || only.has('T9')) {
    const rows = await live.query(
      `SELECT m.id, m.role, m.speaker_agent_id, a.name AS speaker_name, a.persona->>'name' AS persona_name
         FROM messages m LEFT JOIN agents a ON a.id = m.speaker_agent_id
        WHERE m.conversation_id = $1 ORDER BY m.id ASC`,
      [convA],
    );
    const shape = rows.rows.map((r) => ({ id: Number(r.id), role: r.role, sp: r.speaker_agent_id === null ? null : Number(r.speaker_agent_id), name: r.persona_name || r.speaker_name || null }));
    console.log(`      ${JSON.stringify(shape)}`);
    chk('T9.1 所有 user 行的 speaker_agent_id 都是 NULL', shape.filter((x) => x.role === 'user').every((x) => x.sp === null));
    chk('T9.2 至少出现过两个不同的发言人（换人这件事在库里看得见）', new Set(shape.filter((x) => x.role === 'assistant' && x.sp !== null).map((x) => x.sp)).size >= 2, JSON.stringify([...new Set(shape.map((x) => x.sp))]));
    chk('T9.3 没有任何一行指向名单外的智能体（发言人 id 都在这个项目的名单里）', shape.every((x) => x.sp === null || [XZ, YJ, WA, SJ].includes(x.sp)), JSON.stringify(shape.map((x) => x.sp)));
    ev('T9', { conversationId: convA, rows: shape });
  }

  // ---------------- T10：决策2 —— 点名轮**照样能发车**，但循环归会话主人 ----------------
  section('T10 决策2（allow_with_owner）：@别人 + 页面任务 → 发车，且车是会话主人小助在开');
  if (!only || only.has('T10')) {
    /**
     * 这一组用例验的是用户 2026-09-24 的拍板：
     *   决策1（per_round）：@ 只换这一轮谁开口，**不改会话归属**；
     *   决策2（allow_with_owner）：点名轮**允许**进工具循环，但循环主人仍是会话自己那位
     *     （wcId / 页面状态 / 循环名额都是它的，被点名者不接管别人的页）。
     * 所以这里要同时钉住三件事：发了车、车是谁的、会话归属一个字节都没动。
     */
    const ownerBefore = (await live.query('SELECT agent_id FROM conversations WHERE id=$1', [convA])).rows[0]?.agent_id;
    const ownerId = ownerBefore === null || ownerBefore === undefined ? null : Number(ownerBefore);
    chk('T10.0 前置：这条会话的主人是小助（决策1 说 @ 不改归属，那就先记下改之前的样子）', ownerId === XZ, String(ownerBefore));

    const before = stubReqs.length;
    const msg = '@研究员 打开百度搜一下今天的新闻';
    const wcId = 987650101;
    const r = await chatStream(
      token,
      { conversationId: convA, message: msg, taskMode: true, pageUrl: 'https://www.baidu.com', wcId },
      { timeoutMs: 30000, stopAfter: (e) => e.ev === 'loop' },
    );
    const m = mentionOf(r);
    const loopEv = r.events.find((e) => e.ev === 'loop')?.json ?? null;

    chk('T10.1 点名照样成立：meta.mention.kind = switch（发车没有把「点了谁」抹掉）', m?.kind === 'switch', JSON.stringify(m));
    chk('T10.2 ★决策2：这一轮**发了车**（SSE 里有 loop 事件，不再是「点名轮一律走聊天」的旧口径）', Boolean(loopEv?.loopId), JSON.stringify(r.events.map((e) => e.ev)));
    chk('T10.3 ★决策2：车是**会话主人小助**在开（loop.agentId = 小助，不是被点名的研究员）', loopEv?.agentId === XZ, JSON.stringify({ loopAgentId: loopEv?.agentId, XZ, YJ }));
    chk('T10.4 meta.agentId 也是小助（桌面按这一格认「这轮谁在动手」）', metaOf(r)?.agentId === XZ, JSON.stringify(metaOf(r)?.agentId));
    chk('T10.5 ★对账：meta.mention.speakerAgentId 跟着改成小助 —— 否则 meta 说「研究员在答」、库里记的却是小助', m?.speakerAgentId === XZ, JSON.stringify({ speakerAgentId: m?.speakerAgentId, speakerName: m?.speakerName }));
    chk('T10.6 点名事实仍在 meta 里（hits 带着研究员，界面想说「这轮的活由谁在跑」随时说得了）', JSON.stringify((m?.hits ?? []).map((h) => h.agentId)) === JSON.stringify([YJ]), JSON.stringify(m?.hits));
    chk('T10.7 车挂在用户给的那张页上（wcId 原样进了循环，没被换成别人的页）', loopEv?.wcId === wcId, JSON.stringify(loopEv?.wcId));

    // 独立复核：不靠 SSE 那一帧，直接问服务端这条循环记在谁名下
    const info = loopEv?.loopId ? await api(`/agent/loop/info?loopId=${encodeURIComponent(loopEv.loopId)}`, { token }) : null;
    chk('T10.8 复核：/agent/loop/info 也报这条循环的 agentId = 小助、wcId = 那张页', info?.json?.agentId === XZ && info?.json?.wcId === wcId, JSON.stringify(info?.json ?? info?.status));

    // 落库口径：发车轮的开场白由跑循环那位说
    const h = await history(token, convA);
    const a = lastAssistant(h);
    const u = lastUser(h);
    chk('T10.9 库里那句开场白的发言人 = 小助（speaker_agent_id 与 meta 对得上账）', a?.speaker?.id === XZ, JSON.stringify(a?.speaker));
    chk('T10.10 用户行存**原文**（含 @研究员 —— 气泡要显示用户真打了什么，R-C 只作用于给模型/给循环的正文）', u?.text === msg, JSON.stringify(u?.text));

    chk('T10.11 发车轮**不调聊天模型**（桩收到 0 次；发车轮的规矩没被点名改坏）', stubSince(before).length === 0, `桩收到 ${stubSince(before).length} 次`);

    // ★决策1 的交叉验证：发车这件事**不是**靠改会话归属实现的
    const ownerAfter = Number((await live.query('SELECT agent_id FROM conversations WHERE id=$1', [convA])).rows[0]?.agent_id);
    chk('T10.12 ★决策1：发车之后会话归属仍是小助（被点名者没接管这条会话，下一轮不带 @ 还是它答）', ownerAfter === XZ, String(ownerAfter));

    // 收拾：把这条循环停掉（它是内存态，删账号不会带走；留着会占「同时只能有 N 条」的名额）
    const stop = loopEv?.loopId ? await api('/agent/loop/stop', { method: 'POST', token, body: { loopId: loopEv.loopId, reason: 'verify_done' } }) : null;
    chk('T10.13 收尾：循环停掉了（stopped=1，不留活循环）', stop?.json?.stopped === 1, JSON.stringify(stop?.json ?? stop?.status));

    ev('T10', {
      message: msg,
      mention: m,
      loopEvent: loopEv,
      loopInfo: info?.json ?? null,
      metaAgentId: metaOf(r)?.agentId ?? null,
      conversationOwner: { before: ownerId, after: ownerAfter },
      openingSpeaker: a?.speaker ?? null,
      storedUserText: u?.text ?? null,
      stubCalls: stubSince(before).length,
      stopped: stop?.json ?? null,
    });
  }
}

// ------------------------------------------------------------------ 跑
(async () => {
  let exitCode = 0;
  try {
    await main();
  } catch (e) {
    fail += 1;
    failures.push(`EXCEPTION — ${e?.stack ?? e}`);
    console.error(`\n[EXCEPTION] ${e?.message ?? e}`);
  } finally {
    const c = await cleanup();
    section('收尾');
    console.log(`  测试账号删除：${c.removedUser ? '已删（users 级联带走项目/智能体/会话/消息）' : '未删（' + c.note + '）'}`);
    chk('Z1 测试账号跑完就删干净（活库里不留验收 residue）', c.removedUser === true, c.note);
    const summary = {
      at: new Date().toISOString(),
      base: BASE,
      db: DB_URL.replace(/:[^:@/]*@/, ':***@'),
      pass,
      fail,
      failures,
      stubRequests: stubReqs.length,
      evidence,
    };
    try {
      writeFileSync(OUT_PATH, `${JSON.stringify(summary, null, 2)}\n`);
      console.log(`  取证写入 ${OUT_PATH}（桩模型逐次请求：${STUB_LOG}）`);
    } catch (e) {
      console.log(`  取证写入失败：${e?.message ?? e}`);
    }
    console.log(`\n===== 批次 J · J5 端到端：PASS ${pass} / FAIL ${fail} =====`);
    if (fail > 0) {
      console.log('失败清单：');
      for (const f of failures) console.log(`  - ${f}`);
      exitCode = 1;
    }
  }
  process.exit(exitCode);
})();
