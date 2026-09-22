/** 简易 storage 封装 —— 仅为后续接入真实后端预留接口 */
import type { Contact } from '../data/contacts';

export interface ChatMessage {
  id: string;
  sender: 'user' | 'ai';
  text: string;
  thinking?: boolean;
  /** 二维码图片（data URL） */
  qrDataUrl?: string;
  /** 流式输出专用：完整文本；text 是已显示部分，每 tick 推进 */
  _fullText?: string;
}

export const sessionStore = {
  load(_contactId: string): ChatMessage[] { return []; },
  save(_contactId: string, _msgs: ChatMessage[]) { /* noop，留待接入 */ },
};

export const avatarUrl = (c: Contact): string | undefined => c.av;