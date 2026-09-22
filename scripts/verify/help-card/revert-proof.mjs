/**
 * 第 27 步 · **反证**（证明这些测试不是摆设）
 *
 * 做法：对**新增的核心判断逻辑**逐个注入"改回旧写法"的缺陷 → 重新构建 → 跑对应验收
 *      → 确认它**真的变红** → 恢复 → 重新构建 → 确认回到全绿。
 *
 * 五条注入都满足两条硬要求：
 *   ① **保持可编译**（签名/返回类型不变，不产生不可达代码 —— 否则构建就红了，测不出东西）；
 *   ② 精确打在"这条断言本该守住的那个逻辑"上，而不是随便删一行。
 *
 * 覆盖：保守触发（条件 A / 条件 B）、界面区分、自动恢复防误判、安全红线。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'C:/Users/bing/workbuddy-ai/work123';
const HERE = path.join(ROOT, 'scripts/verify/help-card');
const F = {
  agent: path.join(ROOT, 'apps/desktop/electron/agent.ts'),
  driver: path.join(ROOT, 'apps/desktop/electron/driver.ts'),
  app: path.join(ROOT, 'apps/desktop/src/App.tsx'),
  card: path.join(ROOT, 'apps/desktop/src/browser/HelpCard.tsx'),
};
const F2 = {
  helpState: path.join(ROOT, 'apps/desktop/electron/helpState.ts'),
};
const SUITE = {
  trigger: path.join(HERE, 'trigger-gate-verify.mjs'),
  ui: path.join(HERE, 'ui-verify.mjs'),
  detect: path.join(HERE, 'page-detect-verify.mjs'),
  helpState: path.join(HERE, 'help-state-verify.mjs'),
};

let FAILS = 0;
const say = (s) => console.log(s);
const ok = (name, cond, extra = '') => {
  if (cond) say(`PASS  ${name}`);
  else {
    FAILS += 1;
    say(`FAIL  ${name}${extra ? `   << ${extra}` : ''}`);
  }
};

function build(which) {
  const args =
    which === 'electron'
      ? ['run', 'build:electron', '-w', '@ai-workbench/desktop']
      : ['run', 'build:renderer', '-w', '@ai-workbench/desktop'];
  execFileSync('npm', args, { cwd: ROOT, stdio: 'pipe', shell: true });
}

function runSuite(file) {
  try {
    const out = execFileSync('node', [file], { cwd: HERE, encoding: 'utf8', stdio: 'pipe' });
    return out;
  } catch (e) {
    // 断言失败时脚本 exit 1 —— stdout 仍在
    return String(e.stdout ?? '') + String(e.stderr ?? '');
  }
}

const parse = (out) => {
  const m = out.match(/=== 结果：(\d+)\/(\d+) PASS，(\d+) FAIL ===/);
  return m ? { pass: Number(m[1]), total: Number(m[2]), fail: Number(m[3]) } : null;
};

const redNames = (out) => (out.match(/^FAIL {2}(.+)$/gm) ?? []).map((l) => l.replace(/^FAIL {2}/, '').trim());

const INJECTIONS = [
  {
    id: 'A · 保守触发「条件 A」失效（任何页面都当成需要人工）',
    file: F.agent,
    from: `  if (snap.loginLike) return 'login';\n  return null;\n}`,
    to: `  if (snap.loginLike) return 'login';\n  return 'captcha'; // REVERT-INJECT: 条件 A 失效\n}`,
    build: 'electron',
    suite: 'trigger',
    expectRed: ['9.', 'A3'],
  },
  {
    id: 'B · 保守触发「条件 B」失效（不再要求"AI 确实卡住了"）',
    file: F.agent,
    from: `      staleClicks = 0;\n      fails = 0;\n      result = toResult(res);\n      continue;`,
    to: `      staleClicks = 0;\n      fails = 0;\n      maybeRaiseHelp('REVERT-INJECT: 条件 B 失效');\n      result = toResult(res);\n      continue;`,
    build: 'electron',
    suite: 'trigger',
    expectRed: ['8.'],
  },
  {
    id: 'C · 界面区分失效（两种情况共用同一套颜色/图标/文案）',
    file: F.app,
    from: `  if (state.pausedBy === 'agent') {\n    return { cls: 'agent', icon: '🤖', text: \`AI 主动求助 · 等你处理 — \${state.detail}\` };\n  }`,
    to: `  if (state.pausedBy === 'agent') {\n    return { cls: 'user', icon: '⏸', text: \`已暂停（页面归你操作）— \${state.detail}\` }; // REVERT-INJECT\n  }`,
    build: 'renderer',
    suite: 'ui',
    expectRed: ['5.1', '5.3'],
  },
  {
    id: 'D · 自动恢复防误判失效（改回"没框就算完成"）',
    file: F.driver,
    from: `  if (hasSensitiveField) {\n    state.had = true;\n    return false;\n  }\n  return state.had;\n}`,
    to: `  if (hasSensitiveField) {\n    state.had = true;\n    return false;\n  }\n  return true; // REVERT-INJECT: 老逻辑 —— 没框就算完成\n}`,
    build: 'electron',
    suite: 'trigger',
    expectRed: ['17.', '18.'],
  },
  {
    id: 'F · 恢复去重失效（自动与手动几乎同时到就恢复两次）',
    file: F2.helpState,
    from: `        if (clear(wcId, 'page_changed')) deps.requestResume(wcId);`,
    to: `        clear(wcId, 'page_changed');\n        deps.requestResume(wcId); // REVERT-INJECT: 不看返回值，可能恢复两次`,
    build: 'electron',
    suite: 'helpState',
    expectRed: ['4.1', '4.2'],
  },
  {
    id: 'G · 收卡时忘了停观察窗（定时器/轮询泄漏）',
    file: F2.helpState,
    // ★ 注入必须**保持可编译**：第一版写的是 `if (stop && false)`，
    //   TS 把 `stop` 收窄成 never 直接编译失败 —— 那样注入的就不是"逻辑缺陷"，
    //   而是"构建坏了"，测试红得毫无意义。这里改成只删表、不停观察窗。
    from: `    const stop = watches.get(wcId);\n    if (stop) {\n      stop();\n      watches.delete(wcId);\n    }`,
    to: `    const stop = watches.get(wcId);\n    if (stop) {\n      watches.delete(wcId); // REVERT-INJECT: 只删表，不停观察窗\n    }`,
    build: 'electron',
    suite: 'helpState',
    expectRed: ['3.3', '5.4'],
  },
  {
    id: 'E · 安全红线失效（卡片里加了输入框与提交按钮）',
    file: F.card,
    from: `      <div className="helpCard__body">{question}</div>`,
    to: `      <div className="helpCard__body">{question}</div>\n      <input type="text" placeholder="请输入验证码" />\n      <button type="button">提交</button>`,
    build: 'renderer',
    suite: 'ui',
    expectRed: ['4.1', '4.2', '4.3'],
  },
];

say('=== 第 27 步 · 反证：故意改回旧写法，测试必须变红 ===\n');

for (const inj of INJECTIONS) {
  const original = fs.readFileSync(inj.file, 'utf8');
  /**
   * ★ 本仓库 *.ts/tsx 是 **CRLF**，而脚本里的模式串写的是 LF ——
   *   不换行就会"锚点永远找不到"（第一版就踩了，四条注入全被跳过，
   *   而跳过是**静默**的：只报一条 FAIL，很容易被当成"源码变了"）。
   *   这里按文件真实行尾把模式串转过去。
   */
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const from = inj.from.replace(/\n/g, eol);
  const to = inj.to.replace(/\n/g, eol);
  if (!original.includes(from)) {
    ok(`${inj.id} —— 注入点找得到`, false, '注入锚点在源码里找不到（源码变了？）');
    continue;
  }
  say(`---- 注入 ${inj.id}`);
  try {
    fs.writeFileSync(inj.file, original.replace(from, to));
    // ★ 注入后**构建失败**也算"这条注入无效"，要如实报出来而不是把脚本整个带崩 ——
    //   否则后面的注入与"恢复后全绿"那一段全都跑不到（第一版就是这样）。
    try {
      build(inj.build);
    } catch (e) {
      ok(`${inj.id} —— 注入后仍可编译`, false, `构建失败：${String(e.message).split('\n')[0]}`);
      continue;
    }
    const out = runSuite(SUITE[inj.suite]);
    const r = parse(out);
    const reds = redNames(out);
    const hit = r !== null && r.fail > 0 && inj.expectRed.every((p) => reds.some((x) => x.startsWith(p)));
    say(
      `      └ 注入后：${r?.pass ?? '?'}/${r?.total ?? '?'} PASS，${r?.fail ?? '?'} FAIL；` +
        `变红的断言 → ${reds.join(' | ') || '(一条都没红 —— 测试是摆设！)'}`,
    );
    ok(`${inj.id} —— 测试确实变红（${reds.length} 条，含预期的那几条）`, hit, `期望红: ${inj.expectRed.join('/')}`);
  } finally {
    fs.writeFileSync(inj.file, original);
    build(inj.build);
    // ★ 恢复后必须复查：本仓库踩过「Edit 报成功但文件没变」，注入/恢复同理
    const back = fs.readFileSync(inj.file, 'utf8');
    ok(`${inj.id} —— 已恢复且 token 复查通过`, back === original && !back.includes('REVERT-INJECT'), '恢复不干净！');
  }
}

say('\n---- 全部恢复后，三套验收应全绿');
for (const [name, file] of Object.entries(SUITE)) {
  const r = parse(runSuite(file));
  ok(`恢复后 ${name} 全绿`, r !== null && r.fail === 0, JSON.stringify(r));
}

say(`\n=== 反证结果：${FAILS === 0 ? '全部符合预期' : `${FAILS} 项不符合预期`} ===`);
process.exit(FAILS === 0 ? 0 : 1);
