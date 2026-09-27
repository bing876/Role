/**
 * 能力与连接 · 设置抽屉里的「能力与连接」卡片列表（2026-09-27）。
 *
 * 每张卡 = 一个原生能力（网页搜索 / 生成图片）：
 *   · 状态点：灰 = 未配置 / 绿 = 已配置可用；
 *   · 「配置」展开填 key 的表单（secret 字段打码读回、留空=保留当前 key）；
 *   · 「测试连通」最轻一次真调用；「清空」= 拔配置。
 *
 * 纯渲染层；数据全走 usePlugins（→ shared/api → 后端 /plugins*）。
 */
import { useState } from 'react';
import type { PluginInfo } from '@ai-workbench/shared';
import type { FieldView, TestResult } from './usePlugins';
import { McpServersPanel } from './McpServersPanel';

interface PanelProps {
  plugins: PluginInfo[];
  loaded: boolean;
  err: string;
  getConfig: (id: string) => Promise<Record<string, FieldView> | null>;
  saveConfig: (id: string, config: Record<string, string>) => Promise<{ ok: boolean; error?: string }>;
  clearConfig: (id: string) => Promise<boolean>;
  testConfig: (id: string) => Promise<TestResult>;
}

export function PluginsPanel(props: PanelProps) {
  const { plugins, loaded, err } = props;
  return (
    <div className="pluginsPanel">
      <div className="small pluginsPanel__title">能力与连接</div>
      <div className="small pluginsPanel__hint">外部能力：填 key 即开，配置加密存本机；没配的能力，AI 会如实说「没开通」，不会假装做了。</div>
      {!loaded && <div className="small">加载中…</div>}
      {loaded && err && <div className="small pluginsPanel__err">没读到能力列表：{err}</div>}
      <div className="pluginsPanel__list">
        {plugins.filter((p) => !p.id.startsWith('mcp_s')).map((p) => (
          <PluginCard key={p.id} plugin={p} {...props} />
        ))}
      </div>
      <McpServersPanel />
    </div>
  );
}

interface CardProps extends PanelProps {
  plugin: PluginInfo;
}

function PluginCard({ plugin, getConfig, saveConfig, clearConfig, testConfig }: CardProps) {
  const enabled = plugin.enabled;
  const [expanded, setExpanded] = useState(false);
  const [prefilled, setPrefilled] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [testState, setTestState] = useState<'idle' | 'testing' | 'done'>('idle');
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [note, setNote] = useState('');

  const setField = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const onExpand = async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (!prefilled) {
      // 展开时拉一次打码视图，预填非密文字段（secret 留空 = 保留当前 key）
      const view = await getConfig(plugin.id);
      if (view) {
        const init: Record<string, string> = {};
        for (const f of plugin.configFields) {
          const fv = view[f.key];
          if (!fv) continue;
          // secret 字段绝不把 **** 填进去（那会覆盖真 key）；留空 = 不改
          init[f.key] = f.type === 'secret' ? '' : fv.value;
        }
        setForm(init);
      }
      setPrefilled(true);
    }
  };

  const onSave = async () => {
    setBusy(true);
    setNote('');
    const r = await saveConfig(plugin.id, form);
    setBusy(false);
    if (r.ok) {
      setNote('已保存（key 加密存本机）。点「测试连通」验证能不能用。');
    } else {
      setNote(`保存失败：${r.error ?? '未知原因'}`);
    }
  };

  const onTest = async () => {
    setTestState('testing');
    setTestResult(null);
    const r = await testConfig(plugin.id);
    setTestState('done');
    setTestResult(r);
  };

  const onClear = async () => {
    setNote('');
    const ok = await clearConfig(plugin.id);
    setForm({});
    setPrefilled(false);
    setTestResult(null);
    setTestState('idle');
    if (ok) setNote('已清空配置。');
  };

  return (
    <div className="pluginCard" data-status={enabled ? 'on' : 'off'}>
      <div className="pluginCard__head">
        <span className="pluginCard__dot" aria-hidden />
        <span className="pluginCard__name">{plugin.name}</span>
        <span className="pluginCard__badge">{enabled ? '已配置' : '未配置'}</span>
        <button type="button" className="pluginCard__toggle" onClick={() => void onExpand()}>
          {expanded ? '收起' : enabled ? '管理' : '配置'}
        </button>
      </div>
      <div className="small pluginCard__desc">{plugin.description}</div>
      {expanded && (
        <div className="pluginCard__body">
          {plugin.configFields.map((f) => (
            <div className="pluginCard__field" key={f.key}>
              <label className="small" htmlFor={`plg-${plugin.id}-${f.key}`}>
                {f.label}
                {f.required ? ' *' : ''}
              </label>
              {f.type === 'select' ? (
                <select
                  id={`plg-${plugin.id}-${f.key}`}
                  className="authInput"
                  value={form[f.key] ?? ''}
                  onChange={(e) => setField(f.key, e.target.value)}
                >
                  {(f.options ?? []).map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={`plg-${plugin.id}-${f.key}`}
                  className="authInput"
                  type={f.type === 'secret' ? 'password' : 'text'}
                  placeholder={
                    f.type === 'secret' ? (enabled ? '留空 = 保留当前 key；填新的会替换' : f.placeholder ?? '填入 key') : f.placeholder ?? ''
                  }
                  value={form[f.key] ?? ''}
                  onChange={(e) => setField(f.key, e.target.value)}
                  autoComplete="off"
                />
              )}
              {f.help && <div className="small pluginCard__help">{f.help}</div>}
            </div>
          ))}
          <div className="buttons-row">
            <button type="button" className="btn" disabled={busy} onClick={() => void onSave()}>
              {busy ? '保存中…' : '保存'}
            </button>
            <button type="button" className="btn" disabled={testState === 'testing'} onClick={() => void onTest()}>
              {testState === 'testing' ? '测试中…' : '测试连通'}
            </button>
            {enabled && (
              <button type="button" className="btn pluginCard__clear" onClick={() => void onClear()}>
                清空
              </button>
            )}
          </div>
          {note && <div className="small pluginCard__note">{note}</div>}
          {testResult && (
            <div className={`small pluginCard__test ${testResult.ok ? 'ok' : 'err'}`}>{testResult.ok ? '✓ ' : '✗ '}
              {testResult.detail}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
