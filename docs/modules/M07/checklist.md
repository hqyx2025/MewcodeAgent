# M07 验收记录

状态：本地完整检查及安装包通过，待推送与远端 CI 验证（2026-10-06）。

实际环境：Windows 11 Pro，Node.js 24.14.0、npm 11.9.0。仅使用模拟 provider 与本地 MCP 服务，不调用收费模型或用户端点。

- [x] stdio initialize、两页 tools/list、tools/call、输入/输出 Schema、isError。
- [x] Plan 拒绝服务启动。
- [x] HTTP JSON/SSE、重定向、响应限制和鉴权脱敏。
- [x] 取消/超时、目录变化、断连隔离、后代进程清理。
- [x] `npm run check`：类型、lint、格式、边界、22个测试文件和构建通过；229 passed、1 Windows平台跳过（总230）。模块边界70个模块/216条依赖，无违规。
- [x] `npm run test:package`：独立安装/CLI/bin、Mock任务、提示、权限审计以及MCP静态查看/发现/调用通过。
- [x] `npm audit --omit=dev`：0 vulnerabilities；`git diff --check`通过。
- [ ] Windows/Linux CI。

远端 CI 链接与准确代码提交待实际运行后填写。

`npm run bench:mcp`：5个样本，每个使用新连接，Node模拟服务共2个工具/2页发现；Windows Job Object 转发启动计入发现。启动/初始化/发现中位369ms，快照100次读取中位0.19ms，20次调用中位10.52ms。调用包括Schema验证、自动批准回调与内存审计，排除人工等待、模型、外部网络和磁盘审计；不视为真实MCP服务或模型性能。

打包安装回归通过（中文/空格路径、仅生产依赖）：静态list、本地stdio发现及明确授权调用均成功，help不加载MCP SDK/AJV等重依赖。压缩包159496bytes，解包604117bytes，compiled JS191602bytes；help共7次采样中位60.02ms、最小58.46ms、最大61.04ms。使用本地生产依赖安装产物，测量包括Node进程启动；不包含npm安装耗时。
