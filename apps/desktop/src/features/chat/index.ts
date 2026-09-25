/**
 * `features/chat` 的唯一公开 API —— feature 之间只许从这里 import。
 *
 * `useChat` 已含 `sendChat` / `onSend` / `startAgentTask`（阶段 1① 片 7b）。
 *
 * 批次 M-8'：`AgentGuide`（新智能体「引导表」，聊天流里的第一张卡）从 App.tsx
 * 逐字搬进本 feature（`AgentGuide.tsx`）——确认动作仍走宿主注入的 onSave
 * （App 的 savePersona 是跨 feature 协调点，留组合层）。
 */
export { useChat } from './useChat';
export type { AgentChat, ChatApi, Message, Role, UseChatOptions } from './useChat';
export { AgentGuide } from './AgentGuide';
