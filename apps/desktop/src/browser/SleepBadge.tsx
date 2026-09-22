/**
 * 休眠标记（Chrome「内存节省模式」同款图形）
 *
 * Chrome 的 Memory Saver 在标签页休眠时，会把网站原本的 favicon **换掉**，
 * 显示一个灰色圆底 + 内存条图形的小徽标：
 *   - 内存条本体：一个横向的长方形框；
 *   - 里面的颗粒：3 个小方块；
 *   - 右侧的电容：一条短竖条。
 *
 * 为什么复刻这个图形而不是用「月亮 / zzz」：
 *   1. 用户明确要求「改成谷歌设计的那种」；
 *   2. 「内存条」这个意象直说要表达的事 —— **内存被省下来了**（月亮只表示"睡着了"，
 *      但用户真正关心的是省内存）；
 *   3. 它和我们的浅/深两级休眠天然对应：颗粒数可以表示深度。
 *
 * 尺寸固定 14×14（视觉上占 favicon 的位置），颜色走 currentColor，
 * 由外层的 `--shallow` / `--deep` 用 opacity 区分深浅，不额外引入颜色。
 *
 * @param depth  `'shallow'` 省 CPU（页还活着，秒醒）／`'deep'` 省内存（页已卸载，唤醒要重新加载）
 * @param idle   已经闲置多久的人话（例「12 分钟」）。传了就写进 tooltip ——
 *               用户看到「已休眠 12 分钟」比只看到「已休眠」安心得多（知道它不是坏了）。
 */
export function SleepBadge({ depth, idle }: { depth: 'shallow' | 'deep'; idle?: string }) {
  const what =
    depth === 'deep'
      ? '这张页已休眠，内存已释放（点一下唤醒，会重新加载）'
      : '这张页暂时歇着，在后台省电（点一下立刻回来）';
  return (
    <span
      className={`browserTab__sleep browserTab__sleep--${depth}`}
      title={idle ? `${what}　·　已闲置 ${idle}` : what}
      aria-label="已休眠"
    >
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
        {/* 圆底：Chrome 那个灰色圆形徽标 */}
        <circle cx="7" cy="7" r="6.4" fill="currentColor" opacity="0.14" />
        {/* 内存条外框 */}
        <rect
          x="2.6"
          y="4.4"
          width="7"
          height="5.2"
          rx="0.9"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.1"
        />
        {/* 条内的颗粒：深休眠画满 3 颗，浅休眠只画 2 颗 —— 一眼看出睡多深 */}
        <rect x="3.7" y="5.7" width="1.05" height="2.6" rx="0.3" fill="currentColor" />
        <rect x="5.55" y="5.7" width="1.05" height="2.6" rx="0.3" fill="currentColor" />
        {depth === 'deep' && <rect x="7.4" y="5.7" width="1.05" height="2.6" rx="0.3" fill="currentColor" />}
        {/* 右侧电容（内存条的金手指/电容那一小条） */}
        <rect x="10.35" y="5.6" width="1.1" height="3.8" rx="0.4" fill="currentColor" />
      </svg>
    </span>
  );
}
