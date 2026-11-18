# 运行证据：启动记录、终态、恢复判断

目标：任何一次后台任务，**在 owner 轮次结束之后仍然可判断**——它是否启动、是否还在跑、结束成什么样。
没有这些记录时，`unknown job` 只能靠猜，而"猜"会导致重跑、虚填退出码、或把失败当成功。

## 1. 启动即落盘（launch record）

派发成功后**立刻**写，再结束本轮。缺任何一项都不算"已派发"：

| 字段 | 说明 |
|---|---|
| `owner` | 发起者身份：会话 / agent / 子 agent ID，以及 attempt 编号 |
| `role` | PM 明确分配的 engineer / verifier / scribe；普通命令不得自动填 engineer |
| `context_policy` | 工程师首次 new、后续 resume/handoff；正式验收只能 fresh |
| `session_id` / `lineage` | 实际会话及实施链路，续接用明确 ID，换人注明来源 |
| `target_revision` | 验收必须绑定准确交付版本 |
| `job_id` / `agent_id` | 宿主返回的真实标识；**两者不是一回事，不得混用** |
| `argv` | 实际执行的完整命令（flags 全记；**凭据不记**） |
| `cwd` | 工作目录绝对路径 |
| `pid` / `pgid` | 父子进程号与进程组；宿主不提供时写 `unavailable`，不要编 |
| `started_utc` | UTC 时间戳 |
| `started_monotonic` | 同 boot 的单调时钟（用于跨时区/校时判断时长） |
| `stdout_path` / `stderr_path` | 输出落盘的**绝对**路径（不要写进会被删除的 worktree） |
| `expected_terminal` | 完成后应当出现的终态文件/收据路径 |

## 2. 结束即落盘（terminal record）

任务结束时（成功、失败、超时、取消、异常都算）写一条结构化终态记录。进程 success 不是验收 PASS；验收结论另外绑定本轮 verifier 和交付版本：

| 字段 | 说明 |
|---|---|
| `ended_utc` / `ended_monotonic` | 结束时点 |
| `exit` | **真实退出码**；拿不到就写 `null`，**不得用日志里的错误码冒充** |
| `outcome` | `success` / `failed` / `timeout` / `cancelled` / `error` / `unknown` |
| `stdout_sha256` / `stderr_sha256` | 输出文件哈希，便于证明"我看到的是当时那份" |
| `terminal_seen` / `collected` | 终态是否被看到、是否被收取 |

## 3. 允许"终态未知"，禁止伪造

- 异常中断时，唯一诚实的记录是 `outcome: unknown` + `terminal_seen: false` + `exit: null`。
- **不得**为了"闭环"补一个 `exit: 0`，也不得把 curl/工具内部的错误码写成进程退出码。
- `unknown` 不是失败，也不是成功；它要求下一次取证，而不是重跑。

## 4. 恢复判断的顺序（不许跳）

1. 读 launch record + terminal record：有终态就以终态为准。
2. 没有终态但有 `pid/pgid`：核对**进程身份**（argv、启动时间、父进程），确认是同一个任务后才谈探活；
   只凭历史 PID 就发信号是危险的（PID 会被复用）。
3. 没有终态也没有 PID：只能标 `unknown`，并保留现场（partial 文件、日志）。
4. `unknown job`（宿主查不到 ID）：按**归属丢失**处理——不重派、不删现场、不假设失败或完成；
   先固定证据（文件大小、mtime、日志尾部），再决定是否需要人工介入。

## 5. 与待命模式的关系

- 待命（结束本轮等完成事件）要求：launch record 已落盘、宿主承诺完成投递、owner 会话仍存活。
- 三者缺一，就不能声称"已派发并在等待回调"；必须写明限制（见 `dispatch.md` §4）。
- 轮次结束不等于业务完成；阶段性收尾也不得写成 `outcome: success`。
