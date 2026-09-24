/**
 * 批次 J · J4 | 渲染进程这一侧：@点名 与「兜底发车」闸门的验收
 * ===========================================================
 *
 * 验的是生产代码本体：`apps/desktop/src/mentionGate.ts`（App.tsx 真正调用的那两个函数），
 * 外加**接线断言** —— 证明 App.tsx 确实调了它、且没有另抄一份解析。
 *
 *   npm run verify:mention:desktop      （已挂进 npm run verify 主链）
 *
 * ★ 为什么要有这一层（服务端才是裁决方）：
 *   第 21 步那道「没拿到 loopId 也要发车」的兜底，只看流里有没有 loop 事件。
 *   而服务端对 @点名换人轮**一律不发车**（见 chat.ts 的 mentionSwitchRound）。
 *   一旦这轮 502 / 连接被掐、连 meta 都没回来，兜底就会替用户把驾驶员发出去 ——
 *   用户明明只是在叫另一个人说话。所以渲染层必须能**自己**认出「这是点名轮」。
 *   解析用的仍是 packages/shared 的同一份实现（相对路径引源码，Vite 内联进产物）。
 *
 * ★ 接线断言不是「测源码文本」凑数：它防的是**静默失效** ——
 *   闸门函数写得再对，只要 App.tsx 那行 `launch()` 没走它，用户在界面上照样会被误发车，
 *   而所有单元测试都还是绿的。这类「功能存在但没接上」的洞，只能靠接线断言堵。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mentionRosterOf,
  parseLocalMention,
  shouldFallbackLaunch,
} from '../../apps/desktop/src/mentionGate';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

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

/** 桌面联系人列表那一份名单（当前项目；切项目就换一份） */
const AGENTS = [
  { id: 301, name: '小助' },
  { id: 302, name: '研究员' },
  { id: 303, name: '文案' },
];
const XIAOZHU = 301;
const YANJIUYUAN = 302;

log('=== 批次 J · J4：渲染进程的点名闸门 ===');

// ------------------------------------------------------------------ ① 名单整形
log('');
log('--- ① 名单整形：脏数据不许变成「点得到的人」---');
{
  const roster = mentionRosterOf([
    ...AGENTS,
    { id: 0, name: '零号' },
    { id: NaN, name: '不是数' },
    { id: 304, name: '   ' },
    { id: 305, name: '' },
  ] as never);
  log(`      ${JSON.stringify(roster)}`);
  check('id 非法 / 名字空白的都丢掉（否则 @ 上去会解析出一个点不到的「人」）', () => {
    assert.deepEqual(roster, AGENTS);
  });
}

// ------------------------------------------------------------------ ② 本地解析
log('');
log('--- ② 本地解析：认得出「点了别人」，也认得出「点的是自己」---');
{
  const a = parseLocalMention('@研究员 帮我看看这组数据', AGENTS, XIAOZHU);
  log(`      ${JSON.stringify(a)}`);
  check('点了别人 → round=true、speakerId 是研究员', () => {
    assert.equal(a.round, true);
    assert.equal(a.speakerId, YANJIUYUAN);
  });
  check('R-B：@ 的就是当前发言人 → round=false（这一轮不算点名轮，兜底照旧）', () => {
    const b = parseLocalMention('@小助 你觉得呢', AGENTS, XIAOZHU);
    assert.equal(b.round, false);
    assert.equal(b.speakerId, null);
  });
  check('拍板1：@ 与名字之间有空格 → round=false（不算点名）', () => {
    assert.equal(parseLocalMention('@ 研究员 你好', AGENTS, XIAOZHU).round, false);
  });
  check('名单外的名字 → round=false，但要记在 unknown 里（前端可提示「没这个人」）', () => {
    const c = parseLocalMention('@会计 帮我看账', AGENTS, XIAOZHU);
    assert.equal(c.round, false);
    assert.equal(c.speakerId, null);
  });
  check('textLength 只报字数、不带正文（日志里不许出现用户内容）', () => {
    const d = parseLocalMention('@研究员 密码是 hunter2', AGENTS, XIAOZHU);
    assert.equal(typeof d.textLength, 'number');
    assert.ok(!JSON.stringify(d).includes('hunter2'));
  });
}

// ------------------------------------------------------------------ ③ 兜底发车闸门
log('');
log('--- ③ 兜底发车闸门：点名轮绝不替用户把驾驶员发出去 ---');
{
  const mentionRound = parseLocalMention('@研究员 帮我看看这组数据', AGENTS, XIAOZHU);
  const plainRound = parseLocalMention('帮我看看这组数据', AGENTS, XIAOZHU);
  const selfRound = parseLocalMention('@小助 你觉得呢', AGENTS, XIAOZHU);
  const spacedRound = parseLocalMention('@ 研究员 打开百度', AGENTS, XIAOZHU);

  check('基线：有 pending、没拿到 loopId、这轮没点名 → 发车（第 21 步的兜底本身不能被改坏）', () => {
    assert.equal(
      shouldFallbackLaunch({ pendingDrive: true, sawLoop: false, serverMentionKind: 'none', local: plainRound }),
      true,
    );
  });
  check('没有 pending → 不发车（本来就没准备驾驶员）', () => {
    assert.equal(
      shouldFallbackLaunch({ pendingDrive: false, sawLoop: false, serverMentionKind: 'none', local: plainRound }),
      false,
    );
  });
  check('已经拿到 loopId → 不再发第二次', () => {
    assert.equal(
      shouldFallbackLaunch({ pendingDrive: true, sawLoop: true, serverMentionKind: 'none', local: plainRound }),
      false,
    );
  });
  check('服务端说这轮是点名换人（kind=switch）→ 不发车', () => {
    assert.equal(
      shouldFallbackLaunch({ pendingDrive: true, sawLoop: false, serverMentionKind: 'switch', local: plainRound }),
      false,
    );
  });
  check('★关键：**流被掐、meta 一个都没回来**（serverMentionKind=null），本地认出点了别人 → 仍不发车', () => {
    assert.equal(
      shouldFallbackLaunch({ pendingDrive: true, sawLoop: false, serverMentionKind: null, local: mentionRound }),
      false,
    );
  });
  check('反例：本地认出的点名 + 服务端也说 switch → 两道闸一致（不是各判各的）', () => {
    assert.equal(
      shouldFallbackLaunch({ pendingDrive: true, sawLoop: false, serverMentionKind: 'switch', local: mentionRound }),
      false,
    );
  });
  check('反例：R-B（@ 自己）不是点名轮 → 兜底照旧发车（不能因为写了个 @ 就把任务吞了）', () => {
    assert.equal(
      shouldFallbackLaunch({ pendingDrive: true, sawLoop: false, serverMentionKind: 'self', local: selfRound }),
      true,
    );
  });
  check('反例：拍板1（@ 与名字之间有空格）不是点名轮 → 兜底照旧发车', () => {
    assert.equal(
      shouldFallbackLaunch({ pendingDrive: true, sawLoop: false, serverMentionKind: 'none', local: spacedRound }),
      true,
    );
  });
  check('服务端说 busy（R-A：它在忙，只回了一句告知）→ 也不发车：这轮根本没派活', () => {
    assert.equal(
      shouldFallbackLaunch({ pendingDrive: true, sawLoop: false, serverMentionKind: 'busy', local: plainRound }),
      false,
    );
  });
  check('服务端说 empty（只写了 @名字，回了一句反问）→ 也不发车', () => {
    assert.equal(
      shouldFallbackLaunch({ pendingDrive: true, sawLoop: false, serverMentionKind: 'empty', local: plainRound }),
      false,
    );
  });
  check('反例：服务端说 self（R-B：@ 的就是当前发言人）→ 兜底照旧发车（这种轮跟没写 @ 一样）', () => {
    assert.equal(
      shouldFallbackLaunch({ pendingDrive: true, sawLoop: false, serverMentionKind: 'self', local: plainRound }),
      true,
    );
  });
}

// ------------------------------------------------------------------ ④ 接线断言
log('');
log('--- ④ 接线：闸门真的接在 App.tsx 那条 launch() 上（防「功能存在但没接上」）---');
{
  const app = read('apps/desktop/src/App.tsx');
  const gate = read('apps/desktop/src/mentionGate.ts');

  check('App.tsx 从 ./mentionGate 引了 parseLocalMention 与 shouldFallbackLaunch', () => {
    assert.ok(/from '\.\/mentionGate'/.test(app), '没有从 ./mentionGate 引入');
    assert.ok(/parseLocalMention/.test(app) && /shouldFallbackLaunch/.test(app));
  });
  check('App.tsx 里那条兜底 launch() 确实包在 shouldFallbackLaunch(...) 的条件里', () => {
    const m = /shouldFallbackLaunch\(\{[\s\S]{0,400}?\}\)\s*\)\s*\n?\s*launch\(\);/.exec(app);
    assert.ok(m, '兜底 launch() 没有走 shouldFallbackLaunch —— 闸门写了但没接上');
  });
  check('App.tsx 把本地解析结果传进了闸门（local: localMention）', () => {
    assert.ok(/local:\s*localMention/.test(app));
  });
  check('App.tsx 把服务端 meta.mention.kind 传进了闸门（serverMentionKind）', () => {
    assert.ok(/serverMentionKind:\s*sawMention\?\.kind/.test(app));
  });
  check('App.tsx 自己**没有**再引/再调 parseMention（解析只在 mentionGate 里发生一次）', () => {
    // 只查「真的引入 / 真的调用」，不查注释里提到它的名字（注释里写一句 parseMention 不算抄一份实现）
    assert.ok(!/import\s*\{[^}]*\bparseMention\b[^}]*\}\s*from/.test(app), 'App.tsx 自己 import 了 parseMention');
    assert.ok(!/\bparseMention\s*\(/.test(app), 'App.tsx 里直接调了 parseMention —— 规则散进 3500 行组件里就没人能验了');
  });
  check('mentionGate 引的是 shared 的**源码相对路径**（不按包名，避免依赖 dist 是否 build 过）', () => {
    assert.ok(/from '\.\.\/\.\.\/\.\.\/packages\/shared\/src\/mention'/.test(gate));
    assert.ok(!/from '@ai-workbench\/shared'/.test(gate), '按包名引值会要求先 build shared/dist');
  });
}

// ------------------------------------------------------------------ ⑤ 气泡发言人接线
log('');
log('--- ⑤ 接线：气泡上的「这句话是谁说的」---');
{
  const app = read('apps/desktop/src/App.tsx');

  check('Message 类型带 speaker?: ChatSpeaker（前端消息模型里有发言人这一格）', () => {
    assert.ok(/speaker\?:\s*ChatSpeaker;/.test(app));
  });
  check('历史映射把服务端的 speaker 带进来（speaker: m.speaker）', () => {
    assert.ok(/speaker:\s*m\.speaker/.test(app), '/chat/history 的 speaker 没有落到前端消息上');
  });
  check('流式结束时按 meta.mention 的裁决给这条气泡挂发言人', () => {
    assert.ok(/sawMention\.speakerAgentId/.test(app));
    assert.ok(/speaker:\s*spokenBy/.test(app));
  });
  check('名字牌只在 speaker 有名字时渲染（缺失就不显示，**不拿当前智能体冒充**）', () => {
    const m = /const sp = m\.role === 'assistant' \? m\.speaker : undefined;\s*\n\s*if \(!sp \|\| !sp\.name\) return null;/.exec(app);
    assert.ok(m, '名字牌的「没有就不渲染」那道保护不见了');
  });
  check('名字牌只在**换人**那一句上挂（与上一条助手气泡同一个人就不挂，避免每条都挂成噪音）', () => {
    assert.ok(/if \(prevSpeakerId === sp\.id\) return null;/.test(app));
  });
  check('名字牌带了 className 与 data-agent-id（版式归用户 1:1 还原，结构先留好）', () => {
    assert.ok(/className="msg__speaker"/.test(app));
    assert.ok(/data-agent-id=\{sp\.id\}/.test(app));
  });
}

// ------------------------------------------------------------------ ⑥ 服务端落库接线（防漂移）
log('');
log('--- ⑥ 接线：服务端每条助手消息都记 speaker_agent_id（防将来重构把它丢掉）---');
{
  const chat = read('apps/server/src/routes/chat.ts');
  /**
   * 把 chat.ts 里所有 INSERT INTO messages 的语句抓出来，逐条看：
   * role='assistant' 的必须带 speaker_agent_id；role='user' 的必须**不带**（用户不是智能体）。
   * 这是行为之外的第二道保险 —— 真正的证据在 mention-e2e.mjs（真库真接口）。
   */
  const stmts = [...chat.matchAll(/INSERT INTO messages[^\n]*\n?[^\n]*VALUES[^\n]*/g)].map((m) => m[0]);
  log(`      INSERT INTO messages 语句 ${stmts.length} 条`);
  check('抓到了全部 5 处 INSERT（数量变了说明有人加了新写入点，必须一并检查）', () => {
    assert.ok(stmts.length >= 5, `只抓到 ${stmts.length} 条`);
  });
  check('每一条 assistant 写入都带 speaker_agent_id', () => {
    const assistant = stmts.filter((x) => x.includes("'assistant'"));
    assert.ok(assistant.length >= 4, `assistant 写入只有 ${assistant.length} 条`);
    for (const a of assistant) {
      assert.ok(a.includes('speaker_agent_id'), `有一条 assistant 写入没记发言人：${a.slice(0, 120)}`);
    }
  });
  check('user 写入一律**不带** speaker_agent_id（用户不是智能体，硬塞一个 id 就是造假）', () => {
    const user = stmts.filter((x) => x.includes("'user'"));
    assert.ok(user.length >= 1);
    for (const u of user) {
      assert.ok(!u.includes('speaker_agent_id'), `user 写入不该有发言人：${u.slice(0, 120)}`);
    }
  });
  check('/chat/history 的 SELECT 里带 speaker_agent_id 并 LEFT JOIN 出名字', () => {
    assert.ok(/speaker_agent_id, speaker_name, speaker_persona/.test(chat));
    assert.ok(/LEFT JOIN agents a/.test(chat), '必须是 LEFT JOIN：老数据/已删智能体的行不能被 join 掉');
  });
  check('SSE meta 恒带 mention（三处早退分支 + 主路径都要有）', () => {
    const metas = [...chat.matchAll(/sse\((?:res|r), 'meta', \{[\s\S]{0,300}?\}\);/g)].map((m) => m[0]);
    log(`      meta 帧 ${metas.length} 处`);
    assert.ok(metas.length >= 4, `只找到 ${metas.length} 处 meta`);
    for (const m of metas) {
      assert.ok(/mention:\s*mentionMeta/.test(m), `有一处 meta 没带 mention：${m.slice(0, 100)}`);
    }
  });
  check('库表 DDL 里有 speaker_agent_id 列 + ON DELETE SET NULL（智能体删了，历史不能被连坐）', () => {
    const db = read('apps/server/src/db.ts');
    assert.ok(/ALTER TABLE messages ADD COLUMN IF NOT EXISTS speaker_agent_id BIGINT NULL/.test(db));
    assert.ok(/REFERENCES agents\(id\) ON DELETE SET NULL/.test(db));
  });
}

log('');
log(`=== 批次 J · J4 渲染层：PASS ${passes} / FAIL ${fails} ===`);
process.exit(fails > 0 ? 1 : 0);
