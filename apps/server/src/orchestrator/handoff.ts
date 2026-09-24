/**
 * 批次 A | 交接结构化（最高优先）
 * 依据 Grok Bot 实战结论 "Handoff quality is a file format problem, not a prompting problem"
 *
 * 1. 项目工作区建 handoffs/ 目录 + board.md（单写者：只有总协调/发起方能写）
 * 2. 每个委派任务一个文件 handoffs/<jobId>.md，含 目标/输入/产出要求/审批边界
 * 3. 委派消息只传路径不传内容
 * 4. 验收必须包含：两个 agent 并发写 board 不静默丢数据（反证：去掉单写者锁→必须能复现丢失）
 *
 * 设计：
 * - 存储：data/handoffs/<projectId>/ 目录，board.md + <delegationId>.md
 * - board.md 单写者：只有发起方（fromAgent）能写，且通过锁序列化，避免并发丢数据
 * - handoff 文件结构化：目标/输入/产出要求/审批边界/状态/来源
 * - 委派消息只传路径：handoff://<projectId>/<delegationId>.md
 *
 * 锁（收尾 2 重做，取代修 5 的「进程内 Promise 链 + 只有发起方写的约定」）：
 * - 旧实现是 `Map<projectId, Promise>` 进程内锁：批次 D 引入重启恢复后，新旧进程可能同时在写
 *   （tsx watch 重启、部署交接、恢复出来的循环与新请求并发），进程内锁互相看不见 → 丢数据。
 *   「只有发起方写」只是约定：同一项目里两个智能体各自发起委派，就是两个发起方并发写。
 * - 现在：**落库锁** `board_locks`（每项目一行）。写 board.md 时开事务 `SELECT … FOR UPDATE`
 *   拿行锁，持锁完成「读文件 → 追加 → 写临时文件 → rename 原子替换」，再 `version+1` 提交。
 *     · 跨进程、跨重启有效：锁在 PostgreSQL 里，不在任何一个进程的内存里；
 *     · 持锁进程被 kill -9：连接断开 → PG 回滚事务、释放行锁，后来者不会死等；
 *     · rename 原子替换：读者永远看到完整的旧文件或完整的新文件，不会读到写了一半的文件；
 *     · 锁等待有上限（lock_timeout），超时抛错，由调用方决定重试/放弃，不会把请求挂死。
 * - 反证见 scripts/verify/board-lock-db.mjs：两个**独立进程**、中途 kill -9 其中一个再重启，
 *   并发写同一项目 board.md —— 落库锁 0 丢失；换成旧的进程内锁则必丢。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';
import { redactForStorage } from './redact';

/**
 * 收尾 8（2026-09-25 用户拍板）| **交接文件与 board 落盘前一律过脱敏**。
 *
 * 为什么这一批要补在**这里**：`handoffs/<delegationId>.md` 与 `board.md` 是**明文文件**
 * （不像 `tasks.goal_enc` / `messages.content_enc` 那样有密文列），而它们的内容**全部来自
 * 模型与用户**：委派目标、上下文、产出要求、子循环的进度与结论、board 那一行摘要。
 * 频道正文（`channels.ts`）、摘要与要点（`workers.ts`）早就有这道闸，交接文件当初漏了 ——
 * 于是同一句话进频道被抹掉、写进 handoff 却是原文。
 *
 * 口径与 R2 / 收尾 6 完全一致，别在这里另立标准：
 *   · `redactForStorage` 抹的是**值形态**（银行卡 12~19 位 / 身份证 18 位 / 密码 / 验证码 /
 *     CVV / ≥21 位连续纯数字串），只留「有几个字符」，**不是**"按敏感词涂全文"；
 *   · 它是**兜底**，不是"清洗后照发"：要不要**拒绝**这次委派由调用方判定（`detectSensitive`），
 *     这里保证的是"判定漏了一个形态时，至少磁盘上不是原文"。
 *
 * 反证见 `scripts/verify/handoff-redact-revert-proof.py`（把这里的三处脱敏拆掉 → 验收当场红）。
 */
const safe = (t: unknown): string => redactForStorage(String(t ?? ''));

// data/handoffs/<projectId>/ - 兼容多种 cwd
function getDataRoot(): string {
  // 优先用环境变量，其次按常见布局猜
  if (process.env.HANDOFF_ROOT) return path.resolve(process.env.HANDOFF_ROOT);
  // 从当前工作区根开始：apps/server/data/handoffs
  const candidates = [
    path.resolve(process.cwd(), 'apps/server/data/handoffs'),
    path.resolve(process.cwd(), 'data/handoffs'),
    path.resolve(__dirname ?? process.cwd(), '..', '..', 'data', 'handoffs'),
  ];
  for (const c of candidates) {
    try {
      // 若目录已存在或其父目录存在，选用它
      const parent = path.dirname(c);
      if (fs.existsSync(parent) || fs.existsSync(c)) return c;
    } catch {}
  }
  // 兜底：相对当前文件（CommonJS 下 __dirname 可用）
  try {
    // @ts-ignore
    if (typeof __dirname !== 'undefined') return path.resolve(__dirname, '..', '..', 'data', 'handoffs');
  } catch {}
  return path.resolve('apps/server/data/handoffs');
}

export function getHandoffDir(projectId: number): string {
  return path.join(getDataRoot(), String(projectId));
}

export function getBoardPath(projectId: number): string {
  return path.join(getHandoffDir(projectId), 'board.md');
}

export function getHandoffPath(projectId: number, delegationId: number | string): string {
  return path.join(getHandoffDir(projectId), `${delegationId}.md`);
}

export function getHandoffUri(projectId: number, delegationId: number | string): string {
  return `handoff://${projectId}/${delegationId}.md`;
}

function boardHeader(projectId: number): string {
  return `# 项目 ${projectId} 交接板\n\n> 追加由 board_locks 落库锁串行化（跨进程 / 跨重启），文件整体原子替换\n\n`;
}

export function ensureHandoffDir(projectId: number): void {
  const dir = getHandoffDir(projectId);
  fs.mkdirSync(dir, { recursive: true });
  // ★ 'wx' = 排他创建（文件已存在就失败）。原来是 existsSync 再 writeFileSync：
  //   两个进程同时首次创建时，后到的会把先到者**已经追加进去的条目**整个覆盖掉。
  try {
    fs.writeFileSync(getBoardPath(projectId), boardHeader(projectId), { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
}

export interface HandoffData {
  delegationId: number;
  jobId?: string;
  projectId: number;
  fromAgentId: number;
  fromAgentName: string;
  toAgentId: number;
  toAgentName: string;
  goal: string;
  input?: string;
  outputRequire?: string;
  approvalBoundary?: string;
  status: 'running' | 'done' | 'failed' | 'timeout' | 'need_user';
  createdAt: string;
  deadlineAt?: string;
}

/**
 * 交接文件的正文。★ 收尾 8：**所有自由文本字段都过 `safe()`**（见文件里那段说明）。
 * 结构化字段（delegationId / jobId / 项目 id / 状态 / 时间）原样保留 —— 它们不是内容，
 * 抹了只会让文件不可读，而且它们本来就是数字/枚举。
 */
function buildHandoffMarkdown(data: HandoffData): string {
  return `# 交接 ${data.delegationId}

## 目标
${safe(data.goal)}

## 输入
${data.input ? safe(data.input) : '（无额外输入）'}

## 产出要求
${data.outputRequire ? safe(data.outputRequire) : '明确结论 + 要点提纲，stop(reason=done) 收尾'}

## 审批边界
${data.approvalBoundary ? safe(data.approvalBoundary) : '- 敏感信息（密码/验证码/银行卡/身份证/支付）不外发、不索要\n- 高风险（付款/下单）必须 stop(reason=need_user) 交给用户\n- 没有浏览器手，不能说“已打开网页”'}

## 状态
- delegationId: ${data.delegationId}
- jobId: ${data.jobId || ''}
- 项目: ${data.projectId}
- 来自: ${safe(data.fromAgentName)} (#${data.fromAgentId})
- 去向: ${safe(data.toAgentName)} (#${data.toAgentId})
- 状态: ${data.status}
- 创建: ${data.createdAt}
- 截止: ${data.deadlineAt || ''}

## 路径
${getHandoffUri(data.projectId, data.delegationId)}

> 委派消息只传路径不传内容，执行方读取此文件获取完整上下文
`;
}

export function writeHandoffFile(projectId: number, delegationId: number, data: HandoffData): string {
  ensureHandoffDir(projectId);
  const filePath = getHandoffPath(projectId, delegationId);
  const md = buildHandoffMarkdown(data);
  fs.writeFileSync(filePath, md, 'utf8');
  return filePath;
}

export function readHandoffFile(projectId: number, delegationId: number): string | null {
  const filePath = getHandoffPath(projectId, delegationId);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
}

export function updateHandoffStatus(projectId: number, delegationId: number, status: HandoffData['status'], extra?: string): void {
  const filePath = getHandoffPath(projectId, delegationId);
  if (!fs.existsSync(filePath)) return;
  let content = fs.readFileSync(filePath, 'utf8');
  content = content.replace(/- 状态: .*/, `- 状态: ${status}`);
  if (extra) {
    /**
     * ★ 收尾 8：`extra` 是**子循环原样报上来的**进度 / 结论（最可能夹带敏感值的一处），
     *   落盘前过 `safe()`。时间戳是结构化字段，原样留着（抹了反而看不出什么时候更新的）。
     */
    content += `\n\n## 更新 ${new Date().toISOString()}\n${safe(extra)}\n`;
  }
  fs.writeFileSync(filePath, content, 'utf8');
}

// ---------------- board.md 落库锁（收尾 2：跨进程 / 跨重启） ----------------

/** 等锁上限：超过就抛错，交给调用方决定重试还是放弃（不把请求挂死） */
const BOARD_LOCK_TIMEOUT_MS = 10_000;

/**
 * 原子替换：先写同目录临时文件，再 rename 覆盖（POSIX 下 rename 是原子的）。
 * 读者永远只会看到「完整的旧文件」或「完整的新文件」。
 */
function writeFileAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * 在 PostgreSQL 行锁内执行 fn。锁 = board_locks 里该项目的那一行。
 *
 * ★ 不用 withTx：需要在 BEGIN 之后设 lock_timeout（SET LOCAL 只在本事务内生效）。
 * ★ 不用 pg_advisory_xact_lock：行锁 + version 列能留下「谁、第几次写」的痕迹，方便诊断；
 *   两者跨进程语义相同（都随事务 / 连接释放）。
 */
export async function withBoardDbLock<T>(pool: Pool, projectId: number, writer: string, fn: () => Promise<T> | T): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '${BOARD_LOCK_TIMEOUT_MS}ms'`);
    // 行不存在先建（并发建由 ON CONFLICT 兜住），再 FOR UPDATE 锁住它
    await client.query(
      'INSERT INTO board_locks (project_id) VALUES ($1) ON CONFLICT (project_id) DO NOTHING',
      [projectId],
    );
    await client.query('SELECT version FROM board_locks WHERE project_id = $1 FOR UPDATE', [projectId]);
    const result = await fn();
    await client.query(
      'UPDATE board_locks SET version = version + 1, last_writer = $2, updated_at = now() WHERE project_id = $1',
      [projectId, writer.slice(0, 120)],
    );
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 追加一行到 board.md（**落库锁**保护的 read-modify-write）。
 * entry 示例：- [2026-09-23T10:00:00Z] #1 A→B: 任务...
 *
 * fromAgentId 仍然校验（board 只记「谁派给谁」，发起方身份必须合法），
 * 但并发安全**不再依赖**「只有发起方写」这条约定 —— 锁本身就保证不丢。
 */
export async function appendBoardWithLock(
  pool: Pool,
  projectId: number,
  fromAgentId: number,
  entry: string,
): Promise<void> {
  if (!Number.isInteger(fromAgentId) || fromAgentId <= 0) throw new Error('board：fromAgentId 非法');
  /**
   * ★ 收尾 8：board 那一行也过 `safe()`（它带的是 `task.slice(0, 80)` —— 用户原话的摘要）。
   *   放在**临界区之外**：脱敏是纯函数，没必要占着落库锁。
   */
  const safeEntry = safe(entry);
  ensureHandoffDir(projectId);
  // ★ 临界区故意写成**纯同步**（读 → 拼 → 原子替换之间没有 await）：
  //   同一进程内的并发追加因此天然不会交错；跨进程的互斥则完全由 PG 行锁负责。
  await withBoardDbLock(pool, projectId, `agent#${fromAgentId}@pid${process.pid}`, () => {
    const boardPath = getBoardPath(projectId);
    let current = '';
    try {
      current = fs.readFileSync(boardPath, 'utf8');
    } catch {
      current = '';
    }
    writeFileAtomic(boardPath, (current || boardHeader(projectId)) + safeEntry + '\n');
  });
}

/** 读 board 的写计数（验收 / 诊断用：并发写 N 次后 version 应恰好 +N） */
export async function boardVersion(pool: Pool, projectId: number): Promise<number> {
  const r = await pool.query<{ version: string }>('SELECT version FROM board_locks WHERE project_id = $1', [projectId]);
  return r.rows[0] ? Number(r.rows[0].version) : 0;
}

export function readBoard(projectId: number): string {
  const boardPath = getBoardPath(projectId);
  if (!fs.existsSync(boardPath)) return '';
  return fs.readFileSync(boardPath, 'utf8');
}

export function clearBoardForTest(projectId: number): void {
  const boardPath = getBoardPath(projectId);
  if (fs.existsSync(boardPath)) fs.unlinkSync(boardPath);
  ensureHandoffDir(projectId);
}
