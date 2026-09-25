/**
 * `features/projects` 的唯一公开 API —— feature 之间只许从这里 import。
 *
 * ★ 注意这里**没有**导出「进入项目」：那一步要同时指挥 chat / memory / knowledge 三块，
 *   属于组合层的活，留在 `App.tsx`（见 `useProjects` 里 `onEnterProject` 的注释）。
 */
export { useProjects } from './useProjects';
export type { ProjectsApi, UseProjectsOptions } from './useProjects';
