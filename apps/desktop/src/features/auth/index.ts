/**
 * `features/auth` 的唯一公开 API —— feature 之间只许从这里 import。
 *
 * ★ 登出被**有意切两半**：会话那一半在这里（`signOutSession`），
 *   跨 feature 清场那一半留在 `App.tsx` 的 `onLogout`（它才是那个协调点）。
 */
export { useAuth } from './useAuth';
export type { AuthApi } from './useAuth';
