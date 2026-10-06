# 安装包、恢复、升级与回滚

当前为0.1.0待发布工程版本，正式npm publish和GitHub Release未执行。Node.js限定24.x，Git ≥2.40，搜索需ripgrep；Windows默认PowerShell，Linux/macOS默认Bash。依赖版本以锁文件为准，不通过临时升级依赖掩盖错误。

在源码仓库执行 `npm ci` 后，运行 `npm run release:prepare`。入口依次执行完整check、锁定依赖许可核对、固定离线评估和独立生产安装包验证。评估和默认测试只使用程序创建的归属临时仓库、模拟provider和本地MCP，不需要真实模型密钥。

使用 `npm pack --pack-destination .release` 生成本地tgz；预打包会重新构建并核对许可文本。目标目录先由用户或程序创建。仓库根的私有配置、.env、测试、文档源和开发工具不进入发布包；包内容为dist、README、项目LICENSE、THIRD_PARTY_NOTICES及npm必需metadata。独立验证同时核对许可文件存在、私有配置不存在和bin可用。压缩后的tgz可保留用于安装与回滚，不上传即不构成npm发布。

安装本地包可用 `npm install --global <tgz绝对路径>`，也可使用隔离prefix：`npm install --prefix <安装目录> <tgz绝对路径>`，然后运行安装目录下的mewcode入口。后者避免替换现有全局版本。先验证 `mewcode --version`、`mewcode --help`、`mewcode --provider mock --model mock-v1 chat "离线验证"`，再连接实际模型。

真实密钥由进程环境注入，编译后和安装后入口不会隐式读取源码仓库.env.local。`npm run chat/agent`是源码开发便捷入口，会读取存在的该文件。密钥不写入命令参数、任务JSON、示例、源码、日志或会话；对外问题报告只保留错误码、运行版本、协议及已脱敏信息。

## 运行时依赖许可

`npm run licenses`从锁文件筛选生产依赖，核对安装版本并生成随包[许可文本](../../../THIRD_PARTY_NOTICES.md)；`npm run licenses:check`只检查生成内容一致性。包含147个锁定生产依赖及传递依赖，开发工具不在此清单。清单保留上游声明标识，不自动将双许可选成某一个授权。

清单对应当前锁文件和源码安装；tgz依赖声明中的传递版本范围仍由目标npm解析。需要完全复现时使用源码npm ci，并在准备实际分发时核对目标安装的依赖锁。

standardwebhooks 1.1.1和yoga-layout 3.2.1的npm包缺少许可文本。本仓库在[来源记录](../../licenses/sources.json)固定对应上游提交/版本、文本文件与SHA256；前者使用npm metadata提供的gitHead，后者使用v3.2.1指向的提交。生成和CI核对均离线读取已归档文本，不下载最新分支。其他文本来自实际安装包，包括NOTICE；这份清单不替代对分发义务的审阅。

## 升级与回滚

1. 停止活动Agent、Hook、MCP与团队执行；先查看任务/工作树状态，避免安装切换中断写入。
2. 记录原mewcode版本、Node/Git版本、provider协议和已验证tgz的SHA256。备份实际userDirectory/storageDirectory及项目.mewcode中的配置和记忆；备份存储可能含私人任务内容，应保留在自己控制的目录，不提交Git。
3. 先把新tgz安装到独立prefix，用mock和副本配置验证。已有工作树路径和Git分支保持不变，不移动、删除或force回收交付。
4. 验证后再切换使用的bin路径。所有永久规则、模式和审批仍按现有边界执行；会话审批不跨进程继承。
5. 回滚安装以前保留的tgz并恢复原bin路径。回滚代码不能撤销Git提交、文件修改、Shell或MCP外部动作。M16未升级存储Schema；未来新Schema应先核对兼容性，不能用旧代码直接覆盖新状态。

## 故障恢复

| 状态/错误 | 核对与操作 | 不会自动执行的动作 |
| --- | --- | --- |
| 模型超时/断流 | 检查协议、端点、网络；残缺chat轮次不入历史；run检查会话/文件后再明确运行 | 外部工具自动重试 |
| FILE_CONFLICT | 重新ReadFile取得revision，核对外部修改，再提交新参数 | 强制覆盖 |
| 会话锁 | 原进程确认停止后 `sessions unlock <UUID>`；`sessions show`查看状态，再 `run --resume <UUID>` | 抢占活进程、重放旧修改 |
| 记忆锁 | 核对原进程与文件归属后，使用 `memory unlock --scope user/project --approve` | 清除未知锁或自动接受候选 |
| 工作树任务中断 | `worktrees show/diff <UUID>`，原进程停止后 `worktrees recover <UUID> --approve`；死管理锁用unlock | force/prune或删除交付分支 |
| 团队中断 | `teams show/report <UUID>`，原进程停止后recover；uncertain保守消耗原预算，人工核对后retry指定任务 | 自动重跑未知写入或合并 |
| MCP超时/失联 | 客户端关闭旧连接；核对远端是否已执行，再新建任务重新连接 | 不确定调用自动重发 |
| 损坏归属/JSON/权限拒绝 | 保留文件，查明来源；用已核验备份恢复副本，核对路径及规则 | 接管无归属目录、绕过deny |

## 发布前保留的人工步骤

真实Windows/macOS/Linux终端里的输入法、resize、颜色与Esc/Ctrl+C需人工体验；Ink测试、Profiler和CI不替代此步骤。没有承诺真实模型任务质量、工业级OS隔离、无损摘要、零泄漏、费用下降或任意第三方MCP安全性。授权Shell/Hook具有当前用户主机权限，Git对象/refs共享。实际发布需再次明确选择发布位置、版本与凭据后执行。
