/**
 * 批次 L 片 1 | 自然语言建定时任务 —— **纯解析**(无 DB、无 IO,输入一句话,输出意图或 null)
 *
 * 用户规格:句式 → { agentName, taskTemplate, triggerType, triggerConfig } + 从任务+节奏自动
 * 生成 name/description。解析不到(问句/闲聊/没关键词)一律返回 **null** = 回落 LLM 正常路径
 * (与批次 E `detectBuildIntent` 同口径:null 不代表错,只是"这不是建 routine 的话")。
 *
 * 接受的两类句式(有意收窄,宁漏勿误建 —— 反证②钉的就是"含'每天'的闲聊不许建"):
 *   F1 祈使族:  让/请/叫/安排 + [智能体名] + 节奏 + 任务
 *      "让运营助手每天9点检查店铺数据" / "请客服每天早上八点处理退款咨询"
 *      "让数据员每30分钟刷新一次店铺页面" / "让夜值凌晨两点巡检服务器日志"
 *   F2 节奏起头族(必须紧跟"对我做点什么"的前缀,挡住闲聊):
 *      每天/每日 + [时刻] + 提醒我/帮我/替我/给我 + 任务
 *      "每天9点提醒我喝水" / "每天晚上10点半提醒我复盘今天"
 *
 * 明确**不**接受(→ null 回落 LLM,是设计不是缺陷):
 *   · 问句:「怎么设定期任务?」「怎么让运营助手每天9点检查数据」
 *   · 闲聊里含"每天":「我每天早上都喝咖啡」「我们每天9点例会」「你每天几点下班」
 *   · 没有节奏的:「让运营助手检查店铺数据」(一次性任务,归 LLM/任务流)
 *   · 建**智能体**的话:「建一个销售助手」「请建一个每天9点检查数据的助手」(批次 E 的领地)
 *   · 节奏在句尾的:「让X检查店铺数据,每天9点」(不支持的词序)
 *   · 间隔 < 5 分钟:「每分钟检查一次」(computeNextRun 的下限是 5 分钟,照建就是骗人)
 *
 * 节奏口径(与 `routines.ts` 的 computeNextRun 对齐):
 *   · 每天 HH:MM → triggerType='cron', triggerConfig={ hour, minute }(没说时刻→按时段取默认,
 *     完全没说→09:00,timeDefaulted=true,description 里如实写"默认")
 *   · 每 N 分钟 / 每 N 小时 → triggerType='interval', triggerConfig={ intervalMinutes },
 *     范围 5 分钟 ~ 7 天(与 computeNextRun 的 clamp 一致,越界直接 null)
 *
 * name/description 自动生成(身份/名字生成):
 *   name = `<节奏标签>·<任务>`(如「每天 09:00·检查店铺数据」,≤80)
 *   description = `自然语言创建:<原句>`(≤300,默认时刻时追加说明)
 */

import type { RoutineTriggerType } from './routines';

export interface RoutineIntent {
  /** 句子里点名的智能体名(原话,未解析成 id);没点名 = null → 由调用方(L2)落回会话主人 */
  agentName: string | null;
  /** 要执行的任务正文(已去掉节奏/智能体词),给 triggerRoutine 发【协同·例行】用 */
  taskTemplate: string;
  triggerType: RoutineTriggerType;
  /** cron: { hour, minute };interval: { intervalMinutes } */
  triggerConfig: { hour?: number; minute?: number; intervalMinutes?: number };
  /** 「每天 09:00」/「每 30 分钟」—— 展示与生成 name 用 */
  scheduleLabel: string;
  /** 自动生成的 routine 名字(≤80) */
  name: string;
  /** 自动生成的描述:自然语言创建:<原句>(≤300) */
  description: string;
  /** 时刻是默认出来的(没说话 / 只说了"早上""晚上") */
  timeDefaulted: boolean;
  raw: string;
}

// --------------------------------------------------------------------------- 守卫

/** 问句词:命中即 null(反证①:「怎么设定期任务?」不许建;「怎么让X每天9点检查数据」也不许) */
const QUESTION_RE = /(怎么|如何|怎样|为什么|是什么|什么意思|哪些|哪个|能不能|可不可以|行不行|吗)/;

/** 建**智能体**的话:归批次 E 的 detectBuildIntent,本解析器不抢(否则"建一个每天…的助手"会建出 routine) */
const BUILD_AGENT_RE = /(建|创建|新建|来个|来一个|招个|招一个|加个|加一个)[^，。！？!?]{0,12}(助手|智能体|同事|机器人|专员|管家)/;

/** 点名的智能体名不许是这些虚词(「让一个每天9点检查数据的助手来」→ agent="一个" → 拒) */
const AGENT_STOPWORDS = new Set(['一个', '一下', '一位', '一位人', '个', '位', '帮我', '替我', '给我']);

// --------------------------------------------------------------------------- 词法

/** 祈使动词(F1 的锚)。反证 L1a 拆的就是这一行 */
const DIRECTIVE = '(?:让|请|叫|安排)';

/** F2 的任务前缀:必须是"对我做点什么",否则"每天早上喝咖啡"这种闲聊也会误建。反证 L1b 拆的就是这一行 */
const F2_PREFIX = '(?:提醒我|帮我|替我|给我)';

/** 智能体名:中文/字母,1~8 字(不含数字,免得把"9点"吃掉) */
const AGENT_CHARS = '[\u4e00-\u9fa5A-Za-z]{1,8}';
/** 名字段里出现这些"功能字" → 这段不是名字(「让助手**把**9点的会取消」里"助手把"不是名字) */
const NAME_FUNC_CHARS = /把|就|都|又|才|再|向|从|给|对|将|的/;
/** 名字段里出现任务动词 → 这段是任务不是名字;但"XX员/手/师…"是岗位名,放行 */
const NAME_TASK_VERBS = /(检查|处理|汇总|分析|整理|盯着?|写|做|发|报|核对|刷新|巡检|复盘|提醒|汇报|执行|监控|统计|跟进|审核|取消|改)/;
const JOB_TITLE_TAIL = /(员|手|师|助|顾问|经理|专员|管家)$/;
/** 一次性时间词:命中 → 不是"定期任务"(明天/今晚是单次),回落 LLM */
const ONE_SHOT_RE = /(明天|后天|大后天|今晚|今夜|今天|稍后|等会儿|等一下)/;

/** 时段词(带默认时刻:没说话时按"早上=09:00、晚上=21:00…"兜) */
const PERIODS = '凌晨|清晨|早上|早晨|上午|中午|下午|晚上|夜里|半夜|深夜';
const PERIOD_DEFAULT_HOUR: Record<string, number> = {
  凌晨: 6, 清晨: 7, 早上: 9, 早晨: 9, 上午: 9, 中午: 12,
  下午: 15, 晚上: 21, 夜里: 21, 半夜: 0, 深夜: 0,
};
/** 完全没说时刻时的默认(cron daily 09:00) */
const DEFAULT_HOUR = 9;
const DEFAULT_MINUTE = 0;

const CN_DIGIT: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
/** 中文/数字 → 整数(0~99;"十"=10,"十九"=19,"二十三"=23) */
function cnToInt(s: string): number | null {
  const t = s.trim();
  if (/^\d{1,2}$/.test(t)) return Number(t);
  if (CN_DIGIT[t] !== undefined) return CN_DIGIT[t];
  if (t === '十') return 10;
  const m = t.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) return (m[1] ? CN_DIGIT[m[1]] : 1) * 10 + (m[2] ? CN_DIGIT[m[2]] : 0);
  return null;
}

const HOUR_SRC = '(\\d{1,2}|[零一二两三四五六七八九十]{1,3})';
const MIN_SRC = '(\\d{1,2}|[零一二两三四五六七八九十]{1,3})';
/** 「9点」「早上八点」「下午3点30」「晚上10点半」「9点45分」 */
// 注:HOUR_SRC / MIN_SRC 自带括号,这里直接拼、别再套一层(套了组号就错位 —— 批次 L 片 1 实测踩过)
const RE_CLOCK_DIAN = new RegExp(
  `^(${PERIODS})?\\s*${HOUR_SRC}\\s*[点时](?:\\s*(半|点半|半点)|\\s*${MIN_SRC}\\s*分?)?`,
);
/** 「09:30」/「9:30」 */
const RE_CLOCK_24 = /^(\d{1,2})\s*[:：]\s*(\d{2})/;
/** 只有时段词(「每天早上提醒我…」→ 早上默认 09:00) */
const RE_PERIOD_ONLY = new RegExp(`^(${PERIODS})\\s*`);

export interface ParsedClock {
  hour: number;
  minute: number;
  /** 时刻是默认出来的(只说了时段 / 完全没说) */
  defaulted: boolean;
  /** 吃掉的后缀(剩下的是任务) */
  rest: string;
}

/** 从"每天/每日"之后的文本里剥一个时刻;剥不出用默认。永远有返回值。 */
function stripClock(rest: string): ParsedClock {
  let m = rest.match(RE_CLOCK_DIAN);
  if (m) {
    const hour = cnToInt(m[2]);
    const minute = m[3] ? 30 : m[4] ? cnToInt(m[4]) : 0;
    if (hour === null || minute === null || minute < 0 || minute > 59) {
      return finishDefault(rest, undefined);
    }
    let h = hour;
    if (m[1] === '下午' || m[1] === '晚上' || m[1] === '夜里') {
      if (h < 12) h += 12;
    }
    if ((m[1] === '半夜' || m[1] === '深夜') && h === 12) h = 0;
    if (h < 0 || h > 23) return finishDefault(rest, m[1]);
    return { hour: h, minute, defaulted: false, rest: rest.slice(m[0].length) };
  }
  m = rest.match(RE_CLOCK_24);
  if (m) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return finishDefault(rest, undefined);
    return { hour: h, minute: min, defaulted: false, rest: rest.slice(m[0].length) };
  }
  m = rest.match(RE_PERIOD_ONLY);
  if (m) {
    // 只说了时段:按该时段的默认时刻,吃掉时段词
    return { hour: PERIOD_DEFAULT_HOUR[m[1]] ?? DEFAULT_HOUR, minute: 0, defaulted: true, rest: rest.slice(m[0].length) };
  }
  return finishDefault(rest, undefined);
}

function finishDefault(rest: string, period: string | undefined): ParsedClock {
  return { hour: period ? (PERIOD_DEFAULT_HOUR[period] ?? DEFAULT_HOUR) : DEFAULT_HOUR, minute: DEFAULT_MINUTE, defaulted: true, rest };
}

/** 「每30分钟」「每隔一小时」「每半小时」→ 分钟数;不合法返回 null */
function parseIntervalPhrase(phrase: string): number | null {
  const t = phrase.trim();
  let m = t.match(/^(?:每隔|每)\s*(\d+|[零一二两三四五六七八九十]{1,3})\s*分钟$/);
  if (m) {
    const n = cnToInt(m[1]);
    return n !== null && n >= 5 && n <= 7 * 24 * 60 ? n : null;
  }
  m = t.match(/^(?:每隔|每)\s*(\d+|[零一二两三四五六七八九十]{1,3})\s*小时$/);
  if (m) {
    const n = cnToInt(m[1]);
    if (n === null || n < 1 || n > 7 * 24) return null;
    return n * 60;
  }
  if (/^(?:每隔|每)\s*半小时$/.test(t)) return 30;
  if (/^(?:每隔|每)\s*(?:一|1)\s*小时$/.test(t)) return 60;
  return null;
}

/** 节奏锚:每天/每日、每N分钟/每N小时/每半小时/每小时,或裸时刻(时段?+HH点/HH:MM) */
const RE_SCHEDULE_ANCHOR = new RegExp(
  `(每天|每日|(?:每隔|每)\\s*(?:半小时|(?:\\d+|[零一二两三四五六七八九十]{1,3})\\s*(?:分钟|小时)|(?:一|1)\\s*小时)|${RE_CLOCK_DIAN.source.slice(1)})`,
);

/** "名字"片段校验:空 = 没点名(允许);非空必须是像名字的 1~8 字 */
function validAgentPart(part: string): boolean {
  if (part === '') return true;
  if (!new RegExp(`^${AGENT_CHARS}$`).test(part)) return false;
  if (AGENT_STOPWORDS.has(part)) return false;
  if (/[什么怎么吗?？]/.test(part)) return false;
  if (NAME_FUNC_CHARS.test(part)) return false;
  if (NAME_TASK_VERBS.test(part) && !JOB_TITLE_TAIL.test(part)) return false;
  return true;
}

/**
 * 把节奏短语从 rest 头部切出来:每天/每日 + 时刻,或 每N分钟/每N小时,
 * 或**裸时刻**(「让夜值凌晨两点巡检…」→ 每天 02:00;没说"每天"也按每天算,一次性由 ONE_SHOT_RE 挡)。
 * bare=true 表示裸时刻(调用方要再检查时钟后不许紧跟"前")。
 */
function parseSchedulePrefix(rest: string): { scheduleLabel: string; cfg: { hour?: number; minute?: number; intervalMinutes?: number }; timeDefaulted: boolean; taskRaw: string; bare: boolean } | null {
  const mDaily = rest.match(/^(每天|每日)\s*(.*)$/);
  if (mDaily) {
    const clock = stripClock(mDaily[2]);
    return {
      scheduleLabel: `每天 ${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`,
      cfg: { hour: clock.hour, minute: clock.minute },
      timeDefaulted: clock.defaulted,
      taskRaw: clock.rest,
      bare: false,
    };
  }
  // 间隔族:切「每…分钟/小时/半小时/一小时」短语(任务跟在后面,短语到节奏字为止)
  const mInt = rest.match(/^(每隔|每)\s*(半小时|(?:\d+|[零一二两三四五六七八九十]{1,3})\s*分钟|(?:\d+|[零一二两三四五六七八九十]{1,3})\s*小时|(?:一|1)\s*小时)/);
  if (mInt) {
    const phrase = mInt[0];
    const mins = parseIntervalPhrase(phrase);
    if (mins === null) return null;
    const label = mins >= 60 && mins % 60 === 0 ? `每 ${mins / 60} 小时` : `每 ${mins} 分钟`;
    return { scheduleLabel: label, cfg: { intervalMinutes: mins }, timeDefaulted: false, taskRaw: rest.slice(phrase.length), bare: false };
  }
  // 裸时刻:「凌晨两点巡检…」「9点检查…」(没有"每天/每N",按每天算;ONE_SHOT_RE 挡单次的)
  const mBare = rest.match(RE_CLOCK_DIAN);
  if (mBare) {
    const hour = cnToInt(mBare[2]);
    const minute = mBare[3] ? 30 : mBare[4] ? cnToInt(mBare[4]) : 0;
    if (hour === null || minute === null || minute < 0 || minute > 59) return null;
    let h = hour;
    if (mBare[1] === '下午' || mBare[1] === '晚上' || mBare[1] === '夜里') {
      if (h < 12) h += 12;
    }
    if ((mBare[1] === '半夜' || mBare[1] === '深夜') && h === 12) h = 0;
    if (h < 0 || h > 23) return null;
    return {
      scheduleLabel: `每天 ${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      cfg: { hour: h, minute },
      timeDefaulted: false,
      taskRaw: rest.slice(mBare[0].length),
      bare: true,
    };
  }
  const mBare24 = rest.match(RE_CLOCK_24);
  if (mBare24) {
    const h = Number(mBare24[1]);
    const min = Number(mBare24[2]);
    if (h > 23 || min > 59) return null;
    return {
      scheduleLabel: `每天 ${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`,
      cfg: { hour: h, minute: min },
      timeDefaulted: false,
      taskRaw: rest.slice(mBare24[0].length),
      bare: true,
    };
  }
  return null;
}

/** 任务清理:去首尾的语气词/标点 */
function cleanTask(t: string): string {
  return t
    .replace(/^[去来就把]+/, '')
    .replace(/[。.!！?？,，\s]+$/, '')
    .trim();
}

function makeIntent(args: {
  agentName: string | null;
  task: string;
  triggerType: RoutineTriggerType;
  triggerConfig: { hour?: number; minute?: number; intervalMinutes?: number };
  scheduleLabel: string;
  timeDefaulted: boolean;
  raw: string;
}): RoutineIntent {
  const name = `${args.scheduleLabel}·${args.task}`.slice(0, 80);
  let description = `自然语言创建:${args.raw}`;
  if (args.timeDefaulted && args.triggerType === 'cron') {
    description += `(没说话里没给时刻,默认每天 ${String(args.triggerConfig.hour).padStart(2, '0')}:${String(args.triggerConfig.minute).padStart(2, '0')})`;
  }
  description = description.slice(0, 300);
  return { agentName: args.agentName, taskTemplate: args.task, triggerType: args.triggerType, triggerConfig: args.triggerConfig, scheduleLabel: args.scheduleLabel, name, description, timeDefaulted: args.timeDefaulted, raw: args.raw };
}

/**
 * 解析一句话是不是"建定时任务"的意图。不是(问句/闲聊/建智能体/没节奏/没关键词)→ null = 回落 LLM。
 */
export function parseRoutineIntent(message: string): RoutineIntent | null {
  const t = (message ?? '').trim();
  if (!t || t.length < 5) return null;

  // 守卫 1:问句一律不建(反证①/②的"怎么设定期任务?"就是这条挡的)
  if (QUESTION_RE.test(t)) return null;
  // 守卫 2:建**智能体**的话归批次 E,不抢
  if (BUILD_AGENT_RE.test(t)) return null;

  // ---------------- F1 祈使族:让/请/叫/安排 + [名字] + 节奏 + 任务
  // 节奏锚可能在名字后面("让X每天9点…"),也可能就是开头("让每天9点…"),
  // 裸时刻("让夜值凌晨两点…")也算锚。做法:先整体匹配"动词+剩余",再在剩余里找锚,
  // 锚前面的片段当"名字"来校验(不是名字就拒)—— 不能指望一条正则同时管好三段。
  const m1 = t.match(new RegExp(`^(?:${DIRECTIVE})\\s*(.+)$`));
  if (m1) {
    const rest = m1[1];
    if (ONE_SHOT_RE.test(rest)) return null; // 「让X明天9点检查」= 单次,不是定期
    const anchor = rest.match(RE_SCHEDULE_ANCHOR);
    if (anchor && anchor.index !== undefined) {
      const agentPart = rest.slice(0, anchor.index).trim();
      const sched = parseSchedulePrefix(rest.slice(anchor.index));
      if (sched) {
        const taskRaw = sched.taskRaw;
        // 裸时刻后紧跟"前" = 截止时间不是日程(「9点前交报告」)
        if (sched.bare && /^前/.test(taskRaw)) return null;
        const task = cleanTask(taskRaw);
        // 任务以"的"开头 = 前面那句是名词短语(「让每天9点的例会改到10点」不是建任务)
        if (/^的/.test(taskRaw)) return null;
        if (task.length >= 2 && validAgentPart(agentPart)) {
          return makeIntent({
            agentName: agentPart === '' ? null : agentPart,
            task,
            triggerType: sched.cfg.intervalMinutes !== undefined ? 'interval' : 'cron',
            triggerConfig: sched.cfg,
            scheduleLabel: sched.scheduleLabel,
            timeDefaulted: sched.timeDefaulted,
            raw: t,
          });
        }
      }
    }
    return null;
  }

  // ---------------- F2 节奏起头族:每天/每日 + [时刻] + 提醒我/帮我/… + 任务
  const m2 = t.match(/^(每天|每日)\s*(.*)$/);
  if (m2) {
    const clock = stripClock(m2[2]);
    const afterClock = clock.rest.match(new RegExp(`^(?:${F2_PREFIX})\\s*(.{2,60})$`));
    if (afterClock) {
      const task = cleanTask(afterClock[1]);
      if (task.length >= 2) {
        return makeIntent({
          agentName: null,
          task,
          triggerType: 'cron',
          triggerConfig: { hour: clock.hour, minute: clock.minute },
          scheduleLabel: `每天 ${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`,
          timeDefaulted: clock.defaulted,
          raw: t,
        });
      }
    }
  }

  return null;
}
