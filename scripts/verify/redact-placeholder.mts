/**
 * 收尾 6 补丁 | 脱敏占位符「N 字」的正确性（用户 2026-09-24 报的 bug）
 * =====================================================================
 *
 * 报的现象（`GET /agent/task/current` 的 `displayTitle` 真实返回样本）：
 *   `密码Zx9!secret`（10 位）        → `[已脱敏·password·10字]` ✅
 *   `银行卡6222021234567890`（16 位）→ `[已脱敏·card·79字]`     ❌
 *   `身份证110101199003071234`（18 位）→ `[已脱敏·card·79字]`   ❌
 *
 * 根因（**不是**正则贪婪多吞了字符，探针逐条打印过回调实参）：
 *   `String.replace` 回调的实参形状随「正则有没有捕获组」而变 ——
 *     · `password` / `otp` / `cvv` 三条带 2 个捕获组 → `(match, g1, g2, offset, string)`，5 个实参，
 *       旧代码取 `m[2]` 正好是**值** → 字数对；
 *     · `card` / `idcard` 两条用的是 `(?:…)` **非捕获**组 → `(match, offset, string)`，只有 3 个实参，
 *       旧代码取 `m[1]` 拿到 offset（数字，被 `typeof === 'string'` 挡掉 → 前缀空），
 *       取 `m[2]` 拿到的是 **整个输入串** → 字数变成「整句话的长度」。
 *   那个 79 是**上一轮 password 替换之后**整串的长度（原文 71 字，password 那一步把它改成 79 字），
 *   所以看起来像「后一次替换用了已被前一次改写过的字符串」—— 用户的这个判断方向是对的，
 *   只是机制不是「贪婪匹配」，而是「长度取错了来源」。正则本身一个字符都没多吞（见第 ③ 段反例）。
 *
 * 修法：按实参形状还原捕获组个数（`m.length - 3 - 命名组`），无捕获组时用 `match` 本身当被替换段。
 *
 * 用户要求补的三组断言，本脚本逐条落地：
 *   ① 占位符字数必须等于**被替换原文的实际长度**；
 *   ② 多个敏感值连排时，每个占位符字数**各自**正确（不是全都等于整句长度）；
 *   ③ 反例证明贪婪匹配不会吞掉非敏感内容（数字串两侧的中文/英文/短数字/标点一个字节不动）。
 * 另加第 ④ 段：`scrubTaskText` 的「」形状与 `taskDisplayTitle` 的 80 字上限 / 非空兜底。
 *
 * 跑的是生产代码本体（`apps/server/src/orchestrator/redact.ts`），不是副本：
 *   npm run verify:redact        （已挂进 npm run verify 主链）
 *
 * ★ 断言一律用**整串精确相等**，不用 `includes`：
 *   `includes('已脱敏')` 这种断言在字数错成 79 时照样绿 —— 那正是这个 bug 能溜过去的原因。
 */
import { redactForStorage, scrubTaskText, taskDisplayTitle } from '../../apps/server/src/orchestrator/redact';

let passes = 0;
let fails = 0;
const log = (...a: unknown[]) => console.log(a.map(String).join(' '));

function check(label: string, fn: () => void): void {
  try {
    fn();
    passes += 1;
    log(`  PASS ${label}`);
  } catch (err) {
    fails += 1;
    log(`  ★FAIL ${label}  —— ${(err as Error).message}`);
  }
}

function eq(actual: unknown, expected: unknown, msg = ''): void {
  if (actual !== expected) throw new Error(`${msg}\n      实际：${JSON.stringify(actual)}\n      期望：${JSON.stringify(expected)}`);
}

/** 把输出里所有占位符的 (tag, 字数) 按出现顺序抠出来 */
function placeholders(out: string): Array<{ tag: string; len: number }> {
  return [...out.matchAll(/\[已脱敏·([A-Za-z]+)·(\d+)字\]/g)].map((m) => ({ tag: m[1], len: Number(m[2]) }));
}

/** 一条用例：输入、被替换掉的原文（可能多段）、期望的**整串**输出、期望的占位符序列 */
interface Case {
  label: string;
  input: string;
  secrets: string[];
  expected: string;
  want: Array<{ tag: string; len: number }>;
}

/**
 * 通用三连断言：整串精确相等 + 原值一个不剩 + 每个占位符字数等于被替换原文的实际长度。
 * 三段缺一不可：只断「相等」看不出字数错在哪，只断「字数」看不出有没有多吞字符。
 */
function runCase(c: Case): void {
  const out = redactForStorage(c.input);
  log(`      in ：${c.input}`);
  log(`      out：${out}`);
  check(`${c.label}：整串精确相等（不是 includes）`, () => eq(out, c.expected));
  check(`${c.label}：被替换的原文一个字符都不剩`, () => {
    for (const s of c.secrets) if (out.includes(s)) throw new Error(`输出里还留着原值「${s}」`);
  });
  check(`${c.label}：占位符字数 == 被替换原文的实际长度（${c.want.map((w) => `${w.tag}·${w.len}字`).join('、')}）`, () => {
    const got = placeholders(out);
    eq(got.length, c.want.length, '占位符个数不对');
    got.forEach((g, i) => {
      eq(g.len, c.want[i].len, `第 ${i + 1} 个占位符的字数不对（tag=${g.tag}）`);
      eq(g.tag, c.want[i].tag, `第 ${i + 1} 个占位符的类别不对`);
    });
  });
}

log('=== 收尾6 补丁 · 脱敏占位符字数正确性（生产代码本体）===');

// ------------------------------------------------------------------ ① 单个敏感值：字数 == 被替换原文长度
log('');
log('--- ① 占位符字数必须等于被替换原文的实际长度（每条 pattern 各一例，整串精确比对）---');
{
  const cases: Case[] = [
    {
      label: 'password（中文「密码」+ 值）',
      input: '登录用 密码Zx9!secret，别的不该动',
      secrets: ['Zx9!secret'],
      expected: '登录用 密码[已脱敏·password·10字]，别的不该动',
      want: [{ tag: 'password', len: 10 }],
    },
    {
      label: 'password（英文 pwd: 值）',
      input: 'pwd: hunter2secret end',
      secrets: ['hunter2secret'],
      expected: 'pwd: [已脱敏·password·13字] end',
      want: [{ tag: 'password', len: 13 }],
    },
    {
      label: 'otp（验证码 6 位）',
      input: '发送验证码 839201 给用户',
      secrets: ['839201'],
      expected: '发送验证码 [已脱敏·otp·6字] 给用户',
      want: [{ tag: 'otp', len: 6 }],
    },
    {
      label: 'card（16 位，用户报的那条）',
      input: '卡号 6222021234567890 结束',
      secrets: ['6222021234567890'],
      expected: '卡号 [已脱敏·card·16字] 结束',
      want: [{ tag: 'card', len: 16 }],
    },
    {
      label: 'card（13 位 = 下限）',
      input: '订单 1234567890123 号',
      secrets: ['1234567890123'],
      expected: '订单 [已脱敏·card·13字] 号',
      want: [{ tag: 'card', len: 13 }],
    },
    {
      label: 'card（19 位）',
      input: '卡号 1234567890123456789 结束',
      secrets: ['1234567890123456789'],
      expected: '卡号 [已脱敏·card·19字] 结束',
      want: [{ tag: 'card', len: 19 }],
    },
    {
      label: 'card（20 位 = 上限）',
      input: '卡号 12345678901234567890 结束',
      secrets: ['12345678901234567890'],
      expected: '卡号 [已脱敏·card·20字] 结束',
      want: [{ tag: 'card', len: 20 }],
    },
    {
      label: 'card（空格分组：分隔符算在被替换原文里）',
      input: '卡号 6222 0212 3456 7890 结束',
      secrets: ['6222 0212 3456 7890', '6222021234567890'],
      // 19 = 16 位数字 + 3 个空格。语义是「被替换掉的那段原文有多长」，分隔符确实被替换掉了，
      // 所以算进去才是如实的（报 16 反而对不上用户看到的原文长度）。
      expected: '卡号 [已脱敏·card·19字] 结束',
      want: [{ tag: 'card', len: 19 }],
    },
    {
      label: 'card（横线分组）',
      input: '卡号 6222-0212-3456-7890 结束',
      secrets: ['6222-0212-3456-7890'],
      expected: '卡号 [已脱敏·card·19字] 结束',
      want: [{ tag: 'card', len: 19 }],
    },
    {
      label: 'idcard（末位 X，只有这条 pattern 认它）',
      input: '实名 11010119900307888X 结束',
      secrets: ['11010119900307888X'],
      expected: '实名 [已脱敏·idcard·18字] 结束',
      want: [{ tag: 'idcard', len: 18 }],
    },
    {
      label: 'idcard（18 位纯数字，用户报的另一条）',
      input: '实名 110101199003071234 结束',
      secrets: ['110101199003071234'],
      // 类别标成 card 而不是 idcard：card 那条（13~20 位）排在前面先命中了。
      // 标签只是给人看的类别名、不含内容，本批不动顺序（改顺序会连带改 detectSensitive 的判定类别）。
      expected: '实名 [已脱敏·card·18字] 结束',
      want: [{ tag: 'card', len: 18 }],
    },
    {
      label: 'cvv（3 位）',
      input: 'CVV 739 校验通过',
      secrets: ['739'],
      expected: 'CVV [已脱敏·card·3字] 校验通过',
      want: [{ tag: 'card', len: 3 }],
    },
  ];
  for (const c of cases) runCase(c);

  // 字数是「被替换原文」的长度，不是「占位符自己」的长度 —— 这两者在无上下文时最容易被搞混
  const bare = redactForStorage('6222021234567890');
  log(`      纯卡号无上下文 → ${JSON.stringify(bare)}（占位符自身 ${[...bare].length} 字）`);
  check('①-补：整句就是一个卡号时，报的是原文 16 字，不是占位符自己的 14 字', () => {
    eq(bare, '[已脱敏·card·16字]');
    eq(placeholders(bare)[0].len, 16);
  });
}

// ------------------------------------------------------------------ ② 多个敏感值连排：每个占位符各自正确
log('');
log('--- ② 多个敏感值连排时，每个占位符字数各自正确（不许全都等于整句长度）---');
{
  const BUG_GOAL = '帮我查一下 银行卡6222021234567890 的余额，登录用 密码Zx9!secret，实名 身份证110101199003071234';
  const BUG_OUT = redactForStorage(BUG_GOAL);
  log(`      in ：${BUG_GOAL}（${[...BUG_GOAL].length} 字）`);
  log(`      out：${BUG_OUT}`);
  check('②-1：用户报的那句原话，三个占位符字数分别是 16 / 10 / 18', () => {
    eq(
      BUG_OUT,
      '帮我查一下 银行卡[已脱敏·card·16字] 的余额，登录用 密码[已脱敏·password·10字]，实名 身份证[已脱敏·card·18字]',
    );
    const got = placeholders(BUG_OUT).map((x) => `${x.tag}·${x.len}`);
    eq(got.join(','), 'card·16,password·10,card·18');
  });
  check('②-2：回归钉 —— 输出里不许再出现「整句长度」那个数（bug 的形状是三个都报 79）', () => {
    const lens = placeholders(BUG_OUT).map((x) => x.len);
    for (const bad of [79, 71, [...BUG_GOAL].length, [...BUG_OUT].length]) {
      if (lens.includes(bad)) throw new Error(`有占位符报了整句长度 ${bad}：${JSON.stringify(lens)}`);
    }
    if (new Set(lens).size !== lens.length) throw new Error(`三个字数全一样了（${JSON.stringify(lens)}），像是又取了整串长度`);
  });
  check('②-3：三个敏感值一个不剩', () => {
    for (const s of ['6222021234567890', 'Zx9!secret', '110101199003071234']) {
      if (BUG_OUT.includes(s)) throw new Error(`还留着「${s}」`);
    }
  });

  const two = redactForStorage('卡号 6222021234567890 实名 110101199003071234 结束');
  log(`      两串数字只隔一个空格 → ${two}`);
  check('②-4：两个数字串中间只有一个空格时，各自成一段（16 与 18），不被并成一段', () => {
    eq(two, '卡号 [已脱敏·card·16字] 实名 [已脱敏·card·18字] 结束');
  });

  const otptwo = redactForStorage('验证码 839201 与 短信码 778899 都要填');
  log(`      两个验证码连排 → ${otptwo}`);
  check('②-5：同类别连排两个值，两个占位符各报自己的 6 字（不是第二个报整串长度）', () => {
    eq(otptwo, '验证码 [已脱敏·otp·6字] 与 短信码 [已脱敏·otp·6字] 都要填');
  });

  const mixed = redactForStorage('密码Zx9!secret 卡号 6222021234567890 验证码 839201 实名 11010119900307888X CVV 739');
  log(`      五类混排 → ${mixed}`);
  check('②-6：五类混排，字数依次 10 / 16 / 6 / 18 / 3，各自对应自己那段', () => {
    eq(
      placeholders(mixed).map((x) => x.len).join(','),
      '10,16,6,18,3',
    );
    for (const s of ['Zx9!secret', '6222021234567890', '839201', '11010119900307888X', '739']) {
      if (mixed.includes(s)) throw new Error(`还留着「${s}」`);
    }
  });
}

// ------------------------------------------------------------------ ③ 反例：贪婪匹配不许吞掉非敏感内容
log('');
log('--- ③ 反例：贪婪匹配不会吞掉非敏感内容（两侧文本必须逐字节原样）---');
{
  const mixed = redactForStorage('余额 12345 元，卡号 6222021234567890，备注 hello world，订单 A-99，第3章');
  log(`      out：${mixed}`);
  check('③-1：只有 16 位卡号被替换，两侧中文/英文/短数字/标点全部逐字节原样', () => {
    eq(mixed, '余额 12345 元，卡号 [已脱敏·card·16字]，备注 hello world，订单 A-99，第3章');
  });

  check('③-2：完全不含敏感值的句子，输出与输入逐字节相同（一个占位符都不该有）', () => {
    const plain = '把报表发到工作群，然后订正第 3 章的 12 处笔误';
    eq(redactForStorage(plain), plain);
    eq(placeholders(redactForStorage(plain)).length, 0);
  });

  check('③-3：数字串紧贴中文（无空格）也只吞数字，中文不被带走', () => {
    eq(redactForStorage('卡号6222021234567890元'), '卡号[已脱敏·card·16字]元');
  });

  check('③-4：两个数字串中间夹中文时不跨接（「和」字与两侧空格都在）', () => {
    eq(redactForStorage('6222021234567890 和 110101199003071234'), '[已脱敏·card·16字] 和 [已脱敏·card·18字]');
  });

  check('③-5：分组分隔符只认**单个**空格/横线 —— 双空格处不跨接（8+8 位都不到 13 位下限，整句原样）', () => {
    const dbl = '卡号 6222 0212  3456 7890 结束';
    eq(redactForStorage(dbl), dbl);
  });

  // ---- 边界钉：13~20 位才命中。范围外的**不脱敏**，这是既有缺口，钉在这里防止有人悄悄改边界 ----
  log('      边界：12 位 / 21 位 / 34 位连排（两串数字紧贴无分隔）');
  check('③-6：12 位（下限外）不脱敏 —— 短数字串是订单号/数量的常见形状，不该被涂', () => {
    const t = '订单 123456789012 号';
    eq(redactForStorage(t), t);
  });
  check('③-7：21 位（上限外）不脱敏 —— **已知缺口**：card 上限 20 位、idcard 正好 18 位，超出的连续数字串整段漏网', () => {
    const t = '流水 123456789012345678901 号';
    eq(redactForStorage(t), t, );
  });
  check('③-8：34 位连排（两个卡号紧贴无分隔）也不脱敏 —— 同一条已知缺口，钉住它，改边界的人会先看到这里', () => {
    const t = '卡号 6222021234567890110101199003071234 结束';
    eq(redactForStorage(t), t);
    log('      ↑ 这是**漏网**，不是「不需要脱敏」：真出现这种输入，明文会原样落进 payload.steps。');
    log('        没在本批修：放宽上限会把 21+ 位的订单号/流水号/时间戳也涂掉（误伤可读性），');
    log('        且 detectSensitive 用的是同一组边界，要改得两处一起改 + 重新过一遍验收。已记进验收报告「查到但没修」。');
  });
}

// ------------------------------------------------------------------ ④ scrubTaskText 与 taskDisplayTitle
log('');
log('--- ④ scrubTaskText（「」形状 + 值形状）与 taskDisplayTitle（80 字上限 / 非空兜底）---');
{
  const shaped = scrubTaskText('写入「6222021234567890」并把 密码Zx9!secret 填进去');
  log(`      out：${shaped}`);
  check('④-1：「」形状与值形状叠加时，两处字数各自正确（16 与 10）', () => {
    eq(shaped, '写入「[已脱敏·16字]」并把 密码[已脱敏·password·10字] 填进去');
  });

  const GOAL = '帮我查一下 银行卡6222021234567890 的余额，登录用 密码Zx9!secret，实名 身份证110101199003071234';
  const dt = taskDisplayTitle(GOAL);
  log(`      displayTitle：${dt}（${[...dt].length} 字）`);
  check('④-2：taskDisplayTitle 就是用户看到的那个字段，字数与 redactForStorage 一致', () => {
    eq(dt, '帮我查一下 银行卡[已脱敏·card·16字] 的余额，登录用 密码[已脱敏·password·10字]，实名 身份证[已脱敏·card·18字]');
    eq([...dt].length, 73);
  });
  check('④-3：整句都是敏感值时仍然非空（不能给界面一个空标题）', () => {
    eq(taskDisplayTitle('6222021234567890'), '[已脱敏·card·16字]');
  });
  check('④-4：空串 / 全空白回落到「任务」', () => {
    eq(taskDisplayTitle(''), '任务');
    eq(taskDisplayTitle('   '), '任务');
  });
  check('④-5：超长截到 80 字（当年 title 就是这个量级，别撑破界面）', () => {
    eq([...taskDisplayTitle('把'.repeat(120))].length, 80);
  });
  check('④-6：连续空白折叠成一个空格（显示字段不该带 \t 与多空格）', () => {
    eq(taskDisplayTitle('把  报表   发到\t工作群'), '把 报表 发到 工作群');
  });
}

log('');
log(`=== 脱敏占位符字数：PASS ${passes} / FAIL ${fails} ===`);
process.exit(fails > 0 ? 1 : 0);
