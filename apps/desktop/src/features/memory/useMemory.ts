/**
 * 记忆（两层记忆 + 待确认记忆）—— 从 `App.tsx` 抽出的**逻辑**，**行为逐字未改**。
 *
 * 这一片只动「逻辑」，不动 JSX、不动 CSS（用户 2026-09-24 的叫停）。
 * App 那边按**同名的**解构取回这些值，所以 JSX 一个字都不用改：
 *
 *   const {
 *     user: userMem, setUser: setUserMem, userOpen: userMemOpen, setUserOpen: setUserMemOpen,
 *     project: projMem, …, pending: pendingMem, …,
 *     loadUser: loadUserMemory, loadProject: loadProjectMemory, loadPending: loadPendingMemory,
 *     forget: forgetEntry, confirm: confirmMemory, reject: rejectMemory,
 *     confirmAll: confirmAllPending, rejectAll: rejectAllPending,
 *   } = useMemory({ sessionRef, curAgentRef, onNote: setChatNote });
 *
 * 依赖注入（而不是 import App）：
 *   · `sessionRef` / `curAgentRef` —— 会话与"当前是谁"的真相仍在 App 手里，
 *     这两个**镜像 ref**（用户 2026-09-24 点名：7 个镜像一个都不许删）原样传进来用；
 *   · `onNote` —— 提示文案写哪由调用方决定（与 `browser/useBrowserWorkspace` 的 `onNote` 同一套做法），
 *     这样本 feature 不依赖 chat 的 state。
 */
import { useState } from 'react';
import type { MutableRefObject } from 'react';
import type {
  AuthSession,
  MemoryEntry,
  MemoryItem,
  MemoryLayerList,
  MemoryListResult,
} from '@ai-workbench/shared';
import { authFetchJson } from '../../shared/api';

export interface UseMemoryOptions {
  sessionRef: MutableRefObject<AuthSession | null>;
  /** "当前是哪个智能体"的镜像（App 的 `curAgentRef`）——切走后晚到的响应要靠它挡住 */
  curAgentRef: MutableRefObject<number | null>;
  /** 往聊天流写一句人话（App 传的是 `setChatNote`） */
  onNote: (text: string) => void;
}

export interface MemoryApi {
  user: MemoryEntry[];
  setUser: (next: MemoryEntry[]) => void;
  userOpen: boolean;
  setUserOpen: (next: boolean | ((prev: boolean) => boolean)) => void;
  project: MemoryEntry[];
  setProject: (next: MemoryEntry[]) => void;
  projectOpen: boolean;
  setProjectOpen: (next: boolean | ((prev: boolean) => boolean)) => void;
  pending: MemoryItem[];
  setPending: (next: MemoryItem[] | ((prev: MemoryItem[]) => MemoryItem[])) => void;
  pendingOpen: boolean;
  setPendingOpen: (next: boolean | ((prev: boolean) => boolean)) => void;
  loadUser: () => Promise<void>;
  loadProject: (agentId: number) => Promise<void>;
  loadPending: (agentId?: number | null, conversationId?: number | null) => Promise<void>;
  forget: (layer: 'user' | 'agent', id: number) => Promise<void>;
  confirm: (id: number) => Promise<void>;
  reject: (id: number) => Promise<void>;
  confirmAll: () => Promise<void>;
  rejectAll: () => Promise<void>;
}

export function useMemory({ sessionRef, curAgentRef, onNote }: UseMemoryOptions): MemoryApi {
  /** 第一层：用户记忆库（账号级） */
  const [user, setUser] = useState<MemoryEntry[]>([]);
  const [userOpen, setUserOpen] = useState(false);
  /** 第二层：项目（智能体级）记忆 */
  const [project, setProject] = useState<MemoryEntry[]>([]);
  const [projectOpen, setProjectOpen] = useState(false);
  /** 记忆合并第四批：待确认记忆 */
  const [pending, setPending] = useState<MemoryItem[]>([]);
  const [pendingOpen, setPendingOpen] = useState(false);

  const memHeaders = () => ({ authorization: `Bearer ${sessionRef.current?.token ?? ''}` });

  /** 第一层：用户记忆库（账号级）——任何智能体都读得到，界面也一样列出来 */
  const loadUser = async () => {
    if (!sessionRef.current) return;
    try {
      const r = await authFetchJson<MemoryLayerList>('/memory/user', { headers: memHeaders() });
      setUser(r.items);
    } catch {
      /* 后端/库没起就不打扰 */
    }
  };

  /** 第二层：某个智能体的项目记忆（智能体级）——切智能体就整块换成它自己的 */
  const loadProject = async (agentId: number) => {
    if (!sessionRef.current) return;
    try {
      const r = await authFetchJson<MemoryLayerList>(`/agents/${agentId}/memory`, { headers: memHeaders() });
      // 切走之后晚到的响应不能覆盖当前智能体的那份
      if (curAgentRef.current !== agentId) return;
      setProject(r.items);
    } catch {
      /* 同上 */
    }
  };

  /** 记忆合并第四批：待确认记忆（账号级+智能体级+会话级，三级合并） */
  const loadPending = async (agentId?: number | null, conversationId?: number | null) => {
    if (!sessionRef.current) return;
    try {
      const params = new URLSearchParams();
      if (agentId) params.set('agentId', String(agentId));
      if (conversationId) params.set('conversationId', String(conversationId));
      const qs = params.toString() ? `?${params.toString()}` : '';
      const r = await authFetchJson<MemoryListResult>(`/memories${qs}`, { headers: memHeaders() });
      setPending(r.pending);
    } catch {
      /* 后端/库没起就不打扰 */
    }
  };

  /** 忘掉一条：user = 账号级用户记忆库；agent = 当前智能体的项目记忆 */
  const forget = async (layer: 'user' | 'agent', id: number) => {
    const sess = sessionRef.current;
    if (!sess) return;
    try {
      await authFetchJson('/memory/forget', {
        method: 'POST',
        body: JSON.stringify({ layer, id }),
        headers: { authorization: `Bearer ${sess.token}` },
      });
      if (layer === 'user') void loadUser();
      else if (curAgentRef.current !== null) void loadProject(curAgentRef.current);
    } catch (e) {
      onNote(`忘掉失败：${(e as Error).message}`);
    }
  };

  /** 记忆合并第四批：确认/拒绝待确认记忆 */
  const confirm = async (id: number) => {
    const sess = sessionRef.current;
    if (!sess) return;
    try {
      await authFetchJson('/memories/confirm', {
        method: 'POST',
        body: JSON.stringify({ ids: [id] }),
        headers: { authorization: `Bearer ${sess.token}` },
      });
      setPending((prev) => prev.filter((m) => m.id !== id));
      void loadUser();
      if (curAgentRef.current !== null) void loadProject(curAgentRef.current);
      onNote('已确认一条记忆，今后会按它执行。');
    } catch (e) {
      onNote(`确认失败：${(e as Error).message}`);
    }
  };

  const reject = async (id: number) => {
    const sess = sessionRef.current;
    if (!sess) return;
    try {
      await authFetchJson('/memories/reject', {
        method: 'POST',
        body: JSON.stringify({ ids: [id] }),
        headers: { authorization: `Bearer ${sess.token}` },
      });
      setPending((prev) => prev.filter((m) => m.id !== id));
      onNote('已忽略一条记忆。');
    } catch (e) {
      onNote(`忽略失败：${(e as Error).message}`);
    }
  };

  const confirmAll = async () => {
    const sess = sessionRef.current;
    if (!sess || pending.length === 0) return;
    try {
      await authFetchJson('/memories/confirm', {
        method: 'POST',
        body: JSON.stringify({ all: true }),
        headers: { authorization: `Bearer ${sess.token}` },
      });
      setPending([]);
      void loadUser();
      if (curAgentRef.current !== null) void loadProject(curAgentRef.current);
      onNote(`已确认全部 ${pending.length} 条记忆。`);
    } catch (e) {
      onNote(`批量确认失败：${(e as Error).message}`);
    }
  };

  const rejectAll = async () => {
    const sess = sessionRef.current;
    if (!sess || pending.length === 0) return;
    try {
      await authFetchJson('/memories/reject', {
        method: 'POST',
        body: JSON.stringify({ all: true }),
        headers: { authorization: `Bearer ${sess.token}` },
      });
      setPending([]);
      onNote(`已忽略全部 ${pending.length} 条待确认记忆。`);
    } catch (e) {
      onNote(`批量忽略失败：${(e as Error).message}`);
    }
  };

  return {
    user,
    setUser,
    userOpen,
    setUserOpen,
    project,
    setProject,
    projectOpen,
    setProjectOpen,
    pending,
    setPending,
    pendingOpen,
    setPendingOpen,
    loadUser,
    loadProject,
    loadPending,
    forget,
    confirm,
    reject,
    confirmAll,
    rejectAll,
  };
}
