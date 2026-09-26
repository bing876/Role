import { webContents } from 'electron';
import { viewHostRegistry } from './view-host';
import { classifyField, FIELD_REASON_CN, isPaymentConfirmAction, type FieldDescriptor } from './fieldClass';
// ADR-0003 · 浏览器深度 第一片:wait-for / watch 原语的纯 core(不 import electron,可单测);
// 这里只做「wcId → 真实 debugger」的薄包装。
import {
  coreWaitFor,
  coreWatch,
  type CdpSend,
  type CdpEvents,
  type WaitForSpec,
  type WaitForResult,
  type WatchEvent,
  type WatchHandle,
  type WatchSpec,
} from './wait-watch';
import type {
  BrowserAction,
  BrowserActionType,
  DriveActionLabel,
  DriveResult,
  PageSnapshot,
  TaskPhase,
  TaskState,
} from '@ai-workbench/shared';

/**
 * 第 3 步「遥控器先通」——本地驾驶执行器。
 *
 * 目标：让程序能驾驶**主窗口右栏那块内嵌页**（不是独立窗口、不是云端浏览器）。
 * 手段：主进程拿到该页 guest 的 `webContents`（ADR-0002 起是 view-host 托管的
 *      WebContentsView），挂上 `webContents.debugger`（CDP 1.3），
 *      用 `Runtime.evaluate` + `Input.dispatchMouseEvent` 这类协议命令去操作页面。
 *
 * 明确不做的事：
 *   - 不用 Playwright / Puppeteer / 再下一份 Chrome（那会多出一个浏览器进程，违背“驾驶现有内嵌页”）
 *   - 不创建任何 BrowserWindow（第 2 步已经把独立窗口砍掉了）
 *   - 渲染进程不 require('electron')，所有能力只从 preload 的 window.workbench.* 进来
 *
 * 执行器形态：传入一个动作 → 在内嵌页执行 → 返回 { ok, pageSnapshot }。
 *
 * 第 4 步：在"单发动作"之上加一层**任务状态机**（idle | running | paused | done | failed）。
 * 权威状态只有主进程这一份；渲染层的横幅（「AI 正在控制 / 你正在控制」）通过 'state' 广播做镜像。
 * 明确**不接大模型**：恢复运行时的"下一步"是基于 read_page 快照的规则判断（planNext），
 * 并且每一步执行前都复查状态机 —— 暂停后不会再发出任何一次自动 click / type，也永远
 * 不重放暂停前的步骤（恢复 = 先读用户当前真实页面，再据此决定）。
 *
 * 第 22 步（浏览器多实例融合 · 原计划 Phase 2）：**驾驶目标必须点名**。
 *   - 删掉 `findWebviewGuest()` 盲选兜底，`resolveTarget()` 在「没给 id」和「id 已失效」
 *     两种情况下都当场抛错（详见该函数注释）；
 *   - 第 4 步的 demo 循环随之必须由调用方传 `webContentsId`（`startTask(id)`），
 *     没点名就置 failed，而不是随便挑一张页去点。
 */

/** 被暂停拦截的动作（其余动作如 open_url / scroll / read_page 仍然允许） */
const PAUSED_BLOCKED: ReadonlySet<BrowserActionType> = new Set<BrowserActionType>(['click', 'type', 'fill_form']);

// ---------------------------------------------------------------------------
// 动作**形状**校验（`workbench:drive` 这道 IPC 的入口闸）
//
// 为什么必须有它（改这里前先读完）：
//   `workbench:drive` 的入参是从**渲染层**过来的 `unknown`。TS 的类型标注在这里
//   只是"承诺"，运行时什么都能传进来。没有校验时会出两类问题：
//     ① `action` 传成 null / 字符串 / 数组 → `drive()` 第一行 `action.action` **当场抛 TypeError**，
//        而且是在 try 之外 —— IPC 直接 reject，调用方拿到一句栈而不是人话；
//     ② `action` 是个对象但字段类型不对（`{action:'wait', seconds:'abc'}`）→
//        各分支拿着 undefined/NaN 继续跑：`wait` 会 `Math.min(Math.max(NaN,0),30)` → NaN →
//        setTimeout 立刻返回（**静默变成"没等"**）；`click` 会拿 undefined 去找元素。
//        这类"不报错、只是行为不对"最难查。
//
// 校验口径（刻意宽松，别收得太紧）：
//   - **只查形状**（字段在不在、类型对不对、数值范不范范），不查业务语义。
//     例如 `url` 传空串仍然放行 —— 空地址该由 `navigate()` 给出它自己那句人话错误，
//     在这里提前拦掉会把既有错误文案换掉（agent 侧的 `NO_INPUT_FOUND` 之类判断会跟着失灵）。
//   - **允许未知的额外字段**（忽略即可）：将来给某个动作加可选参数时，
//     老版本主进程不该因为多了个字段就拒收。
//   - 长度上限只用来挡住明显异常的输入，值给得很宽（见下面各常量）。
// ---------------------------------------------------------------------------

const MAX_URL_LEN = 2_000;
const MAX_TARGET_LEN = 1_000;
const MAX_TEXT_LEN = 20_000;
const MAX_REASON_LEN = 1_000;
const MAX_OUTLINE_ITEMS = 100;
const MAX_FORM_FIELDS = 100;
const MAX_WAIT_SECONDS = 300;

export type ActionShapeCheck =
  | { ok: true; action: BrowserAction }
  | { ok: false; error: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 出错时把"收到的到底是什么"说清楚 —— 只说"参数错误"没法排查 */
function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return '数组';
  const names: Record<string, string> = {
    string: '字符串',
    number: '数字',
    boolean: '布尔',
    object: '对象',
    undefined: 'undefined',
    function: '函数',
    symbol: 'symbol',
    bigint: 'bigint',
  };
  return names[typeof v] ?? typeof v;
}

/**
 * 校验一个来自 IPC 的动作。**只认形状**，不改写语义。
 *
 * @returns ok=true 时给出**已归一化**的动作（可安全当 `BrowserAction` 用）；
 *          ok=false 时 error 是一句可以直接贴给用户看的人话。
 */
export function validateBrowserAction(raw: unknown): ActionShapeCheck {
  const bad = (why: string): ActionShapeCheck => ({
    ok: false,
    error: `${why}——没有执行任何动作。`,
  });

  if (!isPlainObject(raw)) return bad(`动作必须是一个对象（收到 ${typeOf(raw)}）`);
  const name = raw.action;
  if (typeof name !== 'string' || name === '') {
    return bad(`动作缺少 action 字段，或它不是字符串（收到 ${typeOf(name)}）`);
  }

  /** 取一个字符串字段。required=false 时缺失按空串处理（语义交给 driver 判） */
  const str = (
    key: string,
    max: number,
    required = true,
  ): { ok: true; v: string } | { ok: false; why: string } => {
    const v = raw[key];
    if (v === undefined) {
      return required ? { ok: false, why: `「${name}」缺少 ${key}` } : { ok: true, v: '' };
    }
    if (typeof v !== 'string') {
      return { ok: false, why: `「${name}」的 ${key} 必须是字符串（收到 ${typeOf(v)}）` };
    }
    if (v.length > max) {
      return { ok: false, why: `「${name}」的 ${key} 太长（${v.length} 字，上限 ${max}）` };
    }
    return { ok: true, v };
  };

  switch (name) {
    case 'open_url': {
      const r = str('url', MAX_URL_LEN);
      return r.ok ? { ok: true, action: { action: 'open_url', url: r.v } } : bad(r.why);
    }
    case 'click': {
      const r = str('target', MAX_TARGET_LEN);
      return r.ok ? { ok: true, action: { action: 'click', target: r.v } } : bad(r.why);
    }
    case 'type': {
      const t = str('target', MAX_TARGET_LEN);
      if (!t.ok) return bad(t.why);
      const x = str('text', MAX_TEXT_LEN, false);
      if (!x.ok) return bad(x.why);
      const submitRaw = raw.submit;
      if (submitRaw !== undefined && typeof submitRaw !== 'boolean') {
        return bad(`「type」的 submit 必须是布尔（收到 ${typeOf(submitRaw)}）`);
      }
      return { ok: true, action: { action: 'type', target: t.v, text: x.v, submit: Boolean(submitRaw) } };
    }
    case 'scroll': {
      const d = raw.direction;
      if (d !== 'up' && d !== 'down') {
        return bad(`「scroll」的 direction 只能是 "up" 或 "down"（收到 ${JSON.stringify(d) ?? typeOf(d)}）`);
      }
      return { ok: true, action: { action: 'scroll', direction: d } };
    }
    case 'wait': {
      const s = raw.seconds;
      if (typeof s !== 'number' || !Number.isFinite(s)) {
        return bad(`「wait」的 seconds 必须是一个有限数字（收到 ${typeOf(s)}）`);
      }
      if (s <= 0 || s > MAX_WAIT_SECONDS) {
        return bad(`「wait」的 seconds 必须在 0~${MAX_WAIT_SECONDS} 之间（收到 ${s}）`);
      }
      return { ok: true, action: { action: 'wait', seconds: s } };
    }
    case 'read_page':
      return { ok: true, action: { action: 'read_page' } };
    case 'screenshot':
      return { ok: true, action: { action: 'screenshot' } };
    case 'ask_user': {
      const r = str('reason', MAX_REASON_LEN, false);
      if (!r.ok) return bad(r.why);
      const q = str('question', MAX_TEXT_LEN, false);
      if (!q.ok) return bad(q.why);
      return { ok: true, action: { action: 'ask_user', reason: r.v, question: q.v } };
    }
    case 'done': {
      const s = str('summary', MAX_TEXT_LEN, false);
      if (!s.ok) return bad(s.why);
      const t = str('document_title', MAX_TARGET_LEN, false);
      if (!t.ok) return bad(t.why);
      const o = raw.document_outline;
      let outline: string[] = [];
      if (o !== undefined) {
        if (!Array.isArray(o)) return bad(`「done」的 document_outline 必须是字符串数组（收到 ${typeOf(o)}）`);
        if (o.length > MAX_OUTLINE_ITEMS) {
          return bad(`「done」的 document_outline 条目太多（${o.length}，上限 ${MAX_OUTLINE_ITEMS}）`);
        }
        const badIdx = o.findIndex((x) => typeof x !== 'string');
        if (badIdx >= 0) {
          return bad(`「done」的 document_outline 第 ${badIdx + 1} 项不是字符串（收到 ${typeOf(o[badIdx])}）`);
        }
        outline = o as string[];
      }
      return { ok: true, action: { action: 'done', summary: s.v, document_title: t.v, document_outline: outline } };
    }
    case 'fill_form': {
      const f = raw.fields;
      if (!Array.isArray(f)) return bad(`「fill_form」的 fields 必须是数组（收到 ${typeOf(f)}）`);
      if (f.length > MAX_FORM_FIELDS) {
        return bad(`「fill_form」的 fields 条目太多（${f.length}，上限 ${MAX_FORM_FIELDS}）`);
      }
      const fields: { target: string; text: string }[] = [];
      for (let i = 0; i < f.length; i++) {
        const item = f[i];
        if (!isPlainObject(item)) return bad(`「fill_form」第 ${i + 1} 项必须是对象（收到 ${typeOf(item)}）`);
        if (typeof item.target !== 'string') {
          return bad(`「fill_form」第 ${i + 1} 项的 target 必须是字符串（收到 ${typeOf(item.target)}）`);
        }
        if (typeof item.text !== 'string') {
          return bad(`「fill_form」第 ${i + 1} 项的 text 必须是字符串（收到 ${typeOf(item.text)}）`);
        }
        if (item.target.length > MAX_TARGET_LEN || item.text.length > MAX_TEXT_LEN) {
          return bad(`「fill_form」第 ${i + 1} 项超长`);
        }
        fields.push({ target: item.target, text: item.text });
      }
      return { ok: true, action: { action: 'fill_form', fields } };
    }
    case 'focus_sensitive_field': {
      const t = str('target', MAX_TARGET_LEN);
      if (!t.ok) return bad(t.why);
      const r = str('fieldReason', MAX_REASON_LEN, false);
      if (!r.ok) return bad(r.why);
      return { ok: true, action: { action: 'focus_sensitive_field', target: t.v, fieldReason: r.v } };
    }
    default:
      return bad(`未知动作「${name}」`);
  }
}

type Target = Electron.WebContents;

// ---------------------------------------------------------------------------
// 第 4 步：状态机 —— 第 22 步起**按 target 独立存储**（A1.5）
//
// 以前这里是一组模块级全局变量（phase / phaseDetail / phaseStep / paused / loopToken），
// 因为全窗口只有一张 webview。多实例之后那样必然串味：
// 「A 那张页在跑」会显示成「B 那张页在跑」，一路暂停会把另一路也按住。
//
// 现在状态一律按 **target（内嵌页的 webContentsId）** 存在 Map 里，**没有全局单例**。
// 并发数由配置项管（settings.ts 的 maxConcurrentAgentTasks，默认 20）：
// 调成 1 就退化成「同一时刻只有一张页有活任务」，调大就是真并行，
// 这份数据结构都不用再动 —— 这正是 A1.5 要的「数据先按 target 分开、并发数后调」。
// ---------------------------------------------------------------------------

/** 一张内嵌页自己那一份任务状态 */
interface TargetTask {
  phase: TaskPhase;
  detail: string;
  step: number;
  /** 自动 click / type 当前是否被拒（第 3 步语义，**按 target 独立**） */
  paused: boolean;
  /** 循环令牌：每次开始 / 暂停都自增；循环只在令牌仍有效时才继续下一步 */
  loopToken: number;
  /** 写入顺序号：只用于「没有活任务时，回放**最近一次**终止态」 */
  seq: number;
  /**
   * 第 27 步：这次 `paused` 是谁发起的（`'user'` 用户接管 / `'agent'` AI 求助）。
   * 只影响界面呈现（颜色/图标/文案），不参与任何驾驶判定 —— 它不该有副作用。
   */
  pausedBy: 'user' | 'agent' | null;
}

const IDLE_DETAIL = 'idle · 待命（任务：在百度搜索「AI 工作台」并进入结果页）';

/** 每个 target 一份任务状态 —— **这就是被替换掉的那组全局单例** */
const tasks = new Map<number, TargetTask>();

let seqCounter = 0;
/** 最近一次被任务碰过的 target（「暂停 → 继续」在调用方没点名时靠它回到同一张页） */
let lastTouchedWcId: number | null = null;

/** 取（必要时新建）某个 target 的任务状态 */
function taskOf(wcId: number): TargetTask {
  let t = tasks.get(wcId);
  if (!t) {
    t = { phase: 'idle', detail: IDLE_DETAIL, step: 0, paused: false, loopToken: 0, seq: 0, pausedBy: null };
    tasks.set(wcId, t);
  }
  return t;
}

/** 只读地取 phase（**不建条目**：drive 一次不该就多出一条记录） */
function phaseOf(wcId: number): TaskPhase {
  return tasks.get(wcId)?.phase ?? 'idle';
}

/** 只读地取这张页的暂停门（同上，不建条目） */
function pausedOf(wcId: number): boolean {
  return tasks.get(wcId)?.paused ?? false;
}

/** 某个 target 的状态快照 */
function snapshotOf(wcId: number): TaskState {
  const t = tasks.get(wcId);
  return {
    phase: t?.phase ?? 'idle',
    detail: t?.detail ?? IDLE_DETAIL,
    step: t?.step ?? 0,
    blocked: t?.paused ?? false,
    wcId,
    // 第 27 步：只在**暂停态**才回"谁发起的" —— 别的相位带这个字段只会误导界面
    pausedBy: (t?.phase ?? 'idle') === 'paused' ? t?.pausedBy ?? null : null,
  };
}

/** 「此刻在跑的那张页」；没有在跑的，就取最近一次被任务碰过的那张 */
function activeTaskWcId(): number | null {
  for (const [wcId, t] of tasks) if (t.phase === 'running') return wcId;
  return lastTouchedWcId;
}

/**
 * **没有点名 target 时的聚合视图**（左栏横幅用）。
 *
 * 它**不是**「全局单例状态」，而是从 per-target 状态**推导**出来的：
 *   有 running → running；否则有 paused → paused；否则回放最近一次终止态；都没有 → idle。
 * 一期并发是 1，所以它和「那一张页的状态」基本是同一个东西；
 * 以后并发调大了，它就是一句「N 路在跑」的汇总。
 */
function aggregateState(): TaskState {
  let running: number | null = null;
  let runningSeq = -1;
  let pausedWc: number | null = null;
  let pausedSeq = -1;
  let settledWc: number | null = null;
  let settledSeq = -1;
  for (const [wcId, t] of tasks) {
    /**
     * ⚠️ 取**最近被更新**的那一条（seq 最大），不是 Map 里的第一条。
     *
     * 按插入顺序取会踩这个坑：某张页上有一份**陈旧**的 running（例如用户「停」了、
     * 但那一轮的收尾还没来得及改状态），后来另一张页真的开始跑 ——
     * 聚合视图会一直显示那张旧页的状态，看起来像「新任务根本没起来」。
     */
    if (t.phase === 'running' && t.seq > runningSeq) {
      runningSeq = t.seq;
      running = wcId;
    } else if (t.phase === 'paused' && t.seq > pausedSeq) {
      pausedSeq = t.seq;
      pausedWc = wcId;
    }
    if ((t.phase === 'done' || t.phase === 'failed') && t.seq > settledSeq) {
      settledSeq = t.seq;
      settledWc = wcId;
    }
  }
  if (running !== null) return snapshotOf(running);
  if (pausedWc !== null) return snapshotOf(pausedWc);
  if (settledWc !== null) return snapshotOf(settledWc);
  return { phase: 'idle', detail: IDLE_DETAIL, step: 0, blocked: false };
}

/** 主进程注册的状态监听（main.ts 用于向渲染层广播） */
let stateListener: ((s: TaskState) => void) | null = null;

export function setTaskListener(fn: ((s: TaskState) => void) | null): void {
  stateListener = fn;
}

/**
 * 广播**聚合视图**给渲染层。
 *
 * 为什么广播聚合而不是「刚刚变的那一路」：左栏横幅只有一个，
 * 渲染层拿到聚合就能直接显示，不必自己再合并多路状态（少一次 IPC 往返）。
 * 每一路自己的话由 `emitAgent`（带 wcId）走聊天区，两条路互不干扰。
 */
function broadcast(): void {
  stateListener?.(aggregateState());
}

/**
 * 读状态。
 * @param targetWebContentsId 传了就是**那张页**的状态；不传是聚合视图（左栏横幅用）。
 */
export function getTaskState(targetWebContentsId?: number): TaskState {
  if (typeof targetWebContentsId === 'number') return snapshotOf(targetWebContentsId);
  return aggregateState();
}

/**
 * 改一张页的相位。
 *
 * 第 27 步：`by` 是**这次暂停是谁发起的**。传了才写（未传时保留原值），
 * 并且**离开暂停态时自动清空** —— 否则一次 AI 求助之后，用户后来自己按的暂停
 * 会沿用上一个 `'agent'`，界面就一直错报"AI 在等你"。这条是"谁发起的"能站住的关键。
 */
function setPhase(
  wcId: number,
  next: TaskPhase,
  detail: string,
  step?: number,
  by?: 'user' | 'agent',
): void {
  const t = taskOf(wcId);
  t.phase = next;
  t.detail = detail;
  if (typeof step === 'number') t.step = step;
  if (by) t.pausedBy = by;
  if (next !== 'paused') t.pausedBy = null;
  t.seq = ++seqCounter;
  lastTouchedWcId = wcId;
  broadcast();
}

/** 任务步骤中途被用户接管时抛出：它不算失败，只是本步作废 */
class TaskAborted extends Error {
  constructor() {
    super('任务步骤被中止（用户已接管）');
    this.name = 'TaskAborted';
  }
}

const trunc = (s: string, n = 28): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * 统一的暂停 / 恢复入口（**按 target**）：
 * - 暂停 = 置起这张页的 paused 标志（挡住自动 click/type）+ 它的任务循环立即停；
 * - 恢复 = 解除标志；若这张页处于 paused，则重启循环（循环第一步就是 read_page，
 *   天然满足"先读用户当前真实页面再决定下一步"）。
 */
function applyPaused(wcId: number, value: boolean, by: 'user' | 'agent' = 'user'): void {
  const t = taskOf(wcId);
  t.paused = value;
  if (value) {
    t.loopToken += 1; // 让在途循环在下一个检查点退出
    if (t.phase === 'running') {
      setPhase(wcId, 'paused', '已暂停 — 自动 click/type 已停止，内嵌页可手点（点「继续」先读你停留的页面）', undefined, by);
    } else {
      setPhase(wcId, t.phase, '已暂停 — 自动 click/type 被拒绝（当前不在任务运行中，无其它副作用）', undefined, by);
    }
  } else if (t.phase === 'paused') {
    /**
     * 阶段简报 · 方案 B：**这里不再自己启动循环**。
     *
     * 以前它会去 `beginRun()` —— 那是第 4 步那套**基于规则的 demo 循环**（`planNext`），
     * 第 21 步之后脑已经搬到服务端，这条路径起的是一个根本不存在的旧循环：
     * 状态会显示成 running，但没有任何一步真的被问出来，用户看到的就是「点了继续、没反应」。
     *
     * 现在恢复只做两件事：解除这张页的暂停门 + 如实记成「等你继续」；
     * 真正「先读页 → 再接着跑」由 main.ts 的 `resumeAgentLane()`
     * 统一走服务端循环（它保证第一步就是 read_page 重新感知）。
     */
    setPhase(wcId, 'paused', '已解除暂停门 — 正在读取你当前的真实页面，然后接着做');
  } else {
    setPhase(wcId, t.phase, '自动 click/type 已解除限制');
  }
}

/**
 * 第 22 步：暂停门**按 target**。
 *
 * 不点名时取「此刻在跑的那张页」，没有就取最近一次被任务碰过的那张 ——
 * 这是**从状态表里精确推出来的**，不是「从所有 webContents 里挑一个」那种盲选，
 * 所以不违反 fail-fast；真的一个目标都没有就什么都不做（返回 false），绝不乱按一张页。
 */
export function setDrivingPaused(
  value: boolean,
  targetWebContentsId?: number,
  by: 'user' | 'agent' = 'user',
): boolean {
  const wcId = typeof targetWebContentsId === 'number' ? targetWebContentsId : activeTaskWcId();
  if (wcId === null) return false;
  applyPaused(wcId, value, by);
  return pausedOf(wcId);
}

/** 这张页（不点名 = 此刻在跑 / 最近碰过的那张）的自动 click/type 是不是被按住了 */
export function isDrivingPaused(targetWebContentsId?: number): boolean {
  const wcId = typeof targetWebContentsId === 'number' ? targetWebContentsId : activeTaskWcId();
  return wcId === null ? false : pausedOf(wcId);
}

/**
 * 启动任务：只从 idle / done / failed 进入 running；running / paused 中调用不重复启动。
 *
 * 第 22 步：目标必须点名，或者至少有「上一次那张」。**不猜**：
 * 一个目标都没有时当场返回 failed 并说明原因。
 */
export function startTask(targetWebContentsId?: number): TaskState {
  const wcId = typeof targetWebContentsId === 'number' ? targetWebContentsId : lastTouchedWcId;
  if (wcId === null) return failNoTarget();
  const t = taskOf(wcId);
  if (t.phase === 'running') {
    setPhase(wcId, 'running', '任务已在运行中，无需重复启动');
    return snapshotOf(wcId);
  }
  if (t.phase === 'paused') {
    setPhase(wcId, 'paused', '当前是暂停态 — 请点「继续」（会先读你当前的真实页面，再决定下一步）');
    return snapshotOf(wcId);
  }
  t.paused = false;
  return beginRun(wcId, '启动任务 — 先 read_page 读当前真实页面，再决定下一步');
}

export function pauseTask(targetWebContentsId?: number): TaskState {
  const wcId = typeof targetWebContentsId === 'number' ? targetWebContentsId : activeTaskWcId();
  if (wcId === null) return getTaskState();
  applyPaused(wcId, true);
  return snapshotOf(wcId);
}

export function resumeTask(targetWebContentsId?: number): TaskState {
  const wcId = typeof targetWebContentsId === 'number' ? targetWebContentsId : activeTaskWcId();
  if (wcId === null) return getTaskState();
  const t = taskOf(wcId);
  if (t.phase === 'paused') {
    applyPaused(wcId, false); // 解除 paused 门（真正的「先读页再继续」在 main.ts 的 resumeAgentLane）
  } else {
    // 非 paused 态点「继续」：不做其它事，但必须解除 paused 门
    // （idle 下按过「暂停」的用户，再按「继续」应恢复单发 click/type 放行）
    t.paused = false;
    setPhase(
      wcId,
      t.phase,
      `当前不是暂停态（${t.phase}），无需「继续」；已解除 click/type 限制，要开始任务请点「开始任务」`,
    );
  }
  return snapshotOf(wcId);
}

/** 一个目标都没有时的统一失败话术（第 22 步：宁可说清楚，也不瞎挑一张页） */
function failNoTarget(): TaskState {
  return {
    phase: 'failed',
    detail: '任务失败 — 没有指定要驾驶的页（webContentsId）。请先在聊天里打开一个网页，再从那张页发起任务。',
    step: 0,
    blocked: false,
  };
}

/**
 * 第 7 步：主进程外部编排循环（agent.ts 的云端驾驶员）接管**这一张页**的状态机。
 * 效果 = 这张页的 loopToken 自增（把内置 demo runLoop / 上一个外部循环踢下线）
 *        + 解除这张页的驾驶暂停 + 置 running。
 * **不会**启动 demo 的 runLoop —— AI 循环自己按「读页→问一步→执行一步」走。
 */
export function takeoverRun(targetWebContentsId: number, detail: string): TaskState {
  const t = taskOf(targetWebContentsId);
  t.loopToken += 1;
  t.paused = false;
  setPhase(targetWebContentsId, 'running', detail, 0);
  return snapshotOf(targetWebContentsId);
}

/**
 * 第 7 步：外部循环汇报**这一张页**的状态
 * （running 步摘要 / ask_user→paused / done / failed），只动状态机不动执行。
 */
export function setExternalPhase(
  targetWebContentsId: number,
  next: TaskPhase,
  detail: string,
  step?: number,
  by?: 'user' | 'agent',
): void {
  setPhase(targetWebContentsId, next, detail, step, by);
}

/**
 * 复位。
 * @param targetWebContentsId 传了就只复位**那张页**；不传则清空所有页的状态
 *        （登出 / 全部停止时用，语义与以前一致）。
 */
export function resetTask(targetWebContentsId?: number): TaskState {
  if (typeof targetWebContentsId === 'number') {
    const t = taskOf(targetWebContentsId);
    t.loopToken += 1;
    t.paused = false;
    setPhase(targetWebContentsId, 'idle', '已复位到 idle（done / failed 之后回到这里，再点「开始任务」）', 0);
    return snapshotOf(targetWebContentsId);
  }
  for (const t of tasks.values()) {
    t.loopToken += 1;
    t.paused = false;
  }
  tasks.clear();
  lastTouchedWcId = null;
  const idle: TaskState = {
    phase: 'idle',
    detail: '已复位到 idle（done / failed 之后回到这里，再点「开始任务」）',
    step: 0,
    blocked: false,
  };
  stateListener?.(idle);
  return idle;
}

/**
 * 进入 running 并在后台跑循环；同步返回初始状态（循环结果由 'state' 广播）。
 *
 * 第 22 步：先**验证目标真的在**（resolveTarget 会 fail-fast）——
 * 以前这里是「没给 id 就盲选第一个 webview」，现在宁可当场失败也不猜。
 */
function beginRun(wcId: number, detail: string): TaskState {
  try {
    resolveTarget(wcId);
  } catch (err) {
    setPhase(wcId, 'failed', `任务失败 — ${(err as Error).message}`, 0);
    return snapshotOf(wcId);
  }
  const t = taskOf(wcId);
  const token = ++t.loopToken;
  setPhase(wcId, 'running', detail, 0);
  void runLoop(token, wcId);
  return snapshotOf(wcId);
}

/** 第 4 步 demo 任务的规则常量（与第 3 步调试区一致，不接 AI、选择器写成逗号列表降级） */
const TASK_QUERY = 'AI 工作台';
const TASK_URL = 'https://www.baidu.com';
const TASK_INPUT = '#kw, textarea#chat-textarea';
const TASK_SUBMIT = '#su, button#chat-submit-button';

const MAX_TASK_STEPS = 10;

type Decision =
  | { kind: 'go'; action: BrowserAction; note: string }
  | { kind: 'goal'; reason: string }
  | { kind: 'stuck'; reason: string };

/**
 * 规则式"决定下一步"（明确不是 AI）：只依据 read_page 快照判断还差哪一步。
 * 因为决策完全基于**当前真实页面**，所以天然不会重放暂停前的步骤——
 * 用户手点改了什么，恢复后看到的就是什么。
 */
export function planNext(s: PageSnapshot): Decision {
  const url = (s.url || '').toLowerCase();
  if (!url.startsWith('http')) {
    return { kind: 'stuck', reason: `内嵌页当前不是 http(s) 页面（${url || '空白页'}），请先「打开工作台浏览器」` };
  }
  if (/baidu\.com\/s([?#]|$)/.test(url) || /_百度搜索\s*$/.test(s.title || '')) {
    return { kind: 'goal', reason: `已进入搜索结果页「${trunc(s.title)}」` };
  }
  if (!/baidu\.com/.test(url)) {
    return { kind: 'go', action: { action: 'open_url', url: TASK_URL }, note: `打开 ${TASK_URL}` };
  }
  const typed = (s.inputs || []).some((i) => i.includes(`value=${TASK_QUERY}`));
  if (!typed) {
    return { kind: 'go', action: { action: 'type', target: TASK_INPUT, text: TASK_QUERY }, note: `在搜索框输入「${TASK_QUERY}」` };
  }
  return { kind: 'go', action: { action: 'click', target: TASK_SUBMIT }, note: '点击搜索按钮提交' };
}

/** 执行任务的一步：复用第 3 步的执行原语，但把失败抛出来（由循环转成 failed） */
async function runStep(action: BrowserAction, shouldAbort: () => boolean, wcId: number): Promise<void> {
  const wc = resolveTarget(wcId);
  if (!shouldAbort()) throw new TaskAborted();
  switch (action.action) {
    case 'open_url':
      await navigate(wc, action.url);
      return;
    case 'click': {
      const hit = await clickTarget(wc, action.target, shouldAbort);
      if (!hit) throw new Error(`点击失败：没找到元素「${action.target}」`);
      return;
    }
    case 'type': {
      const r = await typeInto(wc, action.target, action.text, Boolean(action.submit), shouldAbort);
      if (!r.ok) throw new Error(r.reason);
      return;
    }
    case 'scroll':
      await scrollPage(wc, action.direction);
      return;
    case 'read_page':
      // 快照已在外层读过，这一步只作为显式"读页"步存在（本任务里由循环内部完成）
      return;
    default:
      throw new Error(`任务不支持动作：${String((action as { action: string }).action)}`);
  }
}

async function runLoop(token: number, wcId: number): Promise<void> {
  // 第 22 步：令牌与 phase 都从**这张页自己**那份状态里读（以前是模块级全局变量）
  const alive = (): boolean => (tasks.get(wcId)?.loopToken ?? -1) === token && phaseOf(wcId) === 'running';
  try {
    for (let step = 1; step <= MAX_TASK_STEPS; step += 1) {
      if (!alive()) return;
      // 每一步都重新解析**点名的那张页**：中途被关掉会当场抛错转成 failed，
      // 而不是（像以前那样）悄悄换一张别的页继续点。
      const wc = resolveTarget(wcId);
      // 每一步都先读用户当前真实页面（恢复后的第一次决策同样走这里）
      const snap = await readSnapshot(wc);
      if (!alive()) return;
      setPhase(wcId, 'running', `步 ${step}：读页「${trunc(snap.title || snap.url)}」`, step);
      const d = planNext(snap);
      if (d.kind === 'goal') {
        setPhase(wcId, 'done', `任务完成 — ${d.reason}`, step);
        return;
      }
      if (d.kind === 'stuck') {
        setPhase(wcId, 'failed', `任务失败 — ${d.reason}`, step);
        return;
      }
      setPhase(wcId, 'running', `步 ${step}：${d.note}`, step);
      // 步内每个会动鼠标键盘的原语都会复查 alive；步后也复查，暂停后绝不进入下一步
      await runStep(d.action, alive, wcId);
      if (!alive()) return;
    }
    setPhase(wcId, 'failed', `任务失败 — 超过步数上限（第 ${MAX_TASK_STEPS} 步仍在进行），已停止`, MAX_TASK_STEPS);
  } catch (err) {
    if (err instanceof TaskAborted) return; // 用户接管的正常中止，保持 paused 显示
    setPhase(wcId, 'failed', `任务失败 — ${(err as Error).message}`, tasks.get(wcId)?.step ?? 0);
  }
}

// ---------------------------------------------------------------------------
// 找到要驾驶的那块内嵌页
// ---------------------------------------------------------------------------

/**
 * 解析驾驶目标。**必须点名**——这里没有「自己找一张」这条路了。
 *
 * 第 22 步（原计划 Phase 2）删掉了 `findWebviewGuest()` 盲选兜底，理由是它**不可预期**：
 *   - 多张活页可以各跑一路，不传 id 就挑「第一个 webview」，
 *     等于把动作打到别人那张页上（一路在抖音搜索、另一路却在 B 站页面上点）；
 *   - 「第一个」取决于 `getAllWebContents()` 的返回顺序，**出问题时极难复现**。
 * 所以两种错法都当场抛错（fail-fast），**绝不猜**：
 *   - 给了 id 但那张页已经关了 / 不是内嵌页 → 报错；
 *   - 根本没给 id → 也报错（调用方必须显式传 target）。
 *
 * ⚠️ 这是**预期行为，不是回归**：历史上任何漏传 id 的调用点，都应该在这里当场暴露出来。
 */
function resolveTarget(id?: number): Target {
  if (typeof id !== 'number') {
    throw new Error(
      '驾驶目标未指定：必须显式给出内嵌页的 webContentsId（多张页并存时不允许再自动挑一张）。',
    );
  }
  const wc = webContents.fromId(id);
  // ADR-0002 第二片：内嵌页宿主只有一条路 —— 主进程托管的 WebContentsView，
  // wcId 在 viewHostRegistry 里（create 时登记、close/destroyed 时注销）。
  // webview 时期认 `type === 'webview'` 的分支随 webviewTag 一起退场（那种 guest 已不可能存在）；
  // 报错口径不变（点名了但页没了 → 当场停，绝不猜）。
  if (wc && !wc.isDestroyed() && viewHostRegistry.has(wc.id)) return wc;
  throw new Error(`指定的内嵌页已经不在了（webContents ${id} 已关闭或不是内嵌页），这一路停止。`);
}

// ---------------------------------------------------------------------------
// CDP 基础能力
// ---------------------------------------------------------------------------

/**
 * 第 21 步 · CDP 命令统一超时（**这是防死锁的硬闸，别去掉**）。
 *
 * Electron 的 `debugger.sendCommand()` **没有自带超时**：命令发出去了，回包不来就永远挂着。
 * 实测（本机 9333 验收实例）：对内嵌页发 `Input.dispatchMouseEvent(type=mouseWheel)` 时，
 * 命令**永不回包**（`scrollY` 读得出来 = 0，但滚轮那条命令一直不返回）；
 * 一旦挂在里面，整条驾驶循环当场死锁 —— liveLoops 一直是 1、llmCalls 不再增长、
 * 聊天停在「我往下滚一屏看看」，用户点什么都没用（只有重启窗口才恢复）。
 * `Page.captureScreenshot` 在页面正忙时也会这样。
 *
 * 所以：attach 之后给这个 debugger 打**一次**补丁，让每个 CDP 命令都有上限；
 * 超时按「这一步失败了」抛出去，由驾驶循环转成「原因 + 一个下一步」，而不是把整条循环挂死。
 * 打补丁而不是逐个改 15 处调用点 —— 以后新加的动作也自动受这道闸保护。
 */
const CDP_TIMEOUT_MS = 8000;
const cdpPatched = new WeakSet<Electron.Debugger>();

function ensureAttached(wc: Target): Electron.Debugger {
  const dbg = wc.debugger;
  if (!dbg.isAttached()) dbg.attach('1.3');
  if (!cdpPatched.has(dbg)) {
    cdpPatched.add(dbg);
    const raw = dbg.sendCommand.bind(dbg);
    dbg.sendCommand = ((method: string, commandParams?: unknown, sessionId?: string) =>
      Promise.race([
        raw(method, commandParams as never, sessionId),
        new Promise((_resolve, reject) => {
          setTimeout(
            () => reject(new Error(`页面 ${CDP_TIMEOUT_MS / 1000} 秒没有响应这条指令（${method}）`)),
            CDP_TIMEOUT_MS,
          );
        }),
      ])) as typeof dbg.sendCommand;
  }
  return dbg;
}

interface CdpEvalResponse {
  result?: { value?: unknown; description?: string };
  exceptionDetails?: {
    text?: string;
    exception?: { description?: string };
  };
}

/** 在页面里执行一段脚本，拿回可序列化的值 */
async function evaluate<T>(wc: Target, expression: string): Promise<T> {
  const dbg = ensureAttached(wc);
  const res = (await dbg.sendCommand('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    // 让页面里的 click()/submit() 被当成用户手势，绕过部分站点的手势限制
    userGesture: true,
  })) as CdpEvalResponse;

  if (res.exceptionDetails) {
    throw new Error(
      res.exceptionDetails.exception?.description ??
        res.exceptionDetails.text ??
        '页面脚本执行异常',
    );
  }
  return res.result?.value as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// ADR-0003 · 浏览器深度 第一片:wait-for / watch 原语(公开包装)
//
// 纯逻辑在 `./wait-watch`(coreWaitFor / coreWatch,零 electron 依赖,验收直接驱动那份 core)。
// 这里只负责把「点名哪张页 + 真实 debugger」接上 —— 与 `drive()` 同一套目标解析与 fail-fast。
// ---------------------------------------------------------------------------

/**
 * wait-for:等**点名这张页**上某元素/文本出现(带超时,到点如实回 found=false)。
 * 是复杂页驾驶的「等到再动」地基(GrokBot 电脑「可教」)。
 *
 * 目标解析同 `drive`:`resolveTarget` 在「没点名 / 页没了」都当场抛(F12 fail-fast)。
 */
export async function browserWaitFor(wcId: number, spec: WaitForSpec): Promise<WaitForResult> {
  const wc = resolveTarget(wcId);
  const dbg = ensureAttached(wc);
  return coreWaitFor(dbg.sendCommand as unknown as CdpSend, spec);
}

/**
 * watch:监听**点名这张页**的 DOM 变化,新内容出现即回调(push,真实时)。
 * 是客服台类实时页的「新内容即回调」地基(GrokBot 电脑「可监听」)。
 *
 * 返回 `handle.stop()` 摘除。同一张页同一时刻只该有一个监听 —— 重复 start 由 core 的
 * removeBinding + 页内 disconnect 保证 re-arm(不双发);主进程侧的「关页即停」在 main.ts。
 */
export function browserWatch(
  wcId: number,
  onEvent: (e: WatchEvent) => void,
  spec?: WatchSpec,
): WatchHandle {
  const wc = resolveTarget(wcId);
  const dbg = ensureAttached(wc);
  return coreWatch(dbg.sendCommand as unknown as CdpSend, dbg as unknown as CdpEvents, onEvent, spec);
}

// ---------------------------------------------------------------------------
// 注入到页面里的辅助脚本
//
// 作用：把「按 target 找元素」和「读页面快照」这两件事统一在页面侧实现。
// 幂等（带版本号），每次动作前注入一次即可。
// ---------------------------------------------------------------------------

const PAGE_HELPERS = `(() => {
  if (window.__wbHelper && window.__wbHelper.__v === 12) return;
  /**
   * ★ 第 23 步：**穿透遍历**（这一版最重要的改动）。
   *
   * 老实现把「页面」等同于「主文档」——所有查找都是 document.querySelectorAll。
   * 实测（scripts/verify/rootcause-browser-probe.mjs，用的是**这一份** helper）：
   *   - iframe 里的播放按钮 → find() 返回 notfound
   *   - Shadow DOM 里的按钮   → find() 返回 notfound
   *   而同一时刻 contentDocument / shadowRoot 都是可读的、元素也点得动。
   *   → 用户看到的「点了没反应」= 没找到元素，不是点不下去。
   *
   * 真浏览器的「页面」是 主文档 + 所有 open shadow root + 所有同源 frame。
   * 这里就按这个语义做递归遍历，产出的候选元素带**绝对坐标**（累加各级 frame 偏移），
   * 这样上层发 CDP 鼠标事件时坐标直接可用。
   *
   * 安全护栏（都是实测踩出来的）：
   *   - 跨源 frame 读 contentDocument 会抛 → 静默跳过（跨源是另一条路，见注释）
   *   - 深度站点能产出几十万节点 → 访问上限硬截断，绝不让它把页面卡死
   */
  const MAX_NODES = 20000;
  const MAX_DEPTH = 6;
  /** 遍历产出的元素是否在视口内、可见 —— 跨 frame 时要用**该帧自己的** window 计算 */
  const ownerWindow = (el) => {
    try {
      const d = el.ownerDocument;
      return d && d.defaultView ? d.defaultView : window;
    } catch (_) { return window; }
  };
  /** 元素在**最顶层文档**坐标系里的矩形（累加各级 frame 的偏移） */
  const absRect = (el) => {
    let r;
    try { r = el.getBoundingClientRect(); } catch (_) { return null; }
    let x = r.left, y = r.top;
    try {
      let w = ownerWindow(el);
      while (w && w !== window) {
        const fe = w.frameElement;
        if (!fe) break;
        const fr = fe.getBoundingClientRect();
        x += fr.left; y += fr.top;
        w = ownerWindow(fe);
      }
    } catch (_) { /* 跨源会抛：保留已累加的部分，上层会退化处理 */ }
    return { left: x, top: y, width: r.width, height: r.height,
             right: x + r.width, bottom: y + r.height };
  };
  const visible = (el) => {
    if (!el) return false;
    const r = absRect(el);
    if (!r || r.width <= 0 || r.height <= 0) return false;
    let s;
    try { s = ownerWindow(el).getComputedStyle(el); } catch (_) { return false; }
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
  };
  /**
   * 递归遍历：主文档 → open shadow root → 同源 iframe。
   * 产出的是扁平的元素数组（不要用 generator —— 这段代码跑在页面里，
   * 且外层是模板字符串，function* 的写法容易和转义打架）。
   */
  const walkAll = (root, depth, budget) => {
    const out = [];
    if (!root || depth > MAX_DEPTH) return out;
    let all;
    try { all = root.querySelectorAll('*'); } catch (_) { return out; }
    for (let i = 0; i < all.length; i += 1) {
      if (budget.n >= MAX_NODES) return out;
      budget.n += 1;
      const el = all[i];
      out.push(el);
      // open shadow root（closed 的访问不到，按设计跳过）
      try {
        if (el.shadowRoot) {
          const inner = walkAll(el.shadowRoot, depth + 1, budget);
          for (let k = 0; k < inner.length; k += 1) out.push(inner[k]);
        }
      } catch (_) {}
      // 同源 iframe；跨源会抛 → 跳过
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        try {
          const d = el.contentDocument;
          if (d) {
            const inner = walkAll(d, depth + 1, budget);
            for (let k = 0; k < inner.length; k += 1) out.push(inner[k]);
          }
        } catch (_) {}
      }
    }
    return out;
  };
  /** 全页面（含穿透）的元素集合 */
  const allDeep = () => walkAll(document, 0, { n: 0 });
  /** 全页面里匹配选择器的可见元素（等价于老的 querySelectorAll + filter(visible)） */
  const queryDeep = (selector) => {
    const nodes = allDeep();
    const out = [];
    for (let i = 0; i < nodes.length; i += 1) {
      const el = nodes[i];
      try { if (el.matches && el.matches(selector) && visible(el)) out.push(el); } catch (_) {}
    }
    return out;
  };
  const text = (el) => {
    if (!el) return '';
    let raw = el.innerText || el.textContent || '';
    // <input type="submit"> 之类的按钮，文字在 value 上
    if (!raw && (el.tagName === 'INPUT' || el.tagName === 'BUTTON')) raw = el.value || '';
    raw = raw || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
    return String(raw).replace(/\\s+/g, ' ').trim();
  };
  const SELECTABLE = 'button, a, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [contenteditable="true"]';
  const find = (target) => {
    if (!target) return null;
    const t = String(target).trim();
    // 1) 当成 CSS 选择器试。注意要遍历**所有**匹配、取第一个可见的：
    //    真实站点常有「元素在 DOM 里但被 display:none 的祖先藏起来」的情况
    //    （百度首页就是：隐藏的经典搜索框 #kw / #su 排在新版 AI 搜索框前面），
    //    只取 querySelector 的第一个匹配会误判成「找不到元素」。
    //    选择器写成逗号列表即可天然降级，例如 '#kw, textarea#chat-textarea'。
    //    ★ 第 23 步：走 queryDeep（穿透 shadow root 与同源 iframe）。
    try {
      const all = queryDeep(t);
      if (all.length > 0) return all[0];
    } catch (_) { /* 不是合法选择器，继续走文本匹配 */ }
    const low = t.toLowerCase();
    const cands = queryDeep(SELECTABLE);
    // 2) placeholder / aria-label / name / id / title 精确命中
    let hit = cands.find((el) => [el.getAttribute('placeholder'), el.getAttribute('aria-label'),
      el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('title')]
      .some((v) => v && v.trim().toLowerCase() === low));
    if (hit) return hit;
    // 3) 可见文字精确命中
    hit = cands.find((el) => text(el).toLowerCase() === low);
    if (hit) return hit;
    // 4) 可见文字包含
    hit = cands.find((el) => text(el).toLowerCase().indexOf(low) >= 0);
    if (hit) return hit;
    // 5) 兜底：任意可见叶子节点文字包含
    hit = Array.prototype.find.call(queryDeep('*'),
      (el) => visible(el) && el.children.length === 0 && text(el).toLowerCase().indexOf(low) >= 0);
    return hit || null;
  };
  /**
   * 找「能打字的框」。与 find 的关键差别：**文字对不上时不再返回 null**，
   * 而是退回到页面上真实的 input / textarea（含被挤到视口外、用户看不见的那个）。
   *
   * 为什么必须有这个兜底：右栏本来就窄，调试区又把网页压矮，搜索框常常整条在视口外；
   * 而模型爱给「百度搜索输入框」这种描述性 target，对不上任何 placeholder / 可见文字——
   * 老实现到这一步就放弃、报「找不到输入框」，循环连败两次就转 ask_user。
   * 这里按「搜索语义 > 在视口内 > 面积大」挑一个，之后统一 scrollIntoView 再输入。
   */
  /**
   * 第 17 步：视口尺寸。**换页途中 document.documentElement 会是 null**
   * （上一页已拆、下一页还没建），直接读 .clientWidth 会把整条动作链炸成
   * 「读不到内嵌页：TypeError … at overlayish」——那是白烧一步。
   * 这里统一走这个口子，拿不到就回 0（调用方本来就按 0 处理成「不可用」）。
   */
  const viewport = () => {
    const de = document.documentElement;
    return de ? { w: de.clientWidth, h: de.clientHeight } : { w: 0, h: 0 };
  };
  const findInput = (target) => {
    const hit = find(target);
    if (hit) {
      const t = hit.tagName;
      if (t === 'INPUT' || t === 'TEXTAREA' || hit.isContentEditable) return hit;
    }
    const sel = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="image"]), textarea, [contenteditable="true"]';
    // 第 23 步：穿透版可见性/尺寸判定（跨 frame 要用对方 window 算）
    const usable = (el) => {
      if (el.disabled || el.readOnly) return false;
      const r = absRect(el);
      if (!r || r.width <= 0 || r.height <= 0) return false;   // 注意：只要求"有尺寸"，不要求在视口内
      let s;
      try { s = ownerWindow(el).getComputedStyle(el); } catch (_) { return false; }
      return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
    };
    const cands = [];
    {
      const nodes = allDeep();
      for (let i = 0; i < nodes.length; i += 1) {
        const el = nodes[i];
        try { if (el.matches && el.matches(sel) && usable(el)) cands.push(el); } catch (_) {}
      }
    }
    if (!cands.length) return null;
    const { w: vw, h: vh } = viewport();
    const inView = (el) => {
      const r = absRect(el);
      return !!r && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    };
    const searchish = (el) => /(search|query|wd|word|kw|q|搜)/i.test(
      [el.getAttribute('name'), el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.className]
        .filter(Boolean).join(' '));
    const area = (el) => { const r = absRect(el); return r ? r.width * r.height : 0; };
    const score = (el) => (searchish(el) ? 2 : 0) + (inView(el) ? 1 : 0);
    cands.sort((a, b) => score(b) - score(a) || area(b) - area(a));
    return cands[0];
  };
  /**
   * click 专用：文字对不上时，只有 target 明显在说「输入框」才退回真实输入框
   * （避免把「百度一下」这种按钮误当成输入框去点）。
   */
  const findClickable = (target) => {
    const hit = find(target);
    if (hit) return hit;
    return /框|输入|input|textarea|搜索栏/i.test(String(target)) ? findInput(target) : null;
  };
  /**
   * 同一轮 type 的四个脚本（找框 / 读回 / 三种写入）必须盯住**同一个**元素：
   * findInput 是按打分挑的，写完一次 DOM 变了就可能挑到别的框，读回校验会误判成"没写进去"。
   * 所以按 target 字符串缓存命中的元素；元素被移除（换页）就自动重新挑。
   */
  let pickKey = null;
  const pick = (target) => {
    const key = String(target);
    const stashed = window.__wbTypeTarget;
    if (pickKey === key && stashed && stashed.isConnected) return stashed;
    const el = findInput(target);
    pickKey = key;
    window.__wbTypeTarget = el || null;
    return el;
  };
  // ---- 第 9 步：字段事实采集 + 页面侧粗敏感判定 ----
  // 权威分类在 Node 侧 fieldClass.ts；页面里这份 sensitiveish 只干一件事：
  // **疑似敏感就连 el.value 都不碰**，绝不让密码/验证码明文进快照、进模型、进日志。
  const INPUT_SEL = 'input:not([type="hidden"]), textarea, [contenteditable="true"]';
  const SENSITIVEISH_RE = /(验证码|校验码|动态口令|短信码|密码|身份证|银行卡|信用卡|cvv|otp|captcha|verification|password|passcode|security\s*code|payment|pay\s*now|checkout|card\s*number)/i;
  const fieldOf = (el) => {
    const lbl = (() => {
      try {
        if (el.labels && el.labels.length) return String(el.labels[0].innerText || '').trim().slice(0, 60);
        const forId = el.id && document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]');
        if (forId) return String(forId.innerText || '').trim().slice(0, 60);
      } catch (_) {}
      return '';
    })();
    return {
      tag: el.tagName,
      type: (el.getAttribute('type') || (el.tagName === 'TEXTAREA' ? 'textarea' : (el.isContentEditable ? 'text' : ''))) || '',
      name: el.getAttribute('name') || '',
      id: el.id || '',
      ph: el.getAttribute('placeholder') || '',
      aria: el.getAttribute('aria-label') || '',
      lbl,
      maxlength: el.maxLength && el.maxLength > 0 && el.maxLength < 524288 ? el.maxLength : null,
      inputmode: el.getAttribute('inputmode') || '',
      editable: true,
    };
  };
  const sensitiveish = (el) => {
    const f = fieldOf(el);
    return f.type === 'password' || SENSITIVEISH_RE.test([f.name, f.id, f.ph, f.aria, f.lbl].join(' '));
  };
  /**
   * 第 16 步：这一页像不像登录页。工具层要能给出「失败原因 + 一个下一步」，
   * 「需要先登录」是最常见的真实原因之一。只看 password 框与标题/地址里的登录字样，不猜。
   */
  const loginish = () => {
    try { if (queryDeep('input[type="password"]').length > 0) return true; } catch (_) {}
    // 第 23 步：主文档没命中时，也看看同源子框架的地址（登录表单常整个在 iframe 里）
    try {
      const frames = queryDeep('iframe');
      for (let i = 0; i < frames.length; i += 1) {
        try {
          const u = String(frames[i].contentDocument.location.href || '');
          if (/(登录|登陆|登入|sign\\s*in|log\\s*in|login|passport|sso)/i.test(u)) return true;
        } catch (_) {}
      }
    } catch (_) {}
    const t = ((document.title || '') + ' ' + location.href).toLowerCase();
    return /(登录|登陆|登入|sign\\s*in|log\\s*in|login|passport|sso)/i.test(t);
  };
  /**
   * 第 16 步：有没有疑似弹窗/遮罩压在大半屏上（点击失败的另一个常见原因）。
   * 只看类名/ID 像遮罩的元素，且必须是 fixed/absolute + z-index≥10 + 覆盖 >35% 视口——
   * 宁可漏报也不误报（误报会让模型乱猜）。
   */
  const overlayish = () => {
    const sel = '[class*=mask],[class*=overlay],[class*=modal],[class*=dialog],[class*=popup],[class*=layer],[id*=mask],[id*=overlay],[id*=modal],[id*=dialog]';
    let els;
    try { els = queryDeep(sel); } catch (_) { return false; }
    const { w: vw, h: vh } = viewport();
    if (!vw || !vh) return false;
    return els.some((el) => {
      if (!visible(el)) return false;
      let s;
      try { s = ownerWindow(el).getComputedStyle(el); } catch (_) { return false; }
      if (s.position !== 'fixed' && s.position !== 'absolute') return false;
      if ((Number(s.zIndex) || 0) < 10) return false;
      const r = absRect(el);
      return !!r && r.width * r.height > vw * vh * 0.35;
    });
  };
  /**
   * 第 27 步（人工介入卡片）：这个输入框是不是**验证码类**字段。
   *
   * 与 sensitiveish 的分工：sensitiveish 连 password 一起算（它服务的是"绝不代填"），
   * 这里只认**验证码语义**的框 —— 否则任何登录页都会因为有个 password 框被算成验证码页。
   * 词表与 fieldClass.ts 的 OTP_RE 保持一致（那是全工程唯一判定源）。
   */
  const otpish = (el) => {
    const f = fieldOf(el);
    return /(验证码|校验码|动态口令|短信码|一次性密码|verification|verif|otp|captcha|短信|动态码)/i
      .test([f.name, f.id, f.ph, f.aria, f.lbl].join(' '));
  };
  /**
   * 第 27 步：这一页像不像**验证码 / 滑块验证页**（页面级信号）。
   *
   * 为什么必须做成页面级：字段级的 otpish 只在「AI 正想去填某个框」时才起作用，
   * 而「AI 点了提交、页面才弹出滑块」这种场景下 AI 根本没碰过任何框 ——
   * 没有页面级信号，求助卡片就永远不知道该弹。
   *
   * ★ 判据刻意**保守**（宁可漏报也不误报）：误报会让"只是路过一个页面"也弹卡片打扰用户。
   *   必须**同时**满足：
   *     ① 验证语义：标题/地址，或页面上可见短文本，命中验证词；**且**
   *     ② 有落脚点：页面上真有一个验证码类输入框，或一颗"验证/滑动/获取验证码"类的按钮。
   *   只有 ① 没有 ② 的页面（例如一篇讲验证码的文章）一律不算。
   */
  const challengeish = () => {
    try {
      const TITLE_RE = /(验证码|校验码|人机验证|安全验证|安全校验|滑动验证|拖动滑块|滑块验证|captcha|recaptcha|hcaptcha|verify|challenge)/i;
      let semantic = TITLE_RE.test((document.title || '') + ' ' + location.href);
      if (!semantic) {
        try {
          const nodes = queryDeep('h1, h2, h3, h4, label, legend, p, span, div');
          const cap = Math.min(nodes.length, 400);
          for (let i = 0; i < cap && !semantic; i += 1) {
            const el = nodes[i];
            if (!visible(el)) continue;
            const t = text(el);
            if (t.length < 2 || t.length > 60) continue;
            if (TITLE_RE.test(t)) semantic = true;
          }
        } catch (_) {}
      }
      if (!semantic) return false;
      try {
        const inputs = queryDeep(INPUT_SEL);
        for (let i = 0; i < inputs.length; i += 1) if (otpish(inputs[i])) return true;
      } catch (_) {}
      try {
        const ACTION_RE = /(验证|校验|滑动|拖动|滑块|获取验证码|重新获取|发送验证码|重新发送)/i;
        const btns = queryDeep('button, input[type="submit"], input[type="button"], [role="button"]');
        for (let i = 0; i < btns.length; i += 1) {
          if (!visible(btns[i])) continue;
          if (ACTION_RE.test(text(btns[i]))) return true;
        }
      } catch (_) {}
      return false;
    } catch (_) {
      return false;
    }
  };
  /**
   * 第 17 步：判断「这次点击到底有没有让页面动一下」。
   * 只取三个便宜又稳定的量：地址、标题、节点总数。
   * 宁可漏报「没变化」（当成有变化），也不要误报——误报会把正常点击判成没点中。
   *
   * 第 23 步：节点总数改成**含穿透**的计数 —— 否则「点了一下，iframe 里的列表变了」
   * 会被判成「页面没变化」，白白触发 noChange 连击守卫。
   */
  const pageKey = () => location.href + '|' + document.title + '|' + allDeep().length;
  /**
   * 第 17 步：找元素身上（或最近的祖先）那个 <a>，看它要打开什么协议。
   * 抖音这类站点的「打开 App」按钮就是 bytedance:// / snssdk 之类的自定义协议，
   * 在网页里点不动（只能唤起手机 App）——要能明确告诉用户「这颗按钮网页里点不了」，
   * 而不是让他一直点、一直没反应。
   */
  const schemeOf = (el) => {
    try {
      const a = el && el.closest ? el.closest('a[href]') : null;
      const href = a ? String(a.getAttribute('href') || '') : '';
      const m = href.match(/^([a-z][a-z0-9+.-]*):/i);
      if (!m) return '';
      const scheme = m[1].toLowerCase();
      return (scheme === 'http' || scheme === 'https') ? '' : scheme;
    } catch (_) { return ''; }
  };
  /**
   * 第 21 步：可见正文片段。
   *
   * 快照原来只有按钮 / 链接 / 输入框 —— 纯正文的页面（搜索结果、文章、列表）
   * 在模型眼里几乎等于「空的」：「把这一页整理成列表」这类任务直接做不了
   * （实测：百度结果页反复读页只拿到顶部导航和热搜链接，抓不到结果标题）。
   * 这里补一段**短正文**（不是整页 HTML）：内容元素上的可见文字，去重 + 限长 + 限条数。
   */
  const contentTexts = () => {
    const out = [];
    const seen = Object.create(null);
    /**
     * 第 23 步两处修正：
     *   1. **加 a 标签** —— 实测（rootcause-browser-probe.mjs）只扫 h/p/li 时，
     *      纯链接列表页的 contentTexts() 返回空数组；视频列表标题恰恰全是 a。
     *   2. 走 queryDeep —— 正文在 iframe / shadow root 里也要拿得到。
     */
    const nodes = queryDeep('h1, h2, h3, h4, h5, p, li, td, th, dt, dd, blockquote, a, [role="heading"], [role="listitem"], [role="link"]');
    const cap = Math.min(nodes.length, 1500);
    for (let i = 0; i < cap && out.length < 60; i += 1) {
      const el = nodes[i];
      if (!visible(el)) continue;
      const t = text(el);
      if (t.length < 4 || t.length > 180) continue;
      if (seen[t]) continue;
      seen[t] = 1;
      out.push(t);
    }
    return out;
  };
  /**
   * 第 23 步：快照改为**穿透版**（queryDeep）。
   * 这是「AI 看不见 iframe / shadow root 里的东西」的正解 ——
   * 老实现只查主文档，视频站的播放器与列表在快照里完全不存在，
   * 模型只能反复 read_page / 换 target，10 步预算就烧完了。
   */
  const snapshot = () => ({
    url: location.href,
    title: document.title,
    loginLike: loginish(),
    challengeLike: challengeish(),
    overlay: overlayish(),
    buttons: queryDeep('button, input[type="submit"], input[type="button"], [role="button"]')
      .map(text).filter(Boolean).slice(0, 40),
    links: queryDeep('a[href]')
      .map(text).filter(Boolean).slice(0, 40),
    inputs: queryDeep(INPUT_SEL)
      .map((el) => {
        const ph = el.getAttribute('placeholder') || el.getAttribute('aria-label') || '';
        const nm = el.getAttribute('name') || el.id || '';
        // 敏感框：不读 value（第 9 步硬规矩）
        const val = sensitiveish(el) ? '' : (el.value || '');
        return [ph && ('placeholder=' + ph), nm && ('name=' + nm), val && ('value=' + val)]
          .filter(Boolean).join(' | ') || '(无标识输入框)';
      }).slice(0, 40),
    fields: queryDeep(INPUT_SEL)
      .map(fieldOf).slice(0, 40),
    texts: contentTexts(),
  });
  /**
   * 第 23 步：把 absRect 与 queryDeep 一并暴露 —— driver 的点击链路要拿元素的
   * **绝对坐标**（跨 frame 要累加各级偏移），不能再用 getBoundingClientRect
   * （那只是相对自己那一帧的坐标，点下去会偏到别的元素上）。
   */
  window.__wbHelper = {
    __v: 12, visible, text, find, findInput, findClickable, pick, fieldOf, sensitiveish, otpish,
    loginish, overlayish, challengeish, pageKey, schemeOf, contentTexts, snapshot,
    absRect, queryDeep, ownerWindow,
  };
})();`;

/** 组合一段「注入 helper + 执行动作」的脚本 */
function pageScript(body: string): string {
  return `${PAGE_HELPERS}\n${body}`;
}

/** 读一次页面快照（第 9 步：附带字段分类——敏感框连值都没进过这条链路） */
async function readSnapshot(wc: Target): Promise<PageSnapshot> {
  const raw = await evaluate<PageSnapshot & { fields?: FieldDescriptor[] }>(
    wc,
    pageScript('(() => window.__wbHelper.snapshot())()'),
  );
  const fields = Array.isArray(raw.fields) ? raw.fields : [];
  const inputFields = fields.map((f) => {
    const c = classifyField(f);
    const desc = [f.ph && `placeholder=${f.ph}`, (f.name || f.id) && `name=${f.name || f.id}`, f.lbl && `label=${f.lbl}`]
      .filter(Boolean)
      .join(' | ') || '(无标识输入框)';
    return {
      label: c.kind === 'sensitive' ? `[敏感·${FIELD_REASON_CN[c.reason]}] ${desc}` : desc,
      kind: c.kind,
      reason: c.reason,
    };
  });
  const { fields: _drop, ...snap } = raw;
  return { ...snap, inputFields };
}

/** 第 9 步：type/fill_form 的敏感字段守卫——命中就拒填（不依赖模型自觉） */
async function typeSensitiveGuard(wc: Target, target: string): Promise<string | null> {
  const d = await evaluate<FieldDescriptor | null>(
    wc,
    pageScript(`(() => {
      const el = window.__wbHelper.findInput(${JSON.stringify(target)});
      return el ? window.__wbHelper.fieldOf(el) : null;
    })()`),
  );
  if (!d) return null; // 元素都找不到，让 typeInto 自己报“没找到”
  const c = classifyField(d);
  return c.kind === 'sensitive'
    ? `目标是敏感字段（${FIELD_REASON_CN[c.reason]}），AI 不代填——用户直接在该输入框里打字即可`
    : null;
}

/**
 * 第 16 步：操作失败时的「可能原因 + 一个明确的下一步」。
 * 说明书钉死：失败不要退回「你是否确认打开某某网站」这种整段重确认，
 * 也不要让用户自己猜——按当前快照给出最可能的几条原因，再给一个能立刻做的动作。
 */
function failureHint(snap: PageSnapshot | undefined): string {
  const reasons = [
    snap?.loginLike ? '这一页需要先登录' : '',
    snap?.overlay ? '有弹窗/遮罩挡住了元素' : '',
    '页面可能还没加载完',
    '元素不在当前视图里，或这一页没有相应权限',
  ].filter(Boolean);
  const next = snap?.loginLike
    ? '下一步：要我帮你点页面上的登录入口吗？（账号密码请你自己在网页里输，我不代填、也不收聊天里的密码）'
    : '下一步：把按钮上的准确文字告诉我，或者你自己点一下，然后让我接着做（我会先读你当前的页面，不会从头再来）。';
  return `可能原因：${reasons.join(' / ')}。${next}`;
}

/** 第 9 步：click 的支付确认守卫——收银台最终确认永远由用户点 */
async function payClickGuard(wc: Target, target: string): Promise<string | null> {
  const hit = await evaluate<{ label: string } | null>(
    wc,
    pageScript(`(() => {
      const el = window.__wbHelper.find(${JSON.stringify(target)});
      return el ? { label: window.__wbHelper.text(el) } : null;
    })()`),
  );
  if (hit && isPaymentConfirmAction(hit.label)) {
    return `支付/收银的最终确认必须由用户自己点（按钮「${hit.label.slice(0, 40)}」），AI 不代点`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 各个动作的实现
// ---------------------------------------------------------------------------

/** open_url：让内嵌页真的跳过去，并等它加载完 */
async function navigate(wc: Target, url: string): Promise<void> {
  const target = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      wc.off('did-stop-loading', onStop);
      wc.off('did-fail-load', onFail);
      err ? reject(err) : resolve();
    };
    const onStop = () => finish();
    const onFail = (
      _e: Electron.Event,
      code: number,
      desc: string,
      validatedURL: string,
      isMainFrame: boolean,
    ) => {
      // 子资源失败不算导航失败；-3 是 ERR_ABORTED（页面内跳转常出现），也放过
      if (!isMainFrame || code === -3) return;
      finish(new Error(`导航失败（${code}）${desc} ${validatedURL}`));
    };
    const timer = setTimeout(() => finish(), 30_000);

    wc.once('did-stop-loading', onStop);
    wc.on('did-fail-load', onFail);
    wc.loadURL(target).catch(() => {
      /* 真正的失败由 did-fail-load 汇报，这里避免 unhandled rejection */
    });
  });

  // 页面 onload 之后往往还有异步渲染，稍等一下再读快照
  await sleep(500);
}

/** click 的三种结局：没找到 / 是 App 唤起链接（网页里点不了）/ 点了（附有没有让页面动一下） */
type ClickOutcome =
  | { kind: 'notfound' }
  | { kind: 'applink'; scheme: string; label: string }
  | { kind: 'done'; label: string; method: string; hittable: boolean; noChange: boolean };

/**
 * click：优先用 CDP 发**真实鼠标事件**（先短距离移动再按下+抬起）点元素中心，最接近真人操作。
 *
 * ⚠️ 但**坐标必须落在视口内**才算数。实测踩到过：内嵌页视口只有 551px 宽，
 * 而百度首页那排搜索 UI 固定 771px 宽、把「百度一下」按钮挤到了视口右侧外面，
 * 此时 `Input.dispatchMouseEvent` 发出去的坐标命不中任何元素 —— 点击**静默失败**，
 * 但回执看起来还是 ok:true，属于典型的"假成功"。
 * 所以这里先做一次命中测试（elementFromPoint），命中不了就退化为页面侧 `el.click()`，
 * 并把实际用的方式写进 detail 回报。
 *
 * 第 17 步补两件事：
 *   1. 点之前先看这颗按钮是不是 `bytedance://` 这类 App 唤起链接——是的话直接说清楚
 *      「网页里点不了」，不让用户白点十次；
 *   2. 点完比对地址/标题/节点数，页面一点没动就带上 noChange，让驾驶循环能给出
 *      「原因 + 一个下一步」，而不是无限重试。
 */
async function clickTarget(
  wc: Target,
  target: string,
  /** 第 4 步：任务循环传入的存活检查；每个鼠标动作发出前复查，暂停即中止本步 */
  shouldAbort?: () => boolean,
): Promise<ClickOutcome> {
  const tick = (): void => {
    if (shouldAbort && !shouldAbort()) throw new TaskAborted();
  };
  const hit = await evaluate<{
    x: number;
    y: number;
    tag: string;
    label: string;
    hittable: boolean;
    blockedScheme: string;
    before: string;
    inFrame: boolean;
  } | null>(
    wc,
    pageScript(`(() => {
      const H = window.__wbHelper;
      const el = H.findClickable(${JSON.stringify(target)});
      if (!el) return null;
      const scheme = H.schemeOf(el);
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
      /**
       * ★ 第 23 步：坐标必须用 **absRect**（累加各级 frame 偏移），
       *   因为 CDP 的 Input.dispatchMouseEvent 认的是**最顶层视口**的坐标。
       *   同时命中测试也要分层做：
       *     - 元素在主文档 → 用主文档的 elementFromPoint（老逻辑）
       *     - 元素在某级 frame 里 → 用**那一帧**的 elementFromPoint，
       *       拿主文档的 elementFromPoint 去测只会返回 IFRAME 本身（永远测不到里面）
       */
      const r = H.absRect(el);
      if (!r || r.width <= 0 || r.height <= 0) return null;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const inside = cx >= 0 && cy >= 0 && cx < vw && cy < vh;
      const inFrame = H.ownerWindow(el) !== window;
      // 命中测试：在元素**自己那一帧**里，用该帧坐标做 elementFromPoint
      let hittable = false;
      try {
        const ow = H.ownerWindow(el);
        const lr = el.getBoundingClientRect();
        const lx = lr.left + lr.width / 2;
        const ly = lr.top + lr.height / 2;
        const top = ow.document.elementFromPoint(lx, ly);
        hittable = !!top && (top === el || el.contains(top) || (top.contains && top.contains(el)));
      } catch (_) { hittable = false; }
      return {
        x: Math.round(cx), y: Math.round(cy),
        tag: el.tagName, label: H.text(el).slice(0, 60),
        hittable: inside && hittable,
        blockedScheme: scheme,
        before: H.pageKey(),
        inFrame,
      };
    })()`),
  );

  if (!hit) return { kind: 'notfound' };
  if (hit.blockedScheme) return { kind: 'applink', scheme: hit.blockedScheme, label: hit.label };

  /** 点完再看一眼页面动没动（地址 / 标题 / 节点数） */
  const changed = async (): Promise<boolean> => {
    try {
      const after = await evaluate<string>(wc, pageScript('(() => window.__wbHelper.pageKey())()'));
      return after !== hit.before;
    } catch {
      return true; // 读不到（正在导航）＝页面确实在动
    }
  };

  if (hit.hittable) {
    tick();
    const dbg = ensureAttached(wc);
    // 真实鼠标：先挪到旁边一点点，再挪到目标上，然后按下 + 抬起（比瞬移一次更像人）
    await dbg.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: Math.max(0, hit.x - 3), y: Math.max(0, hit.y - 2), button: 'none', clickCount: 0,
    });
    await dbg.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: hit.x, y: hit.y, button: 'none', clickCount: 0,
    });
    await dbg.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: hit.x, y: hit.y, button: 'left', buttons: 1, clickCount: 1,
    });
    await dbg.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: hit.x, y: hit.y, button: 'left', buttons: 0, clickCount: 1,
    });
    await sleep(900);
    const moved = await changed();
    return {
      kind: 'done',
      label: `${hit.tag}「${hit.label}」${hit.inFrame ? '（在内嵌框架里）' : ''}`,
      method: 'cdp-mouse',
      hittable: true,
      noChange: !moved,
    };
  }

  // 元素不在视口内（或被别的东西盖住）：真实鼠标点不到，退化为页面侧 click()
  tick();
  const done = await evaluate<boolean>(
    wc,
    pageScript(`(() => {
      const el = window.__wbHelper.findClickable(${JSON.stringify(target)});
      if (!el) return false;
      el.click();
      return true;
    })()`),
  );
  await sleep(1200);
  if (!done) return { kind: 'notfound' };
  const moved = await changed();
  return { kind: 'done', label: `${hit.tag}「${hit.label}」`, method: 'page-el.click', hittable: false, noChange: !moved };
}

/**
 * type：聚焦输入框 → 清空 → 写入文字 → 可选提交。
 *
 * ⚠️ 为什么是「三层兜底 + 读回校验」而不是直接 Input.insertText：
 * 实测本机（虚拟机 / 远程桌面环境）**所有 CDP 文本注入路径都会静默失败** ——
 * `Input.insertText`、逐字符 `Input.dispatchKeyEvent`、`DOM.focus + insertText`
 * 执行后输入框的值仍然是空字符串，但**不报错**，非常容易误判成「输入成功了」。
 * （鼠标事件不受影响：`Input.dispatchMouseEvent` 靠命中测试路由，点击是正常的。）
 * 所以这里每写一次都读回 `el.value` 校验，失败就换下一种方式，并把实际用到的
 * 方式写进 `detail` 回报，避免"看着成功其实没输入"。
 */
async function typeInto(
  wc: Target,
  target: string,
  value: string,
  submit: boolean,
  /** 第 4 步：任务循环传入的存活检查；每个键盘/写入动作发出前复查，暂停即中止本步 */
  shouldAbort?: () => boolean,
): Promise<{ ok: true; label: string; method: string } | { ok: false; reason: string }> {
  const tick = (): void => {
    if (shouldAbort && !shouldAbort()) throw new TaskAborted();
  };
  const found = await evaluate<{ tag: string; label: string; x: number; y: number } | null>(
    wc,
    pageScript(`(() => {
      const el = window.__wbHelper.pick(${JSON.stringify(target)});
      if (!el) return null;
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
      el.focus();
      if ('value' in el) {
        const proto = el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(el, ''); else el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (el.isContentEditable) {
        el.textContent = '';
      }
      // 第 23 步：用 absRect（跨 frame 时 CDP 需要最顶层视口坐标）
      const r = window.__wbHelper.absRect(el);
      if (!r) return null;
      return {
        tag: el.tagName,
        label: window.__wbHelper.text(el).slice(0, 60),
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
      };
    })()`),
  );

  if (!found) return { ok: false, reason: `没找到可输入的输入框：${target}` };

  const dbg = ensureAttached(wc);

  /** 先补一次真实鼠标点击：不少站点（含百度的新版搜索框）靠 mousedown/focus 处理器才真正激活输入框 */
  if (found.x > 0 && found.y > 0) {
    tick();
    await dbg.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: found.x, y: found.y, button: 'left', clickCount: 1,
    });
    await dbg.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: found.x, y: found.y, button: 'left', clickCount: 1,
    });
  }

  /** 读回输入框当前的值，用于判断到底有没有写进去 */
  const readValue = async (): Promise<string> =>
    evaluate<string>(
      wc,
      pageScript(`(() => {
        const el = window.__wbHelper.pick(${JSON.stringify(target)});
        if (!el) return '';
        return String(('value' in el ? el.value : el.textContent) || '');
      })()`),
    );

  const written = async (): Promise<boolean> => (await readValue()).indexOf(value) >= 0;

  let method = 'none';

  // 1) CDP 真实输入：正常桌面环境下最接近真人操作
  tick();
  await dbg.sendCommand('Input.insertText', { text: value });
  await sleep(250);
  if (await written()) method = 'cdp-insertText';

  // 2) 第 17 步：逐字符真实键盘事件（keyDown → char → keyUp）。
  //    有些站点的搜索框只在 keydown/keypress 上做防抖与联想，insertText 一次灌进去它不认；
  //    短文本走这条路最像真人打字（长文本太慢，跳过）。
  if (method === 'none' && value.length > 0 && value.length <= 30) {
    tick();
    await evaluate(
      wc,
      pageScript(`(() => {
        const el = window.__wbHelper.pick(${JSON.stringify(target)});
        if (el && el.focus) { try { el.focus(); } catch (_) {} }
        return true;
      })()`),
    );
    for (const ch of Array.from(value)) {
      await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch });
      await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'char', key: ch, text: ch });
      await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
      await sleep(35);
    }
    await sleep(250);
    if (await written()) method = 'cdp-keys';
  }

  // 3) 页面侧 execCommand：仍走 Chromium 编辑管线，beforeinput / input 事件都正常
  if (method === 'none') {
    tick();
    await evaluate(
      wc,
      pageScript(`(() => {
        const el = window.__wbHelper.pick(${JSON.stringify(target)});
        if (!el) return false;
        el.focus();
        try { return document.execCommand('insertText', false, ${JSON.stringify(value)}); } catch (_) { return false; }
      })()`),
    );
    await sleep(250);
    if (await written()) method = 'page-execCommand';
  }

  // 4) 原生 setter + InputEvent：对 React 受控组件最稳的兜底
  if (method === 'none') {
    tick();
    await evaluate(
      wc,
      pageScript(`(() => {
        const el = window.__wbHelper.pick(${JSON.stringify(target)});
        if (!el) return false;
        if ('value' in el) {
          const proto = el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
          const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          if (desc && desc.set) desc.set.call(el, ${JSON.stringify(value)}); else el.value = ${JSON.stringify(value)};
        } else if (el.isContentEditable) {
          el.textContent = ${JSON.stringify(value)};
        } else {
          return false;
        }
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(value)}, inputType: 'insertText' }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`),
    );
    await sleep(250);
    if (await written()) method = 'native-setter';
  }

  if (method === 'none') {
    return {
      ok: false,
      reason: `输入框「${found.label}」找到了，但三种写入方式都没能写进去（读到的是空值）。`,
    };
  }

  if (submit) {
    const beforeUrl = wc.getURL();
    tick();

    // 1) CDP 真实回车键（正常桌面环境下有效；本机键盘注入会静默失效）
    await dbg.sendCommand('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'Enter', code: 'Enter',
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    });
    await dbg.sendCommand('Input.dispatchKeyEvent', {
      type: 'char', key: 'Enter', text: '\r',
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    });
    await dbg.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Enter', code: 'Enter',
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    });
    await sleep(1200);

    // 2) 页面侧合成 Enter 键事件（React 的 onKeyDown 认这个）
    if (wc.getURL() === beforeUrl) {
      await evaluate(
        wc,
        pageScript(`(() => {
          const el = window.__wbHelper.find(${JSON.stringify(target)});
          if (!el) return false;
          const opts = {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
            bubbles: true, cancelable: true, composed: true,
          };
          el.dispatchEvent(new KeyboardEvent('keydown', opts));
          el.dispatchEvent(new KeyboardEvent('keypress', opts));
          el.dispatchEvent(new KeyboardEvent('keyup', opts));
          return true;
        })()`),
      );
      await sleep(1500);
    }

    // 3) 最后兜底：直接提交所属表单
    if (wc.getURL() === beforeUrl) {
      await evaluate(
        wc,
        pageScript(`(() => {
          const el = window.__wbHelper.find(${JSON.stringify(target)});
          const form = el && el.form;
          if (form && form.requestSubmit) { form.requestSubmit(); return true; }
          return false;
        })()`),
      );
      await sleep(1200);
    }
  }

  return { ok: true, label: `${found.tag}「${found.label}」`, method };
}

/**
 * scroll：优先发**真实滚轮事件**（CDP Input.dispatchMouseEvent type=mouseWheel），
 * 页面的 wheel 监听器、懒加载、虚拟列表都会像真人滚动一样被触发。
 *
 * 第 21 步的两处修正（都是实测踩出来的）：
 *   1. 滚轮命令在部分状态下**永不回包** —— 只给它 2 秒，超时就当没发出去，
 *      直接走 JS 兜底（全局 CDP 闸是 8 秒，别在这儿白等）。
 *   2. 很多站点（百度结果页、各种后台列表）正文在**自己的 overflow 容器**里，
 *      `window.scrollBy` 一点都不动。所以兜底要连「视口中心那个可滚动容器」一起滚，
 *      判断「有没有动」也要看容器的 scrollTop，不能只看 window.scrollY。
 */
async function scrollPage(wc: Target, direction: 'up' | 'down'): Promise<void> {
  const deltaY = direction === 'down' ? 640 : -640;
  const dirSign = direction === 'down' ? 1 : -1;

  /** 位置指纹：window 的 scrollY + 视口中心那个可滚动容器的 scrollTop（只看 window 会漏判） */
  const readPos = async (): Promise<{ win: number; inner: number } | null> => {
    try {
      return await evaluate<{ win: number; inner: number }>(
        wc,
        pageScript(`(() => {
          const cx = Math.round(document.documentElement.clientWidth / 2);
          const cy = Math.round(document.documentElement.clientHeight / 2);
          let inner = 0;
          let node = document.elementFromPoint(cx, cy);
          while (node && node !== document.body && node !== document.documentElement) {
            const cs = getComputedStyle(node);
            if (/(auto|scroll)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight + 8) {
              inner = Math.round(node.scrollTop);
              break;
            }
            node = node.parentElement;
          }
          return { win: Math.round(window.scrollY), inner };
        })()`),
      );
    } catch {
      return null;
    }
  };

  const before = await readPos();

  // 1) 先试真滚轮。第 21 步：这条命令可能永不回包，所以只等 2 秒。
  try {
    const geo = await evaluate<{ x: number; y: number }>(
      wc,
      pageScript(`(() => ({
        x: Math.round(document.documentElement.clientWidth / 2),
        y: Math.round(document.documentElement.clientHeight / 2),
      }))()`),
    );
    const x = geo?.x && geo.x > 0 ? geo.x : 200;
    const y = geo?.y && geo.y > 0 ? geo.y : 200;
    const dbg = ensureAttached(wc);
    await Promise.race([
      dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY }),
      sleep(2000).then(() => {
        throw new Error('滚轮无响应');
      }),
    ]);
    await sleep(650);
  } catch {
    /* 滚轮发不出去 / 不回包 —— 走下面的 JS 兜底 */
  }

  let after = await readPos();
  const moved = (a: typeof before, b: typeof after): boolean =>
    Boolean(a && b && (a.win !== b.win || a.inner !== b.inner));

  if (!moved(before, after)) {
    // 2) 兜底：让页面自己滚 —— window 和「视口中心那个可滚动容器」都试一遍
    await evaluate(
      wc,
      pageScript(`(() => {
        const step = Math.round(window.innerHeight * 0.85) * ${dirSign};
        window.scrollBy({ top: step, behavior: 'smooth' });
        const cx = Math.round(document.documentElement.clientWidth / 2);
        const cy = Math.round(document.documentElement.clientHeight / 2);
        let node = document.elementFromPoint(cx, cy);
        while (node && node !== document.body && node !== document.documentElement) {
          const cs = getComputedStyle(node);
          if (/(auto|scroll)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight + 8) {
            node.scrollBy({ top: step, behavior: 'smooth' });
            break;
          }
          node = node.parentElement;
        }
        return true;
      })()`),
    );
    await sleep(500);
    after = await readPos();
  }

  // 3) 两条路都试过页面还是没动 —— 明说，别假装滚过。
  //    循环会把它转成「原因 + 一个下一步」，而不是卡在这儿。
  if (before && after && !moved(before, after)) {
    throw new Error(
      direction === 'down'
        ? '这一页往下滚不动了：可能已经到底，或者正文在另一个独立的滚动区域里'
        : '这一页往上滚不动了：可能已经在最上面',
    );
  }
}

/** screenshot：CDP 截图，只回内存里的 data URL */
async function captureScreenshot(wc: Target): Promise<string> {
  const dbg = ensureAttached(wc);
  const res = (await dbg.sendCommand('Page.captureScreenshot', { format: 'png' })) as {
    data?: string;
  };
  if (!res?.data) throw new Error('截图失败：CDP 没有返回图像数据');
  return `data:image/png;base64,${res.data}`;
}

// ---------------------------------------------------------------------------
// 执行器入口
// ---------------------------------------------------------------------------

/** 传入一个动作 → 在内嵌页执行 → 返回 { ok, pageSnapshot } */
export async function drive(action: BrowserAction, targetWebContentsId?: number): Promise<DriveResult> {
  /**
   * ★ 形状闸：先把"这到底是不是一个合法动作"查清楚，再谈执行。
   *
   * 位置选在这里（而不是各个 IPC 处理器里）是有意的 —— `drive()` 是**唯一**的执行入口：
   * `workbench:drive`、`workbench:read-page`、以及驾驶循环的 `exec` 钩子都走它。
   * 闸放在入口，三个调用方一次覆盖；放在 IPC 层则要记得改三处（迟早漏一个）。
   *
   * 注意 `action` 的类型标注是 `BrowserAction`，但运行时它可能来自 IPC 的任意值 ——
   * 这里必须当成 unknown 来校验，不能信类型。
   */
  const check = validateBrowserAction(action);
  if (!check.ok) {
    const rawName = (action as { action?: unknown } | null | undefined)?.action;
    // 这里把原始字符串当标签用（校验已经失败了，没必要再比对一遍合法名单）；
    // 不是字符串/空串时统一记成 'invalid'。
    const label: DriveActionLabel =
      typeof rawName === 'string' && rawName ? (rawName as DriveActionLabel) : 'invalid';
    return { ok: false, action: label, error: check.error };
  }
  action = check.action;

  const actionName = action.action;

  // 第 22 步：**先解析目标**（没点名 / 页没了都当场报错），因为下面的暂停门是按 target 判的
  // —— 先知道是哪张页，才谈得上它有没有被按住。
  let wc: Target;
  try {
    wc = resolveTarget(targetWebContentsId);
  } catch (err) {
    return { ok: false, action: actionName, error: (err as Error).message };
  }
  const wcId = wc.id;

  // 第 3 步语义保留：paused 门挡住调试区/外来的自动 click / type。
  // 第 4 步起 paused 与状态机同进同退（「暂停」按钮走 pauseTask → applyPaused），
  // 所以任务 running 时该门恒开、paused 时恒关。
  // 第 22 步起这个门**按 target**（以前是全局开关，一路暂停会把别路也一起按住）。
  if (pausedOf(wcId) && PAUSED_BLOCKED.has(actionName)) {
    return {
      ok: false,
      action: actionName,
      error: `这张页的驾驶已暂停（状态机：${phaseOf(wcId)}），「${actionName}」不会自动执行；你可以在内嵌页上自己点。`,
    };
  }

  try {
    /** 补充说明（例如 type 实际用了哪种写入方式），会一路带到调试区 */
    let detail: string | undefined;
    /** 第 17 步：动作做了但页面没动（点了几次都没反应时给「原因 + 下一步」） */
    let noChange = false;

    switch (action.action) {
      case 'open_url': {
        await navigate(wc, action.url);
        detail = `已跳转到 ${wc.getURL()}`;
        break;
      }
      case 'click': {
        const pay = await payClickGuard(wc, action.target); // 第 9 步：支付最终确认不代点
        if (pay) {
          // 第 28 步：带 `risk` 标记 —— 驾驶循环见此标记**必定**停下来申报（不再靠模型自觉）
          return {
            ok: false,
            action: actionName,
            error: pay,
            risk: 'pay',
            pageSnapshot: await readSnapshot(wc),
          };
        }
        const hit = await clickTarget(wc, action.target);
        if (hit.kind === 'notfound') {
          // 第 16 步：click 是最常见的失败，必须给「可能原因 + 一个下一步」，
          // 不能只甩一句「没找到」——那会让模型/用户都只能干瞪眼。
          const snap = await readSnapshot(wc);
          return {
            ok: false,
            action: actionName,
            error: `没找到可点击的元素：${action.target}。${failureHint(snap)}`,
            pageSnapshot: snap,
          };
        }
        if (hit.kind === 'applink') {
          // 第 17 步：抖音这类站点的「打开 App」按钮是 bytedance:// 之类的唤起链接，
          // 网页里点了也不会有效果——直接说清楚，并给一个能在网页里做的下一步，不换内核。
          const snap = await readSnapshot(wc);
          return {
            ok: false,
            action: actionName,
            error:
              `「${hit.label}」是 App 唤起链接（${hit.scheme}:），网页里点不了，` +
              '它只能在手机上打开 App。下一步：换一个能在网页里完成的操作（例如用网页版登录后再操作），或者你自己在卡片里点。',
            pageSnapshot: snap,
          };
        }
        noChange = hit.noChange;
        detail = hit.hittable
          ? `已用真实鼠标点击 ${hit.label}`
          : `点击了 ${hit.label}（该元素不在视口内，真实鼠标点不到，改用页面侧 click()）`;
        if (hit.noChange) detail += '；页面暂时没有可见变化';
        break;
      }
      case 'type': {
        const guard = await typeSensitiveGuard(wc, action.target); // 第 9 步：敏感字段不代填
        if (guard) {
          // 第 28 步：`risk` 标记 ⇒ 驾驶循环必定停下来申报，不再只是"一次失败"
          return {
            ok: false,
            action: actionName,
            error: guard,
            risk: 'sensitive',
            pageSnapshot: await readSnapshot(wc),
          };
        }
        const result = await typeInto(wc, action.target, action.text, Boolean(action.submit));
        if (!result.ok) {
          const snap = await readSnapshot(wc);
          return {
            ok: false,
            action: actionName,
            error: `${result.reason}${/没找到可输入的输入框|找不到.{0,6}输入框/.test(result.reason) ? `。${failureHint(snap)}` : ''}`,
            pageSnapshot: snap,
          };
        }
        // R2（2026-09-22）：写入值只记长度、不记原文 —— detail 会拼进步骤摘要（落库/上屏），
        // 还会随回执进服务端消息历史（之后每轮都发给模型）。
        detail = `已向 ${result.label} 写入 ${[...action.text].length} 个字符（方式：${result.method}）`;
        break;
      }
      case 'scroll': {
        await scrollPage(wc, action.direction);
        detail = `已向${action.direction === 'down' ? '下' : '上'}滚动一屏`;
        break;
      }
      case 'wait': {
        await sleep(Math.min(Math.max(action.seconds, 0), 30) * 1000);
        detail = `等待了 ${action.seconds}s`;
        break;
      }
      case 'read_page': {
        break;
      }
      case 'screenshot': {
        const dataUrl = await captureScreenshot(wc);
        return {
          ok: true,
          action: actionName,
          detail: '已截图（只放在内存里，没有落库）',
          pageSnapshot: await readSnapshot(wc),
          screenshot: dataUrl,
        };
      }
      case 'fill_form': {
        // 第 9 步：一次填多个【普通】字段；每个字段都过敏感守卫，敏感的一律拒
        const filled: string[] = [];
        const refused: string[] = [];
        const missed: string[] = [];
        for (const f of (Array.isArray(action.fields) ? action.fields : []).slice(0, 12)) {
          if (pausedOf(wcId)) throw new TaskAborted();
          const g = await typeSensitiveGuard(wc, f.target);
          if (g) {
            refused.push(String(f.target));
            continue;
          }
          const r = await typeInto(wc, f.target, String(f.text ?? ''), false);
          (r.ok ? filled : missed).push(String(f.target) + (r.ok ? '' : `（${r.reason}）`));
        }
        const detail = `填了 ${filled.length} 项` +
          (refused.length ? `；按规矩拒填敏感 ${refused.length} 项` : '') +
          (missed.length ? `；没填上 ${missed.length} 项` : '');
        if (filled.length === 0) {
          const snap = await readSnapshot(wc);
          return {
            ok: false,
            action: actionName,
            error: `${
              refused.length && !missed.length ? '目标全是敏感字段，一项都不能代填' : missed.join(' / ') || '没有可填的字段'
            }。${failureHint(snap)}`,
            // 第 28 步：一项都没填上、且是因为敏感 ⇒ 标记出来，让循环确定性地申报
            risk: refused.length ? 'sensitive' : undefined,
            pageSnapshot: snap,
          };
        }
        return {
          ok: missed.length === 0,
          action: actionName,
          detail,
          // 第 28 步：普通项填上了、但有敏感项被拒 ⇒ 照样标记（ok 可能为 true，
          // 驾驶循环只看这个标记申报，不把它当成"动作失败"）
          risk: refused.length ? 'sensitive' : undefined,
          pageSnapshot: await readSnapshot(wc),
        };
      }
      case 'focus_sensitive_field': {
        // 第 9 步：只定位聚焦、不带也不读值——剩下交给用户的手
        const f = await evaluate<{ found: boolean; label: string }>(
          wc,
          pageScript(`(() => {
            const el = window.__wbHelper.find(${JSON.stringify(action.target)}) ||
              window.__wbHelper.findInput(${JSON.stringify(action.target)});
            if (!el) return { found: false, label: '' };
            try { el.scrollIntoView({ block: 'center' }); } catch (_) {}
            try { el.focus(); } catch (_) {}
            return { found: true, label: String(window.__wbHelper.text(el) || el.tagName).slice(0, 60) };
          })()`),
        );
        if (!f?.found) {
          return { ok: false, action: actionName, error: `没找到要定位的输入框：${action.target}`, pageSnapshot: await readSnapshot(wc) };
        }
        return { ok: true, action: actionName, detail: `已定位并聚焦「${f.label}」`, pageSnapshot: await readSnapshot(wc) };
      }
      case 'ask_user':
      case 'done': {
        // 第 3 步只定类型，不接业务（不接大模型）
        return {
          ok: false,
          action: actionName,
          error: `「${actionName}」在第 3 步只定义了类型，还没有接业务逻辑。`,
        };
      }
      default: {
        return { ok: false, action: actionName, error: `未知动作：${String(actionName)}` };
      }
    }

    return { ok: true, action: actionName, detail, pageSnapshot: await readSnapshot(wc), ...(noChange ? { noChange: true } : {}) };
  } catch (err) {
    return { ok: false, action: actionName, error: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// 第 9 步：敏感输入完成后的「自动恢复驾驶」观察窗
//
// 信号（任一命中即恢复）：did-navigate / did-navigate-in-page / page-title-updated；
// 或轮询发现**页面上敏感输入框整体消失**（登录/验证完成后表单通常就没了）。
// 读不到快照（导航中脚本失败）也算“页面变了”。
// 上限 10 分钟：到时静默停表，保留手动「继续」兜底——绝不为了自动而替用户点提交。
// ---------------------------------------------------------------------------

const SENSITIVE_WATCH_POLL_MS = 1_200;
const SENSITIVE_WATCH_CAP_MS = 10 * 60_000;

/**
 * 第 27 步：自动恢复观察的**判定规则**。
 *
 * 为什么抽成纯函数：这条规则写错的表现是「求助卡刚弹出来 1.2 秒就被自己收掉、
 * AI 立刻接着跑，用户手都没来得及伸」—— 用户一眼可见，但埋在轮询回调里根本没法单测。
 *
 * 规则：
 *   · 这一轮**有**敏感框 → 记下"本来就有"，**不**判定完成；
 *   · 这一轮**没有**敏感框 → 只有当**之前见过**敏感框时才算"用户处理完了"。
 *     （`state.had` 的初值由调用方决定：`requireSensitiveField` 为假时直接置真，
 *       等价于老行为；为真时置假，于是"页面上压根没有敏感框"的场景
 *       —— 最典型的就是**滑块验证页** —— 不会被误判成完成。）
 */
export function shouldFinishSensitiveWatch(hasSensitiveField: boolean, state: { had: boolean }): boolean {
  if (hasSensitiveField) {
    state.had = true;
    return false;
  }
  return state.had;
}

export function startSensitiveAutoResume(
  onDone: () => void,
  targetWebContentsId?: number,
  /**
   * 第 27 步新增的开关（**默认关，老调用点行为一字不变**）：
   *
   * `requireSensitiveField: true` 时，「敏感框整体消失」这条信号**只有在它先前真的
   * 出现过**才算完成。为什么必须有这个开关（实测会翻车）：
   *   **滑块验证页上根本没有敏感输入框** —— 老逻辑第一次轮询就会判成"框没了 = 完成了"，
   *   于是求助卡片刚弹出来 1.2 秒就被自己收掉、AI 立刻接着跑，用户连手都没来得及伸。
   *   打开这个开关后，没有框的页面只能靠**导航/标题变化**或**用户手动点按钮**来结束等待。
   */
  opts: { requireSensitiveField?: boolean } = {},
): () => void {
  let settled = false;
  /** 已经确认"这一页本来就有敏感框"；不需要这个信号时直接置真（等价于老行为） */
  const watchState = { had: !opts.requireSensitiveField };
  let wc: Target | null = null;
  try {
    // 第 17 步：两路并行时必须盯**这一路那张页**，不能盲选第一个 webview
    wc = resolveTarget(targetWebContentsId);
  } catch {
    /* 内嵌页不在：只靠轮询也起不来，直接让调用方等手动继续 */
  }
  const offs: Array<() => void> = [];
  const cleanup = (): void => {
    clearInterval(timer);
    clearTimeout(cap);
    for (const off of offs) off();
    offs.length = 0;
  };
  const finish = (): void => {
    if (settled) return;
    settled = true;
    cleanup();
    onDone();
  };
  if (wc) {
    const handler = (): void => finish();
    const bound = wc;
    bound.on('did-navigate', handler);
    bound.on('did-navigate-in-page', handler);
    bound.on('page-title-updated', handler);
    offs.push(
      () => bound.off('did-navigate', handler),
      () => bound.off('did-navigate-in-page', handler),
      () => bound.off('page-title-updated', handler),
    );
  }
  const timer = setInterval(() => {
    if (!wc || wc.isDestroyed()) {
      finish();
      return;
    }
    void (async () => {
      try {
        const snap = await readSnapshot(wc as Target);
        const has = Boolean(snap.inputFields?.some((f) => f.kind === 'sensitive'));
        // 判定规则在 shouldFinishSensitiveWatch 里（抽出去是为了能单测，见那里的注释）
        if (shouldFinishSensitiveWatch(has, watchState)) finish();
      } catch {
        finish(); // 导航中读不到 = 页面变了
      }
    })();
  }, SENSITIVE_WATCH_POLL_MS);
  const cap = setTimeout(() => {
    settled = true;
    cleanup();
  }, SENSITIVE_WATCH_CAP_MS);
  return () => {
    settled = true;
    cleanup();
  };
}
