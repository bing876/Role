/**
 * 渲染层与后端打交道的**唯一入口**（批次 M · 逻辑抽离第 1 片）。
 *
 * 这四个东西原先写在 `App.tsx` 里（模块级、在组件之外），被 30 多处逻辑用到。
 * 抽出 feature 时如果继续留在 App.tsx，每个 feature 都要反向依赖 App —— 那是死结。
 * 所以原样搬到 `src/shared/api.ts`：**一行逻辑都没改**（连注释都在），只是换了位置，
 * 让 `features/**` 可以依赖 `shared/**` 而不必碰 `app/**`。
 *
 * ⚠️ 这里不许出现任何 React 依赖：它是纯模块，可以被 hooks / 组件 / 测试脚本直接 import。
 */

/** 后端地址：默认 127.0.0.1:8787；浏览器直测模式下自动使用相对路径走 Vite 代理 */
export const API_BASE = () => {
  const custom = localStorage.getItem('workbench.apiBase');
  if (custom) return custom;
  if (typeof window !== 'undefined' && !(window as any).workbench?.isElectron) {
    return '';
  }
  return 'http://127.0.0.1:8787';
};

export const TOKEN_KEY = 'workbench.token';

export async function authFetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE()}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    // ★ 文案要指向本机真正可用的那个动作。
    // 这台机器上没有可用的 Docker（PG 是便携包），"npm run db:up" 是跑不通的；
    // 正确做法是双击仓库根的 start-dev.cmd（它清陈旧 pid → 起 PG → 等库真能查 → 起服务端）。
    throw new Error(`连不上后端 ${API_BASE()}：先双击仓库根目录的 start-dev.cmd 起库和服务端，再重试`);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(dbHint(data.error) ?? `HTTP ${res.status}`);
  return data;
}

/**
 * 把服务端那句「先跑 docker compose…」换成本机真正可用的指引。
 *
 * 服务端 8 个 route 都会回同一句 503 文案（docker / npm run db:up），
 * 但本机没有可用的 Docker —— 对着这句照做只会更困惑。
 * 这里统一在渲染层做一次替换，改动面最小、也不会漏掉某个 route。
 */
export function dbHint(msg?: string): string | undefined {
  if (!msg) return msg;
  if (msg.includes('数据库连不上')) {
    return '数据库没连上：双击仓库根目录的 start-dev.cmd（它会起库 + 服务端并等到真正可用），再点一次';
  }
  return msg;
}
