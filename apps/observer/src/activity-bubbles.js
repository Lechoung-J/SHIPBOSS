// Local display scheduler. It never changes role, task, pose or verdict.
export const TOOL_LABELS = {
  read: ['▤', '读文件'], search: ['⌕', '找调用位置'], edit: ['✎', '修改文件'],
  command: ['>_', '执行命令'], test: ['✓', '跑测试'], delegate: ['↗', '请同事检查'], other: ['⚙', '使用工具'],
};
const PHRASES = {
  pm: ['这一步，怎样替老板省心？', '先把下一步想清楚。', '老板专心想，我来认真干。'],
  engineer: ['愿代码少绕弯，老板多赚钱。', '理一理，再往前走。', '认真敲好这一小步。'],
  recording: ['把关键一步记清楚。', '替老板收好这些线索。', '认真留下可用的记录。'],
  verifier: ['再替老板看仔细一点。', '细节也值得再看一眼。', '把这一关看仔细。'],
};
export function createActivityScheduler({ now = Date.now, random = Math.random } = {}) {
  const states = new Map();
  function tick(key, actor, { visible = true, waiting = false, funAllowed = true } = {}) {
    const at = now();
    let s = states.get(key);
    if (!s) { s = { seen: new Set(), thinkingAt: null, cooldown: 0, until: 0, phrase: -1, resumeAt: 0, paused: false, current: null }; states.set(key, s); }
    const activity = actor.toolActivity;
    if (s.session !== activity?.sessionId) {
      s.seen.clear(); s.current = null; s.until = 0; s.thinkingAt = null; s.session = activity?.sessionId;
    }
    const calls = activity?.calls || [];
    const mark = c => `${activity?.sessionId}/${c.callId}`;
    if (!visible || (!actor.active && !actor.uncertain)) {
      s.resumeAt = at; s.paused = true; s.thinkingAt = null; s.current = null; s.until = 0;
      for (const c of calls) if (c.state !== 'started') s.seen.add(mark(c));
      return null;
    }
    if (s.paused) { s.paused = false; s.resumeAt = at; }
    if (actor.uncertain || activity?.suppressed || waiting || actor.motion === 'waiting' || actor.motion === 'rejected') {
      s.thinkingAt = null; s.current = null; s.until = 0;
      for (const c of calls) if (c.state !== 'started') s.seen.add(mark(c));
      // Waiting and rejected already occupy the original status indicator slot.
      return actor.uncertain || activity?.suppressed ? { kind: 'unknown', icon: '?', text: '状态未知 / 暂停' } : null;
    }
    const active = calls.filter(c => c.state === 'started' && c.timestamp <= at + 5000 && at - c.timestamp <= 300000);
    const completed = calls.filter(c => c.state !== 'started' && !s.seen.has(mark(c)) && c.timestamp >= s.resumeAt && c.timestamp <= at + 5000 && at - c.timestamp <= 4000);
    const latest = list => list.slice().sort((a, b) => b.timestamp - a.timestamp || b.sequence - a.sequence)[0];
    const error = latest(completed.filter(c => c.state === 'error'));
    if (!error && s.current?.kind === 'error' && at < s.until) return s.current;
    const selected = error || latest(active) || latest(completed);
    for (const c of completed) s.seen.add(mark(c));
    if (s.seen.size > 64) s.seen = new Set([...s.seen].slice(-64));
    if (selected) {
      s.thinkingAt = null;
      const [icon, label] = TOOL_LABELS[selected.category] || TOOL_LABELS.other;
      const peers = (selected.state === 'started' ? active : calls.filter(c => c.state !== 'started' && Math.abs(c.timestamp - selected.timestamp) <= 1500)).filter(c => c.category === selected.category).length;
      const count = peers > 1 ? ` ×${peers}` : '';
      const parallel = selected.state === 'started' && activity.runningCount > 1 ? ` · ${activity.runningCount}并行` : '';
      const prefix = selected.state === 'error' ? '工具出错 · ' : selected.state === 'ended' ? '刚完成 · ' : '';
      const next = { kind: selected.state === 'error' ? 'error' : 'tool', icon, text: `${prefix}${label}${count}${selected.target ? ` · ${selected.target}` : ''}${parallel}`, callId: selected.callId, state: selected.state };
      // Running displays are updated directly; completed displays get one readable
      // second, regardless of duplicate snapshots. Higher priorities interrupt.
      s.current = next; s.until = selected.state === 'started' ? at : at + 1000;
      return next;
    }
    if (s.current && s.current.kind !== 'fun' && at < s.until) return s.current;
    const thinking = actor.motion === 'thinking' || activity?.thinking === true;
    if (!thinking || activity?.runningCount > 0) { s.thinkingAt = null; s.current = null; return null; }
    s.thinkingAt ??= at;
    if (s.current?.kind === 'fun' && at < s.until) return funAllowed ? s.current : null;
    s.current = null;
    if (!funAllowed || at - s.thinkingAt < 2000 || at < s.cooldown) return null;
    const pool = PHRASES[actor.role] || PHRASES.pm;
    const sample = Math.max(0, Math.min(.999999, Number(random()) || 0));
    let index = Math.floor(sample * pool.length);
    if (index === s.phrase) index = (index + 1) % pool.length;
    s.phrase = index; s.until = at + 2500; s.cooldown = at + 20000 + sample * 20000;
    s.current = { kind: 'fun', icon: '···', text: pool[index], note: '本地角色彩蛋，非真实内部推理' };
    return s.current;
  }
  return { tick, clear: () => states.clear() };
}

// Small screen-space adjustment only; room geometry and camera stay untouched.
export function layoutActivityBubbles(items, viewport) {
  const placed = [], gap = 5;
  const priority = item => item.kind === 'fun' ? 2 : item.kind === 'tool' ? 1 : 0;
  const overlaps = (a, b) => a.left < b.right + gap && a.right + gap > b.left && a.top < b.bottom + gap && a.bottom + gap > b.top;
  const ordered = [...items].sort((a, b) => priority(a) - priority(b) || a.y - b.y || a.key.localeCompare(b.key));
  for (const item of ordered) {
    const clamp = (v, low, high) => Math.max(low, Math.min(high, v));
    const fit = (x, y) => {
      x = clamp(x, viewport.left + item.width / 2 + 5, viewport.right - item.width / 2 - 5);
      y = clamp(y, viewport.top + item.height + 44, viewport.bottom - 34);
      return { x, y, left: x - item.width / 2, right: x + item.width / 2, top: y - item.height, bottom: y };
    };
    const initial = fit(item.x, item.y), options = [initial];
    for (const previous of placed) {
      options.push(fit(initial.x, previous.top - gap), fit(initial.x, previous.bottom + item.height + gap),
        fit(previous.left - item.width / 2 - gap, initial.y), fit(previous.right + item.width / 2 + gap, initial.y));
    }
    options.sort((a, b) => (a.x - item.x) ** 2 + (a.y - item.y) ** 2 - (b.x - item.x) ** 2 - (b.y - item.y) ** 2);
    const position = options.find(option => !placed.some(previous => overlaps(option, previous)));
    // A cramped fun bubble yields its slot. Real activity uses the nearest fit.
    if (!position && item.kind === 'fun') continue;
    placed.push({ ...item, ...(position || initial) });
  }
  return placed;
}

export function createActivityOverlay({ now, random } = {}) {
  const scheduler = createActivityScheduler({ now, random }), slots = new Map();
  const layer = document.createElement('div'); layer.className = 'activity-layer'; layer.setAttribute('aria-label', '角色活动'); document.body.append(layer);
  let visibleFun = 0, pending = [];
  function begin() { visibleFun = 0; pending = []; }
  function update(key, actor, options, point) {
    let node = slots.get(key);
    if (!node) { node = document.createElement('div'); node.className = 'activity-bubble'; node.hidden = true; layer.append(node); slots.set(key, node); }
    const result = scheduler.tick(key, actor, { ...options, funAllowed: visibleFun < 2 });
    node.hidden = !result;
    if (!result) return;
    if (result.kind === 'fun') visibleFun++;
    node.dataset.kind = result.kind; node.dataset.actor = actor.id; node.dataset.key = key;
    node.dataset.state = result.state || ''; node.dataset.callId = result.callId || '';
    const text = `${result.icon} ${result.text}`;
    if (node.textContent !== text) { node.textContent = text; node._bubbleSize = null; }
    node.title = result.note || result.text;
    node._bubbleSize ||= { width: node.offsetWidth, height: node.offsetHeight };
    pending.push({ key, kind: result.kind, x: point.x, y: point.y - 16, ...node._bubbleSize });
  }
  function end(viewport) {
    const layout = layoutActivityBubbles(pending, viewport), shown = new Set(layout.map(item => item.key));
    for (const item of pending) if (!shown.has(item.key)) slots.get(item.key).hidden = true;
    for (const item of layout) {
      const node = slots.get(item.key);
      node.style.left = `${item.x}px`; node.style.top = `${item.y}px`;
      node._bubbleBounds = { left: item.left, right: item.right, top: item.top, bottom: item.bottom };
      const natural = pending.find(candidate => candidate.key === item.key);
      node.style.setProperty('--tail-left', `${Math.max(8, Math.min(item.width - 8, natural.x - item.left))}px`);
    }
  }
  return { begin, update, end, hide: () => { for (const node of slots.values()) node.hidden = true; }, snapshot: () => [...slots.entries()].map(([key, node]) => ({ key, visible: !node.hidden, kind: node.dataset.kind, text: node.textContent, state: node.dataset.state, callId: node.dataset.callId, x: parseFloat(node.style.left), y: parseFloat(node.style.top), bounds: node._bubbleBounds })) };
}
