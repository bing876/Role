/**
 * 能力与连接 · 渲染层逻辑（2026-09-27）。
 *
 * 「能力与连接」卡片列表：拉插件注册表 + 当前登录用户的配置状态（灰/绿），
 * 填 key / 存（服务端加密落本地）/ 测试连通 / 清空。
 *
 * ★ 后端交互**只**走 `shared/api.ts`（authFetchJson + API_BASE），不在 feature 里硬编码地址。
 * ★ 密钥只在「填 key 的输入框」里出现一次，存完服务端打码，读回永远是 ****（不回明文）。
 */
import { useCallback, useEffect, useState } from 'react';
import { authFetchJson, TOKEN_KEY } from '../../shared/api';
import type { PluginInfo } from '@ai-workbench/shared';

export interface FieldView {
  set: boolean;
  masked: boolean;
  value: string;
}

export interface TestResult {
  ok: boolean;
  detail: string;
  error?: string;
}

export function usePlugins(active: boolean) {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState('');

  const authHeaders = useCallback(() => ({ authorization: `Bearer ${localStorage.getItem(TOKEN_KEY) ?? ''}` }), []);

  const refresh = useCallback(async () => {
    try {
      const r = await authFetchJson<{ plugins: PluginInfo[] }>('/plugins', { headers: authHeaders() });
      // 防御：后端任何异常（旧构建无此路由 / 畸形体）都不许让面板炸 —— 退成空列表
      setPlugins(Array.isArray(r.plugins) ? r.plugins : []);
      setLoaded(true);
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [authHeaders]);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  /** 读某插件当前配置（打码视图），用于展开表单时预填非密文字段 */
  const getConfig = useCallback(
    async (id: string): Promise<Record<string, FieldView> | null> => {
      try {
        const r = await authFetchJson<{ fields: Record<string, FieldView> }>(`/plugins/${id}/config`, { headers: authHeaders() });
        return r.fields;
      } catch {
        return null;
      }
    },
    [authHeaders],
  );

  const saveConfig = useCallback(
    async (id: string, config: Record<string, string>): Promise<{ ok: boolean; error?: string }> => {
      try {
        const r = await authFetchJson<{ ok: boolean; configured: boolean }>(`/plugins/${id}/config`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ config }),
        });
        await refresh();
        return { ok: Boolean(r.ok) };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    [authHeaders, refresh],
  );

  const clearConfig = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        await authFetchJson(`/plugins/${id}/config`, { method: 'DELETE', headers: authHeaders() });
        await refresh();
        return true;
      } catch {
        return false;
      }
    },
    [authHeaders, refresh],
  );

  /** 测试连通（最轻一次真调用）；未配置也会返回 ok:false（不抛） */
  const testConfig = useCallback(
    async (id: string): Promise<TestResult> => {
      try {
        const r = await authFetchJson<TestResult>(`/plugins/${id}/test`, {
          method: 'POST',
          headers: authHeaders(),
          body: '{}',
        });
        return { ok: r.ok, detail: r.detail, error: r.error };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    },
    [authHeaders],
  );

  return { plugins, loaded, err, refresh, getConfig, saveConfig, clearConfig, testConfig };
}
