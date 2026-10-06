# M04 任务

- [x] 扩展统一消息、工具定义、工具结果和流事件类型。
- [x] 实现有界工具参数缓冲区，拒绝坏 ID、重复 ID、坏 JSON、过大参数和结束后事件。
- [x] 接入 Chat Completions 分片及 `tool_call_id` 结果回填。
- [x] 接入 Responses function call、`store:false`、reasoning encrypted content 和 function call output。
- [x] 接入 Anthropic `tool_use/tool_result`、流式 JSON 和 usage 转换。
- [x] 实现 AgentLoop：串行调用、失败纠正、重复失败停止、上下文/轮数/token/时限预算、取消。
- [x] Plan 只读工具暴露与执行器二次检查；增加逐调用 TTY 审批和非 TTY 拒绝。
- [x] 增加 `run` CLI、JSONL 事件和离线 Mock 闭环。
- [x] 增加确定性临时项目回归并更新安装冒烟。
- [x] 本地 `npm run check`、`npm run test:package` 与 `npm run bench:agent` 验证。
- [x] 用户 gpt-5.5 Responses 服务临时目录只读工具冒烟。
- [x] 推送并核对 Windows/Linux GitHub Actions；代码提交 `c5ed520` 的[CI](https://github.com/hqyx2025/MewcodeAgent/actions/runs/37405545914)全部通过。
