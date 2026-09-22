/**
 * 环境变量装载：只信真实环境变量 / apps/server/.env（dotenv 读，.env 不提交）。
 * - 缺 DATABASE_URL / JWT_SECRET / DATA_KEY → 直接拒绝启动（比带弱密钥上线安全）。
 * - 短信：SMS_MOCK=1 或 NODE_ENV≠production → 开发模式（验证码只进服务器日志）；
 *   production 且没配 SMS_HTTP_URL → 启动时打警告，发送接口运行时拒绝并说人话。
 */
export interface ServerEnv {
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  dataKey: string;
  /**
   * 手机号哈希 pepper（`phone_hash = HMAC-SHA256(pepper, phone)`，一手机一用户靠它）。
   *
   * ★ 必填，**没有回退**。以前缺省会悄悄退回 `dataKey`，那是**密钥复用**：
   *   `DATA_KEY` 同时承担「字段加密」和「手机号哈希加盐」两种用途 ——
   *   一处泄漏就连带另一处，而且从配置上看不出这两件事其实共用同一把钥匙。
   *   现在缺了就拒绝启动，逼运维显式给出一个独立的值。
   */
  phonePepper: string;
  smsMock: boolean;
  smsHttpUrl: string;
  isProduction: boolean;
  /** 第 6 步：DeepSeek 流式聊天。key 只允许存在这里（apps/server/.env），缺失不拒启——/chat/stream 自己拒答 */
  deepseekApiKey: string;
  deepseekBaseUrl: string;
  deepseekModel: string;
  /**
   * 工具循环每轮最多几步。
   *
   * ★ 用户拍板（2026-09-20）：**默认不再按步数打断任务**，一路做到 done 为止
   *   —— 以前一轮只走 10 步就停下来问「要我接着做就点『继续』」，
   *   复杂环节被切成好几段，用户得反复说「继续」才能跑完。
   *
   *   0 / 负数 / 留空 = **不限步数**（只受下面的硬兜底约束）；
   *   配成正数 = 回到「一轮 N 步就停下来问」的旧行为（区间 8~200）。
   *   配置项 AGENT_LOOP_MAX_STEPS。
   */
  agentLoopMaxSteps: number;
  /**
   * 第 26 步：联网搜索（Tavily）。key 只允许存在这里（apps/server/.env）。
   *
   * ★ 与 DeepSeek 完全无关：搜索能力**不绑定任何模型**，任何模型都能调它。
   *   所以这个字段独立于上面的 deepseek*，不参与任何模型选择逻辑。
   * ★ 缺失**不拒启**：调用方（`search/tavily.ts`）会回一个明确的
   *   `not_configured` 错误并**拒绝外呼**，而不是悄悄发一个无 key 的请求。
   */
  tavilyApiKey: string;
  /** Tavily 接口地址，默认 https://api.tavily.com（换代理/镜像才动） */
  tavilyBaseUrl: string;
  /**
   * 多智能体编排（临时工并行 + 智能体互相委派）的全部开关与上限。
   *
   * ★ 每一项都有默认值，`.env` 里一个都不写也能跑（按下面的默认值）。
   *   纯解析函数是 `resolveOrchestratorEnv()`，可单测（见 scripts/verify/orc-registry.mts）。
   */
  orch: OrchestratorEnv;
}

// ---------------------------------------------------------------------------
// 多智能体编排 · 配置
//
// ★ 这些不是「调优参数」，是**费用与死循环的闸**（R9 记录过：服务端此前对 LLM 调用
//   没有任何上限，一个跑飞的桩 45 秒打了 700 次）。编排会**成倍放大**调用量
//   （一个循环派 5 个临时工 = 6 路模型调用），所以上限必须在代码里有默认值、
//   在配置里可收紧，而不是「等出事了再加」。
// ---------------------------------------------------------------------------

export interface OrchestratorEnv {
  /** 一票否决：false = 不注册 spawn_workers / delegate，两端退回「只有浏览器 6 工具 + stop」 */
  enabled: boolean;
  /** 主浏览器循环里挂不挂 web_search（唯一的行为变更项；false 时工具表与改前逐字节一致） */
  agentLoopWebSearch: boolean;
  /** 全局同时在跑的后台子任务上限 */
  maxLiveJobs: number;
  /** 同时在跑的被委派子循环上限（与上面的 maxLiveJobs 是两道独立的闸） */
  subLoopMaxLive: number;
  /** 一批临时工里同时跑几个（真并行的度） */
  workerConcurrency: number;
  /** 一次 spawn_workers 最多派几个临时工 */
  workerMaxPerCall: number;
  /** 一条循环累计最多派几个临时工（防「派完再派」刷费用） */
  workerMaxPerLoop: number;
  /** 单个临时工的硬超时 */
  workerTimeoutMs: number;
  /** 整批临时工的预算（到点没回来的按 timeout 汇报，不是整批失败） */
  workerJobBudgetMs: number;
  /** 单个临时工最多搜几轮（0 = 纯推理，不联网） */
  workerMaxSearchRounds: number;
  /**
   * 委派等待的熔断时长（**用户拍板：10 分钟**）。
   * 到点如实告诉发起方「暂未完成」，绝不假装完成、绝不让任务卡死。
   * 配置项 DELEGATE_TIMEOUT_MS，夹在 60 秒 ~ 30 分钟之间（配歪了也不会变成无限等）。
   */
  delegateTimeoutMs: number;
  /** 一个智能体同时能接几件被委派的活（默认 1；超了当场拒收 `agent_busy`，v1 不排队） */
  delegateMaxActivePerAgent: number;
  /** 委派链最大深度（2 = A→B→C 可以，A→B→C→D 不行） */
  delegateMaxDepth: number;
  /** 一条循环最多发起几次委派 */
  delegateMaxPerLoop: number;
  /** 一条循环里 web_search 最多几轮 */
  webSearchMaxRoundsPerLoop: number;
}

export const ORCH_DEFAULTS: OrchestratorEnv = {
  enabled: true,
  agentLoopWebSearch: true,
  maxLiveJobs: 8,
  subLoopMaxLive: 8,
  workerConcurrency: 3,
  workerMaxPerCall: 5,
  workerMaxPerLoop: 12,
  workerTimeoutMs: 120_000,
  workerJobBudgetMs: 180_000,
  workerMaxSearchRounds: 2,
  delegateTimeoutMs: 600_000,
  delegateMaxActivePerAgent: 1,
  delegateMaxDepth: 2,
  delegateMaxPerLoop: 3,
  webSearchMaxRoundsPerLoop: 3,
};

/** 委派超时的允许区间：配歪了也不会变成「无限等」或「1 秒就熔断」 */
export const DELEGATE_TIMEOUT_MS_MIN = 60_000;
export const DELEGATE_TIMEOUT_MS_MAX = 30 * 60_000;

function bool(raw: string | undefined, fallback: boolean): boolean {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === '' ) return fallback;
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
  return fallback;
}

function intIn(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(String(raw ?? '').trim());
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * 解析编排配置（纯函数，可单测）。传入的表可以是 `process.env`，也可以是测试自己造的。
 *
 * ★ 每一项都**夹在合理区间内**：配成 0 / 负数 / 天文数字都不会生效成那个值。
 *   这不是不信任运维，是这些值直接决定「烧多少钱」和「会不会卡死」。
 */
export function resolveOrchestratorEnv(src: Record<string, string | undefined> = process.env): OrchestratorEnv {
  return {
    enabled: bool(src.ORCHESTRATION_TOOLS, ORCH_DEFAULTS.enabled),
    agentLoopWebSearch: bool(src.AGENT_LOOP_WEB_SEARCH, ORCH_DEFAULTS.agentLoopWebSearch),
    maxLiveJobs: intIn(src.ORCH_MAX_LIVE_JOBS, ORCH_DEFAULTS.maxLiveJobs, 1, 64),
    subLoopMaxLive: intIn(src.SUB_LOOP_MAX_LIVE, ORCH_DEFAULTS.subLoopMaxLive, 1, 64),
    workerConcurrency: intIn(src.WORKER_CONCURRENCY, ORCH_DEFAULTS.workerConcurrency, 1, 16),
    workerMaxPerCall: intIn(src.WORKER_MAX_PER_CALL, ORCH_DEFAULTS.workerMaxPerCall, 1, 20),
    workerMaxPerLoop: intIn(src.WORKER_MAX_PER_LOOP, ORCH_DEFAULTS.workerMaxPerLoop, 1, 100),
    workerTimeoutMs: intIn(src.WORKER_TIMEOUT_MS, ORCH_DEFAULTS.workerTimeoutMs, 5_000, 10 * 60_000),
    workerJobBudgetMs: intIn(src.WORKER_JOB_BUDGET_MS, ORCH_DEFAULTS.workerJobBudgetMs, 10_000, 15 * 60_000),
    // 0 是合法值（= 纯推理不联网），所以这一项不走 intIn 的「<=0 用默认」
    workerMaxSearchRounds: (() => {
      const raw = String(src.WORKER_MAX_SEARCH_ROUNDS ?? '').trim();
      if (raw === '') return ORCH_DEFAULTS.workerMaxSearchRounds;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) return ORCH_DEFAULTS.workerMaxSearchRounds;
      return Math.min(5, Math.floor(n));
    })(),
    delegateTimeoutMs: intIn(
      src.DELEGATE_TIMEOUT_MS,
      ORCH_DEFAULTS.delegateTimeoutMs,
      DELEGATE_TIMEOUT_MS_MIN,
      DELEGATE_TIMEOUT_MS_MAX,
    ),
    delegateMaxActivePerAgent: intIn(
      src.DELEGATE_MAX_ACTIVE_PER_AGENT,
      ORCH_DEFAULTS.delegateMaxActivePerAgent,
      1,
      8,
    ),
    delegateMaxDepth: intIn(src.DELEGATE_MAX_DEPTH, ORCH_DEFAULTS.delegateMaxDepth, 1, 5),
    delegateMaxPerLoop: intIn(src.DELEGATE_MAX_PER_LOOP, ORCH_DEFAULTS.delegateMaxPerLoop, 1, 20),
    webSearchMaxRoundsPerLoop: intIn(
      src.WEB_SEARCH_MAX_ROUNDS_PER_LOOP,
      ORCH_DEFAULTS.webSearchMaxRoundsPerLoop,
      1,
      10,
    ),
  };
}

/**
 * 工具循环步数上限。
 *
 * ★ 默认 **0 = 不限步数**（2026-09-20 用户拍板：不要因为步数把任务掐断，
 *   让它一口气跑完整个环节）。想恢复旧行为就把 AGENT_LOOP_MAX_STEPS 配成正数。
 */
export const AGENT_LOOP_MAX_STEPS_DEFAULT = 0;
/** 显式配成正数时的允许区间（8~200；原来只到 12，那是配合「10 步一刀切」的旧口径） */
export const AGENT_LOOP_MAX_STEPS_MIN = 8;
export const AGENT_LOOP_MAX_STEPS_MAX = 200;
/**
 * ★ 硬兜底：即使配成「不限」，走到这么多步也一定停下来问用户。
 *
 * 为什么不能真的无限：模型万一陷入「read_page → 再 read_page」这类**成功的**死循环，
 * 本地那两张安全网（连败 2 次 / 连点 3 次无变化）**拦不住它**（每一步都 ok、也没"没变化"），
 * 那就是一路烧 token 到天亮。
 *
 * ★ 为什么是 50（2026-09-20 用户拍板，从 200 调下来）：
 *   正常任务实测在 10~30 步内就完成了（验收里跑过 14 步、30 步两种长度），
 *   50 步留了足够余量；而 200 步的容错空间太大 —— 真陷入死循环时要白白多烧 150 次模型调用才停。
 *   想放宽就配 AGENT_LOOP_MAX_STEPS，或直接调这个常量。
 */
export const AGENT_LOOP_STEPS_HARD_CAP = 50;

export function resolveAgentLoopMaxSteps(raw: string | undefined): number {
  const n = Number(String(raw ?? '').trim());
  // 0 / 负数 / 空 / 非数字 = 不限步数（交给硬兜底兜住）
  if (!Number.isFinite(n) || n <= 0) return AGENT_LOOP_MAX_STEPS_DEFAULT;
  return Math.min(AGENT_LOOP_MAX_STEPS_MAX, Math.max(AGENT_LOOP_MAX_STEPS_MIN, Math.floor(n)));
}

/** 这一轮实际生效的步数闸：配了正数就用它，没配（不限）就用硬兜底 */
export function effectiveStepLimit(maxSteps: number): number {
  return maxSteps > 0 ? maxSteps : AGENT_LOOP_STEPS_HARD_CAP;
}

export function loadEnv(): ServerEnv {
  const port = Number(process.env.PORT || '8787');
  const databaseUrl = (process.env.DATABASE_URL || '').trim();
  const jwtSecret = (process.env.JWT_SECRET || '').trim();
  const dataKey = (process.env.DATA_KEY || '').trim();
  const phonePepper = (process.env.PHONE_PEPPER || '').trim();

  const missing: string[] = [];
  if (!databaseUrl) missing.push('DATABASE_URL');
  if (!jwtSecret) missing.push('JWT_SECRET');
  if (!dataKey) missing.push('DATA_KEY');
  /**
   * ★ PHONE_PEPPER 现在也是**必填**（以前缺省会悄悄退回 DATA_KEY）。
   *
   * 为什么必须强制：那是**密钥复用** —— 一把钥匙同时管字段加密和手机号加盐，
   * 泄漏一处就连带另一处，而且从配置上完全看不出来。
   * 提示语里给出生成了命令，运维照着做就行。
   *
   * ⚠️ 改这个值会让**已有用户全部登录不上**（库里的 phone_hash 是用旧 pepper 算的）。
   *    迁移办法：`users.phone_enc` 是可解密的手机号副本，
   *    解密 → 用新 pepper 重算 → 回写。参考 `scripts/verify/p12-pepper-migrate.py`。
   */
  if (!phonePepper) {
    missing.push('PHONE_PEPPER');
  }
  if (missing.length > 0) {
    throw new Error(
      `缺少环境变量：${missing.join('、')}。` +
        '复制 apps/server/.env.example 为 apps/server/.env 并填写（.env 已被 .gitignore，不要提交）。' +
        (missing.includes('PHONE_PEPPER')
          ? ' PHONE_PEPPER 生成：node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"' +
            '（注意：换这个值会让已有用户登录不上，需先迁移 phone_hash）'
          : ''),
    );
  }
  if (jwtSecret.length < 16) {
    throw new Error('JWT_SECRET 太短：至少 16 字符。');
  }
  if (dataKey.length < 16) {
    throw new Error('DATA_KEY 太短：建议用 64 位十六进制。');
  }
  if (phonePepper.length < 16) {
    throw new Error('PHONE_PEPPER 太短：至少 16 字符，建议用 64 位十六进制。');
  }
  if (phonePepper === dataKey) {
    // 不拒启，但必须**说出来** —— 这等于没解决密钥复用，只是把它写明了
    console.warn(
      '[server] 警告：PHONE_PEPPER 与 DATA_KEY 相同 —— 仍然是密钥复用' +
        '（一把钥匙同时管字段加密与手机号加盐，泄漏一处即连带另一处）。' +
        '建议换一个独立的值（换值前需先迁移 users.phone_hash）。',
    );
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT 不合法：${process.env.PORT}`);
  }

  const isProduction = (process.env.NODE_ENV || 'development').trim() === 'production';
  const smsMock = process.env.SMS_MOCK === '1' || process.env.SMS_MOCK === 'true' || !isProduction;
  const smsHttpUrl = (process.env.SMS_HTTP_URL || '').trim();
  if (isProduction && !smsMock && !smsHttpUrl) {
    console.warn(
      '[server] 生产模式但没配短信通道（SMS_MOCK 未开、SMS_HTTP_URL 为空）：' +
        '/auth/sms/send 会拒绝发送并提示配置，服务其余部分照常。',
    );
  }

  return {
    port,
    databaseUrl,
    jwtSecret,
    dataKey,
    phonePepper,
    smsMock,
    smsHttpUrl,
    isProduction,
    deepseekApiKey: (process.env.DEEPSEEK_API_KEY || (process.env.ENABLE_DEV_MOCK_LLM === '1' ? 'mock' : '')).trim(),
    deepseekBaseUrl: (process.env.DEEPSEEK_BASE_URL || '').trim() || 'https://api.deepseek.com',
    deepseekModel: (process.env.DEEPSEEK_MODEL || '').trim() || 'deepseek-chat',
    agentLoopMaxSteps: resolveAgentLoopMaxSteps(process.env.AGENT_LOOP_MAX_STEPS),
    tavilyApiKey: (process.env.TAVILY_API_KEY || '').trim(),
    tavilyBaseUrl: (process.env.TAVILY_BASE_URL || '').trim() || 'https://api.tavily.com',
    orch: resolveOrchestratorEnv(process.env),
  };
}
