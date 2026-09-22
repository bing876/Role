import { useEffect, useRef } from 'react';
import type { ChatMessage } from '../lib/storage';

interface Props {
  messages: ChatMessage[];
  onClickQr: (dataUrl: string) => void;
}

/** 第三列：AI 对话流
 *  - 包含 CoT「深度思考态」气泡（.message.ai.thinking 三点动画）
 *  - 包含 AI 二维码卡片（.ai-qr-card）+ 灯箱打开
 */
export default function ChatArea({ messages, onClickQr }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // 新消息进来自动滚到底
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [messages]);

  return (
    <>
      <div className="chat-area" id="chatArea" ref={ref}>
        {messages.map((m) => (
          <Bubble key={m.id} m={m} onClickQr={onClickQr} />
        ))}
      </div>

      {/* 滚动到底按钮（原型 Round 122） */}
      <button className="ai-scroll-btn" id="aiScrollBtn" aria-label="滚动到底部" type="button">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 9l6 6 6-6" />
        </svg>
        <span className="tpt" aria-hidden="true">
          <i /><i /><i />
        </span>
      </button>
    </>
  );
}

function Bubble({ m, onClickQr }: { m: ChatMessage; onClickQr: (s: string) => void }) {
  const isUser = m.sender === 'user';

  // 思考态（CoT「深度思考的框」）
  if (m.thinking) {
    return (
      <div className="message ai thinking">
        <div className="message-avatar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="9" />
          </svg>
        </div>
        <div className="message-bubble">
          {/* 三色跳动圆点 —— CoT 思考动画 */}
          <div className="ai-dots-thinking">
            <span className="dot" />
            <span className="dot" />
            <span className="dot" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`message ${isUser ? 'user' : 'ai'}`}>
      {!isUser && (
        <div className="message-avatar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="9" />
          </svg>
        </div>
      )}

      <div className="message-bubble">
        {m.text && <div className="bubble-text">{m.text}</div>}

        {/* AI 二维码卡片（Round 113 设计稿风格） */}
        {m.qrDataUrl && (
          <div
            className="ai-qr-card qr-bubble"
            onClick={() => onClickQr(m.qrDataUrl!)}
          >
            <img className="qr-image" src={m.qrDataUrl} alt="二维码" />
          </div>
        )}
      </div>
    </div>
  );
}