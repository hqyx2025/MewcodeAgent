# M08 验收记录

状态：已实现并推送，本地及Windows/Linux CI完整检查和独立安装包通过（2026-10-06）。仅使用模拟provider与程序自建临时目录，不调用收费模型。

- [x] 上下文窗口与输出预留，估算/真实usage区分。
- [x] 自动/手动压缩，目标/权限/近期完整调用链与失败回退。
- [x] 长结果溢写和显式查看，凭据脱敏与revision保留。
- [x] 检查点与尾部损坏恢复、未知版本/中间损坏拒绝。
- [x] 意图记录、取消/真实进程崩溃恢复、动作不重放、模式不提升。
- [x] 会话锁、归属检查、链接/穿越拒绝与清理。
- [x] 100轮固定基准、完整检查及独立安装验证。
- [x] Windows/Linux CI。

本地Windows 11 Pro，Node24.14.0/npm11.9.0。`bench:context`固定100轮、每轮一组ReadFile调用/大文本结果，5次内存压缩：822380bytes → 41976bytes，中位2.76ms，归档192条消息；原始目标、系统提示、最近4组完整调用精确保留，历史只保留有界摘录。216096bytes结果溢写后内联7461bytes，单次写入5.39ms（包括digest与sync），显式读取内容完全一致。额外模型调用/token均为0。不是收费模型、网络服务或磁盘压力基准。

最终`npm run check`：26个文件，253 passed、1 Windows平台跳过（总254）。边界73模块/245依赖无违规。存储故障使用确定性锁变化/持久化异常注入，未压满用户磁盘。压缩候选提交失败后旧内存历史不变化、调用组仍完整。生产依赖审计0漏洞，git diff --check通过。

`npm run test:package`本地通过：中文/空格路径、仅生产依赖、独立bin/CLI、MCP和持久会话保存/查看/恢复/模式保留/归属清理全部成功；help不加载SDK/UI等重依赖。本地运行压缩包191680bytes、解包733037bytes、compiled JS232074bytes；help7个样本中位42.51ms、最小42.29ms、最大45.43ms（包含Node进程启动，不包括npm安装）。

远端验收：[GitHub Actions运行37421365496](https://github.com/hqyx2025/MewcodeAgent/actions/runs/37421365496)，代码提交`5a24d8b031853dff8d2e13fef8d8c13dc75c7682`，Node24.21.0。两个平台均通过`npm run check`和`npm run test:package`：Windows 26文件、253 passed/1平台跳过；Ubuntu 26文件、252 passed/2平台跳过（均为254测试）。Windows安装包191684bytes、Ubuntu191697bytes，解包均733048bytes、compiled JS均232074bytes；安装包大小受打包元数据影响，未将两端数值作为性能提升。

首次Windows CI遇到既有MCP测试临时目录`EBUSY`，已对验证归属后的测试目录删除增加最多5次、间隔基数100ms的有界重试；持续锁定仍失败，进程树终止断言保留。随后正常stdio连接测试在5秒预算内未成功，已统一到其他stdio夹具和配置默认的15秒冷启动预算，断言补错误码；超时专项预算不变。上述调整仅影响测试，最终CI两端通过。macOS、真实模型长会话、磁盘压力和断电未验证。
