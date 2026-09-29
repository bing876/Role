/** 模型设置数据：只经 shared/api 调用本地服务，不把密钥存进 Electron settings/localStorage。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelConfigInput, ModelConfigView, ModelTestResult } from '@ai-workbench/shared';
import { authFetchJson } from '../../shared/api';

export function useModelSettings(active: boolean, token: string | null) {
  const [config, setConfig] = useState<ModelConfigView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  // 切账号 / 退出 / 关闭抽屉后的旧请求不能把另一个账号的视图刷回来。
  const serial = useRef(0);
  const headers = useCallback(() => ({ authorization: `Bearer ${token ?? ''}` }), [token]);

  const refresh = useCallback(async () => {
    if (!token) return;
    const id = ++serial.current;
    try {
      const view = await authFetchJson<ModelConfigView>('/model/config', { headers: headers() });
      if (id === serial.current) { setConfig(view); setLoaded(true); setError(''); }
    } catch (e) {
      if (id === serial.current) { setLoaded(true); setError((e as Error).message); }
    }
  }, [token, headers]);

  useEffect(() => {
    ++serial.current;
    setConfig(null); setLoaded(false); setError('');
    if (active && token) void refresh();
    return () => { ++serial.current; };
  }, [active, token, refresh]);

  const save = useCallback(async (input: ModelConfigInput) => {
    if (!token) return { ok: false, error: '请先登录' };
    const accountGeneration = serial.current;
    try {
      await authFetchJson('/model/config', { method: 'POST', headers: headers(), body: JSON.stringify(input) });
      if (accountGeneration === serial.current) await refresh();
      return { ok: true };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  }, [token, headers, refresh]);

  const clear = useCallback(async () => {
    if (!token) return false;
    const accountGeneration = serial.current;
    try {
      await authFetchJson('/model/config', { method: 'DELETE', headers: headers() });
      if (accountGeneration === serial.current) await refresh();
      return true;
    } catch (e) { if (accountGeneration === serial.current) setError((e as Error).message); return false; }
  }, [token, headers, refresh]);

  const test = useCallback(async (): Promise<ModelTestResult> => {
    if (!token) return { ok: false, detail: '请先登录' };
    try {
      return await authFetchJson<ModelTestResult>('/model/test', {
        method: 'POST', headers: headers(), body: '{}',
      });
    } catch (e) { return { ok: false, detail: (e as Error).message }; }
  }, [token, headers]);

  return { config, loaded, error, save, clear, test, refresh };
}
