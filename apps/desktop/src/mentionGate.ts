/**
 * 批次 J · 渲染进程这一侧的 @点名 判定（**唯一**一处，App.tsx 只调它，不在组件里散写规则）。
 *
 * ★ 解析本体仍是 `packages/shared/src/mention.ts` 的 `parseMention` —— 两端同一份实现。
 *   这里按**源码相对路径**引，不按包名：桌面所有 `@ai-workbench/shared` 的 import 都是
 *   `import type`（编译期擦掉），一旦按包名引**值**就会去解 packages/shared/dist，
 *   平白多一个「先 build shared 再起 dev」的前置条件。Vite 会把这份源码直接打进渲染进程产物，
 *   打包后的 app 里没有 node_modules 也照跑。
 * ★ Electron **主进程**运行时绝不能 import shared（tsc 直出、打包后没有 node_modules → 启动即崩）。
 *   所以这套只在渲染进程用；主进程要知道「这轮点了谁」只能问服务端（SSE meta.mention）。
 *
 * 为什么前端要自己判一次（服务端才是裁决方）：
 *   只为一件事 —— **流断了也不误发车**。第 21 步那道兜底只看「有没有拿到 loopId」，
 *   而服务端对 @点名换人轮一律不发车；万一这轮 502 / 连接被掐、连 meta 都没回来，
 *   兜底就会替用户把驾驶员发出去。用户明明只是在叫另一个人说话。
 */
import { parseMention, type MentionRosterEntry } from '../../../packages/shared/src/mention';

/** 桌面手里的智能体（只用得到 id 与名字，所以这里只声明这两个字段，不绑 AgentView 全量） */
export interface MentionRosterSource {
  id: number;
  name: string;
}

/** 当前项目名单 → 点名名单（名字为空 / id 非法的丢掉，免得解析出个点不到的「人」） */
export function mentionRosterOf(agents: readonly MentionRosterSource[]): MentionRosterEntry[] {
  return agents
    .filter((a) => Number.isInteger(a?.id) && a.id > 0 && typeof a?.name === 'string' && a.name.trim().length > 0)
    .map((a) => ({ id: a.id, name: a.name }));
}

/** 本地解析结果（只留渲染进程真要用的三样，别的都在服务端那边） */
export interface LocalMention {
  /** 点了「别人」（@ 自己按 R-B 视作没点名 → false） */
  round: boolean;
  /** 点到的那个人（本地视角；服务端可能因为它正忙而不换人） */
  speakerId: number | null;
  /** 剥掉 @名字 之后的正文还剩几个字（只用于日志/调试，不显示正文本身） */
  textLength: number;
}

/**
 * 本地解析一次。
 *
 * @param text           用户刚输入的原文
 * @param agents         当前项目的名单（切项目就换一份，与联系人列表同源）
 * @param currentAgentId 这一刻正在跟用户说话的那个（R-B 的判据）
 */
export function parseLocalMention(
  text: string,
  agents: readonly MentionRosterSource[],
  currentAgentId: number | null,
): LocalMention {
  const r = parseMention(text, mentionRosterOf(agents), currentAgentId ?? undefined);
  return {
    round: r.speaker !== null,
    speakerId: r.speaker ? r.speaker.agentId : null,
    textLength: [...r.text].length,
  };
}

/**
 * 服务端说的「这一轮跟点名有关」—— switch（换人了）/ busy（R-A：它在忙，回了一句告知）/
 * empty（R-C 边界：只写了 @名字，回了一句反问）。这三种服务端都**没有**派任何浏览器活，
 * 桌面也就没有理由替用户把驾驶员发出去。
 * none（没点名）与 self（R-B：@ 的就是当前发言人 = 视作没写 @）不算，兜底照旧。
 */
const SERVER_MENTION_ROUND = new Set(['switch', 'busy', 'empty']);

/**
 * 第 21 步那道「没拿到 loopId 也要发车」的兜底，**这一轮到底该不该发**。
 *
 * 四个条件全真才发（少一个都不发）：
 *  1. `pendingDrive`   —— 桌面本来就把这条指令预备给了驾驶员（有活页/有 pending）；
 *  2. `!sawLoop`       —— 服务端这轮**没有**给过 loopId（给过就已经发车了，不能再发一次）；
 *  3. `!serverRound`   —— 服务端没说「这轮是点名轮」（meta.mention.kind ∈ switch/busy/empty，权威裁决）；
 *  4. `!local.round`   —— 本地解析也没点到别人（**兜底的兜底**：流被掐时根本拿不到 meta，
 *                         这一条是唯一还能拦住误发车的东西）。
 *
 * @returns true = 发车（调 launch()）；false = 这一轮不发
 */
export function shouldFallbackLaunch(input: {
  pendingDrive: boolean;
  sawLoop: boolean;
  /** 服务端 meta.mention.kind（老后端 / 流断 → null） */
  serverMentionKind?: string | null;
  /** 本地解析的结果（parseLocalMention） */
  local: LocalMention;
}): boolean {
  const serverRound = SERVER_MENTION_ROUND.has(String(input.serverMentionKind ?? ''));
  return Boolean(input.pendingDrive) && !input.sawLoop && !serverRound && !input.local.round;
}
