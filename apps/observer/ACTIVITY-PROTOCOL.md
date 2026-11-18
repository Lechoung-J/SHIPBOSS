# 活动气泡协议 v1

每个已确认角色可选 `toolActivity`。旧快照省略此字段仍有效。

快照保留四项 actors 数组。
记录员使用可选 recordingActor，id/role 固定 recording。
recording bool 和 recordingUncertain 同时约束该角色资格。
其工具摘要沿用同一版本、上限和单槽调度。
旧快照缺省 recordingActor 时，保留原记录员身体显示。

统一派发入口见 [运行指南](runtime/README.md)。
Codex/Claude来源必须有真实host会话和受管launch登记。
CLI wire调用ID含source、assignment与launch范围。
外部Skill receipt先声明membership，不凭UUID虚构PM执行。
队列入口只写service元数据，不写项目registry。
writer验证receipt对应官方journal后才初始化缺失owner。
已有owner与worker登记保持。
Codex按exact session_meta、cwd、主会话及task事件核对。
exec/cli/vscode可接受，originator文案不授role。
Claude按exact sessionId/cwd、isSidechain=false核对。
tool_use/tool_result不读取正文，end_turn才结束当前turn。
无可靠model-busy信号时只显示working，不猜thinking。
外部sourceKey含harness/root/session，跨Harness调用不合并。
官方journal缓存只存有界白名单，8MiB/tick，单会话0.75秒。
每批外部扫描另限2秒，预算不足显示未知，房间order保留。
Codex只按已登记UUID查找文件名，Claude使用encoded root精确路径。
不扫描或打开其它journal正文。

presentation.requests要求官方journal已核验且事件新鲜。
lastEventAt仅来自可信生命周期/工具事件，不用receipt时间或mtime。
默认source TTL为300秒，与PM idle_seconds参数保持一致。
事件在future、缺失或超过TTL时，不触发firstload/show。
陈旧open来源保留membership，但不显示running或工具。
已认证ended历史保留known idle，不因年龄丢失终态。
追加可信新turn可恢复资格，同receipt ID仍供main去重。
缓存升级为official-journal-v2-event-freshness。
旧缓存或缺lastEventAt字段会重新解析，绝不假定fresh。
每项字段为id、at(epoch秒)、action(firstload/show)。
firstload id为receipt hash，同context重复不重弹。
show使用新request hash。显示请求120秒过期，最多32项。
main的去重与弹窗由启动线负责，声明receipt不直接弹窗。
sidecar只输出工具，不从正文或CLI名称猜思考。
大日志按8MiB分段认证，未完成新activation明确pending。
已登记长run只凭准确新鲜事件延续只读有效期。

```json
{"version":1,"projectId":"p-example","actorId":"eng-a","sessionId":"session-id","runningCount":1,"thinking":false,"calls":[{"callId":"call-1","sequence":12,"state":"started","timestamp":1794790000000,"startedAt":1794790000000,"category":"read","target":"app.ts"}]}
```

wire ID 限 1–80 个 ASCII 字母、数字、点、下划线或连字符。project/actor/session 的限制保持原状。

native call ID 单独适配，接受 1–512 个 ASCII 可见非空白字符。call/result 使用同一个函数。简单 ID 可保留原值。超 wire 范围或包含 `|` 时，输出会话范围内的 SHA256 ID。保留 `native-sha256-` 前缀只供映射输出。原生 ID 若使用该前缀，也进入哈希映射。哈希输入为紧凑 JSON 数组 `[sessionId, rawCallId]`。输出为此前缀加64位小写hex，不截断 raw ID。索引和气泡只保留 wire ID。非字符串、控制字符、空白和超限输入仍抑制摘要。

时间为 epoch 毫秒，限有效日期范围。sequence 为非负安全整数。category 使用七种枚举。

```text
read / search / edit / command / test / delegate / other
```

state 限 started/ended/error。target 可为空，最多 32 字。只接受常见源码和 config 后缀的 basename。`.env`、pem、key、token、凭据等敏感命名只显示固定标签。标签来自本地固定表。工具参数、命令、查询、结果、prompt 和推理正文不持久化。

native call/result 按 callId 配对。结果使用 message.toolCallId。重复 call/result 幂等。结果乱序仍关闭原调用。最多追踪 32 个并发调用；超限停止输出该会话详细活动。输出最多 8 个进行中、4 个最近完成。最近完成保留 4 秒，明确显示“刚完成”。普通 bash 为 command；只有角色明确 testing phase 才改为 test。MCP 未知工具归 other。

项目以 header.cwd 精确分组。PM 必须成功激活且通过 depth/descriptor 主会话核对。其它角色必须有当前有效登记，owner 一致，工具开始时间处于该 assignment 登记窗口。同 session 按半开区间 `[bound_at, next_bound_at)` 切窗。最新窗口包含当前 now，排除未来时间。同一 bound_at 的多重登记视为歧义，抑制详细活动。归属使用 call 开始时间，晚到 result 仍属于旧窗口。当前 step 只给仍处于有效窗口的角色思考资格。未登记 child 不产生详细活动。继承前缀、foreign source、损坏、过期和扫描超限不产生可信活动。

PM 活动来源与当前人物生命周期使用同一个可信新鲜主会话。多个合法 open turn 先比较匹配心跳，再比较 turn 起点，最后用 session ID 确定平局，结果不受扫描顺序影响。旧 registry owner 保留登记归属，不作为活动指针。仅展示代表会话当前 turn 内的工具与思考，不跨会话混合；没有新鲜可信来源时不回退旧 owner。待人和后台等待优先，后台等待不产生思考资格。

native data 未提供 source 时，按当前 header 归属。显式 source 必须为对象。对象可省略 sessionId；一旦提供，必须是当前 header.id 的合法字符串。null、数字和 foreign ID 都视为来源矛盾。当前后缀中的工具和 turn/step 事件都检查 source。遇到矛盾时，整份会话摘要抑制工具和思考。继承前缀不污染当前后缀。缓存迁移保留房间 order。新签名如下。

```text
roles-v4-incremental-native
```


thinking 接受显式 motion=thinking。也接受当前 turn 内未结束的匹配 step。两者都要求没有运行工具。背景等待不构成 thinking。工具活动不改变身体动作、role、task 或 verdict。

每角色一个二维槽。待人/异常/未知优先，再工具，最后本地角色彩蛋。完成摘要显示约 1 秒。思考稳定 2 秒后可出现彩蛋，持续 2.5 秒，冷却 20–40 秒。时间和随机源可注入。同屏最多两个彩蛋。隐藏、收纳、离屏或暂停丢弃旧摘要；恢复只采用当前运行工具。减少动态效果时取消漂浮。

详细活动另有 64 KiB 总预算。超额角色只保留固定未知摘要。`suppressed=true` 时没有 calls 和 thinking。

