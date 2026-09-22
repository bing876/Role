// pg-supervisor-revert-proof.cjs —— 反证：证明 pg-supervisor-tests.cjs 不是摆设。
//
// 做法（对齐项目 MEMORY 第八节「反证要注入坏条件，不要删掉检查」）：
//   往**编译产物** `apps/desktop/dist-electron/server-supervisor.js` 里注入
//   一个**真实存在过的缺陷**（不是把断言删掉），重跑测试，看**指定的断言变红**。
//   变不红 = 那条断言测不出错，必须补强。
//
// 为什么改编译产物而不是源码：测试 require 的就是这份产物；
//   改产物 = 改一个字符就能跑，不用每轮 tsc；且注入点精确可控。
//   每轮注入后都还原，并核对 sha256 与注入前一致。
//
// 用法：node scripts/verify/pg-supervisor-revert-proof.cjs
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const MOD = path.join(REPO, 'apps', 'desktop', 'dist-electron', 'server-supervisor.js');
const TEST = path.join(REPO, 'scripts', 'verify', 'pg-supervisor-tests.cjs');

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/** 每条注入：[名字, [[find, replace], ...], [期望变红的断言片段]] */
const INJECTIONS = [
  [
    'I1 去掉并发去重（3 次并发会各起一份）',
    [[
      '    if (pgInflight)\n        return pgInflight;',
      '    if (false && pgInflight)\n        return pgInflight;',
    ]],
    ['并发 3 次**恰好**拉起一次'],
  ],
  [
    'I2 不调用 clearStalePid（陈旧 pid 残留 → PG 静默拒启动）',
    [['    clearStalePid(dataDir, log);', '    void clearStalePid;']],
    ['陈旧 pid 被识别并清掉', '陈旧 pid 文件确实从磁盘上消失了'],
  ],
  [
    'I3 clearStalePid 无条件删（会误删"正在启动的 PG"的 pid）',
    [['    if (Number.isInteger(pid) && pid > 0 && isPidAlive(pid)) {', '    if (false) {']],
    ['活着的 pid 明确"不动它"', '活着的 pid 文件必须还在'],
  ],
  [
    'I4 getPgPort 写死 5432（WORKBENCH_PG_PORT 失效）',
    [[
      '    return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : PG_DEFAULT_PORT;',
      '    return PG_DEFAULT_PORT;',
    ]],
    ['getPgPort 尊重 WORKBENCH_PG_PORT', '找不到便携包时返回 false'],
  ],
  [
    'I5 逃生开关挪到"找包"之后（开关不再短路）',
    [
      [
        `    if (process.env.WORKBENCH_NO_AUTOSTART_PG === '1') {
        log('[pg-supervisor] 自动拉起已被 WORKBENCH_NO_AUTOSTART_PG 关闭，跳过。');
        return false;
    }
    const home = getPgHome();`,
        '    const home = getPgHome();',
      ],
      [
        `        return false;
    }
    // 先清陈旧 pid，否则 PG 会静默拒绝启动`,
        `        return false;
    }
    if (process.env.WORKBENCH_NO_AUTOSTART_PG === '1') {
        log('[pg-supervisor] 自动拉起已被 WORKBENCH_NO_AUTOSTART_PG 关闭，跳过。');
        return false;
    }
    // 先清陈旧 pid，否则 PG 会静默拒绝启动`,
      ],
    ],
    ['开关**短路在**找包之前'],
  ],
];

function runTests() {
  const r = spawnSync(process.execPath, [TEST], { encoding: 'utf8', timeout: 240000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const red = out.split('\n').filter((l) => l.trim().startsWith('✗ ')).map((l) => l.trim().slice(2));
  const m = out.match(/通过 (\d+) \/ 失败 (\d+)/);
  return { out, red, pass: m ? Number(m[1]) : -1, fail: m ? Number(m[2]) : -1 };
}

const before = sha(MOD);
const backup = fs.readFileSync(MOD);
const rows = [];
let bad = 0;

console.log('=== pg-supervisor 反证 ===');
console.log(`基线 sha256 = ${before}\n`);

// 先跑一次基线，确认"没注入时是全绿的" —— 否则反证无从谈起
const base = runTests();
console.log(`基线：通过 ${base.pass} / 失败 ${base.fail}`);
if (base.fail !== 0) {
  console.error('✗ 基线就不绿，反证无意义。先修好再跑。');
  process.exit(1);
}
rows.push(['（基线，无注入）', `${base.pass}/${base.pass + base.fail}`, '—', '—']);

for (const [name, edits, expectRed] of INJECTIONS) {
  let src = backup.toString('utf8');
  let applied = true;
  for (const [find, replace] of edits) {
    if (!src.includes(find)) {
      console.error(`✗ [${name}] 注入点没找到（产物变了？）：\n${find.slice(0, 120)}`);
      applied = false;
      break;
    }
    src = src.replace(find, replace);
  }
  if (!applied) {
    fs.writeFileSync(MOD, backup);
    bad += 1;
    continue;
  }

  fs.writeFileSync(MOD, src);
  const res = runTests();
  fs.writeFileSync(MOD, backup); // 立刻还原

  const missed = expectRed.filter((e) => !res.red.some((r) => r.includes(e)));
  const ok = missed.length === 0;
  if (!ok) bad += 1;

  console.log(`\n${ok ? '✓' : '✗'} ${name}`);
  console.log(`   结果：通过 ${res.pass} / 失败 ${res.fail}（期望红：${expectRed.length} 条）`);
  for (const e of expectRed) {
    const hit = res.red.find((r) => r.includes(e));
    console.log(`     ${hit ? '变红 ✓' : '仍然绿 ✗'}  ${e}`);
  }
  if (res.red.length) {
    console.log(`   实际变红 ${res.red.length} 条，前 3 条：`);
    for (const r of res.red.slice(0, 3)) console.log(`     · ${r.slice(0, 100)}`);
  }
  rows.push([name, `${res.pass}/${res.pass + res.fail}`, String(res.red.length), ok ? '✓' : '✗']);
}

const after = sha(MOD);
const restored = after === before;

console.log('\n=== 汇总 ===');
for (const [n, p, red, ok] of rows) console.log(`  ${ok === '✗' ? '✗' : '·'} ${n}  |  ${p}  |  红 ${red}  |  ${ok}`);
console.log(`\n还原核对：注入前 ${before.slice(0, 16)}… / 还原后 ${after.slice(0, 16)}… → ${restored ? '一致 ✓' : '不一致 ✗'}`);

if (!restored) {
  console.error('✗ 产物没有还原干净！');
  process.exit(1);
}
// 还原后再跑一次，必须回到全绿
const final = runTests();
console.log(`还原后复跑：通过 ${final.pass} / 失败 ${final.fail} → ${final.fail === 0 ? '全绿 ✓' : '仍有红 ✗'}`);

process.exit(bad === 0 && restored && final.fail === 0 ? 0 : 1);
