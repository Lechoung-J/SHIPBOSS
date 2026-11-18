# 观察窗：按派发职责显示

角色由 PM 派发决定。普通 bash 不算工程师；子代理不自动算验收员。
工位只显示有来源的运行状态。未知、失败、取消与验收通过不能混写。

## 随技能启动

执行 SKILL.md 开头的当前宿主分支。
外部入口排队等待官方 journal 校验，不借用 DSH 身份。
完整条件见 observer-bootstrap.md。

## 登记派发

复用既有运行记录，不增加老板审批步骤。要求子代理先回报真实 session/context，再开始工作。宿主返回实际 session/job/agent 后立即登记：

```bash
R=<本SKILL所在目录>/scripts/observer_runtime.py
python3 "$R" --root "$PWD" register \
  --owner-session '<项目registry的owner_session>' \
  --assignment TASK-1-impl-1 --task TASK-1 --role engineer --slot eng-a \
  --policy new --context-id '<实际实现上下文ID>' --session-id '<实际工程师session UUID>' \
  --agent-id '<宿主实际agent ID>' --source native
```

`register` 将实际派发结果和 running 同时登记并输出回执。旧 `bind` 只登记身份。
本机受管子进程用 `launch`，同时包装启动、逐工具摘要和结束，保留原输出与退出码。
原生 agent 用实际 `--agent-id`；宿主没有可读生命周期事件时，按完成通知显式 `finish`，不能猜结束。

工程师续做：新 assignment 指向 `--predecessor`，用 `--policy resume` 和同一明确 session。
只有换人或不能续接时才 `handoff`，并记录来源。

验收另派全新上下文，登记 `--role verifier --slot verifier --policy fresh`。
它必须有新的 session/context ID 和 `--revision '<准确交付版本>'`。
不能把 PM 自检或工程师线程换个名字登记为独立验收。

## 测试等待阶段与人物动作

工程师在已登记的 running assignment 上运行测试时，使用显式阶段包装：

```bash
python3 "$R" --root "$PWD" stage '<工程师assignment>' --phase testing -- <测试命令及参数>
```

包装器执行真实命令，期间提供 testing 信号，结束恢复原阶段。
它保留命令退出码，不将测试结束变成整单完成，也不签发验收结论。
普通实现、调试仍是 working；不能凭命令名字猜 testing。

普通模式人物进门、落座、休息、返回和退场须连续。
重复刷新不能复位；“减少动态效果”是单独的简化分支。
动画验收与安装包验收分别记录，不能只看人物最后的位置。

## 结束、结论与记录员

```bash
python3 "$R" --root "$PWD" finish '<assignment>' --state completed --exit-code 0
# 只有取得独立验收结论后，才记录 verdict：
python3 "$R" --root "$PWD" verdict '<验收assignment>' --verdict PASS --revision '<同一版本>'
```

实现进程成功只是待验收。验收进程结束也不自动成为 PASS。
记录员使用 `--role recording --slot recording`，实际运行时进场，结束时离场。
记录员不需要新建技术验收会话；它提取内容的职责和验收不同。

## 当前覆盖与限制

原生 DSH 支持显式 owner 的 turn、step、job 起止和提问回答事件。
工具名只用于解析确定的事件结构，绝不用来判断工程师或验收员身份。
当天箱数合并该项目不同会话的成功技能加载，排除 Shipboss 并去重。
模型工具加载和用户直接调用均须有明确成功记录，普通聊天和技能目录不计数。
房间默认五分钟无新活动后调暗，恢复活动后亮起；业务验收状态保持。
受限项目日志可排除；首次索引分批追赶，界面来源须说明遗漏或损坏范围。
没有登记的旧任务不追认角色，也不因为原日志很长就伪造当前活动。
过期连接暂停工作动画并显示未知。缺字段时宁可未确认，不补造人名、角色或问题。

运行入口为 `scripts/observer_runtime.py`。
此 runtime 为本地组件。外部身份需要官方 journal 核对。

## 活动来源

五角色共用工具与思考气泡规则，记录员使用原交付桌头点。
外部 Codex 使用 exec --json，Claude 使用 --print --verbose --output-format stream-json --include-partial-messages。
受管 launch 读取其工具流。显式加载 receipt 还可启用精确官方 journal 元数据。没有可核验模型思考信号时，CLI 保留粗运行状态。
大历史使用有界分段认证，首次冷扫描未完成时显示 pending，不虚构角色或绕过来源校验。
安装与首次显示详见 observer-bootstrap.md。
