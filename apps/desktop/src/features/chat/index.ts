/**
 * `features/chat` 的唯一公开 API —— feature 之间只许从这里 import。
 *
 * ★ 还**没**包含 `sendChat`（485 行，片 7b）：那句话要同时指挥聊天 / 浏览器 / 任务，
 *   等 7b 一起搬。
 */
export { useChat } from './useChat';
export type { AgentChat, ChatApi, Message, Role, UseChatOptions } from './useChat';
