# 本地资源收尾

任务收尾要执行资源工具。独立验收通过后，PM还要精确集成。PM复查组合版本，再归档和释放工作区。

状态依次如下：

```text
accepted → integrated-uncommitted → integration-verified
→ archived → workspace-released → closed
```
工具会保留未提交集成状态。它不会据此声称主线已有新提交。

## 登记与只读计划

工具只处理当前主Git工作区内明确登记的目录。它使用Python标准库和本地Git。它没有后台服务或定时任务。

```sh
python3 <skill>/scripts/shipboss-resources.py --root "$PROJECT" init
python3 <skill>/scripts/shipboss-resources.py --root "$PROJECT" adopt --file "$PRIVATE/owned.json"
python3 <skill>/scripts/shipboss-resources.py --root "$PROJECT" inventory
python3 <skill>/scripts/shipboss-resources.py --root "$PROJECT" plan --ids old-build > "$PRIVATE/plan.json"
```

inventory和plan只读。生成的清单、对象和回执默认存入项目私有目录。公开包只带工具和中性说明。

```json
{
  "protected": ["private/publish-review"],
  "resources": [{
    "id": "old-build", "path": "artifacts/old-build.app", "kind": "artifact",
    "owner": "assigned-role", "task": "local-task", "owner_state": "inactive",
    "lease_until": 0, "retention": "reclaim"
  }]
}
```

kind可选artifact、stage、worktree。retention可选current、rollback、evidence、reclaim。先登记当前已验正式包和一个可信回滚包。唯一失败证据登记为evidence。租约过期只表示需要复核。

工作区预算跟随活动角色数量。工具不会因超预算直接删除目录。

未集成worktree默认受保护。PM明确加入`archive_not_integrated:true`后，可验证归档并收起。回执会标archived-not-integrated。工具保留原分支。它另建本地archive ref保护HEAD。它不会自动合并或删分支。

现成依赖链接要逐项登记。例如：

```json
{"dependency_links":{"node_modules":"app/node_modules"}}
```

工具只记录链接。它不读取依赖目录。恢复时可用绝对链接指向同一依赖。其它外部链接会阻断回收。

主线已跟踪文件、Git共有库、运行数据和显式保护路径保持保护。PM应补充当前发布审查区和实际运行路径。

## 验证后释放与恢复

```sh
python3 <skill>/scripts/shipboss-resources.py --root "$PROJECT" apply \
  --plan "$PRIVATE/plan.json" --digest "$REVIEWED_DIGEST"
python3 <skill>/scripts/shipboss-resources.py --root "$PROJECT" archive-verify --archive "$ARCHIVE_SHA"
python3 <skill>/scripts/shipboss-resources.py --root "$PROJECT" restore \
  --archive "$ARCHIVE_SHA" --destination "restored/old-build.app"
```

apply核对计划摘要、根目录身份和资源指纹。它复核owner与进程占用。探测失败或状态未知时，资源保持保护。

macOS探测使用lsof检查cwd和打开的代码路径。PM还要通过宿主核对原生agent状态。租约或进程列表都不能代替该核对。

归档按文件SHA共享内容对象。目录manifest保存字节、mode、相对链接和可读xattrs。工具先恢复到临时目录，再逐项比较。

原.app若通过codesign深度验证，恢复副本也须通过。原签名未通过时，回执明确保留未验证状态。字节一致不代表已公证或启动兼容。

工具保存全部可读xattrs。读取或恢复属性失败时，源目录保留。

本版只支持已证明没有扩展ACL的条目。macOS通过原生API逐项探测。文件、目录和链接本身都参与检查。探测不会跟随依赖链接。

发现ACL时，工具返回unsupported-acl。API缺失、探测失败或平台未支持时，工具返回acl-probe-unknown。两种情况都会保留源目录。工具不会清除源ACL。

plan和apply都会重新探测。释放前与恢复结果也要再次检查。恢复目录新继承的ACL同样会阻断。

新manifest逐项记录acl为absent。旧归档若缺此证明，完整恢复核验会阻断。保留其源目录，探测成功后重新归档。

创建时间与其它未记录属性仍无恢复支持。依赖这些属性的资源应继续保护。

worktree归档包含完整文件树。它也包含未跟踪文件和独有ignored文件。暂存区会单独保存原index和独有Git对象。二进制patch、原HEAD、branch和bundle都保留。

临时独立Git仓库须还原原Git状态。实际恢复通过git worktree add重建关联。工具随后还原文件树与index。它不会照抄旧.git指针。

split-index、未解决合并和submodule保持保护。恢复需要原仓库和归档对象。此工具未声明支持远程备份。

工具使用独占锁和原子receipt。同一digest重复apply会返回原回执。它不会处理旧路径后来出现的新目录。

部分资源成功时，回执逐项说明。存在阻断的apply返回2。崩溃后可能留下未完成回执或旧锁。PM先确认旧PID已停止。再保留归档信息并处理锁。用receipt中的archive标识恢复，然后重新计划。未完成receipt不代表已收尾。

工具不自动回收CAS对象或archive refs。唯一对象字节与APFS物理空闲量有区别。实际回收应分别记录du和df。

## 精确集成与close

独立验收须绑定交付映射。PM集成后，工具检查目标字节和mode。删除项加`deleted:true`。本版集成映射支持普通文件和删除项。符号链接仍可归档恢复。

```json
{"files":[{"source":"src/change.py","target":"src/change.py"}]}
```

```sh
python3 <skill>/scripts/shipboss-resources.py --root "$PROJECT" accept \
  --id "$RESOURCE" --evidence "$ACCEPTANCE_EVIDENCE" --manifest "$PRIVATE/delivery.json"
python3 <skill>/scripts/shipboss-resources.py --root "$PROJECT" integrate \
  --id "$RESOURCE" --manifest "$PRIVATE/delivery.json" --evidence "$INTEGRATION_EVIDENCE"
python3 <skill>/scripts/shipboss-resources.py --root "$PROJECT" verify-integration \
  --id "$RESOURCE" --evidence "$COMBINED_CHECK_EVIDENCE"
python3 <skill>/scripts/shipboss-resources.py --root "$PROJECT" close --id "$RESOURCE"
```

verify-integration前要对最终组合版本重新检查。close前须完成归档与工作区释放。accept可以单独记录证据。缺少验收映射时，集成保持待办。

工具只核对证据文件摘要。独立验收员负责判断证据和交付范围。工具不会把自报PASS当作独立结论。

## 暂停与同会话续接

active、paused、blocked、waiting、unknown资源保持保护。checkpoint保存真实会话UUID和assignment。它还保存工作区指纹、原因代码和下一步。待完成job及最近已验阶段也会保留。

```sh
python3 <skill>/scripts/shipboss-resources.py --root "$PROJECT" checkpoint \
  --id "$RESOURCE" --record "$PRIVATE/checkpoint.json"
python3 <skill>/scripts/shipboss-resources.py --root "$PROJECT" prepare-resume \
  --id "$RESOURCE" --record "$PRIVATE/resume.json"
```

检查点包含以下字段：

```text
session_id, assignment, workspace, state, reason_code
next_action, pending_jobs, verified_stage
```
不要存完整消息、凭据或推理正文。

resume记录重复前三项身份字段。它还需checkpoint_digest、host_state和host_evidence。证据路径来自最新宿主检查。

running返回keep-existing-writer。completed返回collect-existing-delivery。unknown会阻断续接。

stopped或failed须没有待收job。工具还要确认工作区没有活动进程。符合条件时，它返回pm-resume-same-session。executed始终为false。原生续接由PM调用真实宿主工具。新产物仍需重新验收。

## 打包与安装

打包器只拥有本次新建stage。它用PID和inode绑定该目录。成功时，打包器保存操作manifest并释放stage。

失败时，打包器保留应用payload和plist。签名证据、输入身份和诊断也保留。共享Electron继续作为固定输入。它不为每次失败再保留完整Electron包。

证据保存或身份复核失败时，stage继续保留。最终release和rollback由另一套资源登记保护。

安装器会复制自足CLI和中英文说明。安装后help、inventory和plan可直接运行。本版只对本机macOS给出实测范围。它不宣称全平台或远端宿主自动回收。
