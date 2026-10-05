# MewcodeAgent

一个 CLI Coding Agent 项目,仿 Claude Code 的终端编程 Agent 工具

根据[小林 coding 的 MewCode Agent 公开介绍](https://xiaolincoding.com/project/mewcode.html)规划实现，主技术栈为 **TypeScript + Node.js**。

当前阶段：**M01 基础工程、M02 流式模型对话已完成**，支持 Ink 多轮界面、单次/管道模式和 OpenAI 兼容 Chat Completions / Responses。下一模块为 M03 六个编程工具。

## 先阅读这些文档

1. [网页内容提取与来源核对](docs/00-网页内容提取.md)：公开正文、图片中的技术栈与 17 章目录、可获取内容的边界。
2. [技术栈与总体设计](docs/01-技术栈与总体设计.md)：技术选择、五层架构、目录结构、核心协议及关键设计。
3. [模块实施与验收计划](docs/02-模块实施与验收.md)：按章节逐个实现的步骤、交付物、验收场景与调优指标。

按“规格 → 实现 → 验收 → 调优 → 文档”推进。当前模块的[规格](docs/modules/M02/spec.md)、[任务](docs/modules/M02/tasks.md)与[验收记录](docs/modules/M02/checklist.md)可直接查看；[M01 验收记录](docs/modules/M01/checklist.md)保留基础工程基线。

## 本地运行

需要 **Node.js 24.x** 和 npm。首次安装后，开发入口无需构建，也无需 API 密钥：

```powershell
npm ci
npm run dev -- --help
npm run dev -- --version
npm run demo -- "检查基础工程"
npm run dev -- config --json
```

`demo` 始终使用 MockProvider，不调用真实模型或修改项目文件。离线多轮界面可运行：

```powershell
npm run chat -- --provider mock --model mock-v1
npm run chat -- --provider mock --model mock-v1 "你好 MewCode"
"解释流式响应" | npm run dev -- --provider mock --model mock-v1 chat
```

终端中无提示词参数时启动交互界面，Enter 发送、Backspace 删除、Esc 取消回答、Ctrl+C 退出。有提示词参数或管道输入时使用纯文本输出。当前只支持对话，文件与命令工具在 M03/M04 接入。

构建后运行编译产物：

```powershell
npm run build
node dist/index.js --help
node dist/index.js demo "你好 MewCode"
```

## 配置

可将 [examples/config.yaml](examples/config.yaml) 复制为项目内 `.mewcode/config.yaml` 或用户目录 `~/.mewcode/config.yaml`。可选文件缺失时使用默认配置；`--config` 显式指定的文件缺失会报错。

覆盖顺序：默认值 → 用户文件 → 项目文件 → 环境变量 → CLI 字段。嵌套字段合并，未知字段报错，密钥仅引用环境变量名称，不允许写入配置值。

```powershell
npm run dev -- --cwd "C:\你的 项目" config --json
npm run dev -- --mode plan --model custom-model config --json
```

`--cwd` 决定项目与相对路径的基准。`MEWCODE_HOME` 可替代默认用户配置目录；默认日志路径为 `<存储目录>/logs/mewcode.log`。M01 只解析存储路径，不创建会话或写入日志。

基础字段和环境变量见 [M01 配置规则](docs/modules/M01/spec.md)，模型协议见 [M02 规格](docs/modules/M02/spec.md)。`npm run chat` 自动读取存在的 `.env.local`；`npm run dev`、编译后入口和安装后的 `mewcode` 使用当前进程环境，如需读取文件可显式使用 Node.js 的 `--env-file`。

### 真实模型对话

项目内 `.mewcode/config.yaml` 示例（该路径已被 Git 忽略）：

```yaml
provider:
  kind: openai-compatible
  model: gpt-5.5
  wireApi: responses
  baseUrl: https://doufuapi.com/v1
  apiKeyEnv: OPENAI_API_KEY
```

在本地 `.env.local` 中设置 `OPENAI_API_KEY=你的密钥`，然后运行 `npm run chat`。密钥文件已被 Git 忽略，不要写入 YAML 或提交。该供应商、模型和 Responses 协议已完成一次真实冒烟调用；供应商权限与费用由自己的账户决定。Responses 请求固定发送 `store: false`，上下文由客户端逐轮传递。

兼容 Chat Completions 的服务可改用 `wireApi: chat-completions`，并设置自己的模型与端点；按供应商要求选择 `maxTokensParameter: max_tokens` 或 `max_completion_tokens`，不支持 usage 流事件时设置 `includeUsage: false`。Anthropic 适配尚未实现。

需要本地代理时，可在本机 `.env.local` 添加 `NODE_USE_ENV_PROXY=1` 和对应的 `HTTPS_PROXY` 地址。对话支持总请求超时及取消，网络/429/5xx 只在首个流事件前最多重试一次。失败或取消的残缺轮次不会进入下一次模型上下文；达到上下文上限时需开始新会话。

## 检查与安装验证

```powershell
npm run check
npm run test:package
```

`check` 包括类型、lint、格式、模块边界、测试和构建。`test:package` 需要先构建，随后打包到临时目录，仅安装生产依赖，检查独立 CLI 与 `mewcode` bin，再清理临时目录；依赖未缓存时需要访问 npm registry，不会发布到 npm。

GitHub Actions 已配置 Windows/Linux + Node.js 24；远程运行结果以实际 CI 为准。

## 目标能力

流式终端对话、六个编程工具、Agent Loop、权限系统、MCP、上下文压缩、跨会话记忆、Slash Command、Skill、Hook、SubAgent、Git Worktree 和 Agent Teams。

本仓库的方案与后续代码独立设计实现。公开介绍页不包含完整付费教程或源码，文档中的补充实现方案不代表原课程内部实现。
