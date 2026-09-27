/**
 * 能力与连接 · HTTP 面（2026-09-27）。
 *
 *   GET    /plugins                 插件注册表 + 当前登录用户的配置状态（灰/绿/测过）
 *   GET    /plugins/:id/config      读配置（secret 字段打码，**绝不**回明文 key）
 *   POST   /plugins/:id/config      存配置（整份 AES-256-GCM 加密落本地；空 key=保留旧 key）
 *   DELETE /plugins/:id/config      清空配置（=「拔插件」）
 *   POST   /plugins/:id/test        测试连通（最轻一次真调用：搜一个词 / 出一张小图）
 *   GET    /projects/:id/images/:file  取本项目的生成图片（原样回给对话流渲染）
 *
 * 口径（与全仓一致）：要 JWT；只认**当前登录用户自己**的配置（别人的一律 404/403，不泄漏存在性）；
 * 任何错误消息**绝不**带 key 明文 / 上游原文。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { bearerFrom, verifyToken } from '../crypto';
import type { ServerEnv } from '../env';
import type { JsonCipher } from '../crypto';
import { isDbUnreachable } from '../db';
import { deletePluginConfig, loadPluginConfig, savePluginConfig } from '../plugins/config';
import {
  imageProviderFromConfig,
  listPluginsWithStatus,
  maskConfigForView,
  pluginMeta,
  searchProviderFromConfig,
  WEB_SEARCH_PLUGIN,
} from '../plugins/registry';
import { getProjectImageDir } from '../plugins/paths';
import { githubConnector, feishuConnector } from '../plugins/connectors';
import { isConfigComplete } from '../plugins/config';
import { validateMcpEndpoint, McpError } from '../plugins/mcp';

export interface PluginDeps {
  pool: Pool;
  env: ServerEnv;
  cipher: JsonCipher;
}

function errJson(reply: FastifyReply, code: number, error: string, extra?: Record<string, unknown>): FastifyReply {
  return reply.code(code).send({ error, ...extra });
}

function dbErr(reply: FastifyReply, err: unknown): FastifyReply {
  if (isDbUnreachable(err)) return errJson(reply, 503, '数据库连不上，稍后再试');
  console.error('[plugins] 未分类错误：', (err as Error)?.message ?? String(err));
  return errJson(reply, 500, `服务端错误：${(err as Error)?.message ?? String(err)}`);
}

function authed(req: FastifyRequest, env: ServerEnv) {
  const token = bearerFrom(req.headers.authorization);
  return token ? verifyToken(token, env.jwtSecret) : null;
}

/** 取一个非空字符串字段（非字符串/空 → undefined） */
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

export function registerPluginRoutes(app: FastifyInstance, { pool, env, cipher }: PluginDeps): void {
  // ---------------------------------------------------------------------------
  // GET /plugins —— 注册表 + 当前用户配置状态
  // ---------------------------------------------------------------------------
  app.get('/plugins', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    try {
      const plugins = await listPluginsWithStatus(pool, cipher, claims.sub);
      return { plugins };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  // ---------------------------------------------------------------------------
  // GET /plugins/:id/config —— 读配置（打码）
  // ---------------------------------------------------------------------------
  app.get('/plugins/:id/config', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const meta = pluginMeta(String((req.params as { id?: unknown }).id ?? ''));
    if (!meta) return errJson(reply, 404, '没有这个能力');
    try {
      const cfg = await loadPluginConfig(pool, cipher, claims.sub, meta.id);
      const fields = maskConfigForView(meta, cfg);
      return { pluginId: meta.id, configured: Object.values(fields).some((f) => f.set), fields };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  // ---------------------------------------------------------------------------
  // POST /plugins/:id/config —— 存配置（加密落本地）
  //   body: { config: { apiKey?, provider?, baseUrl?, model? } }
  //   · 非 secret 字段：按入参覆盖（空串=清空）
  //   · secret 字段：入参非空=换新的；空=保留旧的（前端读回来是 ****，送不回旧 key）
  // ---------------------------------------------------------------------------
  app.post('/plugins/:id/config', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const meta = pluginMeta(String((req.params as { id?: unknown }).id ?? ''));
    if (!meta) return errJson(reply, 404, '没有这个能力');
    const body = (req.body ?? {}) as { config?: Record<string, unknown> };
    const incoming = body.config && typeof body.config === 'object' ? body.config : {};

    try {
      const existing = (await loadPluginConfig(pool, cipher, claims.sub, meta.id)) ?? {};
      const merged: Record<string, string> = {};
      for (const f of meta.configFields) {
        const rawIn = incoming[f.key];
        if (f.type === 'secret') {
          const newSecret = typeof rawIn === 'string' && rawIn.trim() !== '' ? rawIn.trim() : undefined;
          // 新 key 非空 → 换；否则保留旧（读回来是 ****，送不回旧值，所以空=不改）
          merged[f.key] = newSecret ?? (typeof existing[f.key] === 'string' ? existing[f.key] : '');
        } else {
          merged[f.key] = typeof rawIn === 'string' ? rawIn : (typeof existing[f.key] === 'string' ? existing[f.key] : '');
        }
      }
      // 供应商默认值：没显式选时给个可用默认
      if (meta.id === 'web_search' && !merged.provider) merged.provider = 'tavily';
      if (meta.id === 'image_gen' && !merged.provider) merged.provider = 'dashscope';
      if ((meta.id === 'github' || meta.id === 'feishu') && merged.baseUrl?.trim()) {
        try { validateMcpEndpoint(merged.baseUrl); }
        catch (e) { return errJson(reply, 400, (e as McpError).message); }
      }

      await savePluginConfig(pool, cipher, claims.sub, meta.id, merged);
      const fields = maskConfigForView(meta, merged);
      const complete = meta.requiredFields.every((f) => (merged[f] ?? '').trim() !== '');
      return { ok: true, pluginId: meta.id, configured: complete, fields };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  // ---------------------------------------------------------------------------
  // DELETE /plugins/:id/config —— 清空配置（=「拔插件」）
  // ---------------------------------------------------------------------------
  app.delete('/plugins/:id/config', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const meta = pluginMeta(String((req.params as { id?: unknown }).id ?? ''));
    if (!meta) return errJson(reply, 404, '没有这个能力');
    try {
      await deletePluginConfig(pool, claims.sub, meta.id);
      return { ok: true, pluginId: meta.id, configured: false };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  // ---------------------------------------------------------------------------
  // POST /plugins/:id/test —— 测试连通（最轻一次真调用）
  // ---------------------------------------------------------------------------
  app.post('/plugins/:id/test', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const meta = pluginMeta(String((req.params as { id?: unknown }).id ?? ''));
    if (!meta) return errJson(reply, 404, '没有这个能力');
    try {
      const cfg = await loadPluginConfig(pool, cipher, claims.sub, meta.id);
      let provider: { test(): Promise<{ ok: boolean; detail: string; error?: string }> } | null = null;
      if (meta.id === 'web_search') provider = searchProviderFromConfig(cfg);
      else if (meta.id === 'image_gen') provider = imageProviderFromConfig(cfg);
      else if (meta.id === 'github' && isConfigComplete(cfg, ['apiToken'])) provider = githubConnector(cfg!);
      else if (meta.id === 'feishu' && isConfigComplete(cfg, ['appId', 'appSecret'])) provider = feishuConnector(cfg!);
      if (!provider) {
        return errJson(reply, 400, '还没配好密钥，测试不了。先填 key 再测。', { code: 'not_configured' });
      }
      const r = await provider.test();
      return { ok: r.ok, detail: r.detail, error: r.error };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  // ---------------------------------------------------------------------------
  // GET /projects/:id/images/:file —— 取本项目生成图片（对话流渲染用）
  //   · 只认当前登录用户**自己**的项目下的图片；文件名严格 sanitized（只读已存在的文件）。
  //   · 防路径穿越：:file 只允许「文件名」（不含 / 与 ..），且必须真实存在于该项目图片目录。
  // ---------------------------------------------------------------------------
  app.get('/projects/:id/images/:file', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const pidRaw = Number((req.params as { id?: unknown }).id);
    if (!Number.isInteger(pidRaw) || pidRaw <= 0) return errJson(reply, 400, '项目号不正确');
    const file = String((req.params as { file?: unknown }).file ?? '');
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(file) || file.includes('..')) return errJson(reply, 400, '文件名不合法');
    try {
      // 归属校验：项目必须是当前用户自己的（别人的当不存在，不泄漏）
      const own = await pool.query<{ id: string }>(
        'SELECT id FROM projects WHERE id = $1 AND user_id = $2',
        [pidRaw, claims.sub],
      );
      if (own.rowCount !== 1) return errJson(reply, 404, '图片不存在或不是你的');
      const dir = getProjectImageDir(pidRaw);
      const full = path.join(dir, file);
      // 双保险：realpath 必须仍在该项目图片目录内（挡软链接/越界）
      if (!fs.existsSync(full)) return errJson(reply, 404, '图片不存在或不是你的');
      const realDir = fs.realpathSync(dir);
      const realFull = fs.realpathSync(full);
      if (!realFull.startsWith(realDir + path.sep)) return errJson(reply, 404, '图片不存在或不是你的');
      const buf = fs.readFileSync(full);
      const ctype = file.toLowerCase().endsWith('.png') ? 'image/png' : file.toLowerCase().endsWith('.jpg') || file.toLowerCase().endsWith('.jpeg') ? 'image/jpeg' : 'application/octet-stream';
      return reply.type(ctype).send(buf);
    } catch (err) {
      return dbErr(reply, err);
    }
  });
}

export const IMAGE_GEN_PLUGIN_META = WEB_SEARCH_PLUGIN; // re-export 便于测试引用
