import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentChannelMessage,
  AgentChannelSummary,
  ChannelListResult,
  ChannelMessagesResult,
  DelegationListResult,
  DelegationStatus,
  DelegationView,
} from '@ai-workbench/shared';
import './styles.css';

/**
 * 多智能体编排 · **内部频道**面板（只读）。
 *
 * 用户要求 2 的后半句是「这个交流过程**用户可以查看**」。服务端只给了接口，
 * 界面上读不到就等于没做完 —— 所以这一块补上。
 *
 * ★ 三条约束（改之前先读）：
 *   1. **只读**。这里没有任何「替智能体发消息 / 改委派状态」的入口。
 *      内部频道是智能体之间的交流，用户是**读者**；要插手就回聊天区自己下指令。
 *      （服务端那边也只有 GET，没有写接口 —— 前后端一致，不是一边拦一边放。）
 *   2. **不回显任何写操作的可能性**：没有输入框、没有提交按钮。
 *      与 `browser/HelpCard.tsx` 那条安全红线同一个道理：一旦界面上出现输入框，
 *      就等于给「绕开服务端闸门」开了个口子。
 *   3. 正文在服务端是密文，这里拿到的是**已解密的明文** —— 所以这个面板只能在
 *      已登录态下渲染，token 由 App 传进来，组件自己不碰 localStorage。
 *
 * ★ 为什么单开一个目录而不是塞进 App.tsx：
 *   App.tsx 已经 3300+ 行。`browser/` 那套的先例写得很清楚 ——
 *   「以后要改浏览器相关的东西，只改这个目录，不要再往 App.tsx 里堆」。
 *   这里照做：App.tsx 只负责挂 `<ChannelsPanel …/>` + 一个开关按钮。
 */

/** 委派状态 → 人话 + 色调。超时/失败要一眼看得出来，不能和「办成了」一个颜色。 */
const STATUS_LABEL: Record<DelegationStatus, { text: string; tone: 'ok' | 'wait' | 'bad' | 'mute' }> = {
  pending: { text: '排队中', tone: 'wait' },
  running: { text: '进行中', tone: 'wait' },
  done: { text: '已完成', tone: 'ok' },
  failed: { text: '失败', tone: 'bad' },
  timeout: { text: '超时未完成', tone: 'bad' },
  need_user: { text: '等你拍板', tone: 'wait' },
  rejected: { text: '被拒绝', tone: 'mute' },
};

const KIND_LABEL: Record<AgentChannelMessage['kind'], string> = {
  task: '派活',
  progress: '过程',
  reply: '交活',
  system: '系统',
};

export interface ChannelsPanelProps {
  /** 服务端地址（App 传，组件不自己算） */
  apiBase: string;
  /** 已登录的 JWT（App 传，组件不碰 localStorage） */
  token: string;
  onClose: () => void;
}

export function ChannelsPanel({ apiBase, token, onClose }: ChannelsPanelProps): JSX.Element {
  const [channels, setChannels] = useState<AgentChannelSummary[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [messages, setMessages] = useState<AgentChannelMessage[]>([]);
  const [delegations, setDelegations] = useState<DelegationView[]>([]);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  /** 切号期间晚到的响应要丢掉（与 App.tsx 里既有的做法一致） */
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const get = useCallback(
    async <T,>(path: string): Promise<T> => {
      const res = await fetch(`${apiBase}${path}`, {
        headers: { authorization: `Bearer ${tokenRef.current}` },
      });
      const data = (await res.json().catch(() => ({}))) as T & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      return data;
    },
    [apiBase],
  );

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const r = await get<ChannelListResult>('/agents/channels');
      if (tokenRef.current !== token) return;
      setChannels(r.channels);
      setErr('');
      // 第一次进来自动选最近有动静的一条（列表本来就是按 last_message_at 倒序）
      setActiveId((cur) => cur ?? r.channels[0]?.id ?? null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [get, token]);

  const loadChannel = useCallback(
    async (id: number) => {
      try {
        const [m, d] = await Promise.all([
          get<ChannelMessagesResult>(`/agents/channels/${id}/messages?limit=100`),
          get<DelegationListResult>(`/agents/channels/${id}/delegations?limit=20`),
        ]);
        if (tokenRef.current !== token) return;
        setMessages(m.messages);
        setDelegations(d.delegations);
        setErr('');
      } catch (e) {
        setErr((e as Error).message);
      }
    },
    [get, token],
  );

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (activeId === null) {
      setMessages([]);
      setDelegations([]);
      return;
    }
    void loadChannel(activeId);
  }, [activeId, loadChannel]);

  /**
   * 有「进行中」的委派时**自动刷新**。
   *
   * ★ 为什么不无脑定时轮询：没有活儿时刷新只是白烧请求。
   *   只在列表里真的有 pending/running 时才开一个 5 秒的轮子，全办完了就停。
   */
  useEffect(() => {
    const busy = channels.some((c) => c.liveStatus === 'pending' || c.liveStatus === 'running');
    if (!busy) return;
    const t = setInterval(() => {
      void loadList();
      if (activeId !== null) void loadChannel(activeId);
    }, 5_000);
    return () => clearInterval(t);
  }, [channels, activeId, loadList, loadChannel]);

  const active = channels.find((c) => c.id === activeId) ?? null;

  return (
    <div className="channelsPanel">
      <div className="channelsPanel__head">
        <div>
          <b>内部频道</b>
          <span className="channelsPanel__sub">智能体之间的委派与回复（只读）</span>
        </div>
        <div className="channelsPanel__acts">
          <button type="button" className="btn" onClick={() => void loadList()} disabled={loading}>
            刷新
          </button>
          <button type="button" className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>

      {err && <div className="channelsPanel__err">{err}</div>}

      <div className="channelsPanel__body">
        <div className="channelsPanel__list">
          {channels.length === 0 && !loading && (
            <div className="channelsPanel__empty">还没有频道。智能体之间发生过委派之后，这里就会出现。</div>
          )}
          {channels.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`channelsPanel__item ${c.id === activeId ? 'channelsPanel__item--on' : ''}`}
              onClick={() => setActiveId(c.id)}
            >
              <span className="channelsPanel__peer">
                {c.peerName}
                {c.liveStatus && (
                  <span className={`chip chip--${STATUS_LABEL[c.liveStatus].tone}`}>
                    {STATUS_LABEL[c.liveStatus].text}
                  </span>
                )}
              </span>
              <span className="channelsPanel__preview">{c.lastPreview || '（还没有内容）'}</span>
              <span className="channelsPanel__meta">
                {c.messageCount} 条 · {fmtTime(c.lastAt)}
              </span>
            </button>
          ))}
        </div>

        <div className="channelsPanel__conv">
          {!active ? (
            <div className="channelsPanel__empty">左边选一条频道看对话。</div>
          ) : (
            <>
              <div className="channelsPanel__msgs">
                {messages.length === 0 && <div className="channelsPanel__empty">这条频道还没有消息。</div>}
                {messages.map((m) => (
                  <div key={m.id} className={`msg msg--${m.kind}`}>
                    <div className="msg__head">
                      <b>{m.fromName}</b>
                      <span className="msg__arrow">→ {m.toName}</span>
                      <span className="msg__kind">{KIND_LABEL[m.kind]}</span>
                      <span className="msg__at">{fmtTime(m.at)}</span>
                    </div>
                    <div className="msg__text">{m.text}</div>
                  </div>
                ))}
              </div>

              {delegations.length > 0 && (
                <div className="channelsPanel__dels">
                  <div className="channelsPanel__delsHead">这条频道上的委派</div>
                  {delegations.map((d) => {
                    const s = STATUS_LABEL[d.status];
                    return (
                      <div key={d.id} className={`del del--${s.tone}`}>
                        <div className="del__head">
                          <b>
                            {d.fromName} → {d.toName}
                          </b>
                          <span className={`chip chip--${s.tone}`}>{s.text}</span>
                          <span className="del__at">{fmtTime(d.createdAt)}</span>
                        </div>
                        <div className="del__task">{d.task}</div>
                        {d.summary && <div className="del__sum">结论：{d.summary}</div>}
                        {d.outline && d.outline.length > 0 && (
                          <ul className="del__outline">
                            {d.outline.map((o, i) => (
                              <li key={i}>{o}</li>
                            ))}
                          </ul>
                        )}
                        {/* 超时/失败要如实显示原因 —— 这是「不假装完成」那条要求在界面上的落点 */}
                        {d.error && <div className="del__err">原因：{d.error}</div>}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** 时间只画「时:分」，跨天才带日期（频道里同一天会有几十条，带日期只是噪音） */
function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
