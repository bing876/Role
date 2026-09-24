/**
 * `BrowserGlueApi` 的**契约钉子**（编译期门禁，运行时零开销、不产出任何东西）。
 *
 * 为什么要有它：阶段 2 打算把这个 hook 翻成 `BrowserGlueProvider`。
 * 翻的时候最容易出的事不是报错，而是**悄悄变形** —— 比如少了一个字段、
 * 某个字段从 `null` 变成 `undefined`、回调参数从 `'restart' | 'giveup'` 放宽成 `string`。
 * 这些 tsc 都不会报（少了字段谁在意？），但调用点会静默地开始做错事。
 *
 * 所以这里用类型级断言把**键集合**和**每个键的形状**都钉死：
 * 任何一处变形都会让 `npm run typecheck` 直接红。
 * 改契约的正确姿势是"先改这个文件、再改实现"，改不动就说明破坏面比你以为的大。
 */
import type { BrowserGlueApi, HelpCardView, LoopGoneCard } from './browserGlue';

/** 类型级相等判定（T 与 U 完全一致才为 true） */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** 编译期断言：不满足就报错 */
type Expect<T extends true> = T;

/** ① 键集合必须**完全一致**（多一个、少一个都红） */
export type GlueKeysArePinned = Expect<
  Equal<
    keyof BrowserGlueApi,
    | 'loopGone'
    | 'answerLoopGone'
    | 'helpCards'
    | 'curHelp'
    | 'embedRect'
    | 'onEmbedRect'
    | 'helpCardAct'
    | 'showHelp'
    | 'clearHelp'
    | 'clearEmbed'
    | 'askLoopGone'
  >
>;

/** ② 每个键的形状也钉住（防止放宽成 any / 悄悄加可选） */
export type GlueShapesArePinned = Expect<
  Equal<
    Pick<
      BrowserGlueApi,
      'loopGone' | 'curHelp' | 'helpCards' | 'embedRect' | 'answerLoopGone' | 'helpCardAct' | 'showHelp' | 'clearHelp'
    >,
    {
      loopGone: LoopGoneCard | null;
      curHelp: HelpCardView | null;
      helpCards: Record<number, HelpCardView>;
      embedRect: BrowserGlueApi['embedRect'];
      answerLoopGone: (choice: 'restart' | 'giveup') => void;
      helpCardAct: (kind: 'done' | 'stop', wcId: number) => Promise<void>;
      showHelp: (card: HelpCardView) => void;
      clearHelp: (agentId: number | null | undefined) => void;
    }
  >
>;
