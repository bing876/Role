/**
 * 取证：为什么界面显示「当前项目：还没读到」—— 查库看账号的项目/智能体状态。
 *
 * 要证死的链路：
 *   /projects 返回 currentProjectId = null（这个账号没有任何项目 isCurrent）
 *   → 桌面端 loadProjects 拿到 null → curProjectRef 不绑定
 *   → loadAgents(null) 也绑不到当前智能体
 *   → curAgentRef.current === null
 *   → sendChat() 在 `if (myAgent === null) return` 处**静默返回**
 *   → 用户点「发送」毫无反应，且**没有**任何 chatNote 提示（最难查的一类）
 *
 * 跑法：node scripts/verify/db-scope-check.mjs   （需要库在 5432 跑着）
 */
import pg from 'pg';

const URL = 'postgresql://workbench:workbench@127.0.0.1:5432/workbench';
const c = new pg.Client({ connectionString: URL });

try {
  await c.connect();

  const users = await c.query('SELECT id, phone, xyz_no FROM users ORDER BY id');
  console.log('=== users ===');
  for (const u of users.rows) console.log(`  #${u.id} ${u.phone} ${u.xyz_no ?? ''}`);

  const proj = await c.query(
    'SELECT id, user_id, name, is_current FROM projects ORDER BY user_id, id',
  );
  console.log(`\n=== projects（${proj.rowCount} 行）===`);
  for (const p of proj.rows) {
    console.log(`  #${p.id} user=${p.user_id} ${p.name} is_current=${p.is_current}`);
  }

  const agents = await c.query(
    'SELECT id, user_id, project_id, name FROM agents ORDER BY user_id, project_id, id',
  );
  console.log(`\n=== agents（${agents.rowCount} 行）===`);
  for (const a of agents.rows) {
    console.log(`  #${a.id} user=${a.user_id} project=${a.project_id} ${a.name}`);
  }

  console.log('\n=== 逐账号判定：会不会出现「当前项目 = null」===');
  for (const u of users.rows) {
    const mine = proj.rows.filter((p) => p.user_id === u.id);
    const cur = mine.filter((p) => p.is_current);
    const myAgents = agents.rows.filter((a) => a.user_id === u.id);
    console.log(
      `  账号 #${u.id} ${u.phone}: 项目 ${mine.length} 个、is_current ${cur.length} 个、智能体 ${myAgents.length} 个`,
    );
    if (cur.length === 0) {
      console.log('    ★ currentProjectId 会是 null → 绑不到智能体 → sendChat 静默 return');
    } else if (myAgents.length === 0) {
      console.log('    ★ 有当前项目但没有智能体 → 同样绑不到');
    } else {
      console.log('    ✓ 正常');
    }
  }
} catch (e) {
  console.log('★ 查询失败:', e.message);
  process.exitCode = 1;
} finally {
  await c.end().catch(() => {});
}
