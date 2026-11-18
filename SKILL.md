---
name: shipboss
description: >
  MUST USE 当用户要把想清楚的部分交给外部编码 agent（Codex / Claude Code）实施，
  而本会话只负责定义需求、排期与验收时 — e.g. 让 Codex 去写 / 派给 Codex /
  交给 Claude Code 实现 / 帮我盯着这个改动 / 验收一下 Codex 的产出 /
  并行推进多个项目 / 帮我省认知带宽 / 别让我读一堆 diff。

  Also use when the user frames themselves as 出想法的人/老板 while the agent
  acts as 产品经理 / 验收方 / 技术判断方.

  NOT for: 本会话直接写代码的普通任务；没有外部实施者的单纯代码审查；纯讨论不落地。
metadata:
  version: 4
---

# Shipboss — 派发与验收协议

## 首次加载先执行

这是 Shipboss 本地协议与观察窗入口。
先识别当前宿主，再执行对应分支。
将命令中的 Skill 目录换成本文件所在的实际目录。
外部宿主不要执行 DSH 分支。

Codex 使用宿主真实线程变量：

```bash
bash <本SKILL所在目录>/scripts/observer.sh start --project "$PWD" \
  --harness codex --owner-session "$CODEX_THREAD_ID" --context-id "$CODEX_THREAD_ID"
```

Claude 使用 Skill 的官方会话变量替换：

```bash
bash <本SKILL所在目录>/scripts/observer.sh start --project "$PWD" \
  --harness claude --owner-session '${CLAUDE_SESSION_ID}' --context-id '${CLAUDE_SESSION_ID}'
```

DSH 使用当前主会话变量：

```bash
bash <本SKILL所在目录>/scripts/observer.sh start --project "$PWD" \
  --harness dsh --owner-session "$DSH_SESSION_ID"
```

Codex 的 CODEX_THREAD_ID 来自宿主，与官方 thread.started 对照。
Claude 的变量由 Skill 内容替换，未必是 bash 环境变量。
若本机尚未完成替换校准，或值为空/仍是占位文本，报告身份缺失。
不要生成 UUID，不借用 DSH_SESSION_ID。
外部身份最终由 writer 核对官方 journal，CLI 名称不授予角色。

external start 默认只写有界元数据请求，返回 queued=true、shown=false。
现有 helper 和 writer 就绪后，首次加载才请求显示一次。
同项目/context 重复加载保持隐藏。显式 show 可恢复窗口。
缺 helper 时报告冷启动条件，由用户从正常 OS 入口先启动一次。
不要求修改沙箱、全局审批或认证配置。

身份和业务派发遵循下面完整协议。
启动与安装条件见 `references/observer-bootstrap.md`。


**角色**：用户是老板，本会话是 PM。工程师负责实现并保留实现上下文；验收员每轮从全新上下文独立检查交付；记录员提取和合并有来源的讨论。
角色由派发职责决定，Codex、Claude Code、DSH 子代理和后台命令只是载体。详见 `references/roles-context.md`。

**核心主张**：老板的认知带宽是唯一稀缺资源。本协议的一切设计都服务于
「让老板只读一页纸，且这一页纸是可信的」。

## 两条铁律

1. **工程师的自述不是证据。** 工程师说「已完成、测试通过」→ 可信度为零。
   证据只能来自你自己跑出来的命令输出、和你自己读过的 diff。
2. **验收必须独立。** 不复用工程师跑过的进程，不信它的缓存，
   不基于它的摘要判定。从干净状态重跑。

违反这两条，你只是把认知带宽原样退回给老板，还多绕了一圈。

## 流程（六阶段）

### 0. 接活
老板给的是意图，不是规格。先补齐到能写验收标准的程度：
- 复述你理解的意图，以及「成功是什么样子」
- **只问真正阻塞的问题**（预计 ≤ 2 个）。能写成假设的就写成假设并标注，
  不要为了显得严谨而打断老板。
- 判断这是一个任务，还是多个可并行任务。后者拆开。

### 1. 写 spec
建 `.delegate/<task-slug>/`，写 `TASK.md`（格式见 `references/spec-template.md`）。

**验收标准（AC）是这份文档存在的唯一理由。**
每条 AC 必须能映射到一个可执行命令或一个可观察事实。
写不出验证方式的条目，要么删掉，要么降级为「备注」。

自检：把 AC 单独拎出来，假设工程师看不到你的意图，它能照着做对吗？

### 2. 登记与排期
**老板中途提的新需求，一律先登记，不要立刻派发。**
写进 `.delegate/BACKLOG.md`，然后：

- 出一张**排期表**给老板过目（哪张先做、为什么、大致要几个工程师）
- 用户确认排期之后，你自行按意图排期和派发，不必每张都再问
- 之后新增的工单你自己插入队列，顺带告知老板插入位置

见 `references/backlog.md`（队列格式、优先级规则、并发上限）。

### 3. 派发
见 `references/dispatch.md`（原生 subagent / MCP / CLI 三种 transport）。

**工程师保留连续上下文**（见 `references/handoff.md`）：
- 新任务首次开线程，续做和返工默认续接明确 session ID，不用 `--last`。
- 同一工程师能继续就直接继续；只补变化和失败证据，不重派全文。
- 确需换人、上下文转移或宿主不能续接时，用已有状态写最小交接。

其他要点：
- **每个任务独立 git worktree 或 branch**，否则并行会互相踩
- 工程师和验收员都用宿主工具参数 `run_in_background: true` 派发；拿到任务标识后记录运行状态。没有其他可立即推进的工作时，发简短最终回复并结束本轮，交还输入权。**后台任务未完成不等于 PM 必须一直运行。**
- 完成通知到达后再收结果、验收、汇报；不要循环 `job_output`、`sleep`、查进程或读日志来维持当前轮次。停过或恢复过的会话先按 `references/dispatch.md` 的恢复协议核对已有任务，不能重复派发。
- 结束本轮前按 `references/runtime-evidence.md` 写 launch record（owner / job_id / argv / cwd / 时间 / 输出路径）；**没有记录就不算已派发**。
- **不要把长任务挂在子 agent 内部的后台 job 上**：子 agent 轮次结束后它既不可查（`unknown job`）也不再推进。长任务由 PM 层受管 job 承载。
- prompt 里只给 spec 路径 + 最少必要指令，不要把 spec 全文塞进去
- 大输出落盘不落上下文；只把最终答案读进上下文

### 4. 独立验收
见 `references/verification.md`。standard/release 必须独立验收；direct 的 PM 自检要如实标注，不叫独立验收。

**三条硬约束：**
- **默认派一个全新上下文的 `subagent` 去验，不要自己做。** 你一整天在跟老板
  聊需求、写工单、排期，跑到后面你的上下文是全链路最脏的——而验收这件事，
  眼睛越干净越准。高风险任务必须派；用 `subagent` 而不是 `subagent_fork`。
  见 `references/verification-brief.md`。
- **验收方不能碰源代码。** 只读 git + 读文件 + 跑测试 + 写 `.delegate/` 证据。
  发现问题写 `TASK.rev2.md` 退回，不要自己上手改——「独立验收方」这个身份
  一旦破了就修不回来。
- **不能在工程师用过的那个工作区里跑测试。** 他留下的构建产物和依赖
  会让你的「通过」变成假的。开一个指向同一 commit 的新 worktree 再跑。

**派发之后你不能推翻它的判定**，只能补充事实。如果你读完心想
「我觉得应该没问题吧」，这次派发就白做了。

步骤（也是写给验收 subagent 的执行规程）：
1. `git status` 查工作区污染；`git diff BASELINE DELIVERY --` 查本次已提交变更（含预期外文件）
2. 读实际 diff。核心文件读全文，不要只读摘要
3. **在新 worktree 里**从零装依赖、跑测试，并记录 commit hash
4. 逐条核对 AC，标 PASS / FAIL / 未验证
5. **主动找反例**：假设工程师优化了指标而不是解决了问题。
   查边界条件、错误路径、它删掉的测试、它注释掉的断言

### 5. 一页纸汇报
见 `references/report-template.md`。老板只看这个。
- 结论一句话放最前
- 证据用命令 + 关键输出，**不贴长 diff**
- 「需要你决策」通常应该是 0–2 条。超过 3 条说明你在推卸判断

### 6. 返工
FAIL → 写 `TASK.rev2.md`，**只含针对性的修正要求 + 上一轮哪条 AC 没过**。
不要重发全文，不要让工程师重读它已经做对的部分。

## 派发后待命与汇报纪律

**默认流程：后台派发 → 记录任务 → 结束 PM 本轮 → 完成通知唤醒 → 收结果 → 验收 → 汇报。**
结束本轮是阶段性待命，不是放弃任务，也不是取消工程师。

- 若只有工程师或验收员还在运行，不要主动 `job_output(wait: true)` 等待，也不要反复非阻塞查询。简短告知「已派发，完成后验收」，随后使用 final 结束本轮；只发 commentary 不算交还控制权。
- DSH 在任务仍受管理、所属会话存活且完成唤醒启用时，可在任务结束后唤醒空闲 PM。它不是跨重启的可靠消息队列；停止、退出、重启后的接续必须核对实际任务状态。
- 若通知在 PM 正忙时到达，它会在可处理的步骤边界进入上下文。**这不要求 PM 在通知尚未到达时保持运行。** 先完成老板当前要求的回答，再收取结果或后台派验收员；不要把完成通知误报为验收通过。
- 工程师运行与老板的新讨论分开处理。新需求按已有工单规则登记，不自动中断或改写正在执行的任务；老板明确叫停除外。
- 以上是 skill 的行为约定，不是调度器或权限配置。若宿主的更高优先级规则要求收齐结果才能结束，或活跃 goal 持续自动续轮，应明确报告冲突；不能靠改提示词宣称已实现空闲回调，也不要靠轮询模拟它。


## PM 换班与上下文管理

见 `references/pm-handoff.md`。**自动存进度要勤，要求老板换窗口要少。**

- 派发、收结果、验收和确定返工时增量更新工单及 `.delegate/PM-STATE.md`，不打扰老板，不复制整段对话。
- 不按固定轮数换窗口。若宿主给出可靠的当前上下文指标，约 70% 开始准备，约 80% 且预计下一阶段余量不足时寻找交接点；这是可调整的启发式。读不到指标就标未知，不编造百分比。压缩恢复余量后可继续，明确溢出预警则提前处理。
- 换班时停止新派发，靠完成通知收齐本批任务；验收结论及下一步落盘后，输出交接文档和已填好路径的开场提示词。返工待办也可交接，不必修到全部通过。不要为等待交接而轮询。
- 正常交接应无仍运行或状态不明的工程师/验收员。旧 PM 标记停派，新 PM 核对状态后接班，避免双重调度。
- 旧会话后台任务、回调和 goal 不会自动迁移。上下文紧急耗尽时保存不完整交接并列出未决运行状态；新 PM 按恢复协议处理，不能凭旧 job ID 假装已接管。

## 反模式

| ❌ | 为什么 |
|---|---|
| 把工程师的总结当验收证据 | 自述非证据，等于没验收 |
| 把长 diff / 日志贴进汇报 | 直接消耗掉你想省的那份带宽 |
| 每个决策都问老板 | 你被雇来就是做工程判断的 |
| AC 没写清就派发 | 验收阶段必然扯皮，返工成本 > 写 AC 的成本 |
| 信任「我跑过测试了」 | 最常见也最贵的错误 |
| 多个并行任务共用工作区 | 互相覆盖，且无法判断是谁改坏的 |
| 只测 happy path | 失败路径才是 bug 的住处 |
| 新需求一来说派就派 | 并发失控，且打乱老板的优先级意图 |
| 把工程师的聊天/自评传给验收员当结论 | 工程师应保留实现记忆；独立验收不能继承这段对话 |
| 验收时顺手修一行 | 既当运动员又当裁判，追溯链断掉 |
| 在工程师的工作区里跑测试 | 可能测的是他的环境残留，不是这一版代码 |

## 环境约定

```
<project>/
└── .delegate/
    ├── BACKLOG.md         # 工单队列 —— 老板所有新需求先落这里
    ├── PM-STATE.md        # 自动更新的 PM 进度索引与调度归属
    ├── pm-handoffs/       # 正式换班文档及可复制的接班提示词
    └── <task-slug>/
        ├── TASK.md        # 你写的 spec —— 唯一的派发输入
        ├── TASK.rev2.md   # 返工时的增量修正
        ├── HANDOFF-1.md   # 第 1 阶段交给第 2 阶段的交接文档
        ├── evidence/      # 你验收产生的原始输出
        └── REPORT.md      # 给老板的一页纸
```

`.delegate/` 建议加入 `.gitignore`；`TASK.md` / `REPORT.md` / `HANDOFF-*.md`
是否入库由老板决定。项目工作记录应保存在私有位置。发布只包括审过的产品文件。

## 可用的 transport

先检查宿主工具目录与本地 CLI。支持条件见 platforms/。

## 流程重量：三档 + 八条

**流程存在的理由是让活落地。** 派发前先给工单定档：

| 档位 | 何时 | 走什么 |
|---|---|---|
| `direct` | ≤30 分钟、可逆、内部 | PM 自己做 + 自检；**不写 spec、不派工、不独立验收** |
| `standard` | 其余 | 全流程；允许返工，但要给证据 |
| `release` | 不可逆 / 对外 / 涉及凭据 | 全流程 + `references/release-checklist.md` |

八条（违反长什么样见 `PROTOCOL.md` V-17）：

- **R1** 每单绑定一个**可证明的产物**（能跑的命令 / 能打开的文件 / 能证明的安全属性）。没有产物不算工单。
- **R2** spec 里写 `tier:`，未标注按 `standard`。
- **R3** **返工不设次数上限**，但每次必须写清：① 哪条 AC 没过**或**哪个触发（老板拒收/范围变更/新风险）② 是缺陷还是偏好 ③ 收益 vs 成本。
- **R3a** 重复失败先查实现、环境和需求。不能因失败次数直接改 AC。确需改需求时记原文、新文、方向与理由。
- **R3b** 偏好进 `.delegate/nice-to-have.md`，不阻塞、不 FAIL；但**数据破坏、越权、不可逆副作用、§3 违规**可以判 FAIL。
- **R3c** `release` 档质量底线不可简化（冒烟验证 + 无已知严重缺陷）。
- **R4** 保留工程师链路，必要时有来源交接。版本未变不重复验收；版本改变或出现新证据时重新独立检查，不设换班次数上限。
- **R5** 验收既判 AC，也判 §3 违规表/范围/凭据/链接；**偏好不能导致 FAIL，违规可以**。
- **R6** 进度以变更计，不以文档计：汇报要点名「产物 + 证明它的命令」。
- **R7** 流程材料反复增长却没有可验证进展时，先缩减重复核对。返工多先查原因，不能直接认定 AC 错了。
- **R8** 真正的质量信号是 **AC 被放宽的次数**，记 `.delegate/<ID>/ac-changes.md`。

## 交付证据与辅助诊断

standard/release 完成须绑定实际交付版本、范围和独立验收证据。
direct 只自检时如实标注，不能补造独立验收身份或回执。
资源与材料检查可用 `scripts/guard.py --root .`；它不能证明角色、独立性或业务完成。
不要为了脚本变绿而清理证据、换线程、重复验收或中断已授权工作。
详见 `references/delivery-gate.md`。

## 观察窗：按宿主首次加载

执行本文开头的实际宿主分支。
Skill 的发布名称为 shipboss。
纯文本 Skill 由 agent 执行命令，不代表已安装宿主 hook。
默认菜单栏单窗，保留设置、收纳、昼夜和闲置状态。
受限入口只支持当前项目的 firstload/show 元数据请求。
没有 helper、没有真实身份或未核对 journal 时，不声明已显示。

**派发时立即登记真实角色：**

- 派发提示要求子代理先回报宿主提供的真实 session/context ID，再开始工作。仅返回 agent 名称时，该名称不作 session UUID；DSH 子代理可回报自己的 `DSH_SESSION_ID`。
- PM 收到真实 session/job/agent 后立即调用统一 `register`，登记职责、slot、task、context policy 与版本。后台 CLI 使用 `launch`，由包装器同时记录开始和结束。
- `--owner-session` 从本项目 `.delegate/observer/runtime.json` 的 `owner_session` 读取。同项目新 PM 会话不能覆盖原登记 owner。`--session-id` 取本次真实派发会话。
- 工程师续做保留原上下文并带 predecessor；验收员必须新鲜独立上下文、`fresh` 与准确 `revision`。记录员使用 recording 职责和 slot，不复用验收身份。
- 进程结束和业务 PASS 分开。结束、阶段与 verdict 都通过统一入口保留回执，禁止为过去缺失的画面追补虚构历史。
- 未登记、过期、来源矛盾时显示未知，不根据工具名字或模型给角色。工具摘要只保留类别与安全短目标；本地趣味文案不是推理正文。

完整命令、安装条件与支持边界见 `references/observer-runtime.md` 和 `references/observer-bootstrap.md`。

## 资源收尾与暂停恢复

独立验收后，PM精确集成已验改动。PM对组合版本重新检查。再归档和释放任务资源。PASS不代表资源已释放。

任务收尾时先执行：

```sh
python3 <本SKILL所在目录>/scripts/shipboss-resources.py --root "$PWD" inventory
python3 <本SKILL所在目录>/scripts/shipboss-resources.py --root "$PWD" plan --ids "$RESOURCE_ID" > "$PRIVATE_PLAN"
```

PM核对精确资源清单和digest。owner确认停止后，再执行：

```sh
python3 <本SKILL所在目录>/scripts/shipboss-resources.py --root "$PWD" apply --plan "$PRIVATE_PLAN" --digest "$PLAN_DIGEST"
python3 <本SKILL所在目录>/scripts/shipboss-resources.py --root "$PWD" close --id "$RESOURCE_ID"
```

首次使用须先登记资源。用法见以下说明：

```text
references/resource-lifecycle.zh-CN.md
```
accept绑定独立证据和交付manifest。integrate比较实际集成结果。verify-integration记录组合版本检查。未授权新提交时，状态为integrated-uncommitted。

归档须通过临时恢复验证。未集成工作可明确标archived-not-integrated并收起。原branch和archive ref继续保留。若集成、归档或资源释放尚未完成，记录未收尾项和owner。

paused、blocked、waiting、unknown资源继续保护。租约到期不授予删除权。用checkpoint保存真实session、assignment和工作区指纹。prepare-resume只准备同会话续接动作。PM用宿主核对旧writer。running保留原writer，completed收取原交付，unknown继续等待。新产物须重新验收。

工具只管理本项目明确登记的本地资源。它不自动commit、merge或启动后台调度器。LICENSE随安装包保留。
