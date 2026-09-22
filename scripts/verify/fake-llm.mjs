/**
 * 子阶段 A 的**验收用假模型 + 测试页**（零依赖，只用 node:http）。
 *
 * 为什么要它（而不是真调 DeepSeek）：
 *   1. **可复现的并发时间线** —— 真模型的响应时间抖动很大，两路循环到底有没有真的重叠，
 *      会被「谁先谁后」的运气掩盖。这里每次响应固定延迟 `FAKE_DELAY_MS`，
 *      并发是否真发生由**请求日志的进入/离开时间戳**直接看出来。
 *   2. **不烧 token、不依赖外网**；
 *   3. **状态可分辨** —— 每个目标回一句带目标前缀的结论，用来证明两路任务的状态没有串位。
 *
 * 它同时是个静态站：`/page-a`、`/page-b`、`/form`（含密码/验证码/支付按钮，供安全红线复验）。
 *
 * 用法：
 *   node scripts/verify/fake-llm.mjs            # 监听 8899
 *   FAKE_PORT=8899 FAKE_DELAY_MS=1200 FAKE_STEPS=8 FAKE_LOG=<path> node scripts/verify/fake-llm.mjs
 *
 * 日志（JSONL，每行一次模型请求，带毫秒时间戳）：
 *   {"ev":"req","at":<ms>,"iso":"...","goal":"...","step":1,"kind":"read_page"}
 *   {"ev":"res","at":<ms>,"iso":"...","goal":"...","step":1,"kind":"read_page","dur":1203}
 */
import { createServer } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';

const PORT = Number(process.env.FAKE_PORT || 8899);
/** 每次模型响应的固定延迟（毫秒）—— 并发时间线靠它撑开 */
const DELAY_MS = Number(process.env.FAKE_DELAY_MS || 1200);
/** 每条循环在 stop(done) 之前先走几步 read_page */
const STEPS = Number(process.env.FAKE_STEPS || 4);
const LOG = process.env.FAKE_LOG || '';
/** Phase 3：登录态测试站的**服务端原始请求日志**（JSONL，带每个请求实际带的 Cookie） */
const SITE_LOG = process.env.SITE_LOG || '';
/**
 * 阶段简报 · 方案 B：可选地把**每次提问里最后一条用户消息**也原样记下来。
 *
 * 为什么必须记它：「服务端算出了 delta=moved」只证明**判定发生了**，
 * 证明不了**AI 收到了这个判定**。只有看到恢复后第一次提问的提示词里
 * 带着那段「页面在暂停期间被改变」的结论，才算证明重新感知真的喂到了模型嘴边。
 *
 * 默认关闭（FAKE_DUMP=1 才开），别的验收脚本的日志不受影响。
 */
const DUMP = process.env.FAKE_DUMP === '1';

if (LOG) writeFileSync(LOG, '');
if (SITE_LOG) writeFileSync(SITE_LOG, '');

/** Phase 3：站点侧逐请求记录 —— 「哪个分区（= 哪个项目）带着谁的 cookie 来」以这里为准 */
function logSite(rec) {
  const line = JSON.stringify({ at: Date.now(), iso: new Date().toISOString(), ...rec });
  if (SITE_LOG) {
    try {
      appendFileSync(SITE_LOG, `${line}\n`);
    } catch {
      /* 记不上不影响验收本身 */
    }
  }
  console.log(line);
}

/** 从 Cookie 头里抠出验证站点用的那个 sid */
function sidOf(cookieHeader) {
  const m = /(?:^|;\s*)wbsid=([^;]+)/.exec(cookieHeader || '');
  return m ? m[1] : '';
}

function log(obj) {
  const line = JSON.stringify({ at: Date.now(), iso: new Date().toISOString(), ...obj });
  if (LOG) {
    try {
      appendFileSync(LOG, `${line}\n`);
    } catch {
      /* 记不上不影响验收本身 */
    }
  }
  console.log(line);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从循环的第一条用户消息里抠出任务目标 */
function goalOf(messages) {
  for (const m of messages) {
    if (m && m.role === 'user' && typeof m.content === 'string') {
      const hit = m.content.match(/任务目标：(.+)/);
      if (hit) return hit[1].trim().slice(0, 80);
    }
  }
  return '(无目标)';
}

/** 已经执行过几步（历史里有几条 tool 回执） */
function stepsDone(messages) {
  return messages.filter((m) => m && m.role === 'tool').length;
}

function toolCall(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

/**
 * 场景脚本：目标里含这些**关键词**时，AI 按脚本真的做一串动作，
 * 而不是原地空转 read_page —— 体验场景要看得见「AI 在干什么」。
 *
 * 关键词用子串匹配（goalOf 会把目标截到 80 字，够用）。
 * 没命中就完全走原来的 read_page 循环（老验收脚本不受影响）。
 */
// 注意 url 必须是**绝对地址**：driver 的 navigate() 不认 '/shop' 这种相对路径，
// 传相对路径会让这一步失败、AI 一步就退出（第一版冒烟就是栽在这：循环直接 ask_user 结束）。
const HERE_URL = `http://127.0.0.1:${PORT}`;

/**
 * 阶段2 实验 A（2026-09-21）：「点完要等这么久才有结果」的页面，服务端故意延迟这么久才回。
 *
 * 为什么默认值是 30 秒：产品的「手」超时是 `EXEC_TIMEOUT_MS = 20_000`（apps/desktop/electron/agent.ts）。
 * 30 > 20 ⇒ 工具一定先超时；而动作其实**已经发生**了。这两个事实同时成立，
 * 正是审计里说的「不知道执行没执行」（DeepSeek 叫 TOOL_OUTCOME_UNKNOWN）。
 * 我们要量的就是：超时之后，那一下到底算不算数、AI 会不会因此再来一次。
 */
const SLOW_MS = Number(process.env.SLOW_MS || 30000);

/** 实验页的点击计数（服务端侧的真相：这一下到底点没点上） */
const CLICKS = Object.create(null);

const PLANS = [
  {
    key: '搜索下单',
    steps: [
      { t: 'open_url', url: `${HERE_URL}/shop` },
      { t: 'read_page' },
      { t: 'type', target: '搜索商品', text: '无线鼠标' },
      { t: 'click', target: '搜索' },
      { t: 'read_page' },
      { t: 'click', target: '加入购物车' },
      { t: 'read_page' },
      { t: 'scroll', direction: 'down' },
      { t: 'read_page' },
    ],
  },
  {
    // ★ 场景 s14 专用：**页面自己会动**的商城（实时库存 + 轮播广告每 1.5 秒自己变一次）。
    //   用来验证「用户什么都没做、页面自己变了」时，AI 会不会把自己更新的部分
    //   算到用户头上（说「应该是你自己操作过」）。真实网页里这种东西到处都是：
    //   轮播图、实时行情、倒计时、自动刷新。
    key: '自动刷新',
    steps: [
      { t: 'open_url', url: `${HERE_URL}/auto` },
      { t: 'read_page' },
      { t: 'type', target: '搜索商品', text: '无线鼠标' },
      { t: 'click', target: '搜索' },
      { t: 'read_page' },
      { t: 'click', target: '加入购物车' },
      { t: 'read_page' },
      { t: 'scroll', direction: 'down' },
      { t: 'read_page' },
    ],
  },
  {
    // ★ 场景 s16：会弹 alert 的商城。真实网页里到处都是（Cookie 同意、登录提示、问卷）。
    key: '弹窗',
    steps: [
      { t: 'open_url', url: `${HERE_URL}/dialog` },
      { t: 'read_page' },
      { t: 'type', target: '搜索商品', text: '无线鼠标' },
      { t: 'click', target: '搜索' },
      { t: 'read_page' },
      { t: 'click', target: '加入购物车' },
      { t: 'read_page' },
      { t: 'scroll', direction: 'down' },
      { t: 'read_page' },
    ],
  },
  {
    // ★ 场景 s20：步数很多的任务（14 步 > 服务端上限 10 步），专门用来撞步数上限。
    key: '长任务',
    steps: [
      { t: 'open_url', url: `${HERE_URL}/shop` },
      { t: 'read_page' },
      { t: 'type', target: '搜索商品', text: '无线鼠标' },
      { t: 'click', target: '搜索' },
      { t: 'read_page' },
      { t: 'scroll', direction: 'down' },
      { t: 'read_page' },
      { t: 'scroll', direction: 'down' },
      { t: 'read_page' },
      { t: 'read_page' },
      { t: 'scroll', direction: 'down' },
      { t: 'read_page' },
      { t: 'scroll', direction: 'down' },
      { t: 'read_page' },
    ],
  },
  {
    key: '登录验证',
    steps: [
      { t: 'open_url', url: `${HERE_URL}/captcha` },
      { t: 'read_page' },
      { t: 'type', target: '手机号', text: '13800000000' },
      // 验证码是敏感框：driver 的守卫会拒掉 → AI 卡在这里，正是现实里「要人来」的情形
      { t: 'type', target: '短信验证码', text: '123456' },
      { t: 'read_page' },
      { t: 'click', target: '提交验证' },
      { t: 'read_page' },
      { t: 'click', target: '去下单' },
      { t: 'read_page' },
    ],
  },
  {
    // 第 27 步：**登录墙**（与上面的"验证码"是两条不同的触发支路）。
    // 放在数组**最后**：planFor 取第一个命中的，加在后面不会影响任何既有目标。
    key: '登录墙',
    steps: [
      { t: 'open_url', url: `${HERE_URL}/login` },
      { t: 'read_page' },
      // 账号是普通框，AI 填得进去（和手机号一样，用来做"只拦敏感那一类"的对照）
      { t: 'type', target: '账号', text: 'demo-user' },
      // 密码是敏感框：服务端会把它换成 ask(sensitive_field) ⇒ 页面又像登录墙 ⇒ 弹「登录墙」求助卡
      { t: 'type', target: '密码', text: 'hunter2-not-real' },
      { t: 'read_page' },
      { t: 'click', target: '登录' },
      { t: 'read_page' },
    ],
  },
  {
    // ★ 阶段2 实验 A（2026-09-21）：**点了要等 30 秒才有结果**的按钮。
    //   产品的「手」20 秒就超时（EXEC_TIMEOUT_MS），所以一定会先报"这一步没完成"，
    //   但那一下点击其实已经发出去了 —— 要量的就是这个"超时 ≠ 没执行"。
    //   ★ 放在数组最后：既有目标都不含这两个关键词，不受影响。
    key: '慢响应',
    steps: [
      { t: 'open_url', url: `${HERE_URL}/slowclick` },
      { t: 'read_page' },
      { t: 'click', target: '提交申请' },
      { t: 'read_page' },
      { t: 'read_page' },
    ],
  },
  {
    // ★ 阶段2 实验 B（2026-09-21）：**点了永远没反应**的按钮，看 AI 会连点几次才问。
    //   产品侧：每次 noChange → staleClicks+1；==2 出「我再试一次」提示；>=3 触发提问。
    //   这里给足 6 次点击余量，好量出它到底在第几次停手。
    key: '没反应',
    steps: [
      { t: 'open_url', url: `${HERE_URL}/nochange` },
      { t: 'read_page' },
      { t: 'click', target: '重新加载数据' },
      { t: 'read_page' },
      { t: 'click', target: '重新加载数据' },
      { t: 'read_page' },
      { t: 'click', target: '重新加载数据' },
      { t: 'read_page' },
      { t: 'click', target: '重新加载数据' },
      { t: 'read_page' },
      { t: 'click', target: '重新加载数据' },
      { t: 'read_page' },
      { t: 'click', target: '重新加载数据' },
      { t: 'read_page' },
    ],
  },
  {
    // ★ 阶段2 实验 B2（2026-09-21）：和上面同一颗"点了没反应"的按钮，
    //   但**连续点、中间不夹 read_page**。
    //
    //   为什么必须再做一个变体：B1（夹 read_page）跑出来是"点了 6 次也没提问"。
    //   这有两种解释，不能混着下结论：
    //     ① 那个「连点 3 次就提问」的守卫根本没用；
    //     ② 守卫有用，但 B1 的时序根本走不到它 —— 中间夹的 read_page 会把
    //        staleClicks 清零（agent.ts 里 res.ok && !res.noChange 那一行）。
    //   所以用一个"真·连点"的剧本把条件直接构造出来，才能分清是哪种。
    key: '连点无缝',
    steps: [
      { t: 'open_url', url: `${HERE_URL}/nochange` },
      { t: 'read_page' },
      { t: 'click', target: '重新加载数据' },
      { t: 'click', target: '重新加载数据' },
      { t: 'click', target: '重新加载数据' },
      { t: 'click', target: '重新加载数据' },
      { t: 'click', target: '重新加载数据' },
      { t: 'click', target: '重新加载数据' },
    ],
  },
];

function planFor(goal) {
  for (const p of PLANS) {
    if (String(goal).includes(p.key)) return p;
  }
  return null;
}

/**
 * 从**最后一条工具回执**里把「执行后的当前页」抠出来。
 *
 * 为什么需要：暂停期间用户可能已经把某一步做完了（验证码场景就是：他自己填完并提交，
 * 页面变成「验证通过」）。这时候剧本里那条「点提交验证」已经点不到了，
 * 真模型看得懂快照、会跳过；假模型只会按序号硬点，结果一路点到「连续失败 → 等用户指导」，
 * 把一个本来很漂亮的场景演示成失败。所以让它也看一眼快照再决定走哪一步。
 */
function lastSnapshot(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || m.role !== 'tool') continue;
    const c = typeof m.content === 'string' ? m.content : '';
    const at = c.indexOf('执行后的当前页：');
    if (at < 0) continue;
    const blk = c.slice(at);
    const pick = (label) => {
      const mm = new RegExp(label.replace(/[()（）]/g, (x) => '\\' + x) + ': (.*)').exec(blk);
      return mm ? mm[1] : '';
    };
    return {
      url: pick('url'), title: pick('title'),
      buttons: pick('可见按钮'), links: pick('可见链接'),
      inputs: pick('可见输入框'), texts: pick('页面可见正文（片段，最多 40 条）'),
    };
  }
  return null;
}

/** 剧本里这一步要操作的东西，在当前页上还找得到吗？找不到就说明用户已经做过了 → 跳过 */
function targetPresent(snap, target) {
  if (!snap) return true;
  return [snap.buttons, snap.links, snap.inputs, snap.texts].join(' | ').includes(target);
}

/** 每个目标已经走到剧本第几步了（防止「跳过」之后步号回退、同一句「第 N 步」连着说两遍） */
const LASTSTEP = new Map();

/** 按剧本生成第 step 步，**并跳过当前页上已经不存在的操作** */
function planStepSmart(plan, goal, step, messages) {
  const snap = lastSnapshot(messages);
  let s = Math.max(step, (LASTSTEP.get(goal) || 0) + 1);
  for (let guard = 0; guard <= plan.steps.length; guard += 1) {
    if (s > plan.steps.length) return null;
    const st = plan.steps[s - 1];
    const needsTarget = st.t === 'click' || st.t === 'type';
    if (needsTarget && !targetPresent(snap, st.target)) { s += 1; continue; }
    LASTSTEP.set(goal, s);
    return planStep(plan, goal, s);
  }
  return null;
}

/** 按剧本生成一条消息（第 step 步，1 起） */
function planStep(plan, goal, step) {
  if (step > plan.steps.length) return null;
  const s = plan.steps[step - 1];
  const say = {
    open_url: `第 ${step} 步：先打开商城页面。`,
    read_page: `第 ${step} 步：读一下当前页面。`,
    type: `第 ${step} 步：在「${s.target}」里填 ${s.text}。`,
    click: `第 ${step} 步：点「${s.target}」。`,
    scroll: `第 ${step} 步：往下滚一屏看看。`,
  }[s.t] || `第 ${step} 步。`;
  const args = s.t === 'open_url' ? { url: s.url }
    : s.t === 'type' ? { target: s.target, text: s.text }
      : s.t === 'click' ? { target: s.target }
        : s.t === 'scroll' ? { direction: s.direction } : {};
  return { goal, step, kind: s.t, message: { role: 'assistant', content: say,
    tool_calls: [toolCall(`call_${Date.now()}_${step}`, s.t, args)] } };
}

/**
 * 恢复后的「人话反应」。
 *
 * 为什么要有它：体验报告要给客户看「AI 继续时**说了什么**」。
 * 真模型会自己组织语言；假模型只会按剧本走，不说人话的话截图里就是干巴巴的
 * 「第 N 步：读一下当前页面」，看不出方案 B 到底有没有「重新感知」。
 * 所以这里让假模型**按服务端 delta 的判定**说出对应的话 —— 话是假的，
 * 但「它依据的是服务端真实判定出来的 delta」这一点是真的。
 */
function resumeReaction(messages) {
  // 找最后一条 user 消息（恢复简报是 append 进去的）以及它后面已经回过几条 tool
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i] && messages[i].role === 'user') { lastUserIdx = i; break; }
  }
  if (lastUserIdx < 0) return null;
  const last = messages[lastUserIdx];
  const content = typeof last.content === 'string' ? last.content : '';
  // 两种恢复简报都要认：① 用户按了暂停再继续；② AI 停下来问你、你回答之后再继续
  const RESUMED = /你刚刚被用户暂停，现在已恢复|我刚才停下来问了你一个问题，现在继续/;
  if (!RESUMED.test(content)) return null;
  // ★ 判据必须是「我（模型）在恢复之后**还没说过话**」，不能是「后面有没有 tool 回执」。
  //   实测：服务端 append 完恢复简报后，桌面端会先补一次「重新读取真实页面」，
  //   那条 tool 回执就落在简报后面 —— 用 tool 判会把恢复后的第一句话吃掉
  //   （s1/s3/s4 三场因此全程没说过人话，只有 s2 侥幸命中）。
  for (let i = lastUserIdx + 1; i < messages.length; i += 1) {
    if (messages[i] && messages[i].role === 'assistant') return null;
  }
  let say;
  if (content.includes('这个页面没有变化')) {
    say = '我重新看了一眼：和我上次看到时一模一样，这个页面没变过。那我按原计划接着往下做。';
  } else if (content.includes('页面已经换了一张')) {
    const m = /地址从 (.+?) 变成了 (.+?)\)/.exec(content);
    const to = m ? m[2] : '别的页面';
    say = `我先重新看了一眼当前页面——**你已经不在原来那个页面了**（现在是 ${to}）。`
      + '我不会自己跳回原来的地址，那样会把你刚做的操作覆盖掉。你希望我在这张新页面上继续，还是回到原来的任务？';
    // 注意别把「和」一起写进匹配串：brief 里这段是 `和**我上次看到时**`，带 markdown 星号
  } else if (content.includes('我上次看到时') && content.includes('不一样了')) {
    say = '我重新看了一眼：地址没变，但页面内容跟**我上次看到时**不一样了。'
      + '这可能是你自己操作的，也可能是**页面自己在更新**（轮播、行情、倒计时这类都会自己变，'
      + '我分不清是哪一种，不乱猜）。不管哪种，我都按**现在看到的内容**重新判断，不会重做你已经做过的部分。';
  } else {
    say = '我重新读一下当前页面，看清现在在哪儿再决定下一步。';
  }
  return { say, content };
}

/** 决定这一步回什么（同一套规则，纯函数，方便复算） */
function decide(messages) {
  const goal = goalOf(messages);
  const done = stepsDone(messages);
  const step = done + 1;

  // 恢复后的第一步：先说出「我重新感知到了什么」+ 真去 read_page 一次
  const rr = resumeReaction(messages);
  if (rr) {
    // 页面已经跑偏（换了一张）→ 按规矩停下来问用户，而不是自作主张导航
    const offTrack = rr.content.includes('页面已经换了一张');
    if (offTrack) {
      // ★ 用户「回答」的一种方式就是**自己回到任务原本要去的那个页面**。
      //   这时候 delta 同样是 moved（地址确实变了），但语义完全不同：
      //   不是跑偏，是听懂了。看不出这一层就会把同一个问题再问一遍，
      //   用户回答一次、AI 再问一次，卡成死循环（场景 s9 实测）。
      const mUrl = /\nurl: (\S+)/.exec(rr.content);
      const cur = mUrl ? mUrl[1] : '';
      const plan0 = planFor(goal);
      const home = plan0 ? (plan0.steps.find((s) => s.t === 'open_url') || {}).url : '';
      if (home && cur && cur.replace(/\/$/, '') === String(home).replace(/\/$/, '')) {
        return {
          goal, step, kind: 'read_page',
          message: {
            role: 'assistant',
            content: '我看到你自己回到任务原本的页面了 —— 那就是选「回到原来的任务」。'
              + '我按原计划接着往下做，不重做你已经做过的部分。',
            tool_calls: [toolCall(`call_${Date.now()}_home`, 'read_page', {})],
          },
        };
      }
    }
    if (offTrack) {
      // 规矩 3：页面明显偏离目标 → stop(reason=need_user) 问用户，**不擅自导航**。
      // 空 tool_calls 不会被当成"提问"，必须显式调 stop。
      return {
        goal, step, kind: 'stop',
        message: {
          role: 'assistant',
          content: rr.say,
          tool_calls: [toolCall(`call_${Date.now()}_ask`, 'stop', {
            reason: 'need_user',
            summary: rr.say,
            question: '你希望我在这张新页面上继续，还是回到原来的任务？我不会自己跳回去，怕覆盖你刚做的操作。',
            document_title: '', document_outline: [],
          })],
        },
      };
    }
    return {
      goal, step, kind: 'read_page',
      message: {
        role: 'assistant',
        content: rr.say,
        tool_calls: [toolCall(`call_${Date.now()}_read`, 'read_page', {})],
      },
    };
  }
  // 命中场景剧本就走剧本（走完剧本才收尾）
  const plan = planFor(goal);
  if (plan) {
    const ps = planStepSmart(plan, goal, step, messages);
    if (ps) return ps;
    return {
      goal,
      step,
      kind: 'stop',
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          toolCall(`call_${Date.now()}_${step}`, 'stop', {
            reason: 'done',
            summary: `【假模型结论】目标=${goal} 已完成`,
            document_title: `验收记录 ${goal.slice(0, 20)}`,
            document_outline: [`目标：${goal}`, `步数：${done}`],
          }),
        ],
      },
    };
  }
  if (done < STEPS) {
    return { goal, step, kind: 'read_page', message: { role: 'assistant', content: `第 ${step} 步：先读当前页。`, tool_calls: [toolCall(`call_${Date.now()}_${step}`, 'read_page', {})] } };
  }
  // 结论里带上**目标前缀**：两路任务的结论因此可分辨，用来证明状态没串位
  return {
    goal,
    step,
    kind: 'stop',
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [
        toolCall(`call_${Date.now()}_${step}`, 'stop', {
          reason: 'done',
          summary: `【假模型结论】目标=${goal} 已走完 ${done} 步`,
          document_title: `验收记录 ${goal.slice(0, 20)}`,
          document_outline: [`目标：${goal}`, `步数：${done}`],
        }),
      ],
    },
  };
}

const PAGE = (title, extra = '') => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head>
<body>
  <h1>${title}</h1>
  <p>这是子阶段 A 验收用的本地测试页。</p>
  <input id="q1" type="text" placeholder="普通输入框">
  <button id="btn1">普通按钮</button>
  ${extra}
</body></html>`;

/**
 * 第 27 步（人工介入卡片）：**纯登录墙**。
 *
 * ★ 刻意做成"只有密码框、**没有任何验证码元素**"：
 *   `challengeish()` 要求「验证语义 + 落脚点」同时成立，这里两者都没有 ⇒ challengeLike=false；
 *   而 password 框让 `loginish()` 为真 ⇒ `pageNeedsHuman()` 返回 **'login'**（而不是 'captcha'）。
 *   只有这样才验得到"登录墙"这一支，否则又变成验一遍验证码。
 */
const LOGIN_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>请登录</title>
<style>body{font-family:system-ui;margin:24px}label{display:block;margin:10px 0}
input,button{padding:8px;font-size:14px}#box{padding:16px;border:1px solid #ccc;border-radius:8px}</style>
</head><body>
  <h1>请登录</h1>
  <div id="box">
    <p>登录后才能查看订单详情。</p>
    <label>账号 <input id="user1" type="text" placeholder="账号"></label>
    <label>密码 <input id="pw1" type="password" placeholder="密码"></label>
    <button id="login1">登录</button>
    <div id="msg">（未登录）</div>
  </div>
  <script>
    // 用户自己填密码并提交 → 页面换成"已登录"（标题也变）——
    // 这样"用户处理完了"的自动感知信号（导航/标题变化）在登录墙场景里同样成立。
    document.getElementById('login1').addEventListener('click', function () {
      if (!document.getElementById('pw1').value) { document.getElementById('msg').textContent = '请先输入密码'; return; }
      document.getElementById('box').innerHTML =
        '<h2>已登录</h2><p>欢迎，' + document.getElementById('user1').value + '。</p>';
      document.title = '我的订单 - 已登录';
    });
  </script>
</body></html>`;

const FORM_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>敏感闸复验页</title></head>
<body>
  <h1>敏感闸复验页</h1>
  <label>账号 <input id="u1" type="text" placeholder="账号"></label>
  <label>密码 <input id="pw1" type="password" placeholder="密码"></label>
  <label>短信验证码 <input id="otp1" type="text" placeholder="短信验证码"></label>
  <label>普通框 <input id="q1" type="text" placeholder="普通输入框"></label>
  <button id="pay1">立即支付</button>
  <button id="ok1">普通按钮</button>
</body></html>`;

/* ===========================================================================
 * 场景页（暂停/继续体验场景用）
 *
 * 设计要点：
 *   · /shop    —— 一个「多步任务」的舞台：搜索框 → 搜索按钮 → 出现结果 → 加入购物车。
 *                 点搜索后 DOM 真的会变（结果区从无到有），这样「AI 做了什么」肉眼可见。
 *   · /captcha —— 验证码卡点：手机号是普通框，**短信验证码是敏感框**（AI 代填会被
 *                 driver 的敏感守卫拒掉），这正是现实里「AI 卡住、要人来」的情形。
 *                 提交后整页换成「验证通过」—— 用户手动填完提交，页面变化必须能被
 *                 重新感知判定成 edited。
 *   · /news    —— 一个**长得完全不一样**的站（绿皮、另一个标题），
 *                 给「暂停期间我自己跳去了别的网站」这个场景当目的地。
 * ========================================================================= */
const SHOP_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>示例商城</title>
<style>body{font-family:system-ui;margin:24px}input,button{padding:8px;font-size:14px}
#result{margin-top:16px;padding:12px;border:1px solid #ddd;border-radius:8px;background:#fafafa}</style>
</head><body>
  <h1>示例商城</h1>
  <p>买点什么？</p>
  <input id="q1" type="text" placeholder="搜索商品">
  <button id="btn1">搜索</button>
  <div id="result">（还没有搜索）</div>
  <script>
    document.getElementById('btn1').addEventListener('click', function () {
      var q = document.getElementById('q1').value || '（空）';
      document.getElementById('result').innerHTML =
        '<h3>搜索「' + q + '」的结果</h3><ul><li>' + q + ' 旗舰款 ￥199</li>' +
        '<li>' + q + ' 入门款 ￥89</li></ul><button id="cart1">加入购物车</button>';
      // ★ 点完购物车留一个**明确的痕迹**，但**按钮名字不变**（还是「加入购物车」）——
      //   这样光看「按钮还在不在」是判断不出这一步做完没有的，必须读懂那行提示。
      var c = document.getElementById('cart1');
      if (c) c.addEventListener('click', function () {
        var m = document.getElementById('cartmsg');
        if (!m) { m = document.createElement('p'); m.id = 'cartmsg'; c.parentNode.appendChild(m); }
        m.textContent = '已加入购物车：' + q + ' 旗舰款 ×1（这一步已经完成了）';
      });
    });
  </script>
</body></html>`;

const DIALOG_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>示例商城</title>
<style>body{font-family:system-ui;margin:24px}input,button{padding:8px;font-size:14px}
#result{margin-top:16px;padding:12px;border:1px solid #ddd;border-radius:8px;background:#fafafa}</style>
</head><body>
  <h1>示例商城</h1>
  <p>买点什么？</p>
  <input id="q1" type="text" placeholder="搜索商品">
  <button id="btn1">搜索</button>
  <div id="result">（还没有搜索）</div>
  <script>
    document.getElementById('btn1').addEventListener('click', function () {
      var q = document.getElementById('q1').value || '（空）';
      document.getElementById('result').innerHTML =
        '<h3>搜索「' + q + '」的结果</h3><ul><li>' + q + ' 旗舰款 ￥199</li>' +
        '<li>' + q + ' 入门款 ￥89</li></ul><button id="cart1">加入购物车</button>';
    });
    // ★ 4 秒后弹一个 alert —— 它会**阻塞页面 JS**。真实网页里这种东西到处都是：
    //   Cookie 同意、登录提示、问卷、防爬验证。
    setTimeout(function () { alert('请先同意 Cookie 协议，才能继续浏览本站'); }, 4000);
  </script>
</body></html>`;

const CAPTCHA_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>登录验证</title>
<style>body{font-family:system-ui;margin:24px}label{display:block;margin:10px 0}
input,button{padding:8px;font-size:14px}#box{padding:16px;border:1px solid #ccc;border-radius:8px}</style>
</head><body>
  <h1>登录验证</h1>
  <div id="box">
    <p>为了你的账号安全，请先完成验证。</p>
    <label>手机号 <input id="phone1" type="text" placeholder="手机号"></label>
    <label>短信验证码 <input id="otp1" type="text" placeholder="短信验证码"></label>
    <button id="submit1">提交验证</button>
    <div id="msg">（等待验证）</div>
  </div>
  <script>
    document.getElementById('submit1').addEventListener('click', function () {
      var otp = document.getElementById('otp1').value;
      var phone = document.getElementById('phone1').value;
      if (!otp) { document.getElementById('msg').textContent = '请先填写验证码'; return; }
      document.getElementById('box').innerHTML =
        '<h2>验证通过</h2><p>手机号 ' + phone + ' 已通过验证。</p>' +
        '<p>下一步：确认收货地址并完成下单。</p><button id="next1">去下单</button>';
      document.title = '验证通过 - 示例商城';
    });
  </script>
</body></html>`;

const AUTO_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>示例商城</title>
<style>body{font-family:system-ui;margin:24px}input,button{padding:8px;font-size:14px}
#result{margin-top:16px;padding:12px;border:1px solid #ddd;border-radius:8px;background:#fafafa}
#ad{margin-top:12px;padding:10px;border:1px dashed #f0a;color:#a04}</style>
</head><body>
  <h1>示例商城</h1>
  <p>买点什么？</p>
  <input id="q1" type="text" placeholder="搜索商品">
  <button id="btn1">搜索</button>
  <div id="result">（还没有搜索）</div>
  <p id="ad">广告位：加载中…</p>
  <p id="stock">实时库存：--</p>
  <script>
    // ★ 这两块**用户完全没碰**，是自己每 1.5 秒变一次的：
    //   ① 轮播广告文案轮换；② 实时库存数字跳动。
    //   真实网页里到处都是这种东西（轮播图、实时行情、倒计时、自动刷新）。
    var ads = ['广告位：夏季大促 5 折起', '广告位：新人首单立减 30', '广告位：会员日 满 199 减 50'];
    var ai = 0, stock = 128;
    setInterval(function () {
      ai = (ai + 1) % ads.length;
      var ad = document.getElementById('ad');
      if (ad) ad.textContent = ads[ai];
      stock = 120 + Math.floor(Math.random() * 20);
      var st = document.getElementById('stock');
      if (st) st.textContent = '实时库存：' + stock + ' 件（每 1.5 秒自动刷新）';
    }, 1500);
    document.getElementById('btn1').addEventListener('click', function () {
      var q = document.getElementById('q1').value || '（空）';
      document.getElementById('result').innerHTML =
        '<h3>搜索「' + q + '」的结果</h3><ul><li>' + q + ' 旗舰款 ￥199</li>' +
        '<li>' + q + ' 入门款 ￥89</li></ul><button id="cart1">加入购物车</button>';
    });
  </script>
</body></html>`;

// ---- 阶段2 实验页（2026-09-21）----
// ★ 这两个页面是**故意造出来的**，用处和真机验收的真实站不一样：
//   真机验收要的是"真实地形"（真网络、真 TLS、真 DOM），所以跑去 example.com；
//   这两个实验要的是**把时序钉死成常量** —— "点了要等 30 秒"和"点了永远没反应"
//   在真实网站上没法按需复现，只能造。用户也是这么要求的：
//   「实验A 造『点击后30秒才响应』的页面」「实验B 让AI在『点了页面毫无变化』的页面连点」。

const SLOWCLICK_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>申请单 - 示例</title>
<style>body{font-family:system-ui;margin:24px}button{padding:10px 16px;font-size:15px}
#out{margin-top:16px;padding:10px;border:1px solid #ddd;background:#fafafa}</style>
</head><body>
  <h1>申请单</h1>
  <p>点下面这颗按钮提交申请。（这个站处理得慢，要点完等一会儿才出结果。）</p>
  <button id="go">提交申请</button>
  <div id="out">（还没提交）</div>
  <script>
    document.getElementById('go').addEventListener('click', function () {
      // ★ 关键：点击**立刻**上报一次 —— 这就是"动作确实发生了"的服务端侧证据。
      //   之后才跳到那个要 30 秒才回的结果页（让工具的 20 秒超时先触发）。
      fetch('/__click?p=slowclick&t=' + Date.now());
      document.getElementById('out').textContent = '已提交，正在处理…';
      location.href = '/slowresult?t=' + Date.now();
    });
  </script>
</body></html>`;

const SLOW_RESULT_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>已受理 - 示例</title>
<style>body{font-family:system-ui;margin:24px}</style>
</head><body>
  <h1>已受理</h1>
  <p>你的申请已经受理，受理编号 A-<span id="no">0001</span>。</p>
  <p>（这一页是服务端延迟 30 秒之后才返回的。）</p>
</body></html>`;

const NOCHANGE_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>控制台 - 示例</title>
<style>body{font-family:system-ui;margin:24px}button{padding:10px 16px;font-size:15px}
#out{margin-top:16px;padding:10px;border:1px solid #ddd;background:#fafafa}</style>
</head><body>
  <h1>控制台</h1>
  <p>下面这颗按钮点了之后，页面上<b>什么都不变</b>。真实网站里这种按钮到处都是：
     点了只是唤起手机 App、被弹层挡住、或者当前账号没权限。</p>
  <button id="again">重新加载数据</button>
  <div id="out">（还没有任何变化）</div>
  <script>
    document.getElementById('again').addEventListener('click', function () {
      // 只上报计数，**一点可见的东西都不改** —— 让 AI 那边每次都判成 noChange。
      fetch('/__click?p=nochange&t=' + Date.now());
    });
  </script>
</body></html>`;

const NEWS_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>每日新闻 - 完全另一个网站</title>
<style>body{font-family:system-ui;margin:0;background:#0b6b3a;color:#fff}
header{padding:20px;background:#084c29;font-size:22px;font-weight:700}
main{padding:20px}article{margin-bottom:14px;padding:10px;background:rgba(255,255,255,.1);border-radius:6px}</style>
</head><body>
  <header>每日新闻</header>
  <main>
    <article><h3>今日要闻一</h3><p>这是一个和商城完全无关的网站。</p></article>
    <article><h3>今日要闻二</h3><p>用来验证「暂停期间我跳到别处去了」。</p></article>
    <article><h3>今日要闻三</h3><p>AI 继续时应该发现：自己不在原来那个页面了。</p></article>
  </main>
</body></html>`;

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => resolve(raw));
  });
}

/* ===========================================================================
 * Phase 3 · 登录态测试站（**纯增量**：下面这些都是新路由，上面 2a/2b/desk 用到的
 *   /page-* / /form / /health / chat-completions 一律没动）
 *
 * 它存在的理由：验证「登录态隔离粒度」不能靠猜，得有一个**真站点**：
 *   - /sid?name=X   —— 真的下发一个 `Set-Cookie: wbsid=X`，并在页面里写 localStorage
 *   - /whoami?name=X —— 一个**只读**页面：把「服务端看到的 cookie」和「页面读到的
 *     cookie / localStorage」都渲染出来，还会挂一个真下载链接
 *   - /dl?name=X    —— 真的回一个 Content-Disposition: attachment，触发 Electron 的下载落盘
 *
 * 每个请求都写进 SITE_LOG：**服务端收到的那份 cookie 是原始证据**
 * —— 「同项目的 B 打开就是登录态」「跨项目的 B 打开是游客」都不用听界面说，看这里。
 * ========================================================================= */

/** 测试站点页：把当前会话状态渲染出来 + 一个真下载链接 */
function sitePage(name) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>登录态测试站</title></head>
<body>
  <h1 id="h1">登录态测试站</h1>
  <p id="state">…</p>
  <p>本页身份标记：<b id="who">${name}</b></p>
  <p><a id="dl" href="/dl/${name}">下载一个归属测试文件</a></p>
  <button id="relogin" type="button">以「${name}」身份登录（写 cookie + localStorage）</button>
  <script>
    var NAME = ${JSON.stringify(name)};
    function render() {
      var cookie = document.cookie || '';
      var local = localStorage.getItem('wbwho') || '';
      var sid = (cookie.match(/(?:^|;\\s*)wbsid=([^;]+)/) || [])[1] || '';
      document.getElementById('state').textContent =
        (sid ? 'LOGGED-IN sid=' + sid : 'GUEST sid=') + ' | local=' + (local || '(空)');
      window.__site = { name: NAME, cookie: cookie, local: local, sid: sid,
                        href: location.href, at: Date.now() };
    }
    document.getElementById('relogin').addEventListener('click', function () {
      localStorage.setItem('wbwho', NAME);
      fetch('/sid/' + encodeURIComponent(NAME), { credentials: 'include' })
        .then(function () {
          // 登录后**重新走一次这个地址**（而不是只 render）：这样站点侧会再收到一条
          // 带新 cookie 的 /whoami 请求，「服务端看到的是谁」与页面侧才是同一次事实。
          location.reload();
        });
    });
    render();
  </script>
</body></html>`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const cookieHeader = req.headers.cookie || '';
  /**
   * Phase 3：站点的身份标记走**路径**（/whoami/<name>）而不是 query ——
   * 渲染层「打开 <地址>」的识别正则不含 `?`，带 query 的地址会被截断。
   * 两种写法都认，路径优先。
   */
  const argName = url.pathname.split('/').filter(Boolean)[1] || url.searchParams.get('name') || 'anon';
  const route = url.pathname.startsWith('/sid') ? '/sid'
    : url.pathname.startsWith('/whoami') ? '/whoami'
      : url.pathname.startsWith('/dl') ? '/dl' : '';

  // ---- Phase 3 登录站：所有请求先落一条原始日志（带服务端实际收到的 cookie）----
  if (route) {
    logSite({
      path: route,
      routePath: url.pathname,
      name: argName,
      cookie: cookieHeader,
      sid: sidOf(cookieHeader),
      ua: String(req.headers['user-agent'] || '').slice(0, 60),
    });
  }

  /** 登录：真的下发 cookie（非 HttpOnly，页面自己也读得到，两条证据能对上） */
  if (req.method === 'GET' && route === '/sid') {
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'set-cookie': `wbsid=${encodeURIComponent(argName)}; Path=/; Max-Age=3600`,
    });
    res.end(`sid=${argName}`);
    return;
  }

  /** 只读的「我是谁」页：cookie / localStorage / 服务端视角三样都摆出来 */
  if (req.method === 'GET' && route === '/whoami') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(sitePage(argName));
    return;
  }

  /** 下载：回 attachment，触发 Electron 的 will-download（落盘归属在那边算） */
  if (req.method === 'GET' && route === '/dl') {
    const body = `Phase 3 归属测试文件\n触发者标记：${argName}\n服务端看到的 sid：${sidOf(cookieHeader) || '(无)'}\n`;
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename="wb3-${argName}.txt"`,
    });
    res.end(body);
    return;
  }

  // ---- 重页（供 Phase 4 第 7 节的「自然负载」用）----
  //
  // 为什么需要它：验收用的 /page-* 只有 3~4 个正文节点，而驱动员的 read_page 最多要抓
  // **1500 个正文节点**（driver 里 `h1..p/li/td` 的选择器 + cap 1500）——
  // 真实站点通常几百到几千个，所以只拿 5 行的验收页去量"跑任务的资源成本"，
  // 量到的是**下界**，甚至可能低估一个数量级。
  // 这里按 n 生成正文节点（默认 2000 → 正好吃满 1500 的 cap），用来对照同一并发下
  // 「页变重」对整机 CPU 的影响。**只新增路由，不动 /page-***。
  if (req.method === 'GET' && url.pathname.startsWith('/page-heavy-')) {
    const n = Math.max(1, Math.min(6000, Number(url.pathname.slice('/page-heavy-'.length)) || 2000));
    const rows = [];
    for (let i = 0; i < n; i += 1) {
      rows.push(`<h3>重页小节 ${i + 1}</h3><p>第 ${i + 1} 段正文：真实站点的一屏内容，用来让快照抽取有真东西可抽。</p>`);
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>重页 HEAVY-${n}-${argName}</title></head>
<body><h1>重页 ${n} 节点</h1><p>这是给「自然负载」用的重页。</p>${rows.join('')}</body></html>`);
    return;
  }

  // ---- 测试页 ----
  if (req.method === 'GET' && url.pathname.startsWith('/page-')) {
    const name = url.pathname.slice(1);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE(`验收页 ${name.toUpperCase()}`));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/form') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(FORM_PAGE);
    return;
  }
  // 第 27 步：纯登录墙（只有密码框，没有验证码元素）—— 验"登录墙"那一支
  if (req.method === 'GET' && url.pathname === '/login') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(LOGIN_PAGE);
    return;
  }

  // ---- 场景页（给「暂停/继续」五个体验场景用）----
  // 都是**新路由**，/page-* / /form / /health / chat-completions 一律没动。
  if (req.method === 'GET' && url.pathname === '/shop') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(SHOP_PAGE);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/captcha') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(CAPTCHA_PAGE);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/news') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(NEWS_PAGE);
    return;
  }
  // 场景 s16：会弹 alert 的商城页（4 秒后弹一个对话框，模拟 Cookie 同意 / 登录提示）
  if (req.method === 'GET' && url.pathname === '/dialog') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(DIALOG_PAGE);
    return;
  }
  // 场景 s14：一张**自己会动**的商城页 —— 实时库存数字 + 轮播广告，每 1.5 秒自己变一次。
  if (req.method === 'GET' && url.pathname === '/auto') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(AUTO_PAGE);
    return;
  }

  // ---- 阶段2 实验页路由（2026-09-21）----

  // 实验 A 的起点：一颗「点完要等 30 秒」的按钮
  if (req.method === 'GET' && url.pathname === '/slowclick') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(SLOWCLICK_PAGE);
    return;
  }
  // 实验 A 的结果页：★ 故意延迟 SLOW_MS 才回，让产品的 20 秒工具超时先触发
  if (req.method === 'GET' && url.pathname === '/slowresult') {
    await sleep(SLOW_MS);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(SLOW_RESULT_PAGE);
    return;
  }
  // 实验 B：一颗点了**永远没反应**的按钮
  if (req.method === 'GET' && url.pathname === '/nochange') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(NOCHANGE_PAGE);
    return;
  }
  // 上报一次点击（页面内 fetch）—— 服务端侧的"这一下到底点没点上"
  if (req.method === 'GET' && url.pathname === '/__click') {
    const p = url.searchParams.get('p') || '?';
    CLICKS[p] = (CLICKS[p] || 0) + 1;
    log({ ev: 'click', p, n: CLICKS[p], t: Number(url.searchParams.get('t') || 0) });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  // 读计数（实验脚本用）
  if (req.method === 'GET' && url.pathname === '/__clicks') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, clicks: CLICKS }));
    return;
  }

  // ---- 模型接口 ----
  if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
    const raw = await readBody(req);
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      /* 解析不了就当空 */
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const plan = decide(messages);
    const entered = Date.now();
    if (DUMP) {
      // 只记最后一条用户消息（提示词里「现在是什么情况」那一段就在那儿）
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i];
        if (m && m.role === 'user' && typeof m.content === 'string') {
          log({ ev: 'reqdump', goal: plan.goal, step: plan.step, msg: m.content.slice(0, 4000) });
          break;
        }
      }
    }
    log({ ev: 'req', goal: plan.goal, step: plan.step, kind: plan.kind });
    await sleep(DELAY_MS);
    log({ ev: 'res', goal: plan.goal, step: plan.step, kind: plan.kind, dur: Date.now() - entered });

    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      const payload = { choices: [{ delta: { content: plan.message.content || '' }, index: 0 }] };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ id: 'fake', object: 'chat.completion', model: body.model || 'fake', choices: [{ index: 0, message: plan.message, finish_reason: 'tool_calls' }] }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, fake: true, delayMs: DELAY_MS, steps: STEPS }));
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[fake-llm] http://127.0.0.1:${PORT} delay=${DELAY_MS}ms steps=${STEPS} log=${LOG || '(无)'}`);
});
