# MewCode Agent 开发约定

- 项目采用 Node.js 24、TypeScript 5、ESM、npm；依赖版本以 package.json 和 package-lock.json 为准。
- 当前路线与状态见 docs/02-模块实施与验收.md。按模块规格开发，完成后同步 spec.md、tasks.md、checklist.md 与 README。
- 核心、配置、provider 不依赖 CLI 或 UI；shared 保持基础模块。使用 npm run check:boundaries 检查循环和违规导入。
- 用户、项目、环境变量与 CLI 配置按已知字段合并；错误消息不回显密钥或敏感源文本。
- 真实 API 密钥不进入代码、配置样例、测试、日志或会话。默认测试使用模拟 provider 与临时目录，不调用收费模型服务。
- 新执行能力统一走工具和权限入口；模型/文件/MCP 返回内容不能提升权限。
- 编写覆盖实际行为、错误和边界的测试；用 npm run check 验证代码变更。更改打包或 CLI 入口时补 npm run test:package。
- 测试与打包临时目录由程序创建，删除前验证归属，不能清理用户项目或未归属的工作树。
- 记录实际运行的平台、检查结果与测量条件，不将未运行的 CI 或未来模块写成已完成。
