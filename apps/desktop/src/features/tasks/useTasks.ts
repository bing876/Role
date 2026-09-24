import { useState } from 'react';
import { API_BASE, authFetchJson } from '../../shared/api';

/**
 * 第 8 步：`GET /agent/task/current` 的形态（红点 / 结果都认这个，不信内存假数据）。
 * ★ 类型所有权随逻辑一起搬过来：App 那边只 import 类型，不再各留一份。
 */
export interface CurrentTask {
  id: number;
  status: string;
  goal: string;
  steps: string[];
  unread: boolean;
  summary?: string;
  docTitle?: string;
  unreadHint?: string;
  outline?: string[];
}

/**
 * 阶段 1① · 逻辑抽离第 6 片：**任务快照与结果文档**。
 *
 * 三件事：
 *   · `refreshTask()` —— 拉 `/agent/task/current`（红点的**唯一事实源**在服务端）；
 *   · `openTaskResult()` —— 打开结果详情 + 标已读（红点熄灭）；
 *   · `downloadTaskDoc()` —— 走主进程的"另存为 + 写盘"（内容在主进程侧脱敏）。
 *
 * ★ 为什么 `hasUnread` / `curTask` 的 **setter 也要往外给**：
 *   主进程事件分发（`done` / `note` / `ask` 那几条分支）会顺手点亮/熄灭红点，
 *   而那条 effect 属于**聊天侧的事件分发**，留在 `App.tsx`。
 *   这里把 setter 原样透出，是为了让那条 effect **一个字都不用改**。
 *
 * ★ 本片**只搬逻辑，不动一行 JSX / 一行 CSS**（同名解构回 App）。
 */

export interface UseTasksOptions {
  /** 最新值镜像：会话（token 从这里面拿） */
  sessionRef: { current: { token: string } | null };
  /** 当前会话本身：下载文档前要先确认"确实登录着" */
  session: { token: string } | null;
}

export interface TasksApi {
  /** 当前任务快照（服务端说了算；拉不到就保持原样） */
  curTask: CurrentTask | null;
  setCurTask: (t: CurrentTask | null) => void;
  /** 结果详情面板开没开 */
  taskDetailOpen: boolean;
  setTaskDetailOpen: (v: boolean) => void;
  /** 下载文档那一行的小字 */
  docNote: string;
  setDocNote: (v: string) => void;
  /** 红点（`助` 那个头像上） */
  hasUnread: boolean;
  setHasUnread: (v: boolean | ((prev: boolean) => boolean)) => void;
  /** 拉任务快照；后端/库没起时**red 点保持原样、不打扰** */
  refreshTask: () => Promise<void>;
  /** 看完结果 → 服务端标记已读、红点熄灭 */
  openTaskResult: () => Promise<void>;
  /** 下载 .md：主进程弹"另存为"+写盘，内容经脱敏兜底 */
  downloadTaskDoc: () => Promise<void>;
  /** 登出/换号：任务这一侧的 state 一次清干净 */
  resetTasks: () => void;
}

export function useTasks({ sessionRef, session }: UseTasksOptions): TasksApi {
  const [hasUnread, setHasUnread] = useState(false);
  const [curTask, setCurTask] = useState<CurrentTask | null>(null);
  const [taskDetailOpen, setTaskDetailOpen] = useState(false);
  const [docNote, setDocNote] = useState('');

  const refreshTask = async () => {
    const sess = sessionRef.current;
    if (!sess) return;
    try {
      const r = await authFetchJson<{ task: CurrentTask | null }>('/agent/task/current', {
        headers: { authorization: `Bearer ${sess.token}` },
      });
      if (r.task) {
        setCurTask(r.task);
        setHasUnread(r.task.status === 'done' && r.task.unread);
      }
    } catch {
      /* 后端/库没起时红点保持原样，不打扰 */
    }
  };

  /** 看完结果 → 服务端标记已读、红点熄灭 */
  const openTaskResult = async () => {
    if (!curTask) return;
    setTaskDetailOpen(true);
    if (curTask.unread) {
      const sess = sessionRef.current;
      try {
        await authFetchJson('/agent/task/read', {
          method: 'POST',
          body: JSON.stringify({ taskId: curTask.id }),
          headers: { authorization: `Bearer ${sess?.token ?? ''}` },
        });
        setCurTask({ ...curTask, unread: false });
        setHasUnread(false);
      } catch {
        /* 标已读失败就留着红点，下次再点 */
      }
    }
  };

  /** 下载 .md：主进程弹"另存为"+写盘，内容经脱敏兜底 */
  const downloadTaskDoc = async () => {
    if (!curTask || !session) return;
    setDocNote('正在准备文档…');
    const r = await window.workbench?.downloadDoc(curTask.id, API_BASE());
    if (!r) return;
    if (r.saved) setDocNote(`已保存：${r.path}`);
    else if (r.canceled) setDocNote('已取消保存');
    else setDocNote(`下载失败：${r.error ?? '未知原因'}`);
  };

  const resetTasks = () => {
    setCurTask(null);
    setTaskDetailOpen(false);
    setDocNote('');
    setHasUnread(false);
  };

  return {
    curTask,
    setCurTask,
    taskDetailOpen,
    setTaskDetailOpen,
    docNote,
    setDocNote,
    hasUnread,
    setHasUnread,
    refreshTask,
    openTaskResult,
    downloadTaskDoc,
    resetTasks,
  };
}
