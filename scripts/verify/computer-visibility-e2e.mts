/**
 * 收尾 7 · H | 电脑三级可见度 —— **真机端到端**（真后端 + 真 Postgres + 桌面那两个纯函数本体）
 * ==========================================================================================
 *
 *   npm run verify:visibility:e2e     （会先 build shared+server；需要真库在跑）
 *   node/tsx 直接跑：DATABASE_URL=postgres://… npx tsx scripts/verify/computer-visibility-e2e.mts
 *
 * ★ 为什么 H 需要这一层（批次 H 当年只验了「源码里出现过这些字」）：
 *   H 的空转恰恰是**源码看着齐全、链路根本没通**：组件没人渲染、fetch 打的是 `/api/agents/:id/visibility`
 *   （服务端没有 `/api` 前缀 → 404）、token 摸的是 `localStorage.getItem('token')`
 *   （桌面真实的 key 是 `workbench.token` → 401）、而且从来不 GET 回已存的档位。
 *   这四件事**没有一件**能靠 `readFileSync + includes` 验出来。
 *   所以这一层从 HTTP 入口真打进去、再回真库里查那一列，并且**用桌面自己的函数**去打
 *   （`loadVisibility` / `saveVisibility` / `visibilityUrl` 直接 import 组件模块），
 *   这样「前端拼的地址」与「后端注册的路由」对不上时会当场红 —— 正是当年那个 bug 的形状。
 *
 * 数据策略：只用本次新建的测试账号（两个：一个存偏好、一个验「别人的智能体改不动」），
 * 跑完整体删除（users 级联带走项目/智能体），活库里既有账号一行不碰。
 */
import { createHmac } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// ★ 桌面本体的那三个函数（不是副本）—— 它们拼的地址就是要打真路由的那个地址
import { loadVisibility, saveVisibility, visibilityUrl } from '../../apps/desktop/src/browser/ComputerVisibility';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
/** .mts 是 ESM，没有 require；用 package.json 所在目录当锚点解析 CJS 的 `pg`（顶层 node_modules 里装着） */
const require = createRequire(resolve(repo, 'package.json'));

const args = process.argv.slice(2);
const noSpawn = args.includes('--no-spawn');
const PORT = Number(process.env.PORT || 8795);
const BASE = process.env.BASE || `http://127.0.0.1:${PORT}`;
const OUT_DIR = resolve(repo, 'docs/acceptance/visibility');
const LOG_PATH = resolve(OUT_DIR, `server-${PORT}.log`);
const OUT_PATH = resolve(OUT_DIR, 'visibility-e2e.json');

let pass = 0;
let fail = 0;
const failures: string[] = [];
const evidence: Record<string, unknown> = {};

function chk(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1;
    console.log(`[PASS] ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`[★FAIL] ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
const section = (t: string) => console.log(`\n===== ${t} =====`);

// ------------------------------------------------------------------ 环境
function envOf(): Record<string, string> {
  const p = resolve(repo, 'apps/server/.env');
  if (!existsSync(p)) throw new Error('缺 apps/server/.env（DATABASE_URL / JWT_SECRET / DATA_KEY / PHONE_PEPPER 都在里面）');
  const out: Record<string, string> = {};
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}
const ENV = envOf();
const DB_URL = process.env.DATABASE_URL || ENV.DATABASE_URL;
if (!DB_URL) throw new Error('没有 DATABASE_URL');
if (!ENV.JWT_SECRET || !ENV.DATA_KEY || !ENV.PHONE_PEPPER) throw new Error('.env 缺 JWT_SECRET / DATA_KEY / PHONE_PEPPER');

const { Client: PgClient } = require('pg');
const live = new PgClient({ connectionString: DB_URL });
const phoneHash = (phone: string): string => createHmac('sha256', ENV.PHONE_PEPPER).update(phone, 'utf8').digest('hex');
const CANDIDATES = ['18600003101', '18600003102', '18600003103', '18600003104'];

// ------------------------------------------------------------------ HTTP
async function api(path: string, { method = 'GET', token, body }: { method?: string; token?: string | null; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 就留 null */
  }
  return { status: res.status, json, text };
}

// ------------------------------------------------------------------ 起后端
let server: ReturnType<typeof spawn> | null = null;

async function startServer() {
  const occupied = await fetch(`${BASE}/health`).then(() => true).catch(() => false);
  if (occupied) {
    if (!noSpawn) throw new Error(`${BASE} 已经有服务在监听（先关掉，或加 --no-spawn 复用它）`);
    return null;
  }
  if (noSpawn) throw new Error(`--no-spawn 但 ${BASE} 上没有服务`);
  if (!existsSync(resolve(repo, 'apps/server/dist/index.js'))) {
    throw new Error('缺 apps/server/dist/index.js —— 先跑 npm run build -w @ai-workbench/server');
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const out = createWriteStream(LOG_PATH, { flags: 'w' });
  server = spawn(process.execPath, ['dist/index.js'], {
    cwd: resolve(repo, 'apps/server'),
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL: DB_URL,
      DEEPSEEK_API_KEY: 'not-used-by-this-test',
      SMS_MOCK: '1',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.pipe(out);
  server.stderr?.pipe(out);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return await r.json();
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`后端 ${BASE} 60 秒没起来，看日志 ${LOG_PATH}`);
}

async function waitForSmsCode(phone: string, sinceBytes: number): Promise<string> {
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

async function pickFreePhone(): Promise<string> {
  for (const phone of CANDIDATES) {
    const hash = phoneHash(phone);
    const r = await live.query('SELECT id FROM users WHERE phone_hash = $1', [hash]);
    if (r.rowCount > 0) continue;
    await live.query('DELETE FROM sms_codes WHERE phone_hash = $1', [hash]);
    return phone;
  }
  throw new Error('候选测试手机号在库里都已被占用，换一批');
}

/** 建一个测试账号并登录，回 {token, userId, phone} */
async function makeAccount(): Promise<{ token: string; userId: number; phone: string }> {
  const phone = await pickFreePhone();
  const sinceBytes = existsSync(LOG_PATH) ? readFileSync(LOG_PATH, 'utf8').length : 0;
  const send = await api('/auth/sms/send', { method: 'POST', body: { phone } });
  if (send.status !== 200) throw new Error(`发验证码失败 HTTP ${send.status}：${send.text.slice(0, 200)}`);
  const code = await waitForSmsCode(phone, sinceBytes);
  const login = await api('/auth/login/sms', { method: 'POST', body: { phone, code } });
  const token = login.json?.token ?? login.json?.session?.token ?? null;
  if (!token) throw new Error(`登录失败：${login.text.slice(0, 300)}`);
  const row = await live.query('SELECT id FROM users WHERE phone_hash = $1', [phoneHash(phone)]);
  return { token: String(token), userId: Number(row.rows[0]?.id), phone };
}

const dbVisibility = async (agentId: number): Promise<string | null> => {
  const r = await live.query('SELECT computer_visibility FROM agents WHERE id=$1', [agentId]);
  return r.rows[0]?.computer_visibility ?? null;
};

const userIds: number[] = [];

async function cleanup(): Promise<{ removedUsers: number; note: string }> {
  let removedUsers = 0;
  let note = '';
  try {
    for (const id of userIds) {
      const r = await live.query('DELETE FROM users WHERE id = $1', [id]);
      removedUsers += r.rowCount === 1 ? 1 : 0;
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
    await live.end().catch(() => null);
  } catch (e) {
    note = String((e as Error)?.message ?? e);
  }
  return { removedUsers, note };
}

// ------------------------------------------------------------------ 主流程
async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  await live.connect();
  const health = await startServer();
  section('环境');
  console.log(`  后端 ${BASE}（${health ? '本次自己起的' : '复用外部'}）  库 ${DB_URL.replace(/:[^:@/]*@/, ':***@')}`);

  const acct = await makeAccount();
  userIds.push(acct.userId);
  console.log(`  测试账号 #${acct.userId}（${acct.phone.slice(0, 3)}****${acct.phone.slice(7)}）—— 跑完整体删除`);

  // 当前项目的那一份名单（★ 不带 projectId 会回所有项目的智能体，与桌面 App.tsx 同一个口径）
  const proj = (await api('/projects', { token: acct.token })).json?.currentProjectId ?? null;
  const list = await api(`/agents?projectId=${proj}`, { token: acct.token });
  const agent = (list.json?.agents ?? [])[0] ?? null;
  const agentId: number | null = agent?.id ?? null;
  chk('V0 前置：拿到了当前项目里的一个智能体（可见度是按智能体存的）', Number.isInteger(agentId), JSON.stringify({ proj, agentId }));
  if (!Number.isInteger(agentId)) throw new Error('没有可用的智能体，后面验不了');
  const id = agentId as number;

  // ---------------- V1：默认值 ----------------
  section('V1 默认档位（库里那列的 DEFAULT 就是 status = 收起）');
  const g0 = await api(`/agents/${id}/visibility`, { token: acct.token });
  chk('V1.1 GET 200 且回 status（新智能体默认收起，不抢焦点）', g0.status === 200 && g0.json?.visibility === 'status', JSON.stringify(g0.json ?? g0.text.slice(0, 120)));
  chk('V1.2 真库里那一列就是 status（不是接口现编的默认值）', (await dbVisibility(id)) === 'status', String(await dbVisibility(id)));

  // ---------------- V2：桌面那两个纯函数打的地址，与真路由对得上 ----------------
  section('V2 桌面本体的 visibilityUrl / loadVisibility / saveVisibility 打真路由（当年 404+401 的形状）');
  chk('V2.1 visibilityUrl 不带 `/api` 前缀（服务端注册的是 /agents/:id/visibility）', visibilityUrl('', id) === `/agents/${id}/visibility`, visibilityUrl('', id));
  chk('V2.2 给了 apiBase 就拼成绝对地址，且尾斜杠不会拼出双斜杠', visibilityUrl(`${BASE}/`, id) === `${BASE}/agents/${id}/visibility`, visibilityUrl(`${BASE}/`, id));
  const loaded0 = await loadVisibility({ apiBase: BASE, token: acct.token, agentId: id });
  chk('V2.3 ★loadVisibility 真的读回了库里的档位（不是 null、不是抛错）', loaded0 === 'status', String(loaded0));
  const saved = await saveVisibility({ apiBase: BASE, token: acct.token, agentId: id }, 'takeover');
  chk('V2.4 ★saveVisibility 回 true（HTTP 2xx）', saved === true, String(saved));
  chk('V2.5 存完真库里那一列变成了 takeover（前端函数 → 真路由 → 真库，一条链走完）', (await dbVisibility(id)) === 'takeover', String(await dbVisibility(id)));
  const loaded1 = await loadVisibility({ apiBase: BASE, token: acct.token, agentId: id });
  chk('V2.6 再读一次拿到 takeover（存与读同口径，重开应用能恢复档位）', loaded1 === 'takeover', String(loaded1));

  // ---------------- V3：三档都能存、非法值被拒 ----------------
  section('V3 三档轮一遍 + 非法值 400 + 库里不被写坏');
  for (const v of ['preview', 'status', 'takeover'] as const) {
    const r = await api(`/agents/${id}/visibility`, { method: 'POST', token: acct.token, body: { visibility: v } });
    const db = await dbVisibility(id);
    chk(`V3.${v} POST ${v} → 200 且库里就是 ${v}`, r.status === 200 && r.json?.visibility === v && db === v, JSON.stringify({ http: r.status, body: r.json, db }));
  }
  const bad = await api(`/agents/${id}/visibility`, { method: 'POST', token: acct.token, body: { visibility: 'fullscreen' } });
  chk('V3.bad 非法档位 → 400，且话里说清只能是哪三档', bad.status === 400 && /status\/preview\/takeover/.test(bad.json?.error ?? bad.text), JSON.stringify(bad.json ?? bad.text.slice(0, 120)));
  chk('V3.bad2 被拒之后库里仍是上一次那个合法值（没被写成 NULL / 非法值）', (await dbVisibility(id)) === 'takeover', String(await dbVisibility(id)));
  const empty = await api(`/agents/${id}/visibility`, { method: 'POST', token: acct.token, body: {} });
  chk('V3.empty 不带 visibility → 400（不是默默存成 status）', empty.status === 400, JSON.stringify(empty.json ?? empty.status));

  // ---------------- V4：鉴权与归属 ----------------
  section('V4 没登录改不动、别人的智能体也改不动（可见度是账号内的偏好）');
  const noAuth = await api(`/agents/${id}/visibility`, { method: 'POST', body: { visibility: 'preview' } });
  chk('V4.1 不带 token → 401，库里没被改', noAuth.status === 401 && (await dbVisibility(id)) === 'takeover', JSON.stringify(noAuth.json ?? noAuth.status));
  const other = await makeAccount();
  userIds.push(other.userId);
  const cross = await api(`/agents/${id}/visibility`, { method: 'POST', token: other.token, body: { visibility: 'preview' } });
  chk('V4.2 ★别的账号改这个智能体 → 404（不泄漏存在性），库里没被改', cross.status === 404 && (await dbVisibility(id)) === 'takeover', JSON.stringify({ http: cross.status, db: await dbVisibility(id) }));
  const crossGet = await api(`/agents/${id}/visibility`, { token: other.token });
  chk('V4.3 别的账号连读也读不到（404，不是回一个默认值糊弄过去）', crossGet.status === 404, JSON.stringify(crossGet.json ?? crossGet.status));
  const ghost = await api('/agents/99999999/visibility', { token: acct.token });
  chk('V4.4 不存在的智能体 → 404（不是 500、不是 200+默认值）', ghost.status === 404, JSON.stringify(ghost.json ?? ghost.status));

  // ---------------- V5：读不到时不许猜 ----------------
  section('V5 桌面函数在「读不到」时的口径：回 null，绝不回落成 status 再写回去');
  const badTokenLoad = await loadVisibility({ apiBase: BASE, token: 'not-a-jwt', agentId: id });
  chk('V5.1 token 无效 → loadVisibility 回 null（不是 status）', badTokenLoad === null, String(badTokenLoad));
  const badTokenSave = await saveVisibility({ apiBase: BASE, token: 'not-a-jwt', agentId: id }, 'preview');
  chk('V5.2 token 无效 → saveVisibility 回 false（不抛、不假装成功）', badTokenSave === false, String(badTokenSave));
  chk('V5.3 那次失败的写没有改库（还是 takeover）', (await dbVisibility(id)) === 'takeover', String(await dbVisibility(id)));
  const noAgent = await loadVisibility({ apiBase: BASE, token: acct.token, agentId: null });
  chk('V5.4 没有 agentId → 直接回 null（不发请求打一个 /agents/null/visibility 出去）', noAgent === null, String(noAgent));
  const wrongBase = await loadVisibility({ apiBase: 'http://127.0.0.1:1', token: acct.token, agentId: id });
  chk('V5.5 后端连不上 → 回 null（不抛到界面、不回落成 status）', wrongBase === null, String(wrongBase));
  const badLevel = await saveVisibility({ apiBase: BASE, token: acct.token, agentId: id }, 'fullscreen' as never);
  chk('V5.6 档位非法 → saveVisibility 自己就拒了（false，不发请求）', badLevel === false, String(badLevel));

  evidence.summary = {
    account: `#${acct.userId}`,
    secondAccount: `#${other.userId}`,
    projectId: proj,
    agentId: id,
    finalDbVisibility: await dbVisibility(id),
    desktopHelpers: { urlNoBase: visibilityUrl('', id), urlWithBase: visibilityUrl(BASE, id), loaded: loaded1 },
  };
}

(async () => {
  let exitCode = 0;
  try {
    await main();
  } catch (e) {
    fail += 1;
    failures.push(`EXCEPTION — ${(e as Error)?.stack ?? e}`);
    console.error(`\n[EXCEPTION] ${(e as Error)?.message ?? e}`);
  } finally {
    const c = await cleanup();
    section('收尾');
    console.log(`  测试账号删除：${c.removedUsers}/${userIds.length}${c.note ? `（${c.note}）` : ''}`);
    chk('Z1 测试账号跑完就删干净（活库里不留验收 residue）', c.removedUsers === userIds.length && userIds.length > 0, `${c.removedUsers}/${userIds.length}`);
    try {
      writeFileSync(OUT_PATH, `${JSON.stringify({ at: new Date().toISOString(), base: BASE, db: DB_URL.replace(/:[^:@/]*@/, ':***@'), pass, fail, failures, evidence }, null, 2)}\n`);
      console.log(`  取证写入 ${OUT_PATH}`);
    } catch (e) {
      console.log(`  取证写入失败：${(e as Error)?.message ?? e}`);
    }
    console.log(`\n===== 收尾 7 · H 可见度端到端：PASS ${pass} / FAIL ${fail} =====`);
    if (fail > 0) {
      console.log('失败清单：');
      for (const f of failures) console.log(`  - ${f}`);
      exitCode = 1;
    }
  }
  process.exit(exitCode);
})();
