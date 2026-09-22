/**
 * 多智能体编排 · **被委派子循环的独立容器**。
 *
 * ★ 为什么子循环不能放进 `toolLoop.ts` 那张 `loops` Map（改这里前先读）：
 *   那张 Map 有 `MAX_LIVE_LOOPS = 32` 的上限，`sweep()` 的淘汰策略是「按 touchedAt 从旧到新删」。
 *   子循环挤进去会**把用户挂起 6 小时的浏览器循环挤掉**（反向也成立：用户的页会把子循环挤掉，
 *   委派跑到一半上下文没了）。所以子循环是 `detached` 的，由这里单独管。
 *
 *   `advance(env, session, result)` 本身**不查** Map（它只操作传进来的 session 对象），
 *   所以分离式循环照样能被驱动 —— 这是整个设计能成立的前提。
 *
 * 两个附带好处：
 *   · HTTP 路由（`/agent/loop/next` 等）走的是 `getLoop()`，**天然查不到子循环** ——
 *     子循环没有桌面手，被 `/next` 找到反而是漏洞（客户端能驱动一条不属于它的循环）；
 *   · 子循环不 `bindPageLoop`，所以它绝不会把某张真实页的「正在跑的循环」指向自己。
 *
 * 回收：不做 TTL。每条子循环都挂在一个 job 上，job 有 deadline（≤10 分钟），
 * 到点必然结束（完成 / 超时熔断），结束时从这张表里删掉。没有 deadline 的子循环不存在。
 */
import { getLoop, type LoopSession } from '../toolLoop';

const subLoops = new Map<string, LoopSession>();

export function registerSubLoop(session: LoopSession): void {
  subLoops.set(session.id, session);
}

export function unregisterSubLoop(loopId: string): void {
  subLoops.delete(loopId);
}

export function getSubLoop(loopId: string): LoopSession | null {
  return subLoops.get(loopId) ?? null;
}

export function subLoopCount(): number {
  return subLoops.size;
}

/** 子循环的对外投影（诊断 / /health / 验收脚本用） */
export interface SubLoopView {
  id: string;
  agentId: number | null;
  status: string;
  step: number;
  wcId: number | null;
  kind: string | null;
  parentLoopId: string | null;
  /** 委派链：链深闸与成环闸全靠它，所以必须在投影里看得见 */
  chain: number[];
  detached: boolean;
}

/**
 * 当前在册的子循环。
 *
 * ★ 返回**只读投影**（不是 session 本身）：session 上的 `messages` 可能带用户隐私、
 *   `abortCtl` 是可掐的把手 —— 诊断接口不该拿到这些，拿到的应该是能贴进工单的那几个字段。
 */
export function listSubLoops(): SubLoopView[] {
  return [...subLoops.values()].map((s) => ({
    id: s.id,
    agentId: s.agentId,
    status: s.status,
    step: s.step,
    wcId: s.wcId,
    kind: s.kind ?? null,
    parentLoopId: s.parentLoopId ?? null,
    chain: Array.isArray(s.chain) ? [...s.chain] : [],
    detached: s.detached === true,
  }));
}

/**
 * 按 id 找一条循环：**先查子循环，再查主循环**。
 *
 * 结果投递（`deliverJobResult`）必须用它 —— 发起方可能是浏览器循环（在 `loops` 里），
 * 也可能是另一条子循环（链深 2 时 A→B→C，B 就是子循环）。
 */
export function resolveLoop(loopId: string): LoopSession | null {
  return subLoops.get(loopId) ?? getLoop(loopId);
}
