import { useState } from 'react';
import type { AgentPersona, AgentView } from '@ai-workbench/shared';

/**
 * 批次 M-8' · 逻辑收尾：新智能体的「引导表」从 App.tsx **逐字搬入** features/chat。
 *
 * 它是聊天流里的第一张卡（新智能体 personaStatus=pending 时摆在会话里）；
 * 确认 = 调宿主注入的 onSave（App 的 savePersona 是跨 feature 协调点，留组合层）。
 * 正文一个字节没改（四行表格 + 确认/删除两钮 + 服务端人话回显）。
 */
/**
 * 第 15 步：聊天里的「引导表」。
 *
 * 用户点「添加」后，**新会话里先摆这张表**（不是先弹一个独立设置窗、更不是后台配置页）：
 * 四行简单表格——名称 / 它是谁 / 怎么说话 / 干什么，加一个确认按钮。
 * 确认 → 服务端存人设 → personaStatus 变 ready，这个智能体才按这份描述干活；
 * 没填完也可以先留着这个会话（服务端这时只让模型引导用户填表，不空人设乱聊）。
 */
export function AgentGuide({
  agent,
  onSave,
  onDelete,
}: {
  agent: AgentView;
  onSave: (p: AgentPersona) => Promise<void>;
  onDelete: () => void;
}) {
  const [name, setName] = useState(agent.persona?.name ?? '');
  const [who, setWho] = useState(agent.persona?.who ?? '');
  const [tone, setTone] = useState(agent.persona?.tone ?? '');
  const [duty, setDuty] = useState(agent.persona?.duty ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const rows: Array<{ label: string; value: string; ph: string; set: (v: string) => void; max: number }> = [
    { label: '名称', value: name, ph: '它叫什么？', set: setName, max: 24 },
    { label: '它是谁', value: who, ph: '例如：一个只懂电商运营的老手', set: setWho, max: 120 },
    { label: '怎么说话', value: tone, ph: '例如：短句、直接、别客套', set: setTone, max: 120 },
    { label: '干什么', value: duty, ph: '例如：帮我盯店铺数据、写商品标题', set: setDuty, max: 120 },
  ];

  const submit = async () => {
    if (!name.trim() || busy) return;
    setErr('');
    setBusy(true);
    try {
      await onSave({ name: name.trim(), who: who.trim(), tone: tone.trim(), duty: duty.trim() });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="guide">
      <div className="guide__head">先给这个智能体定个样子</div>
      <div className="small">填完点确认，它才按这份描述干活；没填完也能先留着这个会话。</div>
      <table className="guide__table">
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <th>{r.label}</th>
              <td>
                <input
                  className="guide__input"
                  value={r.value}
                  placeholder={r.ph}
                  maxLength={r.max}
                  onChange={(e) => r.set(e.target.value)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="buttons-row">
        <button type="button" className="btn btn--go guide__ok" disabled={busy || !name.trim()} onClick={() => void submit()}>
          {busy ? '保存中…' : '确认，就按这个来'}
        </button>
        <button type="button" className="btn guide__del" onClick={onDelete}>
          删掉这个智能体
        </button>
      </div>
      {err && <div className="authErr">{err}</div>}
    </div>
  );
}
