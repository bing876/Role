/**
 * 能力与连接 · **插件注册表**（2026-09-27）。
 *
 * 一个「插件」= 一个可开关的外部能力。当前两个**原生**插件：
 *   · web_search  网页搜索（供应商 Tavily，复用既有 search/tavily.ts）
 *   · image_gen   生成图片（供应商 通义万相/DALL-E，见 providers.ts）
 *
 * 每个插件的口径（前后端共用 @ai-workbench/shared 的 PluginInfo 类型）：
 *   id / name / description(给 AI 判断何时用) / tools(接进循环引擎) / configFields(填 key)。
 *
 * 这里**只**存元数据 + 提供「从本地密文配置里挑出可用供应商」的纯函数。
 * 真正的执行（search/generateImage）在 providers.ts；接进循环的工具在 orchestrator/。
 */
import type { Pool } from 'pg';
import type { JsonCipher } from '../crypto';
import type { PluginConfigField, PluginId, PluginInfo, PluginStatus } from '@ai-workbench/shared';
import { isConfigComplete, loadPluginConfig, type PluginConfig, type WebSearchPluginConfig } from './config';
import { imageProviderFor, searchProviderFor, type ImageConfig, type ImageProvider, type SearchProvider } from './providers';

export interface NativePluginMeta {
  id: PluginId;
  name: string;
  description: string;
  tools: string[];
  configFields: PluginConfigField[];
  /** 必填字段（决定「配齐可用」/ 卡片绿灰） */
  requiredFields: string[];
}

export const WEB_SEARCH_PLUGIN: NativePluginMeta = {
  id: 'web_search',
  name: '网页搜索',
  description:
    '联网检索公开资料，返回若干条结果（标题/网址/摘要）。用于需要「此时此刻的外部信息」才能答对的问题：' +
    '最新新闻/时事、天气、赛事比分、股价汇率、某人某公司的最新动态、可能过期的事实。' +
    '闲聊/常识/写代码/解释通用概念不要用它。',
  tools: ['web_search'],
  configFields: [
    { key: 'provider', type: 'select', label: '供应商', options: ['tavily'], help: '当前支持 Tavily' },
    { key: 'apiKey', type: 'secret', required: true, label: 'Tavily API Key', placeholder: 'tvly-…', help: '在 tavily.com 申请' },
    { key: 'baseUrl', type: 'text', label: '接口地址（可选）', placeholder: 'https://api.tavily.com' },
  ],
  requiredFields: ['apiKey'],
};

export const IMAGE_GEN_PLUGIN: NativePluginMeta = {
  id: 'image_gen',
  name: '生成图片',
  description:
    '按一段文字描述生成一张图片，结果会存进当前项目目录并在对话里展示。' +
    '用于用户要「画一张图 / 生成一张插画 / 出一张图」时；不是用来编辑/处理已有图片。',
  tools: ['generate_image'],
  configFields: [
    {
      key: 'provider',
      type: 'select',
      label: '供应商',
      options: ['dashscope', 'openai'],
      help: 'dashscope=通义万相（默认，国内、有免费额度）；openai=DALL-E',
    },
    { key: 'apiKey', type: 'secret', required: true, label: 'API Key', placeholder: 'dashscope：sk-… / openai：sk-…' },
    { key: 'model', type: 'text', label: '模型（可选）', placeholder: 'dashscope 默认 wanx-v1 / openai 默认 dall-e-3' },
    { key: 'baseUrl', type: 'text', label: '接口地址（可选）' },
  ],
  requiredFields: ['apiKey'],
};

/** 全量原生插件（顺序 = 设置抽屉里的展示顺序） */
export const NATIVE_PLUGINS: NativePluginMeta[] = [WEB_SEARCH_PLUGIN, IMAGE_GEN_PLUGIN];

export function pluginMeta(id: string): NativePluginMeta | undefined {
  return NATIVE_PLUGINS.find((p) => p.id === id);
}

// ---------------------------------------------------------------------------
// 从「本地密文配置」里挑出可用供应商
// ---------------------------------------------------------------------------

/** 从加载出的（已解密）配置构造搜索供应商；没配 → null */
export function searchProviderFromConfig(config: PluginConfig | null): SearchProvider | null {
  if (!isConfigComplete(config, WEB_SEARCH_PLUGIN.requiredFields)) return null;
  const c: WebSearchPluginConfig = {
    provider: 'tavily',
    apiKey: String(config!.apiKey ?? '').trim(),
    baseUrl: config!.baseUrl?.trim() ? String(config!.baseUrl) : undefined,
  };
  return searchProviderFor(c);
}

/** 从加载出的（已解密）配置构造图片供应商；没配 → null */
export function imageProviderFromConfig(config: PluginConfig | null): ImageProvider | null {
  if (!isConfigComplete(config, IMAGE_GEN_PLUGIN.requiredFields)) return null;
  const c: ImageConfig = {
    provider: config!.provider === 'openai' ? 'openai' : 'dashscope',
    apiKey: String(config!.apiKey ?? '').trim(),
    baseUrl: config!.baseUrl?.trim() ? String(config!.baseUrl) : undefined,
    model: config!.model?.trim() ? String(config!.model) : undefined,
  };
  return imageProviderFor(c);
}

/**
 * GET /plugins 的列表：每个插件带**当前登录用户**的配置状态（灰/绿/测过）。
 * 只回打码信息，**绝不**回明文 key（密钥只在内存里用，用完即弃）。
 */
export async function listPluginsWithStatus(
  pool: Pool,
  cipher: JsonCipher | null | undefined,
  userId: number,
): Promise<PluginInfo[]> {
  const out: PluginInfo[] = [];
  for (const meta of NATIVE_PLUGINS) {
    const cfg = await loadPluginConfig(pool, cipher, userId, meta.id);
    const complete = isConfigComplete(cfg, meta.requiredFields);
    const status: PluginStatus = complete ? 'configured' : 'unconfigured';
    out.push({
      id: meta.id,
      name: meta.name,
      description: meta.description,
      tools: meta.tools,
      configFields: meta.configFields,
      status,
      enabled: complete,
    });
  }
  return out;
}

/**
 * 打码读回某插件的配置（设置抽屉的「当前已填」展示用）。
 * secret 字段 value 恒为 `****`（set=true 表示设过）；非 secret 字段回原值。
 */
export function maskConfigForView(meta: NativePluginMeta, config: PluginConfig | null): Record<string, { set: boolean; masked: boolean; value: string }> {
  const out: Record<string, { set: boolean; masked: boolean; value: string }> = {};
  for (const f of meta.configFields) {
    const raw = config ? String(config[f.key] ?? '') : '';
    const set = raw.trim() !== '';
    if (f.type === 'secret') {
      out[f.key] = { set, masked: true, value: set ? '****' : '' };
    } else {
      out[f.key] = { set, masked: false, value: raw };
    }
  }
  return out;
}
