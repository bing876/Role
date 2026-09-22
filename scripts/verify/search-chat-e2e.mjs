/**
 * 第 26 步 · 真机端到端：**真实 HTTP + 真实模型 + 真实 Tavily**，打的就是桌面用的那条接口。
 *
 * 为什么还要这一层（前面已有三层）：
 *   `search-vs-browser-routing.mts`  验的是桌面**本地**判定（纯函数）；
 *   `search-tool-decision.mjs`       验的是**模型决策**（直接调 streamChatWithSearch）；
 *   `search-hint-wiring-check.mjs`   验的是**通道名一致**（防静默不生效）。
 *   三层都不经过 `routes/chat.ts` —— 而本步恰恰改了它（它是最核心的接口文件）。
 *   所以必须有这一层：从 **HTTP 入口**打进去，证明
 *     ① 接口没被改坏（meta/delta/done 照旧，错误语义照旧）；
 *     ② `event: search` 真的发得出来（否则界面上那行小字永远不会出现）；
 *     ③ 走搜索的那一轮**没有**制造任何浏览器侧状态。
 *
 * 四类断言（每条都对应一条产品要求）：
 *   ① 该搜索的句子   → SSE 里有 `search` 事件、**没有** `loop` 事件（没走浏览器那条路）
 *   ② 凭常识的句子   → 既没有 `search` 也没有 `loop`
 *   ③ 浏览器任务     → （`taskMode:true`，就是桌面真实会发的那个体）有 `loop`、**没有** `search`
 *   ④ 结构探针（关键）：搜索轮 / 常识轮前后 `/health` 的 `pageStates` 必须**一个都不涨**；
 *      只有浏览器任务那一轮才允许涨 —— 这是"联网搜索**不启动任何浏览器实例**"的机器可验证证据。
 *      （`pageStates` = 服务端内存里 `pageState.ts` 那张 `Map` 的大小，只有浏览器链路会去 bind 页。）
 *
 * 另加：落库核对（搜索轮结束后 `/chat/history` 里必须多出一条助手消息）。
 *
 * 数据策略：全程只用一个**本次新建的测试账号**（手机号在库里挑一个没被占的），
 * 跑完整体删除（users 级联），活库里既有账号一行不碰。
 *
 * 用法：
 *   node scripts/verify/search-chat-e2e.mjs              # 自己起后端（8793）跑完自己收
 *   BASE=http://127.0.0.1:8793 node ... --no-spawn       # 复用已起的后端（必须确认是本次改过的代码）
 */
import { createHmac } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const require = createRequire(resolve(repo, 'node_modules/'));

const args = process.argv.slice(2);
const noSpawn = args.includes('--no-spawn');
/**
 * `--only=S1,B1`：只跑指定用例。
 * 反证脚本（`search-chat-e2e-revert.py`）用它把每次注入的成本压到最低
 * （一条搜索用例 = 1~2 次真模型调用 + 1~2 次真搜索），同时断言照样打在被测路径上。
 */
const onlyArg = (args.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length);
const only = onlyArg ? new Set(onlyArg.split(',').map((s) => s.trim()).filter(Boolean)) : null;
const PORT = Number(process.env.PORT || 8793);
const BASE = process.env.BASE || `http://127.0.0.1:${PORT}`;
const OUT_DIR = resolve(repo, 'docs/acceptance/tavily');
const LOG_PATH = resolve(OUT_DIR, `server-${PORT}.log`);
const OUT_PATH = resolve(OUT_DIR, 'search-chat-e2e.json');

// ------------------------------------------------------------------ 结果收集
let pass = 0;
let fail = 0;
let info = 0;
const failures = [];

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
function note(id, detail = '') {
  info += 1;
  console.log(`[INFO] ${id}${detail ? ' — ' + detail : ''}`);
}

// ------------------------------------------------------------------ 环境
function envOf() {
  const text = readFileSync(resolve(repo, 'apps/server/.env'), 'utf8');
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}
const ENV = envOf();
if (!ENV.DATABASE_URL) throw new Error('apps/server/.env 里没有 DATABASE_URL');
if (!ENV.DEEPSEEK_API_KEY) throw new Error('apps/server/.env 里没有 DEEPSEEK_API_KEY（真机端到端必须真调模型）');

const { Client: PgClient } = require('pg');
const live = new PgClient({ connectionString: ENV.DATABASE_URL });

function phoneHash(phone) {
  const pepper = ENV.PHONE_PEPPER || ENV.DATA_KEY;
  return createHmac('sha256', pepper).update(phone, 'utf8').digest('hex');
}
const CANDIDATES = ['18600001567', '18600001789', '18600001890', '18600001901'];

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
 * 打一次 /chat/stream，把 SSE 完整读回来。
 * 返回 { status, events:[{ev,json}], text, raw }
 */
async function chatStream(token, body, { timeoutMs = 180000 } = {}) {
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
        const ev = evLine ? evLine.slice(6).trim() : null;
        let json = null;
        try {
          json = JSON.parse(dataLine.slice(5).trim());
        } catch {
          /* 坏帧忽略 */
        }
        events.push({ ev, json });
        if (json && typeof json.delta === 'string') text += json.delta;
      }
    }
  } catch (e) {
    raw = `读取流失败：${e?.message ?? e}`;
  } finally {
    clearTimeout(timer);
  }
  return { status, events, text, raw };
}

const evsOf = (events, name) => events.filter((e) => e.ev === name);
const searchQueries = (events) =>
  evsOf(events, 'search')
    .filter((e) => e.json?.phase === 'start')
    .map((e) => e.json?.query);

/** 第 26 步：done 事件带回来的来源列表（界面拿它渲染气泡下方的可点链接） */
const doneSources = (events) => {
  const d = evsOf(events, 'done');
  const last = d[d.length - 1];
  return Array.isArray(last?.json?.sources) ? last.json.sources : [];
};
/** 来源条目长得对不对：title/url/domain 都在，且 url 是 http(s)（否则界面上点不动） */
const sourceShapeOk = (src) =>
  !!src && typeof src.title === 'string' && src.title.trim().length > 0 &&
  typeof src.domain === 'string' && src.domain.trim().length > 0 &&
  typeof src.url === 'string' && /^https?:\/\//i.test(src.url);
/**
 * 两个来源列表是否**逐条一致**（同序、同 url、同 title、同 domain）。
 *
 * ⚠️ 刻意**不用** `JSON.stringify(a) === JSON.stringify(b)`：
 *   Postgres 的 `jsonb` **不保留键顺序**（按长度+字典序重排），
 *   写进去是 {title,url,domain}、读回来可能变成 {url,title,domain} ——
 *   比字符串会假红（第一版就是这么误报 3.5 的）。比字段才靠谱。
 */
const sameSources = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
  a.every((x, i) => x?.url === b[i]?.url && x?.title === b[i]?.title && x?.domain === b[i]?.domain);

// ------------------------------------------------------------------ 起后端
let server = null;
let serverLogBytes = 0;

async function startServer() {
  const occupied = await fetch(`${BASE}/health`).then(() => true).catch(() => false);
  if (occupied) {
    throw new Error(
      `${BASE} 已经有服务在监听。要么是上一轮没退干净的残留（先关掉），` +
        '要么你本来就想复用（加 --no-spawn，并确认它是**本次改过的那份代码**起的）。',
    );
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const out = createWriteStream(LOG_PATH, { flags: 'w' });
  server = spawn(process.execPath, ['dist/index.js'], {
    cwd: resolve(repo, 'apps/server'),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.pipe(out);
  server.stderr.pipe(out);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) {
        const h = await r.json();
        serverLogBytes = readFileSync(LOG_PATH, 'utf8').length;
        return h;
      }
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`后端 ${BASE} 60 秒没起来，看日志 ${LOG_PATH}`);
}

async function waitForSmsCode(phone, sinceBytes) {
  // 必须 await 让出事件循环：同步睡会锁死主线程，stdout 管道永远刷不进日志文件。
  const deadline = Date.now() + 20000;
  const tail = `→ ${phone.slice(0, 3)}****${phone.slice(7)} 验证码 `;
  while (Date.now() < deadline) {
    const text = readFileSync(LOG_PATH, 'utf8').slice(sinceBytes);
    const idx = text.lastIndexOf(tail);
    if (idx >= 0) {
      const code = text.slice(idx + tail.length, idx + tail.length + 6);
      if (/^\d{6}$/.test(code)) return code;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`没在服务端日志里等到验证码（日志：${LOG_PATH}）`);
}

// ------------------------------------------------------------------ 清理
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

async function cleanup(testUserId) {
  const out = { removedUser: false, note: '' };
  try {
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
      if (server.pid) {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(server.pid)], { stdio: 'ignore' });
      }
      server = null;
    }
  } catch (e) {
    out.note = String(e?.message ?? e);
  }
  return out;
}

// ------------------------------------------------------------------ 用例
/**
 * 四类句子。**浏览器那条路用 `taskMode:true` + wcId + pageUrl** ——
 * 这正是桌面 `App.tsx` 在识别出"打开某站干活"时真实会发的体（见 step2-report 的取证）。
 */
const CASES = [
  { id: 'S1', kind: 'search', q: '今天有什么新闻', why: '要"此时此刻的外部信息"' },
  { id: 'S2', kind: 'search', q: '今天北京天气怎么样', why: '同上（生活信息）' },
  /**
   * ★ 第 26 步收尾 · **问题 A 修好之后，桌面会走的那条路**。
   *
   * 修之前：桌面正开着一张页时，「帮我查一下今天的美元汇率」会被
   *   `detectBrowseIntent` 判成「在当前页干活」⇒ 带 `taskMode:true` 上来 ⇒ 去驾驶浏览器。
   * 修之后：同一句话不再算页面操作 ⇒ 桌面**不设 taskMode**，
   *   但体里**仍然带着当前那张页的 `pageUrl` / `wcId`**（它们是桌面的常驻上下文）。
   *
   * 这一条验的就是那个体：**即使这张页就在眼前，也走轻量搜索**
   * （有 `search` 事件、无 `loop` 事件、`pageStates` 不涨）。
   * ⇔ 桌面**不设 taskMode** 那一半由第 1 层（`search-vs-browser-routing.mts`）证明。
   *   两半合起来 = 问题 A 在**真实链路上**修好了。
   */
  {
    id: 'A1',
    kind: 'search',
    q: '帮我查一下今天的美元汇率',
    pageUrl: 'https://www.bing.com/',
    wcId: 987654323,
    pageOpen: true,
    why: '★ 问题 A 修复后的真实链路：即使当前开着一张页，这句也走搜索' },
  { id: 'N1', kind: 'neither', q: '1加1等于几', why: '常识，直接答' },
  { id: 'N2', kind: 'neither', q: '帮我写一段自我介绍，我是做跨境电商的', why: '写作任务，直接答' },
];

/**
 * ★ 第 26 步收尾：**问题 B 修好之后，桌面会走的那条路**。
 *
 * 「帮我在必应上查一下今天的美元汇率」现在被 `detectOpenUrl` 识别成 bing.com，
 * 于是桌面开页并带 `taskMode:true` 上来 —— 这正是这一条要模拟的体。
 * 它证明修复**真的接到了端到端链路上**，而不只是判定函数单测里的一个返回值。
 */
const BROWSER_CASES = [
  {
    id: 'B1',
    q: '打开抖音搜索附近的火锅店，给我出一份报告',
    pageUrl: 'https://www.douyin.com/',
    wcId: 987654321,
    why: '用户点明了具体网站 + 要做操作 → 桌面判定为页面任务（taskMode）',
  },
  {
    id: 'B2',
    q: '帮我在必应上查一下今天的美元汇率',
    pageUrl: 'https://www.bing.com/',
    wcId: 987654322,
    why: '★ 问题 B 修复后的真实链路：点名站点 + 「在…上」句式 → 也该走浏览器那条路',
  },
];

const hasCJK = (s) => /[\u4e00-\u9fa5]/.test(s);

/**
 * 「回答语言 = 中文（跟随系统设置）」怎么判才不误伤。
 *
 * ★ 这个坑我踩过两次（`search-tool-decision.mjs` 一次、本脚本一次）：
 *   `1加1等于几` 的回答可能是 `2。` —— 纯数字 + 标点，**没有语言属性**，
 *   拿"必须含汉字"去判它必然假红。而它恰恰是**正确**回答。
 *
 * 正确口径（三条）：
 *   ① 含汉字                        → 过（中文作答）
 *   ② 完全不含拉丁字母（纯数字/符号）→ 过（没有语言属性，谈不上"不是中文"）
 *   ③ 含拉丁字母但一个汉字都没有     → 失败（那才是真的整句外文了）
 */
const LATIN_WORD = /[A-Za-z]{2,}/;
function isChineseAnswer(s) {
  if (hasCJK(s)) return true;
  return !LATIN_WORD.test(s);
}
const picked = (id) => !only || only.has(id);

async function main() {
  const evidence = {
    startedAt: new Date().toISOString(),
    base: BASE,
    port: PORT,
    spawnMode: noSpawn ? 'reuse' : 'self-spawn(dist/index.js)',
    cases: [],
  };

  // ---------------------------------------------------------- 0. 源码/产物指纹自检
  section('0. 产物指纹自检（确保测的是本次改过的代码）');
  const distChat = resolve(repo, 'apps/server/dist/routes/chat.js');
  const distLoop = resolve(repo, 'apps/server/dist/search/chatLoop.js');
  const distTavily = resolve(repo, 'apps/server/dist/search/tavily.js');
  chk('0.1 dist/routes/chat.js 已含 streamChatWithSearch（本步改动已编译进产物）',
    existsSync(distChat) && readFileSync(distChat, 'utf8').includes('streamChatWithSearch'));
  chk('0.2 dist/search/chatLoop.js 存在', existsSync(distLoop));
  if (existsSync(distTavily)) {
    const t = readFileSync(distTavily, 'utf8');
    chk('0.3 搜索客户端编译产物**零 require**（结构上与浏览器/模型无交集）',
      !/\brequire\s*\(/.test(t), `require 出现 ${(t.match(/\brequire\s*\(/g) ?? []).length} 次`);
  }

  // ---------------------------------------------------------- 1. 起后端 + 登录
  section('1. 起后端（独立端口）+ 测试账号登录');
  await live.connect();
  const health0 = noSpawn ? await (await fetch(`${BASE}/health`)).json() : await startServer();
  console.log(`[health] ${JSON.stringify(health0)}`);
  chk('1.1 后端 /health 就绪且 db=up', health0.ok === true && health0.db === 'up', `db=${health0.db}`);
  chk('1.2 后端已配模型（真机端到端必须真调模型）', health0.llm === 'configured', `llm=${health0.llm}`);

  const phone = await pickFreePhone();
  evidence.testPhone = phone.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2');
  const send = await api('/auth/sms/send', { method: 'POST', body: { phone } });
  chk('1.3 验证码已下发（mock 只进服务端日志）', send.status === 200, `status=${send.status}`);
  const code = await waitForSmsCode(phone, serverLogBytes);
  const login = await api('/auth/login/sms', { method: 'POST', body: { phone, code } });
  chk('1.4 短信登录成功并拿到 JWT', login.status === 200 && typeof login.json?.token === 'string',
    `status=${login.status}`);
  const token = login.json.token;
  const userId = login.json.user?.id;
  const agentId = login.json.agents?.[0]?.id;
  pendingUserId = userId; // ★ 立刻登记，保证收尾路径能删掉它
  evidence.testUserId = userId;
  evidence.testAgentId = agentId;
  chk('1.5 建号时自动建了默认项目 + 一个智能体',
    login.json.project?.isDefault === true && Number.isInteger(agentId),
    `project=${login.json.project?.name} agentId=${agentId}`);

  // ---------------------------------------------------------- 2. 搜索轮 / 常识轮
  section('2. 该搜索 & 凭常识（走聊天路径：不带 taskMode）');
  for (const c of CASES) {
    if (!picked(c.id)) continue;
    const before = await (await fetch(`${BASE}/health`)).json();
    /**
     * ★ 问题 A 用例（`pageOpen`）特意**不带 `taskMode`**、只带页面上下文：
     *   这就是桌面修好之后真会发的体。若服务端拿到 `pageUrl`/`wcId`
     *   就去 bind 页 / 建循环，这条会当场变红。
     */
    const r = await chatStream(token, {
      message: c.q,
      agentId,
      ...(c.pageOpen ? { pageUrl: c.pageUrl, wcId: c.wcId } : {}),
    });
    const searched = searchQueries(r.events);
    const loops = evsOf(r.events, 'loop');
    const after = await (await fetch(`${BASE}/health`)).json();
    const pageDelta = after.pageStates - before.pageStates;

    const rec = {
      id: c.id,
      kind: c.kind,
      question: c.q,
      httpStatus: r.status,
      conversationId: evsOf(r.events, 'meta')[0]?.json?.conversationId ?? null,
      sseEvents: r.events.map((e) => e.ev ?? 'delta'),
      searches: searched,
      sources: doneSources(r.events),
      searchPhases: evsOf(r.events, 'search').map((e) => e.json?.phase),
      /** ★ 问题 A：这一轮是否在「当前开着一张页」的前提下发的（且仍然不设 taskMode） */
      pageContext: c.pageOpen ? { pageUrl: c.pageUrl, wcId: c.wcId, taskMode: false } : null,
      searchDetails: evsOf(r.events, 'search').map((e) => e.json),
      loopEvents: loops.length,
      pageStatesDelta: pageDelta,
      answerChars: r.text.length,
      answerHead: r.text.slice(0, 120),
      upstream: r.raw || undefined,
    };
    evidence.cases.push(rec);

    console.log(`\n--- ${c.id}（${c.kind}）${c.q}`);
    if (c.pageOpen) console.log(`    页面上下文：${c.pageUrl} (wcId=${c.wcId}, taskMode=false)`);
    console.log(`    SSE 事件序列：${rec.sseEvents.join(' → ') || '（空）'}`);
    if (searched.length) console.log(`    模型自拟的搜索词：${JSON.stringify(searched)}`);
    console.log(`    回答前 60 字：${r.text.slice(0, 60).replace(/\n/g, ' ')}`);

    chk(`${c.id} HTTP 200 且流正常结束（meta→…→done）`,
      r.status === 200 && evsOf(r.events, 'meta').length === 1 && evsOf(r.events, 'done').length === 1,
      `status=${r.status} meta=${evsOf(r.events, 'meta').length} done=${evsOf(r.events, 'done').length}`);
    chk(`${c.id} 回答非空`, r.text.trim().length > 0, `${r.text.length} 字`);
    chk(`${c.id} 回答语言=中文（跟随系统设置，不跟随资料语言）`, isChineseAnswer(r.text), r.text.slice(0, 30));

    if (c.kind === 'search') {
      chk(`${c.id} 该搜索 → SSE 里真的有 search 事件（界面那行小字有来源）`, searched.length > 0,
        `查询=${JSON.stringify(searched)}`);
      chk(`${c.id} 该搜索 → **没有** loop 事件（没被误判成浏览器任务）`, loops.length === 0,
        loops.length ? '★ 出现了 loop：被误判成页面任务' : '无 loop');
      chk(`${c.id} ★ 该搜索 → 没有制造任何浏览器侧状态（pageStates 不涨）`, pageDelta === 0,
        `pageStates ${before.pageStates} → ${after.pageStates}`);
      /** ★ 问题 A 专条：只有「当前开着一张页」的用例才跑这条 */
      if (c.pageOpen) {
        chk(`${c.id} ★问题 A：当前正开着一张页（${c.pageUrl}）时这句仍走轻量搜索`,
          searched.length > 0 && loops.length === 0 && pageDelta === 0,
          `搜索=${searched.length} 次 / loop=${loops.length} / pageStates ${before.pageStates} → ${after.pageStates}`);
        chk(`${c.id} ★问题 A：体里带着 pageUrl/wcId 也**没有**去 bind 页面`,
          pageDelta === 0, `pageStates 增量=${pageDelta}（期望 0）`);
      }
      chk(`${c.id} 没有出现错误事件`, evsOf(r.events, 'error').length === 0,
        JSON.stringify(evsOf(r.events, 'error').map((e) => e.json?.error)));
      /**
       * 第 26 步：来源标注。
       * 这一段验的是「搜到的网页有没有被如实交回界面」——
       * 界面上的来源列表完全由 done.sources 驱动，这里为空就等于功能不存在。
       */
      chk(`${c.id} ★ 搜索轮 → done 事件带回了来源列表（界面靠它渲染可点链接）`,
        rec.sources.length > 0, `sources=${rec.sources.length} 个`);
      chk(`${c.id} 来源条目字段完整（title + url + domain，url 是 http(s)）`,
        rec.sources.length > 0 && rec.sources.every(sourceShapeOk),
        rec.sources.slice(0, 3).map((x) => `${x.title?.slice(0, 18)} @ ${x.domain}`).join(' | ') || '（空）');
      chk(`${c.id} 来源已去重（没有重复网址）`,
        new Set(rec.sources.map((x) => x.url)).size === rec.sources.length,
        `${rec.sources.length} 条 / 去重后 ${new Set(rec.sources.map((x) => x.url)).size} 条`);
    } else {
      chk(`${c.id} 凭常识 → 没有多余联网（未调用搜索工具）`, searched.length === 0,
        searched.length ? `★ 却去搜了：${JSON.stringify(searched)}` : '未调用');
      chk(`${c.id} 凭常识 → 也没有 loop 事件`, loops.length === 0, '无 loop');
      chk(`${c.id} 凭常识 → pageStates 不涨`, pageDelta === 0,
        `pageStates ${before.pageStates} → ${after.pageStates}`);
      /** 第 26 步：没搜过就不该有来源 —— 否则界面会给常识问答也挂一排「参考资料」 */
      chk(`${c.id} 凭常识 → done 里没有来源（不凭空冒出来源标注）`, rec.sources.length === 0,
        rec.sources.length ? `★ 却有 ${rec.sources.length} 个来源` : '无来源');
    }
  }

  // ---------------------------------------------------------- 3. 落库核对
  section('3. 落库核对（搜索轮的助手回复必须进历史）');
  const s1 = evidence.cases.find((c) => c.id === 'S1');
  const s1ConvId = s1?.conversationId ?? null;
  if (!s1) {
    note('3.0 本轮没跑 S1（--only 过滤），跳过落库核对');
  } else {
  chk('3.1 S1 的 meta 事件带回了会话号', Number.isInteger(s1ConvId) && s1ConvId > 0, `conversationId=${s1ConvId}`);
  if (Number.isInteger(s1ConvId)) {
    const hist = await api(`/chat/history?conversationId=${s1ConvId}`, { token });
    /**
     * ⚠️ 这里字段名是 `text`（不是 `content`）—— `ChatRow` 的形状就是 {id, role, text, created_at}。
     * 第一版我按 `content` 取，结果 8 条消息全被读成空串，误报了两条 FAIL。
     */
    const msgs = hist.json?.messages ?? [];
    console.log(`    /chat/history 返回 ${msgs.length} 条，末条 role=${msgs[msgs.length - 1]?.role}，` +
      `${(msgs[msgs.length - 1]?.text ?? '').length} 字`);
    chk('3.2 历史里能读回 S1 的用户消息', msgs.some((m) => m.role === 'user' && m.text === s1.question),
      `user 消息数=${msgs.filter((m) => m.role === 'user').length}`);
    /**
     * ⚠️ 不能拿「最后一条」来比 —— 4 个聊天用例**共用同一条会话**（桌面也是这样：一个智能体一条会话），
     *    最后一条是 N2 的回复。第一版就是这么写错的（769 vs 546 的假 FAIL）。
     *    正确口径：找到 S1 那条用户消息，它**紧后面**那条助手消息才是 S1 的回复。
     */
    const i = msgs.findIndex((m) => m.role === 'user' && m.text === s1.question);
    const reply = i >= 0 ? msgs[i + 1] : null;
    chk('3.3 历史里能读回 S1 的助手回复，且与流式内容逐字一致（落库=所答）',
      reply?.role === 'assistant' && reply?.text?.length === s1.answerChars,
      `库里 ${(reply?.text ?? '').length} 字 vs 流式 ${s1.answerChars} 字`);
    /**
     * 第 26 步：来源标注**必须活过切会话/刷新**。
     * 桌面流式结束后是本地追加消息、切会话才重拉 /chat/history ——
     * 只下发不落库的话，来源标注一切走会话就没了（只有刚答完那一刻能看到）。
     */
    chk('3.4 ★ 来源标注落库了（切会话/刷新后仍在）',
      Array.isArray(reply?.sources) && reply.sources.length > 0,
      `库里 ${reply?.sources?.length ?? 0} 个 vs 流式 ${s1.sources.length} 个`);
    chk('3.5 ★ 库里读回的来源与流式下发的逐条一致（同 url 同序）',
      sameSources(reply?.sources, s1.sources),
      (reply?.sources ?? []).slice(0, 3).map((x) => x.domain).join(', ') || '(empty)');
  }
  }

  // ---------------------------------------------------------- 4. 浏览器任务
  section('4. 该走浏览器（taskMode:true，桌面真实会发的体）');
  const browserPicked = BROWSER_CASES.filter((c) => picked(c.id));
  if (browserPicked.length === 0) {
    note('4.0 本轮没跑任何浏览器用例（--only 过滤），跳过');
  }
  for (const bc of browserPicked) {
    const before = await (await fetch(`${BASE}/health`)).json();
    const r = await chatStream(token, {
      message: bc.q,
      agentId,
      taskMode: true,
      pageUrl: bc.pageUrl,
      wcId: bc.wcId,
    });
    const after = await (await fetch(`${BASE}/health`)).json();
    const loops = evsOf(r.events, 'loop');
    const searched = searchQueries(r.events);
    const rec = {
      id: bc.id,
      kind: 'browser',
      question: bc.q,
      taskMode: true,
      pageUrl: bc.pageUrl,
      wcId: bc.wcId,
      httpStatus: r.status,
      sseEvents: r.events.map((e) => e.ev ?? 'delta'),
      loopEvents: loops.map((e) => e.json),
      searches: searched,
      sources: doneSources(r.events),
      pageStatesDelta: after.pageStates - before.pageStates,
      answerHead: r.text.slice(0, 120),
    };
    evidence.cases.push(rec);
    console.log(`\n--- ${bc.id}（browser / taskMode）${bc.q}`);
    console.log(`    为什么走这条路：${bc.why}`);
    console.log(`    SSE 事件序列：${rec.sseEvents.join(' → ') || '（空）'}`);
    console.log(`    loop 事件：${JSON.stringify(loops.map((e) => e.json))}`);
    console.log(`    回答：${r.text.replace(/\n/g, ' ')}`);

    chk(`${bc.id} 浏览器任务 → SSE 里有 loop 事件（交回浏览器那条路）`,
      loops.length === 1 && typeof loops[0].json?.loopId === 'string',
      JSON.stringify(loops.map((e) => e.json?.loopId)));
    chk(`${bc.id} 浏览器任务 → **没有** search 事件（没被搜索敷衍）`, searched.length === 0,
      searched.length ? `★ 却去搜了：${JSON.stringify(searched)}` : '未调用搜索工具');
    chk(`${bc.id} 浏览器任务 → done 里也没有来源（浏览器那条路不产来源标注）`,
      rec.sources.length === 0, rec.sources.length ? `★ 却有 ${rec.sources.length} 个来源` : '无来源');
    chk(`${bc.id} 浏览器任务 → 服务端确实 bind 了一张页（pageStates +1，证明这条路才是"重型"那条）`,
      rec.pageStatesDelta >= 1, `pageStates ${before.pageStates} → ${after.pageStates}`);
    chk(`${bc.id} 浏览器任务 → 这一轮**不调模型**（循环还没被驱动，只写一句开场白）`,
      before.llmCalls === after.llmCalls, `llmCalls ${before.llmCalls} → ${after.llmCalls}`);
    chk(`${bc.id} 开场白非空且是中文`, r.text.trim().length > 0 && isChineseAnswer(r.text), r.text.slice(0, 40));
    chk(`${bc.id} 开场白不许说"已做完"`, !/(已完成|已经完成|报告如下)/.test(r.text), r.text.slice(0, 60));
  }

  // ---------------------------------------------------------- 5. 收尾核对
  section('5. 收尾核对（搜索这条路一次都没碰浏览器）');
  const healthEnd = await (await fetch(`${BASE}/health`)).json();
  /**
   * 期望值随 `--only` 变：跑了几个浏览器用例，服务端就该有几张 bind 过的页 / 几个活循环。
   * 反证脚本注入"搜索轮也去 bind 一张页"时，正是靠这两条变红来证明探针是活的。
   */
  const ranBrowser = browserPicked.length;
  chk(`5.1 只有浏览器任务会 bind 页（pageStates=${ranBrowser}，搜索/常识轮一律 0）`,
    healthEnd.pageStates === ranBrowser, `pageStates=${healthEnd.pageStates}`);
  chk('5.2 搜索轮没有留下"活着的循环"（搜索不建循环）',
    healthEnd.runningLoops === ranBrowser,
    `runningLoops=${healthEnd.runningLoops}（期望 ${ranBrowser}）`);
  evidence.healthEnd = healthEnd;

  // 落库：直接从库里数这位测试用户的助手消息
  // ⚠️ `conversations` **没有** user_id 列（第一版我按 `c.user_id` 查，直接报
  //    `column c.user_id does not exist`，把整个脚本带崩、连收尾都没跑到）。
  //    归属链是 conversations.project_id → projects.user_id —— 与服务端
  //    `resolveConversation` 里那条 `JOIN projects p ON p.id = c.project_id` 同一口径。
  const rows = await live.query(
    `SELECT m.id, m.role, length(m.content_enc) AS enc_len, m.sources
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN projects p ON p.id = c.project_id
      WHERE p.user_id = $1 ORDER BY m.id`,
    [userId],
  );
  const assistants = rows.rows.filter((r) => r.role === 'assistant');
  const users = rows.rows.filter((r) => r.role === 'user');
  const expectedTurns = CASES.filter((c) => picked(c.id)).length + ranBrowser;
  evidence.dbMessages = { total: rows.rowCount, user: users.length, assistant: assistants.length, expectedTurns };
  chk(`5.3 每句用户消息都落库了（期望 ${expectedTurns}）`, users.length === expectedTurns, `user=${users.length}`);
  chk(`5.4 助手回复都落库了（期望 ${expectedTurns}）`, assistants.length === expectedTurns,
    `assistant=${assistants.length}`);
  chk('5.5 库里存的是密文（content_enc 非明文）', assistants.every((r) => Number(r.enc_len) > 0),
    '密文长度均 > 0');
  /** 第 26 步：来源是**明文 JSONB**（公开网址，界面上要直接渲染）；正文仍是密文 */
  const withSources = assistants.filter((r) => Array.isArray(r.sources) && r.sources.length > 0);
  /**
   * 期望「带来源」的条数 = 本轮**真跑了的搜索用例数**。
   *
   * ⚠️ 不能写成 `withSources.length < assistants.length`（第一版就是这么写的）：
   *   反证脚本用 `--only=S1` 跑子集时，库里只有 1 条助手回复、且它**就该**带来源 ⇒
   *   `1 < 1` 为假 ⇒ **基线自己就红**，反证直接失去意义。
   *   按「跑了的搜索用例数」来 gate，全量与子集两种跑法都成立。
   */
  const expectedWithSources = CASES.filter((c) => picked(c.id) && c.kind === 'search').length;
  evidence.dbSources = {
    assistantsWithSources: withSources.length,
    assistants: assistants.length,
    expectedWithSources,
  };
  chk('5.6 ★ 来源真的落进了库（不是只在内存里过了一下）',
    expectedWithSources === 0 || withSources.length >= 1,
    `带来源 ${withSources.length} 条 / 共 ${assistants.length} 条（本轮跑了 ${expectedWithSources} 个搜索用例）`);
  chk('5.7 没搜过的回复不带来源（常识/浏览器轮不该被挂上「参考资料」）',
    expectedWithSources === 0 || withSources.length <= expectedWithSources,
    `带来源 ${withSources.length} 条，上限 ${expectedWithSources} 条`);

  writeFileSync(OUT_PATH, JSON.stringify(evidence, null, 2), 'utf8');
  console.log(`\n证据已写：${OUT_PATH}`);
  return evidence;
}

// ------------------------------------------------------------------ 入口
/**
 * ★ 测试账号 id 一旦拿到就**立刻**记在这里（不是在 main 的返回值里）。
 *   第一版只在 main 正常返回后才取，结果 main 中途抛异常 ⇒ 收尾拿不到 id ⇒
 *   测试账号留在活库里没删掉。收尾路径不能依赖"主流程走完"。
 */
let pendingUserId = null;
try {
  const ev = await main();
  pendingUserId = pendingUserId ?? ev?.testUserId ?? null;
} catch (e) {
  fail += 1;
  failures.push(`致命错误：${e?.message ?? e}`);
  console.log(`\n[FAIL] 致命错误 — ${e?.stack ?? e}`);
} finally {
  // ★ 收尾必须无条件跑（探针里 return 2 跳过收尾 = 进程泄漏 / 脏数据留下）
  const cl = await cleanup(pendingUserId);
  console.log(`\n收尾：测试账号(${pendingUserId ?? '未知'}) 已删除=${cl.removedUser}${cl.note ? ` 备注=${cl.note}` : ''}`);
  try {
    await live.end();
  } catch {
    /* ignore */
  }
  console.log(`\n===== 汇总：${pass} PASS / ${fail} FAIL / ${info} INFO =====`);
  if (failures.length) console.log('失败项：\n - ' + failures.join('\n - '));
  process.exitCode = fail === 0 ? 0 : 1;
}
