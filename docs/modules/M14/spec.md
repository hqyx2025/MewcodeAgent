# M14：Git Worktree 与隔离写入子任务

状态：本地完整检查、安装包和基准通过，远端CI待核对。沿用 TypeScript 5、Node.js 24、ESM、npm；依赖以锁文件为准。本模块独立实现公开课程目录中的 Worktree 主题。

## 目标和入口

为独立写入任务创建明确归属的 Git 分支和工作树，复用 M13 的队列、取消、预算和观察证据，交付可检查的变更。主工作树的未提交内容不复制到子工作树。

- `worktrees list/create/show/diff/reuse/remove/recover/unlock`：明确执行管理动作，无需模型密钥。
- `worktrees delegate --tasks-file <file>`：在已创建工作树内执行写入子任务。
- `run --worktrees`：用户显式开启 Worktree 管理工具和 WorktreeTask。常规 run 不初始化 Git 管理器。
- 不自动合并、安装依赖、删除交付分支、force-remove 或 prune。不从 linked worktree 嵌套管理。

要求 Git ≥2.40，从主仓库根目录进入。支持 Windows PowerShell 和 Linux Bash；授权 shell 具有当前用户的主机权限，工作树绑定不是操作系统沙箱。

## 归属与生命周期

存储路径为 `<MEWCODE_HOME或默认用户存储>/worktrees/<commonDir哈希前24位>/<UUID>`，位于主仓库外。同目录有存储归属标记、每工作树 JSON 和管理锁。校验无 symlink/junction、普通单硬链接文件、有界 UTF-8 JSON、仓库路径、Git commonDir、Git 双向指针、worktree 登记及分支。HEAD 必须是记录 base 的后裔。

记录 app/version/id/repository/commonDir/path/task/branch/base/createdAt/status，以及运行 agentId/host/pid、终态 outcome 和最多16条真实 Bash 检查元数据。检查只存 callId 哈希、ok、exitCode、truncated；额外条数用 checksOmitted 标明，不保存命令原文或源输出。

生命周期：`creating → ready → running → completed/failed/cancelled → removed`。失败创建保留记录和已存在路径。干净且 HEAD 恰好原 base 的终态可以 reuse 到 ready。恢复只将同主机且拥有进程已确定消失的 creating/running 标成 failed，保留文件；活进程、未知主机和无法确认状态拒绝恢复或解锁。

每仓库默认最多4个未回收记录，可通过内部 manager 参数收紧为1–4；创建失败也占名额，需检查后回收。归属记录最多128条，不自动删除恢复记录。同进程管理动作 FIFO，跨进程使用 wx 锁，不静默抢占。

base 默认为 HEAD，解析成固定 commit SHA。task 是1–24字符小写 slug；新分支必须以 codex/ 开头，默认 `codex/worktree-<task>-<UUID前8位>`。已有分支拒绝覆盖。Git 命令使用固定 argv、无 shell、脱敏环境、30秒超时及256KiB输出上限。checkout/status/diff 禁止 Hook、fsmonitor、递归子模块、外部 diff/textconv 和已配置的 clean/smudge/process filter；每次相关操作重新检查 filter 配置及空 Hook 目录。LFS 等过滤内容不自动实体化。

## 权限与隔离写入

管理工具统一注册到 ToolExecutor：List/Inspect 为 read，Create/Remove/Reuse/Recover/Unlock 为 shell；Plan 禁止修改和 shell，deny 优先。删除审批后再次核验记录和当前文件状态。

WorktreeTask 为 write，必须使用 ready、干净、原 base 的已归属工作树。默认工具 ReadFile/Glob/Grep/WriteFile/EditFile；Bash 必须明确加入任务 tools。孩子绑定冻结 lease，文件根目录和进程 cwd 都是该工作树，继承父 mode、deny/ask、白名单、Hook、审计、shell 和超时约束。prepare、Hook 前和实际执行前再核验 lease；结束后旧执行器不能继续写入。

文件工具拒绝主仓库绝对路径、越界路径、链接、.git 和受保护凭据/配置路径。批准的任意 Bash 仍可能影响主机或共享 Git refs，不能据文件工具隔离宣称 shell 完全隔离。孩子不开放 Worktree 管理、Task/WorktreeTask 或其他委派能力。

`--approve` 只批准这一次管理/委派动作，不批准孩子的 shell，也不改变孩子文件编辑模式。离线演示用 `--mode accept-edits` 明确允许文件修改；default 中孩子修改依然逐次审批，非交互环境拒绝。

## 委派、预算和恢复

任务文件为项目内 ≤32KiB UTF-8 JSON，先走路径和 ReadFile 规则，严格 Schema：

```json
{
  "tasks": [
    {
      "id": "fix-one",
      "worktree": "填写创建结果中的UUID",
      "goal": "修复指定模块并核验",
      "context": "只传必要信息",
      "tools": ["ReadFile", "Glob", "Grep", "WriteFile", "EditFile", "Bash"]
    }
  ]
}
```

每批最多4项，沿用 subagents 的并发、任务数、轮数、超时、输出及 token 上限。默认并发2、总任务8、30秒/6轮、子池60k token；两个池各受子池上限约束，父子还共用根总预算，根默认200k。run 同时开启只读池和工作树池，最多各4个运行任务；工作树资源总上限仍为4。配额与子池恢复使用保守累计策略，不增加免费额度。

结果含 worktreeId、agentId、状态、用量、摘要和观察证据；证据相对孩子工作树。Bash 退出码只由真实工具返回记录，不接受模型声明。completed 表示子运行完成并返回合法摘要，不证明目标语义或测试覆盖正确。

根会话独立保存 subagentIds/worktreeTaskIds，原调用被压缩后也阻止相同任务id重放。WorktreeTask intent 保存共享未知用量恢复额度，结果提交后移除；崩溃恢复可能保守多记。恢复根会话不自动续跑孩子，也不自动结束仍为 running 的工作树；先确认原进程停止，再 recover 并审阅。

## 报告、清理与错误

show 返回归属、HEAD、dirty、提交及未提交变更路径、未跟踪/忽略文件和冲突。diff 增加相对 base 的有界脱敏 patch，最多32KiB；未跟踪文件仅列路径。known secret 无论长度都脱敏，通用 sk/私钥模式也脱敏。

模型 Inspect 按工具结果预算结构化缩减 diff 和路径，明确 truncated/omittedPaths，保留 dirty 和归属状态。元数据本身超限或 List 过大返回 WORKTREE_LIMIT；CLI 管理结果上限1MiB，Git原始输出超过256KiB拒绝使用不完整结果。

remove 拒绝 creating/running/removed、修改、未跟踪/忽略文件、冲突和子模块。干净的已提交交付允许回收目录，保留分支。路径已缺失且 Git 无登记可标记 removed；仍登记则拒绝并保留恢复线索。不清理用户项目或无归属目录。

主要错误：WORKTREE_GIT、WORKTREE_OWNER、WORKTREE_BASE、WORKTREE_BRANCH、WORKTREE_BUSY、WORKTREE_LOCKED、WORKTREE_LIMIT、WORKTREE_DIRTY、WORKTREE_SUBMODULE；源 Git stderr、损坏 JSON 与凭据不回显。CLI 批次错误或任一失败结果退出1，保留成功的其他交付。

## 验收和调优

测试覆盖同名修改隔离、脏主工作树、真实 Bash cwd/退出码、分支/ref错误、并发上限、复用基准、脏/忽略文件清理、冲突、子模块、指针/归属篡改、Plan/父deny、取消、重复绑定、恢复防重、报告大小及安装后闭环。

`npm run bench:worktrees` 在归属临时中文路径的小型 Git fixture 测量创建、复用和正常回收。记录缓存、平台、Git/Node及采样条件；不将未执行的依赖准备耗时填成0。完整检查和实测数据见 checklist。
