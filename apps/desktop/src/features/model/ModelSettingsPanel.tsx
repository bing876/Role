/** 设置抽屉 · 当前账号的模型配置。只给配置/测试/清空，不做每轮模型选择器。 */
import { useEffect, useState } from 'react';
import { MODEL_PROVIDER_DEFAULTS as defaults } from '@ai-workbench/shared';
import type { ModelConfigView, ModelProviderName, ModelTestResult } from '@ai-workbench/shared';
import type { useModelSettings } from './useModelSettings';

type Controller = ReturnType<typeof useModelSettings>;

export function ModelSettingsPanel({ config, loaded, error, save, clear, test }: Controller) {
  const [provider, setProvider] = useState<ModelProviderName>('deepseek');
  const [model, setModel] = useState(defaults.deepseek.model);
  const [baseUrl, setBaseUrl] = useState(defaults.deepseek.baseUrl);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [result, setResult] = useState<ModelTestResult | null>(null);
  // GET 永不返回 key；新账号挂载时旧组件由 App 的 key 卸载。读回只预填非秘密字段。
  useEffect(() => {
    if (!config) return;
    setProvider(config.provider); setModel(config.model || defaults.deepseek.model);
    setBaseUrl(config.baseUrl || defaults.deepseek.baseUrl);
    setKey(''); setResult(null);
  }, [config]);

  function changeProvider(next: ModelProviderName) {
    setProvider(next); setModel(defaults[next].model); setBaseUrl(defaults[next].baseUrl);
    setKey(''); setResult(null);
  }
  async function onSave() {
    setBusy(true); setNote(''); setResult(null);
    try {
      const r = await save({ provider, model: model.trim(), baseUrl: baseUrl.trim(), apiKey: key.trim() });
      if (r.ok) { setKey(''); setNote('已加密保存在本机。可点「测试连通」验证真模型。'); }
      else setNote(`保存失败：${r.error ?? '未知错误'}`);
    } finally { setBusy(false); }
  }
  async function onClear() {
    setBusy(true); setNote(''); setResult(null);
    try {
      if (await clear()) { setKey(''); setNote('本地配置已清空；如有环境变量将恢复使用环境变量。'); }
      else setNote('清空失败，请重试。');
    } finally { setBusy(false); }
  }
  async function onTest() {
    setBusy(true); setNote(''); setResult(null);
    try { setResult(await test()); } finally { setBusy(false); }
  }
  const source = (config?.source ?? 'none') as ModelConfigView['source'];
  const label = source === 'invalid' ? '密文损坏·需重配' : source === 'local' ? '本地已配置' :
    source === 'env' ? '环境变量已配置' : '未配置';
  return (
    <section className="modelPanel pluginsPanel" aria-label="模型设置">
      <div className="small pluginsPanel__title">模型设置</div>
      <div className="small pluginsPanel__hint">默认 DeepSeek。只需填一次 key，按账号加密存本机；聊天、委派、记忆、技能共用此配置，不用每轮手动选模型。</div>
      {!loaded && <div className="small">加载模型设置中…</div>}
      {error && <div className="small pluginsPanel__err">模型设置读取失败：{error}</div>}
      {loaded && <div className="pluginCard" data-status={source === 'local' || source === 'env' ? 'on' : 'off'}>
        <div className="pluginCard__head"><span className="pluginCard__dot" aria-hidden />
          <span className="pluginCard__name">{label}</span>
          <span className="pluginCard__badge">{config?.apiKeySet ? '密钥已打码' : '没有可用密钥'}</span>
        </div>
        {source === 'invalid' && <div className="small pluginsPanel__err">已存配置无法解密，任务会拒绝使用环境变量兜底。请重填 key 或清空本地配置。</div>}
        <div className="pluginCard__body">
          <label className="small pluginCard__field">模型供应商
            <select className="authInput" value={provider} onChange={(e) => changeProvider(e.target.value as ModelProviderName)}>
              <option value="deepseek">DeepSeek</option><option value="openai">OpenAI</option><option value="custom">兼容接口</option>
            </select>
          </label>
          <label className="small pluginCard__field">模型名
            <input className="authInput" value={model} maxLength={100} onChange={(e) => setModel(e.target.value)} placeholder="deepseek-flash" />
          </label>
          <label className="small pluginCard__field">API 地址（不含 /chat/completions）
            <input className="authInput" type="url" value={baseUrl} maxLength={2048} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.deepseek.com" />
          </label>
          <label className="small pluginCard__field">API Key（保存后不回显）
            <input className="authInput" type="password" autoComplete="off" value={key} maxLength={4096}
              onChange={(e) => setKey(e.target.value)} placeholder={source === 'local' ? '留空保留当前 key（供应商/地址不变时）' : '填入新 key'} />
          </label>
          <div className="small pluginCard__help">换供应商或 API 地址必须同时填新 key；不把当前 key 带到别家。环境变量密钥不会显示也不会被拷贝进本地设置。</div>
          <div className="buttons-row">
            <button type="button" className="btn" disabled={busy} onClick={() => void onSave()}>{busy ? '处理中…' : '加密保存'}</button>
            <button type="button" className="btn" disabled={busy || !config?.apiKeySet} onClick={() => void onTest()}>测试连通</button>
            {(source === 'local' || source === 'invalid') && <button type="button" className="btn pluginCard__clear" disabled={busy} onClick={() => void onClear()}>清空本地配置</button>}
          </div>
          {note && <div className="small pluginCard__note">{note}</div>}
          {result && <div className={`small pluginCard__test ${result.ok ? 'ok' : 'err'}`}>{result.ok ? '✓ ' : '✗ '}{result.detail}</div>}
        </div>
      </div>}
    </section>
  );
}
