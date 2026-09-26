// ★ 从 shared 引类型（不是从 toolLoop 转引 —— toolLoop 只是 import 它、并没有 re-export）
import type { AgentLoopDecision } from '@ai-workbench/shared';

/**
 * 交互对齐片(2026-09-26) · **哪些循环决策才该写进聊天长连的 `delta`**。
 *
 * 背景(用户报的):执行中主对话流里出现「步骤墙」——
 * `**步骤 1**：…`、`🎉 任务完成`、`> ℹ️ …`、`💬 用户补充指令：…` 全都被当成 `delta`
 * 写进了助手气泡;而同一句话又通过**结构化事件**渲染了一遍 ⇒ 同一段出现两次。
 *
 * 用户定的目标态:**过程轨迹与最终回答分开**。
 *   · 轨迹(步骤/完成/等待/求助/停止) → 只走结构化事件(`step`/`note`/`ask`/`done`/`stopped`),
 *     由桌面端放进「可点开、默认收起」的抽屉;
 *   · **只有 `say`(模型对用户说的话)才进聊天流的 delta** —— 那才是「回答」。
 *
 * ★ 为什么单独放一个模块而不是写在路由里:这条口径必须能被**穷举验证**
 *   (`scripts/verify/chat-trace-isolation.mts`)。一旦有人把步骤改回 delta,验收立刻红。
 *   本模块**零运行时依赖**(只 import 一个 type),所以验收脚本不需要起服务端/连库。
 */
export function chatDeltaFor(decision: AgentLoopDecision): string | null {
  if (decision.kind === 'say') return `\n\n${decision.text}`;
  return null;
}
