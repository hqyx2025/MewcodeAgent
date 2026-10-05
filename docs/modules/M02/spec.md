# M02：流式模型对话与终端界面

状态：本地验收完成（2026-10-06，Asia/Shanghai）。用户授权继续开发并将仓库变更提交、推送；交付结果以Git历史和远程分支为准。

## 目标

实现Ink交互界面、多轮会话、OpenAI兼容Chat Completions/Responses流式适配器、单次/管道纯文本模式、取消、超时和安全错误。保留无需密钥的Mock模式。工具调用与Agent Loop仍在M03/M04，不在本模块执行模型请求的工具。

## 命令与界面

- `mewcode chat`：stdin/stdout均为TTY时启动Ink多轮界面；否则读取stdin作为一条提示词。
- `mewcode chat "问题"`：单次纯文本流式输出，可用于脚本和检查。
- `echo "问题" | mewcode chat`：读取有界UTF-8输入，stdout只包含回答；错误与截断说明走stderr。
- 默认provider为Mock；真实服务通过原有provider/model/baseUrl/apiKeyEnv配置启用。
- Enter发送，Backspace删除完整字素，Esc取消当前回答，Ctrl+C退出。生成中不启动重叠请求。
- UI展示模型、已完成对话、当前输出和状态；增量文本按约30ms合并，结束时刷新完整结果。

## 协议与会话

统一LLMEvent包含文本、usage与正常/长度结束；HTTP或协议错误转换为稳定错误码。成功轮次将user/assistant成对提交；失败或取消的轮次仅在UI展示，不把残缺内容提交给下一轮模型。空回答可正常结束；流缺少结束原因、工具请求、内容过滤或畸形数据应明确报错。

会话级deadline覆盖整个请求及重试；初版限制40条历史消息、100000个上下文字符和200000个输出字符，达到限制明确要求重新开始，不静默删除消息。完整token压缩在M08实现。

首个provider使用openai SDK，可配置baseURL，默认关闭SDK重试。仅在收到首个流事件之前，对网络、429和5xx做最多一次有界退避重试；输出开始后不重试。401/403、参数错误、协议错误不重试。密钥只在创建真实provider时解析；config/help/demo均不读取密钥值。

`provider.wireApi`可选择`chat-completions`（默认）或`responses`。Chat Completions可选择`max_tokens`或`max_completion_tokens`，可关闭`stream_options.include_usage`；Responses发送`max_output_tokens`且固定`store:false`，通过客户端历史传递上下文。模型名由用户提供，不内置收费模型默认值。Anthropic配置暂返回明确的未支持提示，按M04后路线接入。

## 安全与验收

模型返回数据只能作为文本，无文件或命令执行。终端展示过滤ANSI/控制序列；供应商错误响应、Authorization和密钥值不输出到用户错误。测试使用本机HTTP/SSE模拟服务与虚构密钥，不调用收费服务。

覆盖中文、空文本、多轮上下文、请求取消、并发保护、超时、401/429/5xx、半途断流、输出截断、重试边界、UI输入与状态、管道输入、帮助懒加载、独立安装。

## 官方文档依据

[OpenAI官方流式响应文档](https://developers.openai.com/api/docs/guides/streaming-responses/)已读取，明确两种协议的SSE分片与异步迭代方式；Responses处理output_text.delta、completed、incomplete、failed与error。[GPT-5.5模型文档](https://developers.openai.com/api/docs/models/gpt-5.5)已核对。实际服务商可能使用自己的模型别名，接口字段同时依据已安装SDK类型核对。

用户指定doufuapi.com/v1、gpt-5.5、Responses和禁止响应存储。供应商配置及密钥只保存本地忽略文件；实际试连结果在验收记录中更新。用户提供的Codex专用字段review_model、goals等不转换为本项目功能。
