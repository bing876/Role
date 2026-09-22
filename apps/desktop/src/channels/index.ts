/**
 * 多智能体编排 · 内部频道模块的唯一对外入口。
 *
 * 照 `browser/index.ts` 的先例办：以后改频道相关的东西**只改这个目录**，
 * 不要再往 App.tsx 里堆（那个文件已经 3300+ 行）。
 *
 * App.tsx 只负责两件事：一个开关按钮 + 挂 `<ChannelsPanel apiBase token onClose />`。
 * 数据怎么拉、状态怎么放，都在这个目录里。
 */
export { ChannelsPanel } from './ChannelsPanel';
export type { ChannelsPanelProps } from './ChannelsPanel';
