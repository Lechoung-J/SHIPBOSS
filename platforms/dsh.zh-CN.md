# DSH 平台映射

[English](dsh.md) | [中文](dsh.zh-CN.md)

本文件把 [`PROTOCOL.md`](../PROTOCOL.zh-CN.md) 的抽象概念映射到 DSH 宿主原语。**这是全仓库唯一允许出现 DSH 专有标识的文件。** 原则冲突时以 `PROTOCOL.md` 为准；原语细节以本文件为准。

先声明：DSH 的能力会随版本和配置变化。下面写的是本协议依赖的用法；实际执行前把版本、配置和「不支持项」记录到 `RUN.md`。

## 派发

### 工作区

工程师和验收方各用一个独立工作区，均从明确的 commit 创建：

```bash
git worktree add ../<repo>-<task-id>-engineer <baseline-commit>
git worktree add ../<repo>-<task-id>-verify <engineer-commit>
```

把工单 ID、工作区绝对路径、baseline commit、目标 commit 写进 `RUN.md`。禁止两个角色共用同一个可变工作区。

### 子代理原语

先核验可用性，再选路径。下表把「本宿主真实存在的原语」与「依赖宿主后端安装、本机不一定可调用的原语」分开列出：

| 原语 | 语义 | 适用场景 | 可用性 |
|---|---|---|---|
| `subagent` | 启动一个全新上下文的子代理 | 工程师、独立验收方 | ✅ 本宿主存在；验收用它拿全新上下文 |
| `subagent_fork` | 从当前会话分叉，继承当前上下文 | 同一工单的阶段延续、上下文内咨询 | ✅ 存在；**禁止用于独立验收**（上下文不独立） |
| `subagent_codex` | 以独立上下文启动 Codex CLI 作为子代理 | 工程师、独立验收方（仅在后端安装后） | ⚠️ **本版本未安装**，取决于宿主后端安装；不要当作可直接调用的原语 |
| `subagent_claude_code` | 以独立上下文启动 Claude Code 作为子代理 | 工程师、独立验收方（仅在后端安装后） | ⚠️ **本版本未安装**，取决于宿主后端安装；不要当作可直接调用的原语 |

选择规则：

- **默认走「CLI 工程师 + 后台 job」**（见下一节）。这是本仓库多次实际派发验证过的路径，不依赖任何子代理后端。
- 只有在使用者确认宿主已安装 Codex / Claude Code 子代理后端后，才可考虑 `subagent_codex` / `subagent_claude_code`；二者在本版本**未安装**，不确定时一律回退到 CLI + 后台 job。
- 需要宿主内一键派发时，用真实存在的 `subagent`；它给的是全新上下文，适合独立验收。
- `subagent_fork` 只用于「接着做」；它继承上下文和可能的偏见，不能作为验收独立性的实现。

示意调用见下面两条路径。**不要照抄任何本文标注为「未安装」的原语。**

### 路径 A：CLI 工程师 + 后台 job（实测可用）

适用：外部编排、需要可复现的命令、需要完整 stdout/stderr 落盘、或宿主没有安装子代理后端。做法是把 CLI 命令作为**后台 job** 提交（宿主的 `run_in_background` 机制），命令退出码和结果文件落盘，再用 `job_output` 接回。

```bash
# 证据落点必须在主仓库的绝对路径下；不要写进你的 worktree，工作区用完会被删除。
ROOT="<主仓库绝对路径>"
EVIDENCE="$ROOT/.delegate/<TASK-ID>/evidence"
mkdir -p "$EVIDENCE"

# 执行代码仍要进入工程师工作区。
cd "$ENGINEER_WORKTREE"

# 待派发的简报；Claude 与 Codex 两条命令共用同一份 prompt。
BRIEF="$(cat "$ROOT/.delegate/<TASK-ID>/engineer-brief.md")"

# 作为后台 job 提交，不要在前台阻塞本轮。
# bypassPermissions 只是为了让工程师能跑测试和提交；生产默认不要照抄此权限选项。
printf '%s' "$BRIEF" | env ANTHROPIC_BASE_URL="$ANTHROPIC_BASE_URL" \
  ANTHROPIC_AUTH_TOKEN="$ANTHROPIC_AUTH_TOKEN" \
  ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude -p --bare --model <model> --output-format json \
    --max-turns 50 --permission-mode bypassPermissions \
    > "$EVIDENCE/engineer-result.json" \
    2> "$EVIDENCE/engineer-stderr.log"  # --max-turns 未列入 claude --help，实测可解析

# 若本机安装的是 Codex，用 codex exec；具体参数以本机版本 --help 为准。
codex -a never exec --sandbox workspace-write \
  "$BRIEF" \
  > "$EVIDENCE/engineer-result.json" \
  2> "$EVIDENCE/engineer-stderr.log"
```

要点：

- 本示例的 flag 以本机 `claude --help` 为准；`--max-turns` 等未列入 help 但仍被解析的 flag 以实测为准；`--bare` 下 anthropic 认证严格限定为 **`ANTHROPIC_API_KEY` 或 `apiKeyHelper`（经 `--settings` 传入）** 二者之一，`ANTHROPIC_AUTH_TOKEN` 不能单独替代它；本仓库实际派发脚本同时给出 `ANTHROPIC_AUTH_TOKEN` 与 `ANTHROPIC_API_KEY`，与本示例等价。
- `--bare` 会跳过 hooks、LSP、plugin 同步和 `CLAUDE.md` 自动发现，只保留最小 CLI 行为；不要指望它加载项目内的 hooks/插件配置。若改用不带 `--bare` 的配方（早期版本实测过），这些自动发现会恢复，认证方式与 flag 也随 `claude --help` 变化，差异需自行核对。
- `codex exec` 的回退行用顶层 `-a never` 关闭审批、用 `--sandbox workspace-write` 允许在工作区内写文件；具体参数仍以本机版本 `--help` 为准。
- 命令在工程师工作区执行，工作区与 baseline commit 先按「工作区」一节建好。
- `engineer-result.json`、`engineer-stderr.log` 和退出码写入 `RUN.md` 与 `$EVIDENCE`（即主仓库下的 `.delegate/<TASK-ID>/evidence/`），不要只留在终端，也不要写进会被删除的 worktree。
- 后台 job 的 ID（形如 `bash-3537`）是接回任务的唯一凭据。

### 路径 B：宿主内子代理（取决于后端安装）

适用：宿主已提供可用的子代理后端，需要一键派发、不想自己管理 CLI 进程与环境变量。

- 若使用者确认后端已安装，可按宿主文档调用对应的 Codex / Claude Code 子代理；本机这两个原语**未安装**，本文不提供可直接照抄的调用示例。
- 独立验收优先用 `subagent`（全新上下文）；不要用 `subagent_fork` 代替。
- 参数名以当前宿主为准，本文不伪造未经验证的参数。

两条路径的取舍：**CLI + 后台 job** 适合外部编排、可复现和跨会话恢复；**宿主内子代理** 适合宿主内一键派发。后端未安装或无法确认时，只能走前者。

### 后台 job

长时间构建、测试、批量命令放后台 job：

- 派发后记录返回的 job ID（形如 `bash-3537`），写入 `RUN.md` 的 `job` 字段。
- 用 `job_output` 读取该 job 的输出；读取时只取最终结果或尾部若干行，完整输出落盘到 `$ROOT/.delegate/<TASK-ID>/evidence/`。
- 用 `job_list` 查看当前 job 清单，用 `job_kill` 取消失控或不再需要的 job；取消后保留已产生的日志和退出原因。
- 派发后**结束本轮**，不要在同一个回合里反复 `job_output`。

### 完成投递与唤醒上限（宿主配置项）

- `completionDelivery`、`maxConsecutiveWakes` 都是**宿主配置项，agent 侧无法验证**：本文不把它们写成可执行指令，是否存在、叫什么名字、如何开启均需由使用者在本机确认。
- 若使用者确认宿主提供完成投递（`completionDelivery` 生效）：任务结束（成功、失败或取消）时，宿主可能把状态与结果投递回当前会话，形成一次唤醒；agent 侧无法验证该行为是否真的发生。
- 若使用者确认宿主提供唤醒上限（`maxConsecutiveWakes` 生效）：每次唤醒都应是一次明确决策（验收、返工、汇报），不是继续无脑等待；达到上限后不再自动唤醒，由 PM 手动接手或启动换班。该配置的实际取值与语义 agent 侧无法验证。
- 若宿主没有上述能力：不要假设会自动接回，改走外部编排器或前台阻塞（见「没有完成投递时」）。

### 工程师简报

简报落盘为 `$ROOT/.delegate/<TASK-ID>/engineer-brief.md`，至少包含：

- spec 路径与版本、baseline commit、工作区绝对路径；
- 交付物与 AC；
- 只读源材料；
- 必须落盘的证据路径与报告格式；
- 禁止事项（改 AC、改只读材料、共用工作区）。

### 首次会话的欢迎屏（可选）

agent 首次采用本协议的那个会话里，可以**打印一次** [`docs/welcome.txt`](../docs/welcome.txt) 的内容，
放进**一个代码块**里。

- 每个会话只打一次，不要每轮重复；
- 必须留在代码块内，否则会折行、整块歪成噪音；
- 它只是打招呼，不是状态汇报；协议不依赖它。

## 等待与接回

### 正常路径

1. 派发前与使用者确认宿主是否提供完成投递（`completionDelivery` 是宿主配置项，agent 侧无法验证）；同时确认 job ID 会写回 `RUN.md`。若宿主不提供，改用外部编排器或前台阻塞。
2. 后台派发工程师任务：默认走「CLI 工程师 + 后台 job」，确有必要且后端可用时走宿主内 `subagent`。
3. **结束本轮**。不查询状态、不 sleep、不反复读输出、不使用阻塞等待。
4. 收到完成投递（唤醒）后，从消息中取出 job ID、退出状态、结果文件路径。
5. 只读最终结论与证据索引；需要细节时按路径读取，不把完整日志拉进上下文。
6. 进入独立验收。若状态为失败或取消，按失败路径处理并保留证据。

### Stop 之后恢复

会话被停止、用户中断或宿主重启后：

1. 先读 `RUN.md` 与最近的 handoff，不要依赖对话记忆。
2. 对记录的 job ID 调用一次 `job_output`，确认它是运行中、已完成还是已丢失。
3. 若任务已无意义或工作区已污染，调用 `job_kill`，丢弃该工作区，从最后合规 commit 重开。
4. 绝不假设「应该已经完成」；以 job 状态和 commit 为准。
5. 恢复动作和结论写回 `RUN.md`。

### 没有完成投递时

- 若宿主未提供 `completionDelivery` 或该能力不可用（宿主配置项，agent 侧无法验证）：改为前台阻塞执行（`background=false`），或由外部编排器在进程退出后启动下一轮。
- 若只能后台执行又没有投递：明确写 `capability.completion_callback: unsupported`，要求人工唤醒，或改用前台。
- **禁止**用轮询模拟回调：连续调用 `job_output`、`sleep` 循环、反复查询状态都算违反 V-1。
- 唤醒上限：`maxConsecutiveWakes` 若由宿主提供（宿主配置项，agent 侧无法验证），耗尽后视为「已停止」，由 PM 决定继续、换班或终止；不要无限续 wake。

## 上下文余量

### 怎么读

- 优先使用宿主当前版本提供的会话状态/用量字段；把读数、读取时间和来源记录到 `RUN.md`。
- 部分版本会在 `~/.dsh` 下保存会话状态或统计文件。它们**不是稳定 API**：格式随版本变化，只可作为估算依据，不能作为精确合同。
- PM 在每个阶段边界记录一次：已完成阶段、当前 AC、剩余预算估计、下一次交接点。
- 工程师子代理的上下文消耗不计入 PM 的预算；派发新子代理会得到新上下文，但不要让 `subagent_fork` 继承脏上下文来完成需要清醒判断的工作。

### 读不到时怎么降级

1. 改用**阶段检查点**：每完成一个 AC 或一个阶段，写一次状态与 handoff 草稿。
2. 使用保守的固定轮次/唤醒次数阈值；达到阈值就交接，不等到报错或遗忘。
3. 需要长任务时，把工作拆成多个短子任务，每个子任务结束都落盘。
4. 交接后启动新的 PM 上下文，只从磁盘恢复；不要用 `subagent_fork` 假装「重置」。
5. 在 `RUN.md` 标注 `capability.context_remaining: unsupported`，让老板知道换班可能偏早或偏晚。

## 已知不支持的能力

- **Codex / Claude Code 子代理后端不一定安装**：本宿主未安装时 `subagent_codex` / `subagent_claude_code` 不可用（本机即为未安装），必须回退到「CLI 工程师 + 后台 job」。
- **稳定的上下文余量 API**：没有保证可读的剩余上下文百分比；`~/.dsh` 下的文件可能随版本变化，只能估算。
- **真正的独立上下文分叉**：`subagent_fork` 继承当前上下文，不能用于独立验收；验收必须另起新上下文。
- **无条件完成回调**：自动唤醒依赖宿主提供并正确配置 `completionDelivery`（宿主配置项，agent 侧无法验证）；关闭、配置错误或宿主异常时不会自动接回。
- **无限唤醒链**：`maxConsecutiveWakes` 若由宿主提供（宿主配置项，agent 侧无法验证）会截断长链；不能把自动唤醒当成无限后台执行。
- **运行中的完整输出**：后台 job 的中间输出可能有缓冲、截断或延迟；只有最终结果和落盘文件可靠。
- **默认只读隔离**：DSH 不保证子代理天然只读；权限沙箱和工具白名单必须显式配置并验证，否则验收方可能拥有写权限。
- **强制的工具白名单**：工具边界取决于当前配置；不能假定「派给验收方」就自动限制了工具。
- **分布式调度与跨机锁**：没有内建的跨机器队列/锁；backlog 和互斥由文件与人工纪律保证。
- **自动工作区清理**：worktree 和临时目录需要手动回收。
- **跨会话自动恢复**：停止后不会自动知道任务意图；必须读 `RUN.md` 和 handoff。
