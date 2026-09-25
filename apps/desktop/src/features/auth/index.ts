/**
 * `features/auth` 的唯一公开 API —— feature 之间只许从这里 import。
 *
 * ★ 登出被**有意切两半**：会话那一半在这里（`signOutSession`），
 *   跨 feature 清场那一半留在 `App.tsx` 的 `onLogout`（它才是那个协调点）。
 *
 * 批次 M-8'：`AuthScreen`（登录页整块，13 个 state）从 App.tsx 逐字搬进本 feature
 * （`AuthScreen.tsx`）——阶段 1① 因「JSX 不许动」留在 App，阶段 2 收编。
 */
export { useAuth } from './useAuth';
export type { AuthApi } from './useAuth';
export { AuthScreen } from './AuthScreen';
