/** 能力与连接 · MCP server 卡片。设置里加 URL → 后端握手拉工具 → 当插件供循环调用。
 * 仅用户显式添加才发起外呼；Bearer token 只在输入框短暂存在，提交后清空。
 */
import { useState } from 'react';
import { useMcpServers } from './useMcpServers';

export function McpServersPanel() {
  const mcp = useMcpServers(true);
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [bearer, setBearer] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [tests, setTests] = useState<Record<number, string>>({});

  async function add() {
    if (!name.trim() || !url.trim()) { setNote('请填写 server 名称和地址'); return; }
    setBusy(true); setNote('');
    try {
      await mcp.add({ name: name.trim(), url: url.trim(), auth: bearer.trim() ? { bearerToken: bearer.trim() } : undefined });
      setName(''); setUrl(''); setBearer(''); setExpanded(false);
      setNote('已连接并拉取工具；下一轮任务可调用。');
    } catch (err) { setNote(`添加失败：${(err as Error).message}`); }
    finally { setBusy(false); }
  }
  async function remove(id: number) {
    setBusy(true); setNote('');
    try { await mcp.remove(id); setNote('连接已移除；后续任务不会再看到它的工具。'); }
    catch (err) { setNote(`移除失败：${(err as Error).message}`); }
    finally { setBusy(false); }
  }
  async function test(id: number) {
    setBusy(true); setTests((prev) => ({ ...prev, [id]: '测试中…' }));
    try {
      const r = await mcp.test(id);
      setTests((prev) => ({ ...prev, [id]: r.detail }));
    } catch (err) { setTests((prev) => ({ ...prev, [id]: `测试失败：${(err as Error).message}` })); }
    finally { setBusy(false); }
  }

  return (
    <div className="mcpPanel" aria-label="MCP 连接">
      <div className="small pluginsPanel__title">MCP 连接</div>
      <div className="small pluginsPanel__hint">有现成的 MCP server？填地址就能把它的工具交给 AI。只支持 Streamable HTTP；凭据加密存本机。</div>
      {mcp.error && <div className="small pluginsPanel__err">读连接失败：{mcp.error}</div>}
      {!mcp.loaded && <div className="small">加载连接中…</div>}
      {mcp.servers.map((s) => (
        <div className="pluginCard" data-status="on" key={s.id}>
          <div className="pluginCard__head">
            <span className="pluginCard__dot" aria-hidden />
            <span className="pluginCard__name">{s.name}</span>
            <span className="pluginCard__badge">{s.tools.length} 个工具</span>
          </div>
          <div className="small pluginCard__desc">{s.url} · {s.hasAuth ? '已设置鉴权' : '无需密钥'}</div>
          <div className="small pluginCard__desc">{s.tools.map((t) => t.name).join('、')}</div>
          <div className="buttons-row">
            <button type="button" className="btn" disabled={busy} onClick={() => void test(s.id)}>测试连通</button>
            <button type="button" className="btn pluginCard__clear" disabled={busy} onClick={() => void remove(s.id)}>移除</button>
          </div>
          {tests[s.id] && <div className="small pluginCard__note">{tests[s.id]}</div>}
        </div>
      ))}
      <button type="button" className="btn mcpPanel__add" onClick={() => setExpanded((v) => !v)}>{expanded ? '收起' : '＋ 添加 MCP server'}</button>
      {expanded && (
        <div className="pluginCard pluginCard__body">
          <label className="small pluginCard__field">名称<input className="authInput" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} placeholder="例如：我的文档工具" /></label>
          <label className="small pluginCard__field">Streamable HTTP 地址<input className="authInput" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" /></label>
          <label className="small pluginCard__field">Bearer token（若需鉴权；保存后不回显）<input className="authInput" type="password" autoComplete="off" value={bearer} onChange={(e) => setBearer(e.target.value)} /></label>
          <button type="button" className="btn" disabled={busy} onClick={() => void add()}>{busy ? '连接中…' : '连接并拉取工具'}</button>
        </div>
      )}
      {note && <div className="small pluginCard__note">{note}</div>}
    </div>
  );
}
