/**
 * 批次 H | 电脑三级可见度 — Status/Preview(侧边钉住)/Takeover，默认收起
 * 依据 Grok：电脑越显眼，用户越被迫去监督它
 *
 * 三档：
 * - status：只显示状态芯片，默认收起，不抢焦点
 * - preview：侧边钉住，显示当前工具调用/页面摘要，半显眼
 * - takeover：全屏接管，浏览器前置，用户必须监督，最显眼
 *
 * 设计：
 * - 默认收起（status），用户可点展开
 * - Preview 侧边钉住，不遮聊天主区
 * - Takeover 全屏，带遮罩，提示“电脑正在操作，请监督”
 * - 状态来自 loop (running/waiting/done/paused/job_pending)
 * - 可见度偏好存 agents.computer_visibility，默认 status
 */

import { useEffect, useState } from 'react';

export type ComputerVisibility = 'status' | 'preview' | 'takeover';

export interface ComputerVisibilityProps {
  agentId: number | null;
  loopStatus?: string | null;
  currentTool?: string | null;
  pageSummary?: string | null;
  visibility?: ComputerVisibility;
  onChange?: (v: ComputerVisibility) => void;
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
};

export function ComputerVisibility({
  agentId,
  loopStatus,
  currentTool,
  pageSummary,
  visibility: propVisibility,
  onChange,
  children,
}: ComputerVisibilityProps) {
  const [visibility, setVisibility] = useState<ComputerVisibility>(propVisibility ?? 'status');

  useEffect(() => {
    if (propVisibility) setVisibility(propVisibility);
  }, [propVisibility]);

  const set = (v: ComputerVisibility) => {
    setVisibility(v);
    onChange?.(v);
    // 持久化到后端（fire-and-forget）
    if (agentId) {
      try {
        const token = localStorage.getItem('token') ?? '';
        fetch(`/api/agents/${agentId}/visibility`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: token ? `Bearer ${token}` : '',
          },
          body: JSON.stringify({ visibility: v }),
        }).catch(() => {});
      } catch {}
    }
  };

  const statusText = loopStatus ? (STATUS_LABEL[loopStatus] ?? loopStatus) : '空闲';

  // Status：默认收起，只显示芯片
  if (visibility === 'status') {
    return (
      <div className="computerVisibility computerVisibility--status">
        <div className="computerVisibility__bar">
          <span className="chip">{statusText}</span>
          {currentTool && <span className="small">· {currentTool}</span>}
          <span className="computerVisibility__actions">
            <button type="button" className="btn btn--small" onClick={() => set('preview')} title="侧边钉住预览">
              预览
            </button>
            <button type="button" className="btn btn--small btn--primary" onClick={() => set('takeover')} title="全屏接管，监督电脑">
              接管
            </button>
          </span>
        </div>
      </div>
    );
  }

  // Preview：侧边钉住
  if (visibility === 'preview') {
    return (
      <div className="computerVisibility computerVisibility--preview">
        <div className="computerVisibility__bar">
          <span className="chip chip--on">{statusText}</span>
          <span className="small">{currentTool ? `正在：${currentTool}` : '电脑在后台运行'}</span>
          <span className="computerVisibility__actions">
            <button type="button" className="btn btn--small" onClick={() => set('status')} title="收起为状态">
              收起
            </button>
            <button type="button" className="btn btn--small btn--primary" onClick={() => set('takeover')}>
              接管
            </button>
          </span>
        </div>
        <div className="computerVisibility__preview">
          {pageSummary ? <div className="small">{pageSummary.slice(0, 200)}</div> : <div className="small">（暂无页面摘要）</div>}
          {children && <div className="computerVisibility__previewBrowser">{children}</div>}
        </div>
      </div>
    );
  }

  // Takeover：全屏接管，用户被迫监督
  return (
    <div className="computerVisibility computerVisibility--takeover">
      <div className="computerVisibility__takeoverMask">
        <div className="computerVisibility__takeoverHeader">
          <span className="chip chip--on">⚠️ 接管模式 — 请监督电脑操作</span>
          <span className="small">电脑越显眼，用户越被迫去监督它（Grok）</span>
          <span className="computerVisibility__actions">
            <button type="button" className="btn btn--small" onClick={() => set('preview')}>
              退到预览
            </button>
            <button type="button" className="btn btn--small" onClick={() => set('status')}>
              收起
            </button>
          </span>
        </div>
        <div className="computerVisibility__takeoverBody">
          <div className="computerVisibility__takeoverInfo">
            <div>状态：{statusText}</div>
            {currentTool && <div>当前：{currentTool}</div>}
            {pageSummary && <div className="small">页面：{pageSummary.slice(0, 300)}</div>}
          </div>
          <div className="computerVisibility__takeoverBrowser">{children}</div>
        </div>
      </div>
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
