# 技术问答与代码定位

回答围绕当前实现，展开时先讲触发条件、执行路径，再讲边界。参考[讲解稿](project-story.md)和[架构图](architecture-and-decisions.md)，不需要披露模型内部思维链。

## 1. Coding Agent与普通聊天有什么区别？

普通chat组织文本历史和流式UI。run在模型请求工具时执行真实操作，回填callId关联的结构化结果，直到正常结束、预算耗尽或错误。任务是否做对要看文件diff和真实检查，completed仅是引擎正常协议结束。代码：[conversation](../../../src/core/conversation.ts)、[Agent Loop](../../../src/core/agent-loop.ts)；演示：[固定修复](demo-guide.md)。

## 2. 为什么不直接执行模型输出的Shell？

参数分片可能未完整、截断或违反Schema，文本也不构成用户授权。调用先通过ToolCallBuffer及批次验证，再进入执行器的路径、模式、规则、审批和审计。模型、文件或MCP返回不能改权限。授权后的Shell仍具备当前用户主机权限，路径与cwd不是OS沙箱。代码：[tool-calls](../../../src/providers/tool-calls.ts)、[executor](../../../src/tools/executor.ts)；测试：[坏调用整批拒绝](../../../tests/integration/agent-loop.test.ts)。

## 3. 多种模型协议如何统一？

provider把Chat Completions、Responses和Anthropic流转换为统一LLMEvent与内部消息/工具调用类型，包括文本、参数分片、usage和finish。引擎无需依赖UI或具体SDK事件。协议测试覆盖转换、分片和错误；兼容端点是否提供tool calling和usage需实际核对，不能只看“OpenAI兼容”。代码：[types](../../../src/providers/types.ts)、[openai-compatible](../../../src/providers/openai-compatible.ts)、[anthropic](../../../src/providers/anthropic.ts)；证据：[provider-tools](../../../tests/integration/provider-tools.test.ts)、[responses](../../../tests/integration/responses.test.ts)。

## 4. 什么情况下停止？失败之后都会重试吗？

正常文本结束、模型截断、轮数/token预算、连续失败都有明确结束原因；超时、取消、协议错误走分类错误。连续三次工具失败默认停止，工具失败可回填让模型纠错。provider只在首个流事件前对可重试网络/429/5xx有限重试；工具或外部副作用不自动重放，已经输出后也不拼接重试答案。证据：[循环](../../../tests/integration/agent-loop.test.ts)、[供应商网络测试](../../../tests/integration/openai-compatible.test.ts)。

## 5. 为什么Plan要检查两次？

只暴露读工具让模型减少误调用；执行器再限制能力是强制边界，覆盖模型仍请求WriteFile、直接CLI调用或子任务。子执行器继承父deny与模式，父权限收紧继续生效。审批不能覆盖deny。证据：[Plan实际拒绝](../../../tests/integration/agent-loop.test.ts)、[权限继承](../../../tests/unit/permissions.test.ts)。

## 6. “本次允许”和“session允许”怎么区分？

once只批准本次。session在当前执行器进程中缓存规范参数、路径、预览、Shell及权限谱系对应的指纹；参数变化、模式变化或父权限收紧不会沿用旧批准。它不跨进程永久授权。审批等待时不能切模式，审批取消/超时不执行。证据：[精确审批与竞态测试](../../../tests/unit/permissions.test.ts)、[executor](../../../src/tools/executor.ts)。

## 7. 怎么防止覆盖别人刚改过的文件？

ReadFile返回内容revision，EditFile和覆盖WriteFile要求expectedRevision。准备与写入时核对当前文件，唯一替换遇到重复匹配拒绝；写入使用原子替换。它减少并发误覆盖，仍是单文件策略，不能保证多文件事务或对任意外部竞态完全隔离。证据：[文件工具与冲突测试](../../../tests/unit/tools-files.test.ts)、[files](../../../src/tools/files.ts)。

## 8. 上下文压缩是不是模型摘要？会不会丢信息？

当前是本地结构化摘录，没有额外模型请求。预算保留系统提示、目标和最近完整tool call/result组，归档指纹覆盖完整历史；长结果可溢写并返回摘要索引。细节会省略，指纹证明历史身份而非语义保留。窗口计量是有标识的估算；查看检查点和溢写结果才能取回细节。证据：[context](../../../src/core/context.ts)、[压缩边界测试](../../../tests/unit/context.test.ts)、[M16测量](../M16/checklist.md)。

## 9. 为什么会话恢复不能承诺exactly-once？

JSONL检查点保存意图、结果和动作指纹，恢复阻止已记录callId和相同修改参数重放。Shell/MCP成功与日志落盘之间仍可能崩溃，外部动作没有参与本地原子事务。不确定时保留状态、核验外部结果，再明确恢复/重试。证据：[session](../../../src/core/session.ts)、[存储崩溃测试](../../../tests/integration/session-store.test.ts)、[长会话评估](../../../tests/support/release-evaluation.ts)。

## 10. 记忆、Skill和MCP有什么区别？

记忆是用户确认的有界Markdown偏好/项目事实，按预算筛选；Skill是按需加载的指令与目录内资源；MCP是外部服务工具，需授权启动/连接及调用。Skill附带脚本通过工具执行，记忆和指令不能提升权限。当前没有向量数据库、自动接受敏感记忆、MCP sampling或服务端权限提升。代码：[memory](../../../src/core/memory.ts)、[skills](../../../src/core/skills.ts)、[MCP manager](../../../src/mcp/manager.ts)。

## 11. Hook如何避免修改参数后绕过授权？

PreToolUse的updatedInput替换整个输入，随后重新校验Schema、路径、准备操作与授权；脚本本身也要Shell批准，Plan禁止。安全Hook错误默认阻止对应动作，通知错误不能改写已执行结果。快照脚本、事件顺序与审计有边界测试。代码：[hooks](../../../src/tools/hooks.ts)、[executor](../../../src/tools/executor.ts)；证据：[hooks](../../../tests/integration/hooks.test.ts)。

## 12. 为什么工作树不是沙箱？为何不自动合并？

Git Worktree隔离文件工作目录，但对象/refs共享，任意批准Shell仍能访问主机。文件工具根及Shell cwd绑定归属工作树，并继承父策略；不自动安装依赖、合并或force回收。diff、真实Bash检查和同名变更路径让用户审阅；脏目录阻止回收，正常回收保留分支。证据：[worktrees](../../../src/tools/worktrees.ts)、[worktree任务](../../../tests/integration/worktree-tasks.test.ts)、[Teams](../../../tests/integration/teams.test.ts)。

## 13. 多Agent是不是越多越快？预算如何共享？

FIFO池限并发、任务数、深度和时间，父子共享TokenBudget；开始请求前预留，usage回来再结算，缺失usage保守估计，父汇总成本也计入。Teams同成员串行、依赖失败blocked、消息不自动触发新任务。独立大任务可能缩短墙钟时间，但额外模型与汇总会增加用量，真实速度/费用收益尚未评估。代码：[budget](../../../src/core/token-budget.ts)、[pool](../../../src/core/subagents.ts)、[teams](../../../src/core/teams.ts)。

## 14. 哪次优化有数据依据？

压缩原先先格式化全部历史再截断，M16改成只格式化展示预算内的摘录，仍计算完整归档指纹。同一100轮内存场景、各5样本、Windows本地自然缓存，中位数2.74ms变为1.91ms，前后都是822380/41976 bytes。只说明本地压缩CPU成本，不说明真实模型端到端提速。代码：[context](../../../src/core/context.ts)；条件与版本：[M16记录](../M16/checklist.md)。

## 15. 脚本化provider测试有多大价值？下一步怎么评估？

它能可靠复现参数错误、工具失败、取消、恢复与跨平台进程问题；真实文件内容、Node退出码、归属和账本提供可验证结果。它不能评估模型是否能自己找到bug。真实评估需要先明确授权模型费用，固定任务仓库与提交、模型/协议/参数、多次运行和独立判定，记录成功/失败及用量；这只是下一步方案，本轮没有执行。证据：[评估夹具](../../../tests/support/release-evaluation.ts)、[M16验收](../M16/checklist.md)。

## 16. 当前有哪些交付限制？

三平台自动化和独立安装包通过，但正式发布未执行；standardwebhooks包级许可需澄清，人工终端体验和真实模型任务质量仍待验证。tgz传递依赖范围由安装端npm解析，源码npm ci才使用当前锁文件完全复现。可以先以源码、离线演示和实际结果展示工程设计。来源：[发布指南](../M16/release-guide.md)、[三平台结果](../M16/checklist.md)。
