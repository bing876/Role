import { useState } from 'react';
import type { Contact } from '../data/contacts';
import { avatarUrl } from '../lib/storage';

interface Props {
  contacts: Contact[];
  activeId: string;
  activeTab: 'msg' | 'contact' | 'fav' | 'file' | 'moments';
  onSelect: (id: string) => void;
  onBindOpenclaw: (c: Contact) => void;
}

/** 第二列：根据 activeTab 渲染不同视图（联系人 / 收藏 / 文件 / 朋友圈） */
export default function Sidebar({ contacts, activeId, activeTab, onSelect, onBindOpenclaw }: Props) {
  const [q, setQ] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const filtered = contacts.filter((c) => c.name.includes(q));

  // 收藏 / 文件 / 朋友圈是占位（原型未实现完整子视图）
  if (activeTab === 'fav')   return <TabPlaceholder title="收藏" hint="收藏的消息与文件会出现在这里" />;
  if (activeTab === 'file')   return <TabPlaceholder title="文件" hint="对话中收发的文件会出现在这里" />;
  if (activeTab === 'moments')return <TabPlaceholder title="朋友圈" hint="朋友圈功能开发中" />;

  return (
    <>
      <div className="search-pill search-component" data-state={q ? 'filled' : 'default'}>
        <span className="search-ico-v11" aria-hidden="true">
          <svg viewBox="0 0 18 18">
            <circle cx="7.4" cy="7.4" r="4.7" fill="none" stroke="rgba(255,255,255,0.58)" strokeWidth="1.8" />
            <path d="M10.9 10.9L15.2 15.2" fill="none" stroke="rgba(255,255,255,0.58)" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </span>
        <input
          className="search-field"
          type="text"
          value={q}
          autoComplete="off"
          spellCheck={false}
          placeholder="搜索"
          aria-label="搜索"
          onChange={(e) => setQ(e.target.value)}
        />
        {q && (
          <button className="search-clear" aria-label="清空搜索" onClick={() => setQ('')} type="button" />
        )}
      </div>

      <button
        className="add-btn"
        aria-label="新建"
        onClick={() => setShowAdd((v) => !v)}
        type="button"
      />

      <div className="add-popup" style={{ display: showAdd ? 'block' : 'none' }}>
        <div className="opt" onClick={() => { setShowAdd(false); alert('添加联系人（占位）'); }}>
          <span>添加联系人</span>
        </div>
        <div className="opt" onClick={() => { setShowAdd(false); window.dispatchEvent(new Event('wb:open-create-agent')); }}>
          <span>创建智能体</span>
        </div>
      </div>

      <div className="contact-list" id="contactList">
        {filtered.map((c) => (
          <div
            key={c.id}
            className={`contact-item ${c.id === activeId ? 'active' : ''}`}
            onClick={() => onSelect(c.id)}
          >
            {avatarUrl(c) ? (
              <img className="contact-av" src={avatarUrl(c)} alt={c.name} />
            ) : (
              <span
                className="contact-av has-photo"
                style={{ background: `linear-gradient(135deg, ${c.c1}, ${c.c2})` }}
                aria-hidden="true"
              >
                {c.name.charAt(0)}
              </span>
            )}
            <div className="contact-text">
              <div className="contact-name">{c.name}</div>
              <div className="contact-preview">{c.preview}</div>
            </div>
            <div className="contact-time">{c.time}</div>

            {c.bindOpenclaw && (
              <span
                className="contact-qr-wrap"
                onClick={(e) => { e.stopPropagation(); onBindOpenclaw(c); }}
                title="扫码绑定 OpenClaw 客户端"
              >
                <span className="contact-qr" aria-label="生成 OpenClaw 绑定二维码">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="3" width="7" height="7" />
                    <rect x="14" y="3" width="7" height="7" />
                    <rect x="3" y="14" width="7" height="7" />
                    <line x1="14" y1="14" x2="21" y2="14" />
                    <line x1="14" y1="21" x2="21" y2="21" />
                    <line x1="14" y1="14" x2="14" y2="21" />
                    <line x1="21" y1="14" x2="21" y2="21" />
                  </svg>
                </span>
              </span>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function TabPlaceholder({ title, hint }: { title: string; hint: string }) {
  return (
    <div style={{
      padding: '60px 24px',
      color: 'rgba(255,255,255,0.4)',
      fontSize: 13,
      textAlign: 'center',
    }}>
      <div style={{ fontSize: 18, color: 'rgba(255,255,255,0.7)', marginBottom: 8, fontWeight: 600 }}>{title}</div>
      <div>{hint}</div>
    </div>
  );
}