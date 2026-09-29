/** 片3 · GitHub / 飞书真上游 live 验收（明确需外部 key；无 key 退出 1，不伪称通过）。
 * CONNECTORS_GITHUB_TOKEN, CONNECTORS_GITHUB_OWNER, CONNECTORS_GITHUB_REPO
 * CONNECTORS_FEISHU_APP_ID, CONNECTORS_FEISHU_APP_SECRET, CONNECTORS_FEISHU_DOCUMENT_ID
 * 所有凭据只读 env，不入库、不打印、不把原始上游错误回显。
 */
import assert from 'node:assert/strict';
import { githubConnector, feishuConnector } from '../../apps/server/src/plugins/connectors';
const gh = process.env.CONNECTORS_GITHUB_TOKEN;
const fsId = process.env.CONNECTORS_FEISHU_APP_ID;
const fsSecret = process.env.CONNECTORS_FEISHU_APP_SECRET;
if (!gh && !(fsId && fsSecret)) {
  console.error('LIVE 未运行：请设置 CONNECTORS_GITHUB_TOKEN 或 CONNECTORS_FEISHU_APP_ID+CONNECTORS_FEISHU_APP_SECRET');
  process.exitCode = 1;
} else {
  try {
    if (gh) {
      const p = githubConnector({ apiToken: gh });
      const test = await p.test(); assert.ok(test.ok, `GitHub 测试失败：${test.detail}`);
      const owner = process.env.CONNECTORS_GITHUB_OWNER; const repo = process.env.CONNECTORS_GITHUB_REPO;
      if (owner && repo) {
        const issues = await p.listIssues(owner, repo);
        assert.ok(Array.isArray(issues));
        console.log(`GitHub live：${owner}/${repo} issues 真返回 ${issues.length} 条`);
      } else console.log('GitHub live：身份测试通过（未指定仓库，列表未测）');
    }
    if (fsId && fsSecret) {
      const p = feishuConnector({ appId: fsId, appSecret: fsSecret });
      const test = await p.test(); assert.ok(test.ok, `飞书测试失败：${test.detail}`);
      const doc = process.env.CONNECTORS_FEISHU_DOCUMENT_ID;
      if (doc) {
        const result = await p.readDoc(doc);
        assert.ok(result.content, '飞书文档正文为空');
        console.log(`飞书 live：已授权文档真返回 ${result.content.length} 字`);
      } else console.log('飞书 live：租户授权测试通过（未指定文档，读文档未测）');
    }
  } catch (err) { console.error(`LIVE 失败：${(err as Error).message}`); process.exitCode = 1; }
}
