/**
 * 联系人演示数据（设计基准 workbench.work.html 的复刻内容）。
 *
 * ⚠️ 这份文件**曾经没能进版本库**：根 `.gitignore` 第 2 行的 `data/` 是全局通配，
 *    把 `workbench-ui/src/data/` 整个吞了 —— 文件在你本机存在，但 `git add` 一直加不进来。
 *    2026-09-24 批次 M 侦查时发现：workbench-ui 在这个仓库里因此**编译不起来**
 *    （App.tsx / Sidebar / Rail / InputBar / storage.ts 共 5 处 import 全断）。
 *    `.gitignore` 已改成 `/data/`（只锚定仓库根的嵌入式数据库目录）。
 *
 * 内容来源：**不是编的** —— 从已入库的构建产物 `workbench-ui/dist-single/index.html`
 * 里逐字段提取（那份产物是含完整 CONTACTS 数组的单文件版）。
 * 可复跑的提取/比对脚本：`python3 scripts/verify/workbench-ui-recover-contacts.py`
 * （把提取值与本文件逐字段比对，任何一处对不上都会报红）。
 *
 * 若你本机的版本比那份产物更新，**以你本机的为准**，直接覆盖这个文件即可。
 */

export type Contact = {
  id: string;
  name: string;
  /** 没有头像图时的渐变底色（135° 渐变：c1 → c2） */
  c1: string;
  c2: string;
  time: string;
  preview: string;
  /** 「我的助手」专属：可以在聊天里发起 OpenClaw 绑定 */
  bindOpenclaw?: boolean;
  /** 头像（资源 URL / data URL）；有图就不画渐变字母块 */
  av?: string;
};

/**
 * 头像资源表 —— 与产物里的做法一致：Vite 的 `import.meta.glob`（eager + `?url`）。
 *
 * 产物里「我的助手」的 `av` 写的是 `Object.keys(Lo).sort().map(M => Lo[M])[0]`，
 * 即**按路径排序后的第一张**（`avatar-01.png`）；下面这行与之逐字对应。
 */
const avatarAssets = import.meta.glob('../assets/avatars/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

const firstAvatar = Object.keys(avatarAssets).sort().map((k) => avatarAssets[k])[0] ?? '';

/**
 * 可切换的模型清单（InputBar 的「切换模型」弹层用）。
 * 同样是从已入库产物里逐字段提取的，顺序与设计一致。
 */
export const MODELS = [
  'deepseek',
  'zhipu',
  'chatgpt',
  'claude',
  'gemini',
  'grok',
  'qwen',
  'kimi',
  'hunyuan',
];

/** 模型的显示名（InputBar 里 `MODEL_LABEL[m] ?? m`） */
export const MODEL_LABEL: Record<string, string> = {
  deepseek: 'DeepSeek',
  zhipu: '智谱清言',
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini',
  grok: 'Grok',
  qwen: '通义千问',
  kimi: 'Kimi',
  hunyuan: '混元',
};

export const CONTACTS: Contact[] = [
  {
    id: 'contact-0',
    name: '我的助手',
    c1: '#7c5cff',
    c2: '#4f8bff',
    time: '14:32',
    preview: '扫码绑定 OpenClaw 客户端',
    bindOpenclaw: true,
    av: firstAvatar,
  },
  { id: 'contact-1', name: '陈默', c1: '#ff8a5c', c2: '#ff5c8a', time: '13:07', preview: '[文件] 交互稿_v3.fig' },
  { id: 'contact-2', name: '苏离', c1: '#3fd6a8', c2: '#2bb6ff', time: '11:49', preview: '这版配色我这边 OK' },
  { id: 'contact-3', name: '顾北辰', c1: '#ffd25c', c2: '#ff8a3d', time: '昨天', preview: '周末一起去爬灵隐？' },
  { id: 'contact-4', name: '白桃乌龙', c1: '#9b6bff', c2: '#5cc8ff', time: '昨天', preview: '[表情]' },
  { id: 'contact-5', name: '周予安', c1: '#5cd6a8', c2: '#3fa9ff', time: '周二', preview: '需求文档我放到共享盘了' },
];
