/**
 * #3 验证：`workbench:drive` 的动作形状闸。
 *
 * ## 为什么这么测
 * 闸是加在 `drive()` 入口的，而 `drive()` 里要用 Electron 的 webContents 才能真跑。
 * 所以分两层：
 *   (A) **纯函数层**：直接 `require` **编译产物** `dist-electron/driver.js`，
 *       对 `validateBrowserAction` 打真值表 —— 测的是线上那份代码本身，不是抄的副本。
 *   (B) **入口层**：拿**畸形入参**去调真的 `drive()`，断言它返回一句人话错误，
 *       而**不是抛异常**。这一条正是修复前会挂的地方：
 *       以前 `drive(null)` 会在第一行 `action.action` 抛 TypeError（在 try 之外），
 *       IPC 直接 reject，调用方拿到的是栈而不是人话。
 *
 * 用法：
 *   cd apps/desktop && npx electron ../../scripts/verify/drive-shape-probe.mjs --no-sandbox
 */
import { app } from 'electron';
import { createRequire } from 'node:module';
import path from 'node:path';
import url from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const DRIVER = path.join(REPO, 'apps', 'desktop', 'dist-electron', 'driver.js');

let fails = [];
let total = 0;
function chk(cond, label, detail) {
  total++;
  if (cond) console.log('  PASS  ' + label);
  else {
    console.log('  FAIL  ' + label + (detail ? '   ' + detail : ''));
    fails.push(label);
  }
  return cond;
}

async function main() {
  console.log('='.repeat(70));
  console.log('#3 验证：workbench:drive 的动作形状闸');
  console.log('='.repeat(70));

  const driver = require(DRIVER);
  const { validateBrowserAction, drive } = driver;
  if (!chk(typeof validateBrowserAction === 'function', '产物里有 validateBrowserAction')) {
    app.exit(1);
    return;
  }
  chk(typeof drive === 'function', '产物里有 drive');

  // ---------------- (A) 真值表 ----------------
  console.log('\n[A] validateBrowserAction 真值表（跑的是 dist-electron/driver.js）');
  const good = [
    [{ action: 'open_url', url: 'https://example.com' }, 'open_url 正常'],
    [{ action: 'click', target: '登录' }, 'click 正常'],
    [{ action: 'type', target: '搜索框', text: '你好', submit: true }, 'type 正常'],
    [{ action: 'type', target: 'x', text: 'y' }, 'type 不带 submit（可选）'],
    [{ action: 'scroll', direction: 'down' }, 'scroll down'],
    [{ action: 'scroll', direction: 'up' }, 'scroll up'],
    [{ action: 'wait', seconds: 3 }, 'wait 正常'],
    [{ action: 'read_page' }, 'read_page'],
    [{ action: 'screenshot' }, 'screenshot'],
    [{ action: 'ask_user', reason: 'r', question: 'q' }, 'ask_user'],
    [{ action: 'done', summary: 's', document_title: 't', document_outline: ['a', 'b'] }, 'done 正常'],
    [{ action: 'fill_form', fields: [{ target: '姓名', text: '张三' }] }, 'fill_form 正常'],
    [{ action: 'focus_sensitive_field', target: '密码', fieldReason: '需要你亲自输' }, 'focus_sensitive_field'],
    // 宽松口径：空串/缺可选字段**要放行** —— 语义错误交给 driver 出它自己那句人话
    [{ action: 'open_url', url: '' }, '★ open_url 空地址仍放行（语义交给 driver）'],
    [{ action: 'click', target: '' }, '★ click 空 target 仍放行'],
    [{ action: 'done', summary: 's', document_title: 't' }, '★ done 缺 document_outline 仍放行（按空数组）'],
    [{ action: 'read_page', extra: 'ignored' }, '★ 未知额外字段被忽略（前向兼容）'],
  ];
  for (const [input, why] of good) {
    const r = validateBrowserAction(input);
    chk(r.ok === true, `放行：${why}`, r.ok ? '' : `被拒了：${r.error}`);
  }

  const bad = [
    [null, 'null'],
    [undefined, 'undefined'],
    ['click', '字符串（不是对象）'],
    [123, '数字'],
    [[], '数组'],
    [{}, '缺 action 字段'],
    [{ action: '' }, 'action 是空串'],
    [{ action: 42 }, 'action 不是字符串'],
    [{ action: 'not_a_real_action' }, '未知动作名'],
    [{ action: 'open_url', url: 123 }, 'open_url 的 url 不是字符串'],
    [{ action: 'click' }, 'click 缺 target'],
    [{ action: 'type', target: 'x', text: 5 }, 'type 的 text 不是字符串'],
    [{ action: 'type', target: 'x', text: 'y', submit: 'yes' }, 'type 的 submit 不是布尔'],
    [{ action: 'scroll' }, 'scroll 缺 direction'],
    [{ action: 'scroll', direction: 'left' }, 'scroll 方向非法'],
    [{ action: 'wait' }, 'wait 缺 seconds'],
    [{ action: 'wait', seconds: 'abc' }, 'wait 的 seconds 不是数字'],
    [{ action: 'wait', seconds: NaN }, 'wait 的 seconds 是 NaN'],
    [{ action: 'wait', seconds: 0 }, 'wait 的 seconds 是 0'],
    [{ action: 'wait', seconds: 99999 }, 'wait 的 seconds 超上限'],
    [{ action: 'fill_form', fields: 'nope' }, 'fill_form 的 fields 不是数组'],
    [{ action: 'fill_form', fields: [{ target: 'a' }] }, 'fill_form 条目缺 text'],
    [{ action: 'fill_form', fields: [null] }, 'fill_form 条目不是对象'],
    [{ action: 'done', document_outline: 'nope' }, 'done 的 document_outline 不是数组'],
    [{ action: 'done', document_outline: ['a', 7] }, 'done 的 document_outline 含非字符串'],
    [{ action: 'open_url', url: 'x'.repeat(5000) }, 'url 超长'],
  ];
  for (const [input, why] of bad) {
    const r = validateBrowserAction(input);
    chk(r.ok === false, `拒绝：${why}`, r.ok ? '竟然放行了' : '');
    if (r.ok === false) {
      chk(typeof r.error === 'string' && r.error.length > 0 && r.error.includes('没有执行任何动作'),
          `  拒绝时给了人话（${why}）`, `error=${r.error}`);
    }
  }

  // ---------------- (B) 入口层：drive() 不能抛，要给干净结果 ----------------
  console.log('\n[B] 畸形入参调真的 drive() —— 必须是"干净的失败"，不能抛');
  const malformed = [null, undefined, 'click', 42, [], {}, { action: 'nope' }, { action: 'wait', seconds: 'x' }];
  for (const input of malformed) {
    let threw = null;
    let res = null;
    try {
      res = await drive(input);
    } catch (e) {
      threw = e;
    }
    const label = `drive(${JSON.stringify(input)})`;
    if (!chk(threw === null, `${label} 没有抛异常`, `抛了：${threw && threw.message}`)) continue;
    chk(res && res.ok === false, `${label} 返回 ok=false`, JSON.stringify(res));
    chk(res && typeof res.error === 'string' && res.error.length > 0, `${label} 带可读 error`);
    chk(res && typeof res.action === 'string', `${label} 的 action 是字符串`, res && String(res.action));
  }

  console.log('\n' + '='.repeat(70));
  console.log('结果：' + total + ' 条断言，' + fails.length + ' 条失败');
  for (const f of fails) console.log('   ✗ ' + f);
  console.log('='.repeat(70));
  app.exit(fails.length ? 1 : 0);
}

app.whenReady().then(() =>
  main().catch((e) => {
    console.error('探针异常：', e);
    app.exit(2);
  }),
);
app.on('window-all-closed', () => {
  /* 自己控制退出时机 */
});
