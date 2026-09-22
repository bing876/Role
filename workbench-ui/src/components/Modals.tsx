import { useEffect, useState } from 'react';

interface Props {
  showSettings: boolean;
  onCloseSettings: () => void;
  showCreateAgent: boolean;
  onCloseCreateAgent: () => void;
  onCreated: () => void;
  qrLightbox: string | null;
  onCloseQr: () => void;
}

/** 三个模态根节点：设置 / 创建智能体 / 二维码灯箱 */
export function ModalsRoot({ showSettings, onCloseSettings, showCreateAgent, onCloseCreateAgent, onCreated, qrLightbox, onCloseQr }: Props) {
  // App 内点击 ＋ 弹层「创建智能体」事件桥接
  useEffect(() => {
    const open = () => onCreated(); // 由 App 内部状态管理，这里用占位
    window.addEventListener('wb:open-create-agent', open);
    return () => window.removeEventListener('wb:open-create-agent', open);
  }, [onCreated]);

  return (
    <>
      {/* 创建智能体 */}
      {showCreateAgent && <CreateAgentModal onClose={onCloseCreateAgent} onCreated={onCreated} />}

      {/* 设置 */}
      {showSettings && <SettingsModal onClose={onCloseSettings} />}

      {/* 二维码灯箱（点击放大扫码） */}
      {qrLightbox && (
        <div className="qr-lightbox open" onClick={onCloseQr}>
          <img src={qrLightbox} alt="二维码大图" />
        </div>
      )}
    </>
  );
}

function CreateAgentModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [model, setModel] = useState('chatgpt');
  return (
    <div className="config-modal" role="dialog" aria-modal="true" aria-label="创建智能体">
      <div className="config-backdrop" onClick={onClose} />
      <div className="config-card">
        <h3>创建智能体</h3>
        <p className="sub">默认已配置好，可直接创建</p>
        <div className="config-field">
          <label>名称</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="智能体名称" />
        </div>
        <div className="config-field">
          <label>模型</label>
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="chatgpt">ChatGPT</option>
            <option value="claude">Claude</option>
            <option value="deepseek">DeepSeek</option>
            <option value="kimi">Kimi</option>
          </select>
        </div>
        <div className="config-field">
          <label>提示词</label>
          <textarea placeholder="描述智能体的角色与行为" />
        </div>
        <div className="config-actions">
          <button className="config-cancel" onClick={onClose} type="button">取消</button>
          <button className="config-create" onClick={onCreated} type="button">创建</button>
        </div>
      </div>
    </div>
  );
}

function SettingsModal({ onClose }: { onClose: () => void }) {
  const [pane, setPane] = useState<'general' | 'bg'>('general');
  const [bgUrl, setBgUrl] = useState<string | null>(null);

  return (
    <div className="settings-modal" role="dialog" aria-modal="true">
      <div className="settings-backdrop" onClick={onClose} />
      <div className="settings-card">
        <button className="settings-close" onClick={onClose} type="button" aria-label="关闭" />
        <nav className="settings-nav" aria-label="设置分类">
          <button
            className={`settings-nav-item ${pane === 'general' ? 'active' : ''}`}
            onClick={() => setPane('general')}
            type="button"
          >通用设置</button>
          <button
            className={`settings-nav-item ${pane === 'bg' ? 'active' : ''}`}
            onClick={() => setPane('bg')}
            type="button"
          >背景样式</button>
        </nav>
        <div className="settings-body">
          {pane === 'general' && (
            <section className="settings-pane active">
              <h4>通用设置</h4>
              <p className="settings-hint">暂无可配置项。</p>
            </section>
          )}
          {pane === 'bg' && (
            <section className="settings-pane active">
              <h4>背景样式</h4>
              <p className="settings-hint">上传图片作为工作台底部的自定义背景图层。</p>
              <div className="settings-actions">
                <button
                  className="settings-btn"
                  onClick={() => {
                    const input = document.createElement('input');
                    input.type = 'file';
                    input.accept = 'image/*';
                    input.onchange = () => {
                      const f = input.files?.[0]; if (!f) return;
                      setBgUrl(URL.createObjectURL(f));
                    };
                    input.click();
                  }}
                  type="button"
                >上传背景图片</button>
                {bgUrl && (
                  <button className="settings-btn ghost" onClick={() => setBgUrl(null)} type="button">恢复默认</button>
                )}
              </div>
              {bgUrl && (
                <div className="settings-preview">
                  <img src={bgUrl} alt="背景预览" style={{ width: '100%', borderRadius: 8 }} />
                </div>
              )}
              <p className="settings-status">{bgUrl ? '已应用' : ''}</p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}