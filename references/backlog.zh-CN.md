# 工单队列与排期（backlog）

[English](backlog.md) | [中文](backlog.zh-CN.md)

> 用途：让「要做什么、先做什么、现在到哪」只有一个事实来源。聊天记录不是 backlog。协议见 [`../PROTOCOL.md`](../PROTOCOL.zh-CN.md)。

---

## 1. 工单字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 唯一 ID，建议 `<前缀>-<序号>`，例如 `ABC-001`；创建后不复用。 |
| `title` | 是 | 一句话可判定的标题。 |
| `intent` | 是 | 老板原话或链接到原话。 |
| `priority` | 是 | `P0`（阻塞）/`P1`（当前）/`P2`（排队）/`P3`（可延后）。 |
| `status` | 是 | 见第 2 节状态定义。 |
| `spec` | 是 | spec 路径与版本/commit。 |
| `tier` | 是 | `direct` / `standard` / `release`，见 PROTOCOL §4.7；未标注 = `standard` |
| `attempts` | 否 | 实际花掉的「派发 → 验收」轮数 |
| `ac_weakened` | 否 | AC 被改写/放宽的次数（每次都要有书面理由，见 R8） |
| `ac_count` | 否 | AC 数量，便于检查是否可判定。 |
| `dependencies` | 是 | 依赖的工单 ID；无则写 `none`。 |
| `owner` | 是 | 当前负责人（PM/工程师）。 |
| `workspace` | 是 | 独立工作区绝对路径。 |
| `branch` | 是 | 分支名。 |
| `baseline_commit` | 是 | 开工基线。 |
| `delivery_commit` | 否 | 工程师交付 commit。 |
| `verification` | 否 | 验收结论与报告路径。 |
| `evidence` | 否 | evidence 目录。 |
| `blocked_reason` | 否 | 阻塞时必须写具体原因与负责人。 |
| `updated` | 是 | UTC 时间戳。 |
| `notes` | 否 | 取舍、风险、链接。 |

## 2. 状态定义

| 状态 | 含义 | 进入条件 | 允许的下一步 |
|---|---|---|---|
| `intake` | 已接收意图，尚未有可判定 spec | 老板给出需求 | `spec-ready`、`blocked` |
| `spec-ready` | spec 完成，AC 可判定 | spec 自检通过 | `scheduled`、`blocked` |
| `scheduled` | 已排期，等待派发 | 依赖满足、工作区可用 | `dispatched`、`blocked` |
| `dispatched` | 工程师执行中 | 工作区 + 简报 + baseline 就绪 | `verifying`、`blocked`、`rework` |
| `verifying` | 独立验收中 | 交付 commit + 工程师证据 | `reported`、`rework`、`blocked` |
| `rework` | 验收 FAIL 或范围变更 | 失败项与修复方向明确 | `dispatched`、`blocked` |
| `reported` | 一页纸已交老板 | 独立验收 PASS + 一页纸 | `done`、`rework` |
| `done` | 完成 | 老板接受 + 独立验收 PASS | 终态 |
| `blocked` | 暂停 | 有具体原因、负责人和解除条件 | 回到阻塞前状态 |

**只有独立验收 PASS 才能进入 `reported`/`done`。** 工程师自述不能推动状态。

## 2.5 `nice-to-have.md`（不阻塞的偏好）

- **位置**：`.delegate/nice-to-have.md`（项目级，与 `.delegate/` 其余内容一样 gitignored）。
- **负责人**：PM。只有 PM 往里写。
- **什么时候消费**：**版本规划时**——PM 提议哪些条目升级成正式工单。
  连续两个版本周期没被升级的条目 **直接丢弃**（并记录丢弃原因）。
- **硬规则**：这个文件里的任何东西都不得导致 FAIL；反过来，PROTOCOL §3 的违规也**不得**被塞进这里。

## 3. 排期规则

1. **无 spec 不排期**：AC 不可判定的工单不能进入 `scheduled`。
2. **无 baseline 不派发**：每个工单固定 baseline commit。
3. **一单一个工作区**：任何时刻，一个可变工作区只属于一个活跃工单。
4. **WIP 限制**：同时 `dispatched` + `verifying` 的工单数不超过团队可并行验收的能力；默认建议 1–2 个，宁少勿多。
5. **优先级只决定顺序，不是时间承诺**：`P0` 可以先占资源，但不自动降低验收标准。
6. **依赖必须先完成或被显式解除**：不要「边做边等」而不记录。
7. **返工不自动插队**：返工按失败严重度和依赖关系重新排；不得为了赶进度降低 AC。
8. **阻塞必须可解除**：`blocked` 必须写原因、负责人、解除条件；没有这三项不算合法阻塞。
9. **状态变更留痕**：更新 `updated` 和一行 `notes`；不要删除历史工单。
10. **完成定义**：`done` = 独立验收 PASS + 老板接受 + 证据索引可解析。

## 4. 队列模板

| ID | 标题 | 优先级 | 状态 | spec | 依赖 | 负责人 | 工作区 | baseline | 交付 commit | 验收 | 更新时间 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `ABC-001` | <title> | P1 | `scheduled` | `<path>@<sha>` | none | `<owner>` | `<path>` | `<sha>` | - | - | `<UTC>` |
| `ABC-002` | <title> | P2 | `blocked` | `<path>@<sha>` | ABC-001 | `<owner>` | - | - | - | - | `<UTC>` |

### 阻塞记录

| 工单 | 阻塞原因 | 负责人 | 解除条件 | 更新时间 |
|---|---|---|---|---|
| `ABC-002` | <具体事实> | `<owner>` | <可观察条件> | `<UTC>` |

### 决定记录（可选，项目级）

| # | 决定 | 理由 | 影响工单 | 时间 |
|---|---|---|---|---|
| D-1 | <decision> | <why> | ABC-001 | `<UTC>` |

## 5. 一个工单的完整生命周期示例

```text
intake
  -> 写 spec（AC 可判定）
  -> spec-ready
  -> 登记 backlog，固定 baseline，创建 worktree
  -> scheduled
  -> 派发工程师，后台执行，结束本轮
  -> dispatched
  -> 工程师交付 commit + evidence
  -> 新上下文验收方在独立只读工作区重跑
  -> verifying
      -> FAIL：写返工项 -> rework -> dispatched（新 commit）
      -> PASS：一页纸汇报 -> reported
  -> 老板接受 -> done
```

## 5.5 流程审计（R7 / R8 触发器）

每个版本边界跑一次，或在一轮明显变重时跑。**这些是「该评审了」的触发器，不是禁止干活的计数器**
——固定数字绝不能替质量做决定（见 R3 / R7）。

| 信号 | 触发条件（触发评审，不是禁止） | 评审可以决定什么 |
|---|---|---|
| 文档/流程产出 vs 产物变更 | 每 1 个产物变更伴随超过 2 份流程材料（spec / 简报 / 验收 / 交接） | 合并那些不产生信息的步骤；**绝不能**删掉 V-4 或验收简报要求的材料 |
| 单工单 `ac_weakened`（只计 `broadened` 放宽） | ≥ 2 | 先重写 AC 再派发——该怀疑的是 spec，不是代码 |
| 单工单 `attempts` | ≥ 3 | 考虑重新拆分任务；记录之前拆分失败的原因 |

注意：

- 三条都**不得**被当作自动停止条件；由 PM 评审后决定。
- 「砍流程」永远不等于删掉安全材料（验收简报、工具白名单、证据）。

## 6. 排期自查

- [ ] 每个活跃工单都有唯一 ID、spec 版本、baseline commit。
- [ ] 没有两个活跃工单共用同一个可变工作区。
- [ ] 所有 `blocked` 都有原因、负责人、解除条件。
- [ ] 所有 `reported` 都有独立验收报告和一页纸。
- [ ] 没有为了通过而修改 AC 或测试期望。
- [ ] 历史工单没有被删除或覆盖。
- [ ] 队列状态与磁盘上的 `RUN.md`、evidence 一致。

---

## 7. 与交接的关系

- 工程师换人：在工单内按 [`handoff.md`](handoff.zh-CN.md) 交接，backlog 只更新 `owner` 和 `notes`。
- PM 换班：按 [`pm-handoff.md`](pm-handoff.zh-CN.md) 交接，backlog 必须作为快照被引用。
- 交接不改状态定义；状态只能由证据推动。
