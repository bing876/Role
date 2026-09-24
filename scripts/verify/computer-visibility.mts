/**
 * 批次 H + 收尾 7 | 电脑三级可见度 —— 快验收（不需要库；真库往返在 `computer-visibility-e2e.mts`）
 * ==============================================================================================
 *
 *   npm run verify:visibility        （已挂进 npm run verify 主链的 verify:batches 里）
 *
 * ★ 这份为什么整份重写（2026-09-24，收尾 7）：
 *   旧版（`computer-visibility.mjs`）从头到尾只有 `readFileSync + includes`：
 *   「源码里出现过 status/preview/takeover 这几个字」就算过，甚至还断言了一句字面量
 *   `useState<ComputerVisibility>(propVisibility ?? 'status')`。
 *   结果 H 空转了整整一批没人发现 —— 组件**根本没被渲染**、fetch 打的是 `/api/agents/:id/visibility`
 *   （服务端没有 `/api` 前缀 → 404）、token 摸的是 `localStorage.getItem('token')`
 *   （桌面真实 key 是 `workbench.token` → 401）、而且从来不 GET 回已存档位。
 *   这四件事没有一件是 `includes` 能验出来的。
 *
 *   所以这一份改成：① **真调**桌面本体导出的 `visibilityUrl / loadVisibility / saveVisibility`
 *   （用假 fetch 截住，验地址、方法、鉴权头、请求体与返回口径）；② 接线断言（组件真的被 App 渲染、
 *   真的是 BrowserPanel 的**兄弟**节点、切档只碰视图不碰任务）；③ CSS 的安全不变量
 *   （webview 宿主不许 `display:none`/尺寸归零）。源码文本断言只留在「谁调谁」这种没有可执行出口的地方，
 *   并且每条都写清了为什么只能这么验。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VISIBILITY_LEVELS,
  loadVisibility,
  saveVisibility,
  visibilityUrl,
} from '../../apps/desktop/src/browser/ComputerVisibility';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passes = 0;
let fails = 0;
const log = (...a: unknown[]) => console.log(a.map(String).join(' '));

function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passes += 1;
      log(`  PASS ${label}`);
    })
    .catch((err: Error) => {
      fails += 1;
      log(`  ★FAIL ${label}  —— ${err.message}`);
    });
}

/** 假 fetch：把每一次调用原样记下来，回一个可控的响应（验的是「桌面拼了什么、发了什么」） */
interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}
function withFakeFetch(responder: (c: Call) => { ok: boolean; status: number; json?: unknown } | Promise<{ ok: boolean; status: number; json?: unknown }>) {
  const calls: Call[] = [];
  const real = globalThis.fetch;
  const fake = (async (input: unknown, init?: any) => {
    const c: Call = {
      url: String(input),
      method: String(init?.method ?? 'GET'),
      headers: { ...(init?.headers ?? {}) },
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(c);
    const r = await responder(c);
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.json ?? {},
    } as unknown as Response;
  }) as unknown as typeof fetch;
  globalThis.fetch = fake;
  return {
    calls,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

const API = 'http://127.0.0.1:8787';
const TOKEN = 'jwt-abc';

log('=== 批次 H · 电脑三级可见度（收尾 7 修完空转之后）===');

// ------------------------------------------------------------------ ① 地址：不许再有 /api 前缀
log('');
log('--- ① visibilityUrl：与服务端注册的路由逐字对得上（当年 404 就出在这里）---');
await check('①-1：不给 apiBase（浏览器直测走 Vite 代理）→ 相对路径 `/agents/:id/visibility`，**没有** `/api`', () => {
  assert.equal(visibilityUrl('', 7), '/agents/7/visibility');
  assert.equal(visibilityUrl(undefined, 7), '/agents/7/visibility');
});
await check('①-2：给了 apiBase（Electron 里是 http://127.0.0.1:8787）→ 绝对地址', () => {
  assert.equal(visibilityUrl(API, 7), `${API}/agents/7/visibility`);
});
await check('①-3：apiBase 带尾斜杠不会拼出双斜杠（用户手填的地址常带斜杠）', () => {
  assert.equal(visibilityUrl(`${API}//`, 7), `${API}/agents/7/visibility`);
});
await check('①-4：三档就是服务端那三档（多一档少一档都会与 CHECK 约束打架）', () => {
  assert.deepEqual(VISIBILITY_LEVELS, ['status', 'preview', 'takeover']);
  const route = read('apps/server/src/routes/computerVisibility.ts');
  for (const v of VISIBILITY_LEVELS) assert.ok(route.includes(`'${v}'`), `服务端路由的白名单里没有 ${v}`);
});

// ------------------------------------------------------------------ ② 读：loadVisibility
log('');
log('--- ② loadVisibility：GET + Bearer，读不到一律 null（**不许**回落成 status）---');
{
  const f = withFakeFetch(() => ({ ok: true, status: 200, json: { agentId: 7, visibility: 'preview' } }));
  const v = await loadVisibility({ apiBase: API, token: TOKEN, agentId: 7 });
  f.restore();
  log(`      调用：${f.calls[0]?.method} ${f.calls[0]?.url}  auth=${f.calls[0]?.headers?.authorization ?? '(无)'}`);
  await check('②-1：200 + {visibility} → 原样返回那一档', () => assert.equal(v, 'preview'));
  await check('②-2：打的是 GET，地址是 visibilityUrl 拼的那个（不是 /api/…）', () => {
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].method, 'GET');
    assert.equal(f.calls[0].url, `${API}/agents/7/visibility`);
  });
  await check('②-3：带 Bearer JWT（当年摸错 localStorage key，这里恒等于没带 → 401）', () => {
    assert.equal(f.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  });
}
{
  const cases: Array<[string, { ok: boolean; status: number; json?: unknown }, null]> = [
    ['404（老后端没这条路由）', { ok: false, status: 404 }, null],
    ['401（token 过期）', { ok: false, status: 401 }, null],
    ['500', { ok: false, status: 500 }, null],
    ['200 但值是非法档位', { ok: true, status: 200, json: { visibility: 'fullscreen' } }, null],
    ['200 但没有 visibility 字段', { ok: true, status: 200, json: {} }, null],
  ];
  for (const [label, resp, want] of cases) {
    const f = withFakeFetch(() => resp);
    const v = await loadVisibility({ apiBase: API, token: TOKEN, agentId: 7 });
    f.restore();
    await check(`②-4 ${label} → 回 null（读不到就是读不到，不猜一个默认档位）`, () => assert.equal(v, want));
  }
}
{
  const f = withFakeFetch(() => {
    throw new Error('网络断了');
  });
  const v = await loadVisibility({ apiBase: API, token: TOKEN, agentId: 7 });
  f.restore();
  await check('②-5：fetch 抛错也不冒到界面（回 null）', () => assert.equal(v, null));
}
{
  const f = withFakeFetch(() => ({ ok: true, status: 200, json: { visibility: 'status' } }));
  const a = await loadVisibility({ apiBase: API, token: TOKEN, agentId: null });
  const b = await loadVisibility({ apiBase: API, token: TOKEN, agentId: 0 });
  f.restore();
  await check('②-6：没有 agentId → 直接 null，**一个请求都不发**（不许打出 /agents/null/visibility）', () => {
    assert.equal(a, null);
    assert.equal(b, null);
    assert.equal(f.calls.length, 0, `居然发了 ${f.calls.length} 个请求：${JSON.stringify(f.calls.map((c) => c.url))}`);
  });
}

// ------------------------------------------------------------------ ③ 写：saveVisibility
log('');
log('--- ③ saveVisibility：POST + Bearer + {visibility}，失败回 false（不抛、不假装成功）---');
{
  const f = withFakeFetch(() => ({ ok: true, status: 200, json: { agentId: 7, visibility: 'takeover' } }));
  const ok = await saveVisibility({ apiBase: API, token: TOKEN, agentId: 7 }, 'takeover');
  f.restore();
  log(`      调用：${f.calls[0]?.method} ${f.calls[0]?.url}  body=${JSON.stringify(f.calls[0]?.body)}`);
  await check('③-1：成功回 true', () => assert.equal(ok, true));
  await check('③-2：POST 到同一个地址，体就是 {visibility}（服务端只认这个字段名）', () => {
    assert.equal(f.calls[0].method, 'POST');
    assert.equal(f.calls[0].url, `${API}/agents/7/visibility`);
    assert.deepEqual(f.calls[0].body, { visibility: 'takeover' });
  });
  await check('③-3：带 content-type 与 Bearer（少了 content-type，Fastify 那边就不解析 body）', () => {
    assert.equal(f.calls[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(f.calls[0].headers['content-type'], 'application/json');
  });
}
{
  const f = withFakeFetch(() => ({ ok: false, status: 401 }));
  const ok = await saveVisibility({ apiBase: API, token: TOKEN, agentId: 7 }, 'preview');
  f.restore();
  await check('③-4：401/404/500 一律回 false（调用方据此 warn，不弹错、不重试到死）', () => assert.equal(ok, false));
}
{
  const f = withFakeFetch(() => ({ ok: true, status: 200 }));
  const ok = await saveVisibility({ apiBase: API, token: TOKEN, agentId: 7 }, 'fullscreen' as never);
  f.restore();
  await check('③-5：档位非法 → 自己就拒了（false），**不发请求**（不许让服务端来兜前端的错）', () => {
    assert.equal(ok, false);
    assert.equal(f.calls.length, 0);
  });
}
{
  const f = withFakeFetch(() => {
    throw new Error('网络断了');
  });
  const ok = await saveVisibility({ apiBase: API, token: TOKEN, agentId: 7 }, 'preview');
  f.restore();
  await check('③-6：fetch 抛错也回 false（fire-and-forget 的那一头不许崩）', () => assert.equal(ok, false));
}

// ------------------------------------------------------------------ ④ 组件本体的安全不变量
log('');
log('--- ④ 组件本体：不摸 localStorage、不打 /api、children 恒在同一个宿主、不碰任务执行 ---');
{
  const comp = read('apps/desktop/src/browser/ComputerVisibility.tsx');
  /**
   * ★ 只查**代码行**：把注释行剔掉再断言。
   * 这个文件的注释里本来就要写清「老版本打的是 /api/…」「不调 /agent/loop/…」—— 那是历史说明，
   * 拿全文做 `includes` 会把注释当成违规（这一版第一遍跑就是这么假红的）。
   */
  const code = comp
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l))
    .join('\n');
  await check('④-1：★组件代码里不许再出现 `/api/` 前缀，也不许自己摸 localStorage（token/apiBase 由调用方给）', () => {
    assert.ok(!/\/api\//.test(code), '又出现了 /api/ 前缀');
    assert.ok(!/localStorage/.test(code), '组件里又在摸 localStorage（key 摸错就是当年 401 的根因）');
  });
  await check('④-2：★children 恒久渲染在同一个宿主里 —— 不许有「某一档直接 return（把 children 丢掉）」的分支', () => {
    // 原来那一版：if (visibility === 'status') { return (<div>…bar…</div>); } —— status 档根本不渲染 children，
    // 挂上去就等于「用户一收起，正在跑的那张页当场被卸载」。
    assert.ok(!/if \(visibility === 'status'\)\s*\{?\s*return/.test(code), 'status 档又提前 return 了（children 会被丢掉）');
    assert.ok(!/if \(visibility === 'preview'\)\s*\{?\s*return/.test(code), 'preview 档提前 return 也会换掉 children 的父节点');
    assert.ok(/computerVisibility__host/.test(code), '没有那个恒定宿主');
    // 宿主只能出现一次（三档共用）；出现两次就意味着不同档位各渲染一个 → 换父节点 → webview 重建
    assert.equal((code.match(/computerVisibility__host/g) ?? []).length, 1, '宿主出现了不止一次（切档会换父节点）');
    assert.ok(/\{children\}/.test(code), 'children 没有被渲染出来');
  });
  await check('④-3：★组件不碰任务执行（不调 loop 的 start/stop/pause/resume，也不调 throttle）', () => {
    assert.ok(!/agent\/loop\/(start|stop|pause|resume)/.test(code), '组件里出现了 loop 控制接口');
    assert.ok(!/stopDriving|browserThrottle|agentStop|agentDrop/.test(code), '组件里出现了停/放任务的调用');
  });
  await check('④-4：默认档位仍是 status（批次 H 的设计前提：默认收起、不抢焦点）', () => {
    assert.ok(comp.includes("useState<ComputerVisibility>(propVisibility ?? 'status')"), '默认档位不是 status 了');
  });
  await check('④-5：三档都在，且接管档不再用黑色遮罩把该监督的页盖住', () => {
    for (const v of VISIBILITY_LEVELS) assert.ok(comp.includes(`'${v}'`) || comp.includes(v), `组件里没有 ${v}`);
    assert.ok(!/takeoverMask/.test(comp), '又用回全屏遮罩了（那正好盖住用户该监督的页）');
    assert.ok(/takeoverBanner/.test(comp), '接管档应渲染横幅');
  });
}

// ------------------------------------------------------------------ ⑤ 接线：App.tsx 真的渲染了它
log('');
log('--- ⑤ 接线：App.tsx 真的渲染了它（H 空转的主因就是「组件存在但没人用」）---');
{
  const app = read('apps/desktop/src/App.tsx');
  await check('⑤-1：App.tsx 从 ./browser 引了组件与那两个持久化函数', () => {
    assert.ok(/ComputerVisibility,/.test(app) && /loadVisibility,/.test(app) && /saveVisibility,/.test(app), '没有引入');
  });
  await check('⑤-2：★真的渲染了 `<ComputerVisibility`（不是只 import 着不用）', () => {
    assert.ok(/<ComputerVisibility\b/.test(app), 'App.tsx 里没有渲染这个组件');
  });
  await check('⑤-3：传了 apiBase={API_BASE()} 与 token（这两个正是当年 404/401 的根因，必须由调用方给）', () => {
    assert.ok(/apiBase=\{API_BASE\(\)\}/.test(app), '没有把 API_BASE() 传进去');
    assert.ok(/token=\{session\?\.token/.test(app), '没有把 JWT 传进去');
  });
  await check('⑤-4：★它是 BrowserPanel 的**兄弟**节点，不是把面板塞进 children（塞进去 = 切档时 webview 换父节点被重建）', () => {
    const m = /<ComputerVisibility[\s\S]{0,700}?\/>\s*<BrowserPanel/.exec(app);
    assert.ok(m, 'ComputerVisibility 与 BrowserPanel 不是「自闭合 + 紧随其后」的兄弟关系');
    assert.ok(!/<ComputerVisibility[\s\S]{0,900}?<BrowserPanel[\s\S]{0,200}?<\/ComputerVisibility>/.test(app), '面板被塞进 children 了');
  });
  await check('⑤-5：切档只碰视图（showFullscreen），**不碰**任务执行', () => {
    const m = /const onChangeComputerVisibility = \(v: ComputerVisibilityLevel\): void => \{[\s\S]{0,900}?\n  \};/.exec(app);
    assert.ok(m, '找不到切档处理函数');
    const body = m[0];
    assert.ok(/browser\.showFullscreen\(\)/.test(body), '切到显眼档没有把浏览器前置（那这一档就等于没做）');
    assert.ok(!/loop\/(start|stop|pause|resume)/.test(body), '切档里出现了 loop 控制接口');
    assert.ok(!/agentStop|agentDrop|browserThrottle/.test(body), '切档里出现了停/放任务');
    assert.ok(/saveVisibility\(/.test(body), '切档没有存回服务端');
  });
  await check('⑤-6：换智能体/换登录态会读回它自己的档位，且**读不到就不动**（不猜、不写回默认值）', () => {
    assert.ok(/loadVisibility\(\{ apiBase: API_BASE\(\), token: session\.token, agentId \}\)/.test(app), '没有读回档位');
    assert.ok(/if \(off \|\| !v\) return;/.test(app), '读不到时也去 setComputerVisibility 了（那会把「读不到」变成「用户选了收起」）');
    assert.ok(/\}, \[curAgentId, session\?\.token\]\);/.test(app), '读档 effect 的依赖不是「换人/换登录态」');
  });
  await check('⑤-7：喂给组件的状态是真数据（智能体状态 + 最后一条步摘要 + 当前页标题），不是写死的假文案', () => {
    assert.ok(/loopStatus=\{visAgent\?\.status/.test(app), '状态不是从智能体那一行来的');
    assert.ok(/currentTool=\{visLastStep\}/.test(app), '当前这一步不是从主进程报上来的步摘要来的');
    assert.ok(/pageSummary=\{visPage\}/.test(app), '页面摘要不是当前那张页的标题/地址');
    assert.ok(/const visLastStep = agentSteps\.length > 0 \? agentSteps\[agentSteps\.length - 1\] : null;/.test(app));
  });
}

// ------------------------------------------------------------------ ⑥ CSS 的安全不变量
log('');
log('--- ⑥ CSS：webview 宿主必须有真实尺寸（驾驶的点击坐标来自 getBoundingClientRect）---');
{
  const css = read('apps/desktop/src/browser/styles.css');
  const hostBlock = /\.computerVisibility__host \{[^}]*\}/.exec(css)?.[0] ?? '';
  const emptyBlock = /\.computerVisibility__host:empty \{[^}]*\}/.exec(css)?.[0] ?? '';
  log(`      host：${hostBlock.replace(/\s+/g, ' ')}`);
  log(`      host:empty：${emptyBlock.replace(/\s+/g, ' ')}`);
  await check('⑥-1：宿主规则里没有 display:none、没有 height:0（尺寸归零 = 驾驶点击静默失败）', () => {
    assert.ok(hostBlock.length > 0, '找不到 .computerVisibility__host 规则');
    assert.ok(!/display:\s*none/.test(hostBlock), '宿主被 display:none 了');
    // ★ min-height:0 是 flex 子项的常规写法（防溢出），不是把高度归零；先剔掉再判
    const noMin = hostBlock.replace(/min-height:\s*0/g, '');
    assert.ok(!/height:\s*0\b/.test(noMin), '宿主高度被写成 0');
    assert.ok(!/width:\s*0\b/.test(noMin), '宿主宽度被写成 0');
    assert.ok(/min-height:\s*0/.test(hostBlock), '缺 min-height:0（flex 子项溢出时会被撑破，这是既有写法）');
    assert.ok(/flex:\s*1 1 auto/.test(hostBlock), '宿主缺 flex:1 1 auto（里面真有面板时占不到空间）');
  });
  await check('⑥-2：空宿主用 flex-basis 归零而不是 display:none（里面真有面板时这条不生效）', () => {
    assert.ok(emptyBlock.length > 0, '找不到 :empty 规则');
    assert.ok(/flex:\s*0 0 auto/.test(emptyBlock));
    assert.ok(!/display:\s*none/.test(emptyBlock));
  });
  await check('⑥-3：接管档不再是 position:fixed 的黑色遮罩（那会盖住用户该监督的页）', () => {
    const takeoverRoot = /\.computerVisibility--takeover \{[^}]*\}/.exec(css)?.[0] ?? '';
    assert.ok(!/position:\s*fixed/.test(takeoverRoot), '接管档又是全屏固定遮罩了');
    assert.ok(!/rgba\(0,\s*0,\s*0/.test(takeoverRoot), '接管档又加了黑色半透明底');
    assert.ok(/\.computerVisibility__takeoverBanner \{/.test(css), '缺横幅样式');
  });
  await check('⑥-4：三档的类名都在（组件按 `computerVisibility--${visibility}` 拼）', () => {
    for (const v of VISIBILITY_LEVELS) assert.ok(css.includes(`.computerVisibility--${v}`), `CSS 里没有 --${v}`);
  });
  await check('⑥-5：组件在 .browserLayer（flex column）里不许跟面板抢空间', () => {
    const root = /\.computerVisibility \{[^}]*\}/.exec(css)?.[0] ?? '';
    assert.ok(/flex:\s*0 0 auto/.test(root), '根规则缺 flex:0 0 auto（会把面板挤掉一截）');
  });
}

// ------------------------------------------------------------------ ⑦ 服务端那三档（真库往返在 e2e 那份）
log('');
log('--- ⑦ 服务端路由：三档白名单 + 归属校验（**真库往返**在 verify:visibility:e2e 里，不在这里假装验过）---');
{
  const route = read('apps/server/src/routes/computerVisibility.ts');
  const db = read('apps/server/src/db.ts');
  await check('⑦-1：那列有 CHECK 约束、默认 status（库里就不许存进第四档）', () => {
    assert.ok(/computer_visibility TEXT NOT NULL DEFAULT 'status'/.test(db), 'DDL 与预期不符');
    assert.ok(/chk_agents_computer_visibility CHECK \(computer_visibility IN \('status','preview','takeover'\)\)/.test(db), '缺 CHECK 约束');
  });
  await check('⑦-2：读写都按「智能体必须属于当前用户的项目」过滤（别人的智能体改不动）', () => {
    assert.ok(/JOIN projects p ON p\.id = a\.project_id WHERE a\.id=\$1 AND p\.user_id=\$2/.test(route), 'GET 没有归属校验');
    assert.ok(/project_id IN \(SELECT id FROM projects WHERE user_id=\$3\)/.test(route), 'POST 没有归属校验');
  });
  await check('⑦-3：非法档位 400、且回的话里列出合法三档（前端拼错时能一眼看出）', () => {
    assert.ok(/if \(!v \|\| !VALID\.includes\(v\)\) return errJson\(reply, 400/.test(route));
  });
}

log('');
log(`=== 批次 H 可见度：PASS ${passes} / FAIL ${fails} ===`);
process.exit(fails > 0 ? 1 : 0);
