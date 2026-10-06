# M04 验收记录

环境：Windows 11 专业版，Node.js 24.14.0，npm 11.9.0。常规回归全部使用模拟 provider、临时中文/空格路径项目。另执行一次用户已配置 gpt-5.5 Responses 服务的受限真实工具冒烟。

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| 搜索→读取→修改→测试→汇报 | 通过 | `tests/integration/agent-loop.test.ts` 临时项目 5 次工具调用 |
| Chat 参数分片和 tool_call_id | 通过 | `tests/integration/provider-tools.test.ts` |
| Responses 工具调用与 reasoning 回传 | 通过 | `store:false`、encrypted reasoning、function output 请求断言 |
| Anthropic tool_use/tool_result | 通过 | 模拟 SSE、thinking/signature 不外泄、缓存 usage |
| 损坏 ID/JSON/结束标记/截断 | 通过 | 不执行待处理调用，安全错误 |
| 工具失败纠正与重复失败停止 | 通过 | 失败结果回填；三次连续失败停止 |
| Plan 权限 | 通过 | 只暴露 ReadFile/Glob/Grep；执行器仍拒绝 WriteFile |
| 预算、取消、超时、并发 | 通过 | 轮数/token/上下文/事件上限及已提交写入保留 |
| 安装后离线 run | 通过 | `scripts/smoke-package.ts` JSONL Plan 演示 |
| TTY逐调用审批与取消 | 通过 | 真实PTY运行临时项目CLI：输入y后确认创建；审批等待时Ctrl+C以130退出且未写入 |

`npm run check` 通过：15 个测试文件，146 个场景通过、1 个 POSIX 场景在 Windows 跳过，共147个场景（M04新增32个）；类型、lint、格式、模块边界及构建均通过。测试总耗时6.87秒、构建203毫秒。

`npm run test:package` 通过：仅安装生产依赖的中文/空格目录，help/version 不加载 SDK/UI，Mock Plan Agent JSONL 闭环通过。安装包98,601字节，编译JS共117,696字节，help七次样本中位数60.47毫秒。本轮 npm install 审计0漏洞。

## 真实服务验证

用户配置的 `gpt-5.5` / `https://doufuapi.com/v1` / Responses：独立临时目录只放 `hello.txt`，要求一次 ReadFile 后返回文件里的固定标记。2轮、1次ReadFile、精确返回内容，服务报告累计输入+输出10,033 token；请求保持 `store:false`。没有读取或上传本仓库源码、配置或密钥。此单次冒烟不代表任意任务的成功率；Anthropic和Chat工具协议仅做模拟回归。

## 基准与调优范围

`npm run bench:agent`：Windows Node24.14.0，100文件，Mock零网络/模型延迟，5次样本；计时范围为两轮模型流、有界Glob与事件消费，不含初始化。中位8.05毫秒（7.01–18.37），8个事件，1次工具调用，请求JSON分别2232/3131字符。

通过异步迭代直接消费事件而不设无界队列，参数组装后一次解析，只回填一份native工具调用/结果，避免重复编号执行。当前保留串行工具；此数据是基线，不宣称未经对照测量的性能提升或真实模型延迟改善。

## 已知限制

token预算依赖服务报告或字符估算，检查在轮间和工具执行前进行；已发出的请求可能超出预算，不是精确费用硬上限。没有持久恢复/自动压缩或并发调度。TTY审批使用readline逐调用确认，非TTY拒绝；更完整的审批交互留给M06。Shell具有主机用户权限，M03限制不构成操作系统沙箱。

跨平台CI：本次提交推送后核对Windows/Linux结果。
