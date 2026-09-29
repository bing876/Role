/**
 * 防「孤儿脚本」守卫。
 *
 * 为什么要有这一步：
 *   一份**没人跑**的测试脚本，价值是零 —— 它挡不住任何回归，只会让人误以为
 *   「这里有人守着」。历史上攒下过一批这种脚本。
 *
 * ★ 这个守卫自己是撞过坑才写成这样的（2026-09-29）：
 *   第一版只扫 `.mts`、只查 package.json。我据此把 `loop-kill9-worker.mts` 和
 *   `board-lock-worker.mts` 判成「死文件」删了 —— 结果全链红：它们的 spawner 是
 *   `loop-kill9-db.mjs` / `board-lock-db.mjs`（**.mjs 后缀，我压根没扫**），
 *   而且路径是 `path.join(ROOT, 'scripts/verify/xxx.mts')` 拼出来的，
 *   按文件名 grep 也搜不到。删错了两个真在用的文件。
 *   教训：判「没人用」之前，必须把**所有代码文件**都搜一遍，不能只看一个后缀。
 *
 * 所以本守卫分两层：
 *
 *   第一层（硬 FAIL，`.mts`）—— 主测试面，每个都必须有归属：
 *     ① 被 package.json 的任何 script 引用；或
 *     ② 文件名出现在**任何代码文件**里（含 .mjs/.cjs/.py 的 spawner，
 *        路径是拼出来的也能命中，因为匹配的是文件名而非完整路径）；或
 *     ③ 登记在下面的 STANDALONE 里并写清「为什么不进主链」。
 *
 *   第二层（只报数 + 钉基线，其他后缀）—— `scripts/verify/` 里还堆着两百来个
 *     历史探针 / 一次性脚本（`browser-idle-*-probe.py`、`ui15-*.py` …）。
 *     这批不在本守卫的处置范围内（删要拍板，见报告 §10.11），但**数量被钉住**：
 *     只许降、不许涨。涨了就是有人在往坟场里添土，必须红。
 *
 * 跑法：`npx tsx scripts/verify/no-orphan-scripts.mts`
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DIR = path.join(ROOT, 'scripts', 'verify');

/** 被本守卫硬管辖的后缀（主测试面）。 */
const ENFORCED = new Set(['.mts']);

/** 只统计、不处置的后缀（历史探针区）。 */
const SURVEYED = ['.mjs', '.cjs', '.py', '.js', '.tsx'];
const NOT_SCRIPT = new Set(['.md', '.json', '.txt']);

/**
 * 已搬去 `scripts/archive/one-off-probes/` 的一次性探针。
 * 判定标准是**全仓零引用**（连文档/注释都没提过），详见那个目录的 README。
 * 这里钉住数量：只许降不许涨 —— 否则会有人往 archive 里倒文件来绕过
 * 「必须有归属」这条规则。
 */
const ARCHIVE_DIR = 'scripts/archive/one-off-probes';
/**
 * 钉住**名单**而不只是数量：只许减不许增 —— 否则会有人往 archive 里倒文件，
 * 绕过「脚本必须有归属」这条规则。存名单才能精确报出「多出来的是哪个」；
 * 只存数量的话，多一个就把全表列一遍，反而误导人去删老文件（首版就这毛病）。
 */
const ARCHIVE_FILES = [
  '_cleanup.py',
  '_watchdog-check.py',
  'e2e-race-probe.py',
  'e2e-send-probe.py',
  'iframe-click-http.mjs',
  'login-probe.mjs',
  'multi-agent-parallel-tests.py',
  'pg-bringup.mjs',
  'react-input-probe.py',
  'send-gate-probe.py',
  'setup-local-pg.mjs',
  'show-sms-code.cjs',
  'wbctl.py',
];

/** 故意不进主链的脚本，每条都必须写清「为什么不进」。 */
const STANDALONE: Record<string, string> = {
  'bench-idle-scan.mts':
    '慢速证据脚本（约 25s），故意不进主链 —— 跑的是 PGlite 计时对比，' +
    '结论与绝对耗时不可迁移，只服务于报告 §10.9 的论证。',
  'sleep-revert-tests.mts':
    '变异测试机：**会改写源码**再跑别的测试，还原靠 finally 保底。' +
    'CI 里若被 kill（超时 / OOM），finally 不执行 ⇒ 留下改坏的树。' +
    '价值已被它的 sha256 复查证明，手动跑即可，不进主链。',
};

/** 第二层基线：这些后缀下「没有被任何代码文件引用」的文件数。只许降不许涨。 */
const UNOWNED_BASELINE: Record<string, number> = {
  '.mjs': 25,
  '.cjs': 15,
  '.py': 67,
  '.js': 1,
  '.tsx': 0,
};

let bad = 0;
const log = (...a: unknown[]): void => console.log(a.map(String).join(' '));
const ok = (cond: boolean, msg: string): void => {
  log(`  ${cond ? 'PASS' : '★FAIL'} ${msg}`);
  if (!cond) bad += 1;
};

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

// ---- 收集「全仓代码文件」的文本 --------------------------------------------
// ★ 必须包含 .mjs/.cjs/.py —— 第一版漏了它们，于是把被 .mjs spawn 的
//   worker 误判成死文件删掉，全链当场红。
const CODE_EXT = new Set(['.mts', '.mjs', '.cjs', '.ts', '.tsx', '.js', '.py', '.json']);
const SKIP_DIRS = new Set(['.git', 'node_modules', '.cache', 'dist', 'build', 'coverage', '__pycache__']);

function collectCodeText(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (CODE_EXT.has(path.extname(e.name))) {
        try {
          out.set(p, readFileSync(p, 'utf8'));
        } catch {
          /* 二进制/读不了的就当没内容 */
        }
      }
    }
  };
  walk(ROOT);
  return out;
}

const codeText = collectCodeText();
const pkgRaw = codeText.get(path.join(ROOT, 'package.json')) ?? '';
const referenced = new Set<string>();
for (const m of pkgRaw.matchAll(/scripts\/verify\/([A-Za-z0-9_.-]+\.(?:mts|mjs|cjs|js|py|tsx))/g)) {
  referenced.add(m[1]!);
}
/** 被某个代码文件提到过文件名（含 spawner 拼路径的情况）。 */
const mentionedIn = (name: string): string[] => {
  const hits: string[] = [];
  for (const [p, text] of codeText) {
    if (p === path.join(DIR, name)) continue;
    if (text.includes(name)) hits.push(path.relative(ROOT, p));
  }
  return hits;
};

const entries = readdirSync(DIR).filter((f) => isFile(path.join(DIR, f)) && !NOT_SCRIPT.has(path.extname(f)));
const byExt = new Map<string, string[]>();
for (const f of entries) {
  const ext = path.extname(f);
  if (!byExt.has(ext)) byExt.set(ext, []);
  byExt.get(ext)!.push(f);
}

log('');
log('=== 防孤儿脚本守卫 ===');
log(`  scripts/verify/ 下 ${entries.length} 个脚本文件；package.json 直接引用 ${referenced.size} 个`);
log(`  全仓扫了 ${codeText.size} 个代码文件找 spawner（第一版只扫 .mts，删错过人）`);
log('');

// ============ 第一层：.mts 硬管辖 ============
log('--- 第一层：.mts 必须有归属 ---');
const mts = (byExt.get('.mts') ?? []).sort();
const unowned: string[] = [];
for (const f of mts) {
  if (referenced.has(f)) continue;
  const why = STANDALONE[f];
  if (why) {
    log(`  PASS ${f} —— 已登记为独立脚本`);
    log(`       ${why}`);
    continue;
  }
  const hits = mentionedIn(f);
  if (hits.length > 0) {
    // 被别的代码文件起着（可能是拼路径的 spawner）⇒ 有归属
    log(`  PASS ${f} —— 被代码引用：${hits.slice(0, 2).join(', ')}${hits.length > 2 ? ` 等 ${hits.length} 处` : ''}`);
    continue;
  }
  unowned.push(f);
  ok(false, `${f} —— 既没有被 npm script 引用，也没有任何代码文件用它，还没登记为独立脚本`);
}
ok(unowned.length === 0, `第一层干净：${mts.length} 个 .mts 全部有归属`);

// ============ 第二层：其他后缀只报数 + 钉基线 ============
log('');
log('--- 第二层：其他后缀（历史探针区，只钉数量不处置）---');
log('   这批的清理要拍板（删两百来个文件不是我能擅自做的），见报告 §10.11。');
for (const ext of SURVEYED) {
  const list = (byExt.get(ext) ?? []).sort();
  const unownedHere = list.filter((f) => !referenced.has(f) && mentionedIn(f).length === 0);
  const base = UNOWNED_BASELINE[ext] ?? 0;
  ok(
    unownedHere.length <= base,
    `${ext}：无人引用 ${unownedHere.length} 个 ≤ 基线 ${base} 个（只许降不许涨）`,
  );
  if (unownedHere.length > base) {
    // 别把「无人引用清单的前 8 个」当成「新增的」打印 —— 那会误导人去删老文件。
    // 基线只记数量不记名字，所以多出来多少个就明确说多少个，并给出可疑名单。
    log(`       比基线多 ${unownedHere.length - base} 个；近改名/新增的可疑名单（前 10）：`);
    log(`       ${unownedHere.slice(0, 10).join(', ')}${unownedHere.length > 10 ? ' …' : ''}`);
  }
}

// ---- 反向检查①：白名单条目是不是已经不在了 ------------------------------
log('');
for (const f of Object.keys(STANDALONE)) {
  ok(mts.includes(f), `白名单条目仍存在：${f}`);
}

// ---- 反向检查②：★ 被代码引用/引用的脚本，文件必须真的存在 ------------------
// 这一条是拿真事故换来的：我把 `loop-kill9-worker.mts` 判成死文件删了，
// 而它的 spawner 是 `loop-kill9-db.mjs`。删掉之后守卫**照样绿** ——
// 因为守卫只遍历「现存文件」，文件没了就压根不在检查范围里。
// 所以必须反向来一遍：代码里点到名的脚本，磁盘上必须有。
log('');
log('--- 反向检查：代码点到名的脚本必须存在 ---');
{
  const onDisk = new Set(entries);
  let missing = 0;
  // package.json 里点到的
  for (const f of referenced) {
    if (!onDisk.has(f)) {
      ok(false, `package.json 在跑 ${f}，但 scripts/verify/ 里没有这个文件`);
      missing += 1;
    }
  }
  // 任何代码文件里点到名的（含 .mjs spawner 拼路径）
  const mentionedNames = new Set<string>();
  for (const [p, text] of codeText) {
    // ★ 只能跳过「自己提自己」，不能跳过整个 scripts/verify/ ——
    //   spawner（loop-kill9-db.mjs / board-lock-db.mjs）就在这个目录里。
    //   首版写的是跳过整个目录，于是删掉被 spawn 的 worker 照样绿，反证 C 抓到的。
    for (const m of text.matchAll(/scripts\/verify\/([A-Za-z0-9_.-]+\.(?:mts|mjs|cjs|js|py|tsx))/g)) {
      const name = m[1]!;
      if (p === path.join(DIR, name)) continue;
      // ★ 只认**调用行**，不认注释/文档行。首版把散文也当真调用，
      //   于是三处注释里提到的不存在脚本（含我自己写在注释里的 `xxx.mts` 例子）
      //   全被报成"删错了" —— 狼来了叫多了，真报警就没人看了。
      const lineStart = text.lastIndexOf('\n', m.index ?? 0) + 1;
      const line = text.slice(lineStart, text.indexOf('\n', lineStart) === -1 ? undefined : text.indexOf('\n', lineStart));
      const t = line.trim();
      const isComment = t.startsWith('*') || t.startsWith('//') || t.startsWith('#') || t.startsWith('/*') || t.startsWith('-->');
      if (isComment) continue;
      mentionedNames.add(name);
    }
  }
  for (const f of [...mentionedNames].sort()) {
    if (!onDisk.has(f)) {
      ok(false, `有代码在起 ${f}，但 scripts/verify/ 里没有这个文件（删错了？）`);
      missing += 1;
    }
  }
  ok(missing === 0, `反向检查干净：代码点到的 ${referenced.size + mentionedNames.size} 个脚本全部存在`);
}
// ---- archive 目录：钉住数量，防止倒垃圾绕过规则 ---------------------------
log('');
log('--- archive：scripts/archive/one-off-probes/ ---');
{
  const archDir = path.join(ROOT, ARCHIVE_DIR);
  let archFiles: string[] = [];
  try {
    archFiles = readdirSync(archDir).filter((f) => isFile(path.join(archDir, f)) && !NOT_SCRIPT.has(path.extname(f)));
  } catch {
    ok(false, `${ARCHIVE_DIR} 目录不存在（被删了？README 里有恢复方法）`);
  }
  // ★ 是「名单子集」而不是「数量精确相等」。首版写的是 ===，消息却说的是
  //   「只许降不许涨」—— 消息在撒谎：从 archive 里删掉一个文件也会红。
  //   删文件是清理，该放行；只有**新增**才必须红。
  const extra = archFiles.filter((f) => !ARCHIVE_FILES.includes(f)).sort();
  ok(
    extra.length === 0,
    `${ARCHIVE_DIR} 有 ${archFiles.length} 个文件，超出名单 ${extra.length} 个（名单只许减不许增 —— 往这儿倒文件绕过不了「必须有归属」）`,
  );
  if (extra.length > 0) log(`       多出来的是：${extra.join(', ')}`);
  const missing = ARCHIVE_FILES.filter((f) => !archFiles.includes(f)).sort();
  if (missing.length > 0) {
    log(`       （比名单少了 ${missing.length} 个，属清理，放行：${missing.join(', ')}）`);
  }
  // ★ 名单里的文件不许又出现在 scripts/verify/ 里**且没有归属**。没有这一条，
  //   "从 archive 搬回 verify 且不给归属" 是**抓不到**的 ——
  //   tier 2 按扩展名统计 verify 里的无人引用总数，archive↔verify 之间挪动
  //   总数不变，两头都"合法"。反证 I 抓到的就是这个洞。
  //   注意判据要含 referenced：真给它上了归属（进了 package.json）就该放行，
  //   那时该做的是把它从上面 ARCHIVE_FILES 名单里划掉（首版漏了这点，反证 I2 抓到）。
  const shuffled = ARCHIVE_FILES.filter((f) => entries.includes(f) && !referenced.has(f)).sort();
  ok(
    shuffled.length === 0,
    `名单里的文件没有又被放回 scripts/verify/ 且不给归属（搬回来就必须接进主链，不能两头摆）`,
  );
  if (shuffled.length > 0) log(`       两头都有且没归属的：${shuffled.join(', ')}`);
  const promoted = ARCHIVE_FILES.filter((f) => entries.includes(f) && referenced.has(f)).sort();
  if (promoted.length > 0) {
    log(`       ★ ${promoted.join(', ')} 已接进主链，请把它从上面 ARCHIVE_FILES 名单里划掉`);
  }
}

log('');
log(`=== 结论：${bad} 个问题 ===`);
log('  （这份守卫保证的是「主测试面的脚本没有被遗忘」，不保证被引用的脚本真的有效 ——');
log('    后者要靠反证：故意改坏，看它红不红。）');
process.exit(bad > 0 ? 1 : 0);
