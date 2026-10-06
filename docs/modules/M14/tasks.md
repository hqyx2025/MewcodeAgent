# M14 实施任务

- [x] 核对路线、依赖和 Git 工作树权限边界。
- [x] 实现严格 Schema、归属存储、有界读取、同进程 FIFO 与跨进程锁。
- [x] 实现主仓库/ref检测、创建、复用、报告、diff、回收及停止进程恢复。
- [x] 阻断 Git Hook/filter/fsmonitor、越界路径、脏目录和子模块自动清理。
- [x] 接入 lease、工作树根/cwd、父权限和统一工具执行入口。
- [x] 复用 M13 队列和预算，实现显式 WorktreeTask、真实 Bash 检查元数据。
- [x] 接入 CLI、任务文件与 run --worktrees、独立任务id持久化和未知用量恢复。
- [x] 建立中文临时仓库、双写入/取消/失败/篡改/冲突/清理/CLI测试。
- [x] 补安装包的真实 Git fixture 和隔离子任务验收脚本。
- [x] 建立创建/复用/回收基准，记录依赖准备条件和活动上限。
- [x] 最终 npm run check 与 test:package。
- [x] 更新 README、路线、验收记录，提交推送并核对远端 CI。

下一模块 M15 Agent Teams；本轮不自动实现团队、合并分支或安装子工作树依赖。
