/**
 * 批次 H | 电脑三级可见度 — Status/Preview(侧边钉住)/Takeover，默认收起
 * 依据 Grok：电脑越显眼，用户越被迫去监督它
 *
 * 三档：
 * - status：只显示状态芯片，默认收起，不抢焦点
 * - preview：侧边钉住，显示当前工具调用/页面摘要，半显眼
 * - takeover：浏览器前置 + 顶部监督横幅，用户必须监督，最显眼
 *
 * ★ 收尾 7（2026-09-24）修的三处空转 —— 改之前这个组件**一次都没真正生效过**：
 *   1. 它从来没被挂进 `App.tsx`（只在 `browser/index.ts` 里 export 着），界面上根本没有这三档；
 *   2. 持久化打的是 `fetch('/api/agents/:id/visibility')`，而服务端的路由是 `/agents/:id/visibility`
 *      （没有 `/api` 前缀）→ 404；token 读的是 `localStorage.getItem('token')`，
 *      而桌面存 JWT 的 key 是 `workbench.token` → 就算路径对了也是 401。两处都错，所以从没存上；
 *   3. 它**从不加载**已存的偏好（没有 GET），重开应用永远回到 status。
 *   现在：路径与 token 都由调用方传进来（`apiBase` / `token`，App 那边就是 `API_BASE()` 与它握着的 JWT），
 *   读写两个动作抽成 `loadVisibility` / `saveVisibility` 两个纯函数**导出**（验收能直接打它们，
 *   不必渲染 DOM），组件自己不再偷偷 fetch。
 *
 * ★★ 另一条更容易写错的：**children（浏览器面板）绝不能因为切档而换父节点、被卸载、或尺寸归零**。
 *   仓库里 `styles.css` 的 `.browserLayer--bg` 注释已经写明了原因：驾驶的点击坐标来自页内
 *   `getBoundingClientRect`，webview 一旦 `display:none` / 尺寸 0 / 被卸载，坐标全算不出来，
 *   点击静默失败 —— 而 React 里「把同一个元素挪到另一个父节点下」等于卸载重建。
 *   所以本组件把 children **恒久**渲染在同一个 `__host` 里，三档只改宿主周围那圈 chrome；
 *   `status` 档也不再像原来那样直接 `return`（原来那一版在 status 下**根本不渲染 children**）。
 *   App.tsx 那边的接法更保守：BrowserPanel 与本组件是**兄弟**节点（不塞进 children），
 *   这样连「换父节点」的可能性都不存在。
 *
 * ★ 本组件**不许**碰任务执行：不调 loop 的 start/stop/pause、不调 throttle。
 *   「可见性」与「跑不跑」是两件事（`panel-visibility-coupling-probe.py` 就是钉这条的）。
 *   切档要顺带把浏览器前置，那是**调用方**的事（App 调 `browser.showFullscreen()`，
 *   而那条路本来就是「视图开关，跟任务执行毫无耦合」）。
 *
 * 状态来自 loop (running/waiting/done/paused/job_pending)；可见度偏好存 agents.computer_visibility，默认 status。
 */

import { useEffect, useState } from 'react';

export type ComputerVisibility = 'status' | 'preview' | 'takeover';

export const VISIBILITY_LEVELS: ComputerVisibility[] = ['status', 'preview', 'takeover'];

export interface ComputerVisibilityProps {
  agentId: number | null;
  loopStatus?: string | null;
  /** 状态人话摘要（AgentRow.statusDetail）——比裸状态码有用，界面上就显示它 */
  statusDetail?: string | null;
  /** 当前步数（AgentRow.statusStep） */
  step?: number | null;
  currentTool?: string | null;
  pageSummary?: string | null;
  /** 受控用法：调用方（App）持有档位并负责持久化 */
  visibility?: ComputerVisibility;
  onChange?: (v: ComputerVisibility) => void;
  /** 后端地址：桌面在 Electron 里是 http://127.0.0.1:8787，浏览器直测时是 ''（走 Vite 代理） */
  apiBase?: string;
  /** JWT。★ 不许自己去 localStorage 摸：key 是调用方的事（桌面用的是 workbench.token） */
  token?: string | null;
  children?: React.ReactNode; // browser panel
}

const LABEL: Record<ComputerVisibility, string> = {
  status: '状态',
  preview: '预览',
  takeover: '接管',
};

const STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  waiting: '等待中',
  waiting_job: '等待同事',
  paused: '已暂停',
  done: '已完成',
  stopped: '已停止',
  failed: '失败',
  idle: '空闲',
  thinking: '思考中',
  working: '在干活',
  blocked: '需要你看一眼',
};

// ---------------------------------------------------------------------------
// 持久化：两个纯函数，路径与鉴权只在这里定义一次
// ---------------------------------------------------------------------------

/** 读写偏好走的是同一个地址（服务端 `routes/computerVisibility.ts`，**没有** `/api` 前缀） */
export function visibilityUrl(apiBase: string | undefined, agentId: number): string {
  const base = String(apiBase ?? '').replace(/\/+$/, '');
  return `${base}/agents/${agentId}/visibility`;
}

function authHeaders(token: string | null | undefined): Record<string, string> {
  const t = String(token ?? '').trim();
  return t ? { 'content-type': 'application/json', authorization: `Bearer ${t}` } : { 'content-type': 'application/json' };
}

/**
 * 读回已存的档位。失败（未登录 / 网络 / 老后端没这条路由）一律回 `null`，
 * **不许**回落成 `'status'` 再写回去 —— 那会把「读不到」变成「用户选了收起」，把偏好抹掉。
 */
export async function loadVisibility(input: {
  apiBase?: string;
  token?: string | null;
  agentId: number | null;
}): Promise<ComputerVisibility | null> {
  if (!Number.isInteger(input.agentId) || !input.agentId) return null;
  try {
    const res = await fetch(visibilityUrl(input.apiBase, input.agentId as number), {
      method: 'GET',
      headers: authHeaders(input.token),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { visibility?: unknown };
    const v = typeof body?.visibility === 'string' ? body.visibility : '';
    return (VISIBILITY_LEVELS as string[]).includes(v) ? (v as ComputerVisibility) : null;
  } catch {
    return null;
  }
}

/** 存档位。成功回 true；失败回 false（调用方决定要不要提示，组件自己不吞错也不假装成功） */
export async function saveVisibility(
  input: { apiBase?: string; token?: string | null; agentId: number | null },
  visibility: ComputerVisibility,
): Promise<boolean> {
  if (!Number.isInteger(input.agentId) || !input.agentId) return false;
  if (!(VISIBILITY_LEVELS as string[]).includes(visibility)) return false;
  try {
    const res = await fetch(visibilityUrl(input.apiBase, input.agentId as number), {
      method: 'POST',
      headers: authHeaders(input.token),
      body: JSON.stringify({ visibility }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

export function ComputerVisibility({
  agentId,
  loopStatus,
  statusDetail,
  step,
  currentTool,
  pageSummary,
  visibility: propVisibility,
  onChange,
  children,
}: ComputerVisibilityProps) {
  /** 默认收起（status）：不抢焦点。受控时用调用方给的档位 */
  const [visibility, setVisibility] = useState<ComputerVisibility>(propVisibility ?? 'status');

  useEffect(() => {
    if (propVisibility) setVisibility(propVisibility);
  }, [propVisibility]);

  /**
   * 切档只改本地状态 + 通知调用方。
   * ★ 持久化不在这里做：调用方（App）握着 `API_BASE()` 与 JWT，由它调 `saveVisibility`
   *   —— 组件自己去摸 localStorage 正是原来那版存不上的根因（key 都摸错了）。
   * ★ 也不在这里碰任何 loop/驾驶接口（见文件头：可见性与任务执行必须解耦）。
   */
  const set = (v: ComputerVisibility) => {
    setVisibility(v);
    onChange?.(v);
  };

  const statusText = loopStatus ? (STATUS_LABEL[loopStatus] ?? loopStatus) : '空闲';
  const who = agentId ? `#${agentId}` : '未选智能体';

  return (
    <div className={`computerVisibility computerVisibility--${visibility}`} data-agent-id={agentId ?? ''}>
      <div className="computerVisibility__bar">
        <span className={visibility === 'status' ? 'chip' : 'chip chip--on'}>{statusText}</span>
        {typeof step === 'number' && step > 0 && <span className="small">第 {step} 步</span>}
        {currentTool && <span className="small">· {currentTool}</span>}
        {statusDetail && <span className="small computerVisibility__detail">{statusDetail}</span>}
        <span className="small computerVisibility__who">{who}</span>
        <span className="computerVisibility__actions">
          {VISIBILITY_LEVELS.map((v) => (
            <button
              key={v}
              type="button"
              className={v === visibility ? 'btn btn--small btn--primary' : 'btn btn--small'}
              title={v === 'takeover' ? '浏览器前置 + 监督横幅' : v === 'preview' ? '侧边钉住预览' : '收起为状态'}
              onClick={() => set(v)}
            >
              {LABEL[v]}
            </button>
          ))}
        </span>
      </div>

      {visibility === 'preview' && (
        <div className="computerVisibility__preview">
          {pageSummary ? <div className="small">{pageSummary.slice(0, 200)}</div> : <div className="small">（暂无页面摘要）</div>}
        </div>
      )}

      {visibility === 'takeover' && (
        /**
         * 接管档：**不遮页**。原来那一版是 `position:fixed; inset:0` 的黑色遮罩，
         * 正好把用户该监督的那张页盖住 —— 与这一档的目的相反。
         * 现在是一条顶部横幅（`pointer-events` 只落在按钮上），页照常看得见；
         * 「浏览器前置」由调用方调 `browser.showFullscreen()` 完成（那是既有的视图开关，与执行无耦合）。
         * 版式（颜色/圆角/位置）等用户的 1:1 设计稿，这里只保证功能与「不挡页」。
         */
        <div className="computerVisibility__takeoverBanner">
          <span className="chip chip--on">⚠️ 接管模式 — 请监督电脑操作</span>
          <span className="small">电脑越显眼，用户越被迫去监督它（Grok）</span>
          {pageSummary && <div className="small">页面：{pageSummary.slice(0, 300)}</div>}
        </div>
      )}

      {/**
        * ★ children 恒久渲染在同一个宿主里：三档都不换父节点、不卸载、不 `display:none`、不尺寸归零。
        *   原因见文件头（webview 一旦没有真实尺寸，驾驶的点击坐标全废）。
        *   App.tsx 目前把 BrowserPanel 当**兄弟**节点渲染（更保守），所以这个宿主通常是空的 ——
        *   留着它是为了「谁哪天把面板塞进来」时不会踩到卸载那个坑。
        */}
      <div className="computerVisibility__host">{children}</div>
    </div>
  );
}

// 工具：格式化工具描述（与 loop.ts 的 formatToolDesc 保持一致）
export function formatToolForVisibility(call: { name: string; args?: any } | null): string | null {
  if (!call) return null;
  const args = (call.args ?? {}) as Record<string, unknown>;
  if (call.name === 'open_url') return `打开 ${String(args.url ?? '')}`;
  if (call.name === 'click') return `点击 ${String(args.target ?? '')}`;
  if (call.name === 'type') return `输入到 ${String(args.target ?? '')}`;
  if (call.name === 'read_page') return '读页面';
  if (call.name === 'scroll') return `滚动 ${args.direction ?? 'down'}`;
  return call.name;
}
