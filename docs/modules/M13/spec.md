# M13 SubAgent 规格

状态：本地完整检查、独立安装包与延迟基准通过；Windows/Linux CI待推送后核对。

## 目标与入口

显式开启后允许父 Agent 使用 `Task` 同时委派最多4个独立只读任务。每个孩子有独立 provider 实例、消息历史、工具调用编号集合和可信 `agentId`。只向父任务返回任务状态、必要摘要、核验后的文件引用及用量；不回传完整子历史。

```powershell
npm run dev -- --provider mock --model mock-v1 --subagents --mode plan run "检查目录" --json
npm run dev -- --provider mock --model mock-v1 delegate --tasks-file tasks.json --json
npm run dev -- --subagents prompt --json
```

`delegate` 表示用户明确开启本次委派，任务文件必须是项目内可读的UTF-8 JSON且不超过32KiB。`prompt`只检查工具元数据，不调用模型。Mock只演示目录列表和协议，不分析任意用户任务。真实provider复用既有服务配置，默认开发/验收使用模拟服务。

任务文件与模型 `Task` 参数使用同一严格Schema：

```json
{
  "tasks": [
    {
      "id": "explore-core",
      "goal": "检查 core 的预算和停止条件，输出必要摘要",
      "context": "只关注任务生命周期",
      "tools": ["ReadFile", "Glob", "Grep"]
    },
    {
      "id": "explore-tools",
      "goal": "检查工具入口，列出权限校验位置",
      "tools": ["ReadFile", "Glob", "Grep"]
    }
  ]
}
```

id为小写字母开头的字母/数字/横线，最多24字符；goal最多2048字符，context最多4096字符；工具最多3个且不能重复。context默认为空，tools默认三个只读工具。可选 `retryOf` 必须指向当前池内已经 failed/cancelled/budget_exhausted 的任务，同时使用全新id；成功任务、运行任务和恢复时状态不明的任务不能如此重试。

## 配置与预算

默认关闭。用户配置的 `subagents.enabled: true` 或 CLI `--subagents` 为可信开启来源；项目配置只能关闭或收紧用户已有数值上限，不能自行开启/扩大并发或额外模型调用。CLI的显式开启可以覆盖项目关闭项；数值仍沿用合并后的限额。

| 字段 | 默认 | 有效范围/含义 |
| --- | ---: | --- |
| concurrency | 2 | 1–4，池级FIFO并发 |
| maxTasks | 8 | 1–32，整个池的唯一任务数，拒绝后的已消费id也计入 |
| timeoutMs | 30000 | 1–120000，包含排队时间，不超过父时限 |
| maxTurns | 6 | 1–12，不超过父轮数上限 |
| maxTotalTokens | 60000 | 1024–200000，所有子任务共用的token账本 |
| maxOutputTokens | 2048 | 128–8192，不超过父单轮输出上限 |
| resultBytes | 4096 | 512–8192，每个结构化结果的字节上限 |

父/子模型请求共享父账本；孩子还共用子任务账本。每个请求启动前原子预留保守输入估算加输出上限，无余额则不启动模型流。服务报告usage时按实际input+output记账；正常结束但无usage时按输入估算及实际输出字节保守估算；失败/取消且无usage时按整个预留记账。预留尚未启动就被取消则释放，不计请求。

输入估算沿用M08的一字节/token与协议开销。服务报告超出预留时记录真实超额，阻止后续请求，不隐藏超额。账本控制请求准入，不能保证第三方服务遵守输出上限，也不是精确货币限额；没有引入服务定价或实付费用统计。

父检查点和finish的totalTokens含父、子模型与父汇总请求；恢复按已保存总量继承余额。子任务账本恢复时保守地将旧父子总量作为已消费量，避免旧格式无法区分子用量而扩大余额；因此长父历史可能使新委派提前耗尽预算。

持久会话在Task执行前记录pendingSubagentTokens（不超过子池上限与父剩余余额）。结果完成的检查点移除此项；如果进程在委派中崩溃，恢复把该保守额度加入totalTokens并标记estimated，避免未知子请求费用被重置为零。可能多记未发起或尚未报告的请求；新旧历史格式都不能恢复第三方服务的精确计费。

## 权限与生命周期

孩子固定Plan模式、深度1。执行器白名单仅允许任务指定的ReadFile/Glob/Grep；父白名单/deny/ask/路径策略动态继承，不能由工具结果或模型参数放宽。即使伪造WriteFile、Bash、MCP、SkillRead、Task调用也会被执行器拒绝。子执行器不继承父会话审批授权，遇到需审批的读请求默认拒绝。

子任务继承项目指令的读取边界和父Hook配置。Plan禁止脚本；必需的安全Hook因此可能阻止孩子启动，不能为提高成功率绕过。权限、Hook、工具结果及Agent事件包含执行器产生的agentId；模型不能通过参数覆盖身份。

FIFO队列支持多批提交；父调用取消传给排队和运行任务，排队取消立即移除，运行模型/工具收到同一取消信号。每个任务的deadline从入队计算。单个失败保留其他结果，任务结束后释放计时器与监听器、丢弃子历史和provider引用。provider必须遵守现有AbortSignal契约；本模块不引入进程隔离或不响应取消的第三方代码强制终止。

## 结果与证据

孩子最终响应必须是严格JSON `{summary,evidence}`，summary不超过4096字符，最多16条证据；不接受Markdown围栏、额外字段或普通文本。证据字段为path、可选正整数line、可选note。模型返回的文件引用要经过运行时观察记录核验：

- ReadFile：成功结果的相对路径/revision及实际返回文本中的行号，不能使用endLine推断未返回的截断行；revision变化时清除旧行记录。
- Grep：成功匹配的相对路径/行号，不保存匹配正文。
- Glob：实际列出的路径，只证明目录列表，不能附行号。

核验记录最多128路径、按估算64KiB元数据上限；超限明确标记EVIDENCE_LIMIT，不接受未记录的证据。read/match/listing标明观察类型，read可带revision。核验只证明工具曾观察到相应位置，不证明摘要语义正确、文件仍未改变或源代码结论有效。

每个结果保留id、agentId、status、code、tokens、estimated、summary、evidence、omittedEvidence、truncated。终态为completed/failed/cancelled/budget_exhausted/rejected。参数、模型错误、失败响应不回显原始源文本；已知凭据和常见密钥模式在输入中拒绝转发，最终摘要/note脱敏，含敏感值的引用路径省略。

按字节减少证据和缩短摘要，始终保留所有任务状态与用量，保持有效JSON。批汇总还计算外层ToolResult JSON转义和最大callId空间，保证适配父toolResultBytes；启用时该预算至少2048 bytes。ToolResult仅使用content，避免重复data放大结果。

## 恢复与后续边界

任务id一经消费就不能重复提交，重复不再请求模型。父检查点独立保存最多32个subagentIds，压缩后仍保留；历史中不确定的Task调用也用于恢复防重。恢复不重放同id任务。子历史、状态和retryOf关系不独立持久化；如需重新检查，明确使用新id提交新任务。

当前仅只读协作；写入子任务、Worktree生命周期属于M14，长期Teams/消息队列属于M15。并发收益取决于任务独立性和模型/工具延迟；真实模型质量、费用和速度需后续在独立授权环境测量。
