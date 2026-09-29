/** 设置抽屉的 MCP server 列表：唯一后端入口 `shared/api.ts`，JWT 不写入任何配置文件。 */
import { useCallback, useEffect, useState } from 'react';
import type { McpServerView, McpAddServerInput, McpTestView } from '@ai-workbench/shared';
import { authFetchJson, TOKEN_KEY } from '../../shared/api';

export function useMcpServers(active: boolean) {
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const auth = useCallback(() => ({ authorization: `Bearer ${localStorage.getItem(TOKEN_KEY) ?? ''}` }), []);
  const refresh = useCallback(async () => {
    try {
      const r = await authFetchJson<{ servers: McpServerView[] }>('/mcp/servers', { headers: auth() });
      setServers(Array.isArray(r.servers) ? r.servers : []);
      setError('');
    } catch (err) { setError((err as Error).message); }
    finally { setLoaded(true); }
  }, [auth]);
  useEffect(() => { if (active) void refresh(); }, [active, refresh]);
  const add = useCallback(async (input: McpAddServerInput) => {
    await authFetchJson('/mcp/servers', { method: 'POST', headers: auth(), body: JSON.stringify(input) });
    await refresh();
  }, [auth, refresh]);
  const remove = useCallback(async (id: number) => {
    await authFetchJson(`/mcp/servers/${id}`, { method: 'DELETE', headers: auth() });
    await refresh();
  }, [auth, refresh]);
  const test = useCallback((id: number) => authFetchJson<McpTestView>(`/mcp/servers/${id}/test`, {
    method: 'POST', headers: auth(), body: '{}',
  }), [auth]);
  return { servers, loaded, error, add, remove, test, refresh };
}
