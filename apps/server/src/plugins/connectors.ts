/** 片3 · 原生 GitHub / 飞书只读连接器（真 REST 实现，零全局 gh 登录态）。
 * 官方 API：GitHub https://docs.github.com/en/rest/issues/issues；Feishu
 * https://open.feishu.cn/document/ukTMukTMukTM/uUDN04SN0QjL1QDN/document-docx/docx-overview
 * 外部响应白名单整形 + 限长，错误不透传上游正文/密钥。
 */
import { validateMcpEndpoint } from './mcp';
import type { PluginConfig } from './config';

export class ConnectorError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ConnectorError'; }
}
const SEGMENT = /^[a-zA-Z0-9_.-]{1,80}$/;
const TOKEN = /^[a-zA-Z0-9_-]{1,128}$/;
function pathSegment(value: string, label: string, re = SEGMENT): string {
  const v = String(value ?? '').trim();
  if (!re.test(v) || v === '.' || v === '..') throw new ConnectorError('bad_args', `${label} 不合法`);
  return encodeURIComponent(v);
}
function apiBase(input: string, fallback: string): string {
  try { return validateMcpEndpoint(input?.trim() || fallback).replace(/\/+$/, ''); }
  catch { throw new ConnectorError('bad_url', 'API 地址不正确：公网必须 HTTPS，本机可 HTTP'); }
}
async function getJson(url: string, headers: Record<string, string>, opts: { method?: string; body?: string } = {}): Promise<unknown> {
  try {
    const response = await fetch(url, {
      method: opts.method ?? 'GET', body: opts.body, headers,
      redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ConnectorError('upstream_http', `上游返回 HTTP ${response.status}（检查密钥、权限和地址）`);
    }
    const len = Number(response.headers.get('content-length') || 0);
    if (len > 1_000_000) throw new ConnectorError('response_too_large', '上游响应太大');
    const reader = response.body?.getReader();
    if (!reader) throw new ConnectorError('bad_response', '上游响应为空');
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 1_000_000) throw new ConnectorError('response_too_large', '上游响应太大');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    try { return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))); }
    catch { throw new ConnectorError('bad_response', '上游响应不是 JSON'); }
  } catch (err) {
    if (err instanceof ConnectorError) throw err;
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError'))
      throw new ConnectorError('timeout', '上游请求超时');
    throw new ConnectorError('network', '上游连不上（网络或地址不可用）');
  }
}
const txt = (v: unknown, n = 400) => typeof v === 'string' ? v.slice(0, n) : '';
export interface ConnectorTestResult { ok: boolean; detail: string; error?: string }

/** GitHub PAT 与指定 API origin（默认 api.github.com） */
export function githubConnector(cfg: PluginConfig) {
  const key = String(cfg.apiToken ?? '').trim();
  if (!key) throw new ConnectorError('not_configured', '还没填 GitHub Token');
  const base = apiBase(cfg.baseUrl, 'https://api.github.com');
  const headers = { authorization: `Bearer ${key}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  const request = (path: string) => getJson(`${base}${path}`, headers);
  return {
    async test(): Promise<ConnectorTestResult> {
      try {
        const j = await request('/user') as { login?: string };
        return { ok: true, detail: `已连通 GitHub（${txt(j.login, 80) || '已认证'}）` };
      } catch (err) { return { ok: false, detail: (err as ConnectorError).message, error: (err as ConnectorError).code }; }
    },
    async listIssues(owner: string, repo: string, state: 'open' | 'closed' | 'all' = 'open') {
      const o = pathSegment(owner, '仓库 owner');
      const r = pathSegment(repo, '仓库 repo');
      if (!['open', 'closed', 'all'].includes(state)) throw new ConnectorError('bad_args', 'state 必须是 open/closed/all');
      const rows = await request(`/repos/${o}/${r}/issues?state=${state}&per_page=20`) as unknown;
      if (!Array.isArray(rows)) throw new ConnectorError('bad_response', 'GitHub issues 响应不正确');
      return rows.filter((v) => !!v && typeof v === 'object' && !('pull_request' in v)).slice(0, 20).map((v) => ({
        number: Number(v.number), title: txt(v.title, 250), state: txt(v.state, 16),
        url: txt(v.html_url, 500), body: txt(v.body, 1200),
      }));
    },
    async readIssue(owner: string, repo: string, number: number) {
      const o = pathSegment(owner, '仓库 owner'); const r = pathSegment(repo, '仓库 repo');
      if (!Number.isInteger(number) || number <= 0 || number > 1_000_000_000) throw new ConnectorError('bad_args', 'issue 编号不正确');
      const v = await request(`/repos/${o}/${r}/issues/${number}`) as Record<string, unknown>;
      if (!v || v.pull_request) throw new ConnectorError('not_issue', '这是 PR，不是 issue');
      return { number: Number(v.number), title: txt(v.title, 250), state: txt(v.state, 16),
        url: txt(v.html_url, 500), body: txt(v.body, 6000) };
    },
  };
}

/** 飞书应用：用 App ID+Secret 换 tenant_access_token，按应用授权读 docx / 云盘。 */
export function feishuConnector(cfg: PluginConfig) {
  const id = String(cfg.appId ?? '').trim();
  const secret = String(cfg.appSecret ?? '').trim();
  if (!id || !secret) throw new ConnectorError('not_configured', '还没配飞书 App ID / App Secret');
  const base = apiBase(cfg.baseUrl, 'https://open.feishu.cn');
  async function token(): Promise<string> {
    const r = (await getJson(`${base}/open-apis/auth/v3/tenant_access_token/internal`,
      { 'content-type': 'application/json' }, { method: 'POST', body: JSON.stringify({ app_id: id, app_secret: secret }) })) as { code?: number; tenant_access_token?: string };
    if (r?.code !== 0 || !r.tenant_access_token) throw new ConnectorError('auth_failed', '飞书应用鉴权失败（检查 App ID/Secret）');
    return r.tenant_access_token;
  }
  async function request(path: string) {
    const accessToken = await token();
    const r = (await getJson(`${base}/open-apis${path}`, { authorization: `Bearer ${accessToken}`, accept: 'application/json' })) as { code?: number; data?: any };
    if (r?.code !== 0) throw new ConnectorError('upstream_error', `飞书接口失败（code ${Number(r?.code) || -1}，检查应用权限）`);
    return r.data ?? {};
  }
  return {
    async test(): Promise<ConnectorTestResult> {
      try { await token(); return { ok: true, detail: '飞书应用凭据有效（已取得 tenant_access_token）；读取文档还需单独授权。' }; }
      catch (err) { return { ok: false, detail: (err as ConnectorError).message, error: (err as ConnectorError).code }; }
    },
    async listFiles(folderToken?: string) {
      const folder = folderToken?.trim() ? `&folder_token=${pathSegment(folderToken, 'folder token', TOKEN)}` : '';
      const data = await request(`/drive/v1/files?page_size=20${folder}`);
      const rows = Array.isArray(data.files) ? data.files : Array.isArray(data.items) ? data.items : [];
      return rows.slice(0, 20).map((v: any) => ({ name: txt(v.name, 200), type: txt(v.type, 50),
        token: txt(v.token, 128), url: txt(v.url, 500) }));
    },
    async readDoc(documentId: string) {
      const doc = pathSegment(documentId, 'document_id', TOKEN);
      const data = await request(`/docx/v1/documents/${doc}/raw_content`);
      return { documentId, content: txt(data.content, 8000) };
    },
  };
}
