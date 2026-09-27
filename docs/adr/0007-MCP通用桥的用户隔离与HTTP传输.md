# ADR-0007 · MCP 通用桥：Streamable HTTP、按用户授权、append-only 工具注册表

- 状态：接受（2026-09-27，片2）

## 背景

原生能力（网页搜索/生成图片）有固定工具名；MCP server 工具由用户运行时添加，来自公网，存在跨账号调用、重名、远端 URL/凭据泄漏风险。现有 ToolRegistry 不支持注销，模型的工具表在建循环时固定。

## 决定

1. 第一版只支持 MCP `2025-03-26` Streamable HTTP（JSON-RPC 的 `initialize`/`initialized`/`tools/list`/`tools/call`），兼容 JSON 与 SSE 响应；不执行用户提供的 stdio/shell 命令。
2. 注册工具名按全局 `mcp__s<serverRowId>__<toolName>` 命名。一个账号最多 8 个 server，每个最多 40 个工具；新增时连通拉工具并持久化元数据。主循环两个入口按当下用户的列表拼工具名；执行器**再查** `(server.id,user_id)` 及工具成员。删除后旧注册表项仍在内存但不可执行、也不再发给模型。
3. 认证仅作为 `auth_enc` AES-256-GCM 密文落库，响应仅回 `hasAuth`；不能解密/没有 cipher → fail-closed。不把上游原始错误回显（防密钥泄漏）。公网端点仅 HTTPS，本机回环可 HTTP；拒 URL 内凭据/查询参数、禁重定向，自定义鉴权头限 `X-*`。
4. 离线自动验收由真库、真 app、真回环 HTTP MCP server 实现；公网 DeepWiki live 验收需网络连接，在沙箱受限时明确失败、不伪称成功（`verify:mcp:public` 独立运行）。

协议出处：https://modelcontextprotocol.io/specification/2025-03-26/basic/transports

## 后果

- 新增 MCP 能力下一轮任务才能看见；已经建好的循环工具名保持原样（但删除的连接在执行时失败）。
- append-only 表需上限；跨用户相同原始工具名不会相互覆盖。
- 目前只开放远程 HTTP 传输；需要 OAuth 流程、stdio、资源订阅等更广协议覆盖时另立 ADR 和安全评估。

## 备选与否因

- 直接把原始工具名注册到全局表：同名撞、串号，拒。
- 在 UI/本机执行任意 stdio 命令：可被恶意配置 RCE，拒。
- 只靠建循环时工具名过滤、不在执行时验 `user_id`：删除/串号后仍可能调用，拒。
- 拉不到公开服务时把本地桩说成真实公网验收：虚假上线证据，拒。
