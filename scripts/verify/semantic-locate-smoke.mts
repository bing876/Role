/**
 * ADR-0004 · 浏览器深度 第二片 —— 稳健元素定位(语义定位层)验收(真驱动 core)。
 *
 * 「真」在哪(对照 ADR 验收口径):
 *   - 驱动的是**生产那份 core**(`apps/desktop/electron/semantic-locate.ts` 的 coreSemanticLocate /
 *     semanticResolveExpr),注入的解析 JS 是**单一真源**,不是副本;
 *   - 「本地测试页」= 进程内 DOM(Node `vm` **真跑**那段解析 JS),做**改版前/后两版**(换 class /
 *     换顺序 / 去掉稳定属性),验「同一语义目标两版都点中同一颗」。
 *   - **反证(只认 class 的旧定位在改版页必红)**:纯 class 选择器在改版页解析失败,而同一目标语义定位
 *     仍成功 —— 证明「抗改版」来自语义层。
 *   - 拆掉必红见 `semantic-locate-revert.py`(删稳定属性级 / 删文本+tag 级)。
 *
 * 沙箱没有 Electron 二进制、且红线禁装 headless Chromium —— 真 CDP 端到端在 `semantic-locate-live.mjs`
 * (有真二进制的机器上跑,require 编译产物走真 wc.debugger)。
 *
 * 用法:npx tsx scripts/verify/semantic-locate-smoke.mts(无需 Electron)。
 */
import vm from 'node:vm';
import { coreSemanticLocate } from '../../apps/desktop/electron/semantic-locate.ts';
import type { SemanticTarget } from '../../packages/shared/src/index.ts';

// ---------------------------------------------------------------------------
// 断言工具
// ---------------------------------------------------------------------------
let total = 0;
const fails: string[] = [];
function chk(cond: boolean, label: string, detail?: string): void {
  total++;
  if (cond) console.log('  PASS  ' + label);
  else {
    fails.push(label);
    console.log('  FAIL  ' + label + (detail ? '   ' + detail : ''));
  }
}

// ---------------------------------------------------------------------------
// 进程内「本地测试页」:最小但契约真实的 DOM
// ---------------------------------------------------------------------------
class Node {
  tag: string;
  attrs: Record<string, string> = {};
  text = '';
  children: Node[] = [];
  parent: Node | null = null;
  hidden = false;
  constructor(tag: string) {
    this.tag = tag.toUpperCase();
  }
  get id(): string {
    return this.attrs.id ?? '';
  }
  set id(v: string) {
    this.attrs.id = v;
  }
  attr(k: string): string {
    return this.attrs[k] ?? '';
  }
  setAttr(k: string, v: string): this {
    this.attrs[k] = v;
    return this;
  }
  add(child: Node): Node {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join('');
  }
  get innerText(): string {
    return this.textContent;
  }
  get isConnected(): boolean {
    return true;
  }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return this.hidden ? { left: 0, top: 0, width: 0, height: 0 } : { left: 10, top: 10, width: 100, height: 30 };
  }
  /** 子树内匹配选择器的所有节点(含自身后代,不含自身) */
  querySelectorAll(sel: string): Node[] {
    const out: Node[] = [];
    const visit = (n: Node): void => {
      for (const c of n.children) {
        if (matches(c, sel)) out.push(c);
        visit(c);
      }
    };
    visit(this);
    return out;
  }
}

/** 极简选择器匹配:tag / #id / [attr="val"] / [attr] / 逗号列表。够本片验收用。 */
function matches(el: Node, sel: string): boolean {
  return sel
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .some((part) => {
      if (part.startsWith('#')) return el.attrs.id === part.slice(1);
      if (part.startsWith('.')) return (el.attrs.class ?? '').split(/\s+/).includes(part.slice(1));
      const attrEq = part.match(/^\[([a-z-]+)="(.*)"\]$/i);
      if (attrEq) return el.attrs[attrEq[1]] === attrEq[2];
      const attrOnly = part.match(/^\[([a-z-]+)\]$/i);
      if (attrOnly) return attrOnly[1] in el.attrs;
      return el.tag === part.toUpperCase();
    });
}

interface Page {
  document: any;
  /** 直接在某上下文里跑一段表达式(旧定位/class 反证用) */
  eval: (expr: string) => unknown;
}

function makePage(body: Node): Page {
  const docEl = new Node('html');
  docEl.add(body);
  const document: any = {
    documentElement: docEl,
    querySelectorAll: (sel: string) => docEl.querySelectorAll(sel),
  };
  const context: any = {
    document,
    getComputedStyle: (el: Node) =>
      el.hidden ? { visibility: 'visible', display: 'none', opacity: 1 } : { visibility: 'visible', display: 'block', opacity: 1 },
  };
  context.window = context; // 页里 window.x 与全局 x 同一份
  vm.createContext(context);
  const page: Page = {
    document,
    eval: (expr: string) => vm.runInContext(expr, context, { timeout: 1000 }),
  };
  return page;
}

/** 把进程内页包装成一个「CDP send」:Runtime.evaluate 真的在页里跑表达式。 */
function cdpFor(page: Page) {
  return async (method: string, params?: unknown): Promise<unknown> => {
    if (method === 'Runtime.evaluate') {
      const p = (params ?? {}) as { expression: string };
      try {
        const value = page.eval(p.expression);
        return { result: { value } };
      } catch (e) {
        return { exceptionDetails: { text: String(e) } };
      }
    }
    return {};
  };
}

// ---------------------------------------------------------------------------
// 三版本地测试页(改版前 / 改版后 / 改版后·去掉稳定属性)
// ---------------------------------------------------------------------------
function pageV1(): Page {
  // 改版前:class=.submit-btn,有 testid/id,顺序:提交订单 在前
  const form = new Node('form');
  form.setAttr('id', 'order');
  const submit = form.add(new Node('button'));
  submit.setAttr('class', 'submit-btn');
  submit.setAttr('data-testid', 'submit-order');
  submit.setAttr('id', 'btn-submit');
  submit.text = '提交订单';
  const cancel = form.add(new Node('button'));
  cancel.setAttr('class', 'cancel-btn');
  cancel.text = '取消';
  return makePage(form);
}

function pageV2(): Page {
  // 改版后:class 全换(.cta-primary-2025)、顺序对调(取消在前)、testid 保留
  const form = new Node('form');
  form.setAttr('id', 'order');
  const cancel = form.add(new Node('button'));
  cancel.setAttr('class', 'cancel-v2');
  cancel.text = '取消';
  const submit = form.add(new Node('button'));
  submit.setAttr('class', 'cta-primary-2025');
  submit.setAttr('data-testid', 'submit-order');
  submit.text = '提交订单';
  return makePage(form);
}

function pageV2b(): Page {
  // 改版后(更狠):class 全换、顺序对调、连 testid 也去掉 —— 逼出 text+tag+within 兜底
  const form = new Node('form');
  form.setAttr('id', 'order');
  const cancel = form.add(new Node('button'));
  cancel.setAttr('class', 'x-cancel');
  cancel.text = '取消';
  const submit = form.add(new Node('button'));
  submit.setAttr('class', 'x-primary');
  submit.text = '提交订单';
  return makePage(form);
}

/** 语义定位,断言命中的是「提交订单」那颗(不是「取消」)。 */
async function locateSubmit(
  page: Page,
  target: SemanticTarget,
): Promise<{ found: boolean; via: string; label: string; description: string }> {
  const res = await coreSemanticLocate(cdpFor(page), target);
  return { found: res.found, via: res.via, label: res.label, description: res.description };
}

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------
async function scenarioSameTargetAcrossRevisions(): Promise<void> {
  console.log('\n[S1] 同一语义目标,改版前/后两版都点中同一颗(换 class + 换顺序)');
  const target: SemanticTarget = { text: '提交订单', tag: 'button', within: 'form' };
  for (const [name, page] of [
    ['v1 改版前', pageV1()],
    ['v2 改版后', pageV2()],
    ['v2b 改版后(去 testid)', pageV2b()],
  ] as const) {
    const r = await locateSubmit(page, target);
    chk(r.found === true, `S1 ${name}:语义定位命中(found=true)`, JSON.stringify(r));
    chk(r.label === '提交订单', `S1 ${name}:命中的是「提交订单」那颗(不是「取消」)`, `label=${r.label}`);
    chk(r.via === 'text+tag+within', `S1 ${name}:命中方式=text+tag+within`, `via=${r.via}`);
  }
}

async function scenarioStableAttrPriority(): Promise<void> {
  console.log('\n[S2] 有稳定属性时优先走稳定属性(F4);testid 被去掉时回落文本+结构(F5)');
  // v1/v2 有 testid → 走 testid
  for (const [name, page] of [
    ['v1', pageV1()],
    ['v2', pageV2()],
  ] as const) {
    const r = await locateSubmit(page, { testId: 'submit-order' });
    chk(r.found === true && r.via === 'testid', `S2 ${name}:testId 优先,via=testid`, `found=${r.found} via=${r.via}`);
    chk(r.label === '提交订单', `S2 ${name}:命中的是「提交订单」`, `label=${r.label}`);
  }
  // v2b 没 testid → 回落 text+tag+within
  const r = await locateSubmit(pageV2b(), { testId: 'submit-order', text: '提交订单', tag: 'button', within: 'form' });
  chk(r.found === true, 'S2 v2b:testid 没了,靠 text+tag+within 仍命中', JSON.stringify(r));
  chk(r.via === 'text+tag+within', 'S2 v2b:回落方式=text+tag+within', `via=${r.via}`);
}

async function scenarioClassOnlyBreaksOnRevision(): Promise<void> {
  console.log('\n[S3] 反证:只认 class 的旧定位,改版前命中、改版后**必失败**;语义定位两版都成功');
  // 旧定位 = 把 target 当 CSS 选择器(老 find 的第一步)。class-only:'.submit-btn'
  const classOnly = (page: Page): boolean => {
    const r = page.eval(`(() => { const all = document.querySelectorAll('.submit-btn'); return all.length > 0; })()`);
    return r === true;
  };
  chk(classOnly(pageV1()) === true, 'S3 旧定位(class .submit-btn)在改版前命中');
  chk(classOnly(pageV2()) === false, 'S3 旧定位(class .submit-btn)在改版后**失败**(class 被换 → 红)');
  chk(classOnly(pageV2b()) === false, 'S3 旧定位(class .submit-btn)在改版后(去 testid)**失败**');
  // 同一目标,语义定位在改版后仍成功(绿)
  const target: SemanticTarget = { text: '提交订单', tag: 'button', within: 'form' };
  const v2 = await locateSubmit(pageV2(), target);
  const v2b = await locateSubmit(pageV2b(), target);
  chk(v2.found === true, 'S3 语义定位在改版后仍成功(绿)', JSON.stringify(v2));
  chk(v2b.found === true, 'S3 语义定位在改版后(去 testid)仍成功(绿)', JSON.stringify(v2b));
}

async function scenarioDisambiguation(): Promise<void> {
  console.log('\n[S4] 同文案多元素:文本最贴合的优先(完全相等 > 包含),不瞎挑(F1)');
  const form = new Node('form');
  const a = form.add(new Node('button'));
  a.text = '点击提交订单按钮'; // 包含目标,但不是精确
  const b = form.add(new Node('button'));
  b.text = '提交订单'; // 精确
  const page = makePage(form);
  const r = await locateSubmit(page, { text: '提交订单', tag: 'button', within: 'form' });
  chk(r.found === true, 'S4 命中(有一棵)', JSON.stringify(r));
  chk(r.label === '提交订单', 'S4 命中的是**精确**那颗,不是包含它的长文案那颗', `label=${r.label}`);
}

async function scenarioHiddenNotMatched(): Promise<void> {
  console.log('\n[S5] 不可见元素不命中(F6)');
  const form = new Node('form');
  const hiddenBtn = form.add(new Node('button'));
  hiddenBtn.text = '提交订单';
  hiddenBtn.setAttr('id', 'hidden-submit');
  hiddenBtn.hidden = true; // display:none / 零尺寸
  const visibleBtn = form.add(new Node('button'));
  visibleBtn.text = '提交订单';
  visibleBtn.setAttr('id', 'visible-submit');
  const page = makePage(form);
  const r = await locateSubmit(page, { text: '提交订单', tag: 'button', within: 'form' });
  chk(r.found === true, 'S5 命中(可见那颗)', JSON.stringify(r));
  // 命中的应是可见那颗:用坐标/标签无法区分,改用「隐藏那颗若被命中则会排在前」——
  // 这里直接验证:把可见那颗也隐藏 → 应 notfound
  visibleBtn.hidden = true;
  const r2 = await locateSubmit(page, { text: '提交订单', tag: 'button', within: 'form' });
  chk(r2.found === false, 'S5 两颗都不可见 → notfound(只认真可见)', JSON.stringify(r2));
}

async function scenarioOrderInsensitive(): Promise<void> {
  console.log('\n[S6] 换 DOM 顺序不漂移:同一目标在「提交订单在前/在后」两版都命中同一颗(F3)');
  // 两版只有顺序不同(其余一致),语义目标相同
  const mk = (submitFirst: boolean): Page => {
    const form = new Node('form');
    const submit = new Node('button');
    submit.setAttr('class', 'p');
    submit.text = '提交订单';
    const cancel = new Node('button');
    cancel.setAttr('class', 'c');
    cancel.text = '取消';
    if (submitFirst) {
      form.add(submit);
      form.add(cancel);
    } else {
      form.add(cancel);
      form.add(submit);
    }
    return makePage(form);
  };
  const target: SemanticTarget = { text: '提交订单', tag: 'button', within: 'form' };
  const r1 = await locateSubmit(mk(true), target);
  const r2 = await locateSubmit(mk(false), target);
  chk(r1.found && r1.label === '提交订单', 'S6 顺序 A(提交在前):命中「提交订单」', JSON.stringify(r1));
  chk(r2.found && r2.label === '提交订单', 'S6 顺序 B(提交在后):命中同一颗「提交订单」(不漂移)', JSON.stringify(r2));
}

async function scenarioCoreRobustness(): Promise<void> {
  console.log('\n[S7] 解析健壮性:空目标/不存在 → notfound 不崩(F5/F9)');
  const page = pageV1();
  const cdp = cdpFor(page);
  // 空目标(没有任何字段)→ notfound,不抛
  const empty = await coreSemanticLocate(cdp, {} as SemanticTarget);
  chk(empty.found === false && empty.via === 'none', 'S7 空目标 → notfound(via=none),不崩', JSON.stringify(empty));
  // 不存在的文本 → notfound
  const miss = await coreSemanticLocate(cdp, { text: '根本不存在', tag: 'button', within: 'form' });
  chk(miss.found === false, 'S7 不存在的文本 → notfound', JSON.stringify(miss));
}

async function main(): Promise<void> {
  console.log('='.repeat(68));
  console.log('ADR-0004 · 浏览器深度 第二片:稳健元素定位(语义定位层)验收(真驱动 core)');
  console.log('='.repeat(68));

  await scenarioSameTargetAcrossRevisions();
  await scenarioStableAttrPriority();
  await scenarioClassOnlyBreaksOnRevision();
  await scenarioDisambiguation();
  await scenarioHiddenNotMatched();
  await scenarioOrderInsensitive();
  await scenarioCoreRobustness();

  console.log('\n=== 结论 ===');
  console.log(`  ${total - fails.length} PASS / ${fails.length} FAIL`);
  if (fails.length) {
    console.log('  失败项:');
    for (const f of fails) console.log('    - ' + f);
  } else {
    console.log('  语义定位地基验收全绿(同一目标改版前/后都点中;class 旧定位改版必红)');
  }
  setTimeout(() => process.exit(fails.length ? 1 : 0), 50);
}

void main().catch((e) => {
  console.error('  验收异常:', e);
  process.exit(1);
});
