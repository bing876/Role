import { useEffect, useRef, useState } from 'react';
import { CONTACTS, type Contact } from './data/contacts';
import Rail from './components/Rail';
import Sidebar from './components/Sidebar';
import ChatArea from './components/ChatArea';
import InputBar from './components/InputBar';
import { ModalsRoot } from './components/Modals';
import type { ChatMessage } from './lib/storage';

const SB_DEFAULT = 250;            // 与 tokens.css --sb-w 默认值一致
const SB_MIN = 220;
const SB_MAX = 360;

export default function App() {
  const [activeContactId, setActiveContactId] = useState(CONTACTS[0].id);
  const [activeTab, setActiveTab] = useState<'msg' | 'contact' | 'fav' | 'file' | 'moments'>('msg');
  const [model, setModel] = useState('chatgpt');
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showQrLightbox, setShowQrLightbox] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Record<string, ChatMessage[]>>({});
  const [sidebarWidth, setSidebarWidth] = useState<number>(SB_DEFAULT);

  const activeContact: Contact =
    CONTACTS.find((c: Contact) => c.id === activeContactId) ?? CONTACTS[0];

  // ---------------------------------------- 持久化：刷新不丢消息
  // 首次挂载：从 localStorage 读回会话
  useEffect(() => {
    try {
      const raw = localStorage.getItem('workbench:sessions');
      if (raw) setSessions(JSON.parse(raw));
    } catch (_) { /* ignore */ }
  }, []);
  // 任意会话变化 → 写回（节流：300ms 一次，频繁流式不会频繁写）
  const saveTimer = useRef<number | null>(null);
  useEffect(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      try { localStorage.setItem('workbench:sessions', JSON.stringify(sessions)); } catch (_) {}
    }, 300);
    return () => { if (saveTimer.current) window.clearTimeout(saveTimer.current); };
  }, [sessions]);
  // 侧栏宽度持久化
  useEffect(() => {
    const raw = localStorage.getItem('workbench:sb-w');
    if (raw) {
      const v = Number(raw);
      if (v >= SB_MIN && v <= SB_MAX) setSidebarWidth(v);
    }
  }, []);
  useEffect(() => {
    try { localStorage.setItem('workbench:sb-w', String(sidebarWidth)); } catch (_) {}
  }, [sidebarWidth]);

  // ---------------------------------------- 流式输出
  // 找到「text 还没播完整」的 AI 消息，每 30ms 推进 1~2 字
  // 反证开关：?muted=true 时挂个 noop setInterval，验证测试能区分「流式真在跑」vs「挂了个空 setInterval」
const streamMuted =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('muted') === 'true';

useEffect(() => {
  if (streamMuted) return;
  const t = window.setInterval(() => {
      setSessions((prev) => {
        let changed = false;
        const next: Record<string, ChatMessage[]> = {};
        for (const sid in prev) {
          next[sid] = prev[sid].map((m) => {
            const full = m._fullText;
            if (full && m.sender === 'ai' && m.text.length < full.length) {
              changed = true;
              const step = full.length > 120 ? 3 : 1;
              const newLen = Math.min(full.length, m.text.length + step);
              return { ...m, text: full.slice(0, newLen) };
            }
            return m;
          });
        }
        return changed ? next : prev;
      });
    }, 30);
    return () => window.clearInterval(t);
  }, []);

  // ---------------------------------------- 演示模式（仅截图验证用）
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const demo = params.get('demo');
    if (!demo) return;
    const baseUser: ChatMessage = { id: 'demo-u', sender: 'user', text: '帮我绑定 OpenClaw 客户端' };
    if (demo === 'thinking') {
      setSessions({ 'contact-0': [baseUser, { id: 'demo-t', sender: 'ai', text: '', thinking: true }] });
    } else if (demo === 'qr') {
      const qr = makeQrDataUrl('workbuddy://bind-openclaw?agent=' + encodeURIComponent('我的助手'));
      setSessions({ 'contact-0': [baseUser, { id: 'demo-a', sender: 'ai', text: '请用微信扫描下方二维码绑定 OpenClaw 客户端：', qrDataUrl: qr }] });
    } else if (demo === 'stream') {
      // 流式输出演示：注入一条带 _fullText 的 AI 消息，看每帧递增
      const full = '好的，我正在为你生成 OpenClaw 绑定二维码。绑定流程一共 3 步：① 微信扫码 ② 授权 OpenClaw 客户端 ③ 在工作台确认收到设备列表。请稍等…';
      setSessions({ 'contact-0': [baseUser, { id: 'demo-s', sender: 'ai', text: '', _fullText: full }] });
    } else if (demo.startsWith('tab-')) {
      // tab 切换演示：?demo=tab-fav / tab-file / tab-moments
      const t = demo.slice(4);
      if (t === 'fav' || t === 'file' || t === 'moments') setActiveTab(t);
    }
  }, []);

  const messages = sessions[activeContactId] ?? [];

  // ---------------------------------------- 发送：用户消息 + CoT 思考态 + AI 回复（流式）
  const handleSend = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const now = Date.now();
    const userMsg: ChatMessage = { id: `u-${now}`, sender: 'user', text: trimmed };

    // 「我的助手」 + 提到 OpenClaw → 直接产出二维码卡片（占位，未走流式）
    if (activeContact.bindOpenclaw && /openclaw|绑定|qr|扫码/i.test(trimmed)) {
      const qr = makeQrDataUrl('workbuddy://bind-openclaw?agent=' + encodeURIComponent(activeContact.name));
      setSessions((prev) => ({
        ...prev,
        [activeContactId]: [
          ...(prev[activeContactId] ?? []),
          userMsg,
          { id: `t-${now}`, sender: 'ai', text: '', thinking: true },
        ],
      }));
      setTimeout(() => {
        setSessions((prev) => ({
          ...prev,
          [activeContactId]: (prev[activeContactId] ?? []).map((m) =>
            m.id === `t-${now}` ? { id: `a-${now}`, sender: 'ai', text: '请用微信扫描下方二维码绑定 OpenClaw 客户端：', qrDataUrl: qr } : m,
          ),
        }));
      }, 700);
      return;
    }

    // 普通 AI 回复：流式输出
    const full = `收到「${trimmed}」，这里是 ${activeContact.name} 的占位回复。下面是流式输出演示：abcdefghijklmnopqrstuvwxyz0123456789——共 60+ 字，每个 tick 推进 1~3 字，看打字机效果。`;
    setSessions((prev) => ({
      ...prev,
      [activeContactId]: [
        ...(prev[activeContactId] ?? []),
        userMsg,
        { id: `t-${now}`, sender: 'ai', text: '', thinking: true },
      ],
    }));
    setTimeout(() => {
      setSessions((prev) => ({
        ...prev,
        [activeContactId]: (prev[activeContactId] ?? []).map((m) =>
          m.id === `t-${now}` ? { id: `a-${now}`, sender: 'ai', text: '', _fullText: full } : m,
        ),
      }));
    }, 700);
  };

  // ---------------------------------------- splitter 拖动
  const dragRef = useRef<{startX: number; startW: number} | null>(null);
  const onSplitterDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startW: sidebarWidth };
  };
  const onSplitterMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const next = Math.max(SB_MIN, Math.min(SB_MAX, dragRef.current.startW + dx));
    setSidebarWidth(next);
  };
  const onSplitterUp = (e: React.PointerEvent) => {
    dragRef.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  };

  return (
    <div
      className="frame"
      role="application"
      aria-label="AI 工作台"
      style={{ ['--sb-w' as any]: `${sidebarWidth}px` }}
    >
      <div className="frame-internal-stroke" aria-hidden="true" />
      <section className="main-glass" aria-hidden="true" />
      <div className="user-bg-layer" id="userBgLayer" aria-hidden="true" />
      <div className="workbench-mat" aria-hidden="true" />

      {/* 第二列（联系人 / 收藏 / 文件 / 朋友圈随 activeTab 切换） */}
      <aside className="sidebar">
        <Sidebar
          contacts={CONTACTS}
          activeId={activeContactId}
          activeTab={activeTab}
          onSelect={setActiveContactId}
          onBindOpenclaw={(c) => {
            const qr = makeQrDataUrl('workbuddy://bind-openclaw?agent=' + encodeURIComponent(c.name));
            setActiveContactId(c.id);
            setSessions((prev) => {
              const list = prev[c.id] ?? [];
              if (list.some((m) => m.qrDataUrl)) return prev;
              return {
                ...prev,
                [c.id]: [
                  ...list,
                  { id: `a-${Date.now()}`, sender: 'ai', text: '请扫码绑定 OpenClaw 客户端：', qrDataUrl: qr },
                ],
              };
            });
          }}
        />
      </aside>

      {/* 分隔条 —— 可拖动 */}
      <div
        className="splitter"
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整侧栏宽度（双击复位）"
        tabIndex={0}
        onPointerDown={onSplitterDown}
        onPointerMove={onSplitterMove}
        onPointerUp={onSplitterUp}
        onPointerCancel={onSplitterUp}
        onDoubleClick={() => setSidebarWidth(SB_DEFAULT)}
        data-val={sidebarWidth}
      />

      {/* 第一列（rail） */}
      <Rail
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onHamburger={() => setShowSettings(true)}
        onQuickAdd={() => setShowCreateAgent(true)}
        avatarLetter="U"
        agents={CONTACTS.slice(1)}
      />

      {/* 第三列 */}
      <div className="main-area">
        <div className="top-area" aria-hidden="true" />
        <ChatArea messages={messages} onClickQr={(url) => setShowQrLightbox(url)} />
        <InputBar onSend={handleSend} model={model} onModelChange={setModel} />
      </div>

      <ModalsRoot
        showSettings={showSettings}
        onCloseSettings={() => setShowSettings(false)}
        showCreateAgent={showCreateAgent}
        onCloseCreateAgent={() => setShowCreateAgent(false)}
        onCreated={() => setShowCreateAgent(false)}
        qrLightbox={showQrLightbox}
        onCloseQr={() => setShowQrLightbox(null)}
      />
    </div>
  );
}

function makeQrDataUrl(payload: string): string {
  const QR = (window as unknown as { __qrcodeLazy?: (t: number, e: string) => any }).__qrcodeLazy;
  if (!QR) return '';
  try {
    const qr = QR(0, 'L');
    qr.addData(payload);
    qr.make();
    return qr.createDataURL(6, 0);
  } catch (_e) { return ''; }
}