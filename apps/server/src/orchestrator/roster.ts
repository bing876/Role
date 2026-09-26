/**
 * 多智能体编排 · **同事名单**（谁在这个项目里、各自管什么、此刻忙不忙）。
 *
 * ★ 为什么名单不能写进工具的 description：
 *   description 是**静态**的（注册时定死、发模型前只做深拷贝），而名单是**按项目按当下**变的
 *   —— 谁在忙、谁正在等结果，每一次委派都不一样。所以它走「第一条 user 消息的追加段」
 *   （`StartLoopInput.orchestrationBlock`），由 `orchestrationBlock()` 拼好。
 *
 * ★ 忙/等这两个标记来自 `registry` 的内存名额表，不是 DB：
 *   它们描述的是「此刻」，跨重启本来就不该保留（重启后没有在跑的委派，谁都不忙）。
 */
import type { Pool } from 'pg';
import type { ServerEnv } from '../env';
import { agentBusyCount, isAgentWaiting } from './registry';
import { chiefOfStaffBlock, orchestrationBlock, type RosterEntry } from './prompts';

interface RosterRow {
  id: string;
  name: string;
  kind: string;
  persona: { name?: string; duty?: string; description?: string; antiJobs?: string } | null;
}

/**
 * 取同项目的智能体名单。
 *
 * @param excludeAgentId  要从结果里剔掉的那个（一般就是发起方自己 —— 不该委派给自己；
 *                        闸里也有一道 `delegate_self`，这里剔掉是为了**别让模型看见这个选项**）
 */
export async function loadProjectRoster(
  pool: Pool,
  userId: number,
  projectId: number,
  excludeAgentId: number | null = null,
): Promise<RosterEntry[]> {
  const r = await pool.query<RosterRow>(
    `SELECT a.id, a.name, a.kind, a.persona
       FROM agents a JOIN projects p ON p.id = a.project_id
      WHERE p.user_id = $1 AND a.project_id = $2
      ORDER BY CASE WHEN a.kind = 'assistant' THEN 0 WHEN a.kind = 'hen' THEN 1 ELSE 2 END, a.id ASC
      LIMIT 20`,
    [userId, projectId],
  );
  const out: RosterEntry[] = [];
  for (const row of r.rows) {
    const id = Number(row.id);
    if (excludeAgentId !== null && id === excludeAgentId) continue;
    const personaName = typeof row.persona?.name === 'string' ? row.persona.name.trim() : '';
    const duty = typeof row.persona?.duty === 'string' ? row.persona.duty.trim().slice(0, 80) : '';
    // G3：语义路由燃料 —— 整份人设(描述) + 不干什么。切片控制提示词长度。
    const description = typeof row.persona?.description === 'string' ? row.persona.description.trim().slice(0, 200) : '';
    const antiJobs = typeof row.persona?.antiJobs === 'string' ? row.persona.antiJobs.trim().slice(0, 120) : '';
    out.push({
      id,
      name: personaName || String(row.name ?? `#${id}`),
      duty,
      ...(description ? { description } : {}),
      ...(antiJobs ? { antiJobs } : {}),
      busy: agentBusyCount(id) > 0,
      waiting: isAgentWaiting(id),
    });
  }
  return out;
}

/** 按名字/ID 在同项目里解析委派目标（大小写与首尾空格不敏感；重名取 id 最小的那个） */
export async function resolveDelegateTarget(
  pool: Pool,
  userId: number,
  projectId: number,
  to: string | number,
): Promise<{ id: number; name: string; projectId: number } | null> {
  if (typeof to === 'number' || /^\d+$/.test(String(to).trim())) {
    const id = Number(to);
    const r = await pool.query<{ id: string; name: string; project_id: string; persona: { name?: string } | null }>(
      `SELECT a.id, a.name, a.project_id, a.persona
         FROM agents a JOIN projects p ON p.id = a.project_id
        WHERE p.user_id = $1 AND a.id = $2 LIMIT 1`,
      [userId, id],
    );
    const row = r.rows[0];
    if (!row) return null;
    const personaName = typeof row.persona?.name === 'string' ? row.persona.name.trim() : '';
    return { id: Number(row.id), name: personaName || String(row.name ?? `#${id}`), projectId: Number(row.project_id) };
  }
  const needle = String(to ?? '').trim().toLowerCase();
  if (!needle) return null;
  const r = await pool.query<{ id: string; name: string; project_id: string; persona: { name?: string } | null }>(
    `SELECT a.id, a.name, a.project_id, a.persona
       FROM agents a JOIN projects p ON p.id = a.project_id
      WHERE p.user_id = $1 AND a.project_id = $2
      ORDER BY a.id ASC LIMIT 50`,
    [userId, projectId],
  );
  for (const row of r.rows) {
    const personaName = typeof row.persona?.name === 'string' ? row.persona.name.trim() : '';
    const display = personaName || String(row.name ?? '');
    if (display.trim().toLowerCase() === needle) {
      return { id: Number(row.id), name: display, projectId: Number(row.project_id) };
    }
  }
  return null;
}

/**
 * 在**这个账号的全部项目**里按名字找智能体（不带项目过滤）。
 *
 * ★ 只用于「拒绝话术」：区分「查无此人」与「有这个人但在别的项目」。
 *   两者都拒，但话术不一样 —— 前者要说「名字对不上」，后者要说「只能同项目」，
 *   模型才知道下一步该改名字还是该换人。
 *
 * ⚠️ **不许**用它来做委派目标的解析（那会绕过同项目闸）。解析一律走
 *   `resolveDelegateTarget(pool, userId, projectId, to)`。
 */
export async function findAgentByNameAnyProject(
  pool: Pool,
  userId: number,
  name: string,
): Promise<{ id: number; name: string; projectId: number } | null> {
  const needle = String(name ?? '').trim().toLowerCase();
  if (!needle || /^\d+$/.test(needle)) return null;
  const r = await pool.query<{ id: string; name: string; project_id: string; persona: { name?: string } | null }>(
    `SELECT a.id, a.name, a.project_id, a.persona
       FROM agents a JOIN projects p ON p.id = a.project_id
      WHERE p.user_id = $1
      ORDER BY a.id ASC LIMIT 200`,
    [userId],
  );
  for (const row of r.rows) {
    const personaName = typeof row.persona?.name === 'string' ? row.persona.name.trim() : '';
    const display = personaName || String(row.name ?? '');
    if (display.trim().toLowerCase() === needle) {
      return { id: Number(row.id), name: display, projectId: Number(row.project_id) };
    }
  }
  return null;
}

/**
 * 给某一路循环拼「同事名单 + 编排规矩」追加段（`/agent/loop/start` 与聊天两处共用）。
 *
 * ★ 一律返回 `string | undefined`，**出错也返回 undefined**：
 *   这段东西只是「让模型知道还能委派谁」。查不到项目 / 没开编排 / 名单为空 / DB 抖动，
 *   都应该让循环**照原来的样子跑**，绝不能因为拼名单失败就把用户的任务挡在门外。
 *   （所以这里 `.catch(() => undefined)` 是刻意的，不是偷懒。）
 *
 * 返回 `undefined` 时 `startLoop` 走「不加这一段」的老路 —— 与改动前逐字节一致。
 */
export async function orchestrationBlockFor(
  pool: Pool,
  env: ServerEnv,
  userId: number,
  agentId: number | null,
): Promise<string | undefined> {
  if (!env.orch?.enabled) return undefined;
  if (!Number.isInteger(agentId) || (agentId as number) <= 0) return undefined;
  try {
    const projectId = await projectOfAgent(pool, userId, agentId as number);
    if (projectId === null) return undefined;
    const roster = await loadProjectRoster(pool, userId, projectId, agentId);
    // 即使只有自己，也要给管家路由块
    const selfName = await getAgentName(pool, agentId as number);
    const base = roster.length === 0 ? '' : orchestrationBlock(agentId as number, roster);
    const chief = chiefOfStaffBlock(selfName ?? '', agentId as number, roster);
    const combined = [base, chief].filter(Boolean).join('\n');
    return combined || undefined;
  } catch (err) {
    console.warn('[orc] 拼同事名单失败（这一路按「没有编排」继续跑）：', (err as Error)?.message ?? String(err));
    return undefined;
  }
}

async function getAgentName(pool: Pool, agentId: number): Promise<string | null> {
  try {
    const r = await pool.query<{ name: string; persona: { name?: string } | null }>('SELECT name, persona FROM agents WHERE id=$1 LIMIT 1', [agentId]);
    const row = r.rows[0];
    if (!row) return null;
    const pName = typeof row.persona?.name === 'string' ? row.persona.name.trim() : '';
    return pName || row.name || null;
  } catch {
    return null;
  }
}

/** 发起方所在的项目 id（委派必须同项目；查不到就是 null，闸会拒） */
export async function projectOfAgent(pool: Pool, userId: number, agentId: number): Promise<number | null> {
  const r = await pool.query<{ project_id: string }>(
    `SELECT a.project_id FROM agents a JOIN projects p ON p.id = a.project_id
      WHERE p.user_id = $1 AND a.id = $2 LIMIT 1`,
    [userId, agentId],
  );
  return r.rows[0] ? Number(r.rows[0].project_id) : null;
}
