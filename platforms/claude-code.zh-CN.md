# Claude Code 平台映射

[English](claude-code.md) | [中文](claude-code.zh-CN.md)

本文件把 [`PROTOCOL.md`](../PROTOCOL.zh-CN.md) 的抽象概念映射到 Claude Code 原语。原则冲突时以 `PROTOCOL.md` 为准。具体 flag 以当前安装版本的 `claude --help` 为准；`--max-turns` 等未列入 help 但仍被解析的 flag 以实测为准；下面给出的是本协议推荐的稳定用法。

## 派发

### 工作区

工程师与验收方各用一个独立 worktree：

```bash
git worktree add ../<repo>-<task-id>-engineer <baseline-commit>
git worktree add ../<repo>-<task-id>-verify <engineer-commit>
```

简报和输出都落盘到主仓库的绝对路径下（`$ROOT`），不把长篇 brief 直接塞进父会话；证据不要写进工作区（worktree），工作区用完会被删除：

```text
$ROOT/.delegate/<TASK-ID>/engineer-brief.md
$ROOT/.delegate/<TASK-ID>/verification-brief.md
$ROOT/.delegate/<TASK-ID>/evidence/
```

### 交互式：Agent / Task 子代理

- 用 **Agent 工具**（旧版本叫 Task 工具）派一个子代理，`subagent_type` 选 `general-purpose`；只读探索可用 `Explore` 或 `Plan`。
- 把简报文件路径交给子代理，要求它先读 spec 再动手。
- 子代理在工程师工作区里执行，提交 commit，并把报告写到 evidence 路径。
- 验收必须新开一个 Agent 调用；不要把实现过程、工程师自我评价或父会话的推理作为验收输入。父会话只传：spec、交付 commit、验收简报、证据路径。

示意：

```text
Agent(
  subagent_type = "general-purpose",
  description   = "TASK-001 engineer",
  prompt        = "先读 $ROOT/.delegate/TASK-001/engineer-brief.md，然后在 <engineer-worktree> 执行，并把证据写到 $ROOT/.delegate/TASK-001/evidence/。"
)
```

### 无头 CLI：`claude -p`

适合由外部脚本或编排器派发：

```bash
# 证据落点必须在主仓库的绝对路径下；不要写进工作区（worktree），工作区用完会被删除。
ROOT="<主仓库绝对路径>"
EVIDENCE="$ROOT/.delegate/<TASK-ID>/evidence"
mkdir -p "$EVIDENCE"

# 执行代码仍要进入工程师工作区。
cd "$ENGINEER_WORKTREE"
claude -p "$(cat "$ROOT/.delegate/<TASK-ID>/engineer-brief.md")" \
  --allowedTools "Read" "Grep" "Glob" "Bash" "Edit" "Write" \
  --permission-mode acceptEdits \
  --output-format json \
  --max-turns 50 \
  > "$EVIDENCE/engineer-result.json" \
  2> "$EVIDENCE/engineer-stderr.log"  # --max-turns 未列入 claude --help，实测可解析
echo "exit=$?"
```

示例的前提与边界（PM 于 2026-10-18 在 Claude Code 2.1.251 实测）：

- `--permission-mode acceptEdits` 只覆盖文件编辑：能读写文件、能跑只读命令（如 `echo`、`git log`）；但**不能**跑会写文件的脚本、不能 `git add/commit`。上面示例的 `--allowedTools` 已显式包含 `Bash`，那是工具级的整包放开，详见下面的[降级路径](#工程师无法自检或无法提交时)。
- `--allowedTools` 是 **variadic**（help 中写作 `<tools...>`）：若把 prompt 位置参数紧跟在它后面，prompt 会被当成工具名吞掉，报 `Error: Input must be provided either through stdin or as a prompt argument when using --print`，退出码 1，且不产生任何 JSON。正确写法是 prompt 走 `stdin`（`printf '%s' "$BRIEF" | claude -p --permission-mode acceptEdits --allowedTools "Bash" ...`），或确保 `--allowedTools` 后面紧跟另一个 flag 而不是 prompt。

验收方用受限工具集（语法以当前版本为准）：

```bash
# 证据落点同样必须在主仓库的绝对路径下；不要写进工作区（worktree），工作区用完会被删除。
ROOT="<主仓库绝对路径>"
EVIDENCE="$ROOT/.delegate/<TASK-ID>/evidence"
mkdir -p "$EVIDENCE"

# 执行验证仍要进入验收工作区。
cd "$VERIFY_WORKTREE"
claude -p "$(cat "$ROOT/.delegate/<TASK-ID>/verification-brief.md")" \
  --allowedTools "Read" "Grep" "Glob" "Bash(git diff:*)" "Bash(git show:*)" "Bash(bash .delegate/<TASK-ID>/verify.sh)" \
  --disallowedTools "Edit" "Write" "NotebookEdit" \
  --permission-mode default \
  --output-format json \
  --max-turns 30 \
  > "$EVIDENCE/verifier-result.json" \
  2> "$EVIDENCE/verifier-stderr.log"  # --max-turns 未列入 claude --help，实测可解析
```

补充约束：

- `--permission-mode plan` 可作为额外只读层，但它会限制执行能力；需要跑测试时不要只依赖 plan 模式。
- `--allowedTools` / `--disallowedTools` 是工具级控制，不等于文件系统只读；验收工作区本身应使用只读副本或独立 worktree。
- `--output-format json` 的结果文件是验收证据的一部分，不要只保留人类可读摘要。

### 工程师无法自检或无法提交时

headless `-p` 没有审批应答方。如果派发配置不让工程师执行写副作用命令，工程师既跑不了 `verify.sh`，也提交不了；按风险从低到高可选：

- **窄白名单**：做法——在 `--permission-mode acceptEdits` 之外加 `--allowedTools "Bash"`，并让 prompt 走 `stdin`（`printf '%s' "$BRIEF" | claude -p ... --allowedTools "Bash"`），避开 variadic 吞参数坑；PM 于 2026-10-18 在 2.1.251 实测可跑 `verify.sh`（`ALL GREEN (exit 0)`）并成功提交。代价与风险——这是**工具级**放开整个 Bash，不是命令级白名单；命令级写法（如 `Bash(git *)`）**未测**。适用场景——隔离 worktree 内、信任简报来源的常规自检。
- **`--permission-mode bypassPermissions`**：做法——派发时直接使用该模式，工程师可跑 `verify.sh`、可提交（实测）。代价与风险——审批全关，任何命令都能执行；只应在一次性隔离的 worktree 或容器里用，**不得作为默认**。适用场景——短时、可丢弃的一次性工作区。
- **代跑**：做法——工程师只交付文件变更，由 PM 机械提交，验收方在干净工作区代跑验证并把输出与退出码落盘。代价与风险——工程师失去反馈回路，返工变慢；证据归属必须写清：工程师**不得**声称自己跑过测试或给出自己没跑过的退出码，报告中要显式标注「未自检」，否则违反协议铁律一（工程师自述不是证据 / 证据必须可复查）。适用场景——宿主无法放开 Bash，或组织策略禁止 headless 执行写命令。
- **外部编排器代跑**（可选）：做法——编排器在工程师结束后机械提交并代跑 `verify.sh`，把完整输出与退出码写回 `$ROOT/.delegate/<TASK-ID>/evidence/`，供工程师下一轮读取。代价与风险——多一层脚本与状态同步；回传结果仍须验收方重跑。适用场景——多工单批量派发、需要统一收集退出码。

### 首次会话的欢迎屏（可选）

agent 首次采用本协议的那个会话里，可以**打印一次** [`docs/welcome.txt`](../docs/welcome.txt) 的内容，
放进**一个代码块**里。

- 每个会话只打一次，不要每轮重复；
- 必须留在代码块内，否则会折行、整块歪成噪音；
- 它只是打招呼，不是状态汇报；协议不依赖它。

## 等待与接回

### 正常路径

1. **Agent / Task 子代理**：父会话的这次工具调用会阻塞到子代理结束，返回值就是接回点。这是交互式 Claude Code 中最可靠的「完成回调」。
2. **`claude -p`**：进程退出就是完成信号。前台运行时，命令返回后继续下一轮；后台运行时，交给外部编排器等待进程并启动验收。
3. 接回后先读结果文件末尾、退出码和 evidence 索引，再决定验收或返工。

### 后台与唤醒

- Bash 工具的 `run_in_background` 会返回 shell ID，但 Claude Code **不保证**在父会话结束本轮后把「后台进程已完成」作为新消息唤醒模型。若本轮结束，可能没有任何自动接回。
- 因此：
  - 需要后台执行时，优先由**外部编排器**管理：脚本启动 `claude -p`，用 shell `wait` 或进程退出事件触发下一步；下一步可以再启动一个 `claude -p` 并传入交接文件。
  - 或者使用同步的 Agent 调用，不要结束本轮。
  - 只有在当前宿主明确投递完成通知时，才可以把后台任务当成有回调；否则在 `RUN.md` 写 `capability.completion_callback: unsupported`。
- Hooks（如 `Stop`、`SubagentStop`、`Notification`）可以调用外部脚本，但 hook **不会自行恢复一个已经结束的模型回合**；它适合触发外部编排器或写唤醒文件。
- 手动恢复：读 `RUN.md` 和 handoff；检查进程是否还在；用 `claude --resume <session-id>` 或新会话从磁盘状态继续。不要假设上一轮已完成。
- **禁止轮询**：不要用 `sleep` 循环、反复 `BashOutput` 查询、反复读日志来「等」后台任务。违反 V-1。

## 上下文余量

### 怎么读

- `/context` 命令面向使用者，展示当前上下文占用；**模型不能稳定地以编程方式读取剩余百分比**，不能把它当作自动阈值信号。
- `claude -p --output-format json` 会在结束时给出本次运行的 usage（输入/输出 token 等）。这是**运行结束后的统计**，不是运行中的实时余量。
- 子代理有独立上下文；父会话看不到子代理的实时 token 消耗。

### 读不到时怎么降级

1. 采用阶段检查点：每完成一个 AC/阶段，写 `RUN.md` 和 handoff 草稿。
2. 用 `--max-turns`（未列入 `claude --help`，实测可解析）限制单次运行规模；到上限就落盘并换新会话。
3. 在阶段边界主动换班：不要等到自动压缩发生。自动压缩后的摘要是有损的，恢复时重读 spec、backlog、证据。
4. 上下文策略阈值（60% 规划、75% 执行、85% 停止接新活）在 Claude Code 中只能作为**人工估计**；读不到就提前交接。
5. 记录 `capability.context_remaining: unsupported` 或 `estimated`，不要伪造精确值。

## 已知不支持的能力

- **跨回合的后台完成唤醒**：没有内建的「后台任务结束后自动唤醒已结束会话」保证；`run_in_background` 的 shell ID 不是完成回调。
- **模型可读的实时上下文余量**：`/context` 是人类界面；JSON usage 只在运行结束后可得。
- **文件系统级只读**：工具白名单和权限模式限制的是工具调用，不是所有读写路径；验收方仍可能读取敏感文件。需要强隔离时使用容器、只读挂载或独立用户。
- **子代理作为安全边界**：子代理不是不可信代码的沙箱；它可能继承父会话的部分权限与环境。不要用子代理执行不受信任的代码。
- **内建持久队列/调度器**：没有跨会话的 backlog 与锁；排期由文件（如 `references/backlog.md`）维护。
- **自动 worktree 生命周期管理**：创建、清理、锁都需要人工或外部脚本。
- **嵌套子代理的稳定契约**：可用深度与行为随版本/配置变化，不能假定任意层级都能派发。
- **hook 恢复会话**：hook 能触发外部动作，但不能替你把已经结束的对话「叫醒」。
- **headless `-p` 下需要审批的 Bash 命令会被直接拒绝**：`-p` 没有审批应答方，需要审批的命令不会挂起等待，而是立即失败并报 `This command requires approval`（重试耗尽后以 `error_max_turns` 结束）。`--permission-mode acceptEdits` 只覆盖文件编辑，不覆盖有写副作用的 Bash 命令（`git add` / `git commit`、`touch`、写临时文件的测试脚本）：工程师因此跑不了会写临时文件的 `verify.sh`，也不能 `git add/commit`；只读命令（`echo`、`git log`）仍可执行。另有与权限模式无关的工作目录边界，越界时报 `Claude Code may only create or modify files in the allowed working directories for this session: '<cwd>'`。（PM 于 2026-10-18 在 Claude Code 2.1.251 实测。）
