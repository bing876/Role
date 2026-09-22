#!/usr/bin/env node
/**
 * 第 26 步 · 第一小步验收：**只验证 Tavily 联网搜索服务本身通不通**。
 *
 * 本脚本的边界（刻意收窄）：
 *   ✅ 读 apps/server/.env 取密钥、调用 apps/server/dist/search/tavily.js
 *   ✅ 真机向 Tavily 发真实请求，打印真实结果
 *   ✅ 用本地 mock server 确定性地打错误分支（不靠上游脸色）
 *   ❌ 不调用任何 AI 模型、不 import llm.ts、不认识 DeepSeek
 *   ❌ 不 import 任何浏览器相关模块（apps/desktop/**、webview、electron 一律不碰）
 *   ❌ 不改任何状态：只读 + 只在 .workbuddy-ai/tavily-search-test/ 下落盘取证
 *
 * 用法：
 *   node scripts/verify/tavily-search-check.mjs            # 全量（含真实联网）
 *   node scripts/verify/tavily-search-check.mjs --offline  # 跳过真实联网，只跑 mock/反证/隔离自检
 *   node scripts/verify/tavily-search-check.mjs --json     # 额外输出机器可读汇总
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const ENV_PATH = path.join(ROOT, 'apps', 'server', '.env');
const ENV_EXAMPLE = path.join(ROOT, 'apps', 'server', '.env.example');
const CLIENT_SRC = path.join(ROOT, 'apps', 'server', 'src', 'search', 'tavily.ts');
const CLIENT_DIST = path.join(ROOT, 'apps', 'server', 'dist', 'search', 'tavily.js');
const OUT_DIR = path.join(ROOT, '.workbuddy-ai', 'tavily-search-test');

const argv = process.argv.slice(2);
const OFFLINE = argv.includes('--offline');
const EMIT_JSON = argv.includes('--json');

let pass = 0;
let fail = 0;
const failures = [];

function chk(id, ok, detail) {
  const tag = ok ? 'PASS' : 'FAIL';
  if (ok) pass += 1;
  else {
    fail += 1;
    failures.push(`${id} ${detail ?? ''}`.trim());
  }
  console.log(`[${tag}] ${id}${detail ? ' — ' + detail : ''}`);
  return Boolean(ok);
}

function section(title) {
  console.log(`\n===== ${title} =====`);
}

/**
 * 剥掉注释后再做标识扫描。
 * ⚠️ 别省这一步：源码顶部那段注释**专门用来声明"本文件不碰浏览器/不绑模型"**，
 *    连注释一起扫会把"免责说明"误判成"引用了浏览器"。
 * `(^|[^:])` 是为了不误伤字符串里的 `https://`。
 */
function stripComments(code) {
  return String(code)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
}

/** 极简 .env 解析（不引第三方依赖）：KEY=VALUE，忽略注释与空行，去掉包裹引号 */
function loadDotEnv(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

/** 起一个本地 mock Tavily：按需回状态码 / 原始 body，并记录收到的请求（含头与 body） */
async function withMockServer(handler, fn) {
  const hits = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      hits.push({ url: req.url, method: req.method, headers: req.headers, bodyText });
      handler(req, res, bodyText);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    return await fn({ baseUrl, hits, port });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function jsonReply(res, status, payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(text);
}

async function expectError(label, promise, expectedCode) {
  try {
    await promise;
    return chk(label, false, `预期抛 WebSearchError(${expectedCode})，但成功返回了`);
  } catch (err) {
    const code = err?.code ?? '(no-code)';
    const ok = code === expectedCode;
    return chk(label, ok, ok ? `code=${code}` : `预期 code=${expectedCode}，实际 code=${code}（${err?.message}）`);
  }
}

// ---------------------------------------------------------------- 主流程

async function main() {
  console.log('Tavily 联网搜索 · 服务连通性自检（第 26 步 · 第一小步）');
  console.log(`仓库根：${ROOT}`);
  console.log(`模式：${OFFLINE ? '离线（跳过真实联网）' : '在线（含真实联网）'}\n`);

  // ---------- 0. 加载被测客户端 ----------
  section('0. 加载被测客户端');
  if (!chk('0.1 编译产物存在', existsSync(CLIENT_DIST), CLIENT_DIST.replace(ROOT + path.sep, ''))) {
    console.log('      先跑：npm run build -w @ai-workbench/server');
    return;
  }
  const mod = await import(pathToFileURL(CLIENT_DIST).href);
  chk('0.2 导出 webSearch', typeof mod.webSearch === 'function');
  chk('0.3 导出 WebSearchError', typeof mod.WebSearchError === 'function');
  chk('0.4 导出 webSearchConfigFromEnv', typeof mod.webSearchConfigFromEnv === 'function');
  if (typeof mod.webSearch !== 'function') return;
  const { webSearch, WebSearchError, webSearchConfigFromEnv, describeApiKey, redactSecrets } = mod;

  // ---------- A. 密钥与环境 ----------
  section('A. 密钥存放与环境');
  const env = loadDotEnv(ENV_PATH);
  chk('A.1 能读到 apps/server/.env', Object.keys(env).length > 0, `${Object.keys(env).length} 个键`);
  const apiKey = (env.TAVILY_API_KEY ?? '').trim();
  chk('A.2 TAVILY_API_KEY 非空', apiKey.length > 0, describeApiKey(apiKey));
  chk('A.3 密钥格式像 Tavily key', apiKey.startsWith('tvly-') && apiKey.length >= 20, `长度 ${apiKey.length}`);
  chk(
    'A.4 TAVILY_BASE_URL 合法',
    /^https?:\/\//.test(env.TAVILY_BASE_URL ?? ''),
    env.TAVILY_BASE_URL ?? '(空)',
  );

  const ignore = spawnSync('git', ['check-ignore', '-v', 'apps/server/.env'], { cwd: ROOT, encoding: 'utf8' });
  chk('A.5 .env 被 .gitignore 挡住', ignore.status === 0, (ignore.stdout || '').trim());

  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', 'apps/server/.env'], { cwd: ROOT, encoding: 'utf8' });
  chk('A.6 .env 不在 git 索引里', tracked.status !== 0);

  const example = existsSync(ENV_EXAMPLE) ? readFileSync(ENV_EXAMPLE, 'utf8') : '';
  const exampleVal = (example.match(/^TAVILY_API_KEY=(.*)$/m) ?? [, ''])[1].trim();
  chk('A.7 .env.example 里的 TAVILY_API_KEY 是空值', exampleVal === '', `值="${exampleVal}"`);
  chk('A.8 .env.example 不含任何 tvly- 明文', !/tvly-[A-Za-z0-9_-]{8,}/.test(example));

  const config = webSearchConfigFromEnv({ tavilyApiKey: apiKey, tavilyBaseUrl: env.TAVILY_BASE_URL });
  chk('A.9 能由环境构造出配置', config.apiKey === apiKey && /^https?:\/\//.test(config.baseUrl));

  // ---------- B. 真实联网 ----------
  section('B. 真实联网（真机验证）');
  const realReports = [];
  if (OFFLINE) {
    console.log('[SKIP] B.* —— 本次为 --offline，未发真实请求');
  } else {
    // B1/B2/B6：最典型的「需要联网才知道」的问题
    const q1 = '今天有什么新闻';
    try {
      const r1 = await webSearch(config, q1, { maxResults: 5 });
      realReports.push({ label: q1, response: r1 });
      chk('B.1 常规查询有返回', r1.results.length > 0, `${r1.results.length} 条 / ${r1.tookMs}ms`);
      const bad = r1.results.filter(
        (it) => !it.title || !/^https?:\/\//.test(it.url) || !it.content,
      );
      chk('B.2 每条结果结构合法（title/url/content）', bad.length === 0, bad.length ? `${bad.length} 条不合法` : '全部合法');
      const allUrls = r1.results.every((it) => /^https?:\/\//.test(it.url));
      chk('B.3 url 都是 http(s) 绝对地址', allUrls);
      chk('B.4 query 回显正确', r1.query.length > 0, r1.query);

      console.log('\n--- 真实返回（' + q1 + '）---');
      r1.results.forEach((it, i) => {
        console.log(`${i + 1}. ${it.title}`);
        console.log(`   ${it.url}`);
        console.log(`   ${it.content.replace(/\s+/g, ' ').slice(0, 220)}${it.content.length > 220 ? '…' : ''}`);
        console.log(`   (score=${it.score})`);
      });
      console.log('');
    } catch (err) {
      chk('B.1 常规查询有返回', false, `${err?.code}: ${err?.message}`);
    }

    // B5：news 主题 + 只要最近 2 天
    const q2 = '今日要闻';
    try {
      const r2 = await webSearch(config, q2, { topic: 'news', days: 2, maxResults: 5 });
      realReports.push({ label: `${q2} (topic=news, days=2)`, response: r2 });
      chk('B.5 news 主题查询有返回', r2.results.length > 0, `${r2.results.length} 条 / ${r2.tookMs}ms`);
      console.log('\n--- 真实返回（' + q2 + ' · topic=news）---');
      r2.results.slice(0, 3).forEach((it, i) => {
        console.log(`${i + 1}. ${it.title}  <${it.url}>`);
      });
      console.log('');
    } catch (err) {
      chk('B.5 news 主题查询有返回', false, `${err?.code}: ${err?.message}`);
    }

    // B7：让上游顺带给一段简短回答
    try {
      const r3 = await webSearch(config, '今天北京天气怎么样', { includeAnswer: true, maxResults: 3 });
      realReports.push({ label: '今天北京天气怎么样 (includeAnswer)', response: r3 });
      chk('B.7 includeAnswer 请求成功', r3.results.length > 0 || Boolean(r3.answer), `${r3.results.length} 条`);
      if (r3.answer) console.log(`\n--- 上游简短回答 ---\n${r3.answer}\n`);
    } catch (err) {
      chk('B.7 includeAnswer 请求成功', false, `${err?.code}: ${err?.message}`);
    }

    // B8：中文问题与英文问题都通（能力与语言无关）
    try {
      const r4 = await webSearch(config, 'OpenAI latest news', { maxResults: 3 });
      realReports.push({ label: 'OpenAI latest news', response: r4 });
      chk('B.8 英文查询有返回', r4.results.length > 0, `${r4.results.length} 条`);
    } catch (err) {
      chk('B.8 英文查询有返回', false, `${err?.code}: ${err?.message}`);
    }
  }

  // ---------- C. 反证：故意注入坏条件，证明上面的 PASS 不是摆设 ----------
  section('C. 反证（注入坏条件）');

  // C1/C2：本地能判定的错误必须在本地拦掉，且**一次网络都不发**
  await withMockServer((req, res) => jsonReply(res, 200, { results: [] }), async ({ baseUrl, hits }) => {
    await expectError(
      'C.1 空查询 → bad_query',
      webSearch({ apiKey, baseUrl }, '   '),
      'bad_query',
    );
    chk('C.2 空查询时没有外呼', hits.length === 0, `实际命中 ${hits.length} 次`);

    await expectError(
      'C.3 未配置 key → not_configured',
      webSearch({ apiKey: '', baseUrl }, '今天有什么新闻'),
      'not_configured',
    );
    chk('C.4 未配置 key 时没有外呼', hits.length === 0, `实际命中 ${hits.length} 次`);
  });

  // C5：真实无效密钥必须被上游拒绝（证明鉴权链路真的在生效）
  if (!OFFLINE) {
    const bogus = 'tvly-dev-' + 'x'.repeat(40);
    await expectError(
      'C.5 无效密钥 → unauthorized（真上游）',
      webSearch({ apiKey: bogus, baseUrl: config.baseUrl }, '今天有什么新闻'),
      'unauthorized',
    );
  } else {
    console.log('[SKIP] C.5 —— 离线模式');
  }

  // C6：不可达地址 → network_error
  await expectError(
    'C.6 不可达地址 → network_error',
    webSearch({ apiKey, baseUrl: 'http://127.0.0.1:1' }, '今天有什么新闻', { timeoutMs: 3000 }),
    'network_error',
  );

  // C7~C11：用本地 mock 确定性地打各错误分支（不靠上游脸色）
  await withMockServer((req, res) => jsonReply(res, 401, { detail: 'unauthorized' }), async ({ baseUrl }) => {
    await expectError('C.7 mock 401 → unauthorized', webSearch({ apiKey, baseUrl }, 'q'), 'unauthorized');
  });
  await withMockServer((req, res) => jsonReply(res, 429, { detail: 'rate limit' }), async ({ baseUrl }) => {
    await expectError('C.8 mock 429 → rate_limited', webSearch({ apiKey, baseUrl }, 'q'), 'rate_limited');
  });
  await withMockServer((req, res) => jsonReply(res, 432, { detail: 'plan limit' }), async ({ baseUrl }) => {
    await expectError('C.9 mock 432 → rate_limited', webSearch({ apiKey, baseUrl }, 'q'), 'rate_limited');
  });
  await withMockServer((req, res) => jsonReply(res, 500, { detail: 'boom' }), async ({ baseUrl }) => {
    await expectError('C.10 mock 500 → upstream_error', webSearch({ apiKey, baseUrl }, 'q'), 'upstream_error');
  });
  await withMockServer((req, res) => jsonReply(res, 200, '<html>not json</html>'), async ({ baseUrl }) => {
    await expectError('C.11 mock 200 非 JSON → bad_response', webSearch({ apiKey, baseUrl }, 'q'), 'bad_response');
  });
  await withMockServer((req, res) => jsonReply(res, 200, { answer: 'x' }), async ({ baseUrl }) => {
    await expectError('C.12 mock 200 缺 results → bad_response', webSearch({ apiKey, baseUrl }, 'q'), 'bad_response');
  });

  // C13：请求契约 —— key 只走 Authorization 头，body 里绝不能有 key
  await withMockServer(
    (req, res) => jsonReply(res, 200, { query: 'q', results: [{ title: 't', url: 'https://e.com', content: 'c', score: 1 }] }),
    async ({ baseUrl, hits }) => {
      const r = await webSearch({ apiKey, baseUrl }, 'q', { maxResults: 2, topic: 'news', days: 2 });
      chk('C.13 mock 200 合法 → 正常解析', r.results.length === 1 && r.results[0].url === 'https://e.com');
      const h = hits[0] ?? { headers: {}, bodyText: '' };
      chk('C.14 密钥走 Authorization: Bearer 头', h.headers?.authorization === `Bearer ${apiKey}`);
      chk('C.15 请求 body 里不含密钥', !h.bodyText.includes(apiKey), h.bodyText.slice(0, 120));
      const sent = JSON.parse(h.bodyText || '{}');
      chk('C.16 请求打到 /search 且方法为 POST', h.url === '/search' && h.method === 'POST');
      chk('C.17 news+days 参数被带上', sent.topic === 'news' && sent.days === 2 && sent.max_results === 2);
    },
  );

  // C18：脱敏函数本身有效（防止 key 顺着错误消息漏出去）
  chk('C.18 redactSecrets 能抹掉密钥', !redactSecrets(`oops ${apiKey} oops`).includes(apiKey));
  chk('C.19 describeApiKey 不吐密钥本体', !describeApiKey(apiKey).includes(apiKey.slice(9)));

  // C20：所有抛出过的错误消息都不含密钥（把 mock 与真上游两条路都覆盖）
  const leaked = [];
  const probes = [
    () => webSearch({ apiKey, baseUrl: 'http://127.0.0.1:1' }, 'q', { timeoutMs: 2000 }),
    () => webSearch({ apiKey: 'tvly-dev-' + 'y'.repeat(40), baseUrl: 'http://127.0.0.1:1' }, 'q', { timeoutMs: 2000 }),
  ];
  for (const p of probes) {
    try {
      await p();
    } catch (err) {
      const blob = `${err?.message ?? ''} ${JSON.stringify(err ?? {})}`;
      if (blob.includes(apiKey) && apiKey) leaked.push(blob.slice(0, 80));
    }
  }
  chk('C.20 错误对象里不含真实密钥', leaked.length === 0, leaked.join(' | '));

  // ---------- D. 隔离自检 ----------
  section('D. 隔离自检（与浏览器 / 模型无交集）');
  const src = readFileSync(CLIENT_SRC, 'utf8');
  // ★ 只扫**代码**，剥掉注释：文件顶部那段注释正是在说明"本文件刻意不碰浏览器/不绑模型"，
  //   如果连注释一起扫，断言就会把"写了免责说明"误判成"引用了浏览器"（本脚本第一版就踩了这个坑）。
  const codeOnly = stripComments(src);
  const browserTokens = ['webview', 'BrowserPanel', 'openBrowser', 'setWindowOpenHandler', 'ipcMain', 'webContents', 'electron', 'browserLayer'];
  const modelTokens = ['deepseek', 'DEEPSEEK', 'chat/completions', 'llmFetch', 'tool_calls', 'openai'];
  const hitBrowser = browserTokens.filter((t) => new RegExp(t, 'i').test(codeOnly));
  const hitModel = modelTokens.filter((t) => new RegExp(t, 'i').test(codeOnly));
  chk('D.1 客户端**代码**不含浏览器相关标识', hitBrowser.length === 0, hitBrowser.join(',') || '无（注释里的说明不计）');
  chk('D.2 客户端**代码**不含模型相关标识', hitModel.length === 0, hitModel.join(',') || '无（注释里的说明不计）');
  chk('D.3 客户端源码零 import（与任何模块解耦）', !/^\s*import\s/m.test(codeOnly));
  // D.4：结构性证明 —— 编译产物里连一次 require 都没有 ⇒ 运行时依赖图是空的
  const distCode = stripComments(readFileSync(CLIENT_DIST, 'utf8'));
  chk('D.4 编译产物零 require（运行时依赖图为空）', !/\brequire\s*\(/.test(distCode));
  chk('D.5 编译产物代码里也无浏览器/模型标识', !browserTokens.some((t) => new RegExp(t, 'i').test(distCode)) && !modelTokens.some((t) => new RegExp(t, 'i').test(distCode)));

  // ---------- 落盘取证 ----------
  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(OUT_DIR, `tavily-search-${stamp}.json`);
  const report = {
    at: new Date().toISOString(),
    mode: OFFLINE ? 'offline' : 'online',
    key: describeApiKey(apiKey),
    pass,
    fail,
    failures,
    realResponses: realReports.map((r) => ({ label: r.label, ...r.response })),
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n取证落盘：${reportPath.replace(ROOT + path.sep, '')}`);

  if (EMIT_JSON) console.log('\n' + JSON.stringify({ pass, fail, failures }, null, 2));

  console.log(`\n===== 汇总：${pass} PASS / ${fail} FAIL =====`);
  if (fail > 0) console.log('失败项：\n - ' + failures.join('\n - '));
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('脚本自身异常：', err);
  process.exitCode = 2;
});
