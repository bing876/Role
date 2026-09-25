/**
 * `features/memory` 的唯一公开 API —— feature 之间只许从这里 import。
 * 本片只搬了**逻辑**：JSX 与 `styles.css` 里 `.memList*` / `.memCard` 等规则一行没动。
 */
export { useMemory } from './useMemory';
export type { MemoryApi, UseMemoryOptions } from './useMemory';
/** 规格 C4（2026-09-25）：记忆确认卡（渲染在对话流里,替代旧侧栏抽屉式确认面板） */
export { MemoryConfirmCard } from './MemoryConfirmCard';
