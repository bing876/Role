import { useEffect, useState } from 'react';
import type { AuthProfile, AuthSession } from '@ai-workbench/shared';
import { API_BASE, TOKEN_KEY, authFetchJson } from '../../shared/api';

/**
 * 阶段 1① · 逻辑抽离第 5 片：**会话**（静默登录 / 改密码 / 登出）。
 *
 * ★ 边界（与片 4 的 `enterProject` 同一个道理）：
 *   `onLogout` 的**前半段**是"会话这件事"本身 —— 清 token、把主进程那份凭证清掉、
 *   把分区闸的项目白名单清掉、把 session 置空。这半段归本 hook。
 *   **后半段**（清聊天 / 清名单 / 清两层记忆 / 清资料 / 清任务 / 关掉所有网页）要动
 *   六七个 feature 的 state —— 那是**跨 feature 清场**，只能待在组合层：
 *   App 里那个 `onLogout` 只写"顺序"（先 `signOutSession()`，再清各 feature），
 *   两半各归各位，**不需要注入回调**。
 *
 * ★ 本片**只搬逻辑，不动一行 JSX / 一行 CSS**（登录页那个 `AuthScreen` 组件本身带 JSX，原样留在 App.tsx）。
 */

export interface AuthApi {
  /** 当前会话；`null` = 未登录（界面会画登录页） */
  session: AuthSession | null;
  setSession: (s: AuthSession | null | ((prev: AuthSession | null) => AuthSession | null)) => void;
  /** 正在拿已存 token 换 profile（登录页会显示"检查中"） */
  checkingAuth: boolean;
  /** 改密码表单的三件套 */
  pwOld: string;
  setPwOld: (v: string) => void;
  pwNew: string;
  setPwNew: (v: string) => void;
  pwMsg: string;
  setPwMsg: (v: string) => void;
  /** 改密码：已设过密码要带旧的；成功后本地的 `has_password` 立刻置真 */
  submitPassword: () => Promise<void>;
  /**
   * 登出的**会话那一半**：清 token + 清主进程凭证 + 清分区白名单 + session 置空。
   * 跨 feature 的那一半由 App 的 `onLogout` 紧接着做（它是唯一的清场协调点）。
   */
  signOutSession: () => void;
}

export function useAuth(): AuthApi {
  // ---- 第 5 步：会话。JWT 从 localStorage 读回后只放内存 state；绝不 console 打全文 ----
  const [session, setSession] = useState<AuthSession | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(() => Boolean(localStorage.getItem(TOKEN_KEY)));
  const [pwOld, setPwOld] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwMsg, setPwMsg] = useState('');

  /** 带已存 token 调 /auth/me：能换回 profile 就静默登录，换不回来就清 token 回登录页 */
  useEffect(() => {
    const saved = localStorage.getItem(TOKEN_KEY);
    if (!saved) return;
    let off = false; // 卸载标志：慢回来的响应不再 setState
    authFetchJson<AuthProfile>('/auth/me', { headers: { authorization: `Bearer ${saved}` } })
      .then((p) => {
        if (off) return;
        /**
         * ★ F5 后的静默恢复 —— **必须**同步给主进程。
         * 这条路径完全不经过主进程（token 是从 localStorage 直接读出来的），
         * 不同步的话就会出现「渲染层已登录、主进程没凭证」，
         * 用户刷新后立刻点下载文档就会报"没有登录凭证"。
         */
        void window.workbench?.syncSession?.(API_BASE(), saved);
        setSession({ ...p, token: saved });
      })
      .catch(() => {
        localStorage.removeItem(TOKEN_KEY);
        // 登录态失效 → 顺手把主进程那份也清掉，别留着一份过期的还能发请求
        void window.workbench?.syncSession?.(API_BASE(), '');
        if (!off) setSession(null);
      })
      .finally(() => { if (!off) setCheckingAuth(false); });
    return () => { off = true; };
  }, []);

  const submitPassword = async () => {
    if (!session) return;
    setPwMsg('');
    try {
      const body: Record<string, string> = { new_password: pwNew };
      if (session.user.has_password) body.old_password = pwOld;
      const r = await authFetchJson<{ ok: boolean; message: string }>('/auth/password/set', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { authorization: `Bearer ${session.token}` },
      });
      setPwMsg(r.message);
      setPwOld('');
      setPwNew('');
      setSession((s) => (s ? { ...s, user: { ...s.user, has_password: true } } : s));
    } catch (e) {
      setPwMsg((e as Error).message);
    }
  };

  const signOutSession = () => {
    localStorage.removeItem(TOKEN_KEY);
    // ★ 登出 → 把主进程那份凭证也清掉（它是内存里的，不主动清就得等进程退出）
    void window.workbench?.syncSession?.(API_BASE(), '');
    /**
     * ★ 登出 → 分区闸的项目集合也要清空。
     * 不清的话下一位登录者会**继承上一位的项目白名单**，分区闸就等于没装。
     */
    void window.workbench?.syncProjects?.([]);
    setSession(null);
    setPwMsg('');
  };

  return {
    session,
    setSession,
    checkingAuth,
    pwOld,
    setPwOld,
    pwNew,
    setPwNew,
    pwMsg,
    setPwMsg,
    submitPassword,
    signOutSession,
  };
}
