/** 片3 · GitHub / 飞书原生只读工具：注册表定义 + 用户加密配置 → 真 REST。
 * 没配置/解不开 → not_configured、不外呼；所有结果都白名单整形。
 * 不提供自动发消息/写文档/建 Issue 等有副作用工具。
 */
import type { ToolDefinition, LoopToolResult } from '@ai-workbench/shared';
import type { Pool } from 'pg';
import type { JsonCipher } from '../crypto';
import type { ServerExecutionContext } from '../toolRegistry';
import { registerServerTool } from '../toolRegistry';
import { loadPluginConfig, isConfigComplete } from '../plugins/config';
import { ConnectorError, githubConnector, feishuConnector } from '../plugins/connectors';

function def(name: string, description: string, properties: Record<string, unknown>, required: string[],
  check: (args: Record<string, unknown>) => boolean): ToolDefinition {
  return {
    name, description,
    parameters: { type: 'object', properties, required, additionalProperties: false } as ToolDefinition['parameters'],
    side: 'server', kind: 'action', timeoutMs: 50_000,
    validate: (args) => check(args)
      ? { ok: true, args }
      : { ok: false, reason: 'bad_args', question: '连接器参数不正确，请检查仓库名/文档 ID。' },
  };
}
const repoName = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(v) && v !== '.' && v !== '..';
const documentId = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const repoProps = {
  owner: { type: 'string', description: '仓库所属用户/组织（例如 octocat）' },
  repo: { type: 'string', description: '仓库名（例如 Hello-World）' },
};
export const CONNECTOR_TOOLS: ToolDefinition[] = [
  def('github_list_issues', '从当前用户连接的 GitHub 仓库读取前 20 个 issue（不含 PR）；只读，不创建/修改。用于用户询问仓库待办/进度。',
    { ...repoProps, state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'issue 状态（默认 open）' } },
    ['owner', 'repo'], (a) => repoName(a.owner) && repoName(a.repo) && (a.state === undefined || ['open', 'closed', 'all'].includes(a.state as string))),
  def('github_read_issue', '读取当前用户连接的 GitHub 仓库中的一条 issue 正文（不是 PR），只读。',
    { ...repoProps, number: { type: 'integer', description: 'issue 编号' } }, ['owner', 'repo', 'number'],
    (a) => repoName(a.owner) && repoName(a.repo) && Number.isInteger(a.number) && Number(a.number) > 0),
  def('feishu_list_files', '列出当前用户连接的飞书应用有权限访问的云盘文件（前 20 个）；只读，非整个用户私有云盘。',
    { folderToken: { type: 'string', description: '文件夹 token（可选；不填列应用可见的根目录）' } }, [],
    (a) => a.folderToken === undefined || documentId(a.folderToken)),
  def('feishu_read_doc', '读取当前用户飞书应用**已授权**的一篇 docx 文档正文；只读，不发送/修改。',
    { documentId: { type: 'string', description: 'docx 文档 ID/token（从文档链接获得）' } }, ['documentId'],
    (a) => documentId(a.documentId)),
];

/** 每次执行都按 ctx.userId 查密文配置，防跨账号串 key。 */
export async function executeConnectorTool(name: string, args: Record<string, unknown>, ctx: ServerExecutionContext,
  pool: Pool, cipher: JsonCipher): Promise<LoopToolResult> {
  const id = name.startsWith('github_') ? 'github' : name.startsWith('feishu_') ? 'feishu' : '';
  const definition = CONNECTOR_TOOLS.find((x) => x.name === name);
  if (!id || !definition) return { ok: false, error: 'unknown_tool', detail: '没有这个原生连接器工具' };
  if (!definition.validate(args, { snapshot: null }).ok)
    return { ok: false, error: 'bad_args', detail: '连接器参数不正确（未外呼）' };
  const cfg = await loadPluginConfig(pool, cipher, ctx.userId, id);
  if (!isConfigComplete(cfg, id === 'github' ? ['apiToken'] : ['appId', 'appSecret']))
    return { ok: false, error: 'not_configured', detail: `还没配置「${id === 'github' ? 'GitHub' : '飞书'}」连接（设置 → 能力与连接）` };
  try {
    let data: unknown;
    if (id === 'github') {
      const p = githubConnector(cfg!);
      if (name === 'github_list_issues') data = await p.listIssues(String(args.owner), String(args.repo), args.state as 'open' | 'closed' | 'all' | undefined);
      else data = await p.readIssue(String(args.owner), String(args.repo), Number(args.number));
    } else {
      const p = feishuConnector(cfg!);
      if (name === 'feishu_list_files') data = await p.listFiles(args.folderToken as string | undefined);
      else data = await p.readDoc(String(args.documentId));
    }
    return { ok: true, detail: `${id === 'github' ? 'GitHub' : '飞书'}数据读取完成`, data };
  } catch (err) {
    const e = err instanceof ConnectorError ? err : new ConnectorError('connector_failed', '连接器暂时不可用');
    return { ok: false, error: e.code, detail: e.message };
  }
}

export function registerConnectorTools(pool: Pool, cipher: JsonCipher): void {
  for (const tool of CONNECTOR_TOOLS) {
    registerServerTool(tool, { execute: (args, ctx) => executeConnectorTool(tool.name, args, ctx, pool, cipher) });
  }
}
