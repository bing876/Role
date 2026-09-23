/**
 * 批次 I | 模型自动路由 — 用户不选模型，后端按任务路由
 *
 * 设计：
 * - 用户不选模型，前端不暴露模型选择器
 * - 后端按任务类型自动路由到合适的模型
 * - 任务类型：chat(闲聊)、tool(浏览器工具循环)、extract(记忆抽取)、search(搜索总结)、worker(临时工)、delegate(委派)
 * - 路由依据：任务复杂度、是否需要工具、是否需要长上下文、是否需要快响应
 * - 配置：通过环境变量配置不同任务的模型，默认全走 deepseek-chat，可扩展多模型
 *
 * 环境变量：
 * - MODEL_ROUTING_ENABLED=1 开启路由（默认开启）
 * - DEEPSEEK_MODEL_CHAT 闲聊模型（默认 deepseek-chat）
 * - DEEPSEEK_MODEL_TOOL 工具循环模型（默认 deepseek-chat，需要工具调用能力）
 * - DEEPSEEK_MODEL_EXTRACT 记忆抽取模型（默认 deepseek-chat，需要 JSON）
 * - DEEPSEEK_MODEL_SEARCH 搜索总结模型（默认 deepseek-chat）
 * - DEEPSEEK_MODEL_WORKER 临时工模型（默认 deepseek-chat）
 * - DEEPSEEK_MODEL_DELEGATE 委派模型（默认 deepseek-chat）
 * - 可扩展：OPENAI_API_KEY / ANTHROPIC_API_KEY 等多模型（预留）
 *
 * 反证：
 * - 用户不选模型，前端无模型选择器
 * - 同一任务类型始终路由到同一模型（确定性）
 * - 复杂任务路由到更强模型，简单任务路由到更快模型
 */

import type { ServerEnv } from './env';

export type TaskKind = 'chat' | 'tool' | 'extract' | 'search' | 'worker' | 'delegate' | 'default';

export interface ModelConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  taskKind: TaskKind;
  reason: string;
}

function resolveModelForTask(env: ServerEnv, taskKind: TaskKind, taskText?: string): ModelConfig {
  const baseUrl = env.deepseekBaseUrl;
  const apiKey = env.deepseekApiKey;

  // 基础模型
  const chatModel = (process.env.DEEPSEEK_MODEL_CHAT || '').trim() || env.deepseekModel;
  const toolModel = (process.env.DEEPSEEK_MODEL_TOOL || '').trim() || env.deepseekModel;
  const extractModel = (process.env.DEEPSEEK_MODEL_EXTRACT || '').trim() || env.deepseekModel;
  const searchModel = (process.env.DEEPSEEK_MODEL_SEARCH || '').trim() || env.deepseekModel;
  const workerModel = (process.env.DEEPSEEK_MODEL_WORKER || '').trim() || env.deepseekModel;
  const delegateModel = (process.env.DEEPSEEK_MODEL_DELEGATE || '').trim() || env.deepseekModel;

  // 按任务复杂度进一步路由（简单启发式）
  const isComplex = (text: string): boolean => {
    if (!text) return false;
    // 复杂任务关键词：分析、诊断、整理、对比、综合、报告
    return /(分析|诊断|整理|对比|综合|报告|调研|策划|复杂|深度|全面)/.test(text);
  };

  const isSimple = (text: string): boolean => {
    if (!text) return false;
    // 简单任务：问候、闲聊、简单问答
    return /^(你好|您好|hi|hello|谢谢|感谢)/i.test(text.trim()) || text.trim().length < 10;
  };

  switch (taskKind) {
    case 'chat':
      if (taskText && isSimple(taskText)) {
        return { apiKey, baseUrl, model: chatModel, taskKind, reason: '简单闲聊，路由到快速模型' };
      }
      if (taskText && isComplex(taskText)) {
        return { apiKey, baseUrl, model: chatModel, taskKind, reason: '复杂闲聊，路由到推理模型' };
      }
      return { apiKey, baseUrl, model: chatModel, taskKind, reason: '闲聊任务' };
    case 'tool':
      return { apiKey, baseUrl, model: toolModel, taskKind, reason: '浏览器工具循环，需要工具调用能力' };
    case 'extract':
      return { apiKey, baseUrl, model: extractModel, taskKind, reason: '记忆抽取，需要 JSON 输出' };
    case 'search':
      return { apiKey, baseUrl, model: searchModel, taskKind, reason: '搜索总结' };
    case 'worker':
      return { apiKey, baseUrl, model: workerModel, taskKind, reason: '临时工并行' };
    case 'delegate':
      return { apiKey, baseUrl, model: delegateModel, taskKind, reason: '智能体委派' };
    default:
      return { apiKey, baseUrl, model: env.deepseekModel, taskKind: 'default', reason: '默认路由' };
  }
}

export function getModelForTask(env: ServerEnv, taskKind: TaskKind, taskText?: string): ModelConfig {
  const enabled = (process.env.MODEL_ROUTING_ENABLED ?? '1').trim() !== '0';
  if (!enabled) {
    return {
      apiKey: env.deepseekApiKey,
      baseUrl: env.deepseekBaseUrl,
      model: env.deepseekModel,
      taskKind: 'default',
      reason: '路由关闭，全部走默认模型',
    };
  }
  return resolveModelForTask(env, taskKind, taskText);
}

/**
 * 供 llm.ts 调用的包装：根据 tag 自动推断 taskKind
 */
export function inferTaskKindFromTag(tag: string): TaskKind {
  const t = (tag ?? '').toLowerCase();
  if (t.includes('chat/stream') || t.includes('chat')) return 'chat';
  if (t.includes('agent/loop') || t.includes('tool') || t.includes('next-action')) return 'tool';
  if (t.includes('memories/extract') || t.includes('extract')) return 'extract';
  if (t.includes('search') || t.includes('tavily')) return 'search';
  if (t.includes('worker')) return 'worker';
  if (t.includes('delegate')) return 'delegate';
  return 'default';
}
