/** MCP Streamable HTTP 客户端：initialize → initialized → tools/list(+cursor) / tools/call。
 * 单一生产实现供路由、循环及验收共用。协议：
 * https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
 * 只支持远端 HTTP transport（不执行 stdio shell 命令）；超时覆盖**读取响应体**。
 */
export class McpError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'McpError';
  }
}
export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}
export interface McpAuth {
  bearerToken?: string;
  headers?: Record<string, string>;
}
export interface McpClientOpts {
  timeoutMs?: number;
  clientName?: string;
  clientVersion?: string;
  protocolVersion?: string;
}
export interface McpSession {
  sessionId?: string;
  serverInfo?: { name?: string; version?: string };
  protocolVersion?: string;
}
type JsonRpc = { jsonrpc: '2.0'; id?: number | string; method?: string; result?: unknown; error?: { code: number; message: string } };
const PROTOCOL_VERSION = '2025-03-26';
const MAX_BODY = 1_000_000;
let rpcId = 1;

/** 非回环必须 HTTPS；不能把口令藏在 URL 或经跨站跳转漏出 auth。 */
export function validateMcpEndpoint(raw: string): string {
  if (typeof raw !== 'string' || raw.length > 2048) throw new McpError('bad_url', 'MCP 地址过长或不正确');
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new McpError('bad_url', 'MCP server 地址必须是合法 URL'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))
    throw new McpError('bad_url', '公网 MCP server 必须用 HTTPS；仅本机回环可用 HTTP');
  if (url.username || url.password || url.search || url.hash)
    throw new McpError('bad_url', 'MCP 地址不接受用户名、密码、查询参数或片段；密钥请填单独的 Bearer token');
  return url.href;
}

function headersFor(auth: McpAuth | undefined, session?: McpSession): Record<string, string> {
  const h: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (session?.protocolVersion) h['mcp-protocol-version'] = session.protocolVersion;
  if (session?.sessionId) h['mcp-session-id'] = session.sessionId;
  if (auth?.bearerToken) h.authorization = `Bearer ${auth.bearerToken}`;
  for (const [k, v] of Object.entries(auth?.headers ?? {})) {
    // 外部配置绝不能盖 Content-Type、Host、Authorization 或 session header。
    if (!/^x-[a-z0-9-]{1,60}$/i.test(k) || typeof v !== 'string' || /[\r\n]/.test(v) || v.length > 2048)
      throw new McpError('bad_auth', '自定义鉴权头只能用 X-*（值不含换行且不超过 2048 字）');
    h[k] = v;
  }
  return h;
}

async function boundedBody(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) throw new McpError('response_too_large', 'MCP 响应过大（上限 1MB）');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** 只信与本次请求 id 相同的响应帧（跳过异步通知）。错误消息不回显上游原文/密钥。 */
async function readRpc(res: Response, id: number): Promise<JsonRpc> {
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new McpError('http_error', `MCP server 返回 HTTP ${res.status}`);
  }
  const candidates: unknown[] = [];
  if ((res.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream')) {
    // SSE 可以长时间不结束；收到匹配本次 id 的 data 帧就返回，绝不等流关闭。
    const reader = res.body?.getReader();
    if (!reader) throw new McpError('bad_response', 'MCP SSE 响应为空');
    let buffer = '';
    let bytes = 0;
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BODY) throw new McpError('response_too_large', 'MCP 响应过大（上限 1MB）');
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trimStart().startsWith('data:')) continue;
          try {
            const j = JSON.parse(line.trimStart().slice(5).trim());
            if (j?.jsonrpc === '2.0' && j?.id === id) {
              candidates.push(j);
              break;
            }
          } catch { /* 坏帧跳过 */ }
        }
        if (candidates.length) break;
      }
    } finally { await reader.cancel().catch(() => undefined); }
  } else {
    const text = await boundedBody(res);
    try { const v: unknown = JSON.parse(text); candidates.push(...(Array.isArray(v) ? v : [v])); } catch {
      throw new McpError('bad_response', 'MCP server 响应不是合法 JSON');
    }
  }
  const rpc = candidates.find((v): v is JsonRpc =>
    !!v && typeof v === 'object' && (v as JsonRpc).jsonrpc === '2.0' && (v as JsonRpc).id === id);
  if (!rpc) throw new McpError('bad_response', 'MCP server 没有返回对应的 JSON-RPC 响应');
  if (rpc.error) throw new McpError('protocol', `MCP 服务端报错（RPC ${Number(rpc.error.code) || -1}）`);
  return rpc;
}

async function post(url: string, auth: McpAuth | undefined, session: McpSession | undefined,
  message: object, opts: McpClientOpts): Promise<Response> {
  try {
    return await fetch(url, {
      method: 'POST', headers: headersFor(auth, session), body: JSON.stringify(message),
      redirect: 'error', signal: AbortSignal.timeout(Math.min(60_000, Math.max(100, opts.timeoutMs ?? 20_000))),
    });
  } catch (e) {
    if (e instanceof McpError) throw e;
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError'))
      throw new McpError('timeout', '连接 MCP server 超时');
    throw new McpError('network', '连不上 MCP server（地址不对 / 没起来 / 网络不通）');
  }
}

async function request(url: string, auth: McpAuth | undefined, session: McpSession | undefined,
  method: string, params: unknown, opts: McpClientOpts): Promise<{ result: unknown; response: Response }> {
  const id = rpcId++;
  const response = await post(url, auth, session, { jsonrpc: '2.0', id, method, params }, opts);
  try {
    const rpc = await readRpc(response, id);
    return { result: rpc.result, response };
  } catch (e) {
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError'))
      throw new McpError('timeout', 'MCP 响应超时');
    throw e;
  }
}

export async function openMcpSession(url: string, auth?: McpAuth, opts: McpClientOpts = {}): Promise<McpSession> {
  url = validateMcpEndpoint(url);
  const { result: raw, response } = await request(url, auth, undefined, 'initialize', {
    protocolVersion: opts.protocolVersion ?? PROTOCOL_VERSION, capabilities: {},
    clientInfo: { name: opts.clientName ?? 'ai-workbench', version: opts.clientVersion ?? '1.0' },
  }, opts);
  const result = (raw ?? {}) as { serverInfo?: { name?: string; version?: string }; protocolVersion?: string };
  const session: McpSession = {
    sessionId: response.headers.get('mcp-session-id') ?? undefined,
    protocolVersion: result.protocolVersion ?? PROTOCOL_VERSION,
    serverInfo: result.serverInfo,
  };
  const notification = await post(url, auth, session, { jsonrpc: '2.0', method: 'notifications/initialized' }, opts);
  if (!notification.ok) {
    await notification.body?.cancel().catch(() => undefined);
    throw new McpError('protocol', `MCP 初始化通知失败（HTTP ${notification.status}）`);
  }
  await notification.body?.cancel().catch(() => undefined); // 标准: 202 空响应
  return session;
}

function normalizeTool(v: unknown): McpTool | null {
  if (!v || typeof v !== 'object') return null;
  const t = v as Record<string, unknown>;
  if (typeof t.name !== 'string' || !/^[a-zA-Z0-9_.-]{1,64}$/.test(t.name)) return null;
  if (!t.inputSchema || typeof t.inputSchema !== 'object' || Array.isArray(t.inputSchema)) return null;
  const schema = t.inputSchema as Record<string, unknown>;
  if (schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object') return null;
  if (JSON.stringify(schema).length > 16_384) return null;
  return { name: t.name, description: typeof t.description === 'string' ? t.description.slice(0, 500) : undefined, inputSchema: schema };
}

export async function listMcpTools(url: string, auth?: McpAuth, opts: McpClientOpts = {}): Promise<McpTool[]> {
  const session = await openMcpSession(url, auth, opts);
  const all: McpTool[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 8; page++) {
    const { result } = await request(url, auth, session, 'tools/list', cursor ? { cursor } : {}, opts);
    const r = (result ?? {}) as { tools?: unknown; nextCursor?: unknown };
    if (!Array.isArray(r.tools)) throw new McpError('bad_response', 'MCP server 未返回工具列表');
    for (const entry of r.tools) {
      const t = normalizeTool(entry);
      if (!t) continue;
      if (seen.has(t.name)) throw new McpError('duplicate_tool', 'MCP server 返回了重名工具');
      seen.add(t.name);
      all.push(t);
      if (all.length > 40) throw new McpError('too_many_tools', 'MCP server 工具太多（上限 40）');
    }
    if (typeof r.nextCursor !== 'string' || !r.nextCursor) return all;
    if (r.nextCursor === cursor || r.nextCursor.length > 512) throw new McpError('bad_response', 'MCP 工具列表游标不合法');
    cursor = r.nextCursor;
  }
  throw new McpError('too_many_tools', 'MCP 工具列表分页过多（上限 8 页）');
}

export async function callMcpTool(url: string, auth: McpAuth | undefined, name: string,
  args: Record<string, unknown>, opts: McpClientOpts = {}): Promise<{ text: string; isError?: boolean }> {
  const session = await openMcpSession(url, auth, opts);
  const { result } = await request(url, auth, session, 'tools/call', { name, arguments: args }, opts);
  const r = (result ?? {}) as { content?: { type?: string; text?: string }[]; isError?: boolean };
  return {
    text: (Array.isArray(r.content) ? r.content : []).filter((x) => x?.type === 'text' && typeof x.text === 'string')
      .map((x) => x.text ?? '').join('\n').slice(0, 8000),
    isError: r.isError === true,
  };
}
