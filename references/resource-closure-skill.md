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
