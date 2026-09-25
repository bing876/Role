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
 * - DEEPSEEK_MODEL_CHAT 闲聊模型（默认 deepseek-chat）—— **简单**闲聊走它
 * - DEEPSEEK_MODEL_CHAT_COMPLEX 复杂闲聊模型（分析/诊断/对比/报告/调研…）。
 *   ★ 收尾 7（2026-09-24 用户拍板「真路由」）新增：以前复杂闲聊只是把 `reason` 写成
 *     「路由到推理模型」，`model` 返回的还是 `DEEPSEEK_MODEL_CHAT` —— 日志说得像路由了，
 *     实际两者同一个模型（空转）。现在**没配这个变量就如实回落**到 CHAT，并把「回落」写进 reason，
 *     绝不再声称路由到了一个其实没换的模型。
 * - DEEPSEEK_MODEL_TOOL 工具循环模型（默认 deepseek-chat，需要工具调用能力）
 * - DEEPSEEK_MODEL_EXTRACT 记忆抽取模型（默认 deepseek-chat，需要 JSON）
 * - DEEPSEEK_MODEL_SEARCH 搜索总结模型（默认 deepseek-chat）
 * - DEEPSEEK_MODEL_WORKER 临时工模型（默认 deepseek-chat）
 * - DEEPSEEK_MODEL_DELEGATE 委派模型（默认 deepseek-chat）
 * - 可扩展：OPENAI_API_KEY / ANTHROPIC_API_KEY 等多模型（预留）
 *
 * 反证（`scripts/verify/model-routing.mts`，跑的是本文件本体，不是副本）：
 * - 用户不选模型，前端无模型选择器
 * - 同一任务类型 + 同一正文 → 始终同一个模型（确定性）
 * - **配了 `DEEPSEEK_MODEL_CHAT_COMPLEX` 时，简单闲聊与复杂闲聊选出的 `model` 必须真的不同**
 * - 没配时两者相同，且 `reason` 必须如实说「回落」，不许声称路由到了推理模型
 * - `MODEL_ROUTING_ENABLED=0` 时一律回默认模型
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
  /**
   * 收尾 7 | 复杂闲聊的模型。★ 关键在「没配就如实回落」：
   * 回落不是 bug，是**没有第二个模型可用**时唯一诚实的行为；
   * bug 是回落了却在 `reason` 里写「已路由到推理模型」（那就是本批要修的空转）。
   */
  const chatComplexModel = (process.env.DEEPSEEK_MODEL_CHAT_COMPLEX || '').trim();
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
      /**
       * 收尾 7（用户 2026-09-24 拍板：真路由）：简单与复杂**必须选出不同的模型**，
       * 前提是配了 `DEEPSEEK_MODEL_CHAT_COMPLEX`；没配就回落到 CHAT，且 reason 如实说回落。
       * 原来这一段的两个分支 `model` 都写 `chatModel`，只有 reason 不一样 ——
       * 日志看着像路由了，实际一次都没换过模型（这就是「批次 I 空转」）。
       */
      if (taskText && isSimple(taskText)) {
        return { apiKey, baseUrl, model: chatModel, taskKind, reason: '简单闲聊，路由到快速模型' };
      }
      if (taskText && isComplex(taskText)) {
        return chatComplexModel
          ? { apiKey, baseUrl, model: chatComplexModel, taskKind, reason: '复杂闲聊，路由到推理模型' }
          : {
              apiKey,
              baseUrl,
              model: chatModel,
              taskKind,
              reason: '复杂闲聊，但未配 DEEPSEEK_MODEL_CHAT_COMPLEX，回落快速模型（没有换模型）',
            };
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
