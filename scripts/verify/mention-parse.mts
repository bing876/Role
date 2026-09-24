/**
 * 批次 J · J1 | `@点名` 确定性解析器验收（含全部反例）
 * ====================================================
 *
 * 验的是生产代码本体：`packages/shared/src/mention.ts` 的 `parseMention`。
 *   npm run verify:mention        （已挂进 npm run verify 主链）
 *
 * ★ 为什么每条规则都要配反例：点名是用户能一眼验证的行为，「看起来能用」不算数。
 *   下面每个 `反例` 断言都是在证明**不该命中的时候真的不命中** —— 只测正例的话，
 *   一个「永远返回第一个智能体」的实现也能全绿。
 *
 * 覆盖：名单精确匹配 / 邮箱里的 @ 不算 / 最长名优先 / 跨项目不生效 /
 *       拍板1（@ 必须紧跟名字）/ 拍板2（只认第一个命中当说话人）/
 *       R-B（@ 的就是当前说话人 → 当作没写 @）/ R-C（交给智能体的文本去掉 @名字）/
 *       确定性（同输入同输出、与名单顺序无关）/ 全仓只许有一份实现
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMention, mentionSummary } from '../../packages/shared/src/mention';
import type { MentionRosterEntry } from '../../packages/shared/src/mention';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let passes = 0;
let fails = 0;
const log = (...a: unknown[]) => console.log(a.map(String).join(' '));

function check(label: string, fn: () => void): void {
  try {
    fn();
    passes += 1;
    log(`  PASS ${label}`);
  } catch (err) {
    fails += 1;
    log(`  ★FAIL ${label}  —— ${(err as Error).message}`);
  }
}

/** 本项目里会出现的名单（研究员 / 设计 / 小助 + 一个长名，用来验最长名优先） */
const ROSTER: MentionRosterEntry[] = [
  { id: 101, name: '研究员' },
  { id: 102, name: '设计' },
  { id: 103, name: '小助' },
  { id: 104, name: '研究员助手' },
];

log('=== 批次 J · J1：@点名 确定性解析器 ===');

// ------------------------------------------------------------------ ① 正例：基本点名
log('');
log('--- ① 正例：@名单里的人 → 说话人改成它，正文去掉 @名字 ---');
{
  const r = parseMention('@研究员 建一个销售助手', ROSTER);
  log(`      ${JSON.stringify({ speaker: r.speaker, text: r.text, mentions: r.mentions.length })}`);
  check('命中研究员（id=101），说话人就是它', () => {
    assert.equal(r.speaker?.agentId, 101);
    assert.equal(r.speaker?.name, '研究员');
  });
  check('R-C：交给智能体的正文是「建一个销售助手」，不含 @研究员', () => {
    assert.equal(r.text, '建一个销售助手');
    assert.ok(!r.text.includes('@'), `正文里还留着 @：${r.text}`);
    assert.ok(!r.text.includes('研究员'), `正文里还留着名字：${r.text}`);
  });
  check('meta 用的 mentions 列表带 span（摘除靠 span，不靠字符串替换）', () => {
    assert.equal(r.mentions.length, 1);
    assert.equal(r.mentions[0].start, 0);
    assert.equal('@研究员 建一个销售助手'.slice(r.mentions[0].start, r.mentions[0].end), '@研究员');
  });
  check('mentionSummary 不带正文（日志不是第二个明文出口）', () => {
    const s = mentionSummary(r);
    log(`      summary：${s}`);
    assert.ok(!s.includes('建一个销售助手'), `摘要里带了正文：${s}`);
    assert.ok(s.includes('#101'), s);
  });

  const r2 = parseMention('@研究员去查一下报表', ROSTER);
  check('@ 后面不写空格也算点名（中文最自然的写法），正文是「去查一下报表」', () => {
    assert.equal(r2.speaker?.agentId, 101);
    assert.equal(r2.text, '去查一下报表');
  });

  const r3 = parseMention('麻烦@设计看一下这张页', ROSTER);
  check('@ 出现在句中（左边是中文）也算点名', () => {
    assert.equal(r3.speaker?.agentId, 102);
    assert.equal(r3.text, '麻烦看一下这张页');
  });
}

// ------------------------------------------------------------------ ② 反例：不该命中的都不命中
log('');
log('--- ② 反例：名单外 / 邮箱里的 @ / 带空格的 @ / 光一个 @ → 一律不点名 ---');
{
  const outside = parseMention('@张三 去查一下', ROSTER);
  check('反例1：名单外的名字（@张三）不命中，说话人不变', () => {
    assert.equal(outside.speaker, null);
    assert.equal(outside.mentions.length, 0);
  });
  check('反例1b：名单外的名字进 unknown（用户写了 @ 但没这个人，可用于提示）', () => {
    assert.deepEqual(outside.unknown, ['张三']);
    log(`      unknown=${JSON.stringify(outside.unknown)}，正文原样保留：${JSON.stringify(outside.text)}`);
    assert.equal(outside.text, '@张三 去查一下', '名单外的那段不该被摘掉（它不是点名，是正文）');
  });

  const mail = parseMention('把结果发到 team@研究员.example.com 然后告诉我', ROSTER);
  check('反例2：邮箱里的 @ 不算点名（左边紧贴邮箱本地部字符）', () => {
    assert.equal(mail.speaker, null, `邮箱被当成点名了：${JSON.stringify(mail.mentions)}`);
    assert.equal(mail.mentions.length, 0);
    assert.equal(mail.text, '把结果发到 team@研究员.example.com 然后告诉我', '邮箱地址被改写了');
  });
  const mail2 = parseMention('first.last@设计 这个地址发出去', ROSTER);
  check('反例2b：本地部带点号的邮箱也不算（`.` 在邮箱本地部字符集里）', () => {
    assert.equal(mail2.speaker, null);
    assert.equal(mail2.text, 'first.last@设计 这个地址发出去');
  });

  const spaced = parseMention('@ 研究员 建一个销售助手', ROSTER);
  check('反例3（拍板1）：@ 与名字之间有空格 → 不算点名', () => {
    assert.equal(spaced.speaker, null, `带空格的 @ 被当成点名了：${JSON.stringify(spaced.mentions)}`);
    assert.equal(spaced.mentions.length, 0);
    assert.equal(spaced.text, '@ 研究员 建一个销售助手', '不该摘掉任何东西');
  });

  const bare = parseMention('查一下 @', ROSTER);
  check('反例4：光一个 @（后面没内容）不点名、不报错', () => {
    assert.equal(bare.speaker, null);
    assert.equal(bare.mentions.length, 0);
    assert.equal(bare.text, '查一下 @');
  });

  const none = parseMention('把报表发到工作群', ROSTER);
  check('反例5：完全没写 @ 的普通消息，mentions 空、正文逐字节原样', () => {
    assert.equal(none.speaker, null);
    assert.equal(none.mentions.length, 0);
    assert.equal(none.text, '把报表发到工作群');
    assert.equal(none.textEmpty, false);
    assert.equal(mentionSummary(none), '无点名');
  });

  const emptyRoster = parseMention('@研究员 建一个销售助手', []);
  check('反例6（跨项目不生效的机制）：名单里没有这个人 → 不命中', () => {
    assert.equal(emptyRoster.speaker, null, '空名单还命中了');
    assert.equal(emptyRoster.mentions.length, 0);
  });
  const otherProject = parseMention('@研究员 建一个销售助手', [{ id: 201, name: '别项目的人' }]);
  check('反例6b：别项目的名单（不含研究员）→ 不命中，正文原样', () => {
    assert.equal(otherProject.speaker, null);
    assert.equal(otherProject.text, '@研究员 建一个销售助手');
    assert.deepEqual(otherProject.unknown, ['研究员']);
  });
}

// ------------------------------------------------------------------ ③ 最长名优先
log('');
log('--- ③ 最长名优先：名单里同时有「研究员」与「研究员助手」---');
{
  const r = parseMention('@研究员助手 来做这件事', ROSTER);
  check('@研究员助手 命中长名（id=104），不是把「助手」两个字留给正文', () => {
    assert.equal(r.speaker?.agentId, 104, `命中了 ${r.speaker?.agentId}（${r.speaker?.name}）`);
    assert.equal(r.speaker?.name, '研究员助手');
    assert.equal(r.text, '来做这件事', `正文里残留了名字的一部分：${r.text}`);
  });
  const short = parseMention('@研究员 来做这件事', ROSTER);
  check('@研究员 仍然命中短名（长的没把它吃掉）', () => {
    assert.equal(short.speaker?.agentId, 101);
    assert.equal(short.text, '来做这件事');
  });
  const shuffled = parseMention('@研究员助手 来做这件事', [
    { id: 103, name: '小助' },
    { id: 101, name: '研究员' },
    { id: 104, name: '研究员助手' },
    { id: 102, name: '设计' },
  ]);
  check('名单顺序打乱后结果不变（最长名优先是自己排序排的，不靠调用方给对顺序）', () => {
    assert.equal(shuffled.speaker?.agentId, 104);
    assert.deepEqual(shuffled, r);
  });
}

// ------------------------------------------------------------------ ④ 拍板2：只认第一个命中当说话人
log('');
log('--- ④ 拍板2：一句话只能有一个说话人 —— 第一个命中的算，其余只进 mentions ---');
{
  const r = parseMention('@研究员 @设计 一起看这张页', ROSTER);
  log(`      ${JSON.stringify({ speaker: r.speaker?.agentId, mentions: r.mentions.map((m) => m.agentId), text: r.text })}`);
  check('说话人是第一个命中的研究员（101），不是最后一个', () => {
    assert.equal(r.speaker?.agentId, 101);
  });
  check('其余命中（设计 102）只进 mentions 列表，给 SSE meta 用', () => {
    assert.deepEqual(
      r.mentions.map((m) => m.agentId),
      [101, 102],
    );
  });
  check('R-C：两个 @名字 都被摘掉，正文只剩「一起看这张页」', () => {
    assert.equal(r.text, '一起看这张页');
  });

  const dup = parseMention('@研究员 和 @研究员 再看一遍', ROSTER);
  check('同一个名字点两次：两处都摘掉（按 span 摘，不是字符串替换 —— 否则只会摘掉第一处）', () => {
    assert.equal(dup.text, '和 再看一遍');
    assert.equal(dup.mentions.length, 2);
    assert.equal(dup.speaker?.agentId, 101);
  });
}

// ------------------------------------------------------------------ ⑤ R-B：@ 的就是当前说话人
log('');
log('--- ⑤ R-B：@ 的就是当前说话人 → 当作没写 @（不报错、不重新路由）---');
{
  const r = parseMention('@研究员 继续刚才那件事', ROSTER, 101);
  log(`      ${JSON.stringify({ speaker: r.speaker, selfMention: r.selfMention, text: r.text })}`);
  check('speaker 是 null（不重新路由），selfMention 置 true 让调用方知道发生过', () => {
    assert.equal(r.speaker, null);
    assert.equal(r.selfMention, true);
  });
  check('正文照常摘掉 @名字（当作没写 @，但也不把 @ 留给模型当任务内容）', () => {
    assert.equal(r.text, '继续刚才那件事');
  });
  check('不报错、不抛异常，mentions 里仍然记录这次命中（界面可以什么都不显示）', () => {
    assert.equal(r.mentions.length, 1);
    assert.equal(mentionSummary(r).includes('按没写 @ 处理'), true, mentionSummary(r));
  });

  const notSelf = parseMention('@研究员 继续刚才那件事', ROSTER, 102);
  check('当前说话人是**别人**（102）时照常改人（R-B 只在「@ 的就是自己」时生效）', () => {
    assert.equal(notSelf.speaker?.agentId, 101);
    assert.equal(notSelf.selfMention, false);
  });

  const selfThenOther = parseMention('@小助 @研究员 一起看', ROSTER, 103);
  check('第一个命中的是自己、后面还有别人 → **不**把第二个提成说话人（那等于偷偷换人）', () => {
    assert.equal(selfThenOther.speaker, null, `speaker=${JSON.stringify(selfThenOther.speaker)}`);
    assert.equal(selfThenOther.selfMention, true);
    assert.deepEqual(
      selfThenOther.mentions.map((m) => m.agentId),
      [103, 101],
    );
    assert.equal(selfThenOther.text, '一起看');
  });
}

// ------------------------------------------------------------------ ⑥ R-C 的边界：摘完空了
log('');
log('--- ⑥ R-C 边界：只写了 @名字、没写要它做什么 ---');
{
  const r = parseMention('@研究员', ROSTER);
  check('textEmpty 置 true（调用方该回一句人话提示，不是把空正文丢给模型）', () => {
    assert.equal(r.speaker?.agentId, 101);
    assert.equal(r.text, '');
    assert.equal(r.textEmpty, true);
  });
  const r2 = parseMention('  @研究员   @设计  ', ROSTER);
  check('只有 @ 与空白时也算 textEmpty（空白折叠后为空）', () => {
    assert.equal(r2.text, '');
    assert.equal(r2.textEmpty, true);
    assert.equal(r2.mentions.length, 2);
  });
  const r3 = parseMention('   ', ROSTER);
  check('整句空白（没有 @）：textEmpty=true 且不点名', () => {
    assert.equal(r3.textEmpty, true);
    assert.equal(r3.mentions.length, 0);
  });
}

// ------------------------------------------------------------------ ⑦ 确定性
log('');
log('--- ⑦ 确定性：同输入同输出、纯函数、不改入参 ---');
{
  const input = '@研究员助手 和 @设计 看下 team@研究员.example.com 这个地址';
  const a = parseMention(input, ROSTER);
  const b = parseMention(input, ROSTER);
  check('同一输入两次解析结果逐字节相同（不依赖时间/随机/Map 迭代顺序）', () => {
    assert.deepEqual(a, b);
  });
  check('复杂句：长名优先命中 104、邮箱那段不命中、设计命中 102', () => {
    log(`      ${JSON.stringify(a)}`);
    assert.deepEqual(
      a.mentions.map((m) => m.agentId),
      [104, 102],
    );
    assert.equal(a.text, '和 看下 team@研究员.example.com 这个地址');
  });
  const rosterCopy = ROSTER.map((x) => ({ ...x }));
  parseMention(input, rosterCopy);
  check('不改入参：名单数组没被排序打乱（内部是 slice 后排序）', () => {
    assert.deepEqual(rosterCopy, ROSTER);
    assert.deepEqual(ROSTER.map((x) => x.id), [101, 102, 103, 104]);
  });
  check('undefined / null 输入不抛（走空结果分支）', () => {
    const r = parseMention(undefined as unknown as string, ROSTER);
    assert.equal(r.mentions.length, 0);
    assert.equal(r.text, '');
    assert.equal(r.textEmpty, true);
  });
}

// ------------------------------------------------------------------ ⑧ 全仓只许有一份实现
log('');
log('--- ⑨ 摘 @ 之后**不许抹掉用户的换行**（tidy 只收拾空格）---');
{
  /**
   * 为什么要单独立一条：`\s+` 是包含 `\n` 的。
   * 早先那版清理写的是 `replace(/\s+/g,' ')`，于是「@研究员 帮我写：\n标题\n正文」
   * 交给模型时变成了一行 —— 用户排好的版被点名逻辑顺手抹平了。
   * 换行是用户写的，只有「摘掉 @名字 留下的双空格」才需要收拾。
   */
  const r = parseMention('@研究员 帮我写：\n标题\n正文', ROSTER);
  log(`      ${JSON.stringify({ text: r.text })}`);
  check('正文里的换行原样保留（只在摘掉 @名字 处收拾空格）', () => {
    assert.equal(r.text, '帮我写：\n标题\n正文');
  });
  const r2 = parseMention('@研究员   看看   这组  数据', ROSTER);
  check('摘掉 @名字 之后，多出来的空格压成一个', () => {
    assert.equal(r2.text, '看看 这组 数据');
  });
  const r3 = parseMention('@研究员\n\n看一下这份报表', ROSTER);
  check('@名字 独占一行时，剩下的正文首尾空白去掉（不留开头空行）', () => {
    assert.equal(r3.text, '看一下这份报表');
  });
  const r4 = parseMention('第一行\n第二行', ROSTER);
  check('反例：一个 @ 都没写 → 正文一个字都不动（连空白都不收拾）', () => {
    assert.equal(r4.text, '第一行\n第二行');
  });
}

log('');
log('--- ⑧ 防漂移：全仓只许有一份 parseMention 实现（两端共用，不许各抄一份）---');
{
  /**
   * 为什么要有这条：`packages/shared/src/tools.ts` 的文件头写着「桌面侧故意不在运行时 import 本文件」，
   * 因为 Electron 主进程是 tsc 直出、打包产物里没有 node_modules —— 那边只能本地抄一份 + 用验收脚本证明等价。
   * 点名解析不需要进主进程（气泡前缀与兜底发车都在**渲染层**，Vite 会把它内联进产物），
   * 所以这里能做到真正的一份实现：渲染层直接 import shared 的**源文件**（相对路径，不依赖 dist 是否 build 过）。
   * 这条断言就是防止将来有人「顺手」在桌面复制一份 —— 复制的那一刻，两端就会各自漂移。
   */
  const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-electron', 'build', 'out', 'coverage', 'data']);
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      // 跳过依赖与**构建产物**：shared 的 dist、桌面的 dist/dist-electron 里都可能有编译出来的同名函数
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|mts|mjs|js)$/.test(e.name)) {
        const src = fs.readFileSync(p, 'utf8');
        if (/function parseMention\s*\(/.test(src)) hits.push(path.relative(ROOT, p));
      }
    }
  };
  walk(ROOT);
  log(`      parseMention 定义出现在：${JSON.stringify(hits)}`);
  check('全仓 parseMention 的定义只在 packages/shared/src/mention.ts 一处（本脚本自己不算：标签与正则都避开了那段字面量）', () => {
    assert.deepEqual(hits, [path.join('packages', 'shared', 'src', 'mention.ts')]);
  });
}

// ------------------------------------------------------------------ ⑩ dist 半份跟踪 = fresh clone 起不来
log('');
log('--- ⑩ shared 的 dist：要么整份不跟踪，要么整份跟踪（半份会让新克隆的服务端启动即崩）---');
{
  /**
   * 这条是真踩出来的（2026-09-24，批次 J）：`.gitignore` 里有 `dist/`，但
   * `packages/shared/dist/index.js`、`tools.js` 这些是当年 `git add -f` 进去的 —— 也就是**部分跟踪**。
   * 本批给 shared 新增了 `mention.ts`，编译出的 `dist/mention.js` 被 `dist/` 规则挡住没进库，
   * 而**已跟踪**的 `dist/index.js` 里写着 `__exportStar(require("./mention"))`。
   * 后果：新克隆的仓库不跑 `npm run build -w @ai-workbench/shared` 就起服务端 →
   * `require('@ai-workbench/shared')` 直接 ERR_MODULE_NOT_FOUND，**启动即崩**，
   * 而在开发机上永远复现不了（本地 dist 是全的）。
   *
   * 所以钉一条：只要 dist 里有**任何**文件被跟踪，磁盘上每个 .js/.d.ts 就都必须被跟踪。
   * （正解是「dist 整个不跟踪、靠 build 生成」，但那要动既有的 index.js/tools.js，
   *   不属本批；先用这条闸把「半份」这个状态挡住。）
   */
  const distDir = path.join(ROOT, 'packages', 'shared', 'dist');
  if (!fs.existsSync(distDir)) {
    log('      （本地没有 dist：跳过 —— 没 build 过就没有半份跟踪的问题）');
  } else {
    const onDisk = fs
      .readdirSync(distDir)
      .filter((f) => /\.(js|d\.ts)$/.test(f))
      .sort();
    let tracked: string[] = [];
    let gitOk = true;
    try {
      // ★ 这是 ESM（.mts），没有 require —— 第一版在这里写了 require，被 try/catch 吞成
      //   「git 不可用」而静默跳过（断言没跑却看着像跑了，正是最坏的那种假绿）
      tracked = execFileSync('git', ['ls-files', 'packages/shared/dist'], { cwd: ROOT, encoding: 'utf8' })
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean)
        .map((rel) => path.basename(rel))
        .filter((f) => /\.(js|d\.ts)$/.test(f))
        .sort();
    } catch {
      gitOk = false;
    }
    log(`      磁盘 ${onDisk.length} 个（${onDisk.join(', ')}）`);
    log(`      跟踪 ${tracked.length} 个（${tracked.join(', ') || 'git 不可用'}）`);
    if (!gitOk) {
      log('      git 不可用 → 这一段跳过（不作数，也不算失败）');
    } else if (tracked.length === 0) {
      check('dist 一份都没跟踪（这是理想状态：靠 build 生成）', () => assert.ok(true));
    } else {
      const missing = onDisk.filter((f) => !tracked.includes(f));
      check('部分跟踪时，磁盘上每个 .js/.d.ts 都必须在版本库里（否则新克隆的服务端 require 不到 → 启动即崩）', () => {
        assert.deepEqual(missing, [], `没进库的：${missing.join(', ')}`);
      });
      check('反过来说：库里跟踪的 dist 文件也必须都还在磁盘上（不许留下指向空气的记录）', () => {
        const ghost = tracked.filter((f) => !onDisk.includes(f));
        assert.deepEqual(ghost, [], `磁盘上没有的：${ghost.join(', ')}`);
      });
    }
  }
}

log('');
log(`=== 批次 J · J1 解析器：PASS ${passes} / FAIL ${fails} ===`);
process.exit(fails > 0 ? 1 : 0);
