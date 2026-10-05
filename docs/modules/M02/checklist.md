# M02：验收清单

状态：本地验收完成。执行日期：2026-10-06（Asia/Shanghai）。

- [x] 类型/lint/格式/模块边界/测试/构建通过。
- [x] UTF-8流、空回答、usage、停止/截断与协议异常正确。
- [x] 多轮历史正确；失败/取消不提交残缺轮次。
- [x] 401不重试；429/5xx/网络首事件前最多重试一次；输出后不重试。
- [x] 取消和整个请求超时能关闭流并恢复界面。
- [x] Ink支持中文/emoji输入、Enter、Backspace、Esc及Ctrl+C。
- [x] 终端控制序列与供应商敏感错误不直接展示。
- [x] 单次/管道输入纯文本输出与退出码正确。
- [x] 安装包包含所有延迟加载资源；help/version不加载UI/SDK。
- [x] 真实供应商试连状态如实记录。
- [x] 文档与交付范围已更新；提交/推送以Git历史和远程分支为准。

## 检查证据

环境：Windows、Node.js24.14.0、npm11.9.0。默认回归全部使用Mock或本机HTTP/SSE服务与虚构密钥，无收费模型调用。

| 检查 | 实际结果 |
| --- | --- |
| `npm run check` | 类型、ESLint、Prettier、架构边界、78项测试与构建通过 |
| Vitest | 8个测试文件，78项通过，最近代码检查耗时约2.24秒 |
| `npm run test:package` | 中文/空格临时路径、仅生产依赖安装、bin、demo、单次chat、help/version懒加载验证通过 |
| `npm audit --json` | 0个漏洞 |
| Windows终端人工验证 | ConPTY中中文/emoji两轮Mock对话成功，第二轮用量随历史增长；Ctrl+C退出成功 |
| 真实模型冒烟 | doufuapi.com/v1、gpt-5.5、Responses、store:false，短提示得到OK，退出码0，约7.7秒 |
| 云端CI | 已配置Windows/Linux Node24与独立安装检查；本记录仅证明本地Windows验收，远程结果见Actions |

首次推送d9ef171的Linux CI全通过；Windows运行器将文件检出为CRLF，导致Prettier格式检查失败。已增加.gitattributes统一文本检出为LF，并验证启用core.autocrlf的独立检出；修复提交的跨平台结果见后续Actions。

真实试连仅发送短提示及默认对话指令，不发送仓库文件；输出上限256 tokens、总超时60秒。费用未读取账单，不能从调用耗时推断价格。密钥保存在被忽略的.env.local中，供应商配置保存在被忽略的.mewcode/config.yaml中。

## 调优与资源边界

- UI文本增量按约30ms合并，Ink帧率上限30FPS；120个快速模拟分片的回归验证最终文本完整且重绘帧少于120。Windows短定时器存在粒度差异，测试使用5秒等待预算。
- 已完成对话使用Static输出，避免重绘所有历史；界面最多接收200个显示轮次。核心默认最多40条历史消息、100000个上下文字符、200000个输出字符，达到上限明确提示重新开始。
- help/version继续按需加载；安装回归通过Node加载钩子阻止Zod/YAML/Ink/React/OpenAI导入，确认轻量命令不初始化模型或UI。
- M02首次生产安装采样：7次help墙钟中位数40.60ms（最小39.01/最大52.91ms），入口5742 bytes，全部编译JS合计40525 bytes。README更新前npm压缩包39667 bytes、解压136729 bytes；文档变化会改变包大小，此项保留首次M02样本。离线demo单次314.30ms，不包含网络安装时间。
- 网络重试仅在首个原始流事件之前进行一次200ms退避，并受总deadline约束；开始流后不重启请求，避免重复回答。

## 限制与下一步

M02仍是对话助手，不读取/修改项目文件、不执行命令、不执行模型工具请求。会话仅驻留内存，压缩、恢复与跨会话记忆按后续模块推进；limits.maxTurns留给Agent Loop，不代表聊天轮数预算。Anthropic、Linux/macOS人工终端验证尚未完成。M03先实现六个工具和基础权限入口，M04再接入模型工具调用循环。
