# M07：MCP 协议

状态：Windows 本地模拟回归和安装验证通过，最终完整检查及远端 CI 核对中（2026-10-06）。

## 范围

使用官方 MCP SDK 1.32.1，实现 stdio 和 Streamable HTTP initialize、tools/list 分页和 tools/call。配置只保存环境变量名称；服务 ID 最多8个，同 ID 的后续配置整份替换，避免混合不同命令的参数和凭据引用。默认不连接，run 通过 `--mcp <id...>` 选择。独立 `mcp list` 静态查看，`mcp discover`、`mcp call` 不调用模型。

启动和调用统一进入 ToolExecutor：external effect 始终审批，Plan 拒绝，accept-edits 和 allow 规则不能放宽，deny/ask 保持优先。服务只读声明、工具描述和返回内容不能授予权限。连接工具对模型隐藏；代理工具命名含服务 ID 和远端名摘要，长度不超过64。授权指纹包含连接代次和 Schema 摘要，不跨连接复用。

## 协议边界

- 参数必须为 object JSON Schema；支持 type、properties、required、additionalProperties、items、enum、const、数值/长度/数量边界及 title/description。拒绝 $ref、pattern/format、composition 等不支持的关键字，不静默放宽。使用 AJV 验证输入与 structuredContent 输出。
- Schema 最多32KiB、8层、512节点；JSON 数据最多256KiB、32层、10000节点。每服务最多64工具、8页、目录总计512KiB；每连接最多16MiB原始流量，stdio最多2000消息。超限关闭连接。
- 外部 text/structuredContent 经凭据脱敏后返回；媒体、资源、sampling、elicitation、required task 协议不执行。工具 isError 映射为明确失败。
- 连接与调用受独立时限、任务总预算和 Ctrl+C 约束。单服务连接失败不影响其他服务/内置工具；超时、断连不自动重试，外部副作用可能已发生。list_changed 使旧目录失效，重新发现需新建任务/管理器。
- stdio 仅继承系统环境白名单及显式引用。cwd 必须位于项目内且非链接。Windows 使用 Job Object 管理转发进程及后代，Linux 使用独立进程组；stderr 不输出、不保留。
- HTTP 仅固定无凭据/query/hash的 HTTP(S) endpoint，headersEnv 引用鉴权；禁止重定向、不自动 OAuth、不恢复重放请求。支持 JSON 和 SSE，GET 405 合法。关闭取消网络流，不无限等待服务端 DELETE。

MCP 启动权限允许外部程序拥有当前用户的主机能力，属于明确授权，不是 OS 文件/网络沙箱。Schema 子集和响应限制是本项目兼容性约束，不能宣称支持所有 MCP 服务。

## 验收

本地模拟 stdio/HTTP 服务覆盖分页发现、重名、成功、isError、畸形/超限 Schema 和结果、环境脱敏、权限、取消、目录变化和连接清理。`npm run check`、`npm run test:package`、有界 MCP 基准以及实际 Windows/Linux CI。不得调用收费模型。
