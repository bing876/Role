import { useEffect, useRef, useState } from 'react';
import { SOFT_TAB_HINT, toHttpUrl } from './url';
import type { BrowserWorkspace } from './useBrowserWorkspace';
import { hostLabel } from './url';
import { humanizeIdle } from './sleepPolicy';
import { SleepBadge } from './SleepBadge';
import './styles.css';

/**
 * 第 20 步 · 浏览器模块：中栏那块**钉住的工作区**（顶栏 tab + URL 栏 + 舞台）。
 *
 * 它是 .middle（纵向 flex）的兄弟节点、不在 .chat 的滚动区里 ——
 * 所以「滚聊天不会把浏览器滚没」，切智能体也不会把它卸载掉
 * （正在跑的那几路驾驶因此不会断）。
 *
 * 第 20 步的关键点：
 *   - 顶栏只显示**当前智能体**的 tab（别人的 tab 你看不见、也带不过来）；
 *   - 舞台里**所有智能体、所有 tab** 的页宿主都一直挂着（绝对定位铺满、靠 z-index 分层）：
 *     被切到后面的那张必须仍然活着、仍然有真实尺寸，否则驾驶在它上面点不中任何元素；
 *   - 每张页的**登录态**按**它所属的项目**分区（Phase 3：同项目的智能体共用一套）——
 *     ADR-0002 起分区名由主进程在 create 时拼并过闸，渲染层只报 projectId；
 *   - **活页上限（全局，默认 4 张，设置可调大）**：到上限拒新开并说明；页数多时 URL 栏右侧提示「开太多会卡」，绝不替用户关页。
 *
 * ADR-0002（页宿主 `<webview>` → 主进程托管的 WebContentsView）：
 *   - 舞台里挂的是**占位 div**（`.browserPanel__view`，与老 webview 同名同类）——
 *     第四列的三态 / z 分层 / 修饰符一个字节没动，动的只有「这里面是什么」；
 *   - 真页面活在主进程的原生视图里：本组件只负责三件事 ——
 *     ① 宿主 div 挂载/卸载 → 建/销毁原生宿主（`ws.hostMounted` / `ws.hostGone`）；
 *     ② 量舞台几何 → 每页的 (rect, visible) 走 `browserViewRect`（rAF 合并、签名去重）；
 *     ③ 切当前页 → `browserViewOrder`（原生视图按子序堆叠，置顶）。
 *   - 隐藏（切后台 / 切智能体 / 求助卡之外的页）= `visible: false`，**不销毁**（隐藏≠卸载）；
 *     只有深休眠 / 关 tab / 关光所有页才走销毁（三条有意卸载路径，语义与 webview 时期一致）。
 */

/**
 * 第 27 步（人工介入卡片）：「求助卡模式」里那张页要落在哪儿。
 *
 * 坐标一律是**相对 `.browserPanel__stage` 的左上角**（stage 在 embed 模式下铺满中栏，
 * 所以也就等于相对中栏会话区）—— 渲染层量出来的，主进程一无所知。
 * `clip` 是一段现成的 `clip-path` 值：卡片被滚出视口时，用它把页面裁到可见的那一块，
 * 免得一张大页盖在聊天上面。
 */
export interface EmbedRect {
  left: number;
  top: number;
  width: number;
  height: number;
  clip: string;
}

export function BrowserPanel({
  ws,
  agentLabel,
  embed,
}: {
  ws: BrowserWorkspace;
  agentLabel?: string;
  embed?: { wcId: number | null; rect: EmbedRect | null };
}) {
  const active = ws.active;
  /**
   * 第 27 步：现在是不是"求助卡模式"。
   * 必须**同时**满足「视图是 embed」和「知道要嵌哪张页」—— 少一个就退回普通渲染，
   * 免得出现"层透明了、却没有任何一张页露脸"的空窗（那种状态下用户会以为页丢了）。
   */
  const embedActive = ws.view === 'embed' && typeof embed?.wcId === 'number';
  /** URL 栏的草稿：用户正在编辑时不跟页面走，免得打字打到一半被覆盖 */
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  /**
   * 地址栏 DOM。
   *
   * 第 24 步：认不出站点时（用户拍板）要「开一张起始页 + 把焦点交给地址栏」，
   * 让用户直接打网址。聚焦这件事只在**这个组件内部**做得到 ——
   * workspace 那层拿不到这个 input，所以那里只把"请求聚焦"的次数加一，
   * 这里监听次数变化后执行聚焦。用次数（而不是布尔）是为了**连续两次请求也能生效**。
   */
  const urlRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (ws.urlBarFocusTick <= 0) return;
    const el = urlRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [ws.urlBarFocusTick]);
  /** 当前智能体名下睡着了几张（顶栏那个「· N 个已休眠」） */
  const asleepCount = ws.tabs.filter((t) => !!t.sleep).length;

  useEffect(() => {
    if (editing) return;
    setDraft(active?.url ?? '');
  }, [active?.url, active?.id, editing]);

  /**
   * ADR-0002：宿主 div 现在是**占位**（真页面在主进程的原生视图里）：
   * 只登记元素（节点身份断言 + 几何测量的锚点）。
   * 标题/地址不再听元素事件（改由主进程 `pageinfo` 推，见 useBrowserWorkspace）；
   * 非 http(s) 的整页跳转闸在主进程 guest 侧（wireBrowserGuest），口径不变。
   */
  const bindRef = (id: number, el: HTMLElement | null): void => {
    ws.registerWebview(id, el);
  };

  const stageRef = useRef<HTMLDivElement | null>(null);
  /** create 回执落地后重发几何用的「发一次」入口（rect 效果里挂上，见下） */
  const sendRectsRef = useRef<(() => void) | null>(null);

  /**
   * ADR-0002 ①：页宿主（原生视图）生命周期 —— 跟**宿主 div** 的挂载/卸载走。
   *
   *   挂上（首挂 / 深休眠唤醒）→ `ws.hostMounted`（create + 登记 wcId + 报 owner）；
   *   摘下（深休眠 / 关 tab / 关光所有页）→ `ws.hostGone`（destroy）。
   *
   * 深休眠分支渲染的是占位卡（没有宿主 div），所以自然走「摘下」路径 ——
   * 休眠语义与 webview 时期逐字一致（深休眠才卸载；浅休眠/隐藏都不动宿主）。
   */
  const hostKeysRef = useRef<Set<number> | null>(null);
  /**
   * 卸载代次（每次挂载 +1）—— 只在「真卸载」时才销毁宿主。
   *
   * ★★ 2026-09-26 修（真机症状：「指定的内嵌页已经不在了（webContents NNNN 已关闭）」——
   *   AI 正在驾驶的页会莫名其妙被销毁，只能重开一遍）：
   *
   * 旧写法是一个布尔标志 `panelUnmountedRef`：cleanup 只把它设 `true`、**从不设回 `false`**。
   * 而 `useRef(false)` 的初值只在**新实例**上生效 —— `apps/desktop/src/main.tsx` 里
   * `<StrictMode>` 是开着的，开发模式下 React 会在**同一个实例**上跑一遍
   * 「setup → cleanup → setup」⇒ 标志从挂载起就**永远是 true** ⇒ 宿主效果的
   * **每一次依赖变化**（开一张页 / 关一张页 / drivingIds 变）都走
   * `if (panelUnmountedRef.current)` 分支，把**当前所有**原生视图销毁重建
   * ⇒ 页被重建、正在跑的那路驾驶目标当场作废。
   *
   * 光是"在 effect body 里复位"也不够：StrictMode 的卸载发生在重挂**之前**，
   * 复位后紧接着的那次卸载仍会把刚建好的视图销毁一次（挂载瞬间 create→destroy→create 抖动）。
   *
   * 所以改成 **代次 + 微任务**：cleanup 把销毁推迟一个微任务，并检查"有没有更晚的挂载"——
   *   · StrictMode 的**假卸载**会被紧随其后的重挂取代 → 跳过（不销毁、不抖动）；
   *   · **真卸载**（关光所有页 → App 把整层卸掉）没有后续挂载 → 执行销毁（路径① 的原生侧那一半）。
   */
  const mountGenerationRef = useRef(0);
  useEffect(() => {
    const generation = (mountGenerationRef.current += 1);
    return () => {
      queueMicrotask(() => {
        if (mountGenerationRef.current !== generation) return; // 被重挂取代 = 假卸载
        for (const id of hostKeysRef.current ?? []) ws.hostGone(id);
        hostKeysRef.current = new Set<number>();
      });
    };
    // ws.hostGone 读的是 hook 里的 ref（pagesRef / wcIdsRef），闭包不会过期
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const now = new Set<number>();
    for (const t of ws.allTabs) {
      const deepSleeping = t.sleep === 'deep' && !ws.drivingIds.includes(t.id);
      if (!deepSleeping) now.add(t.id);
    }
    const prev = hostKeysRef.current ?? new Set<number>();
    for (const id of prev) {
      if (!now.has(id)) ws.hostGone(id);
    }
    for (const t of ws.allTabs) {
      if (now.has(t.id) && !prev.has(t.id)) {
        // create 期间视图离屏 —— 回执落地后重发一次几何，页才落位（F7：不闪左上角、也不漏帧）
        void ws.hostMounted(t).then(() => {
          sendRectsRef.current?.();
        });
      }
    }
    hostKeysRef.current = now;
    /*
     * ★ 这里**故意没有 cleanup**：依赖变化（开页/关页/drivingIds 变）绝不能销毁视图 ——
     *   「真卸载才销毁」由上一条「代次 + 微任务」的 effect 独家负责。
     */
  }, [ws.allTabs, ws.drivingIds]);

  /**
   * ADR-0002 ②：几何同步 —— 渲染进程量舞台 rect，逐页发 (rect, visible)。
   *
   * 坐标系：舞台的 `getBoundingClientRect`（视口坐标）== 窗口内容区坐标
   * （内容区即视口，原生视图 setBounds 相对内容区左上角），**直接透传**，不做偏移换算。
   *
   * 去重：签名（各页 rect+visible）不变就不发；拖拽/缩放/层状态变化才按 rAF 节奏发。
   *
   * visible 映射**以 App 算好的层 class 为准**（`.browserLayer--hidden` / `--embed`）——
   * 不在这边再维护一套「什么情况下可见」的逻辑，两份逻辑永远对不齐才是事故之源：
   *   - embed 态：只有要嵌的那一张露脸（它的 rect 按求助卡的 rect+clip 收缩）；
   *   - 普通态：层没隐藏 且 这张页是当前智能体的当前页。
   *   隐藏 = `visible: false`（视图仍附着、页照跑），**绝不是销毁**。
   */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let raf = 0;
    let lastSig = '';
    let alive = true;

    type ViewState = { tabId: number; rect: { x: number; y: number; width: number; height: number }; visible: boolean };

    const compute = (): ViewState[] => {
      const layer = stage.closest('.browserLayer');
      const layerCls = layer ? layer.getAttribute('class') ?? '' : '';
      const embedMode = layerCls.includes('browserLayer--embed');
      const hidden = layerCls.includes('browserLayer--hidden');
      const s = stage.getBoundingClientRect();
      const out: ViewState[] = [];
      for (const t of ws.allTabs) {
        const deepSleeping = t.sleep === 'deep' && !ws.drivingIds.includes(t.id);
        if (deepSleeping) continue; // 深休眠 = 宿主已销毁，无视图可发
        const otherAgent = ws.currentAgentId !== null && t.agentId !== ws.currentAgentId;
        const on = !otherAgent && t.id === active?.id && t.agentId === active?.agentId;
        const isEmbedTarget = embedActive && !otherAgent && ws.webContentsIdOf(t.id) === embed?.wcId;
        const visible = embedMode ? isEmbedTarget : !hidden && !otherAgent && on;
        let rect = { x: s.left, y: s.top, width: s.width, height: s.height };
        if (embedMode && isEmbedTarget && embed?.rect) {
          // 求助卡的 clip 是 `inset(上 右 下 左)` —— 等价于把原生视图的 bounds 四边各收掉一块
          const c = /inset\(\s*([\d.]+)px\s+([\d.]+)px\s+([\d.]+)px\s+([\d.]+)px\s*\)/.exec(embed.rect.clip);
          const top = c ? parseFloat(c[1]) : 0;
          const right = c ? parseFloat(c[2]) : 0;
          const bottom = c ? parseFloat(c[3]) : 0;
          const left = c ? parseFloat(c[4]) : 0;
          rect = {
            x: s.left + embed.rect.left + left,
            y: s.top + embed.rect.top + top,
            width: Math.max(0, embed.rect.width - left - right),
            height: Math.max(0, embed.rect.height - top - bottom),
          };
        }
        out.push({ tabId: t.id, rect, visible });
      }
      return out;
    };

    const send = (force = false): void => {
      if (!alive) return;
      const states = compute();
      const sig = states
        .map((x) => `${x.tabId}:${Math.round(x.rect.x)},${Math.round(x.rect.y)},${Math.round(x.rect.width)},${Math.round(x.rect.height)}:${x.visible ? 1 : 0}`)
        .join('|');
      if (!force && sig === lastSig) return;
      lastSig = sig;
      for (const x of states) {
        void window.workbench?.browserViewRect?.({
          tabKey: x.tabId,
          rect: {
            x: Math.round(x.rect.x),
            y: Math.round(x.rect.y),
            width: Math.round(x.rect.width),
            height: Math.round(x.rect.height),
          },
          visible: x.visible,
        });
      }
    };

    const schedule = (): void => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        send();
      });
    };
    sendRectsRef.current = (): void => send(true);

    const ro = new ResizeObserver(schedule);
    ro.observe(stage);
    window.addEventListener('resize', schedule);
    // 层的三态 class 变化（App 算的可见性依据）→ 立刻重发
    const layer = stage.closest('.browserLayer');
    let mo: MutationObserver | null = null;
    if (layer && typeof MutationObserver !== 'undefined') {
      mo = new MutationObserver(schedule);
      mo.observe(layer, { attributes: true, attributeFilter: ['class'] });
    }
    schedule();
    return () => {
      alive = false;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', schedule);
      mo?.disconnect();
      sendRectsRef.current = null;
    };
  }, [ws.allTabs, ws.view, ws.currentAgentId, ws.drivingIds, ws.embedWcId, active, embedActive, embed]);

  /**
   * ADR-0002 ③：切当前页 → 原生视图置顶（原生视图的 z 序 = 子序）。
   * 同一时刻只有一张页 visible，置顶是「切换瞬间不闪」的保险，不是正确性依赖。
   */
  useEffect(() => {
    if (active) void window.workbench?.browserViewOrder?.(active.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);

  return (
    <div className={embedActive ? 'browserPanel browserPanel--embed' : 'browserPanel'}>
      {/* 顶栏：当前智能体一张页一个 tab（没有上限）+ 「＋」+ 展开/收起 */}
      <div className="browserPanel__tabs" role="tablist" aria-label="打开的网页">
        <span
          className="browserPanel__who"
          title="标签页按智能体隔离（这是谁的页）；登录态按项目共享（同项目的智能体共用一套 cookie）"
        >
          {agentLabel ? `${agentLabel} 的浏览器` : '浏览器'}
        </span>
        {ws.tabs.map((t) => (
          <div
            key={t.id}
            className={[
              'browserTab',
              t.id === active?.id ? 'browserTab--on' : '',
              // 休眠页整张压暗一档（标题也退到背景里），和 Chrome 一样
              t.sleep ? 'browserTab--asleep' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <button
              type="button"
              role="tab"
              aria-selected={t.id === active?.id}
              className="browserTab__label"
              title={t.url}
              onClick={() => ws.activate(t.id)}
            >
              {ws.drivingIds.includes(t.id) && (
                <span className="browserTab__run" title="驾驶员正在这张页上操作">
                  ●
                </span>
              )}
              {/*
               * 休眠标记：占 favicon 的位置（label 最前面）。
               * 和 Chrome 一样 —— 页一休眠就把网站图标换掉，而不是另加一个角标。
               * 只有真在跑任务的页才不会休眠，所以「驾驶中」和「休眠」不会同时出现。
               */}
              {!ws.drivingIds.includes(t.id) && t.sleep && (
                <SleepBadge depth={t.sleep} idle={humanizeIdle(ws.idleMsOf(t.id))} />
              )}
              {t.title || hostLabel(t.url) || t.bootUrl}
            </button>
            <button type="button" className="browserTab__x" aria-label="关闭这张页" onClick={() => ws.closeTab(t.id)}>
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          className="browserTab__add"
          title="给这个智能体新开一张（没有数量上限）"
          onClick={() => ws.openNewTab()}
        >
          ＋
        </button>
        {/*
         * 第 25 步：这里是「退出全屏」而不是「收起」。
         * 退出 ≠ 关闭：面板不卸载、webview 尺寸不变、正在跑的任务一秒都不停 ——
         * 只是把中栏会话区还给聊天，并在右下角亮起「后台运行中」小图标（点它回来）。
         */}
        <button
          type="button"
          className="browserPanel__toggle"
          title="切回对话：浏览器会转到后台继续运行，任务不会中断。点击顶栏「🌐 浏览器」或右下角小图标随时回来"
          onClick={() => ws.exitFullscreen()}
        >
          💬 切回对话
        </button>
      </div>

      {/* URL 栏：跟着当前智能体当前那张页走；改了回车即导航（只允许 http/https） */}
      <div className="browserPanel__urlbar">
        <span className="browserPanel__scheme" aria-hidden="true">
          {/^https:/i.test(active?.url ?? '') ? '🔒' : '🌐'}
        </span>
        <input
          ref={urlRef}
          className="browserPanel__url"
          value={draft}
          spellCheck={false}
          placeholder="输入网址后回车（只允许 http / https）"
          onFocus={() => setEditing(true)}
          onBlur={() => setEditing(false)}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || !active) return;
            const next = toHttpUrl(draft);
            if (next) ws.navigate(active.id, next);
            setEditing(false);
            (e.target as HTMLInputElement).blur();
          }}
        />
        {ws.softHint && (
          <span className="browserPanel__warn" title={`超过 ${SOFT_TAB_HINT} 张会开始有点卡，但不会自动关页`}>
            开太多会卡
          </span>
        )}
        {/*
         * 页数 + 休眠数（第 24 步）。原来是「N 张活页」——「活页」这个词已经不要了。
         * 休眠数单独显示出来，用户才不会以为「页怎么少了 / 内容丢了吗」。
         */}
        <span
          className="browserPanel__count"
          title={
            asleepCount > 0
              ? `${ws.tabCount} 个页面，其中 ${asleepCount} 个已休眠（释放了内存），点一下就能唤醒`
              : `${ws.tabCount} 个页面`
          }
        >
          {ws.tabCount} 个页面
          {asleepCount > 0 && <span className="browserPanel__asleep"> · {asleepCount} 个已休眠</span>}
        </span>
        {/*
         * 第 24 步：**休眠总开关**。
         *
         * 为什么要给用户一个开关：休眠是有代价的（深休眠唤醒要重新加载）。
         * 如果用户正在做"对着三个页面来回抄数据"这种事，自动休眠只会碍事。
         * 默认开 —— 因为"长时间不用自己收起来、不占内存"是他明确要的行为。
         *
         * 用一个小图标按钮而不是开关控件：这里空间很紧（旁边就是页数提示），
         * 而它是个"设了就不太动"的偏好，不该抢视觉重心。
         */}
        <button
          type="button"
          className={`browserPanel__sleepToggle${ws.sleepEnabled ? '' : ' browserPanel__sleepToggle--off'}`}
          onClick={() => ws.setSleepEnabled(!ws.sleepEnabled)}
          title={
            ws.sleepEnabled
              ? '空闲自动休眠：已开启（长时间不用的页会自动省内存）。点一下关掉'
              : '空闲自动休眠：已关闭（所有页都会一直占着内存）。点一下开启'
          }
        >
          {ws.sleepEnabled ? '自动休眠 开' : '自动休眠 关'}
        </button>
      </div>

      {/* 舞台：所有智能体、所有 tab 的页宿主（ADR-0002 起是占位 div，真页面在主进程原生视图里）都挂在这里，只靠 z-index 分层 */}
      <div className="browserPanel__stage" ref={stageRef}>
        {ws.tabs.length === 0 && <div className="browserPanel__empty small">这个智能体还没有打开网页</div>}
        {ws.allTabs.map((t) => {
          /**
           * 第 21 步：**别的智能体的页不露脸**（但照样挂着、照样活着）。
           *
           * 第 20 步只做了「顶栏只显示当前智能体的 tab」，舞台里别的智能体的页仍铺在最底层 ——
           * 切到「卡布」时顶栏写着「0 张活页 / 这个智能体还没有打开网页」，
           * 屏幕上却还看得见小助那张百度页，看起来像「串了」。
           * 现在：不是当前智能体的页一律 `--off`（opacity 0 + 不接收指针事件）。
           * **尺寸与挂载状态完全不变**（不是 display:none、不是卸载），
           * 所以它上面正在跑的那一路驾驶照旧点得中、也不会断。
           */
          const otherAgent = ws.currentAgentId !== null && t.agentId !== ws.currentAgentId;
          const on = !otherAgent && t.id === active?.id && t.agentId === active?.agentId;
          /**
           * 第 27 步：求助卡模式下，只有"要嵌的那一张"露脸，别的页和全屏时一样不露脸
           * （`--off` 只改 opacity / pointer-events，**不动尺寸、不卸载** —— 那几路驾驶照跑）。
           */
          /**
           * ★ `!otherAgent` 这一条不能省：用户切到别的智能体时，求助的那张页
           *   必须跟着一起藏起来 —— 否则它会**浮在另一个对话的聊天上面**，
           *   看起来像"别人的浏览器串到我这来了"。
           */
          const isEmbedTarget = embedActive && !otherAgent && ws.webContentsIdOf(t.id) === embed?.wcId;

          /*
           * ★ 第 24 步：**深休眠的页不渲染宿主** —— 这才是真的省内存。
           *
           * ADR-0002 起这条更直白：不渲染宿主 div = 生命周期效果里走 `hostGone`
           * = 主进程**销毁**原生视图（guest 渲染进程真的没了，内存真省了）。
           * 浅休眠（`'shallow'`）只是降帧、宿主照样在；**只有深休眠才卸载**。
           *
           * ★ 红线：`drivingIds` 里的页**永远不会**是 deep ——
           *   判定层（sleepPolicy）已经把"正在被驾驶"硬拦掉了，
           *   这里再守一道：真出现这种数据（不该有），也**拒绝卸载**，
           *   宁可多占内存，也不能把 AI 正在跑的任务弄断。
           */
          const deepSleeping = t.sleep === 'deep' && !ws.drivingIds.includes(t.id);
          if (deepSleeping) {
            return (
              <div
                key={t.id}
                className={otherAgent ? 'browserPanel__slept browserPanel__slept--off' : 'browserPanel__slept'}
              >
                <SleepBadge depth="deep" />
                <div className="browserPanel__sleptTitle">{t.title || hostLabel(t.url) || t.bootUrl}</div>
                <div className="browserPanel__sleptHint">这张页已休眠，内存已释放。</div>
                <button type="button" className="browserPanel__sleptBtn" onClick={() => ws.wakeAndActivate(t.id)}>
                  唤醒
                </button>
              </div>
            );
          }

          /**
           * ADR-0002：**占位 div**（与老 `<webview>` 同名同类 —— class / 修饰符 / z 分层
           * 一个字节没动）。真页面在主进程的原生视图里：
           *   - 几何：本组件的 rect 效果按这张 div 量舞台 + 内联 style，走 `browserViewRect`；
           *   - 生命周期：宿主 div 挂载/卸载 → `ws.hostMounted` / `ws.hostGone`；
           *   - 加载地址：create 时用**当前 `t.url` 兜底**（深休眠唤醒回到最后在的地方，
           *     与老 `src` 口径一致，见 `hostMounted`）。
           * 分区（登录态）与 target=_blank 收编都在主进程 create/guest 接线里，口径不变。
           */
          return (
            <div
              key={t.id}
              ref={(el) => bindRef(t.id, el)}
              className={
                embedActive
                  ? isEmbedTarget
                    ? 'browserPanel__view browserPanel__view--embed'
                    : 'browserPanel__view browserPanel__view--off'
                  : otherAgent
                    ? 'browserPanel__view browserPanel__view--off'
                    : on
                      ? 'browserPanel__view browserPanel__view--on'
                      : 'browserPanel__view'
              }
              /**
               * 第 27 步：几何跟随（**影子层方案**的核心）。
               *
               * 量出来的 rect 直接写进内联 style —— 宿主 div 本身**从头到尾没动过位置**，
               * 还在 `.browserPanel__stage` 里；变的只有 CSS：它看起来落在聊天卡片里了而已。
               * 原生视图跟着这块内联几何走（rect 效果里把 clip 收缩算进 bounds）。
               *
               * ★ 没量到 rect 时**不给内联样式**（退回铺满舞台），而不是给个 0×0 ——
               *   尺寸归零会让 CDP 驾驶的点击坐标全部失效（本模块顶部的红线）。
               */
              style={
                embedActive && isEmbedTarget && embed?.rect
                  ? {
                      left: `${embed.rect.left}px`,
                      top: `${embed.rect.top}px`,
                      width: `${embed.rect.width}px`,
                      height: `${embed.rect.height}px`,
                      right: 'auto',
                      bottom: 'auto',
                      clipPath: embed.rect.clip,
                    }
                  : undefined
              }
            />
          );
        })}
      </div>
    </div>
  );
}
