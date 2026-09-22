#!/usr/bin/env node
/**
 * 给某个会话造 N 条**加密的**消息，用来复现"聊天记录很长"这个真实场景。
 *
 * 为什么必须用服务端自己的 crypto：
 *   `messages.content_enc` 是 AES-256-GCM 密文，格式 `gcm$iv$tag$ct`。
 *   自己实现一遍很容易对不上（密钥派生、iv 长度、tag 顺序），
 *   所以直接 require 编译产物 `apps/server/dist/crypto.js` 的 `makeCipher`。
 *
 * 用法：
 *   node scripts/verify/seed-messages.mjs --conversation 12 --count 200
 *   node scripts/verify/seed-messages.mjs --conversation 12 --clear
 *
 * 只读写**开发库**（DATABASE_URL 取自 apps/server/.env），不碰别的库。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(path.dirname(HERE));
const require = createRequire(path.join(REPO, 'apps', 'server', 'package.json'));

// ---- 读 apps/server/.env（不覆盖已有环境变量，与 dotenv 行为一致）
const envPath = path.join(REPO, 'apps', 'server', '.env');
const env = {};
for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const s = line.trim();
  if (!s || s.startsWith('#') || !s.includes('=')) continue;
  const i = s.indexOf('=');
  env[s.slice(0, i).trim()] = s.slice(i + 1).trim();
}
if (!env.DATA_KEY || !env.DATABASE_URL) {
  console.error('apps/server/.env 里缺 DATA_KEY 或 DATABASE_URL');
  process.exit(2);
}

const { makeCipher } = require(path.join(REPO, 'apps', 'server', 'dist', 'crypto.js'));
const cipher = makeCipher(env.DATA_KEY);

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const convId = Number(flag('conversation', '0'));
const count = Number(flag('count', '200'));
const clear = args.includes('--clear');
if (!Number.isInteger(convId) || convId <= 0) {
  console.error('用法：node seed-messages.mjs --conversation <id> [--count 200] [--clear]');
  process.exit(2);
}

const { Client } = require('pg');
const client = new Client({ connectionString: env.DATABASE_URL });
await client.connect();

const own = await client.query('SELECT id, agent_id, project_id FROM conversations WHERE id = $1', [convId]);
if (own.rowCount !== 1) {
  console.error(`会话 ${convId} 不存在`);
  await client.end();
  process.exit(2);
}
console.log('会话：', own.rows[0]);

if (clear) {
  const r = await client.query('DELETE FROM messages WHERE conversation_id = $1', [convId]);
  console.log(`已清空 ${r.rowCount} 条`);
  await client.end();
  process.exit(0);
}

// 造点"像真的"内容：长短不一、含网址、含换行、含少量 emoji —— 覆盖渲染路径
const TOPICS = [
  '帮我看下这个项目的目录结构', '把刚才那段总结成三条要点', '这个报错是什么意思',
  '帮我写一个读取 CSV 的脚本', '上次说的那个方案再展开讲讲', '对比一下这两种实现',
  '为什么这里要用事务', '这个接口的返回格式是什么', '帮我改成 TypeScript',
  '这里为什么会有并发问题',
];
const FILLER = [
  '好的，我先看一下代码。',
  '这个问题通常有三个原因：一是……二是……三是……',
  '结论：建议改成显式事务，并用 SELECT ... FOR UPDATE 先锁行，避免 TOCTOU。',
  '参考 https://example.com/docs/guide 这一节，里面讲得比较清楚。',
  '第一点：把状态机拆成两个字段。\n第二点：读路径不要写库。\n第三点：失败要能重试。',
  '这个 API 返回 `{ ok: true, data: [...] }`，注意 `ok` 为 false 时要看 `error`。',
  '嗯，我理解你的意思了。让我确认一下：你是想让它**在后台跑**，还是**每 5 分钟轮询**？',
  '已经改好了，改动只在 useBrowserWorkspace.ts 一个文件里，其他文件没动。',
  '⚠️ 这里有个坑：`opacity:0` 不会让 Chromium 认为页面不可见，所以定时器不会被钳制。',
  '简单说：CPU 只占 0.2%，内存 +111MB，帧率锁 60fps，没有掉帧。',
];

const rows = [];
for (let i = 0; i < count; i++) {
  const role = i % 2 === 0 ? 'user' : 'assistant';
  const base = role === 'user' ? TOPICS[i % TOPICS.length] : FILLER[i % FILLER.length];
  // 让长度有变化（短的 10 字、长的 400+ 字）
  const pad = role === 'assistant' && i % 5 === 0
    ? '\n\n' + Array.from({ length: 6 }, (_, k) => `补充第 ${k + 1} 条说明：这一段的目的是把内容拉长，模拟真实回答的长度。`).join('\n')
    : '';
  rows.push([convId, role, cipher.encryptText(base + pad)]);
}

// 批量插入（一次 100 条）
let inserted = 0;
for (let i = 0; i < rows.length; i += 100) {
  const chunk = rows.slice(i, i + 100);
  const vals = [];
  const ph = chunk.map((r, k) => {
    vals.push(r[0], r[1], r[2]);
    return `($${k * 3 + 1}, $${k * 3 + 2}, $${k * 3 + 3})`;
  });
  const res = await client.query(
    `INSERT INTO messages (conversation_id, role, content_enc) VALUES ${ph.join(',')}`,
    vals,
  );
  inserted += res.rowCount;
}
const total = await client.query('SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1', [convId]);
console.log(`已插入 ${inserted} 条；该会话现在共 ${total.rows[0].n} 条`);
await client.end();
