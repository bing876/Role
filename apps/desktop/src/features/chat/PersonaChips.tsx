import { useState } from 'react';

/**
 * 产品交互规格 C1（2026-09-25）：三问 = **输入框上方一行 chips**（替代旧 AgentGuide 大表格）。
 *
 * 规格原话：可点 / 可自己写 / 可跳过；打字 / 跳过 / 答完即消失。
 *  - 每个问题 = 一个 chip 组：快速选项（可点）+「✎ 自己写」（内联输入框）；
 *  - 「跳过」= 按当前值收尾（没改过的字段保持默认人设）；
 *  - 全部答完 → 自动收尾；
 *  - 用户开始打字 → 父组件（主输入框 onChange）直接收尾，本组件不管。
 *
 * 受控：当前值与「动过没有」都由 App 持有（`draft`/`touched`），本组件只报事件：
 *  - onField(k, v)：某个问题被答（App 更新 draft + touched）；
 *  - onComplete(final)：全答完（App 落库并收起）；
 *  - onSkip()：跳过（App 按当前值落库并收起）。
 * 落库统一走 App 的 savePersona（POST /agents/:id/persona，跨 feature 协调点在组合层）。
 */
export interface PersonaChipsDraft {
  agentId: number;
  /** persona.name（＝左栏真名字）；占位名时可被改名 chip 改 */
  name: string;
  /** ＋添加 路径的占位名（「新智能体」）→ 多一个改名 chip；对话式「创建 XXX」没有 */
  nameIsPlaceholder: boolean;
  who: string;
  tone: string;
  duty: string;
  /** G2：不干什么（anti-jobs）—— 标准栏，可选填 */
  antiJobs: string;
}

export type PersonaField = 'name' | 'who' | 'tone' | 'duty' | 'antiJobs';

/** 快速选项：显示文案与提交值分开（「就按原话的」提交的是当前值,不是按钮文案） */
interface ChipOption {
  label: string;
  value: string;
}

const WHO_OPTIONS = ['一个深耕这行的专业老手', '一个贴心细致的搭档'];
const TONE_OPTIONS = ['短句、直接', '温和、细致'];
/** G2：「不干什么」快速选项（anti-jobs 标准栏，可选） */
const ANTIBOARDS_OPTIONS = ['不碰敏感操作（花钱/删除/对外发）', '不抢别的专员更擅长的活'];

export function PersonaChips({
  draft,
  touched,
  onField,
  onComplete,
  onSkip,
}: {
  /** 当前值（含已答的部分） */
  draft: PersonaChipsDraft;
  /** 哪些问题被用户动过（答过） */
  touched: Partial<Record<PersonaField, boolean>>;
  onField: (k: PersonaField, v: string) => void;
  onComplete: (final: PersonaChipsDraft) => void;
  onSkip: () => void;
}) {
  const [editing, setEditing] = useState<PersonaField | null>(null);
  const [editVal, setEditVal] = useState('');

  const required: PersonaField[] = draft.nameIsPlaceholder ? ['name', 'who', 'tone', 'duty'] : ['who', 'tone', 'duty'];
  const isAnswered = (k: PersonaField): boolean => Boolean(touched[k]);

  const commit = (k: PersonaField, v: string): void => {
    const clean = v.trim();
    if (!clean) return;
    const next: PersonaChipsDraft = { ...draft, [k]: clean };
    onField(k, clean);
    setEditing(null);
    setEditVal('');
    const all = required.every((f) => f === k ? true : Boolean(touched[f]));
    if (all) onComplete(next);
  };

  const startEdit = (k: PersonaField): void => {
    setEditing(k);
    setEditVal(isAnswered(k) ? draft[k] : '');
  };

  const question = (label: string, k: PersonaField, options: ChipOption[]): JSX.Element => (
    <span className="personaChips__q" key={k}>
      <span className="personaChips__ql">{label}</span>
      {isAnswered(k) ? (
        <button
          type="button"
          className="personaChips__chip personaChips__chip--done"
          title="点一下可以改"
          onClick={() => startEdit(k)}
        >
          ✓ {draft[k]}
        </button>
      ) : (
        <>
          {options.map((o) => (
            <button type="button" key={o.label} className="personaChips__chip" onClick={() => commit(k, o.value)}>
              {o.label}
            </button>
          ))}
          {editing === k ? (
            <input
              className="personaChips__input"
              autoFocus
              value={editVal}
              maxLength={120}
              placeholder={`${label}：自己写…`}
              onChange={(e) => setEditVal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit(k, editVal);
                else if (e.key === 'Escape') {
                  setEditing(null);
                  setEditVal('');
                }
              }}
              onBlur={() => commit(k, editVal)}
            />
          ) : (
            <button type="button" className="personaChips__chip personaChips__chip--write" onClick={() => startEdit(k)}>
              ✎ 自己写
            </button>
          )}
        </>
      )}
    </span>
  );

  return (
    <div className="personaChips" data-agent-id={draft.agentId}>
      <span className="personaChips__label">给「{draft.name}」定个样子：</span>
      {draft.nameIsPlaceholder && question('叫什么', 'name', [])}
      {question('它是谁', 'who', WHO_OPTIONS.map((o) => ({ label: o, value: o })))}
      {question('怎么说话', 'tone', TONE_OPTIONS.map((o) => ({ label: o, value: o })))}
      {question('干什么', 'duty', draft.duty ? [{ label: `就按「${draft.duty.slice(0, 10)}${draft.duty.length > 10 ? '…' : ''}」`, value: draft.duty }] : [])}
      {question('不干什么', 'antiJobs', ANTIBOARDS_OPTIONS.map((o) => ({ label: o, value: o })))}
      <button type="button" className="personaChips__skip" onClick={onSkip} title="不折腾了,按默认来">
        跳过
      </button>
    </div>
  );
}
