/**
 * 批次 J · J4 | 渲染进程这一侧：@点名 与「兜底发车」闸门的验收
 * ===========================================================
 *
 * 验的是生产代码本体：`apps/desktop/src/mentionGate.ts`（桌面真正调用的那道闸），
 * 外加**接线断言** —— 证明 App.tsx 确实调了它，并把两项拍板（决策1 per_round / 决策2 allow_with_owner）
 * 在服务端与桌面的落点一起钉住（口径被人改回去时这里会红）。
 *
 *   npm run verify:mention:desktop      （已挂进 npm run verify 主链）
 *
 * ★ 为什么要有这一层（服务端才是裁决方）：
 *   第 21 步那道「没拿到 loopId 也要发车」的兜底，只看流里有没有 loop 事件。
 *   而 R-A（被点名者正忙）与「整条只写了 @名字」这两种轮，服务端**只回一句告知、不派任何活**。
 *   这两种轮要是被兜底发出去，等于把用户的一句「@某人」变成了一次浏览器操作 ——
 *   所以渲染层要认得出「服务端这轮已经用告知答过了」。判据只有服务端的 meta.mention.kind。
 *
 * ★ 用户 2026-09-24 拍板（决策2 = allow_with_owner）之后，桌面**不再自己解析 @**：
 *   点名轮允许发车（循环归会话主人），「文本里有 @」不再是前端能改结果的判据，
 *   那次本地解析就成了死代码 —— 撤掉（连 `vite.config.ts` 的 `fs.allow` 一起回退）。
 *   §②③④ 反过来钉住这件事：不许长回来，也不许把决策1/决策2 的口径悄悄改回去。
 *
 * ★ 接线断言不是「测源码文本」凑数：它防的是**静默失效** ——
 *   闸门函数写得再对，只要 App.tsx 那行 `launch()` 没走它，用户在界面上照样会被误发车，
 *   而所有单元测试都还是绿的。这类「功能存在但没接上」的洞，只能靠接线断言堵。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldFallbackLaunch } from '../../apps/desktop/src/mentionGate';

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

log('=== 批次 J · J4：渲染进程的点名闸门 ===');

// ------------------------------------------------------------------ ① 闸门真值表（决策2 口径）
log('');
log('--- ① 兜底发车闸门：决策2 = allow_with_owner（点名轮**允许**发车，循环归会话主人）---');
{
  const L = (kind: string | null | undefined, over: object = {}): boolean =>
    shouldFallbackLaunch({ pendingDrive: true, sawLoop: false, serverMentionKind: kind, ...over });

  log(`      none=${L('none')} switch=${L('switch')} self=${L('self')} busy=${L('busy')} empty=${L('empty')} null=${L(null)}`);

  check('基线：有 pending、没拿到 loopId、这轮没点名 → 发车（第 21 步那道兜底本身不能被改坏）', () => {
    assert.equal(L('none'), true);
  });
  check('老规矩 1：没有 pending（本来就没准备驾驶员）→ 不发车', () => {
    assert.equal(L('none', { pendingDrive: false }), false);
  });
  check('老规矩 2：这轮已经拿到 loopId → 不再发第二次', () => {
    assert.equal(L('none', { sawLoop: true }), false);
  });

  // ★ 决策2 的核心：点名轮不再被前端一刀切吞掉
  check('★决策2：服务端说这轮点名换了人（kind=switch）→ **照样发车**，循环归会话主人', () => {
    assert.equal(L('switch'), true, '前端还在按「switch 就不发车」的旧口径拦着 —— 用户已拍板 allow_with_owner');
  });
  check('★决策2 的另一半：R-A（kind=busy）服务端只回了一句告知、没派活 → **不许**替用户发车', () => {
    assert.equal(L('busy'), false, 'busy 轮被发出去了：用户只是在叫一个正忙的人，结果浏览器动了');
  });
  check('★决策2 的另一半：整条只写了 @名字（kind=empty）→ 服务端反问了一句、没派活 → **不许**发车', () => {
    assert.equal(L('empty'), false);
  });
  check('R-B：@ 的就是当前发言人（kind=self）→ 跟没写 @ 一样，照旧发车', () => {
    assert.equal(L('self'), true);
  });
  check('老后端 / 流被掐（meta 一个都没回来，kind=null）→ 按第 21 步的老规矩发车（不因点名功能变严）', () => {
    /**
     * 这里刻意**不**再本地解析 @ 来「保守拦截」：决策2 之后 switch 轮本来就该发车，
     * 唯一需要拦的 busy/empty 两轮服务端都会正常把 meta 发回来（它们的回法就是 close 前那一帧）。
     * 真连 meta 都没回来时，按老规矩处理，而不是替用户猜服务端判了什么 ——
     * 猜错的方向（该发的没发）会让任务轮凭空消失，这比多发一次更难查。
     */
    assert.equal(L(null), true);
    assert.equal(L(undefined), true);
  });
  check('未知 kind（将来服务端加了新种类）→ 默认放行，只认 busy/empty 两种「告知轮」', () => {
    assert.equal(L('someday'), true, '闸门把没见过的 kind 当成告知轮拦掉了 —— 新功能会被这道闸静默吞掉');
  });
}

// ------------------------------------------------------------------ ② 闸门接线（防「功能存在但没接上」）
log('');
log('--- ② 接线：闸门真的接在那条兜底 launch() 上（现住 features/chat），且桌面不再自己解析 @ ---');
{
  const app = read('apps/desktop/src/App.tsx');
  const gate = read('apps/desktop/src/mentionGate.ts');
  /**
   * ★ 2026-09-25（片 7b）：这些接线**跟着代码走**。
   *   逻辑抽离把「兜底发车 / 发言人裁决」那一侧搬进了 `features/chat/useChat.ts`，
   *   所以探针改为在「App.tsx（组合层）+ features/chat（发送那一侧）」里找 ——
   *   断言的含义一字未改（这条接线在桌面上确实存在、且规则不许散写）。
   */
  const chatSrc = read('apps/desktop/src/features/chat/useChat.ts');
  const desktop = app + '\n' + chatSrc;

  check('App.tsx 从 ./mentionGate 引了 shouldFallbackLaunch', () => {
    assert.ok(/from '\.\/mentionGate'/.test(app), '没有从 ./mentionGate 引入');
    assert.ok(/shouldFallbackLaunch/.test(app));
  });
  check('App.tsx 里那条兜底 launch() 确实包在 shouldFallbackLaunch(...) 的条件里', () => {
    const m = /shouldFallbackLaunch\(\{[\s\S]{0,400}?\}\)\s*\)\s*\n?\s*launch\(\);/.exec(desktop);
    assert.ok(m, '兜底 launch() 没有走 shouldFallbackLaunch —— 闸门写了但没接上');
  });
  check('App.tsx 把服务端 meta.mention.kind 传进了闸门（serverMentionKind）', () => {
    assert.ok(/serverMentionKind:\s*sawMention\?\.kind/.test(desktop));
  });
  check('★决策2 的死代码不许长回来：桌面**任何**源码里都不许再调 parseMention / 传 local', () => {
    // 只查「真的引入 / 真的调用」，不查注释里提到它的名字（注释里写一句 parseMention 不算抄一份实现）
    for (const [name, src] of [['App.tsx', app], ['mentionGate.ts', gate], ['features/chat/useChat.ts', chatSrc]] as const) {
      assert.ok(!/import\s*\{[^}]*\bparseMention\b[^}]*\}\s*from/.test(src), name + ' 自己 import 了 parseMention');
      assert.ok(!/\bparseMention\s*\(/.test(src), name + ' 里调了 parseMention —— 决策2 之后本地解析已无用途');
      assert.ok(!/parseLocalMention|mentionRosterOf/.test(src), name + ' 里还留着本地解析那两个函数');
    }
    assert.ok(!/local:\s*localMention/.test(desktop), '桌面还在往闸门传 local');
  });
  check('桌面运行时不再跨 root 引 shared 源码（只从包里取**类型**），vite 的 fs.allow 也就不该留着', () => {
    assert.ok(!/from ['"][^'"]*shared\/src\//.test(app) && !/from ['"][^'"]*shared\/src\//.test(gate), '还有指向 shared/src 的 import');
    assert.ok(!/fs:\s*\{\s*allow/.test(read('apps/desktop/vite.config.ts')), 'vite.config.ts 里还有 fs.allow（多余的放权）');
    assert.ok(/import type[^;]*ChatSpeaker|ChatSpeaker/.test(desktop), '气泡要用的 ChatSpeaker 类型应来自 shared');
  });
  check('闸门的判据写在 mentionGate 里（NOTICE_ROUND = busy/empty），不散在 App.tsx', () => {
    assert.ok(/NOTICE_ROUND/.test(gate) && /'busy'/.test(gate) && /'empty'/.test(gate));
    assert.ok(!/NOTICE_ROUND/.test(desktop), '规则漏进组件里了');
  });
}

// ------------------------------------------------------------------ ③ 决策1：@ 只换这一轮的发言人
log('');
log('--- ③ 决策1（per_round）：@ 不许改会话归属，下一轮自动回到原来那位 ---');
{
  const chat = read('apps/server/src/routes/chat.ts');

  check('chat.ts 里没有任何一处 UPDATE conversations 的 agent_id（换人只活在这一轮）', () => {
    const m = /UPDATE\s+conversations[\s\S]{0,200}?agent_id\s*=/.exec(chat);
    assert.ok(!m, '出现了改会话归属的 SQL：' + m?.[0].slice(0, 120));
  });
  check('换人轮的会话上下文按「一次性」建（conversationId 传 null，否则拿到的是会话原主人的人设）', () => {
    assert.ok(/const switchedSpeakerId = mention\.kind === 'switch' \? mention\.agentId : null;/.test(chat));
    assert.ok(/switchedSpeakerId !== null \? null : convId/.test(chat), 'buildAgentContext 的 convId 没有按 switch 置 null');
  });
  check('换人只覆盖这一轮真正要用的那个变量（routedAgentId），不碰会话本身', () => {
    assert.ok(/if \(mentionSpeakerId !== null\) routedAgentId = mentionSpeakerId;/.test(chat));
    assert.ok(!/routedAgentId\s*=\s*null/.test(chat));
    assert.ok(/const mentionSwitchRound = mention\.kind === 'switch'/.test(chat), 'mentionSwitchRound 判定不见了');
  });
}

// ------------------------------------------------------------------ ④ 决策2：服务端换人轮也能发车，且循环归会话主人
log('');
log('--- ④ 决策2（allow_with_owner）：换人轮可进工具循环，但循环主人是会话自己那位 ---');
{
  const chat = read('apps/server/src/routes/chat.ts');

  check('★isTaskMode 不再被 mentionSwitchRound 短路（旧的「换人轮一律走聊天」已按拍板撤掉）', () => {
    assert.ok(/const isTaskMode = isExplicitTask \|\| shouldEnterTaskMode\(mentionText, hasActivePage\);/.test(chat),
      'isTaskMode 还挂着 mentionSwitchRound 的否定条件');
    assert.ok(!/!mentionSwitchRound && \(isExplicitTask/.test(chat), '旧口径残留');
  });
  check('发车判定用的正文是剥掉 @名字 之后的 mentionText（@ 只是点名，不是任务内容）', () => {
    assert.ok(/shouldEnterTaskMode\(mentionText,/.test(chat));
  });
  check('★发车轮的 meta.speaker 改成 loop.agentId（否则 meta 说 A 在答、库里记的是 B）', () => {
    const m = /if \(mentionSwitchRound\) \{\s*mentionMeta\.speakerAgentId = loop\.agentId[\s\S]{0,120}?mentionMeta\.speakerName = null;\s*\}/.exec(chat);
    assert.ok(m, '发车分支没有把发言人改成跑循环那位');
  });
  check('★循环主人取的是**会话自己的 agent_id**，不是被点名者（决策2 的「归会话主人」就落在这里）', () => {
    // 会话主人是从库里读出来的（SELECT agent_id FROM conversations），不是从本轮路由变量推的
    assert.ok(/SELECT agent_id FROM conversations WHERE id = \$1/.test(chat), '循环分支没有回读会话的 agent_id');
    assert.ok(/const loopAgentId = Number\.isInteger\(convAgentId\) && convAgentId > 0 \? convAgentId : agentId;/.test(chat),
      'loopAgentId 的算法被改了 —— 被点名者一旦顶进这里，就会去接管别人的页');
    // 反向钉：循环分支里不许拿 mention / routedAgentId 当循环主人
    const loopBranch = chat.slice(chat.indexOf('if (isTaskMode) {'), chat.indexOf('// 第 10 步'));
    assert.ok(!/loopAgentId\s*=\s*(routedAgentId|mention\.|mentionSpeakerId|switchedSpeakerId)/.test(loopBranch),
      '循环主人被换成了本轮点名的那位');
    assert.ok(loopBranch.includes('registerLoopSse(loop.id, res, convId)'), '任务轮的 SSE 长连接口被改动了（顺手确认没碰坏）');
  });
  check('meta.mention 的 kind/hits/unknown 照样带出去（点名这件事不能因为发车就被抹掉）', () => {
    assert.ok(/mention: mentionMeta/.test(chat));
    assert.ok(!/delete mentionMeta\.(kind|hits|unknown)/.test(chat));
  });
}

// ------------------------------------------------------------------ ⑤ 气泡发言人接线
log('');
log('--- ⑤ 接线：气泡上的「这句话是谁说的」---');
{
  const app = read('apps/desktop/src/App.tsx');
  /** ★ 同 ②：发言人这一侧的「类型 / 历史映射 / 裁决」已随 `sendChat` 搬进 features/chat */
  const chatSrc = read('apps/desktop/src/features/chat/useChat.ts');
  const data = app + '\n' + chatSrc;

  check('Message 类型带 speaker?: ChatSpeaker（前端消息模型里有发言人这一格）', () => {
    assert.ok(/speaker\?:\s*ChatSpeaker;/.test(data));
  });
  check('历史映射把服务端的 speaker 带进来（speaker: m.speaker）', () => {
    assert.ok(/speaker:\s*m\.speaker/.test(data), '/chat/history 的 speaker 没有落到前端消息上');
  });
  check('流式结束时按 meta.mention 的裁决给这条气泡挂发言人', () => {
    assert.ok(/sawMention\.speakerAgentId/.test(data));
    assert.ok(/speaker:\s*spokenBy/.test(data));
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
