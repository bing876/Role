import React from 'react';

/**
 * 交互对齐片(2026-09-26) · **极简 markdown 渲染**(零依赖、零 `dangerouslySetInnerHTML`)。
 *
 * 为什么需要它:用户报「助手最终回答里有 raw `**`」—— 模型输出的是 markdown,
 * 而气泡一直是 `<div>{text}</div>` 纯文本渲染,`**加粗**` 就原样露出来了。
 *
 * 为什么自己写而不是引库:
 *   · 仓库**不许引 Tailwind/shadcn**,也一直刻意保持桌面端零 UI 依赖(`dependencies` 只有 react/react-dom);
 *   · 只支持模型真会用的那几样就够了(标题/加粗/斜体/行内码/围栏码/列表/引用/链接);
 *   · 关键是**安全**:全部渲染成 React 元素,绝不 `innerHTML`,所以模型就算吐出 `<script>` 也只是文字。
 *
 * 刻意**不做**的事:表格、HTML 透传、脚注、嵌套列表缩进层级(模型极少用,做了反而容易出样式事故)。
 */

/** 行内:`**粗**` / `*斜*` / `` `码` `` / `[文字](url)` —— 按顺序切,不递归嵌套 */
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(`[^`]+`)|(\[[^\]\n]+\]\([^)\s]+\))/g;
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const token = m[0];
    const key = `${keyPrefix}-i${i++}`;
    if (token.startsWith('**')) out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith('`')) out.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (token.startsWith('[')) {
      const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      // 只放行 http(s):javascript:/data: 一律退化成纯文字(不做任何可点击的东西)
      if (mm && /^https?:\/\//i.test(mm[2])) {
        out.push(
          <a key={key} href={mm[2]} target="_blank" rel="noreferrer noopener">
            {mm[1]}
          </a>,
        );
      } else {
        out.push(token);
      }
    } else out.push(<em key={key}>{token.slice(1, -1)}</em>);
    last = at + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * 块级:围栏码 / 标题 / 有序与无序列表 / 引用 / 段落。
 * 流式渲染友好:半截的 `**` 不会抛错(正则不匹配就当普通文字),所以打字机过程中也安全。
 */
export function MarkdownText({ text }: { text: string }): React.ReactElement {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let quote: string[] = [];
  let code: { lang: string; lines: string[] } | null = null;

  const flushPara = (): void => {
    if (para.length === 0) return;
    const key = `p${blocks.length}`;
    blocks.push(<p key={key}>{renderInline(para.join('\n'), key)}</p>);
    para = [];
  };
  const flushList = (): void => {
    if (!list) return;
    const key = `l${blocks.length}`;
    const items = list.items.map((it, i) => <li key={`${key}-${i}`}>{renderInline(it, `${key}-${i}`)}</li>);
    blocks.push(list.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>);
    list = null;
  };
  const flushQuote = (): void => {
    if (quote.length === 0) return;
    const key = `q${blocks.length}`;
    blocks.push(<blockquote key={key}>{renderInline(quote.join('\n'), key)}</blockquote>);
    quote = [];
  };
  const flushAll = (): void => {
    flushPara();
    flushList();
    flushQuote();
  };

  for (const raw of lines) {
    const line = raw;
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (code) {
      if (fence) {
        const key = `c${blocks.length}`;
        blocks.push(
          <pre key={key}>
            <code>{code.lines.join('\n')}</code>
          </pre>,
        );
        code = null;
      } else {
        code.lines.push(line);
      }
      continue;
    }
    if (fence) {
      flushAll();
      code = { lang: fence[1] ?? '', lines: [] };
      continue;
    }
    if (!line.trim()) {
      flushAll();
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flushAll();
      const level = h[1].length;
      const key = `h${blocks.length}`;
      const content = renderInline(h[2], key);
      blocks.push(
        level <= 2 ? <h4 key={key}>{content}</h4> : <h5 key={key}>{content}</h5>,
      );
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      flushPara();
      flushList();
      quote.push(q[1]);
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      flushQuote();
      const ordered = Boolean(ol);
      const item = (ul ?? ol)![1];
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(item);
      continue;
    }
    flushList();
    flushQuote();
    para.push(line);
  }
  if (code) {
    const key = `c${blocks.length}`;
    blocks.push(
      <pre key={key}>
        <code>{code.lines.join('\n')}</code>
      </pre>,
    );
  }
  flushAll();
  return <>{blocks}</>;
}
