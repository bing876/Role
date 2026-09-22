// reset-accounts.cjs —— 把账号库清成"只留一个手机号"，并保证**可回滚**。
//
// 用法：
//   node scripts/verify/reset-accounts.cjs backup            # 导出全部表 → JSON（不删任何东西）
//   node scripts/verify/reset-accounts.cjs purge             # 删除除 KEEP 外的账号（先自动备份）
//   node scripts/verify/reset-accounts.cjs verify            # 核对只剩 1 个 + 该账号能登录
//   node scripts/verify/reset-accounts.cjs restore <file>    # 从备份文件恢复
//
// 保留哪个号：环境变量 KEEP_PHONE，默认 18665594441。
//
// ★ 为什么必须自带备份：本机没有 `pg_dump`（便携包 pg\bin 只有 initdb/pg_ctl/postgres），
//   所以"导出成可回灌的 JSON"这件事得自己实现。删之前不备份 = 不可逆。
//
// ★ 级联已由外键保证（见下面 TABLES 注释）：删 users 一行会带走
//   projects → agents → conversations → messages / tasks / task_pauses 等，
//   只有 `sms_codes` 没有外键（它按 phone_hash 关联），要单独清。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..', '..');
const CS = 'postgresql://workbench:workbench@localhost:5432/workbench';
const KEEP_PHONE = process.env.KEEP_PHONE || '18665594441';
const BACKUP_DIR = path.join(REPO, 'docs', 'acceptance', 'root-cause');

/** 全部表，按"先删子表再删父表"的顺序无关 —— 这里只用于**整表导出/恢复**。 */
const TABLES = [
  'users', 'projects', 'agents', 'conversations', 'messages', 'tasks', 'task_pauses',
  'memories', 'user_memories', 'agent_memories',
  'knowledge_documents', 'knowledge_chunks', 'sms_codes',
];

function readEnvFile() {
  const o = {};
  for (const line of fs.readFileSync(path.join(REPO, 'apps', 'server', '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) o[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return o;
}
const phoneHash = (phone, pepper) => crypto.createHmac('sha256', pepper).update(phone, 'utf8').digest('hex');

async function connect() {
  const { Client } = require(path.join(REPO, 'node_modules', 'pg'));
  const db = new Client({ connectionString: CS });
  await db.connect();
  return db;
}

const counts = async (db) => {
  const o = {};
  for (const t of TABLES) {
    try { o[t] = (await db.query(`SELECT count(*)::int n FROM "${t}"`)).rows[0].n; }
    catch { o[t] = -1; } // 表不存在
  }
  return o;
};
const fmt = (o) => TABLES.map((t) => `${t}=${o[t]}`).join('  ');

/** 导出全部表 → JSON（含列名，恢复时按列名回灌） */
async function backup(db, tag = '') {
  const snap = { at: new Date().toISOString(), tables: {} };
  for (const t of TABLES) {
    try {
      const r = await db.query(`SELECT * FROM "${t}"`);
      snap.tables[t] = { columns: r.fields.map((f) => f.name), rows: r.rows };
    } catch { snap.tables[t] = { columns: [], rows: [] }; }
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const file = path.join(BACKUP_DIR, `accounts-backup-${tag || 'auto'}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(snap, null, 1), 'utf8');
  const total = Object.values(snap.tables).reduce((s, v) => s + v.rows.length, 0);
  console.log(`✓ 已备份 ${total} 行 → ${file}`);
  return file;
}

(async () => {
  const mode = process.argv[2] || 'verify';
  const db = await connect();
  const env = readEnvFile();
  const hKeep = phoneHash(KEEP_PHONE, env.PHONE_PEPPER || env.DATA_KEY);

  if (mode === 'backup') {
    console.log('=== 备份前 ===\n  ' + fmt(await counts(db)));
    await backup(db, 'manual');
    await db.end();
    return;
  }

  if (mode === 'restore') {
    const file = process.argv[3];
    if (!file || !fs.existsSync(file)) { console.error('用法：restore <备份文件>'); process.exit(1); }
    const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
    await db.query('BEGIN');
    try {
      // 先清空（CASCADE 处理外键顺序），再按备份回灌
      await db.query(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
      for (const t of TABLES) {
        const { columns, rows } = snap.tables[t] || { columns: [], rows: [] };
        if (!columns.length || !rows.length) continue;
        const cols = columns.map((c) => `"${c}"`).join(',');
        const ph = columns.map((_, i) => `$${i + 1}`).join(',');
        for (const row of rows) {
          await db.query(`INSERT INTO "${t}" (${cols}) VALUES (${ph})`, columns.map((c) => row[c]));
        }
        // 序列推到已用最大值之后，避免回灌后新插入撞主键
        if (columns.includes('id')) {
          await db.query(`SELECT setval(pg_get_serial_sequence('"${t}"','id'),
            GREATEST((SELECT COALESCE(MAX(id),1) FROM "${t}"), 1))`);
        }
      }
      await db.query('COMMIT');
      console.log('✓ 已恢复 →', file);
    } catch (e) {
      await db.query('ROLLBACK');
      console.error('✗ 恢复失败，已回滚：', e.message);
      process.exitCode = 1;
    }
    console.log('  恢复后：' + fmt(await counts(db)));
    await db.end();
    return;
  }

  if (mode === 'purge') {
    const before = await counts(db);
    console.log('=== 删除前 ===\n  ' + fmt(before));
    const keep = (await db.query('SELECT id, xyz_id FROM users WHERE phone_hash = $1', [hKeep])).rows;
    if (keep.length !== 1) {
      console.error(`✗ 保留目标不唯一（命中 ${keep.length} 个）—— 中止，不动任何数据。`);
      console.error(`  期望手机号 ${KEEP_PHONE}，pepper 取自 apps/server/.env`);
      await db.end(); process.exit(1);
    }
    const keepId = keep[0].id;
    console.log(`\n保留：id=${keepId}  XYZ=${keep[0].xyz_id}  手机号 ${KEEP_PHONE}`);

    const file = await backup(db, 'before-purge');

    await db.query('BEGIN');
    try {
      // 级联带走 projects → agents → conversations → messages / tasks / task_pauses …
      const del = await db.query('DELETE FROM users WHERE id <> $1', [keepId]);
      // sms_codes 没有外键，单独清（保留目标号的近期验证码，避免正在登录的人被打断）
      const delSms = await db.query('DELETE FROM sms_codes WHERE phone_hash <> $1', [hKeep]);
      await db.query('COMMIT');
      console.log(`\n✓ 删除 users ${del.rowCount} 行、sms_codes ${delSms.rowCount} 行（关联数据由外键级联带走）`);
    } catch (e) {
      await db.query('ROLLBACK');
      console.error('✗ 删除失败，已整体回滚（数据没变）：', e.message);
      await db.end(); process.exit(1);
    }

    console.log('\n=== 删除后 ===\n  ' + fmt(await counts(db)));
    console.log(`\n回滚命令：node scripts/verify/reset-accounts.cjs restore "${file}"`);
    await db.end();
    return;
  }

  // ---- verify ----
  console.log('=== 账号核对 ===');
  const rows = (await db.query('SELECT id, xyz_id, phone_hash FROM users ORDER BY id')).rows;
  console.log(`  users 共 ${rows.length} 条`);
  for (const r of rows) {
    console.log(`  id=${r.id}  ${r.xyz_id}  ${r.phone_hash === hKeep ? '← 保留目标 ✓' : '（非保留）'}`);
  }
  const ok1 = rows.length === 1 && rows[0].phone_hash === hKeep;
  console.log(`\n${ok1 ? '✓' : '✗'} 只剩 1 个账号，且就是 ${KEEP_PHONE}`);
  console.log('  全表行数：' + fmt(await counts(db)));

  // 保留账号的"家当"还在不在
  const kid = rows[0] && rows[0].id;
  if (kid) {
    const p = (await db.query('SELECT id, name, is_default FROM projects WHERE user_id = $1', [kid])).rows;
    const a = (await db.query(
      'SELECT a.id, a.name FROM agents a JOIN projects p ON p.id = a.project_id WHERE p.user_id = $1', [kid])).rows;
    console.log(`\n  该账号的项目 ${p.length} 个、智能体 ${a.length} 个`);
    for (const x of p) console.log(`   项目 ${x.id} ${x.name}${x.is_default ? '（默认）' : ''}`);
    for (const x of a) console.log(`   智能体 ${x.id} ${x.name}`);
    if (p.length !== 1 || a.length !== 1) console.log('  ⚠ 默认应当是 1 个项目 + 1 个「小助」');
  }
  await db.end();
  process.exit(ok1 ? 0 : 1);
})().catch((e) => { console.error('出错：', e.message); process.exit(2); });
