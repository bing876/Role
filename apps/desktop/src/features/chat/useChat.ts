import { useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ChatHistoryResult, ChatSource, ChatSpeaker } from '@ai-workbench/shared';
import { authFetchJson } from '../../shared/api';

/**
 * 阶段 1① · 逻辑抽离第 7a 片：**聊天这一侧的 state 与历史**。
 *
 * 搬进来的：一个智能体一份聊天的 `chats`（+ 它的最新值镜像 `chatsRef`）、
 * 「哪个智能体在流式输出 / 流到哪了」、聊天区那一行提示 `chatNote`、
 * 步骤小字 `agentSteps`、结果文档信息 `agentDoc`、以及「这个智能体拉过历史没」的账本。
 *
 * ★ 还**没**搬 `sendChat`（485 行，片 7b）与几条"名单类"跨 feature 操作：
 *   它们要同时指挥聊天 / 浏览器 / 任务，属于组合层，等 7b 一起处理。
 *
 * ★ `curAgentId` / `curAgentRef` 是**注入**的（"当前是哪个智能体"是左栏的选择，
 *   不属于聊天这一侧，浏览器与记忆也要读它）。
 *
 * ★ 本片**只搬逻辑，不动一行 JSX / 一行 CSS**（同名解构回 App）。
 */

export type Role = 'user' | 'assistant';

export type Message = {
  id: number;
  role: Role;
  text: string;
  /**
   * 第 26 步：这条回复引用到的网页来源（本轮联网检索命中的）。
   * 只有走过搜索的助手回复才有；渲染成气泡下方的可点链接。
   */
  sources?: ChatSource[];
  /**
   * 批次 J：这句助手话是**哪个智能体**说的（@点名换人之后，同一条会话里会有不同人开口）。
   * undefined = 不知道（老数据 / 服务端没给）—— 界面就**不挂名字牌**，绝不拿当前智能体冒充。
   */
  speaker?: ChatSpeaker;
};

/** 第 15 步：一个智能体 = 一份聊天（自己的消息列表 + 自己的会话号） */
export type AgentChat = { messages: Message[]; convId: number | null };

/** 空列表用同一个常量：切智能体时引用稳定，不会每次渲染都造新数组 */
const EMPTY_MESSAGES: Message[] = [];

export interface UseChatOptions {
  /** 最新值镜像：会话（token 从这里面拿） */
  sessionRef: { current: { token: string } | null };
  /** 当前智能体 id（响应式，用于 `messages` 这类派生值） */
  curAgentId: number | null;
  /** 最新值镜像：当前智能体（异步回包里读它，闭包里的 state 是旧的） */
  curAgentRef: { current: number | null };
}

export interface ChatApi {
  /** 一个智能体一份聊天 */
  chats: Record<number, AgentChat>;
  setChats: Dispatch<SetStateAction<Record<number, AgentChat>>>;
  /** 异步回包里读最新 chats（闭包里拿 state 会拿到旧的） */
  chatsRef: { current: Record<number, AgentChat> };
  /** 已经拉过历史的智能体，来回切换不反复请求 */
  historyLoadedRef: { current: Set<number> };
  /** 当前智能体那一份（没有就是 undefined） */
  curChat: AgentChat | undefined;
  /** 当前要渲染的消息列表（没有就指向同一个空数组常量） */
  messages: Message[];
  /** 往「当前智能体」那份聊天里追加/替换消息（沿用第 6 步以来的调用点写法） */
  setMessages: (updater: Message[] | ((prev: Message[]) => Message[])) => void;
  /** 改某一份聊天（引用不变时原样返回，少一次无谓渲染） */
  patchChat: (agentId: number, patch: (c: AgentChat) => AgentChat) => void;
  /** 流式输出中 */
  streaming: boolean;
  setStreaming: Dispatch<SetStateAction<boolean>>;
  /** 正在流式输出的那个智能体（别的智能体的消息不该被这段文本染色） */
  streamingAgentId: number | null;
  setStreamingAgentId: Dispatch<SetStateAction<number | null>>;
  /** 这一轮流式文本 */
  streamText: string;
  setStreamText: Dispatch<SetStateAction<string>>;
  /** 聊天区那一行提示（**其它 feature 唯一往聊天里说话的通道**） */
  chatNote: string;
  setChatNote: Dispatch<SetStateAction<string>>;
  /** 主进程报上来的最后几步摘要（可见度条要用尾巴那一条） */
  agentSteps: string[];
  setAgentSteps: Dispatch<SetStateAction<string[]>>;
  /** 结果文档的标题与大纲 */
  agentDoc: { title: string; outline: string[] } | null;
  setAgentDoc: Dispatch<SetStateAction<{ title: string; outline: string[] } | null>>;
  /** 聊天里追加一条「小助之外」的系统泡（driver 循环的问话/结论/报错），只进内存展示 */
  pushChatLine: (text: string) => void;
  /**
   * 第 17 步：按智能体落桶的系统泡。
   * 两路驾驶可能分属两个智能体，事件里的 wcId 决定这条话进谁的聊天 ——
   * 绝不按「此刻正在看的那个智能体」乱写（那正是「聊天串了」）。
   */
  pushChatLineFor: (agentId: number, text: string) => void;
  /** 拉某个智能体的历史（切号期间晚到的响应丢掉） */
  loadAgentHistory: (agent: { id: number; conversationId: number | null }) => Promise<void>;
  /** 登出/换号：聊天这一侧一次清干净 */
  resetChat: () => void;
}

export function useChat({ sessionRef, curAgentId, curAgentRef }: UseChatOptions): ChatApi {
  const [chats, setChats] = useState<Record<number, AgentChat>>({});
  /** 异步回包里读最新 chats（闭包里拿 state 会拿到旧的） */
  const chatsRef = useRef<Record<number, AgentChat>>({});
  chatsRef.current = chats;
  /** 已经拉过历史的智能体，来回切换不反复请求 */
  const historyLoadedRef = useRef<Set<number>>(new Set());

  const [streaming, setStreaming] = useState(false);
  const [streamingAgentId, setStreamingAgentId] = useState<number | null>(null);
  const [streamText, setStreamText] = useState('');
  const [chatNote, setChatNote] = useState('');
  const [agentSteps, setAgentSteps] = useState<string[]>([]);
  const [agentDoc, setAgentDoc] = useState<{ title: string; outline: string[] } | null>(null);

  const patchChat = (agentId: number, patch: (c: AgentChat) => AgentChat) => {
    setChats((prev) => {
      const cur = prev[agentId] ?? { messages: [], convId: null };
      const next = patch(cur);
      return next === cur ? prev : { ...prev, [agentId]: next };
    });
  };

  const curChat = curAgentId === null ? undefined : chats[curAgentId];
  const messages = curChat?.messages ?? EMPTY_MESSAGES;
  /** 往「当前智能体」那份聊天里追加/替换消息（沿用第 6 步以来的调用点写法） */
  const setMessages = (updater: Message[] | ((prev: Message[]) => Message[])) => {
    const id = curAgentRef.current;
    if (id === null) return;
    patchChat(id, (c) => ({ ...c, messages: typeof updater === 'function' ? updater(c.messages) : updater }));
  };

  /** 聊天里追加一条「小助之外」的系统泡（driver 循环的问话/结论/报错），只进内存展示 */
  const pushChatLine = (text: string) => {
    setMessages((prev) => prev.concat({ id: Date.now() + Math.floor(Math.random() * 1000), role: 'assistant', text }));
  };

  const pushChatLineFor = (agentId: number, text: string) => {
    patchChat(agentId, (c) => ({
      ...c,
      messages: c.messages.concat({ id: Date.now() + Math.floor(Math.random() * 1000), role: 'assistant', text }),
    }));
  };

  const loadAgentHistory = async (agent: { id: number; conversationId: number | null }) => {
    const sess = sessionRef.current;
    if (!sess) return;
    const q = agent.conversationId !== null ? `?conversationId=${agent.conversationId}` : `?agentId=${agent.id}`;
    try {
      const h = await authFetchJson<ChatHistoryResult>(`/chat/history${q}`, {
        headers: { authorization: `Bearer ${sess.token}` },
      });
      if (sessionRef.current?.token !== sess.token) return; // 切号期间晚到的响应丢掉
      historyLoadedRef.current.add(agent.id);
      patchChat(agent.id, () => ({
        // 批次 J：历史里的发言人一并带过来（服务端 speaker_agent_id → {id,name}）；
        // 老行没有这一列 → undefined → 气泡不挂名字牌（不猜、不拿当前智能体冒充）
        messages: h.messages.map((m) => ({ id: m.id, role: m.role, text: m.text, sources: m.sources, speaker: m.speaker })),
        convId: h.conversationId,
      }));
    } catch (e) {
      setChatNote(`拉取历史失败：${(e as Error).message}`);
    }
  };

  /** 登出/换号：聊天这一侧一次清干净（原来在 `onLogout` 里散着写） */
  const resetChat = () => {
    setChatNote('');
    setStreamText('');
    setChats({});
    historyLoadedRef.current = new Set();
    setAgentSteps([]);
    setAgentDoc(null);
  };

  return {
    chats,
    setChats,
    chatsRef,
    historyLoadedRef,
    curChat,
    messages,
    setMessages,
    patchChat,
    streaming,
    setStreaming,
    streamingAgentId,
    setStreamingAgentId,
    streamText,
    setStreamText,
    chatNote,
    setChatNote,
    agentSteps,
    setAgentSteps,
    agentDoc,
    setAgentDoc,
    pushChatLine,
    pushChatLineFor,
    loadAgentHistory,
    resetChat,
  };
}
