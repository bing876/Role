/**
 * 第 26 步：**「正在搜索」这条提示的接线一致性检查**。
 *
 * 为什么要单独查这个：本项目踩过一个反复出现的坑 ——
 * 「通道名两端必须一致，不一致时不报错、只静默不生效」。
 * SSE 事件名正是这种通道：服务端写 `event: search`、桌面读 `ev === 'search'`，
 * 名字差一个字，界面上就永远不出现那行小字，而且**什么错都不会报**。
 *
 * 所以这里做的是**静态接线核对**（真实读取两端源码，不是复刻逻辑）：
 *   ① 服务端真的发了 `search` 事件；
 *   ② 桌面真的处理 `search` 事件；
 *   ③ 事件名两边**逐字相同**；
 *   ④ 桌面的状态 → 渲染 → CSS 三处名字对得上；
 *   ⑤ 桌面在流结束时会把提示收掉（不留残留）。
 *
 * ⚠️ 它**不**验证视觉效果（字号/颜色/位置好不好看）—— 那必须人眼看。
 *
 * 跑法：node scripts/verify/search-hint-wiring-check.mjs
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SERVER_CHAT = path.join(ROOT, 'apps', 'server', 'src', 'routes', 'chat.ts');
const APP = path.join(ROOT, 'apps', 'desktop', 'src', 'App.tsx');
/** ★ 2026-09-25（片 7b）：`search` 事件的处理随 `sendChat` 搬进 features/chat（探针跟着代码走） */
const CHAT_SRC = path.join(ROOT, 'apps', 'desktop', 'src', 'features', 'chat', 'useChat.ts');
const LEGACY_CSS = path.join(ROOT, 'apps', 'desktop', 'src', 'styles.css');

let pass = 0;
let fail = 0;
const failures = [];
const chk = (id, ok, detail = '') => {
  if (ok) pass += 1;
  else {
    fail += 1;
    failures.push(`${id} ${detail}`.trim());
  }
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id}${detail ? ' — ' + detail : ''}`);
  return Boolean(ok);
};

const server = readFileSync(SERVER_CHAT, 'utf8');
const app = readFileSync(APP, 'utf8') + '\n' + readFileSync(CHAT_SRC, 'utf8');
/**
 * 批次 M-5'：.searchHint 规则随聊天区搬进 design/11-chat-bubbles.css（编号 CSS 跟组件走）。
 * 类名↔CSS 一致性检查的对象改为「设计系统整体」（design/*.css 合并 + styles.css）。
 */
const designDir = path.join(ROOT, 'apps', 'desktop', 'src', 'design');
// M9'：styles.css 已删（若有人复活它,合并进来只会让旧规则假绿 —— 直接断言它不在场）
if (existsSync(LEGACY_CSS)) {
  console.log('★ 失败项：styles.css 又出现了（M9\' 已删）');
  process.exit(1);
}
const css = '' + '\n' +
  readdirSync(designDir)
    .filter((f) => f.endsWith('.css'))
    .map((f) => readFileSync(path.join(designDir, f), 'utf8'))
    .join('\n');

// ---- ① 服务端真的发 search 事件，且事件名从一个地方取（避免多处写死） ----
const srvEvent = server.match(/sse\([^,]+,\s*'([a-z_]+)',\s*e\)/);
chk('1.1 服务端发出 search 事件', Boolean(srvEvent) && srvEvent[1] === 'search', srvEvent ? `事件名=${srvEvent[1]}` : '未找到');
const srvName = srvEvent ? srvEvent[1] : '';

// ---- ② 桌面真的处理这个事件 ----
const appEvent = app.match(/ev === '([a-z_]+)'\s*\)\s*\{\s*\n\s*\/\*\*\s*\n\s*\* 第 26 步/);
chk('1.2 桌面处理 search 事件', Boolean(appEvent) && appEvent[1] === 'search', appEvent ? `事件名=${appEvent[1]}` : '未找到');
const appName = appEvent ? appEvent[1] : '';

// ---- ③ 两端逐字相同 ----
chk('1.3 两端事件名逐字一致', srvName !== '' && srvName === appName, `服务端="${srvName}" 桌面="${appName}"`);

// ---- ④ 状态 → 渲染 → CSS ----
chk('2.1 桌面有 searchHint 状态', /const \[searchHint, setSearchHint\] = useState\(''\)/.test(app));
chk('2.2 桌面在 search 事件里 setSearchHint', /setSearchHint\(`正在搜索：/.test(app), '（起始态文案）');
chk('2.3 桌面渲染了 searchHint', /\{streaming && streamingAgentId === curAgentId && searchHint && \(/.test(app));
chk('2.4 渲染用的类名与 CSS 一致', app.includes('className="searchHint"') && /^\.searchHint\s*\{/m.test(css), 'className="searchHint" ↔ .searchHint{');

// ---- ⑤ 收尾 ----
chk('3.1 流结束时清掉提示（不留残留）', /setSearchHint\(''\);/.test(app));
chk(
  '3.2 提示文案包含"搜索"字样（用户看得懂这是在联网查资料）',
  /正在搜索：/.test(app) && /已搜索/.test(app),
);

// ---- ⑥ 本步不许碰浏览器 UI：提示的类名不能出现在浏览器样式里 ----
chk(
  '4.1 searchHint 不掺进浏览器面板样式',
  !/browserLayer|browserFloating/.test(app.match(/\.searchHint[\s\S]{0,200}/)?.[0] ?? '') && !/searchHint/.test(readFileSync(path.join(ROOT, 'apps/desktop/src/browser/styles.css'), 'utf8')),
  '（搜索提示只属于聊天区）',
);

console.log(`\n===== 汇总：${pass} PASS / ${fail} FAIL =====`);
if (fail > 0) console.log('失败项：\n - ' + failures.join('\n - '));
process.exitCode = fail === 0 ? 0 : 1;
