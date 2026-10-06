# M12 Hook 系统规格

本模块落实公开介绍中的Hook生命周期扩展；网页未公开实现协议，以下JSON、限额和失败策略是本仓库的设计。以本地主机配置为来源，Hook不能由模型、Skill、文件正文或MCP返回动态注册。

## 配置与执行

用户、项目、CLI配置中的 `hooks` 数组按来源顺序追加；合并后最多32个、id全局唯一。同名不覆盖，未知字段报错。每项含 `id`、`event`、`script`，可选 `tool`（仅工具事件，精确匹配工具名称）、`timeoutMs`（默认5000，1–60000）、`env`（最多16个环境变量名称，不接受值，禁止NODE_*和执行程序搜索设置）。缺失显式变量阻止本次Hook。

脚本是项目根内最多64KiB的UTF-8 Node ESM文本；相对路径始终基于项目根，用户配置也遵守此规则。禁止链接、junction、硬链接、凭据/内部路径及别名；脚本读取必须由ReadFile策略直接允许。内部隐藏工具 `HookScript` 按shell效果审批，同时遵守Bash的deny与父策略；Plan禁止所有脚本。脚本可以执行任意主机操作，审批不等于沙箱，无法可信地声明一个任意脚本“只读”。accept-edits不自动授权Hook。

审批展示脚本路径、SHA256和显式变量名称；指纹包含源代码、脱敏事件stdin、环境和Node执行文件。审批后复核脚本摘要与权限，通过固定Node启动器从管道读取批准的源代码快照，作为data URL模块执行，避免Windows命令行长度限制和路径替换执行不同代码。支持node:内置模块；相对导入与包名导入不可用，需要绝对file URL显式导入。import.meta.url是data URL，不能用于定位脚本文件；资源路径以process.cwd()为项目根。脚本不允许自动授权后续工具；更新输入重新走原工具全部校验、目标prepare、权限与审批。

stdin是单个UTF-8 JSON（最多64KiB）加换行：`version:1`、`event`、唯一 `eventId`、执行器所属 `sessionId`、`mode`；PreToolUse额外传tool的callId/name/input，PostToolUse只传编号、名称、成功与错误码；生命周期传有限reason。不传对话、模型配置、项目正文、工具结果正文。已知凭据与显式变量值在字符串字段脱敏。子进程继承现有主机基础环境白名单，业务变量仅从env名单取得，总环境JSON最多32KiB，不继承NODE_OPTIONS，不自动继承模型密钥；显式env名单始终需要脚本审批。

stdout必须且仅为JSON：`{"decision":"continue"}` 或 `{"decision":"block"}`；仅PreToolUse的continue可附 `updatedInput` 对象，替换整个工具输入；多钩子按配置顺序，后者看到前者改参。拒绝未知字段、非法事件改参及额外输出。stdout/stderr合计最多16KiB，非零退出、超时、取消、格式/环境/权限失败都记录固定错误码；错误不回显脚本输出或源代码；改参含已知凭据或任何配置Hook显式变量的值时拒绝返回（短值按整字符串匹配，避免破坏普通文本）。

## 触发、顺序和失败

| 事件 | 时机 | 失败/阻止策略 |
| --- | --- | --- |
| SessionStart | Agent开始/恢复，MCP启动、发现项目指令和首次模型请求前 | 阻止本次任务，不请求模型 |
| PreToolUse | 有效请求、初步deny检查后，实际工具校验/授权前 | 阻止工具；改参重新校验与授权 |
| PostToolUse | 实际工具执行器返回成功或错误后 | 审计通知失败，保留工具真实结果；不修改结果、不回滚 |
| Stop | Agent准备输出finish和提交最终检查点前 | 阻止成功/预算停止声明，保存stopped检查点；不自动增加模型轮次 |
| SessionEnd | Agent清理，正常/错误/取消/消费者提前停止 | 尽力通知；取消状态不再启动脚本，只记录取消诊断 |

run触发全部事件；独立tool与mcp命令触发Pre/Post；chat、prompt、skills、commands、config和hooks查看不执行脚本，chat的/run进入Agent后触发。已有完整检查点恢复仍触发Start/Stop/End，不重放原工具。工具原始Schema失败或初步策略deny时不运行Hook；Pre失败没有Post。后续目标准备失败仍有Post。隐藏脚本调用不再次触发钩子，直接调用HookScript拒绝。

同一执行器工具事务FIFO串行（Pre→实际工具→Post），最多8个等待/执行请求；排队、审批、Hook和工具共享调用总时限。取消排队不越过前序请求。不同执行器具有不同sessionId；同一实例多次run沿用sessionId，eventId逐事件唯一；不声称这是持久会话ID。任务之间无共享可变决策或事件缓存。

## 审计、限额和边界

每次实际匹配记录时间戳、Hook id、事件/归属、mode、sequence、outcome、固定code、包含审批等待的durationMs，不记录输入输出、环境值或正文。最多10000条；原权限审计仍记录脚本及工具的授权。`run --json` 输出hook事件；`--audit-file`在同一新建JSONL文件写权限与Hook记录，Hook记录可由event字段识别。安全事件审计写入失败阻止动作；通知事件失败保留真实结果。

M12首版仅本地Node脚本，不提供外部shell命令、HTTP Hook、常驻进程、后台并行、脚本权限沙箱或写入回滚。默认配置为空，不启动子进程；有配置时必须执行必要校验，不能用缓存跳过审批。基准记录事件次数、脚本启动次数与总延迟，使用临时目录和模拟审批，不访问模型。
