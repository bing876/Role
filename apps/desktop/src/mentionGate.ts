/**
 * 批次 J · 渲染进程这一侧的 @点名 闸门（**唯一**一处，App.tsx 只调它，不在组件里散写规则）。
 *
 * ★ 用户 2026-09-24 拍板（决策2 = allow_with_owner）之后，这一侧**不再自己解析 @**：
 *   点名轮**允许**发车（循环归会话主人），所以「文本里有 @」不再是不发车的理由 ——
 *   本地解析在这里已经没有任何能改变结果的用途，留着一个没人用的调用就是死代码。
 *   裁决权本来也只在服务端（名单归属、谁在忙，前端都不知道）。
 *   解析器仍然只有一份：`packages/shared/src/mention.ts`（服务端运行时用；
 *   桌面只从 shared 取**类型**，`ChatMentionMeta` / `ChatSpeaker`）。
 *   `verify:mention:parse` 的第 ⑧ 段继续钉住「全仓 parseMention 只许有一处定义」——
 *   将来谁想在桌面抄一份正则，那条闸会先红。
 * ★ Electron **主进程**运行时绝不能 import shared（tsc 直出、打包后没有 node_modules → 启动即崩）。
 *   主进程要知道「这轮点了谁」只能读服务端 SSE 的 meta.mention。
 */

/**
 * 服务端说了「这一轮它已经用一句告知答过了」—— R-A（busy：被点名者正忙）
 * 与 R-C 边界（empty：整条只写了 @名字）。这两种服务端**没有派任何活**、
 * 也**没有调模型**，回的是固定人话；这时候桌面再兜底把驾驶员发出去，
 * 就等于把用户的一句「@某人」变成了一次浏览器操作。
 *
 * `switch`（换人）与 `self`（R-B：@ 的就是当前发言人）**不在这里**：
 * 按决策2，这两种轮该发车就发车（循环归会话主人）。
 */
const NOTICE_ROUND = new Set(['busy', 'empty']);

/**
 * 第 21 步那道「没拿到 loopId 也要发车」的兜底，**这一轮到底该不该发**。
 *
 * 三个条件全真才发（少一个都不发）：
 *  1. `pendingDrive`  —— 桌面本来就把这条指令预备给了驾驶员（有活页/有 pending）；
 *  2. `!sawLoop`      —— 服务端这轮**没有**给过 loopId（给过就已经发车了，不能再发一次）；
 *  3. `!noticeRound`  —— 服务端没说「这轮我只回了一句告知」（meta.mention.kind ∈ busy/empty）。
 *
 * @returns true = 发车（调 launch()）；false = 这一轮不发
 */
export function shouldFallbackLaunch(input: {
  pendingDrive: boolean;
  sawLoop: boolean;
  /** 服务端 meta.mention.kind（老后端 / 流断 → null，此时按老规矩发） */
  serverMentionKind?: string | null;
}): boolean {
  return (
    Boolean(input.pendingDrive) && !input.sawLoop && !NOTICE_ROUND.has(String(input.serverMentionKind ?? ''))
  );
}
