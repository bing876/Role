/**
 * 能力与连接 · 图片落盘的**项目目录**（2026-09-27）。
 *
 * 「图片结果进对话流 + 落项目目录」的「落项目目录」一半：每张生成的图存到
 *   <dataRoot>/images/<projectId>/<时间戳>_<sanitized>.png
 * 由服务端 `GET /projects/:id/images/:file` 原样回给界面渲染。
 *
 * dataRoot 的解析口径与 `orchestrator/handoff.ts` 的 getDataRoot 完全一致
 * （env 覆盖 → 常见 cwd 布局 → __dirname 兜底），所以「交接文件」和「生成图片」
 * 落在同一棵数据树下（`apps/server/data`），运维只认一个地方。
 *
 * ★ 只依赖 node:path / node:fs，零外部依赖；文件名严格 sanitized，绝不把模型给的
 *   prompt 原样拼进路径（防路径穿越）。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 数据根（与 handoff 的 getDataRoot 同一口径）：env WORKBENCH_DATA_DIR 优先 */
export function getDataRoot(): string {
  if (process.env.WORKBENCH_DATA_DIR) return path.resolve(process.env.WORKBENCH_DATA_DIR);
  const candidates = [
    path.resolve(process.cwd(), 'apps/server/data'),
    path.resolve(process.cwd(), 'data'),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) || fs.existsSync(path.dirname(c))) return c;
    } catch {
      /* ignore */
    }
  }
  try {
    // @ts-ignore
    if (typeof __dirname !== 'undefined') return path.resolve(__dirname, '..', '..', 'data');
  } catch {
    /* ignore */
  }
  return path.resolve('apps/server/data');
}

/** 某项目的图片目录：<dataRoot>/images/<projectId> */
export function getProjectImageDir(projectId: number): string {
  return path.join(getDataRoot(), 'images', String(projectId));
}

export function ensureProjectImageDir(projectId: number): string {
  const dir = getProjectImageDir(projectId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 把任意 prompt 安全地变成文件名片段：只留「字母数字下划线」，其余一律变下划线，
 * 夹到 40 字符。绝不让 `../` / 中文 / 空格 拼进路径（路径穿越 + 跨平台乱码）。
 */
export function sanitizePromptSlug(prompt: string): string {
  const base = String(prompt ?? '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return base || 'image';
}

/** 生成一个图片文件名：<时间戳>_<slug>.<ext> */
export function makeImageFilename(prompt: string, ext: 'png' | 'jpg' | 'jpeg' = 'png'): string {
  return `${Date.now()}_${sanitizePromptSlug(prompt)}.${ext}`;
}
