/**
 * 怀疑 1 修复验证：`will-attach-webview` 的分区闸真的生效吗？
 *
 * ## 要证明两件事（缺一不可）
 *   (A) **判定逻辑对** —— 从 `main.ts` 里把 `decideWebviewPartition` 的**原文**抽出来跑真值表
 *       （不是抄一份副本：抄副本只能证明"我抄对了"，证明不了线上是对的）。
 *   (B) **Electron 真的会听** —— 在 `will-attach-webview` 里改写 `webPreferences.partition`
 *       之后，guest 拿到的**确实是改写后那个 session**。
 *       这一条必须真机验：如果 Electron 忽略改写（或者 session 在更早就已经定下来），
 *       那整套修复就是个摆设，而代码看起来完全正确。
 *
 * 用法：
 *   cd apps/desktop && npx electron ../../scripts/verify/partition-guard-probe.mjs --no-sandbox
 */
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const MAIN_TS = path.join(REPO, 'apps', 'desktop', 'electron', 'main.ts');
const PRELOAD_TS = path.join(REPO, 'apps', 'desktop', 'electron', 'preload.ts');
const APP_TSX = path.join(REPO, 'apps', 'desktop', 'src', 'App.tsx');

const ORPHAN = 'persist:workbench-browser-project-none';
const PREFIX = 'persist:workbench-browser-project-';

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

// ---------------------------------------------------------------------------
// 把 main.ts 里的纯函数原文抽出来（按大括号配平）
// ---------------------------------------------------------------------------
function extractFunction(src, name) {
  // 签名里可能有复杂的返回类型标注（`number | null | 'bad'`、`PartitionDecision`…），
  // 所以**不要**去枚举返回类型里允许出现哪些字符 —— 直接"一直匹配到函数体那个 `{`"。
  const sig = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*[^{]*\\{');
  const m = sig.exec(src);
  if (!m) return null;
  const i = src.indexOf('{', m.index);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(m.index, j + 1);
    }
  }
  return null;
}

function loadDeciders() {
  const src = fs.readFileSync(MAIN_TS, 'utf8');
  const pidSrc = extractFunction(src, 'projectIdFromPartitionName');
  const decSrc = extractFunction(src, 'decideWebviewPartition');
  if (!pidSrc || !decSrc) {
    console.log('    [debug] 抽不到函数：pid=' + !!pidSrc + ' decide=' + !!decSrc);
    return null;
  }
  /** 去掉参数与返回值的 TS 类型标注，只留纯 JS */
  const strip = (s) =>
    s.replace(/function\s+(\w+)\s*\(([^)]*)\)\s*:[^{]*\{/, (_m, n, a) => {
      const params = a
        .split(',')
        .map((p) => p.split(':')[0].trim())
        .filter(Boolean)
        .join(', ');
      return `function ${n}(${params}) {`;
    });
  const code =
    `const PROJECT_PARTITION_PREFIX = ${JSON.stringify(PREFIX)};\n` +
    strip(pidSrc) + '\n' + strip(decSrc) + '\n' +
    'return { projectIdFromPartitionName, decideWebviewPartition };';
  try {
    // eslint-disable-next-line no-new-func
    return new Function(code)();
  } catch (e) {
    console.log('    [debug] 求值失败：' + e.message);
    console.log('    [debug] 生成的代码：\n' + code.slice(0, 900));
    return null;
  }
}

// ---------------------------------------------------------------------------
// (B) 真机：Electron 会不会按改写后的 partition 建 session
// ---------------------------------------------------------------------------
function attachOnce(requestedPartition, owned, synced, applyGuard = true) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false },
    });
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      try {
        win.destroy();
      } catch {
        /* 已销毁 */
      }
      resolve(result);
    };

    win.webContents.on('will-attach-webview', (_e, wp) => {
      // applyGuard=false 就是**修复前的行为**（当时根本没有这个处理器）：
      // 渲染层写什么分区就用什么分区。
      if (!applyGuard) return;
      const d = DECIDE(typeof wp.partition === 'string' ? wp.partition : '', owned, synced);
      if (d.quarantined) wp.partition = d.partition;
    });

    win.webContents.on('did-attach-webview', (_e, guest) => {
      const storage = guest.session.getStoragePath() ?? '';
      // 判定"guest 实际用的是哪个分区"：看 session 的落盘路径里带的目录名
      done({ ok: true, storage });
    });

    setTimeout(() => done({ ok: false, storage: '' }), 15000);

    const html =
      '<!doctype html><html><body>' +
      `<webview src="about:blank" partition="${requestedPartition}" style="width:50px;height:50px"></webview>` +
      '</body></html>';
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  });
}

let DECIDE = null;

async function main() {
  console.log('='.repeat(70));
  console.log('怀疑 1 修复验证：will-attach-webview 分区闸');
  console.log('='.repeat(70));

  const mod = loadDeciders();
  if (!chk(!!mod, '能从 main.ts 抽出 projectIdFromPartitionName / decideWebviewPartition 原文')) {
    app.exit(1);
    return;
  }
  const { projectIdFromPartitionName, decideWebviewPartition } = mod;
  DECIDE = decideWebviewPartition;

  // ---------------- (A) 判定逻辑真值表 ----------------
  console.log('\n[A] 判定逻辑（取自 main.ts 原文）');
  const OWNED = new Set([101, 202]);

  const cases = [
    // [输入, owned, synced, 期望最终分区, 期望被改写?, 说明]
    [`${PREFIX}101`, OWNED, true, `${PREFIX}101`, false, '自己的项目 → 放行'],
    [`${PREFIX}202`, OWNED, true, `${PREFIX}202`, false, '自己的另一个项目 → 放行（页可跨项目共存，这是设计）'],
    [`${PREFIX}999`, OWNED, true, ORPHAN, true, '★ 不在自己名下的项目 → 改写'],
    [`${PREFIX}1`, OWNED, true, ORPHAN, true, '★ 猜一个小号（别人的项目） → 改写'],
    ['persist:evil', OWNED, true, ORPHAN, true, '★ 自造分区名 → 改写'],
    ['', OWNED, true, ORPHAN, true, '★ 空分区（会落到默认 session） → 改写'],
    ['persist:workbench-browser-project-abc', OWNED, true, ORPHAN, true, '★ 非数字项目号 → 改写'],
    [`${PREFIX}-1`, OWNED, true, ORPHAN, true, '★ 负数项目号 → 改写'],
    [`${PREFIX}0`, OWNED, true, ORPHAN, true, '★ 0 项目号 → 改写'],
    [ORPHAN, OWNED, true, ORPHAN, false, '兜底隔离分区本身 → 放行'],
    [`${PREFIX}999`, OWNED, false, `${PREFIX}999`, false, '★ 还没同步项目列表 → 放行（不误伤启动）'],
  ];
  for (const [input, owned, synced, want, wantQ, why] of cases) {
    const d = decideWebviewPartition(input, owned, synced);
    chk(
      d.partition === want && d.quarantined === wantQ,
      `decide(${JSON.stringify(input)}, synced=${synced}) → ${wantQ ? '改写' : '放行'}`,
      `实际 partition=${JSON.stringify(d.partition)} quarantined=${d.quarantined}（${why}）`,
    );
  }

  // 反例：一个不属于自己的项目号，绝不能原样放行
  const leaked = decideWebviewPartition(`${PREFIX}999`, OWNED, true);
  chk(leaked.partition !== `${PREFIX}999`, '★ 关键反例：不在名下的项目号**绝不会**原样透传');

  // ---------------- (B) 真机：Electron 是否听改写 ----------------
  console.log('\n[B] 真机：改写后 guest 实际用的是哪个 session');
  const ownedSet = new Set([101]);
  const r1 = await attachOnce(`${PREFIX}999`, ownedSet, true);
  chk(r1.ok, '① 能挂上 guest（测试前提成立）', 'did-attach-webview 超时');
  if (r1.ok) {
    const usesOrphan = r1.storage.includes('workbench-browser-project-none');
    const usesLeaked = r1.storage.includes('workbench-browser-project-999');
    chk(!usesLeaked, '★ 请求 999（不在名下）→ guest **没有**用 999 的 session',
        `storage=${r1.storage}`);
    chk(usesOrphan, '★ 请求 999（不在名下）→ guest 用的是隔离分区',
        `storage=${r1.storage}`);
  }

  const r2 = await attachOnce(`${PREFIX}101`, ownedSet, true);
  chk(r2.ok, '② 能挂上 guest（自己的项目这一路）', 'did-attach-webview 超时');
  if (r2.ok) {
    chk(r2.storage.includes('workbench-browser-project-101'),
        '★ 请求 101（在自己名下）→ guest 用 101 的 session（没被误伤）',
        `storage=${r2.storage}`);
  }

  // ---------------- (C) 对照：不加闸就是修复前的样子 ----------------
  console.log('\n[C] 对照实验：**不加闸**（= 修复前的行为）guest 会用到哪个 session');
  const r3 = await attachOnce(`${PREFIX}999`, ownedSet, true, false);
  chk(r3.ok, '③ 能挂上 guest（对照前提成立）', 'did-attach-webview 超时');
  if (r3.ok) {
    chk(r3.storage.includes('workbench-browser-project-999'),
        '★ 不加闸时 guest **确实**用了 999 的 session —— 漏洞是真的',
        `storage=${r3.storage}（若这里没命中，说明"绕过"这件事本身没成立，要重新评估）`);
  }
  chk(
    r1.ok && r3.ok && r1.storage !== r3.storage,
    '★ 加闸 vs 不加闸，guest 用的 session **不同**（闸确实在起作用，不是摆设）',
    `加闸=${r1.storage} / 不加闸=${r3.storage}`,
  );

  // ---------------- (D) 静态：建页口确实挂了这道闸吗 ----------------
  // ADR-0002 第二片：宿主换成 WebContentsView 后，`will-attach-webview` 随 `webviewTag`
  // 一起退场，建页口收敛为 view-host 的 create —— 闸跟着挪到建页口（同一判定函数）。
  // 所以这里的断言口径是：① 建页口真的调了闸；② 旧挂点已移除（防"两套挂点各说各话"）。
  console.log('\n[D] 静态：建页口（view-host create）确实挂了这道闸（防止"函数在、但没接上"）');
  const src = fs.readFileSync(MAIN_TS, 'utf8');
  const viewHostSrc = fs.readFileSync(path.join(REPO, 'apps', 'desktop', 'electron', 'view-host.ts'), 'utf8');
  chk(/deps!\.decidePartition\s*\(\s*raw\s*\)/.test(viewHostSrc),
      '★ view-host 的 create 里调了闸（decidePartition）');
  chk(/session\.fromPartition\s*\(\s*d\.partition\s*\)/.test(viewHostSrc),
      '★ 判定出的分区**确实用于**建页（session.fromPartition(d.partition)）');
  chk(!/\.on\(\s*'will-attach-webview'/.test(src),
      '★ 旧挂点 will-attach-webview 已移除（第二片退场口径，防两套挂点并存）');
  chk(/decidePartition:\s*\(raw\)\s*=>\s*decideWebviewPartition\s*\(\s*raw\s*,\s*ownedProjectIds\s*,\s*projectsSyncedAt\s*!==\s*null\s*\)/.test(src),
      '★ main.ts 把闸接进建页口：decideWebviewPartition + 真实项目集合 + 同步状态');
  chk(/ipcMain\.handle\(\s*'workbench:projects:sync'/.test(src),
      '★ 注册了项目列表同步通道（闸的判据来源）');

  const preloadSrc = fs.readFileSync(PRELOAD_TS, 'utf8');
  chk(/syncProjects:\s*\(projectIds:\s*number\[\]\)/.test(preloadSrc), 'preload 暴露了 syncProjects');
  const appSrc = fs.readFileSync(APP_TSX, 'utf8');
  chk(/window\.workbench\?\.syncProjects\?\.\(\s*r\.projects\.map/.test(appSrc),
      '★ 渲染层拿到项目列表后同步给主进程');
  chk(/window\.workbench\?\.syncProjects\?\.\(\[\]\)/.test(appSrc),
      '★ 登出时清空项目集合（否则下一位登录者继承上一位的白名单）');

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

/**
 * ★ 必须挡住默认的"最后一个窗口关掉就退出"。
 * 不然第一轮 `win.destroy()` 之后进程直接结束，后面的用例**根本不会跑**
 * —— 现象是"日志只到一半就没了、退出码还是 0"，看着像脚本自己写完了（踩过）。
 */
app.on('window-all-closed', () => {
  /* 探针自己控制退出时机（main() 结束时 app.exit） */
});
