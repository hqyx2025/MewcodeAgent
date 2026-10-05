# M03：工具系统

状态：本地验收完成，2026-10-06。沿用用户授权逐模块实现、验收并推送；远程状态见对应Git历史与Actions。

## 交付与边界

实现ReadFile、WriteFile、EditFile、Glob、Grep、Bash，统一Zod输入、JSON Schema、注册表、执行器及allow/ask/deny入口。新增`tools`查看定义，`tool <名称> --input <JSON>`明确调用；`--approve`仅由CLI用户授权本次操作。模型对话仍无工具能力，Agent Loop在M04接入。

默认模式允许只读工具、写入和shell要求审批；accept-edits允许文件编辑但shell仍需审批；plan拒绝编辑和shell。显式deny优先。审批看到实际规范化路径、参数与变更预览；输入不能改变模式或权限，取消/超时后不会继续执行等待审批的动作。

## 文件与搜索

项目根使用realpath。路径规范化后必须位于根内；拒绝symlink/junction路径、Windows ADS/别名及.git、.env系列、项目本地配置/会话/缓存路径。搜索也排除这些路径及依赖/构建目录，不跟随符号链接。此路径策略约束文件工具，不能约束已授权shell中的任意代码。

ReadFile读取有界UTF-8文本，拒绝二进制、非法UTF-8与超过1MiB文件，返回行号、SHA-256 revision与行区间。覆盖WriteFile/EditFile必须提供读取所得expectedRevision；创建WriteFile不得覆盖已出现文件。EditFile默认唯一精确匹配，可显式replaceAll。审批后重新核对版本，使用同目录独占临时文件和rename写入，保留文件权限并清理临时文件；不创建父目录。

Glob使用Node.js异步目录遍历与无间接依赖的picomatch匹配器，可选隐藏文件与显式ignore模式；支持*、**、?与字符类，不支持括号/花括号展开，结果有数量/字节/100000目录项/64层深度上限。Glob不承诺自动解释所有.gitignore规则。原计划fast-glob引入了braces未修复的递归模式拒绝服务漏洞，已移除该依赖；内置glob没有全局隐藏文件选项，因此改用有界opendir遍历。Grep通过rg的JSON协议执行正则或字面量搜索，保留路径/行号，使用rg原生忽略规则；缺少rg时明确提示安装，不偷偷换用阻塞正则引擎。非法正则、无匹配、进程失败分别处理。

## Shell与资源

Bash保留课程名称，默认Windows PowerShell、Linux/macOS Bash；Windows Bash需用户显式提供Git Bash可执行路径，不默认调用WSL。shell适配器记录实际shell、cwd和退出码，设输出上限、超时及取消；Windows PowerShell绑定kill-on-close Job Object，并使用taskkill清理进程树，POSIX使用进程组。子进程环境按基础系统变量白名单构造，不继承API密钥；显式Git Bash的进程树主要依靠taskkill，脱离父进程的后台程序需单独管理。

shell审批表示授权执行展示的完整命令，它拥有运行用户的主机权限，cwd与环境白名单不是OS沙箱。文件系统检查也无法提供针对恶意主机进程并发替换路径的内核级隔离；版本检查主要防止正常并发编辑丢失。原子覆盖保留POSIX普通权限位，不承诺复制所有者、ACL或扩展属性。

整个调用deadline覆盖准备、审批和执行；长搜索和进程可取消，输出截断明确标识，shell因输出上限被终止返回TOOL_OUTPUT_LIMIT而非假定成功。普通文件读写在阶段边界检查取消，不能强行中断已提交的内核文件系统调用；已提交写入按成功返回，取消不会回滚。写入/命令调用串行保护，同一执行器最多8个活动调用，重复callId被拒绝且最多记录10000个callId。默认测试均在临时中文路径中执行，不调用真实模型或修改用户代码。
