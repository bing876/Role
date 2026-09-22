/**
 * Web 环境下的 Workbench 桥接垫片（供浏览器直接预览与测试使用）
 * 当处于真实 Electron 环境时，window.workbench 已由 preload.ts 注入，本文件不产生影响。
 */

import type {
  BrowserAction,
  BrowserEvent,
  BrowserInstanceInfo,
  DriveResult,
  PageSnapshot,
  TaskState,
  WorkbenchBridge,
  WorkbenchSettings,
} from '@ai-workbench/shared';

if (typeof window !== 'undefined' && !(window as any).workbench) {
  const listeners: Record<string, Array<(payload?: any) => void>> = {};

  const emit = (event: BrowserEvent, payload?: string) => {
    const list = listeners[event] || [];
    list.forEach((cb) => {
      try {
        cb(payload);
      } catch (err) {
        console.warn(`[webBridge] 监听器执行错误 (${event}):`, err);
      }
    });
  };

  const smsListeners: Array<(info: { masked: string; code: string }) => void> = [];

  let activeToken = '';
  let activeApiBase = '';
  let activeLanes: number[] = [];
  const taskStates: Record<number, TaskState> = {};

  const makeState = (phase: TaskState['phase'], detail: string, wcId = 1001, pausedBy?: 'user' | 'agent'): TaskState => ({
    phase,
    detail,
    step: 1,
    blocked: phase === 'paused',
    pausedBy: phase === 'paused' ? (pausedBy ?? 'user') : null,
    wcId,
  });

  const defaultSettings: WorkbenchSettings = {
    maxParallel: 2,
    maxInstances: 6,
  } as unknown as WorkbenchSettings;

  let currentSettings = { ...defaultSettings };
  const virtualWebviews: Record<number, { url: string; title: string }> = {};

  // 拦截 fetch /auth/sms/send，开发模式下在前端自动派发 mock 验证码
  const originalFetch = window.fetch;
  window.fetch = async (...args) => {
    const res = await originalFetch(...args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] as Request)?.url || '';
      if (url.includes('/auth/sms/send')) {
        const cloned = res.clone();
        cloned.json().then((data) => {
          if (data && data.sent) {
            const masked = '138****8001';
            const code = data.mock_code || '123456';
            smsListeners.forEach((fn) => fn({ masked, code }));
          }
        }).catch(() => {});
      }
    } catch {}
    return res;
  };

  const bridgeImpl = {
    isElectron: false,
    platform: 'web',
    appVersion: '0.1.0-web',
    ping: async () => 'pong',

    openBrowser: async (_url?: string) => {},
    showBrowser: async () => {},
    hideBrowser: async () => {},
    focusBrowser: async () => {},

    drive: async (action: BrowserAction, targetWebContentsId?: number): Promise<DriveResult> => {
      const wcId = targetWebContentsId ?? 1001;
      const snap: PageSnapshot = {
        url: virtualWebviews[wcId]?.url || 'https://www.baidu.com',
        title: virtualWebviews[wcId]?.title || '网页视窗',
        links: ['https://www.baidu.com'],
        inputs: ['wd'],
        buttons: ['搜索', '更多', '登录'],
        inputFields: [],
      };
      return {
        ok: true,
        action: action.action,
        detail: `[Web模拟] 成功执行 ${action.action}`,
        pageSnapshot: snap,
      };
    },

    readPage: async (targetWebContentsId?: number): Promise<DriveResult> => {
      const wcId = targetWebContentsId ?? 1001;
      const snap: PageSnapshot = {
        url: virtualWebviews[wcId]?.url || 'https://www.baidu.com',
        title: virtualWebviews[wcId]?.title || '百度一下，你就知道',
        links: ['https://news.baidu.com', 'https://tieba.baidu.com'],
        inputs: ['wd'],
        buttons: ['百度一下', '新闻', 'hao123', '地图', '贴吧', '视频', '图片'],
        inputFields: [{ kind: 'normal', label: '搜索框', reason: 'search_query' }],
      };
      return {
        ok: true,
        action: 'read_page',
        detail: '页面读取完成',
        pageSnapshot: snap,
      };
    },

    pauseDriving: async () => true,
    resumeDriving: async () => true,

    startTask: async (targetWebContentsId?: number): Promise<TaskState> => {
      const wcId = targetWebContentsId ?? 1001;
      const st = makeState('running', '正在执行驾驶任务', wcId);
      taskStates[wcId] = st;
      emit('state', JSON.stringify(st));
      return st;
    },

    pauseTask: async (targetWebContentsId?: number): Promise<TaskState> => {
      const wcId = targetWebContentsId ?? 1001;
      const st = makeState('paused', '已暂停 — 自动操作已停止，浏览器交还给你', wcId, 'user');
      taskStates[wcId] = st;
      const apiBase = activeApiBase || '';
      try {
        await fetch(`${apiBase}/agent/loop/pause`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${activeToken}` },
          body: JSON.stringify({ wcId, by: 'user' }),
        });
      } catch {}
      emit('state', JSON.stringify(st));
      return st;
    },

    resumeTask: async (targetWebContentsId?: number): Promise<TaskState> => {
      const wcId = targetWebContentsId ?? 1001;
      const st = makeState('running', '已恢复驾驶', wcId);
      taskStates[wcId] = st;
      const apiBase = activeApiBase || '';
      try {
        await fetch(`${apiBase}/agent/loop/resume`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${activeToken}` },
          body: JSON.stringify({ wcId }),
        });
      } catch {}
      emit('state', JSON.stringify(st));
      return st;
    },

    resetTask: async (): Promise<TaskState> => {
      const st = makeState('idle', '就绪');
      emit('state', JSON.stringify(st));
      return st;
    },

    getTaskState: async (targetWebContentsId?: number): Promise<TaskState> => {
      const wcId = targetWebContentsId ?? 1001;
      return taskStates[wcId] || makeState('idle', '就绪', wcId);
    },

    agentStart: async (
      goal: string,
      apiBase: string,
      token: string,
      targetWebContentsId?: number,
      opts?: { agentId?: number | null; loopId?: string },
    ): Promise<TaskState> => {
      const wcId = targetWebContentsId ?? 1001;
      activeToken = token;
      activeApiBase = apiBase;
      if (!activeLanes.includes(wcId)) activeLanes.push(wcId);
      const st = makeState('running', `正在执行：${goal}`, wcId);
      taskStates[wcId] = st;
      emit('state', JSON.stringify(st));

      emit('agent', JSON.stringify({ kind: 'note', level: 'info', text: `已启动网页驾驶：${goal}` }));

      const loopId = opts?.loopId;
      if (loopId) {
        (async () => {
          let step = 0;
          let lastResult: any = null;
          while (taskStates[wcId]?.phase === 'running') {
            try {
              const res = await fetch(`${apiBase}/agent/loop/next`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ loopId, result: lastResult, agentId: opts?.agentId, wcId }),
              });
              const decision = await res.json();
              if (decision.kind === 'tool') {
                step += 1;
                const toolName = decision.call?.name;
                const args = decision.call?.args || {};
                emit('agent', JSON.stringify({ kind: 'note', level: 'info', text: decision.text || `准备调用工具：${toolName}` }));

                if (toolName === 'open_url') {
                  const url = args.url || 'https://www.baidu.com';
                  virtualWebviews[wcId] = { url, title: '浏览中...' };
                  emit('agent', JSON.stringify({ kind: 'step', step, summary: `步 ${step}：打开网址 ${url}`, ok: true }));
                  lastResult = { ok: true, detail: `已打开 ${url}`, page: { url, title: '目标网页' } };
                } else if (toolName === 'read_page') {
                  emit('agent', JSON.stringify({ kind: 'step', step, summary: `步 ${step}：读取网页内容`, ok: true }));
                  lastResult = {
                    ok: true,
                    detail: '页面读取成功',
                    page: {
                      url: virtualWebviews[wcId]?.url || 'https://www.baidu.com',
                      title: '网页视窗',
                      buttons: ['下一步', '确定'],
                    },
                  };
                } else {
                  emit('agent', JSON.stringify({ kind: 'step', step, summary: `步 ${step}：执行动作 ${toolName}`, ok: true }));
                  lastResult = { ok: true, detail: `动作 ${toolName} 执行完毕` };
                }
              } else if (decision.kind === 'done') {
                emit('agent', JSON.stringify({
                  kind: 'done',
                  summary: decision.summary || '任务已成功完成',
                  documentTitle: decision.document_title || '任务结论报告',
                  documentOutline: decision.document_outline || ['任务概述', '分析要点', '成果总结'],
                  docReady: true,
                }));
                const doneState = makeState('done', '任务已完成', wcId);
                taskStates[wcId] = doneState;
                emit('state', JSON.stringify(doneState));
                break;
              } else if (decision.kind === 'paused' || decision.kind === 'stopped') {
                const endState = makeState(decision.kind === 'paused' ? 'paused' : 'idle', decision.kind, wcId);
                taskStates[wcId] = endState;
                emit('state', JSON.stringify(endState));
                break;
              } else if (decision.kind === 'ask') {
                emit('agent', JSON.stringify({ kind: 'ask', reason: decision.reason, question: decision.question }));
                const askState = makeState('paused', `等待确认：${decision.question}`, wcId, 'agent');
                taskStates[wcId] = askState;
                emit('state', JSON.stringify(askState));
                break;
              } else {
                break;
              }
            } catch (err) {
              console.warn('[webBridge] agent loop 推进异常:', err);
              break;
            }
          }
        })();
      }

      return st;
    },

    agentStop: async () => {
      Object.keys(taskStates).forEach((k) => {
        const id = Number(k);
        taskStates[id] = makeState('idle', '已停止', id);
        emit('state', JSON.stringify(taskStates[id]));
      });
      activeLanes = [];
      emit('agent', JSON.stringify({ kind: 'note', level: 'info', text: '任务已停止' }));
    },

    agentDrop: async (targetWebContentsId?: number) => {
      const wcId = targetWebContentsId ?? 1001;
      taskStates[wcId] = makeState('idle', '已放下', wcId);
      activeLanes = activeLanes.filter((id) => id !== wcId);
      emit('state', JSON.stringify(taskStates[wcId]));
    },

    loopGoneChoice: async (targetWebContentsId: number, _choice: 'restart' | 'giveup'): Promise<TaskState> => {
      return makeState('idle', '已复位', targetWebContentsId);
    },

    agentLanes: async () => {
      return activeLanes;
    },

    browserOwner: async (_webContentsId: number, _agentId: number) => {},

    browserThrottle: async (_webContentsId: number, _throttle: boolean) => ({ ok: true }),

    agentAnswer: async (text: string, _targetWebContentsId?: number) => {
      emit('agent', JSON.stringify({ kind: 'note', level: 'info', text: `用户补充说明：${text}` }));
    },

    downloadDoc: async (taskId: number, _apiBase: string) => {
      const content = `# 任务 #${taskId} 运行总结与分析报告\n\n- 状态：已成功执行\n- 运行时：Web 沙箱适配器\n- 耗时与步骤：已归档至数据库\n`;
      const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `task-${taskId}-report.md`;
      a.click();
      URL.revokeObjectURL(url);
      return { saved: true, path: `task-${taskId}-report.md` };
    },

    syncSession: async (apiBase: string, token: string) => {
      activeApiBase = apiBase;
      activeToken = token;
      return { ok: true, hasToken: Boolean(token) };
    },

    syncProjects: async (_projectIds: number[]) => {},

    onWebviewBlocked: (_cb: (info: { partition: string; reason: string }) => void) => {
      return () => {};
    },

    getSettings: async () => {
      return { ...currentSettings };
    },

    setSettings: async (patch: Partial<WorkbenchSettings>) => {
      currentSettings = { ...currentSettings, ...patch };
      return { ...currentSettings };
    },

    resourceSnapshot: async () => {
      return {
        enabled: true,
        sampleMs: 3000,
        mainPid: 1,
        level: 'normal' as const,
        cpuPercent: 12.5,
        memoryBytes: 312 * 1024 * 1024,
        gear: 'normal' as const,
        timestamp: Date.now(),
        instances: activeLanes.map((id) => ({
          id,
          webContentsId: id,
          title: virtualWebviews[id]?.title || '工作台内嵌视窗',
          url: virtualWebviews[id]?.url || 'https://www.baidu.com',
          lastActiveAt: Date.now(),
        })),
      } as any;
    },

    resourceHistory: async () => [],
    resourceEvents: async () => [],

    resourceInstances: async (_list: BrowserInstanceInfo[]) => {},

    on: (event: BrowserEvent, callback: (payload?: string) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(callback);
      return () => {
        listeners[event] = (listeners[event] || []).filter((cb) => cb !== callback);
      };
    },

    onSmsMockCode: (cb: (info: { masked: string; code: string }) => void) => {
      smsListeners.push(cb);
      return () => {
        const idx = smsListeners.indexOf(cb);
        if (idx >= 0) smsListeners.splice(idx, 1);
      };
    },
  };

  (window as any).workbench = bridgeImpl as unknown as WorkbenchBridge;
  console.log('[webBridge] Web 直测适配桥已挂载至 window.workbench');
}
export {};
