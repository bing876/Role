/**
 * R4 发车判定 · 真服务端验收（对齐独立验收报告第 5、6 两项）
 * ---------------------------------------------------------------------------
 * 口径来自 docs/验收报告-独立验收R1-R4-20260922.md：
 *   第 5 项：稍长闲聊不被误判成任务（R4 本体）
 *   第 6 项：正常浏览器任务仍正常触发（回归 / 反向保护）
 *
 * 与 r4-intent-source-parity.mjs 的分工（两个都要跑，缺一不可）：
 *   - parity 脚本测的是**纯函数**（快、无依赖，但只到「判定返回 true/false」为止）
 *   - 本脚本测的是**整条链**：真 HTTP + 真 JWT 登录 + 真 PGlite 建表 + 真 /chat/stream，
 *     断言落在**服务端到底有没有真的建循环**（SSE 里有没有 `event: loop`）+
 *     `/health` 的 liveLoops 计数。判定对了但下游没接上，这里会露出来。
 *
 * 判定证据：POST /chat/stream 的原始 SSE 字节流。
 *   有 `event: loop` = 发车（进任务模式、startLoop 建了工具循环）
 *   无 `event: loop` = 走普通聊天分支（该分支工具表只有 web_search，结构上开不了浏览器）
 *
 * 离线可跑的边界（如实说明）：
 *   - LLM 用服务端**自带**的沙箱桩（ENABLE_DEV_MOCK_LLM=1 → llm.ts 内置），不联网、不烧 token。
 *     桩不参与被测逻辑：发车判定发生在调模型**之前**。
 *   - 库用 PGlite 内存库（db.ts 原生支持 pglite:// 连接串），不需要 Docker/本机 PG。
 *   - CDP 执行器不触发：本验收只看「服务端是否发车」，不驱动浏览器。
 *   ⇒ shouldEnterTaskMode / startLoop / SSE 广播全是仓库真代码，一行没桩。
 *
 * ★★ 反证（这套断言有没有鉴别力，必须自己证明）：
 *   同一套用例在**旧宽松逻辑**（origin/main）上必须第 5 项失败。跑法（不动当前工作区）：
 *
 *     git worktree add /tmp/wb-main origin/main
 *     ln -s "$PWD/node_modules" /tmp/wb-main/node_modules
 *     REPO_DIR=/tmp/wb-main LABEL=main-old EXPECT=fail5 \
 *       node scripts/verify/r4-dispatch-acceptance.mjs
 *     git worktree remove /tmp/wb-main
 *
 *   实测结论（2026-09-22）：main-old 第5项 1/5（4 条闲聊全被误发车）、liveLoops=9；
 *   R4 版第5项 5/5、liveLoops=5。第 6 项两版都 5/5 —— 所以**只有第 5 项有鉴别力**，
 *   单看「任务还能不能发车」是证明不了 R4 生效的。
 *
 * 用法：node scripts/verify/r4-dispatch-acceptance.mjs
 * 环境变量：REPO_DIR（被测代码所在仓库根）/ LABEL（证据文件标签）/ EXPECT=pass|fail5
 * 退出码：0 = 与预期一致；1 = 不一致
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OWN_REPO = path.resolve(HERE, '../..'); // 证据永远写回**本脚本所属**仓库，不写进被测 worktree
const REPO = process.env.REPO_DIR ? path.resolve(process.env.REPO_DIR) : OWN_REPO;
const LABEL = process.env.LABEL || 'HEAD';
const EXPECT = process.env.EXPECT === 'fail5' ? 'fail5' : 'pass';
// 避开既有占用：8787（用户 dev）/ 8798-8799（2a）/ 5273（vite）/ 8899（fake-llm）/ 9333（Electron）
const PORT = Number(process.env.ACCEPT_PORT || 8900 + Math.floor(Math.random() * 90));
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.join(OWN_REPO, 'docs/acceptance/r4-dispatch');
fs.mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ 起服务端 */
async function bootServer() {
  const env = {
    ...process.env,
    PORT: String(PORT),
    DATABASE_URL: 'pglite://memory',
    JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    DATA_KEY: crypto.randomBytes(32).toString('hex'),
    PHONE_PEPPER: crypto.randomBytes(32).toString('hex'),
    SMS_MOCK: '1',
    NODE_ENV: 'development',
    ENABLE_DEV_MOCK_LLM: '1',
  };
  const logPath = path.join(OUT_DIR, `server-${LABEL}.log`);
  const log = fs.createWriteStream(logPath);
  const child = spawn('npx', ['tsx', 'apps/server/src/index.ts'], { cwd: REPO, env });
  child.stdout.pipe(log);
  child.stderr.pipe(log);

  let earlyExit = null;
  child.on('exit', (c, sig) => { earlyExit = `服务端进程提前退出（code=${c} sig=${sig}）`; });

  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < 90_000) {
    try {
      const j = await fetch(`${BASE}/health`).then((r) => r.json());
      // ★ 必须同时确认「库起来了」和「这是个全新进程」：只判 db==='up' 会把上一轮
      //   还没退干净的残留服务端当成本轮起的（实测踩过：0.1s "就绪" 且 llmCalls=5），
      //   那会让反证结论完全失真。
      const fresh = Number(j.llmCalls) === 0 && Number(j.liveLoops) === 0;
      if (j.db === 'up' && fresh) {
        console.log(`[boot] 真服务端就绪（${((Date.now() - t0) / 1000).toFixed(1)}s，端口 ${PORT}）：${JSON.stringify(j)}`);
        console.log(`[boot] 被测代码：${REPO}`);
        console.log(`[boot] 服务端日志：${logPath}`);
        return child;
      }
      last = j.db === 'up' ? `端口 ${PORT} 上是残留进程（${JSON.stringify(j)}），等它退…` : JSON.stringify(j);
    } catch {
      last = '还没监听';
    }
    await sleep(500);
  }
  child.kill('SIGKILL');
  throw new Error(`服务端 90s 内没就绪：${earlyExit ?? ''} 最后状态 = ${last}；详见 ${logPath}`);
}

/* -------------------------------------------------------------------- 真登录 */
async function login() {
  const phone = '139' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
  const sj = await fetch(`${BASE}/auth/sms/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone }),
  }).then((r) => r.json());
  if (!sj.mock_code) throw new Error(`拿不到 mock 验证码（SMS_MOCK 没开？）：${JSON.stringify(sj)}`);
  const lj = await fetch(`${BASE}/auth/login/sms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone, code: sj.mock_code }),
  }).then((r) => r.json());
  if (!lj.token) throw new Error(`登录失败：${JSON.stringify(lj)}`);
  console.log(`[auth] 真 JWT 登录成功（${phone.slice(0, 3)}****，验证码走 SMS_MOCK 通道，本轮新建测试账号）`);
  return lj.token;
}

/* ------------------------------------------------- 发一句话，抓原始 SSE 字节 */
async function sendChat(token, body, windowMs = 4000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), windowMs);
  let raw = '';
  try {
    const r = await fetch(`${BASE}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!r.ok || !r.body) {
      const txt = await r.text().catch(() => '');
      return { raw: `HTTP ${r.status} ${txt}`, events: [], deltas: '' };
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += dec.decode(value, { stream: true });
      if (raw.includes('event: done')) break; // 聊天轮会自己收尾；任务轮是长连，靠超时中断
    }
  } catch {
    /* 超时中断 = 预期：任务轮 SSE 长连本来就不会自己结束 */
  } finally {
    clearTimeout(timer);
  }
  const events = [...raw.matchAll(/^event: (\S+)$/gm)].map((m) => m[1]);
  const deltas = [...raw.matchAll(/^data: (\{.*\})$/gm)]
    .map((m) => { try { return JSON.parse(m[1]).delta ?? ''; } catch { return ''; } })
    .join('');
  return { raw, events, deltas };
}

/* ------------------------------------------------------------------ 验收用例 */
const LONG_CHITCHAT =
  '今天天气真舒服，早上出门遛弯的时候楼下花坛开了好多月季，心情特别好，你那边天气怎么样啊';

const CASES = [
  // ---- 第 5 项：稍长闲聊 / 简单提问不得被误判成任务 ----
  { id: '5-1', item: 5, msg: LONG_CHITCHAT, expectLoop: false, why: '43 字纯闲聊、无动作词、无活页（复查报告 R4 点名的原句）' },
  { id: '5-2', item: 5, msg: '帮我查一下今天北京的天气怎么样', expectLoop: false, why: '弱动作词「查」+ 无页面指代 → 走聊天联网搜索，不开浏览器' },
  { id: '5-3', item: 5, msg: '今天北京天气怎么样', page: { pageUrl: 'https://www.bing.com/', wcId: 7 }, expectLoop: false, why: '有活页也不再一票发车（旧逻辑 hasPage→true 会发）' },
  { id: '5-4', item: 5, msg: '什么是量子力学', expectLoop: false, why: '概念提问 → 普通聊天' },
  { id: '5-5', item: 5, msg: '我今天心情不太好想找人聊聊天随便说点什么', expectLoop: false, why: '>15 字但无动作词（旧逻辑 length>=15 一票发车会发）' },
  // ---- 第 6 项：正常浏览器任务仍必须正常触发（回归 / 反向保护） ----
  { id: '6-1', item: 6, msg: '打开百度，搜索一下今天的新闻，把前三条标题读给我', expectLoop: true, why: '验收报告第 6 项原句：强动作词「打开」' },
  { id: '6-2', item: 6, msg: '帮我下单', expectLoop: true, why: '强动作词「下单」，短句也要发车' },
  { id: '6-3', item: 6, msg: '打开 https://shop.example.com/item/9 帮我把这双鞋下单', expectLoop: true, why: '显式 URL → 任务' },
  { id: '6-4', item: 6, msg: '在这个页面搜一下同款', page: { pageUrl: 'https://shop.example.com/', wcId: 8 }, expectLoop: true, why: '弱动作词「搜」+ 页面指代「这个页面」→ 必须发车（否则就是收紧过头）' },
  { id: '6-5', item: 6, msg: '诊断一下我的店铺后台情况', expectLoop: true, why: '强动作词「诊断」' },
];

/* ---------------------------------------------------------------------- 主流程 */
console.log(`=== R4 发车判定 · 真服务端验收（标签 ${LABEL}，预期 ${EXPECT === 'pass' ? '两项全通过' : '第5项失败'}）===`);
const child = await bootServer();
let exitCode = 0;
try {
  const token = await login();
  const results = [];
  for (const c of CASES) {
    const body = { message: c.msg };
    if (c.page) {
      body.pageUrl = c.page.pageUrl;
      body.wcId = c.page.wcId;
      body.browserOpened = c.page.pageUrl; // 桌面已直接出卡片的那一轮
    }
    const r = await sendChat(token, body);
    const loop = r.events.includes('loop');
    const pass = loop === c.expectLoop;
    results.push({
      ...c,
      actualLoop: loop,
      pass,
      events: r.events,
      replyHead: r.deltas.slice(0, 46).replace(/\n/g, ' '),
      rawBytes: r.raw.length,
    });
    console.log(
      `${pass ? 'PASS' : 'FAIL'} [${c.id}] 第${c.item}项 发车=${loop}（期望 ${c.expectLoop}） ` +
        `events=[${r.events.join(',')}]  "${c.msg.slice(0, 24)}${c.msg.length > 24 ? '…' : ''}"`,
    );
    await sleep(150);
  }

  const item5 = results.filter((r) => r.item === 5);
  const item6 = results.filter((r) => r.item === 6);
  const ok5 = item5.every((r) => r.pass);
  const ok6 = item6.every((r) => r.pass);
  const health = await fetch(`${BASE}/health`).then((r) => r.json());
  const wantLoops = CASES.filter((c) => c.expectLoop).length;

  console.log('\n================ 验收结论 ================');
  console.log(`第 5 项「稍长闲聊不被误判成任务（R4）」：${ok5 ? '✅ 通过' : '❌ 不通过'}（${item5.filter((r) => r.pass).length}/${item5.length}）`);
  console.log(`第 6 项「正常浏览器任务仍正常触发（回归）」：${ok6 ? '✅ 通过' : '❌ 不通过'}（${item6.filter((r) => r.pass).length}/${item6.length}）`);
  console.log(`\n/health 佐证：liveLoops=${health.liveLoops} runningLoops=${health.runningLoops} llmCalls=${health.llmCalls}`);
  console.log(`（liveLoops 应等于「期望发车」的用例数 ${wantLoops}；每条闲聊用例一个循环都不该建）`);
  const loopsOk = Number(health.liveLoops) === wantLoops;
  console.log(`${loopsOk ? 'PASS' : 'FAIL'}  liveLoops 计数与预期发车数一致（${health.liveLoops} vs ${wantLoops}）`);

  fs.writeFileSync(
    path.join(OUT_DIR, `r4-acceptance-${LABEL}.json`),
    JSON.stringify({ label: LABEL, repo: REPO, at: new Date().toISOString(), item5: ok5, item6: ok6, liveLoopsMatches: loopsOk, health, results }, null, 2),
  );
  console.log(`\n取证：${path.join(OUT_DIR, `r4-acceptance-${LABEL}.json`)}`);

  const actual = ok5 && ok6 && loopsOk;
  const wanted = EXPECT === 'pass';
  if (actual !== wanted) {
    console.log(`\n★ 反证判定：本次预期「${wanted ? '全通过' : '第5项失败'}」，实测「${actual ? '全通过' : '有失败'}」→ **与预期不符**`);
    exitCode = 1;
  } else {
    console.log(`\n★ 反证判定：与预期一致（预期「${wanted ? '全通过' : '第5项失败'}」）`);
  }
} finally {
  child.kill('SIGTERM');
  await sleep(600);
  try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
}
process.exit(exitCode);
