/**
 * `features/chat` 的唯一公开 API —— feature 之间只许从这里 import。
 *
 * `useChat` 已含 `sendChat` / `onSend` / `startAgentTask`（阶段 1① 片 7b）。
 *
 * 规格 C1（2026-09-25）：`AgentGuide`（旧「引导表」大表单）移除 —— 三问改
 * `PersonaChips`（输入框上方一行 chips：可点/可自己写/可跳过,打字/跳过/答完即消失）。
 * 落库仍走宿主注入（App 的 savePersona 是跨 feature 协调点,留组合层）。
 */
export { useChat } from './useChat';
export type { AgentChat, ChatApi, Message, Role, UseChatOptions } from './useChat';
export { PersonaChips } from './PersonaChips';
export type { PersonaChipsDraft, PersonaField } from './PersonaChips';
export { CollabCard, isCollabMessage } from './CollabCard';
/**
 * 交互对齐片(2026-09-26):助手最终回答渲染成**干净 markdown**(极简、零依赖、零 innerHTML)。
 * 气泡一直是纯文本,模型的 `**加粗**` 会原样露出 —— 这个组件就是补那一层。
 */
export { MarkdownText } from './MarkdownText';
