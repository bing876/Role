/** 片2 · 公网 MCP live smoke。需要真外网（失败非跳过；不将网络失败记作上线成功）。
 * MCP_PUBLIC_URL 默认 DeepWiki 的公开 Streamable HTTP 端点。
 * MCP_PUBLIC_TOOL 可显式指定只读工具名；否则至少验证 initialize + tools/list 的真实协议调用。
 * 用法：npm run verify:mcp:public
 */
import assert from 'node:assert/strict';
import { callMcpTool, listMcpTools } from '../../apps/server/src/plugins/mcp';

const url = process.env.MCP_PUBLIC_URL || 'https://mcp.deepwiki.com/mcp';
const name = process.env.MCP_PUBLIC_TOOL;
try {
  const tools = await listMcpTools(url, {}, { timeoutMs: 20_000 });
  assert.ok(tools.length > 0, '公开 server 未返回任何工具');
  console.log(`PUBLIC MCP OK: ${tools.length} tools: ${tools.map((t) => t.name).slice(0, 8).join(', ')}`);
  if (name) {
    assert.ok(tools.some((t) => t.name === name), `公开 server 中没有 ${name}`);
    const args = JSON.parse(process.env.MCP_PUBLIC_ARGS || '{}') as Record<string, unknown>;
    const r = await callMcpTool(url, {}, name, args, { timeoutMs: 30_000 });
    assert.equal(r.isError, false, '公开 server 的工具执行报错');
    assert.ok(r.text, '公开 server 工具回了空结果');
    console.log(`PUBLIC MCP CALL OK: ${name}，结果 ${r.text.length} 字`);
  }
} catch (err) {
  // 不打印 URL 中敏感参数/上游响应（错误是已脱敏 McpError）
  console.error(`PUBLIC MCP FAIL: ${(err as Error).message}`);
  process.exitCode = 1;
}
