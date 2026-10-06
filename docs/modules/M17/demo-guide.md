# 可复现演示手册

本手册默认用于源码仓库，使用现有固定测试与M16评估，不增加运行入口。Node.js 24、npm、Git ≥2.40和rg需要可用；初次执行 `npm ci`。在仓库根运行下列命令，PowerShell与Bash均可使用。演示无需真实模型凭据，不执行 `npm run agent/chat`，这两个开发命令会读取存在的.env.local。

测试和评估自己创建归属临时中文/空格路径项目、用户目录及必要Git仓库，结束按归属守卫清理；没有手工删除目录步骤。不要把固定测试夹具改成自己的项目。正式模型演示另按已授权provider与权限操作，不包含在本轮验证中。

## 准备与讲解路径

```powershell
node --version
npm --version
git --version
rg --version
```

建议先打开[修复夹具](../../../tests/support/release-evaluation.ts)，说明provider是预设动作，文件、Shell、Git与MCP是真实执行。准备只需安装依赖；命令输出已足够展示工程证据，不需要手工填写UUID、复制密钥或准备工作树。测试通过时Vitest可能隐藏内部事件，按下面的断言位置讲解，不能声称输出展示了TTY审批弹窗。

## 演示一：失败断言 → 修改 → 真实检查通过

```powershell
npm run eval:release
```

返回的JSON为m16-v1评估套件，`results`中的五个status均应为passed；异常断言会使命令非零退出。重点展示bug-fix的beforeExit为1、afterExit为0，requests为5、syntheticTokens为250。原文件是`a-b`，带ReadFile revision的EditFile改成`a+b`；两组Node算术断言通过，最后核对文件内容。

接着说明file-refactor的files为2、四组真实行为断言通过；long-session执行100次读取和6次压缩，恢复后相同动作被拒绝；mcp-lifecycle核验父子进程停止；team-repairs的峰值并行为2、各自真实检查退出0、主树仍保留原bug。所有目录最终由夹具回收，团队fixture审阅提交后回收目录但保留分支，最终整个归属临时仓库才清理。

审批在夹具中使用显式测试回调批准固定动作，不代表真实用户已经批准任意Shell。用量是合成数据，输出耗时因机器/缓存变化，不要求与M16基准数字相等。失败断言与实际退出码是验证；最终文字不是验证。

## 演示二：纠错、Plan拒绝与取消后的文件状态

```powershell
npm test -- tests/integration/agent-loop.test.ts --reporter=verbose -t 'returns tool failures to the model|exposes only read tools in Plan|preserves a completed write when the user cancels'
```

预期命中3项，其余未选案例显示过滤跳过。打开[对应测试](../../../tests/integration/agent-loop.test.ts)：

| 案例     | 实际证据                                                                          | 应讲清楚什么                                       |
| -------- | --------------------------------------------------------------------------------- | -------------------------------------------------- |
| 纠错     | 第一次ReadFile返回FILE_NOT_FOUND，第二次改读exists.txt，两次工具调用后完成        | 结构化失败回填给下一轮；这里下一步由脚本指定       |
| Plan拒绝 | 模型仍请求WriteFile，执行器返回权限失败；blocked.txt不存在                        | 隐藏写工具只是提示，执行器仍检查；模型不能提升模式 |
| 取消     | committed.txt包含saved，skipped.txt不存在；错误CANCELLED，后续结果为AGENT_STOPPED | 取消停止后续动作，保留已完成修改；不是自动回滚     |

三项测试应通过，表示预期失败/取消行为正确发生。不要把Vitest退出0解释成被拒绝的动作执行成功。

## 演示三：一次批准、精确复用与拒绝

```powershell
npm test -- tests/unit/permissions.test.ts --reporter=verbose -t 'session consent reuses only exact normalized parameters|once consent never caches and refusal never executes'
```

预期命中2项。[权限测试](../../../tests/unit/permissions.test.ts)核验当前进程session批准只对完全相同的规范参数、目标、预览与Shell复用；参数改变必须重新询问。once不会缓存，拒绝不执行且不增加grant。它验证审批回调与执行器，未进行真人TTY交互。

追问“用户已经点过允许为什么还拒绝”时，说明deny优先、Plan与父权限仍约束，授权范围精确且模式变更会清除grant。`--approve`也不能覆盖deny；可查看[真实CLI拒绝测试](../../../tests/integration/permissions-cli.test.ts)。

## 演示四：界面取消和进程清理

```powershell
npm test -- tests/unit/chat-ui.test.tsx --reporter=verbose -t 'cancels a waiting response|exits on Ctrl\+C'
npm test -- tests/integration/tools-shell.test.ts --reporter=verbose -t 'cancels a parent and proves its child process has exited'
```

第一条预期命中2项，Ink测试渲染器模拟Esc取消与Ctrl+C退出，确认provider取消和未提交残缺轮次；第二条命中1项，运行真实Shell父子进程，取消后核验归属子进程退出。渲染器行为测试不是输入法、resize、色彩或终端FPS的人工验证。

## 演示失败时

Git/rg缺失先安装环境，不跳过权限或归属守卫。某个命令命中0项应核对测试名，不能拿“全部过滤跳过”作为通过。路径、超时或进程清理失败时保留错误码和测试名；不要force删除未知目录、覆盖文件或把用户项目替换进fixture。provider、模型费用与网络问题不属于本手册的离线执行条件。

现场时间不够时只跑演示一和二，审批/取消UI的已验证命令保留供追问。此处是建议讲解安排，没有测得真人演示时长。

## 人工TTY补充，尚未验收

需要体验真实键盘和审批时，先由用户建立独立空白项目与独立MEWCODE_HOME、使用不含provider凭据的配置并固定mock。用 `npm run dev -- --provider mock --model mock-v1 chat` 验证中文输入、Esc与Ctrl+C；用六工具明确调用的ReadFile、EditFile和Bash展示最终参数、diff及y/s/拒绝。mock不会自主修复任意bug。按[README工具示例](../../../README.md)准备输入文件；写入与命令必须在专用项目获得授权，不能对仓库根随意演示。此人工流程未在本轮执行，不计为已验收。
