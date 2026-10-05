# M01：基础工程规格

状态：已实现并完成本地验收。用户已确认继续按 TypeScript + Node.js 方案开发。

## 目标与边界

交付可安装的 ESM CLI、严格 TypeScript 工程、配置加载与校验、基础错误/事件/模型契约、确定性 MockProvider，以及类型/lint/格式/模块边界/测试/构建检查。

本模块不接真实模型、不实现 Ink 多轮对话、工具执行或 Agent Loop。Ink、React 和 SDK 先核对元数据，实际依赖在对应模块引入。

## 命令

- `mewcode --help`、`mewcode --version`：不加载配置或读取凭据，即使配置损坏也可以查看。
- `mewcode config [--json]`：校验配置、输出有效设置、路径和来源层。不读取密钥值。
- `mewcode demo [prompt]`：始终使用 MockProvider，流式输出中文，不访问网络、不修改项目文件。
- 无子命令：展示帮助；未知选项/命令：非零退出。
- `--cwd` 确定项目目录；`--config` 替代项目内默认配置文件，显式缺失时报错。
- `--provider`、`--model`、`--mode`、`--base-url`、`--api-key-env`、`--storage-dir`、`--log-file` 覆盖配置字段。

## 配置规则

覆盖顺序：内置默认 → 用户配置 → 项目配置 → 环境变量 → CLI字段覆盖。对象按已知字段合并，不整块覆盖其他字段；每个来源单独校验，再校验合并结果。

默认用户文件 `~/.mewcode/config.yaml`；项目文件 `<cwd>/.mewcode/config.yaml`。环境变量 `MEWCODE_HOME` 可指定用户配置/默认存储目录。缺少可选文件使用默认值，显式配置文件缺失报错。

支持 `provider.kind/model/baseUrl/apiKeyEnv`、`mode`、`limits.maxTurns/timeoutMs/maxOutputTokens`、`storage.directory/logFile`。未知字段报错；限制字段必须为范围内正整数；真实模型需显式指定非 `mock-v1` 的名称。M01允许查看真实模型配置，不要求密钥存在，因为不会访问模型服务。

环境变量：`MEWCODE_PROVIDER`、`MEWCODE_MODEL`、`MEWCODE_BASE_URL`、`MEWCODE_API_KEY_ENV`、`MEWCODE_MODE`、`MEWCODE_MAX_TURNS`、`MEWCODE_TIMEOUT_MS`、`MEWCODE_MAX_OUTPUT_TOKENS`、`MEWCODE_STORAGE_DIR`、`MEWCODE_LOG_FILE`。空字符串不静默当成默认值。

路径统一基于真实 `cwd` 解析，支持中文与空格；默认日志路径 `<storageDirectory>/logs/mewcode.log`。M01只解析这些路径，不创建存储目录、不写日志文件。

## 错误与数据边界

错误使用稳定code；配置错误指出字段，不回显输入值。YAML解析错误只输出位置，不展示源文本。配置文件最大256 KiB，使用JSON_SCHEMA，不允许自定义可执行标签。baseUrl不允许URL凭据、查询串或片段；API密钥只通过变量名引用。

取消模拟流抛出CANCELLED，CLI退出码130；其他执行错误退出码1。UTF-8输出与Unicode分片不拆开代理对。Mock usage是确定性估算，不表示真实模型费用或分词结果。

## 依赖与验收

Node.js24、npm11环境；TypeScript5.9、Commander、Zod、js-yaml；tsx/tsup、Vitest、ESLint、Prettier与dependency-cruiser。版本以package.json和package-lock.json为准。

必须通过配置覆盖/拒绝无效数据/脱敏、中文路径、模型流顺序/取消、CLI退出行为、编译产物与临时目录安装测试。CI配置Windows/Linux Node24；本地记录实际执行环境，不把尚未运行的云端CI写成已通过。

性能先记录帮助、离线演示的启动基线与产物大小。帮助路径延迟加载配置/provider；后续不把UI/模型SDK加入帮助启动路径。

## 已锁定的依赖与后续兼容性

直接运行依赖：Commander15.0.0、Zod4.6.5、js-yaml5.4.2。开发检查使用TypeScript5.9.3、tsx4.23.15、tsup8.5.1、Vitest5.0.3、ESLint10.12.0、Prettier3.9.9和dependency-cruiser18.5.0。

2026-10-05核对registry元数据：Ink8.0.0要求Node≥22和React≥19.3，React当前稳定版19.3.0；openai7.28.0要求Node≥22并兼容Zod4，Anthropic SDK0.131.0与MCP SDK1.32.1也接受Zod4。以上UI/SDK尚未安装或实际验证，M02/M04/M07引入时重新核对。

构建依赖通过overrides锁定esbuild0.28.2，修复审计发现的Windows开发服务文件读取问题；tsup/Vite的上游范围仍在0.27系列，升级相关依赖时需重新评估并移除不再必要的override。当前构建与测试实际验证该版本组合，npm audit结果另见验收记录。
