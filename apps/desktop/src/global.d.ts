import type { WorkbenchBridge } from '@ai-workbench/shared';

declare global {
  interface Window {
    /** 由 electron/preload.ts 通过 contextBridge 注入 */
    workbench?: WorkbenchBridge;
  }
}

export {};
