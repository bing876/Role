/**
 * 第 16 步：模型调用的**唯一出口**（计数 + 日志）。
 *
 * 为什么要有这个文件：
 *   - 验收要求「空闲/保活时不调 LLM」必须**看得出来**。把 5 处 fetch 收成一个出口后，
 *     每次调用都会打一行 `[llm] #N ...`，`GET /health` 也回一个 `llmCalls` 计数——
 *     保活挂着没消息时，这两个数都不动，就是证据。
 *   - 顺手统一超时、JSON 模式、密钥只从这里出去（绝不进前端、绝不进日志）。
 *
 * 明确不做：不在这里做重试风暴、不做计费看板、不做 7×24 集群调度。
 */
import type { ServerEnv } from './env';

export interface LlmToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** 第 21 步：assistant 要求调用工具时带上它（tool 角色的消息用 tool_call_id 回执） */
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
}

export interface LlmCallOptions {
  /** 调用方标签，只用于日志（例如 chat/stream、agent/next-action） */
  tag: string;
  stream?: boolean;
  /** 让模型只回一个 JSON 对象（DeepSeek 的 response_format） */
  json?: boolean;
  temperature?: number;
  /** 单次请求超时；默认 60s（流式聊天由调用方自己给 AbortController） */
  timeoutMs?: number;
  /** 调用方自己的 AbortSignal（流式聊天用：客户端断开就掐上游） */
  signal?: AbortSignal;
  /**
   * 第 21 步：工具表（OpenAI 兼容的 function 定义）。
   * 给了它才开 function call——闲聊路径**一个工具都不给**，所以闲聊不可能开页。
   */
  tools?: unknown[];
  /** 'auto'（默认，给工具时）/ 'none' / 'required' */
  toolChoice?: 'auto' | 'none' | 'required';
}

let calls = 0;
let lastAt = 0;
let lastTag = '';

/** 累计模型调用次数（/health 暴露它，用来证明空闲/保活不调模型） */
export function llmCallCount(): number {
  return calls;
}

export function llmLastCall(): { count: number; at: number; tag: string } {
  return { count: calls, at: lastAt, tag: lastTag };
}

/**
 * 调一次 chat/completions。返回原始 Response，交给调用方决定怎么读（流式 / JSON）。
 * 抛错就是连不上；HTTP 非 2xx 不在这里抛（调用方各自要不同的错误话术）。
 */
export async function llmFetch(env: ServerEnv, messages: LlmMessage[], opts: LlmCallOptions): Promise<Response> {
  calls += 1;
  lastAt = Date.now();
  lastTag = opts.tag;
  console.log(`[llm] #${calls} tag=${opts.tag} stream=${opts.stream ? 'yes' : 'no'} model=${env.deepseekModel}`);

  if (env.deepseekApiKey === 'mock' || env.deepseekApiKey.startsWith('mock:')) {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const lastTool = [...messages].reverse().find((m) => m.role === 'tool');

    if (opts.stream) {
      const encoder = new TextEncoder();
      const chunks = [
        `data: {"choices":[{"delta":{"content":"【沙箱直测】已接收指令：${lastUser.slice(0, 20)}。"}}]}\n\n`,
        `data: {"choices":[{"delta":{"content":"正在为您执行分析与规划..."}}]}\n\n`,
        `data: [DONE]\n\n`,
      ];
      let idx = 0;
      const stream = new ReadableStream({
        async pull(controller) {
          if (idx < chunks.length) {
            controller.enqueue(encoder.encode(chunks[idx++]));
            await new Promise((r) => setTimeout(r, 50));
          } else {
            controller.close();
          }
        },
      });
      return new Response(stream, {
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      });
    }

    if (opts.tools && opts.tools.length > 0) {
      // 工具循环模式：根据工具调用历史判定下一步
      const toolCount = messages.filter((m) => m.role === 'tool').length;
      let msgBody: Record<string, unknown>;

      if (toolCount === 0) {
        // 第一步：根据用户目标是打开网页还是普通感知
        const wantsUrl = /打开|搜|查|访问|http/i.test(lastUser);
        const targetUrl = lastUser.match(/https?:\/\/[^\s]+/)?.[0] || 'https://www.baidu.com';
        if (wantsUrl) {
          msgBody = {
            role: 'assistant',
            content: `我先打开目标网页进行检索：${targetUrl}`,
            tool_calls: [
              {
                id: `call_${Date.now()}_1`,
                type: 'function',
                function: { name: 'open_url', arguments: JSON.stringify({ url: targetUrl }) },
              },
            ],
          };
        } else {
          msgBody = {
            role: 'assistant',
            content: '我先查看当前页面内容。',
            tool_calls: [
              {
                id: `call_${Date.now()}_1`,
                type: 'function',
                function: { name: 'read_page', arguments: '{}' },
              },
            ],
          };
        }
      } else if (toolCount === 1) {
        // 第二步：读取网页内容
        msgBody = {
          role: 'assistant',
          content: '目标页面已加载，正在读取页面核心内容。',
          tool_calls: [
            {
              id: `call_${Date.now()}_2`,
              type: 'function',
              function: { name: 'read_page', arguments: '{}' },
            },
          ],
        };
      } else {
        // 第三步：整理结论并收尾
        msgBody = {
          role: 'assistant',
          content: '已成功完成对目标网页的浏览与信息提取，现在为您整理结果。',
          tool_calls: [
            {
              id: `call_${Date.now()}_done`,
              type: 'function',
              function: {
                name: 'stop',
                arguments: JSON.stringify({
                  reason: 'done',
                  summary: `已完成网页浏览与要点整理：${lastUser.slice(0, 30)}`,
                  document_title: '任务执行结论报告',
                  document_outline: ['任务目标概述', '网页核心内容提取', '综合分析结论'],
                }),
              },
            },
          ],
        };
      }

      const mockRes = {
        id: `mock-${Date.now()}`,
        choices: [
          {
            index: 0,
            message: msgBody,
            finish_reason: msgBody.tool_calls ? 'tool_calls' : 'stop',
          },
        ],
      };
      return new Response(JSON.stringify(mockRes), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // 普通 JSON 或单次对话
    const mockJson = {
      id: `mock-${Date.now()}`,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: `收到你的需求：${lastUser}。沙箱仿真引擎已就绪。`,
          },
          finish_reason: 'stop',
        },
      ],
    };
    return new Response(JSON.stringify(mockJson), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  const body: Record<string, unknown> = {
    model: env.deepseekModel,
    stream: Boolean(opts.stream),
    messages,
  };
  if (opts.json) body.response_format = { type: 'json_object' };
  if (typeof opts.temperature === 'number') body.temperature = opts.temperature;
  // 第 21 步：只有显式给了工具表才带 tools —— 闲聊/知识库轮不带，模型也就没有开页的能力。
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
    body.tool_choice = opts.toolChoice ?? 'auto';
  }

  const signal = opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 60_000);
  return fetch(`${env.deepseekBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.deepseekApiKey}` },
    body: JSON.stringify(body),
    signal,
  });
}
