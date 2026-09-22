// show-sms-code.cjs —— 从库里反推某手机号最新验证码（开发期 mock 模式下用）
// 用法：node scripts/verify/show-sms-code.cjs [手机号]
const crypto = require('crypto');
const { Client } = require('pg');

// ★ pepper 必须按**服务端真实的优先级**取：真实环境变量 → .env 的 PHONE_PEPPER → DATA_KEY。
//   （PHONE_PEPPER 已经轮换成一个独立值，硬编码旧值会反推不到 —— 踩过。）
const fs = require('fs');
const path = require('path');
function readPepper() {
  if (process.env.PHONE_PEPPER) return process.env.PHONE_PEPPER;
  try {
    const txt = fs.readFileSync(path.join(__dirname, '..', '..', 'apps', 'server', '.env'), 'utf8');
    const pick = (k) => {
      const m = txt.match(new RegExp('^\\s*' + k + '\\s*=\\s*(.*)$', 'm'));
      return m ? m[1].replace(/^["']|["']$/g, '').trim() : '';
    };
    return pick('PHONE_PEPPER') || pick('DATA_KEY');
  } catch { return ''; }
}
const PEPPER = readPepper()
  || '37e9158ac1e8b27befae29e59e0f94dc7d3b5f9408e853f9afcde816231cf887';
const PHONE = process.argv[2] || '18665594441';

(async () => {
  const db = new Client({ connectionString: 'postgresql://workbench:workbench@localhost:5432/workbench' });
  await db.connect();
  const h = crypto.createHmac('sha256', PEPPER).update(PHONE, 'utf8').digest('hex');
  const rows = (await db.query(
    'SELECT id, code_hash, salt, expires_at, used, created_at FROM sms_codes WHERE phone_hash = $1 ORDER BY created_at DESC LIMIT 3',
    [h])).rows;
  if (!rows.length) {
    console.log('该手机号没有任何发码记录（说明「获取验证码」没成功发出去）');
  }
  for (const r of rows) {
    let code = null;
    if (!r.used) {
      for (let i = 0; i < 1_000_000; i++) {
        const c = String(i).padStart(6, '0');
        if (crypto.createHash('sha256').update(r.salt + '$' + c, 'utf8').digest('hex') === r.code_hash) {
          code = c; break;
        }
      }
    }
    const left = Math.round((r.expires_at - Date.now()) / 1000);
    console.log(
      `id=${r.id}  码=${code || '(已使用)'}  used=${r.used}  ` +
      `剩余=${left > 0 ? left + 's' : '已过期'}  现在可用=${!r.used && left > 0}`);
  }
  await db.end();
})().catch((e) => { console.error('ERR', e && e.message ? e.message : e); process.exit(1); });
