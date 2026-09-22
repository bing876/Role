import { useState } from 'react';
import { MODELS, MODEL_LABEL } from '../data/contacts';

interface Props {
  onSend: (text: string) => void;
  model: string;
  onModelChange: (m: string) => void;
}

/** 底部输入栏 + ＋弹层 + 模型切换弹层 + CL 额度环
 *  - 发送时 data-state=thinking → 停止方块
 *  - CL 环 running → token 内圈旋转
 */
export default function InputBar({ onSend, model, onModelChange }: Props) {
  const [text, setText] = useState('');
  const [state, setState] = useState<'empty' | 'typing' | 'thinking'>('empty');
  const [showAttach, setShowAttach] = useState(false);
  const [showModel, setShowModel] = useState(false);
  const [thinking, setThinking] = useState(false);

  const submit = () => {
    if (thinking) { setThinking(false); setState('empty'); return; }
    if (!text.trim()) return;
    onSend(text);
    setText('');
    setState('thinking');
    setThinking(true);
    // 与 App 里的 setTimeout 协同关闭（实际应监听 AI 完成的回调，简化为定时器）
    setTimeout(() => { setThinking(false); setState('empty'); }, 900);
  };

  return (
    <>
      <div className="inputbar" data-state={state}>
        {/* ＋ 附件按钮 */}
        <button
          className="inputbar-btn attach"
          data-act="attach"
          aria-label="附件 / 工具"
          type="button"
          onClick={() => setShowAttach((v) => !v)}
        >
          <span className="plus" />
        </button>

        {/* ＋ 弹层 */}
        <div className="attach-popup" style={{ display: showAttach ? 'block' : 'none' }}>
          <button className="item" type="button" onClick={() => { setShowAttach(false); alert('添加照片和文件（占位）'); }}>
            <span className="ico"><svg viewBox="0 0 24 24"><path d="M21.4 11.05l-9.2 9.2a5.5 5.5 0 1 1-7.78-7.78l8.49-8.49a3.5 3.5 0 1 1 4.95 4.95l-8.49 8.49a1.5 1.5 0 0 1-2.12-2.12l7.78-7.78" /></svg></span>
            <span className="txt"><span className="t">添加照片和文件</span><span className="d">从电脑上传</span></span>
          </button>
          <button className="item" type="button" onClick={() => { setShowAttach(false); alert('从资料库添加（占位）'); }}>
            <span className="ico"><svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" /><line x1="3" y1="13" x2="21" y2="13" /></svg></span>
            <span className="txt"><span className="t">从资料库添加</span><span className="d">浏览和搜索你的文件</span></span>
          </button>
          <button className="item" type="button" onClick={() => { setShowAttach(false); alert('创建图片（占位）'); }}>
            <span className="ico"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="11" r="1.5" /><path d="M3 17l5-5 4 4 3-3 6 6" /></svg></span>
            <span className="txt"><span className="t">创建图片</span><span className="d">可视化呈现任何内容</span></span>
          </button>
          <button className="item" type="button" onClick={() => { setShowAttach(false); alert('网页搜索（占位）'); }}>
            <span className="ico"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><line x1="3" y1="12" x2="21" y2="12" /></svg></span>
            <span className="txt"><span className="t">网页搜索</span><span className="d">查找实时新闻和信息</span></span>
          </button>
          <button className="item" type="button" onClick={() => { setShowAttach(false); alert('深度研究（占位）'); }}>
            <span className="ico"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.5" y2="16.5" /><path d="M8 11h6M11 8v6" /></svg></span>
            <span className="txt"><span className="t">深度研究</span><span className="d">获取详细报告</span></span>
          </button>
        </div>

        {/* 输入框 */}
        <input
          className="inputbar-field"
          type="text"
          placeholder="需要我做些什么"
          aria-label="输入消息"
          autoComplete="off"
          spellCheck={false}
          value={text}
          onChange={(e) => { setText(e.target.value); setState(e.target.value ? 'typing' : 'empty'); }}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        />

        {/* 语音按钮 */}
        <button className="inputbar-btn voice" data-act="voice" aria-label="语音输入" type="button">
          <svg className="voice-ico" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M12 17v4" />
            <path d="M6 11a6 6 0 0 0 12 0" />
          </svg>
        </button>

        {/* 发送 / 停止 */}
        <button
          className="inputbar-btn send"
          data-act="send"
          aria-label={thinking ? '停止' : '发送'}
          onClick={submit}
          type="button"
        >
          <svg className="send-sparkle" viewBox="640 15 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M652 17V37M647 23.25V30.75M662 24.5V29.5M642 24.5V29.5M657 20.75V33.25" />
          </svg>
          <svg className="send-stop" viewBox="0 0 24 24" fill="#FFFFFF">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        </button>
      </div>

      {/* CL 权益额度 + 插件位 + 模型弹层 */}
      <div className="token-outside">
        <button
          className="inputbar-btn token"
          data-act="token"
          data-state={thinking ? 'running' : 'idle'}
          data-quota="high"
          aria-label="CL 权益额度 / 切换模型"
          onClick={() => setShowModel((v) => !v)}
          type="button"
        >
          <svg className="tok-ring" viewBox="0 0 47 47" aria-hidden="true">
            <circle className="tok-track" cx="23.5" cy="23.5" r="21.5" />
            <circle className="tok-fill"  cx="23.5" cy="23.5" r="21.5" />
          </svg>
          <span className="tok-logo" data-model={model} aria-hidden="true" />
          <span className="tok-spinner" aria-hidden="true" />
        </button>

        <div className="model-popup" id="modelPopup" style={{ display: showModel ? 'block' : 'none' }}>
          <div className="mp-head">
            <span className="mp-title">切换模型</span>
          </div>
          <div className="mp-list">
            {MODELS.map((m) => (
              <button
                key={m}
                className="mp-item"
                onClick={() => { onModelChange(m); setShowModel(false); }}
                type="button"
                style={{ fontWeight: m === model ? 600 : 400 }}
              >
                {MODEL_LABEL[m] ?? m}
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}