# MewcodeAgent

一个 CLI Coding Agent 项目,仿 Claude Code 的终端编程 Agent 工具

根据[小林 coding 的 MewCode Agent 公开介绍](https://xiaolincoding.com/project/mewcode.html)规划实现，主技术栈为 **TypeScript + Node.js**。

当前阶段：**M15 Agent Teams 已实现，正在完成验收**，支持既有模块、归属 Git 工作树，以及持久成员、依赖任务看板、有界消息、累计预算和显式中断恢复。边界与实际检查结果见[M15规格](docs/modules/M15/spec.md)和[验收记录](docs/modules/M15/checklist.md)，下一模块为M16整体调优与发布。

## 先阅读这些文档

1. [网页内容提取与来源核对](docs/00-网页内容提取.md)：公开正文、图片中的技术栈与 17 章目录、可获取内容的边界。
2. [技术栈与总体设计](docs/01-技术栈与总体设计.md)：技术选择、五层架构、目录结构、核心协议及关键设计。
3. [模块实施与验收计划](docs/02-模块实施与验收.md)：按章节逐个实现的步骤、交付物、验收场景与调优指标。

按“规格 → 实现 → 验收 → 调优 → 文档”推进。当前模块的[规格](docs/modules/M15/spec.md)、[任务](docs/modules/M15/tasks.md)与[验收记录](docs/modules/M15/checklist.md)可直接查看；M01–M14 的验收记录保留前期基线。

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

终端中无提示词参数时启动交互界面，Enter 发送、Backspace 删除、Esc 取消回答、Ctrl+C 退出。有提示词参数或管道输入时使用纯文本输出。`chat` 用于纯对话，`run` 启动 Agent 工具任务，`tool` 明确调用一个工具。

构建后运行编译产物：

```powershell
npm run build
node dist/index.js --help
node dist/index.js demo "你好 MewCode"
```

## Slash Command

```powershell
npm run dev -- commands
npm run dev -- commands resume
npm run chat -- --provider mock --model mock-v1 "/help"
npm run agent -- "/plan 分析项目入口" --save-session
```

chat 支持 `/help`、`/clear`、`/model`、`/permissions`、`/compact`、`/resume <id> [task]`、`/plan [on|off|task]`，TTY 中 Tab 补全名称。清空同时重置当前展示和模型上下文，压缩使用本地摘录。`/model` 切换当前服务的模型；`/permissions` 切换模式不能超过启动时上限，本地命令不连接模型。

`/resume <id>` 与 `/plan <task>` 会先退出 chat 界面，再交给 Agent CLI 执行和审批；纯对话历史不会变成工具会话。`run` 的 `/clear`、`/compact` 会拒绝，因为单任务入口没有 chat 历史。

把模板保存为项目 `.mewcode/commands/review.md` 或用户目录 `commands/review.md`，可选 Markdown frontmatter：

```markdown
---
description: 检查指定文件
argument-hint: '<path> [options]'
---

请检查 $1，要求：$ARGUMENTS
```

调用 `/review "中文 文件.ts" 检查边界`；内置优先于项目、项目优先于用户。正文按需读取，`/help --refresh` 更新名称和说明索引。位置参数和原始参数串只替换文字；模板不会执行 shell 或切换权限，`run` 的后续工具动作仍需原权限策略。[完整限制与行为](docs/modules/M10/spec.md)。

## Skill 系统

项目技能放在 `.mewcode/skills/code-review/SKILL.md`，用户技能放在用户目录的 `skills/code-review/SKILL.md`；项目覆盖同名用户技能。正文示例：

```markdown
---
name: code-review
description: 审查变更，定位错误并验证边界测试。
---

定位相关文件，检查失败路径；需要时使用 SkillRead 读取 references/checklist.md。
```

```powershell
npm run dev -- skills list
npm run dev -- skills show code-review --content
npm run dev -- skills match --query "审查变更并检查边界测试"
npm run dev -- prompt --json --skill code-review
npm run agent -- "审查本次变更" --skill code-review
npm run chat -- "/skill code-review 解释边界测试方法"
```

不指定技能时按名称/描述做本地词项匹配，最多选2个；显式名单最多4个。启动只保存元数据，选中后才读取正文；资源不自动读取。`/skills refresh` 更新索引，`/skill <name> <task>` 为本轮明确选择。每轮记录名称、来源与选择原因，提示元数据不输出正文。

Agent的 `SkillRead` 只能读取本轮选中技能目录内的有界文本资源；附带脚本需要另走完整Bash命令审批，Plan禁止执行。chat只提供建议，不读取资源或执行脚本。技能不能提升权限或授权MCP，Skill提供方法和本地资源，MCP提供需审批的外部服务能力。[格式、限额、匹配和恢复边界](docs/modules/M11/spec.md)。

## 生命周期 Hook

在用户或项目配置中增加 `hooks`；数组按来源顺序追加，id不能重复。脚本路径基于项目根，示例：

```yaml
hooks:
  - id: protect-locks
    event: PreToolUse
    tool: WriteFile
    script: .mewcode/hooks/protect-locks.mjs
    timeoutMs: 5000
    env: []
```

对应 `.mewcode/hooks/protect-locks.mjs`：

```js
let text = '';
for await (const part of process.stdin) text += part;
const event = JSON.parse(text);
const blocked = event.tool.input.path.endsWith('.lock');
process.stdout.write(JSON.stringify({ decision: blocked ? 'block' : 'continue' }));
```

`npm run dev -- hooks` 只查看配置；`run` 触发SessionStart、PreToolUse、PostToolUse、Stop、SessionEnd，独立 `tool` 与 `mcp` 调用触发工具事件。脚本执行需要shell审批，Plan禁止；chat和prompt不会执行Hook脚本。只接受结构化JSON，PreToolUse可通过 `updatedInput` 替换整个输入，随后重新校验和授权；安全事件失败阻止动作，通知失败保留工具实际结果。`run --json` 可查看脱敏Hook审计，`--audit-file`可保存JSONL，`npm run bench:hooks`测量本地延迟。

脚本作为已批准的Node ESM快照执行，支持node:内置模块；相对/包名导入不可用，需要绝对file URL。环境变量只显式引用名称，不能在配置内填写密钥值。[完整协议、限额、取消和恢复边界](docs/modules/M12/spec.md)。

## 只读 SubAgent

```powershell
npm run dev -- --provider mock --model mock-v1 --subagents --mode plan run "检查目录" --json
npm run dev -- --provider mock --model mock-v1 delegate --tasks-file tasks.json --json
npm run bench:subagents
```

任务文件示例：

```json
{
  "tasks": [
    { "id": "core", "goal": "检查 src/core 的任务生命周期" },
    { "id": "tools", "goal": "检查 src/tools 的权限入口" }
  ]
}
```

`run` 默认关闭委派；用户通过 `--subagents` 或用户配置开启后，模型可以调用 `Task`。`delegate` 是用户明确提交任务的入口，每批最多4项，整个池默认最多8项、并发2项。项目配置只能收紧限额。Mock仅演示协议和目录列表；真实分析需配置已有provider。

只读孩子固定Plan、深度1，仅开放ReadFile/Glob/Grep，继承父deny与Hook边界；父历史、记忆、Skill和审批授权不复制。结果含状态、用量、摘要及核验后的观察引用；失败不会丢失其他任务结果，重试需新id和retryOf。父取消传播到队列与运行任务，父子共享token预算，缺少usage按保守估算记账，父汇总成本也计入。保存会话后保留任务id并阻止恢复重放；子会话不独立恢复。[配置、证据核验、预算与恢复限制](docs/modules/M13/spec.md)。

## 隔离工作树与写入子任务

需要 Git ≥2.40，从主仓库根目录运行。创建固定提交的独立分支和工作树，主树未提交内容不复制。示例使用 mock，不需要模型密钥：

```powershell
npm run dev -- worktrees create --task fix-one --approve
npm run dev -- worktrees create --task fix-two --approve
npm run dev -- worktrees list
npm run dev -- worktrees show <UUID>
npm run dev -- worktrees diff <UUID>
npm run dev -- --provider mock --model mock-v1 --mode accept-edits worktrees delegate --tasks-file tasks.json --approve --json
npm run dev -- worktrees remove <UUID> --approve
npm run bench:worktrees
```

项目内 tasks.json 用创建结果的UUID绑定，例如：

```json
{
  "tasks": [
    { "id": "one", "worktree": "第一个UUID", "goal": "检查并修复模块一" },
    { "id": "two", "worktree": "第二个UUID", "goal": "检查并修复模块二" }
  ]
}
```

mock 只在每个工作树写入并读取固定 mewcode-demo.txt，演示协议，不完成任意目标。真实 provider 的任务默认开放文件工具；Bash需明确加入tools。文件根和Bash cwd绑定工作树，仍受父权限、Hook和共享预算约束。`--approve`只批准管理/委派，不批准孩子shell；Plan与deny不可绕过。

常规Agent用 `run --worktrees` 明确开启，默认最多4个未回收工作树。show/diff展示归属、变化、冲突及真实Bash退出信息；不把模型自述当成测试结果。修改、未跟踪/忽略文件、子模块或活动任务阻止回收，保留路径；干净已提交交付可回收目录，分支仍保留。停止进程后可明确 recover/unlock，不能抢占活进程。

不自动合并或安装依赖，Git refs/对象仍共享，授权的任意shell有主机权限。依赖准备、审阅提交与合并由用户决定；[完整规格与恢复限制](docs/modules/M14/spec.md)。

## 团队成员与依赖任务

先创建两个干净工作树，将返回的 UUID 填入项目内 team.json。示例中的 reviewer 使用自己的工作树，收到前序摘要和工作树 ID；需要审阅完整交付时使用 `teams report`：

```json
{
  "name": "module-team",
  "members": [
    { "id": "editor", "role": "实现模块", "worktree": "第一个UUID" },
    { "id": "reviewer", "role": "审阅交付", "worktree": "第二个UUID" }
  ],
  "tasks": [
    { "id": "implement", "member": "editor", "goal": "检查并修复模块" },
    {
      "id": "review",
      "member": "reviewer",
      "goal": "检查前序交付摘要",
      "dependsOn": ["implement"],
      "tools": ["ReadFile", "Glob", "Grep", "TeamInbox", "TeamSend"]
    }
  ]
}
```

```powershell
npm run dev -- teams create --file team.json --approve
npm run dev -- teams show <团队UUID>
npm run dev -- --provider mock --model mock-v1 --mode accept-edits teams run <团队UUID> --approve --json
npm run dev -- teams report <团队UUID>
npm run dev -- teams add <团队UUID> --file more-tasks.json --approve
npm run dev -- teams send <团队UUID> --file message.json --approve
npm run dev -- teams inbox <团队UUID> --member editor
npm run dev -- teams cancel <团队UUID> --approve
npm run dev -- teams retry <团队UUID> --task implement --approve
npm run dev -- teams recover <团队UUID> --approve
npm run bench:teams
```

`more-tasks.json` 使用同样的 `tasks` 数组，每次最多新增4项；`message.json` 为 `{"messageId":"新UUID","to":"editor","task":"implement","text":"审阅数据"}`，task可省略。协调者为本地确定性调度器，消息不会创建或执行任务。mock只演示固定文件写入/核验，不完成任意目标；上述只读review任务需真实provider才会分析交付，mock仅返回演示摘要。

每团队最多4成员、32生命周期任务、128消息，默认消息上限64。默认并发2、总预算60k、每任务40k、6轮/30秒；仍受可信 subagents 和 CLI 限制，默认每批最多8任务。相同成员串行，依赖失败标记blocked，批次上限留下queued供下一次明确run。完成任务不重放，成员身份与工作树交付跨run保存，每任务模型上下文独立；既有父权限、Hook与工具白名单继续生效。`--approve`只批准管理/运行，孩子shell仍需批准。

`show`默认省略目标、上下文和消息正文，`--content`明确查看；结果摘要与观察证据会显示。`report`含diff、真实Bash检查和同名变更路径，需人工审阅合并。同主机原进程确定消失后才能recover/unlock；未知任务记为uncertain并保守消耗原预留预算，明确retry才可再执行。主仓库外的归属记录最多64团队、每条512KiB；没有后台成员进程或自动合并。[完整边界](docs/modules/M15/spec.md)。

## 模型执行任务

```powershell
npm run dev -- --provider mock --model mock-v1 --mode plan run "查看目录" --json
npm run agent -- "分析项目入口" --mode plan
npm run agent -- "修复一个小 bug 并运行测试"
```

`npm run agent` 自动读取存在的 `.env.local`，沿用已有模型配置。离线 Mock 仅调用 Glob 并汇报结果，不解释或修改任意任务。

默认修改与 shell 展示最终路径、cwd、shell、diff和完整参数，TTY 输入 y 批准本次，s 授权当前进程内完全相同的操作；非 TTY 拒绝需要审批的动作。`--mode accept-edits` 允许文件修改，shell 仍需确认；Plan 只暴露读取工具并由执行器再次拦截写入。更严格的规则始终生效。

`run` 支持 `--max-turns`（默认配置 20）、`--max-total-tokens`（默认 200000）、`--timeout-ms`（默认配置 120000）。连续三次工具失败停止；损坏/截断分片不执行工具；取消保留已完成的修改。token 使用服务报告或明确标记的估算，不能视为精确费用上限。

## MCP 服务

MCP 默认不启动。配置只保存命令、项目内 cwd 和环境变量名称，不保存密钥；stdio 与 Streamable HTTP 服务都通过 `external` 权限进入统一审批入口。Plan 模式禁止连接，服务端的只读提示不能放宽权限。

```yaml
mcp:
  servers:
    local:
      transport: stdio
      command: 'C:/tools/mcp-server.exe'
      args: []
      cwd: .
      env:
        API_TOKEN: MCP_API_TOKEN
    remote:
      transport: http
      url: https://example.test/mcp
      headersEnv:
        Authorization: MCP_AUTH_HEADER
```

```powershell
npm run dev -- mcp list
npm run dev -- mcp discover local --approve-start
npm run dev -- mcp call local echo --approve-start --approve --input '{"text":"hello"}'
npm run agent -- "查询本地服务" --mcp local
```

`mcp discover` 和 `mcp call` 的连接授权、工具调用授权分开处理。MCP 工具名称使用服务 ID 与远端名称摘要，输入/输出只接受有界 JSON Schema 子集；媒体、资源、sampling、elicitation 和自动重试不执行。调用超时或断连时不重放请求，外部副作用可能已经发生。

`--json` 输出 JSONL 事件，普通模式文本在 stdout、工具及审批状态在 stderr。工具串行执行，任务预算有限；持久会话需显式启用，恢复不会自动重放历史操作。

## 上下文与会话

```powershell
npm run agent -- "检查项目入口" --save-session --mode plan
# 使用上次输出的 UUID
npm run agent -- --resume <session-id>
npm run dev -- sessions list
npm run dev -- sessions show <session-id>
npm run dev -- sessions show <session-id> --content --checkpoint 1
npm run dev -- sessions compact <session-id>
npm run dev -- sessions result <session-id> <digest>.json
npm run dev -- sessions delete <session-id>
```

默认窗口262144 tokens、触发比例0.75、近期4轮、摘要/工具结果各8192 bytes，可通过配置 `context.windowTokens/triggerRatio/recentTurns/summaryBytes/toolResultBytes/autoCompact` 调整。请求输入按序列化UTF-8字节保守估算并预留 `limits.maxOutputTokens`，不是模型精确tokenizer；累计费用预算仍区分provider usage和估算。

自动压缩使用本地结构化摘录，额外模型调用为0；保留原始目标、当前系统指令和近期完整调用组，历史摘要只作为数据。摘要会省略细节，已保存会话可通过检查点查完整历史。长工具结果保存到会话 outputs 并返回有界预览、文件revision和溢写索引；未保存会话时仅返回有界内联结果。

会话保存在 `<storageDirectory>/sessions/<UUID>`，绑定项目、provider和model。恢复重建项目指令、使用旧/当前模式中更严格者、重新审批新操作；MCP连接仍需显式指定。不再次执行旧callId或与已记录修改动作相同的参数，遇到不确定外部状态先核对，不保证外部动作与本地日志具备原子事务。

崩溃遗留锁不会自动解除：核对原进程已退出后可用 `sessions unlock <session-id>`。目录拒绝链接和路径穿越，删除只清理归属验证通过且未锁定的单会话及溢写。单检查点/结果2MiB、单会话总64MiB、最多10000提交记录；磁盘或校验失败会停止后续动作。`sessions show`默认仅元数据，`--content`显式查看脱敏正文；会话脱敏覆盖已知凭据与常见密钥形式，不代表隐藏全部业务信息。

## 用户与项目记忆

```powershell
# 仅查看当前项目；不会自动保存会话或调用模型
npm run dev -- memory list
# --approve确认这一次操作；省略时TTY会展示审批，非TTY拒绝
npm run dev -- memory add --scope user --kind preference --text "回答使用简体中文" --approve
npm run dev -- memory add --scope project --kind convention --text "验证使用npm test" --approve
npm run dev -- memory show <entry-id>
npm run dev -- memory edit <entry-id> --text "验证使用npm run check" --approve
npm run dev -- memory delete <entry-id> --approve

# 从已保存会话提取候选，查看后逐条确认；候选提取不会写记忆
npm run dev -- memory candidates <session-id>
npm run dev -- memory accept <session-id> --candidate <candidate-digest> --approve
```

用户文件 `<userDirectory>/memory.md` 只保存显式确认的通用偏好；项目文件 `<cwd>/.mewcode/memory.md` 绑定当前规范项目根，允许preference/convention/fact。文件为有版本、归属和来源的JSON代码块Markdown，最多64KiB/100条；单条为最多1024字符的单行文本。使用 `memory edit` 保留原kind并记录新的人工来源；可用 `--kind` 显式改变项目条目的分类。`--revision <digest>` 限制保存版本，`--revision new` 仅允许新文件；审批期间发生变化会拒绝覆盖。

候选只识别原始用户消息中的单行 `用户偏好：…`、`项目约定：…`、`已验证事实：…`；不从模型、工具输出或压缩摘要推断事实。`fact`是用户复核后的主张，不是机器证明。候选来源记录会话、检查点、消息和行号；接受时检查候选digest，可用 `--checkpoint <sequence>` 指定原检查点。项目候选不会自动转成全局记忆，用户作用域只接收preference，跨项目会话拒绝。

run、prompt和chat每轮按需读取：偏好和约定优先，事实按英文词项/中文二字词项交集筛选，整条选择；默认JSON注入预算8192bytes，配置 `memory.enabled` / `memory.injectionBytes` 可调整，环境变量 `MEWCODE_MEMORY=false` 关闭自动注入。项目不能重新开启用户已关闭的记忆，显式环境覆盖可以。`prompt --json` 只显示条目ID、来源作用域、数量、字节和警告，不输出正文。压缩保留当前记忆区，恢复重新读取；删除后下一次请求不再加载，但不会抹除历史中已经复述的内容。

管理工具对模型隐藏；修改、删除和解锁即使accept-edits也需审批，Plan禁止变更，deny不能由 `--approve` 覆盖。自动读取尊重 `MemoryRead` 的ask/deny及路径规则；例如用户配置中 `tool: MemoryRead, decision: deny` 可禁止全部自动读取。普通文件工具保留内部记忆路径，自定义项目内用户目录受专用规则保护，递归查询可能需缩小范围。Shell和MCP本身有经授权的主机能力，记忆文件保护不等同于OS沙箱。

写入使用独占锁和原子替换；崩溃遗留锁不会自动偷取，可在核对原进程终止后 `memory unlock --scope project --approve`，只允许同主机且进程已终止的有效锁。未知版本、损坏、超限、symlink/junction或硬链接会拒绝；已知凭据、常见密钥与敏感赋值拒绝保存，外部引入的敏感条目过滤。过滤是本地规则，不保证识别所有个人或业务敏感信息；不要将此类信息作为记忆输入。固定基准可运行 `npm run bench:memory`，不调用收费模型。

## 权限规则与审计

```powershell
npm run dev -- permissions
# 审计父目录须已存在；每次使用新文件名
npm run dev -- --provider mock --model mock-v1 --mode plan run "查看目录" --json --audit-file ../mewcode-audit-001.jsonl
```

用户配置 `~/.mewcode/config.yaml` 与项目 `.mewcode/config.yaml` 可保存规则，例如：

```yaml
permissions:
  rules:
    - decision: deny
      path: private
    - decision: ask
      effect: write
      path: src
```

支持 `decision: allow/ask/deny`、可选 `tool`、`effect: read/write/shell/external`、`path`。path 是项目相对字面路径，使用 `/`，覆盖子目录；不支持 glob、命令前缀或目录穿越。规则累积且 deny > ask > allow；项目 allow 不能免除修改审批，只有用户/CLI的显式文件 allow 可授予文件权限，shell 和 external 始终需审批。项目配置也不能将 default 或 Plan 自动改成 accept-edits；可用用户配置、环境变量或 `--mode` 显式选择模式。

递归 Glob/Grep 范围与受限目录相交时，整次查询被拒绝或要求审批，应缩小搜索范围。ReadFile 路径 deny 同时保护递归读取、项目指令和编辑准备阶段；需要审批的项目指令不会被自动注入。模型、普通文件或项目指令不能修改权限。

会话授权只匹配完整参数、目标、预览、shell及策略版本，不授权目录或命令前缀，不跨进程保存。每次仍检查路径和文件revision；模式变化清空授权，运行或审批中不能切换。M13子Agent通过受约束的fork继承父权限，仅开放任务指定的只读工具。

`run --json` 增加 `permission` 事件；`tool` 的 JSON 带 `audit`。审计只含决策、来源、模式、授权方式、缓存命中、执行器标识及调用/参数摘要，不含命令、文件内容或绝对路径。`--audit-file` 写入新JSONL文件，不能覆盖已有文件或跟随链接，写入故障阻止动作。推荐保存到项目之外，或已创建的 `.mewcode/audit/`；若选项目内其他位置，该文件会成为禁止范围，覆盖它的递归搜索也会拒绝。审计记录表示授权决策，实际执行成功与否以工具结果为准，不用于自动重放任务。

## 系统提示与项目指令

```powershell
npm run dev -- --mode plan prompt
npm run dev -- --mode plan prompt --json
```

`prompt` 查看提示段、实际环境/预算和根指令来源元数据，无需密钥、不调用模型、不输出项目指令正文。`run --json` 的 `prompt_info` 事件记录初始提示和按需更新的来源。

启动只在 `--cwd` 项目根检查 `AGENTS.md`，缺失时兼容 `CLAUDE.md`；同目录空或无效AGENTS也不切换到CLAUDE。访问内置文件工具的路径、Grep路径、Bash cwd或Glob静态前缀时，沿目标目录祖先按需发现子目录指令。较深层项目约定只适用于其目录；运行时权限和用户任务优先。不会自动读取父目录、home或递归扫描整个项目。

首次发现新子目录指令或读取警告时，当前整批工具返回 `INSTRUCTIONS_UPDATED` 且不执行。下一轮模型看到新提示后重新计划，需使用新的callId；这会占用模型轮数，但不计连续工具失败。

指令在一次任务内缓存快照，新任务重新读取。拒绝链接、非普通文件和越界路径；单文件注入最多16KiB、总计32KiB，截断/坏编码/脱敏有来源警告。发现最多32层、128个目录，超限停止。项目文件里的授权声明不能改变工具权限。详见[M05规格](docs/modules/M05/spec.md)。

## 明确调用编程工具

Grep 需要 `rg`（ripgrep）可执行程序位于 PATH；Windows 可通过 `winget install BurntSushi.ripgrep.MSVC` 安装，Ubuntu 可用 `sudo apt-get install ripgrep`。工具调用无需模型密钥。

```powershell
npm run dev -- tools
npm run dev -- tool ReadFile --input-file examples/tool-read.json
npm run dev -- tool Glob --input-file examples/tool-glob.json
npm run dev -- tool Grep --input-file examples/tool-grep.json
npm run dev -- tool WriteFile --input-file examples/tool-write.json --approve
npm run dev -- tool Bash --input-file examples/tool-shell.json --approve
```

`tools` 输出六个工具的完整 JSON Schema；`tool` 输出包含 `callId`、`ok`、`content`、`data` 和错误码的 JSON。示例写入会创建 `mewcode-demo.txt`。参数也可用 `--input <JSON>`；PowerShell 下推荐参数文件，避免原生命令的引号差异。

ReadFile 返回完整文件的 `data.revision`。覆盖 WriteFile 或执行 EditFile 时，将该值放入参数的 `expectedRevision`；版本变化会拒绝修改。EditFile 还需 `path`、`oldText`、`newText`，默认唯一匹配，重复替换需显式 `replaceAll: true`。文件读写限 1MiB，读取输出最多 2000 行/32KiB，截断会标记 `truncated`。

默认读取允许，文件修改与命令需要 `--approve` 授权本次操作。`--mode accept-edits` 允许文件编辑，命令仍需授权；`--mode plan` 禁止修改和 shell，即使提供 `--approve` 也不能绕过。路径限制在项目根内，并拒绝符号链接/junction、`.git`、`.env` 系列和本地配置/会话/缓存路径。

Bash 工具在 Windows 默认运行 PowerShell，在 Linux/macOS 默认运行 Bash。Windows 使用 Git Bash 时需显式设置 `--shell bash --shell-executable "C:\Program Files\Git\bin\bash.exe"`。子进程不继承 API 密钥，支持输出上限、超时及取消；授权 shell 后命令具有当前用户的主机权限，工作目录和审批不是操作系统沙箱。PowerShell 原生命令保留最后一次 native exit code，内部命令失败返回 1，脚本可通过 `exit` 显式控制退出码。

Glob 支持 `*`、`**`、`?` 和字符类，以及 `includeHidden`、`ignore`、`maxResults`；不自动解释 `.gitignore`。Grep 使用 rg 的忽略规则，`fileGlob` 为项目相对模式，`path` 可进一步限定搜索目录；搜索跳过超过 1MiB 的文件，结果和进程输出均有上限。

## 配置

可将 [examples/config.yaml](examples/config.yaml) 复制为项目内 `.mewcode/config.yaml` 或用户目录 `~/.mewcode/config.yaml`。可选文件缺失时使用默认配置；`--config` 显式指定的文件缺失会报错。

普通字段覆盖顺序：默认值 → 用户文件 → 项目文件 → 环境变量 → CLI 字段。嵌套字段合并，未知字段报错，密钥仅引用环境变量名称，不允许写入配置值。权限规则按来源累积，不被空数组清除；项目mode只可收紧。规则总量上限400条。

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

兼容 Chat Completions 的服务可改用 `wireApi: chat-completions`，并设置自己的模型与端点；按供应商要求选择 `maxTokensParameter: max_tokens` 或 `max_completion_tokens`，不支持 usage 流事件时设置 `includeUsage: false`。Anthropic 适配器现支持流式对话与工具调用；配置 `kind: anthropic`、实际模型名和 `ANTHROPIC_API_KEY`（自定义端点为服务根 URL，例如 `https://api.anthropic.com`）。本模块 Anthropic 只运行模拟协议测试。

需要本地代理时，可在本机 `.env.local` 添加 `NODE_USE_ENV_PROXY=1` 和对应的 `HTTPS_PROXY` 地址。对话支持总请求超时及取消，网络/429/5xx 只在首个流事件前最多重试一次。失败或取消的残缺轮次不会进入下一次模型上下文；达到上下文上限时需开始新会话。

## 检查与安装验证

```powershell
npm run check
npm run test:package
npm run bench:tools
npm run bench:agent
npm run bench:prompt
npm run bench:permissions
npm run bench:mcp
npm run bench:context
```

`check` 包括类型、lint、格式、模块边界、测试和构建。`test:package` 需要先构建，随后打包到临时目录，仅安装生产依赖，检查独立 CLI 与 `mewcode` bin，再清理临时目录；依赖未缓存时需要访问 npm registry，不会发布到 npm。

GitHub Actions 已配置 Windows/Linux + Node.js 24；远程运行结果以实际 CI 为准。

## 目标能力

流式终端对话、六个编程工具、Agent Loop、权限系统、MCP、上下文压缩、跨会话记忆、Slash Command、Skill、Hook、SubAgent、Git Worktree 和 Agent Teams。

本仓库的方案与后续代码独立设计实现。公开介绍页不包含完整付费教程或源码，文档中的补充实现方案不代表原课程内部实现。
