import { useState } from 'react';
import type { AuthSession } from '@ai-workbench/shared';
import { API_BASE, TOKEN_KEY } from '../../shared/api';

/** 安装包空本地库的首次引导：明确由人设密码并记住 XYZ，绝不启用假短信或自动执行任务。 */
export function LocalFirstRun({ onSession }: { onSession: (s: AuthSession) => void }) {
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<AuthSession | null>(null);

  const create = async () => {
    setError('');
    if (password.length < 8 || password.length > 128 || password !== repeat) {
      setError('密码需要 8–128 位，且两次输入一致');
      return;
    }
    setBusy(true);
    try {
      const bridge = window.workbench;
      if (!bridge) throw new Error('本机引导仅在安装包中可用');
      const result = await bridge.createLocalAccount(password);
      setPassword('');
      setRepeat('');
      setCreated(result);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  const enter = () => {
    if (!created) return;
    localStorage.setItem(TOKEN_KEY, created.token);
    void window.workbench?.syncSession?.(API_BASE(), created.token);
    onSession(created);
  };

  return (
    <div className="authWrap authWrap--login">
      <div className="authCard">
        {created ? <>
          <h3>本机工作台已备好</h3>
          <p>本地数据库、默认项目和「小助」已创建。下次用这个 XYZ 号和刚设的密码登录：</p>
          <p><strong data-testid="local-xyz" style={{ letterSpacing: 1 }}>{created.user.xyz_id}</strong>（请记下来）</p>
          <p className="small">进入后展开「设置 → 模型设置」，填入自己的 DeepSeek API Key。没填时模型不会编造回复。</p>
          <button type="button" className="btn btn--go" onClick={enter}>我已记下，进入工作台</button>
        </> : <>
          <h3>第一次打开 · 建好本机工作台</h3>
          <p className="small">本地数据库已自动建立，不需要安装 PostgreSQL、Docker 或 Node。设置一个本机账号密码，下一步会显示你的 XYZ 登录号。</p>
          <input className="authInput" type="password" autoComplete="new-password" placeholder="本机密码（8–128 位）"
            value={password} onChange={(e) => setPassword(e.target.value)} />
          <input className="authInput" type="password" autoComplete="new-password" placeholder="再输入一次密码"
            value={repeat} onChange={(e) => setRepeat(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void create(); }} />
          <button type="button" className="btn btn--go" disabled={busy || password.length < 8 || password !== repeat} onClick={() => void create()}>
            {busy ? '正在创建…' : '建好并显示登录号'}
          </button>
          <p className="small">本机账户/模型密钥只存此设备；不会自动发送消息或调用外部模型。登录后按需配置 DeepSeek。</p>
        </>}
        {error && <div role="alert" className="authError">{error}</div>}
      </div>
    </div>
  );
}
