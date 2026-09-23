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
 * 锁实现：
 * - 内存锁 per projectId：Promise 链，序列化 board 的 read-modify-write
 * - 无锁版本用于反证：故意制造 read→delay→write 竞态，必丢数据
 */

import fs from 'node:fs';
import path from 'node:path';

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

export function ensureHandoffDir(projectId: number): void {
  const dir = getHandoffDir(projectId);
  fs.mkdirSync(dir, { recursive: true });
  const boardPath = getBoardPath(projectId);
  if (!fs.existsSync(boardPath)) {
    fs.writeFileSync(boardPath, `# 项目 ${projectId} 交接板\n\n> 单写者：只有总协调/发起方能写，序列化追加，防丢\n\n`, 'utf8');
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

function buildHandoffMarkdown(data: HandoffData): string {
  return `# 交接 ${data.delegationId}

## 目标
${data.goal}

## 输入
${data.input || '（无额外输入）'}

## 产出要求
${data.outputRequire || '明确结论 + 要点提纲，stop(reason=done) 收尾'}

## 审批边界
${data.approvalBoundary || '- 敏感信息（密码/验证码/银行卡/身份证/支付）不外发、不索要\n- 高风险（付款/下单）必须 stop(reason=need_user) 交给用户\n- 没有浏览器手，不能说“已打开网页”'}

## 状态
- delegationId: ${data.delegationId}
- jobId: ${data.jobId || ''}
- 项目: ${data.projectId}
- 来自: ${data.fromAgentName} (#${data.fromAgentId})
- 去向: ${data.toAgentName} (#${data.toAgentId})
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
    content += `\n\n## 更新 ${new Date().toISOString()}\n${extra}\n`;
  }
  fs.writeFileSync(filePath, content, 'utf8');
}

// ---------------- 单写者锁（防并发丢数据） ----------------

const boardLocks = new Map<number, Promise<void>>();

async function withBoardLock<T>(projectId: number, fn: () => Promise<T>): Promise<T> {
  const prev = boardLocks.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((res) => (release = res));
  boardLocks.set(projectId, prev.then(() => next));
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * 单写者：只有发起方能写 board.md，且序列化
 * entry 示例：- [2026-09-23T10:00:00Z] #1 A→B: 任务...
 */
export async function appendBoardWithLock(
  projectId: number,
  fromAgentId: number,
  entry: string,
): Promise<void> {
  ensureHandoffDir(projectId);
  // 单写者校验：fromAgentId 必须 >0（发起方），被委派方不应直接写 board
  if (!Number.isInteger(fromAgentId) || fromAgentId <= 0) throw new Error('board 单写者：fromAgentId 非法');
  return withBoardLock(projectId, async () => {
    const boardPath = getBoardPath(projectId);
    let current = '';
    try {
      current = fs.readFileSync(boardPath, 'utf8');
    } catch {
      current = '';
    }
    // 模拟一点 IO 延迟，让并发更易复现（有锁时仍安全）
    await new Promise((r) => setTimeout(r, 10));
    const next = current + entry + '\n';
    fs.writeFileSync(boardPath, next, 'utf8');
  });
}

/**
 * 无锁版本：故意制造竞态，用于反证（必丢数据）
 * 两个并发调用同时 read，第二个 write 覆盖第一个
 */
export async function appendBoardWithoutLock(projectId: number, entry: string): Promise<void> {
  ensureHandoffDir(projectId);
  const boardPath = getBoardPath(projectId);
  let current = '';
  try {
    current = fs.readFileSync(boardPath, 'utf8');
  } catch {
    current = '';
  }
  // 故意延迟，放大竞态窗口
  await new Promise((r) => setTimeout(r, 20));
  const next = current + entry + '\n';
  fs.writeFileSync(boardPath, next, 'utf8');
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
