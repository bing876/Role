import type { MemoryItem } from '@ai-workbench/shared';

/**
 * 产品交互规格 C4（2026-09-25）：记忆**要确认才生效,但确认在对话流里,不弹抽屉**。
 *
 * 待确认记忆（decision/fact,服务端 memories 表 pending 态）在**会话流里**渲染成确认卡：
 * - 「确认，生效」→ 真 POST /memories/confirm → 进 memories 真表,卡消失;
 * - 「不用」→ 真 POST /memories/reject → 卡消失;
 * - 旧的侧栏「待确认（N）」面板（抽屉式确认路径）已随 C4 移除。
 *
 * 确认动作（confirm/reject）由组合层注入（useMemory 的函数,跨 feature 协调点在 App）。
 */
export function MemoryConfirmCard({
  item,
  onConfirm,
  onReject,
}: {
  item: MemoryItem;
  onConfirm: (id: number) => void;
  onReject: (id: number) => void;
}) {
  const kind = item.type === 'decision' ? '决定' : item.type === 'fact' ? '事实' : '偏好';
  return (
    <div className="memConfirmCard" data-mem-id={item.id}>
      <div className="memConfirmCard__head">
        <span className="memConfirmCard__kind">记忆·{kind}</span>
        <span className="memConfirmCard__note">待确认 · 你点头才生效</span>
      </div>
      <div className="memConfirmCard__content">{item.content}</div>
      <div className="memConfirmCard__actions">
        <button type="button" className="memConfirmCard__btn memConfirmCard__btn--go" onClick={() => onConfirm(item.id)}>
          确认，生效
        </button>
        <button type="button" className="memConfirmCard__btn" onClick={() => onReject(item.id)}>
          不用
        </button>
      </div>
    </div>
  );
}
