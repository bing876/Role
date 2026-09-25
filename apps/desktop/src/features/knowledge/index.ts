/**
 * `features/knowledge` 的唯一公开 API —— **feature 之间只许从这里 import**
 * （批次 M 的分层规矩：不许伸手进别人的内部路径）。
 *
 * 目前这一片只搬了「逻辑」，还没有搬 UI：`App.tsx` 的知识库面板 JSX 与
 * `styles.css` 里的 `.knowledgePanel*` 规则**一行都没动**（用户 2026-09-24 的叫停：
 * 设计语言未定稿前不搬 CSS/组件）。搬完之后 `index.ts` 会再多出一个 `<KnowledgePanel/>`。
 */
export { useKnowledge } from './useKnowledge';
export type { KnowledgeApi, UseKnowledgeOptions } from './useKnowledge';
