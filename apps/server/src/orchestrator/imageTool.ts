/**
 * 能力与连接 · `generate_image` 服务端工具（2026-09-27）。
 *
 * 「生成图片」接进循环引擎当一个可调用工具：
 *   · 定义（给模型看的 schema）：本文件 GENERATE_IMAGE_TOOL（side='server'）。
 *   · 执行器：按**用户本地加密配置**解析图片供应商 → 真生成 → **落项目目录** →
 *     写一条助手消息（markdown 图片）进对话流 → 广播 `image` SSE 事件（实时上屏）→ 回执。
 *
 * ★ 与 spawn_workers 一样走「服务端就地执行」分支（side='server' && kind='action'），
 *   但不 park：单张图 ~10~30s，在 /agent/loop/next 的 90s 硬超时内，直接 await 即可
 *   （超时由 provider 内部 60s 兜底，不会把循环打成 brain_failed）。
 * ★ 落项目目录：<dataRoot>/images/<projectId>/<ts>_<slug>.<ext>（见 plugins/paths.ts）。
 * ★ 图片进对话流：存一条 role=assistant 的消息（content = 一个 markdown 图片），
 *   并广播 `image` 事件让桌面即时把它拼进当前助手气泡。两路口径一致，不重复渲染。
 */
import type { LoopToolResult, ToolDefinition } from '@ai-workbench/shared';
import fs from 'node:fs';
import type { Pool } from 'pg';
import type { ServerEnv } from '../env';
import type { JsonCipher } from '../crypto';
import { ensureProjectImageDir, makeImageFilename } from '../plugins/paths';
import { resolveImageProviderForUser } from '../plugins/resolve';
import { broadcastLoopEvent } from '../loopSse';
import type { ServerExecutionContext } from '../toolRegistry';

export const GENERATE_IMAGE_TOOL_NAME = 'generate_image';

export const GENERATE_IMAGE_TOOL: ToolDefinition = {
  name: GENERATE_IMAGE_TOOL_NAME,
  description: [
    '按一段文字描述生成一张图片，存进当前项目目录，并在对话里展示给用户看。',
    '',
    '【该用它】用户明确要「画一张 / 生成一张图 / 出一张插画 / 做一张配图」时。',
    '【不要用它】用户要编辑/修图/裁剪已有图片时（本能力只生成新图）；纯文字写作不要用。',
    '',
    '【怎么用】prompt 写清楚要画什么（主体、风格、色调、构图，一句到几句自然语言即可）。',
    '一次只画一张；画完我会把图直接放进对话里，你只需再用一句话说明这张图即可。',
    '如果没配置图片密钥，我会如实告诉用户「还没开通生成图片」，不会假装画了。',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '要画什么的自然语言描述（主体 + 风格 + 构图）。' },
    },
    required: ['prompt'],
    additionalProperties: false,
  } as any,
  side: 'server',
  kind: 'action',
  timeoutMs: 90_000,
  validate: (args) => {
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim().slice(0, 800) : '';
    if (!prompt) return { ok: false, reason: 'bad_args', question: '要画什么没写清楚。给我一句图片描述。' };
    return { ok: true, args: { prompt } };
  },
};

export interface ImageToolDeps {
  pool: Pool;
  env: ServerEnv;
  cipher: JsonCipher;
}

/** conversationId → projectId；没有会话就退回 agentId → projectId；再没有 → null */
async function resolveProjectId(pool: Pool, ctx: ServerExecutionContext): Promise<number | null> {
  if (ctx.conversationId && ctx.conversationId > 0) {
    const r = await pool.query<{ project_id: string | null }>('SELECT project_id FROM conversations WHERE id = $1', [ctx.conversationId]);
    const pid = Number(r.rows[0]?.project_id);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  if (ctx.agentId && ctx.agentId > 0) {
    const r = await pool.query<{ project_id: string | null }>('SELECT project_id FROM agents WHERE id = $1', [ctx.agentId]);
    const pid = Number(r.rows[0]?.project_id);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

/** 生成一张图：解析供应商 → 真生成 → 落项目目录 → 进对话流 → 广播 → 回执 */
export async function executeGenerateImageTool(
  deps: ImageToolDeps,
  ctx: ServerExecutionContext,
  args: Record<string, unknown>,
): Promise<LoopToolResult> {
  const { pool, cipher } = deps;
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim().slice(0, 800) : '';
  if (!prompt) return { ok: false, detail: '要画什么没写清楚', error: 'bad_prompt' };

  // 1) 按用户本地加密配置解析供应商（没配 → not_configured，不发注定失败的请求）
  const provider = await resolveImageProviderForUser(pool, cipher, ctx.userId);
  if (!provider) {
    return {
      ok: false,
      detail: '还没开通「生成图片」（在「设置 → 能力与连接」里填图片供应商的 key），这张图没画',
      error: 'not_configured',
    };
  }

  // 2) 定项目（落盘 + 归属都要知道是哪个项目）
  const projectId = await resolveProjectId(pool, ctx);

  // 3) 真生成
  const r = await provider.generateImage(prompt);
  if (!r.ok || !r.bytes || r.bytes.length === 0) {
    return { ok: false, detail: r.detail || '图片没生成出来', error: r.error ?? 'image_failed' };
  }

  // 4) 落项目目录：<dataRoot>/images/<projectId|0>/<ts>_<slug>.<ext>
  const pidForDisk = projectId ?? 0;
  let filePath = '';
  let servedPath = '';
  try {
    const dir = ensureProjectImageDir(pidForDisk);
    const file = makeImageFilename(prompt, r.ext);
    filePath = `${dir}/${file}`;
    fs.writeFileSync(filePath, r.bytes);
    servedPath = `/projects/${pidForDisk}/images/${file}`;
  } catch (err) {
    // 落盘失败：图已生成但没地方存 —— 如实报错（不假装成功），不泄漏内容
    return { ok: false, detail: '图片生成了但存进项目目录失败', error: 'save_failed' };
  }

  // 5) 图片进对话流：写一条助手消息（markdown 图片）
  if (ctx.conversationId && ctx.conversationId > 0) {
    try {
      const caption = prompt.slice(0, 80);
      const md = `![${caption}](${servedPath})`;
      await pool.query(
        "INSERT INTO messages (conversation_id, role, content_enc, speaker_agent_id) VALUES ($1, 'assistant', $2, $3)",
        [ctx.conversationId, cipher.encryptText(md), ctx.agentId ?? null],
      );
    } catch (err) {
      // 消息没写进会话不影响「图已生成并落盘」这一事实 —— 打一行（不带内容）继续
      console.warn('[image] 图片消息写入会话失败（图已落盘）：', (err as Error).message);
    }
    // 广播 `image` 事件，让桌面**即时**把它拼进当前助手气泡（对话流实时可见）
    broadcastLoopEvent(ctx.loopId, 'image', { url: servedPath, caption: prompt.slice(0, 80) });
  }

  // 6) 回执：告诉模型图已生成、存到哪（detail 进模型上下文）
  return {
    ok: true,
    detail: `图片已生成并存进项目目录（${Math.round(r.bytes.length / 1024)}KB，已放进对话里）`,
    data: { url: servedPath, filePath, tookMs: r.tookMs },
  };
}
