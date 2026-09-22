# 桌面端登录全挂 —— 根因、修复、反证

日期：2026-09-21 · 结论：**已修复并换装，登录实测通过**

---

## 一、症状

装了本轮云端同步包之后，桌面端登录页永远停在
「**正在准备后端…（应用会自动拉起数据库和服务端，首次启动最长约 1 分钟，已等 3058 秒）**」，
点登录报「连不上后端」。

后端本身是完全健康的：`/health` 返回
`{"ok":true,"service":"ai-workbench-server","db":"up","sms":"mock","llm":"configured"}`，
数据库 13 张表就绪。所以问题不在服务端，在**渲染层算出来的后端地址**。

---

## 二、根因

云端提交 **`d6ee1c4`（支持会话沙箱直测部署，内置 PGlite 数据库与 WebBridge 适配器）**
改了 `apps/desktop/src/App.tsx` 里的 `API_BASE()`：

```ts
// 改之前
const API_BASE = () => localStorage.getItem('workbench.apiBase') || 'http://127.0.0.1:8787';

// 改之后
const custom = localStorage.getItem('workbench.apiBase');
if (custom) return custom;
if (typeof window !== 'undefined' && !(window as any).workbench?.isElectron) {
  return '';                       // web 直测模式走 Vite 代理
}
return 'http://127.0.0.1:8787';
```

设计意图没问题：web 沙箱垫片 `webBridge.ts` 里 `isElectron: false` → 走相对路径。

**但 preload 从来没有 `isElectron` 这个字段** —— `apps/desktop/electron/preload.ts` 暴露给
`window.workbench` 的只有 `platform` / `appVersion` / `ping` 和其它方法。于是真实 Electron 里：

```
window.workbench.isElectron === undefined
→ !undefined === true
→ API_BASE() 返回 ''（空串）
→ fetch('/health') 在 file:// 起源下必然失败
→ 永远「正在准备后端」
```

`d6ee1c4` 正是本轮从 `arena/01a0c1e3-work123` 同步进来的 9 个提交之一 —— 也就是说，
**这次部署把这个回归一起带了进来**。

---

## 三、修复（两处，缺一不可）

| 文件 | 改动 |
|---|---|
| `packages/shared/src/index.ts` | `WorkbenchBridge` 接口新增 `isElectron: boolean`（不加则 preload 里 TS 报「多余属性」） |
| `apps/desktop/electron/preload.ts` | bridge 新增 `isElectron: true` |

`App.tsx` 一行未动 —— 字段补齐后原判断自然成立。

---

## 四、验证（CDP 直插真实安装版的渲染层）

用 `--no-sandbox --remote-debugging-port=9222` 启动安装版，连渲染层实测。

**修复后**

```
window.workbench: { hasBridge: true, isElectron: true, apiBaseStored: null }
页面上下文 fetch: base=[http://127.0.0.1:8787] OK {"ok":true,"db":"up",...}
登录页文案:      登录 AI 工作台 | 手机验证码 | XYZ号+密码 | 微信 | 获取验证码 |
                登录 / 注册 | … | ⚡ 快捷登录：一键演示账号进入
                        ↑ 不再有「正在准备后端」
```

**端到端**：完整鼠标序列点「⚡ 快捷登录」

```
hasToken: true（165 字符）
stillLoginGate: false
渲染出: 当前项目 / 小助·在线 / 💬 对话 / 🌐 浏览器 / 欢迎使用 AI 自主浏览器工作台 / 示例提示
```

---

## 五、反证（证明验证不是摆设）

故意把 preload 的 `isElectron` 改成 `false`，重新构建 + 换装 + 重启，再跑同一套探针：

```
isElectron: false
页面上下文 fetch: base=[] FAIL Failed to fetch
登录页文案:      … | 正在准备后端…（应用会自动拉起数据库和服务端，首次启动最长约 1 分钟，已等 50 秒） | …
```

**三项全红，且完整复现了用户截图里的症状。** 随后恢复 `true`、重建、换装，
asar 的 `sha256 = 691205b2…` 与修复版一致。

---

## 六、产物与回滚

- 已装包：`...\@ai-workbenchdesktop\resources\app.asar`（新，5,572,642 B）
- 回滚包：`_rollback-backup-20260918\app.asar.old-isElectron-fix-r8-final`（反证前的版本）
- 更早：`app.asar.old-cloud-sync-01a0c1e3`（本轮同步前）

---

## 六点五、修复后补做的登录边界测试（全绿）

修好"能登录"只是及格线。下面这些场景简报里没要求，是我主动补的：

| # | 场景 | 结果 |
|---|---|---|
| 1 | 手机号只填 10 位 | ✅ 「获取验证码」保持 disabled |
| 2 | 填 11 位 | ✅ 按钮解禁 |
| 3 | 发码后页面显示 mock 码 | ✅ 取到 6 位码 |
| 4 | **填错验证码（000000）** | ✅ 不登录，提示「验证码不对或已失效（错 5 次作废，可重新获取）」 |
| 5 | 填正确码 | ✅ 登录成功，token 163 字符 |
| 6 | **全新手机号自动建号** | ✅ 分配 XYZ19958，「密码：未设置」 |
| 7 | 点「微信」tab | ✅ 诚实占位「即将开通…未接入真实微信」，不白屏 |
| 8 | **未设密码的号走 XYZ+密码登录** | ✅ 明确拒绝 + 给可操作指引，且 `hasToken:false` |

期间我怀疑过"新号一注册就显示密码已设置"是 bug，实测那个号本来就在库里（users 表 141 行），
新号确实显示"未设置" —— **虚惊一场，没有误报**。

脚本：`.workbuddy-ai/_cdp-login-phone.mjs`、`_cdp-newuser.mjs`、`_cdp-pwdlogin.mjs`。

---

## 七、需要你亲自判断的主观项

自动化只能证明"登录通了、主界面渲染出来了"，这几项得你亲眼看一下：

1. **常驻顶栏浏览器切换** —— 位置顺不顺手，会不会挡住会话
2. **欢迎引导卡片** —— 挡不挡视线，示例提示自然不自然
3. **可视化看板** —— 信息密度会不会太高
4. 让 AI 打开网页执行时，**切后台 → 切回来**的过渡是否连贯

---

## 八、一件必须提醒的事

**我启动的进程活不过我的任务结束。** 现在工作台是我在一个后台任务里拉起来的，
那个任务结束后窗口会被一起回收。**请现在就用；** 如果过一会儿窗口没了，
双击桌面图标重新打开即可（你自己打开的不会被回收）。
