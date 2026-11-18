#!/usr/bin/env python3
"""交付与资源检查。

用法：python3 guard.py [--root .] [--json]     # 硬失败时退出码 1

硬失败（阻止 done）：
  probe      探测失败（git 不可用 / 非仓库）——失败关闭，不假装健康
  deliverable 标 done 的工单行，其交付列必须是仓库里真实存在的 commit
  delegate_size / worktrees / state_size / evidence_files / evidence_size
  sessions_today / open_tickets
告警（不阻止）：
  commit_age / last_commit   —— 时钟判不了长任务，空提交会让它说谎
"""
import argparse, json, os, re, subprocess, sys, time
from pathlib import Path

DEFAULTS = {
    "commit_age_hours": 24,
    "delegate_size_mb": 2048,
    "worktrees": 3,
    "state_kb": 10,
    "evidence_files_per_task": 20,
    "evidence_mb_per_task": 5,
    "sessions_per_day": 10,
    "open_tickets": 3,
    "exception_max_days": 90,
}

HARD = ("probe", "deliverable", "delegate_size", "worktrees", "state_size",
        "evidence_files", "evidence_size", "sessions_today", "open_tickets")
WARN = ("commit_age", "last_commit")


def sh(cmd, cwd):
    """返回 (stdout, ok)。命令失败必须被上层看见。"""
    try:
        r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=30)
        return r.stdout, r.returncode == 0
    except Exception:
        return "", False


def git_works(root: Path) -> tuple[bool, str]:
    out, ok = sh(["git", "rev-parse", "--is-inside-work-tree"], root)
    if not ok or out.strip() != "true":
        return False, "git 不可用或不在仓库内"
    return True, ""


def oldest_uncommitted_hours(root: Path):
    out, ok = sh(["git", "status", "--porcelain", "-z"], root)
    if not ok:
        return None, "git status 失败"
    paths = [p[3:] for p in out.split("\x00") if len(p) > 3]
    times = []
    for rel in paths:
        try:
            times.append(os.path.getmtime(root / rel))
        except OSError:
            continue
    return ((time.time() - min(times)) / 3600 if times else None), ""


def last_commit_hours(root: Path):
    out, ok = sh(["git", "log", "-1", "--format=%ct"], root)
    if not ok:
        return None, "git log 失败"
    out = out.strip()
    if not out.isdigit():
        return None, "仓库还没有提交"
    return (time.time() - int(out)) / 3600, ""


def dir_size_mb(path: Path) -> float:
    total = 0
    for base, _, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(base, name))
            except OSError:
                pass
    return total / 1024 / 1024


def count_worktrees(root: Path):
    out, ok = sh(["git", "worktree", "list"], root)
    if not ok:
        return None, "git worktree 失败"
    return max(0, len(out.splitlines()) - 1), ""


def count_sessions_today(root: Path) -> int:
    encoded = "--" + str(root.resolve()).replace("/", "-") + "--"
    base = Path.home() / ".dsh" / "sessions" / encoded
    if not base.exists():
        return 0
    cutoff = time.time() - 86400
    return sum(1 for d in base.iterdir() if d.is_dir() and d.stat().st_mtime > cutoff)


def backlog_rows(root: Path):
    """解析当前队列表：返回 (task_id, status, row_text) 列表。"""
    path = root / ".delegate" / "BACKLOG.md"
    if not path.exists():
        return None
    rows = []
    for line in path.read_text(errors="ignore").splitlines():
        stripped = line.strip()
        if not stripped.startswith("|") or "→" in stripped:
            continue
        cells = [c.strip().strip("`") for c in stripped.strip("|").split("|")]
        if len(cells) < 3:
            continue
        m = re.search(r"[A-Z][A-Z0-9]*-\d+", cells[0] + " " + cells[1])
        if not m:
            continue
        status = next((c for c in cells if c in
                       ("intake", "spec-ready", "scheduled", "dispatched", "verifying",
                        "rework", "reported", "done", "blocked")), None)
        if status is None:
            continue
        rows.append((m.group(0), status, stripped))
    return rows


def commit_exists(root: Path, sha: str) -> bool:
    if not re.fullmatch(r"[0-9a-f]{7,40}", sha or ""):
        return False
    _, ok = sh(["git", "cat-file", "-e", f"{sha}^{{commit}}"], root)
    return ok


def undelivered_done(root: Path):
    """标 done 的行必须含一个真实存在的 commit，否则返回工单号列表；BACKLOG 缺失返回 None。"""
    rows = backlog_rows(root)
    if rows is None:
        return None
    bad = []
    for task, status, row in rows:
        if status != "done":
            continue
        hashes = re.findall(r"\b[0-9a-f]{7,40}\b", row)
        if not any(commit_exists(root, h) for h in hashes):
            bad.append(task)
    return bad


def _read_kv(path: Path) -> dict:
    """从 TASK/RECEIPT 里读 `key: value` 形式的字段（Markdown 里的简单 yaml 行）。"""
    kv = {}
    if not path.exists():
        return kv
    for line in path.read_text(errors="ignore").splitlines():
        m = re.match(r"\s*[-*]?\s*([a-z_]+)\s*:\s*(.+?)\s*$", line)
        if m:
            kv.setdefault(m.group(1), m.group(2).strip().strip("`"))
    return kv


def _scope_paths(scope: str) -> list[str]:
    return [p.strip().strip("`") for p in re.split(r"[,，]", scope or "") if p.strip()]


def _scope_ok(paths: list[str]) -> tuple[bool, str]:
    if not paths:
        return False, "delivery_scope 为空"
    for p in paths:
        if p in ("*", "**", "./*") or p.endswith("/*") and p.count("/") == 0:
            return False, f"范围过宽：{p}"
    return True, ""


def _commit_msg(root: Path, sha: str) -> str:
    out, ok = sh(["git", "log", "-1", "--format=%B", sha], root)
    return out if ok else ""


def _commit_files(root: Path, sha: str) -> list[str]:
    out, ok = sh(["git", "show", "--name-only", "--format=", sha], root)
    return [l.strip() for l in out.splitlines() if l.strip()] if ok else []


def _inside(path: str, scope: list[str]) -> bool:
    for s in scope:
        base = s.rstrip("/*")
        if s.endswith("/**") or s.endswith("/*"):
            if path == base or path.startswith(base + "/"):
                return True
        elif path == s or path.startswith(s.rstrip("/") + "/"):
            return True
    return False


def _since(root: Path) -> int:
    """交付指纹自哪个工单起生效（数字部分）。"""
    marker = root / ".delegate" / "delivery-fingerprint-since"
    if marker.exists():
        m = re.search(r"\d+", marker.read_text(errors="ignore"))
        if m:
            return int(m.group(0))
    return 10 ** 9


def _num(task: str) -> int:
    m = re.search(r"(\d+)$", task)
    return int(m.group(1)) if m else 0


def fingerprint_check(root: Path):
    """返回 (bad, legacy, detail)。bad = [(task, reason)]；legacy = 无 TASK.md 的 done 单。"""
    rows = backlog_rows(root)
    if rows is None:
        return None, [], "BACKLOG.md 不存在"
    bad, legacy, claimed = [], [], {}
    for task, status, _ in rows:
        if status != "done":
            continue
        tdir = root / ".delegate" / task
        task_md, receipt_md = tdir / "TASK.md", tdir / "RECEIPT.md"
        if _num(task) < _since(root) or not task_md.exists():
            legacy.append(task)
            continue
        tk = _read_kv(task_md)
        scope = _scope_paths(tk.get("delivery_scope", ""))
        ok, why = _scope_ok(scope)
        if not ok:
            bad.append((task, why)); continue
        if not tk.get("proof_command"):
            bad.append((task, "缺 proof_command")); continue
        rc = _read_kv(receipt_md) if receipt_md.exists() else {}
        sha = (rc.get("result_commit") or "").strip()
        if not sha or not re.fullmatch(r"[0-9a-f]{7,40}", sha):
            bad.append((task, "RECEIPT 缺 result_commit")); continue
        if not rc.get("accepted_by"):
            bad.append((task, "RECEIPT 缺 accepted_by")); continue
        if not commit_exists(root, sha):
            bad.append((task, f"commit {sha} 不存在")); continue
        _, anc = sh(["git", "merge-base", "--is-ancestor", sha, "main"], root)
        if not anc:
            bad.append((task, f"commit {sha} 未进 main")); continue
        msg = _commit_msg(root, sha)
        if f"Task-ID: {task}" not in msg:
            bad.append((task, f"提交缺 `Task-ID: {task}`")); continue
        files = _commit_files(root, sha)
        if not files:
            bad.append((task, "该提交没有改动任何文件")); continue
        outside = [f for f in files if not _inside(f, scope)]
        if outside:
            bad.append((task, f"改动超出声明范围：{outside[:3]}")); continue
        if sha in claimed:
            bad.append((task, f"commit 与 {claimed[sha]} 重复认领")); continue
        claimed[sha] = task
    return bad, legacy, ""


def count_open_tickets(root: Path) -> int:
    rows = backlog_rows(root) or []
    return sum(1 for _, status, _ in rows if status in ("dispatched", "verifying", "rework"))


def evidence_stats(root: Path):
    """每个工单分别统计，返回最坏的两条记录（文件数、体积各自归属）。"""
    worst = {"files": (0, ""), "mb": (0.0, "")}
    base = root / ".delegate"
    if not base.exists():
        return worst
    for task in base.iterdir():
        ev = task / "evidence" if task.is_dir() else None
        if not ev or not ev.exists():
            continue
        n = sum(1 for p in ev.rglob("*") if p.is_file())
        mb = dir_size_mb(ev)
        if n > worst["files"][0]:
            worst["files"] = (n, task.name)
        if mb > worst["mb"][0]:
            worst["mb"] = (round(mb, 1), task.name)
    return worst


def load_exceptions(root: Path, max_days: int):
    path = root / ".delegate" / "guard-exceptions.json"
    if not path.exists():
        return {}, []
    try:
        raw = json.loads(path.read_text())
    except Exception:
        return {}, ["guard-exceptions.json 解析失败，按无例外处理"]
    today = time.strftime("%Y-%m-%d")
    horizon = time.strftime("%Y-%m-%d", time.localtime(time.time() + max_days * 86400))
    active, problems = {}, []
    for name, v in (raw or {}).items():
        if not isinstance(v, dict):
            problems.append(f"{name}: 条目不是对象")
            continue
        owner, reason, exp = v.get("owner"), v.get("reason"), str(v.get("expires", ""))
        if not owner or not reason:
            problems.append(f"{name}: 缺 owner 或 reason")
            continue
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", exp):
            problems.append(f"{name}: expires 不是 YYYY-MM-DD")
            continue
        if exp < today:
            problems.append(f"{name}: 已过期（{exp}）")
            continue
        if exp > horizon:
            problems.append(f"{name}: 超出 {max_days} 天上限（{exp}）")
            continue
        active[name] = v
    return active, problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    root = Path(args.root).resolve()

    cfg = dict(DEFAULTS)
    cfg_path = root / ".delegate" / "guard.json"
    if cfg_path.exists():
        try:
            cfg.update(json.loads(cfg_path.read_text()))
        except Exception:
            print("WARN: guard.json 解析失败，用默认阈值")

    findings, violations = [], []

    def record(name, value, limit, unit, ok, hint):
        findings.append({"check": name, "value": value, "limit": limit, "unit": unit,
                         "ok": ok, "hint": hint})
        if not ok:
            violations.append(name)

    works, why = git_works(root)
    record("probe", "ok" if works else "ERR", "ok", "", works, why or "git 探测正常")
    if not works:
        return _emit(findings, violations, root, args.json, cfg)

    age, err = oldest_uncommitted_hours(root)
    record("commit_age", round(age, 1) if age is not None else None,
           cfg["commit_age_hours"], "h", err == "" and (age is None or age <= cfg["commit_age_hours"]),
           err or "最久未提交改动超过阈值（告警）")

    last, err = last_commit_hours(root)
    record("last_commit", round(last, 1) if last is not None else None,
           cfg["commit_age_hours"], "h", err == "" and (last is None or last <= cfg["commit_age_hours"]),
           err or "最近一次提交超过阈值（告警）")

    bad, legacy, err = fingerprint_check(root)
    if bad is None:
        record("deliverable", "ERR", 0, "count", False, err or "无法解析 backlog")
    else:
        detail = "；".join(f"{t}({r})" for t, r in bad[:3]) if bad else "无"
        record("deliverable", len(bad), 0, "count", not bad, "交付指纹不成立：" + detail)
    if legacy:
        record("legacy_done", len(legacy), 9999, "count", True,
               f"遗留工单无 TASK.md（不追责）：{', '.join(legacy[:5])}")

    record("delegate_size", round(dir_size_mb(root / ".delegate"), 1) if (root / ".delegate").exists() else 0.0,
           cfg["delegate_size_mb"], "MB",
           dir_size_mb(root / ".delegate") <= cfg["delegate_size_mb"] if (root / ".delegate").exists() else True,
           "回收已合并的工作树与旧证据")

    wt, err = count_worktrees(root)
    record("worktrees", wt if wt is not None else "ERR", cfg["worktrees"], "count",
           err == "" and (wt is None or wt <= cfg["worktrees"]), err or "已合并的工作树立即删")

    state = root / ".delegate" / "PM-STATE.md"
    state_kb = state.stat().st_size / 1024 if state.exists() else 0.0
    record("state_size", round(state_kb, 1), cfg["state_kb"], "KB",
           state_kb <= cfg["state_kb"], "状态压成索引，细节进讨论稿")

    ev = evidence_stats(root)
    record("evidence_files", ev["files"][0], cfg["evidence_files_per_task"], "count",
           ev["files"][0] <= cfg["evidence_files_per_task"],
           f"证据文件过多（{ev['files'][1]}）：先打包归档，禁止删除唯一证据")
    record("evidence_size", ev["mb"][0], cfg["evidence_mb_per_task"], "MB",
           ev["mb"][0] <= cfg["evidence_mb_per_task"],
           f"证据体积超限（{ev['mb'][1]}）：打包归档，不许删唯一证据")

    sessions = count_sessions_today(root)
    record("sessions_today", sessions, cfg["sessions_per_day"], "count",
           sessions <= cfg["sessions_per_day"], "开窗口不是解药：先交付再换窗")

    tickets = count_open_tickets(root)
    record("open_tickets", tickets, cfg["open_tickets"], "count",
           tickets <= cfg["open_tickets"], "同时进行的工单太多，先关掉再开新的")

    return _emit(findings, violations, root, args.json, cfg)


def _emit(findings, violations, root, as_json, cfg):
    active, problems = load_exceptions(root, int(cfg.get("exception_max_days", 90)))
    still = [v for v in violations if v not in active]
    if as_json:
        print(json.dumps({"findings": findings, "violations": still,
                          "excused": [v for v in violations if v in active],
                          "exception_problems": problems}, ensure_ascii=False, indent=2))
        return 1 if still else 0

    print(f"# 交付与资源闸门 · {root.name}")
    for f in findings:
        mark = "OK  " if f["ok"] else ("WARN" if f["check"] in WARN and f["ok"] is False and f["value"] is not None else "FAIL")
        if f["check"] in WARN and not f["ok"]:
            mark = "WARN"
        val = "-" if f["value"] is None else f["value"]
        print(f"{mark} {f['check']:<15} {str(val):>8} {f['unit']:<6} (上限 {f['limit']})")
        if not f["ok"]:
            print(f"     → {f['hint']}")
    for v in still:
        if v in active:
            print(f"EXCUSED {v}: {active[v]['reason']}（{active[v]['owner']}，到期 {active[v]['expires']}）")
    for p in problems:
        print(f"WARN 例外文件：{p}")
    print()
    hard = [v for v in still]
    print("ALL OK" if not hard else f"VIOLATIONS: {len(hard)} → {', '.join(hard)}")
    return 1 if hard else 0


if __name__ == "__main__":
    raise SystemExit(main())
