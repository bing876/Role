import { useState } from 'react';

/**
 * 产品交互规格 C3（2026-09-25）：**协同进对话流（折叠）**。
 *
 * 服务端（collabChat.ts / chiefOfStaff.ts）把委派往来直接写进相关智能体的主会话，
 * 消息以【协同·派单/接单/交回/进展/系统/路由】开头。这里把这类消息渲染成**折叠卡**：
 * - 默认收起 = 一行摘要（种类 + 一句话）—— 不占注意力、不给用户增加管理动作；
 * - 点开看全文（谁→谁、任务/结果、ID、状态）；
 * - 没有独立的协同抽屉 / 仪表盘 / 指派板（C3 红线）。
 *
 * 纯展示组件：是否协同消息由文本前缀判定（与服务端 buildCollabText 的前缀契约对齐）。
 */
export function isCollabMessage(text: string): boolean {
  return text.startsWith('【协同·');
}

/** 取协同种类（派单 / 接单 / 交回 / 进展 / 系统 / 路由 …） */
export function collabKind(text: string): string {
  const m = /^【协同·([^】]+)】/.exec(text);
  return m ? m[1] : '协同';
}

/** 前缀之后的正文（from → to：…） */
export function collabBody(text: string): string {
  return text.replace(/^【协同·[^】]+】\s*/, '');
}

export function CollabCard({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const kind = collabKind(text);
  const body = collabBody(text);
  const clipped = body.length > 48 ? `${body.slice(0, 48)}…` : body;
  return (
    <div className={open ? 'collabCard collabCard--open' : 'collabCard'}>
      <button
        type="button"
        className="collabCard__head"
        aria-expanded={open}
        title={open ? '点击收起' : '点击展开看全文'}
        onClick={() => setOpen(!open)}
      >
        <span className="collabCard__kind">协同·{kind}</span>
        <span className="collabCard__line">{clipped}</span>
        <span className="collabCard__toggle">{open ? '收起' : '展开'}</span>
      </button>
      {open && <div className="collabCard__body">{body}</div>}
    </div>
  );
}
