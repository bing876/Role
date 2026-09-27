# ADR-0008 · GitHub / 飞书原生连接器先只读、按用户存密钥

- 状态：接受（2026-09-27，片3）

## 背景

用户要求把 GitHub 和飞书作为原生能力接入设置/循环引擎；但先前产品约束「不做自动发送」仍生效。飞书的 tenant_access_token 代表**应用**而非用户，默认不能读取用户全部私有云文档；GitHub 的 Issues API 会混进 PR。

## 决定

1. 第一片仅提供四个只读工具：`github_list_issues`、`github_read_issue`、`feishu_list_files`、`feishu_read_doc`；**不提供**创建 Issue、提交 PR、发飞书消息、写文档的自动工具。
2. 设置里的 GitHub Token / 飞书 App ID + App Secret 按既有 `plugin_configs` AES-256-GCM 加密；测试连通使用真 `/user` 与 `/auth/v3/tenant_access_token/internal` API。飞书 test 只能说明 App ID+Secret 有效，**不能**证明任一文档已授权。只用 `ctx.userId` 的配置，不借宿主机 `gh auth` 或某个全局 env key。
3. 外部 API 使用封闭路径/校验后的仓库名、issue 编号、folder/document ID；公网 HTTPS、本机回环 HTTP；不跟随跳转；响应限 1 MB、白名单整形、错误脱敏。GitHub list 排除 `pull_request` 项；飞书文档读取限应用有权限的内容。
4. 自动验收用真库真 Fastify app + 生产 executor + 本地真 HTTP 上游服务；真实 token 公网端到端单列 `verify:connectors:live`，无凭据不冒充通过。

参考：GitHub https://docs.github.com/en/rest/issues/issues；飞书 https://open.feishu.cn/document/ukTMukTMukTM/uUDN04SN0QjL1QDN/document-docx/docx-overview 、https://open.larkoffice.com/document/server-docs/api-call-guide/server-api-list 。

## 后果

- 用户只须填 key，不必管理 OAuth 回调；但 PAT / App Secret 的申请与最小权限配置由用户在各官方平台完成。
- 飞书 tenant token 会在每次调用获取（先不落盘、不缓存），读 docx 需要把应用单独加入文档授权。
- GitHub Enterprise / Lark 国际站可改 HTTPS API base URL（仅用户主动保存）。

## 备选与否因

- 自动建 issue / 自动发飞书消息：与「不做自动发送」冲突；要另行设计确认卡与可审计授权，拒。
- 用当前运行环境的 `gh` 登录态给所有用户复用：跨账号泄权，拒。
- 把飞书 token 当用户 token 直接读所有文档：权限口径造假，拒。
