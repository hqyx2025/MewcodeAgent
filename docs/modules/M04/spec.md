# M04：Agent Loop 与模型工具调用规格

状态：已完成（2026-10-06，Windows Node 24.14.0本地验收；Windows/Linux Node24 CI通过）。

## 目标

`run` 命令把统一模型流、M03 工具注册表和 `ToolExecutor` 组成有界循环：模型返回完整且成功结束的工具参数后才执行；工具结果带原 `callId` 回填下一轮；模型结束为纯文本时报告完成。Chat Completions、Responses 和 Anthropic 都映射到同一内部消息/事件协议。

## 内部协议

- `LLMMessage` 支持 `system/user/assistant/tool`，助手消息可带 `toolCalls`；工具消息必须带 `callId`。
- `tool_call_delta` 按 index 组装名称、callId 与 JSON 参数；最多 16 个调用、256 KiB 参数、10,000 个流事件。ID、名称、JSON 对象和结束原因均校验。
- 只有 `finish: tool_calls` 且所有调用完整时执行。`length`、断流、错误或畸形分片不执行任何待处理调用。
- Responses `store:false`；工具轮回传 function call/output 以及不透明 reasoning item（含 `encrypted_content`），避免无状态 GPT-5 推理上下文丢失。引用：[OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling/)、[reasoning](https://developers.openai.com/api/docs/guides/reasoning/)。
- Anthropic `tool_use/tool_result` 转换为同一内部调用；thinking/signature 只作为不透明上下文保存，不向终端输出。

## Agent Loop 行为

- `maxTurns` 默认沿用配置（20），单任务默认 200,000 累计 token（真实 usage 优先；缺失时明确标记估算），上下文 200,000 字符，总时限沿用配置。
- 工具串行执行，保证后一个调用能看到前一个版本/结果；跨轮重复 callId 拒绝。连续 3 个失败停止并报告 `repeated_failures`。
- Plan 模式只向模型暴露 read 工具，执行器仍二次校验；default 写入与 shell 审批；非 TTY 审批自动拒绝。取消或超时保留已提交写入，不执行取消时尚未开始的调用。
- `run --json` 输出 JSONL 事件；普通模式文本写 stdout，工具和审批状态写 stderr。`chat` 行为不变。

## 安全与边界

模型、工具和文件内容不能提升权限；所有动作必须经过 M03 执行器。模型工具定义使用非 strict JSON Schema 以兼容国内 OpenAI 兼容服务，真实参数仍由 Zod 校验。Anthropic 适配器已实现离线协议回归，但未在本模块自动调用付费服务。

## 演示

```powershell
npm run dev -- --provider mock --model mock-v1 --mode plan run "查看项目入口" --json
npm run agent -- "修复一个小 bug 并运行测试"
```

需要写入或 shell 时，TTY 每次逐调用询问 `y/N`；管道/非交互环境拒绝需要审批的动作。`--max-turns`、`--max-total-tokens`、`--timeout-ms` 可进一步收紧预算。

## 非目标

本模块不做持久会话恢复、自动上下文压缩、MCP、并发子 Agent、长期记忆或自动批准；它们分别留给后续模块。
