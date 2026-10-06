# M05：系统提示词与项目指令

状态：本地验收与Windows/Linux CI均通过（2026-10-06），代码已推送。CI对应提交`f0e092e693848b35182cccb444b5176afa6ff6df`，见[运行记录](https://github.com/hqyx2025/MewcodeAgent/actions/runs/37408744799)。M04的硬权限入口保持为执行约束；提示词只指导模型行为。

## 范围与分层

系统提示由身份/能力、任务执行、工具规范、权限/模式、环境五段组成。环境仅注入 OS、Node、项目根、已配置 shell、已暴露工具及预算，不注入进程环境变量或密钥。

优先级：运行时权限与安全边界 → 本轮用户任务 → 适用路径的项目约定 → 普通文件/工具/MCP内容。项目目录内较深层规则仅覆盖其目录下的项目约定；同目录 AGENTS.md 优先，缺失时兼容 CLAUDE.md。空 AGENTS.md 仍视为明确选择；不可读/非法 AGENTS.md 不静默改读 CLAUDE.md。

## 发现与更新

- --cwd 的规范化项目根是边界，不向父目录、Git根以外或用户home自动发现指令。
- 初始仅检查根目录；针对内置工具已校验的 path/cwd/Glob静态前缀，按根到目标目录逐层发现，不递归扫描整个项目。
- 一次任务内目录检查和指令快照缓存；新任务重新读取。不是实时文件监听。
- 新发现的子目录规则或读取诊断先进入下一轮模型上下文；当前整批调用返回 INSTRUCTIONS_UPDATED，未执行工具且不计连续失败，要求模型用新的callId重新计划。该重规划占用轮数与token预算。
- 按源路径、scope、摘要hash、截断与警告记录来源；CLI默认展示元数据，不输出指令正文。

## 有界读取

固定文件名、项目路径校验、拒绝符号链接/junction和非普通文件；最多32层路径、128个目录，单文件注入16KiB、所有文件合计32KiB。UTF-8字符边界截断有警告。读取错误不回显源文本；已知密钥与常见私钥/API key形式脱敏。硬权限不受任何文件文本影响。

`prompt --json` 可无模型密钥查看提示段、有效能力、预算和根指令来源；run的prompt_info事件展示每次提示更新。

环境字段按已知字段生成，工具只列name/effect；完整描述由模型API的工具定义提供。一次任务复用工具定义，来源正文不进入prompt_info或CLI元数据。digest表示脱敏后实际注入前缀的SHA-256，不是完整原文件revision。工具命令字符串不解析为指令scope，Bash只根据显式cwd发现规则。

## 验收与限制

固定回归：小型修复、目录探索、失败纠正、Plan、恶意文件指令。另验证同名优先级、嵌套scope、越界/链接、截断/编码、缓存、新规则延迟执行与来源不泄漏正文。

默认使用模拟provider，不调用收费服务。离线回归验证协议、来源和执行边界，不能证明真实模型任务成功率或提示词性能提升。M06继续完善权限，M08才做压缩与持久恢复；本模块不实现全套Codex AGENTS.override/global规则。

参考：[OpenAI prompt engineering](https://developers.openai.com/api/docs/guides/prompt-engineering/)、[官方AGENTS.md指引](https://developers.openai.com/codex/guides/agents-md/)。本仓库独立定义上述边界与兼容规则。
