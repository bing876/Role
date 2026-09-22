import { useEffect, useRef, useState } from 'react';
import { SOFT_TAB_HINT, isHttpUrl, partitionFor, toHttpUrl } from './url';
import type { BrowserWorkspace } from './useBrowserWorkspace';
import { hostLabel } from './url';
import { isStartPage } from './sites';
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
 *   - 舞台里**所有智能体、所有 tab** 的 <webview> 都一直挂着（绝对定位铺满、靠 z-index 分层）：
 *     被切到后面的那张必须仍然活着、仍然有真实尺寸，否则驾驶在它上面点不中任何元素；
 *   - 每张页的 `partition` 按**它所属的项目**算（Phase 3：同项目的智能体共用一套登录态）；
 *   - **没有活页上限**：开多少张都行，页数多了只在 URL 栏右侧提示「开太多会卡」，不关页。
 */

/** 元素上挂的私有字段：卸载时用来摘掉监听 */
type WebviewEl = HTMLElement & { __wbOff?: () => void };

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
   * 给 webview 挂监听（React 不会告诉我们这些）：
   *   1. 点站内链接、SPA 路由跳转、标题变化 → 反映到标签和 URL 栏上；
   *   2. **协议闸（桌面侧）**：非 http(s) 的整页跳转当场取消，留在当前页。
   *      主进程里还有一道权威闸；渲染层这一道是双保险，也让「点不动」在本地就止住。
   * 元素卸载时把监听摘掉（用元素上的私有字段记住卸载函数）。
   */
  const bindRef = (id: number, el: HTMLElement | null): void => {
    if (el && typeof (el as any).getWebContentsId !== 'function') {
      (el as any).getWebContentsId = () => id;
    }
    ws.registerWebview(id, el);
    if (!el) return;
    const anyEl = el as WebviewEl;
    anyEl.__wbOff?.();
    const onTitle = (e: Event): void => {
      const title = String((e as Event & { title?: string }).title ?? '');
      if (title) ws.notePageInfo(id, { title });
    };
    const onNav = (e: Event): void => {
      const url = String((e as Event & { url?: string }).url ?? '');
      if (url) ws.notePageInfo(id, { url });
      // Phase 3：页就绪/跳转时顺手把「这张页属于哪个智能体」报给主进程（下载记录要用）
      ws.noteOwner(id);
    };
    /** Phase 3：guest 就绪 → 把「这张页是哪个智能体开的」报给主进程（下载记录要标 owner） */
    const onDomReady = (): void => {
      ws.noteOwner(id);
    };
    const onWillNavigate = (e: Event): void => {
      const url = String((e as Event & { url?: string }).url ?? '');
      if (url && !isHttpUrl(url)) {
        (e as Event & { preventDefault?: () => void }).preventDefault?.();
        console.warn('[browser] 已拦下非 http(s) 跳转，留在当前页：', url);
      }
    };
    el.addEventListener('page-title-updated', onTitle);
    el.addEventListener('did-navigate', onNav);
    el.addEventListener('did-navigate-in-page', onNav);
    el.addEventListener('will-navigate', onWillNavigate);
    // Phase 3：guest 一就绪就把 owner 报给主进程（早报早好；拿不到 id 时 noteOwner 自己会跳过）
    el.addEventListener('dom-ready', onDomReady);
    anyEl.__wbOff = () => {
      el.removeEventListener('page-title-updated', onTitle);
      el.removeEventListener('did-navigate', onNav);
      el.removeEventListener('did-navigate-in-page', onNav);
      el.removeEventListener('will-navigate', onWillNavigate);
      el.removeEventListener('dom-ready', onDomReady);
    };
  };

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

      {/* 舞台：所有智能体、所有 tab 的 webview 都挂在这里，只靠 z-index 分层 */}
      <div className="browserPanel__stage">
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
           * ★ 第 24 步：**深休眠的页不渲染 <webview>** —— 这才是真的省内存。
           *
           * 为什么必须"不渲染"而不是"藏起来"：
           *   `<webview>` 只要挂在 DOM 上，Electron 就为它保留一个 guest 渲染进程，
           *   那份内存一分都省不下来。`display:none` / `opacity:0` 都**不省内存**。
           *   所以浅休眠（`'shallow'`）只是降帧、页照样挂着；**只有深休眠才卸载**。
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

          return (
            <webview
              key={t.id}
              ref={(el) => bindRef(t.id, el as unknown as HTMLElement | null)}
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
               * 量出来的 rect 直接写进内联 style —— webview 元素本身**从头到尾没动过位置**，
               * 还在 `.browserPanel__stage` 里、还是同一个 guest、还是同一个 wcId。
               * 变的只有 CSS：它看起来落在聊天卡片里了而已。
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
              /*
               * ★ 深休眠唤醒后要重新加载，`key` 不能只是 t.id ——
               *   同一张页从"休眠占位卡"变回 `<webview>` 时 React 会新建元素，
               *   但 `src` 若仍是 `bootUrl`（开页时的地址），用户会**丢掉会话中的导航**
               *   （比如从首页点进商品页、睡了 40 分钟、唤醒后回到首页）。
               *   所以用 `url`（当前真实地址）当 src 的兜底：优先回到他最后在的地方。
               */
              src={t.url && t.url !== t.bootUrl && !isStartPage(t.url) ? t.url : t.bootUrl}
              /*
               * Phase 3：分区按**这张页所属的项目**算 —— 同项目的智能体共用一套 cookie / 登录态。
               * 注意 `t.projectId` 是开页那一刻定下的（不是现在的项目），
               * 所以切项目不会让已开的页换一套登录态。
               */
              partition={partitionFor(t.projectId)}
              /*
               * target=_blank / window.open 由主进程 setWindowOpenHandler 拦下 → 推给渲染层
               * 真开一条 tab（第 23 步），不会创建 BrowserWindow、不会弹系统浏览器。
               *
               * ★ 值必须写成字符串 "true"，**不能**用裸的 `allowpopups`（布尔）。
               *   Electron 的 webview 是靠「属性在不在」（hasAttribute）决定放不放行弹窗的；
               *   而 React 18 对**未知属性**上的布尔值不写进 DOM —— 实测
               *   `hasAttribute('allowpopups')` = false。属性丢了不是"少个属性"：
               *   Chromium 直接把弹窗挡掉，主进程的 handler **一次都进不去**
               *   （electron.log 里连一行 "[webview] target=_blank" 都没有），
               *   于是「页里点开链接 → 真开一条 tab」在真机里从来没生效过。
               *
               * ★ 类型为什么要收窄：JSX 上这个属性来自 `@types/react` 的
               *   `WebViewHTMLAttributes.allowpopups?: boolean`（本目录 `webview.d.ts` 里那份
               *   在 `jsx: react-jsx` 下并不生效，实测报错类型就是 boolean）。它声明成布尔，
               *   可**运行时布尔会被丢掉** —— 类型与运行时不一致，只能在这里显式收窄。
               *   写 `"true"` 时 DOM 上就是 `allowpopups="true"`，Electron 认的就是"属性存在"。
               */
              allowpopups={'true' as unknown as boolean}
            />
          );
        })}
      </div>
    </div>
  );
}
