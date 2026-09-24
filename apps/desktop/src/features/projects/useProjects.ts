import { useState } from 'react';
import type { ProjectSummary } from '@ai-workbench/shared';
import { authFetchJson } from '../../shared/api';
import type { ProjectCreateResult, ProjectListResult, ProjectUpdateResult } from '@ai-workbench/shared';

/**
 * 阶段 1① · 逻辑抽离第 4 片：**项目层**（列表 / 切换 / 新建）。
 *
 * ★ 为什么要**注入** `onEnterProject` 而不是在这里直接进项目：
 *   「进入某个项目」要同时动**三块 feature 的 state** ——
 *   · 聊天侧的名单与当前智能体（`agents` / `curAgentId` + 那几个"最新值镜像" ref）；
 *   · 记忆侧的项目记忆（`projMem` 清空）；
 *   · 资料侧的资料列表（`knowledgeDocs` 清空、按新项目重拉）。
 *   按用户拍板的架构（feature 之间只经各自 `index.ts` 互访、`features/**` 不许依赖 `app/**`），
 *   这种**跨 feature 协调**只能待在组合层（`App.tsx`）—— 于是这里只负责"项目这一侧"，
 *   把"进项目"这一个动作作为回调注入进来。
 *
 * ★ 本片**只搬逻辑，不动一行 JSX / 一行 CSS**：仍然同名解构回 App。
 */

export interface UseProjectsOptions {
  /** 最新值镜像：会话 */
  sessionRef: { current: { token: string } | null };
  /** 最新值镜像：当前项目 id（切项目在异步里最容易串，必须读最新值） */
  curProjectRef: { current: number | null };
  /** 把「当前使用中的项目」写回 App 的 state（钩子自己只管列表这一份） */
  onCurrentProject: (id: number | null) => void;
  /** ★ 跨 feature 协调点：真正切进某个项目（换名单 / 清记忆与资料缓存 / 重拉四份数据） */
  onEnterProject: (id: number) => Promise<void>;
}

export interface ProjectsApi {
  projects: ProjectSummary[];
  projectsOpen: boolean;
  setProjectsOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  projectBusy: boolean;
  projectNote: string;
  newProjectName: string;
  setNewProjectName: (v: string) => void;
  /** 读项目列表；把「当前使用中的项目」同步到 state 与 ref，并返回它 */
  loadProjects: () => Promise<number | null>;
  /** 切换当前项目：服务端 activate 先落地，再进这个项目（名单与资料一起换） */
  switchProject: (id: number) => Promise<void>;
  /** 新建项目（服务端连带建一只母鸡并设为当前项目）→ 直接进这个新项目 */
  createProject: () => Promise<void>;
  /** 换号/登出：把项目这一侧的 state 清干净 */
  resetProjects: () => void;
}

export function useProjects({
  sessionRef,
  curProjectRef,
  onCurrentProject,
  onEnterProject,
}: UseProjectsOptions): ProjectsApi {
  /** 项目列表（当前项目那一条 `isCurrent`） */
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectNote, setProjectNote] = useState('');

  /** 读项目列表；把「当前使用中的项目」同步到 state 与 ref，并返回它 */
  const loadProjects = async (): Promise<number | null> => {
    const sess = sessionRef.current;
    if (!sess) return null;
    try {
      const r = await authFetchJson<ProjectListResult>('/projects', {
        headers: { authorization: `Bearer ${sess.token}` },
      });
      if (sessionRef.current?.token !== sess.token) return null;
      setProjects(r.projects);
      /**
       * ★ 把项目列表推给主进程 —— 分区闸（`will-attach-webview`）靠它判定归属。
       * 主进程那个事件是**同步**的，没法自己去拉，所以必须在这里显式同步一次。
       * 拿不到列表时（上面 catch）不同步，主进程会保持"还没同步过"的宽松状态。
       */
      void window.workbench?.syncProjects?.(r.projects.map((p) => p.id));
      curProjectRef.current = r.currentProjectId;
      onCurrentProject(r.currentProjectId);
      setProjectNote('');
      return r.currentProjectId;
    } catch (e) {
      setProjectNote(`读不到项目列表：${(e as Error).message}`);
      return null;
    }
  };

  /** 切换当前项目：服务端 activate 先落地，再进这个项目（名单与资料一起换） */
  const switchProject = async (id: number) => {
    const sess = sessionRef.current;
    if (!sess || projectBusy || id === curProjectRef.current) return;
    setProjectBusy(true);
    setProjectNote('');
    try {
      await authFetchJson<ProjectUpdateResult>(`/projects/${id}/activate`, {
        method: 'POST',
        body: '{}',
        headers: { authorization: `Bearer ${sess.token}` },
      });
      if (sessionRef.current?.token !== sess.token) return;
      await onEnterProject(id);
      await loadProjects();
    } catch (e) {
      setProjectNote(`切换项目没成：${(e as Error).message}`);
    } finally {
      setProjectBusy(false);
    }
  };

  /** 新建项目（服务端连带建一只母鸡并设为当前项目）→ 直接进这个新项目 */
  const createProject = async () => {
    const sess = sessionRef.current;
    const name = newProjectName.trim();
    if (!sess || projectBusy || !name) return;
    setProjectBusy(true);
    setProjectNote('');
    try {
      const r = await authFetchJson<ProjectCreateResult>('/projects', {
        method: 'POST',
        body: JSON.stringify({ name }),
        headers: { authorization: `Bearer ${sess.token}` },
      });
      if (sessionRef.current?.token !== sess.token) return;
      setNewProjectName('');
      setProjectNote(`项目「${r.project.name}」建好了（自带一只母鸡），已经切过去。`);
      await onEnterProject(r.project.id);
      await loadProjects();
    } catch (e) {
      setProjectNote(`建项目没成：${(e as Error).message}`);
    } finally {
      setProjectBusy(false);
    }
  };

  /** 换号/登出（两处调用点原来各写 4 行，现在收口成一个动作） */
  const resetProjects = () => {
    setProjects([]);
    setProjectBusy(false); // 换号时别把「处理中…」留在界面上
    setProjectsOpen(false);
    setNewProjectName('');
    setProjectNote('');
  };

  return {
    projects,
    projectsOpen,
    setProjectsOpen,
    projectBusy,
    projectNote,
    newProjectName,
    setNewProjectName,
    loadProjects,
    switchProject,
    createProject,
    resetProjects,
  };
}
