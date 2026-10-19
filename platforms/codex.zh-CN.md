# Codex 平台映射

[English](codex.md) | [中文](codex.zh-CN.md)

本文件把 [`PROTOCOL.md`](../PROTOCOL.zh-CN.md) 的抽象概念映射到 OpenAI Codex CLI 原语。原则冲突时以 `PROTOCOL.md` 为准。flag 与事件字段以当前安装版本的 `codex --help` / `codex exec --help` 为准。

## 派发

### 工作区

工程师与验收方各用一个独立 worktree，并从明确 commit 启动：

```bash
git worktree add ../<repo>-<task-id>-engineer <baseline-commit>
git worktree add ../<repo>-<task-id>-verify <engineer-commit>
```

`codex exec` 是非交互入口；把简报写到主仓库的绝对路径下（`$ROOT`），用命令替换传入，避免超长内联 prompt。证据也不要写进工作区（worktree），工作区用完会被删除：

```text
$ROOT/.delegate/<TASK-ID>/engineer-brief.md
$ROOT/.delegate/<TASK-ID>/verification-brief.md
$ROOT/.delegate/<TASK-ID>/evidence/
```

审批选项 `-a/--ask-for-approval` 属于**顶层** `codex`，必须写在 `exec` **之前**；`--sandbox` 在**顶层与 `codex exec` 都声明**，不是 `exec` 专属，写在 `exec` 之前或之后都能解析；`--json`、`--output-last-message` 属于 `codex exec`，写在 `exec` 之后。`codex exec` 子命令自身不暴露审批开关。

### 工程师派发

```bash
# 证据落点必须在主仓库的绝对路径下；不要写进工作区（worktree），工作区用完会被删除。
ROOT="<主仓库绝对路径>"
EVIDENCE="$ROOT/.delegate/<TASK-ID>/evidence"
mkdir -p "$EVIDENCE"

# 执行代码仍要进入工程师工作区。
cd "$ENGINEER_WORKTREE"
codex -a never exec \
  --sandbox workspace-write \
  --output-last-message "$EVIDENCE/engineer-final.md" \
  --json \
  "$(cat "$ROOT/.delegate/<TASK-ID>/engineer-brief.md")" \
  > "$EVIDENCE/engineer-events.jsonl" \
  2> "$EVIDENCE/engineer-stderr.log"
echo "exit=$?"
```

要点：

- 工程师需要写代码和跑测试，使用 `workspace-write`；默认不要用 `danger-full-access`。`workspace-write` 是否真能写入，本版本未实测。
- `-a never` 必须放在 `exec` 之前。`--ask-for-approval` 是顶层 `codex` 的选项（取值 `untrusted` / `on-request` / `never`），写在 `exec` 之后会报 `error: unexpected argument '--ask-for-approval' found`（codex-cli 0.144.1，2026-10-18 实测）。
- 审批策略对应的 `config.toml` 键名未实测；目前只保证 CLI 形式 `-a/--ask-for-approval` 可用。`-a never` 是否真的不弹审批同样未实测，不要把「命令可解析」当成「审批已关闭」。
- 需要安装依赖或联网时，优先在派发前预置环境；若必须在任务中联网，记录具体原因与范围，不要默认放开全网。
- `--json` 的 JSONL 事件流落盘，作为过程证据；`--output-last-message` 的最终消息作为一页纸输入。
- 每个工单一个独立工作区；不要和验收方共用。

### 验收派发

```bash
# 证据落点同样必须在主仓库的绝对路径下；不要写进工作区（worktree），工作区用完会被删除。
ROOT="<主仓库绝对路径>"
EVIDENCE="$ROOT/.delegate/<TASK-ID>/evidence"
mkdir -p "$EVIDENCE"

# 执行验证仍要进入验收工作区。
cd "$VERIFY_WORKTREE"
codex -a never exec \
  --sandbox read-only \
  --output-last-message "$EVIDENCE/verifier-final.md" \
  --json \
  "$(cat "$ROOT/.delegate/<TASK-ID>/verification-brief.md")" \
  > "$EVIDENCE/verifier-events.jsonl" \
  2> "$EVIDENCE/verifier-stderr.log"
echo "exit=$?"
```

要点：

- 验收方必须用 `read-only` sandbox；只允许读取、检查和运行白名单内的验证命令。`read-only` 是否真的阻止写入，本版本未实测；需要强隔离时另加容器或独立用户。
- Codex 没有 Claude Code 那种逐工具白名单，工具边界主要由 sandbox 模式 + 审批策略 + 简报中的命令白名单共同构成。需要更细的限制时，用包装脚本只暴露允许的命令。
- 验收方的工作区基于工程师交付 commit，全新创建或只读复制；不能使用工程师正在编辑的目录。
- 验收方必须自己重跑 `verify.sh` 和 AC 对应命令，保留自己的退出码与 JSON 事件流。

### 0.144.1 中的其他可用选项

以下都由 `codex exec --help`（codex-cli 0.144.1，2026-10-18 核对）列出；具体语义以该帮助文本为准：

- `-c/--config <key=value>`：覆盖 `~/.codex/config.toml`，支持点路径；
- `-C/--cd <DIR>`：指定工作根目录；
- `--add-dir <DIR>`：在主工作区之外追加可写目录；
- `--ephemeral`：不持久化会话文件；
- `--ignore-user-config`：不加载用户 `config.toml`（认证仍读 `CODEX_HOME`）；
- `--strict-config`：遇到本版本不认识的配置字段时直接报错；
- `--enable/--disable <FEATURE>`：启用/禁用 feature flag（可重复）。

### 使用 AGENTS.md

可以在工作区放置 `AGENTS.md` 说明仓库级约束（只读材料、禁止修改的文件、测试命令）。但 **AGENTS.md 是提示，不是权限边界**；权限仍由 sandbox 和审批策略保证。

### 首次会话的欢迎屏（可选）

agent 首次采用本协议的那个会话里，可以**打印一次** [`docs/welcome.txt`](../docs/welcome.txt) 的内容，
放进**一个代码块**里。

- 每个会话只打一次，不要每轮重复；
- 必须留在代码块内，否则会折行、整块歪成噪音；
- 它只是打招呼，不是状态汇报；协议不依赖它。

## 等待与接回

### 正常路径

- `codex exec` 是**同步进程**：进程退出即完成信号。前台运行时，命令返回后直接进入验收。
- 退出码为 0 只表示进程成功结束，不表示 AC 通过；仍要独立验收。
- 接回后先读 `--output-last-message` 文件、`--json` 事件流的最后一个 `turn.completed`（事件名未实测）、以及退出码，再决定下一步。

### 后台执行

- Codex 本身没有「会话内后台任务 + 完成后唤醒模型」的原语；`codex exec` 的生命周期就是进程生命周期。
- 需要后台执行时，由**外部编排器**负责：
  - shell：`nohup codex exec ... &`，在编排脚本里 `wait $!`，然后启动验收；
  - systemd / CI / 任务队列：以进程退出事件触发下一步。
- 可以配置 Codex 的 `notify` hook，在 `agent-turn-complete` 等事件发生时调用外部脚本。它适合写唤醒文件、发通知、触发编排器，**但不会恢复一个已经结束的 Codex 会话**。`notify` hook 是否存在、`agent-turn-complete` 事件名是否拼写正确，均未实测，且随版本变化。
- 手动恢复：读 `RUN.md`、handoff、事件流；确认进程是否仍在；无人值守恢复用 `codex exec resume --last`（非交互；0.144.1 中位于 `exec` 之下），或新会话从磁盘状态继续。顶层还提供 `codex resume`（交互式 picker，供人手动挑选会话，不适合无人值守），两者不要混淆。不要假设上一轮已完成。
- 超时：用外部 `timeout` 包裹，例如 `timeout 30m codex exec ...`；退出码 124 视为超时，保留日志并终止。
- **禁止轮询**：不要 `sleep` 循环、反复 tail 事件流、反复查询进程来伪装等待。违反 V-1。

## 上下文余量

### 怎么读

- `codex exec --json` 的 `turn.completed` 事件（事件名未实测）通常包含本轮 usage（如输入 token、输出 token、缓存命中 token）。这是**本轮结束后的统计**，不是实时剩余量。
- 上下文窗口来自模型元数据或 `config.toml` 中的 `model_context_window` 一类配置（键名未实测）。**不要自己猜一个数**；读不到就标记为不可用。
- 审批策略由顶层 `-a/--ask-for-approval` 控制；对应的 `config.toml` 配置键名未实测，不要照猜键名写配置。
- 估算方法：`最近一轮 input_tokens / 已知上下文窗口` 可以作为占用比例的粗略下界/估计，但系统提示、工具定义、缓存等会带来偏差，必须标注「估算」。
- TUI 的 `/status` 等界面可以给人看用量；不要假设模型能以编程方式读取同样的实时数字。

### 读不到时怎么降级

1. 以阶段为单位落盘：每完成一个 AC/阶段写 `RUN.md` 与 handoff 草稿。
2. 每次 `codex exec` 都保留 JSONL 事件流；换会话时只读摘要、最后事件和证据索引。
3. 长任务拆成多次短执行；每次结束后根据磁盘状态决定继续或换班。
4. 在 `RUN.md` 写 `capability.context_remaining: estimated` 或 `unsupported`，并提前交接。
5. 不要把上下文窗口配置（`model_context_window`，键名未实测）调大来「解决」上下文问题；窗口是模型能力，不是可用预算。

## 已知不支持的能力

- **会话内后台任务 + 完成唤醒**：`codex exec` 是进程级同步执行；没有内建的「结束后唤醒已结束会话」机制。
- **`notify` 作为恢复机制**：`notify` 只能触发外部命令，不能恢复会话；hook 与事件名（如 `agent-turn-complete`）的存在性、拼写未实测，且随版本变化。
- **`codex exec` 子命令不暴露审批开关**：`-a/--ask-for-approval` 是顶层 `codex` 的选项（取值 `untrusted` / `on-request` / `never`），写在 `exec` 之后会报 `error: unexpected argument '--ask-for-approval' found`。派发脚本必须把审批 flag 放在子命令**之前**：`codex -a never exec …`（codex-cli 0.144.1，2026-10-18 实测）。
- **内建子代理/角色编排**：没有 Task 式子代理原语；工程师与验收方需要由外部编排器启动为独立进程/会话。
- **细粒度工具白名单**：没有逐工具 allow/deny 的稳定原语；主要依赖 `--sandbox`、审批策略和命令包装脚本。
- **实时上下文百分比**：只有回合结束后的 usage 与配置中的窗口大小；无法精确知道当前剩余。
- **只读即保密**：`read-only` sandbox 是否真的阻止写入未实测；即使生效，也不隐藏工作区内的敏感文件；需要保密时用容器、独立用户或凭据隔离。
- **网络与平台一致性**：sandbox 的网络策略、路径限制和审批行为随平台/版本变化，不能假定跨平台一致。
- **内建队列、锁、worktree 管理**：backlog、互斥与工作区生命周期由文件和外部脚本负责。
- **跨机器/跨版本恢复**：`codex exec resume` 的可用性、子命令位置与会话存储位置随版本变化，不保证可迁移。
- **自动 AC 判定**：AC 仍需外部 `verify.sh` 或明确命令来判定；进程退出码不等于验收通过。
