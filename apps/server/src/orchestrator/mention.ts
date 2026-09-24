/**
 * 批次 J · 服务端：把「@点名」解析成**这一轮该怎么走**的决定
 *
 * ★ 解析本体只有一份：`packages/shared/src/mention.ts` 的 `parseMention`。
 *   服务端走包名导入（`@ai-workbench/shared`，需要 shared 的 dist 已构建，`npm run build` 会先建它）；
 *   桌面渲染进程走源码相对路径；Electron **主进程运行时不得 import shared**（见 shared/src/index.ts 的说明）。
 *
 * 本文件只负责「服务端才知道」的三件事：
 *  1) **名单从哪来**：当前用户的 currentProjectId + `loadProjectRoster`（项目内、含忙/等标记）。
 *     名单里的名字与「委派同事」用的是同一份（persona.name 优先），所以 @点名 与 委派 不会对不上号。
 *     跨项目点不到 → 名单里根本没有那个名字 → 规则 4 自动成立。
 *  2) **R-A**：被点名的智能体此刻是不是忙/在等 —— 忙就**不静默改派**，回一段「它在做什么 + 要不要等/换人」。
 *     「忙」只认 working/thinking/waiting 三态；blocked（循环停了/暂停了）不算，理由见 BUSY_STATUSES。
 *  3) **R-B/R-C** 落到决定上：@自己 = 视作没点名；交给智能体的正文一律剥掉 @名字 段。
 */
import type { Pool } from 'pg';
import { parseMention, type MentionHit, type MentionRosterEntry } from '@ai-workbench/shared';
import { loadProjectRoster } from './roster';
import { resolveAgentStatus, type AvatarStatus } from './agentStatus';
import { currentProjectId } from '../projectScope';

/**
 * 点名用的名单项就是 shared 里的 `MentionRosterEntry`（id + 名字）——
 * 类型也只有一份，服务端这里**不再另定义一个同名的**（否则两端字段会各自漂移）。
 */
export type { MentionRosterEntry };

/**
 * 取「这一刻可以被 @ 的名单」。
 *
 * 没有当前项目 → 空名单（此时任何 @xxx 都不命中，按普通文本走，不报错）。
 * 项目归属由 `currentProjectId` 校验（只认这个用户自己的当前项目）。
 */
export async function loadMentionRoster(pool: Pool, userId: number): Promise<MentionRosterEntry[]> {
  const projectId = await currentProjectId(pool, userId);
  if (projectId === null) return [];
  const roster = await loadProjectRoster(pool, userId, projectId, null);
  return roster
    .map((r) => ({ id: r.id, name: r.name }))
    .filter((r) => typeof r.name === 'string' && r.name.length > 0);
}

/** 这一轮的决定（chat.ts 只按 kind 分支，不再自己判规则） */
export type ChatMentionDecision =
  /** 没有点名（含「@ 了但名单里没有」）→ 照普通聊天走，正文原样 */
  | { kind: 'none'; text: string; unknown: string[] }
  /** R-B：点的是当前发言人自己 → 视作没点名，不改派、不报错；正文已剥 @ */
  | {
      kind: 'self';
      agentId: number | null;
      agentName: string;
      text: string;
      mentions: MentionHit[];
      unknown: string[];
    }
  /** 正常改派：被点名者空闲 → 这一轮换成它 */
  | { kind: 'switch'; agentId: number; agentName: string; text: string; mentions: MentionHit[]; unknown: string[] }
  /** R-A：被点名者正忙/在等 → **不改派**，回一段告知（notice 就是要发的正文） */
  | {
      kind: 'busy';
      agentId: number;
      agentName: string;
      status: AvatarStatus;
      detail: string;
      notice: string;
      mentions: MentionHit[];
      unknown: string[];
    }
  /** R-C 边界：整条只写了 @名字 → 不调模型，反问用户要做什么 */
  | {
      kind: 'empty';
      agentId: number | null;
      agentName: string;
      notice: string;
      mentions: MentionHit[];
      unknown: string[];
    };

/** 决定里「要不要发 notice 而不调模型」的判定（chat.ts 用） */
export function decisionNotice(d: ChatMentionDecision): string | null {
  return d.kind === 'busy' || d.kind === 'empty' ? d.notice : null;
}

/** 决定要不要改派发言人（chat.ts 用）：只有 switch 才改 */
export function decisionSpeaker(d: ChatMentionDecision): number | null {
  return d.kind === 'switch' ? d.agentId : null;
}

/**
 * 哪些状态算「忙得接不下这一轮」。
 *
 * · working / thinking —— 循环**正在跑**（真在干活，占着这张页与步数）；
 * · waiting           —— 正在等自己委派出去的结果（registry 的名额被它占着）；
 * · idle / done       —— 空得下来，正常换人。
 *
 * ★ **blocked 刻意不算忙**（这一条是端到端验收 T3.10 打出来的）：
 *   `resolveAgentStatus` 把「循环 paused / stopped / failed」都归到 blocked —— 那是**头像状态**的语义
 *   （「这条循环需要你来看一眼」），不是「它腾不出手」。恰恰相反：blocked 的智能体此刻**没在干活**，
 *   正在等人；这时候 @ 它，它完全能答话（聊天与那条停住的循环互不相干）。
 *   把 blocked 当忙，后果是「一个智能体只要停过一次循环，五分钟之内就再也点不动它」——
 *   用户 @ 它只会得到一句「它卡住了」，而它其实闲着。
 */
const BUSY_STATUSES: ReadonlySet<AvatarStatus> = new Set(['working', 'waiting', 'thinking']);

function busyPhrase(status: AvatarStatus, detail: string): string {
  switch (status) {
    case 'waiting':
      return `正在等它委派出去的活回结果（${detail}）`;
    case 'working':
      return `手上正有活在做（${detail}）`;
    case 'thinking':
      return `正在处理上一轮、还没腾出手（${detail}）`;
    default:
      return detail || '正忙';
  }
}

/**
 * 解析 + 规则落地。
 *
 * @param roster          当前项目名单（`loadMentionRoster`）
 * @param message         用户这一轮的**原始**文本（含 @名字）
 * @param currentAgentId  当前会话的发言人（没有就 null）—— R-B 要用
 */
export function resolveChatMention(opts: {
  roster: MentionRosterEntry[];
  message: string;
  currentAgentId: number | null;
}): ChatMentionDecision {
  const parsed = parseMention(opts.message, opts.roster, opts.currentAgentId ?? undefined);

  // R-C 边界：整条只写了 @名字（不管点的是自己还是别人）→ 没活可派，反问一句
  if (parsed.textEmpty) {
    const first = parsed.mentions[0] ?? null;
    const name = first?.name ?? '';
    const who = first ? `你只 @ 了 ${name}，` : '你这条消息里只有 @，';
    return {
      kind: 'empty',
      agentId: first?.agentId ?? null,
      agentName: name,
      notice: `${who}没写要它做什么。补一句要做的事，我就把这轮交给${first ? '它' : '对应的智能体'}。`,
      mentions: parsed.mentions,
      unknown: parsed.unknown,
    };
  }

  // R-B：第一个命中就是当前发言人自己（或只 @ 了自己）→ 视作没点名
  if (parsed.selfMention) {
    // selfMention 的判据在 parseMention 里就是「第一个命中 === currentAgentId」，
    // 所以这里直接用 currentAgentId 反查名字（MentionHit 上没有 self 标记，别去找）。
    const selfId = opts.currentAgentId ?? null;
    const selfName = opts.roster.find((r) => r.id === selfId)?.name ?? '';
    return {
      kind: 'self',
      agentId: selfId,
      agentName: selfName,
      text: parsed.text,
      mentions: parsed.mentions,
      unknown: parsed.unknown,
    };
  }

  // 没有命中（含「@ 了但名单里没这个人 / @ 与名字之间有空格」）→ 普通聊天
  if (!parsed.speaker) {
    return { kind: 'none', text: parsed.text, unknown: parsed.unknown };
  }

  const speaker = parsed.speaker;
  const live = resolveAgentStatus(speaker.agentId);

  // R-A：忙/等 → 不静默改派，回告知
  if (BUSY_STATUSES.has(live.status)) {
    return {
      kind: 'busy',
      agentId: speaker.agentId,
      agentName: speaker.name,
      status: live.status,
      detail: live.detail,
      notice:
        `你点的 ${speaker.name} 此刻${busyPhrase(live.status, live.detail)}。` +
        `我没有把这轮偷偷改派给它，也没有替你另换一个人。` +
        `你可以：等它忙完再 @ 它一次；或者 @ 别的智能体；` +
        `或者直接说你要什么，这轮就按现在的会话继续。`,
      mentions: parsed.mentions,
      unknown: parsed.unknown,
    };
  }

  return {
    kind: 'switch',
    agentId: speaker.agentId,
    agentName: speaker.name,
    text: parsed.text,
    mentions: parsed.mentions,
    unknown: parsed.unknown,
  };
}

/**
 * R-A / R-C 边界：这句「告知」由谁开口。
 *
 * ★ busy 那一轮**绝不能**让被点名的那个正忙的智能体自己开口 —— 它没接这轮，
 *   替它说话就等于又一次「静默改派」（R-A 明令禁止的那种）。
 *   顺序：会话当前发言人 → 请求/路由带来的那个 → 项目管家 → 名单里任何一个不是它的人。
 * ★ empty（只写了 @名字）相反：**优先让被点名者自己问**「你要我做什么」最自然，
 *   它此刻并不忙（busy 判定在 empty 之后才跑，真忙也已经由 busy 分支接管）。
 */
export function pickNoticeSpeaker(opts: {
  decision: ChatMentionDecision;
  currentSpeakerId: number | null;
  fallbackAgentId: number | null;
  roster: MentionRosterEntry[];
}): number | null {
  const d = opts.decision;
  const henName = '项目管家';
  if (d.kind === 'empty' && d.agentId !== null) {
    const busy = resolveAgentStatus(d.agentId).status;
    if (!BUSY_STATUSES.has(busy)) return d.agentId;
  }
  const blocked = d.kind === 'busy' ? d.agentId : null;
  const candidates = [
    opts.currentSpeakerId,
    opts.fallbackAgentId,
    opts.roster.find((r) => r.name === henName)?.id ?? null,
    ...opts.roster.map((r) => r.id),
  ];
  for (const c of candidates) {
    if (c !== null && Number.isInteger(c) && c > 0 && c !== blocked) return c;
  }
  return null;
}
