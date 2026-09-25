import { useEffect, useState } from 'react';
import type { AuthSession } from '@ai-workbench/shared';
import { API_BASE, TOKEN_KEY, authFetchJson } from '../../shared/api';

/**
 * 批次 M-8' · 逻辑收尾：登录页整块从 App.tsx **逐字搬入** features/auth。
 *
 * 阶段 1① 第 5 片把**会话逻辑**（静默登录 / 改密码 / 登出）搬进了 useAuth，
 * 但登录页组件本身**带 JSX**，按当时「JSX 一行不许动」的纪律留在 App.tsx；
 * 阶段 2 允许动结构了，M8' 把它收进本 feature（对外只经 index.ts）。
 * 正文一个字节没改（13 个 state / 后端自愈探测 / mock 验证码 / ⚡ 快捷登录）。
 */
type AuthTab = 'sms' | 'xyz' | 'wechat';

export function AuthScreen({ onSession }: { onSession: (s: AuthSession) => void }) {
  const [tab, setTab] = useState<AuthTab>('sms');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [xyz, setXyz] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [hint, setHint] = useState('');
  const [busy, setBusy] = useState(false);
  /** 获取验证码后的 60 秒冷却（和服务端 60 秒防连发对齐） */
  const [cooldown, setCooldown] = useState(0);
  /** 后端就绪状态：checking 首次探测 / waiting 正在自愈 / ready 可用 */
  const [backend, setBackend] = useState<'checking' | 'waiting' | 'ready'>('checking');
  /** 已经等了多久（秒），给用户一个"在动"的反馈 */
  const [waited, setWaited] = useState(0);
  /** 自增即可重新触发下面的探测 effect（请求失败时用它"重新排队等后端"） */
  const [probeKey, setProbeKey] = useState(0);
  /** mock 模式下的验证码（应用自己拉起的服务端，用户看不到任何窗口 —— 由主进程转过来） */
  const [mockCode, setMockCode] = useState<{ masked: string; code: string } | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  /**
   * ★★ 等后端自己就绪（2026-09-20 补，修的就是"明明在自愈、界面却甩红字"）。
   *
   * 背景：应用启动时会在后台**自己拉起 PostgreSQL + 服务端**（见 server-supervisor）。
   * 冷启动最坏要 ~40 秒（PG 崩溃恢复 + 建表重试）。而登录页原来一发现 fetch 失败
   * 就写死一句「连不上后端 … 再重试」，**而且不会自己重试** ——
   * 用户看到的是一句吓人的红字，其实后端半分钟后就自己好了。
   * 这就是"功能明明修好了、用户却还是进不去"的真正来源：**报错报早了，且不撤销**。
   *
   * 现在：不通就每 2 秒自己重探，期间只显示"正在准备"，探到就**自动把红字撤掉**继续。
   * 探测口径与主进程一致：认 `/health` 的 `service` 标识，不认"有东西回 200"。
   */
  useEffect(() => {
    let off = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const r = await fetch(`${API_BASE()}/health`, { signal: AbortSignal.timeout(2500) });
        const j = (await r.json()) as { service?: string };
        if (off) return;
        if (j?.service === 'ai-workbench-server') {
          setBackend('ready');
          setErr('');   // ★ 后端自己好了 → 必须把之前那句红字撤掉，否则用户以为还坏着
          setWaited(0);
          return;
        }
      } catch {
        /* 还没起来，继续等 */
      }
      if (off) return;
      setBackend('waiting');
      setWaited((w) => w + 2);
      timer = window.setTimeout(() => void tick(), 2000);
    };
    void tick();
    return () => { off = true; if (timer) window.clearTimeout(timer); };
  }, [probeKey]);

  /** 主进程转来的 mock 验证码（只有应用自己拉起服务端时才会有） */
  useEffect(() => {
    const off = window.workbench?.onSmsMockCode?.((info) => {
      setMockCode(info);
      setCode(info.code);
    });
    return () => { off?.(); };
  }, []);

  const smsCodeSent = async () => {
    setErr('');
    setHint('');
    setBusy(true);
    try {
      await authFetchJson('/auth/sms/send', { method: 'POST', body: JSON.stringify({ phone: phone.trim() }) });
      setCooldown(60);
      setHint(
        '验证码已发送（开发模式不发真短信）。'
        + '下面会直接显示 6 位码；万一没显示，说明服务端是你手动起的 —— '
        + '去「AI工作台-服务端」窗口找 [sms:mock] 那行。',
      );
    } catch (e) {
      // 429 是限流（服务端每分钟每个 IP 有上限）——直接说清楚，别让用户以为是自己输错了。
      const msg = (e as Error).message;
      // 连不上 = 后端还在自愈 → 不甩红字，改成"重新排队等后端"（见上面的探测 effect）
      if (msg.includes('连不上后端')) { setProbeKey((k) => k + 1); }
      else setErr(msg.includes('太频繁') ? `${msg}（这是防刷限制，等一会儿再点就好，不是你的手机号有问题）` : msg);
    } finally {
      setBusy(false);
    }
  };

  const login = async (path: string, body: Record<string, string>) => {
    setErr('');
    setHint('');
    setBusy(true);
    try {
      const sess = await authFetchJson<AuthSession>(path, { method: 'POST', body: JSON.stringify(body) });
      localStorage.setItem(TOKEN_KEY, sess.token);
      /**
       * ★ 登录成功 → 显式把登录态同步给主进程一次。
       * 主进程的 token 是纯内存的，只有这一条通道能让它"知道"用户已登录，
       * 供下载文档等**主进程自己发请求**的场景使用（详见 preload 的 syncSession 注释）。
       */
      void window.workbench?.syncSession?.(API_BASE(), sess.token);
      console.info(`[auth] 登录成功：${sess.user.xyz_id}（token 已保存 ${sess.token.length} 字符，全文不打印）`);
      onSession(sess);
    } catch (e) {
      const msg = (e as Error).message;
      // 同上：连不上后端不是"错误"，是"还在自愈中"—— 别写红字，重新排队等它
      if (msg.includes('连不上后端')) setProbeKey((k) => k + 1);
      // 「该账号还没设置过密码…」这类服务端人话原样显示，不吞
      else setErr(msg);
    } finally {
      setBusy(false);
    }
  };

  const tabBtn = (id: AuthTab, label: string) => (
    <button type="button" className={tab === id ? 'authTab authTab--on' : 'authTab'} onClick={() => { setTab(id); setErr(''); setHint(''); }}>
      {label}
    </button>
  );

  return (
    // F4：真登录页带 --login 修饰类
    <div className="authWrap authWrap--login">
      <div className="authCard">
        <h3>登录 AI 工作台</h3>
        <div className="authTabs">
          {tabBtn('sms', '手机验证码')}
          {tabBtn('xyz', 'XYZ号+密码')}
          {tabBtn('wechat', '微信')}
        </div>

        {/*
          ★ 后端还在自愈时**只显示"正在准备"**，绝不写红字。
          应用启动会在后台自己拉起数据库 + 服务端，冷启动最坏 ~40 秒；
          这段时间里甩一句"连不上后端"会让人以为坏了（这正是之前反复被报的问题）。
        */}
        {backend !== 'ready' && (
          <div className="small" style={{ color: '#8a6d3b', padding: '6px 0' }}>
            正在准备后端…（应用会自动拉起数据库和服务端，首次启动最长约 1 分钟
            {waited > 0 ? `，已等 ${waited} 秒` : ''}）
          </div>
        )}

        {/* ★ mock 模式下直接把验证码摆出来：服务端是应用自己起的，用户看不到任何窗口 */}
        {mockCode && (
          <div className="small" style={{ padding: '6px 0' }}>
            本次验证码：<b style={{ fontSize: 16, letterSpacing: 2 }}>{mockCode.code}</b>
            <span style={{ opacity: 0.65 }}>（开发模式 · {mockCode.masked}）</span>
          </div>
        )}

        {tab === 'sms' && (
          <>
            <input className="authInput" placeholder="大陆手机号（11 位）" value={phone} maxLength={11}
              onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))} />
            <div className="authRow">
              <input className="authInput" style={{ flex: 1 }} placeholder="6 位验证码" value={code} maxLength={6}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
              <button type="button" className="btn" disabled={busy || backend !== 'ready' || cooldown > 0 || phone.length !== 11} onClick={() => void smsCodeSent()}>
                {cooldown > 0 ? `${cooldown}s 后可重发` : '获取验证码'}
              </button>
            </div>
            <button type="button" className="btn btn--go" disabled={busy || backend !== 'ready' || phone.length !== 11 || code.length !== 6}
              onClick={() => void login('/auth/login/sms', { phone: phone.trim(), code })}>
              登录 / 注册
            </button>
            <div className="small">未注册的手机号会自动建号，并分配对外号 XYZ+数字（不能自选）。</div>
            <div style={{ marginTop: 12, borderTop: '1px dashed #e0e0e0', paddingTop: 10 }}>
              <button
                type="button"
                className="btn"
                style={{ width: '100%', background: '#f0f7ff', color: '#0284c7', borderColor: '#bae6fd', fontWeight: 600, padding: '8px 12px' }}
                onClick={async () => {
                  setErr('');
                  setBusy(true);
                  try {
                    const testPhone = '1380013' + String(Date.now()).slice(-4);
                    setPhone(testPhone);
                    const s = await authFetchJson<{ sent: boolean; mock_code?: string }>('/auth/sms/send', {
                      method: 'POST',
                      body: JSON.stringify({ phone: testPhone }),
                    });
                    const c = s.mock_code || '123456';
                    setCode(c);
                    await login('/auth/login/sms', { phone: testPhone, code: c });
                  } catch (e) {
                    setErr((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                ⚡ 快捷登录：一键演示账号进入
              </button>
            </div>
          </>
        )}

        {tab === 'xyz' && (
          <>
            <input className="authInput" placeholder="XYZ 号（如 XYZ10001，也可只输数字）" value={xyz}
              onChange={(e) => setXyz(e.target.value)} />
            <input className="authInput" type="password" placeholder="密码（≥8 位）" value={password}
              onChange={(e) => setPassword(e.target.value)} />
            <button type="button" className="btn btn--go" disabled={busy || backend !== 'ready' || !xyz || !password}
              onClick={() => void login('/auth/login/xyz', { xyz, password })}>
              登录
            </button>
            <div className="small">没设置过密码的号会在这里被明确拒绝：先用手机号验证码登录后到左栏设密码。</div>
          </>
        )}

        {tab === 'wechat' && (
          <>
            <div className="small" style={{ padding: '8px 0' }}>
              微信登录「即将开通」：本步只在数据库预留了 openid/unionid 字段，未接入真实微信。
            </div>
            <button type="button" className="btn btn--go" onClick={() => setHint('微信登录即将开通，本步点它没有用——请走手机号或 XYZ号+密码。')}>
              用微信登录（即将开通）
            </button>
          </>
        )}

        {hint && <div className="small">{hint}</div>}
        {err && <div className="authErr">{err}</div>}
      </div>
    </div>
  );
}
