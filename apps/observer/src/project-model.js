// Deterministic, local demonstration data. This model performs no I/O.
export const PROJECT_CYCLE_SECONDS = 90;

const EPSILON = 1e-9;
const PROJECTS = [
  {
    id: 'shipboss', name: 'SHIPBOSS', source: 'DSH · 演示', offset: 0, skillsUsed: 16,
    tasks: [
      { key: 'a', title: '演示：多项目状态卡', assignee: 'eng-a' },
      { key: 'b', title: '演示：桌面回报摘要', assignee: 'eng-b' },
    ],
  },
  {
    id: 'website', name: '网站改版', source: 'Codex · 演示', offset: 12, skillsUsed: 5,
    tasks: [{ key: 'a', title: '演示：网站信息架构方案', assignee: 'eng-a' }],
    initialEvent: 'human-needed',
  },
  {
    id: 'tool', name: '小工具', source: 'DSH · 演示', offset: 24, skillsUsed: 9,
    tasks: [{ key: 'a', title: '演示：本地清单导出', assignee: 'eng-a' }],
    initialEvent: 'completed',
  },
];

// Events address one actor/task, never a global project stage. Equal timestamps
// are reduced in this order, so the verifier and PM each own at most one task.
const EVENTS = [
  [0, 'dispatch-started', null, 'pm', '演示：思考任务拆分与验收条件', 'thinking'],
  [4, 'dispatch-ready', null, 'pm', '演示：派发两项独立任务', 'working'],
  [4, 'implementation-started', 'a', 'eng-a', '演示：思考状态卡的实现方案', 'thinking'],
  [6, 'implementation-started', 'b', 'eng-b', '演示：思考回报摘要的实现方案', 'thinking'],
  [7, 'dispatch-finished', null, 'pm', '演示：派发完成，等待任务回调'],
  [7, 'implementation-motion', 'a', 'eng-a', '演示：编写多项目状态卡', 'working'],
  [9, 'recording-started', null, 'scribe', '演示：记录对话中的改动要点', 'reading'],
  [10, 'implementation-motion', 'b', 'eng-b', '演示：编写桌面回报摘要', 'working'],
  [14, 'implementation-motion', 'a', 'eng-a', '演示：运行测试，在沙发等待结果', 'testing'],
  [19, 'recording-finished', null, 'scribe', '演示：记录完成，整理归档', 'idle'],
  [21, 'implementation-motion', 'a', 'eng-a', '演示：整理测试结果与交付说明', 'working'],
  [22, 'implementation-finished', 'a', 'eng-a', '演示：A 首次交付，进入独立验收队列'],
  [22, 'verification-started', 'a', 'verifier', '演示：思考 A 的验收边界', 'thinking'],
  [25, 'verification-motion', 'a', 'verifier', '演示：独立运行 A 的验收检查', 'testing'],
  [28, 'implementation-motion', 'b', 'eng-b', '演示：运行测试，在走廊踱步等待', 'testing'],
  [31, 'verification-rejected', 'a', 'verifier', '演示：A 验收失败，缺少空状态检查', 'rejected'],
  [35, 'verification-released', 'a', 'verifier', '演示：退回 A，等待修复后的交付'],
  [35, 'rework-started', 'a', 'eng-a', '演示：第二次实现，思考空状态修复', 'thinking'],
  [38, 'implementation-motion', 'a', 'eng-a', '演示：修复空状态并补充检查', 'working'],
  [39, 'implementation-motion', 'b', 'eng-b', '演示：完善摘要与交付说明', 'working'],
  [47, 'implementation-motion', 'a', 'eng-a', '演示：运行修复后的测试，在沙发等待', 'testing'],
  [53, 'implementation-motion', 'a', 'eng-a', '演示：整理修复证据，准备再次交付', 'working'],
  [55, 'implementation-finished', 'a', 'eng-a', '演示：A 第二次交付，重新进入验收队列'],
  [55, 'verification-started', 'a', 'verifier', '演示：复查 A 的修复范围', 'thinking'],
  [58, 'verification-motion', 'a', 'verifier', '演示：重新运行 A 的独立验收检查', 'testing'],
  [60, 'implementation-finished', 'b', 'eng-b', '演示：B 独立交付，在 A 后等待验收'],
  [64, 'verification-passed', 'a', 'verifier', '演示：A 第二次验收通过，回调给 PM'],
  [65, 'verification-started', 'b', 'verifier', '演示：思考 B 的验收边界', 'thinking'],
  [68, 'verification-motion', 'b', 'verifier', '演示：独立运行 B 的验收检查', 'testing'],
  [70, 'review-finished', 'a', 'pm', '演示：PM 完成 A 的回报复核'],
  [75, 'verification-passed', 'b', 'verifier', '演示：B 验收通过，回调给同一位 PM'],
  [82, 'review-finished', 'b', 'pm', '演示：两项回报已复核，工作室待命'],
];

const taskId = (projectId, epoch, key) => `${projectId}-e${epoch}-${key}`;
const seconds = value => Math.round(value * 1e6) / 1e6;

function makeReport(task, event, outcome = 'PASS') {
  const failed = outcome === 'FAIL', human = outcome === 'NEEDS-HUMAN';
  return {
    id: `${task.id}-attempt-${task.attempt}`, taskId: task.id, attempt: task.attempt,
    eventId: event.id, eventSeq: event.seq, time: event.time,
    title: `${task.title} · 第 ${task.attempt} 次演示回报`, verdict: `${outcome} · 演示`,
    changed: human ? '演示：准备了两种信息架构方向，等待选择。'
      : failed ? '演示：首次实现已交付，验收发现遗漏的空状态。'
        : `演示：完成「${task.title.replace('演示：', '')}」的模拟交付。`,
    verified: human ? '演示：仅展示待决策状态，没有执行真实检查。'
      : failed ? '演示：模拟独立验收失败；空状态断言未通过，需要返工。'
        : '演示：模拟独立验收通过；没有读取源码或运行真实项目检查。',
    risk: '演示数据，不代表真实代码、构建或交付质量。',
    needsYou: human ? '演示：选择保留现有导航或采用新版结构；这里只展示问题。'
      : failed ? '演示：工程师将自动返工，无需真实审批。' : '演示无需操作；本页只展示模拟回报。',
    simulated: true,
  };
}

function makeEvent(state, seq, time, type, key, actorId, activity, motion = 'idle') {
  const id = key ? taskId(state.id, state.epoch, key) : null;
  const attempt = id ? state.tasks[id].attempt + Number(type === 'rework-started') : null;
  return {
    id: `${state.id}-e${state.epoch}-event-${seq}`,
    projectId: state.id, epoch: state.epoch, seq, time, type, taskId: id,
    actorId, activity, motion, attempt, simulated: true,
  };
}

function reduceEvent(state, event) {
  if (event.projectId !== state.id || event.epoch !== state.epoch || event.seq !== state.seq + 1) return state;
  const task = event.taskId ? state.tasks[event.taskId] : null;
  if (event.taskId && !task) return state;
  const next = { ...state, tasks: { ...state.tasks }, seq: event.seq, latestEvent: event, events: [...state.events, event] };
  const update = changes => { next.tasks[task.id] = { ...task, ...changes }; };
  const report = outcome => {
    const item = makeReport(task, event, outcome);
    next.reports = [...state.reports, item];
    update({ verdict: item.verdict, evidence: [...task.evidence, item.verified] });
    return next.tasks[task.id];
  };
  switch (event.type) {
    case 'recording-started':
      next.recording = true; next.scribeMotion = event.motion; next.scribeActivity = event.activity;
      break;
    case 'recording-finished':
      next.recording = false; next.scribeMotion = 'idle'; next.scribeActivity = event.activity;
      break;
    case 'dispatch-started':
    case 'dispatch-ready':
      next.dispatching = true; next.pmMotion = event.motion; next.pmActivity = event.activity;
      break;
    case 'dispatch-finished':
      next.dispatching = false;
      break;
    case 'implementation-started':
    case 'rework-started':
      update({ status: 'implementing', attempt: event.attempt, motion: event.motion, activity: event.activity });
      break;
    case 'implementation-motion':
      if (task.status !== 'implementing') return state;
      update({ motion: event.motion, activity: event.activity });
      break;
    case 'implementation-finished':
      update({ status: 'verifying', motion: 'idle', activity: event.activity, verification: 'queued' });
      next.verificationQueue = [...state.verificationQueue, task.id];
      break;
    case 'verification-started':
      if (state.verifierTaskId || state.verificationQueue[0] !== task.id) return state;
      update({ verification: 'active' });
      next.verificationQueue = state.verificationQueue.slice(1);
      next.verifierTaskId = task.id;
      next.verifierMotion = event.motion; next.verifierActivity = event.activity;
      break;
    case 'verification-motion':
      if (state.verifierTaskId !== task.id || task.verification !== 'active') return state;
      next.verifierMotion = event.motion; next.verifierActivity = event.activity;
      break;
    case 'verification-rejected':
      if (state.verifierTaskId !== task.id || task.verification !== 'active') return state;
      next.tasks[task.id] = { ...report('FAIL'), status: 'rework', verification: 'rejected', activity: event.activity };
      next.verifierMotion = 'rejected'; next.verifierActivity = event.activity;
      break;
    case 'verification-released':
      if (state.verifierTaskId !== task.id || task.verification !== 'rejected') return state;
      next.verifierTaskId = null;
      break;
    case 'verification-passed':
      if (state.verifierTaskId !== task.id || task.verification !== 'active') return state;
      next.tasks[task.id] = { ...report('PASS'), status: 'reviewing', verification: 'passed', activity: event.activity };
      next.verifierTaskId = null;
      next.reviewQueue = [...state.reviewQueue, task.id];
      break;
    case 'review-finished':
      if (state.reviewQueue[0] !== task.id) return state;
      update({ status: 'done', activity: event.activity });
      next.reviewQueue = state.reviewQueue.slice(1);
      break;
    case 'human-needed':
      next.tasks[task.id] = { ...report('NEEDS-HUMAN'), status: 'reviewing', activity: event.activity };
      next.needsAttention = true; next.awaitingUser = true;
      next.pendingQuestion = {
        id: `${state.id}-e${state.epoch}-question-1`, sessionId: 'demo',
        question: '演示：网站导航保留现有结构，还是采用新版信息架构？', simulated: true,
      };
      break;
    case 'completed':
      next.tasks[task.id] = { ...report('PASS'), status: 'done', verification: 'passed', activity: event.activity };
      break;
    case 'project-added':
      break;
    default:
      return state;
  }
  return next;
}

function makeState(definition, epoch = 1, createdAt = definition.offset) {
  const tasks = Object.fromEntries(definition.tasks.map(({ key, title, assignee }) => {
    const id = taskId(definition.id, epoch, key);
    return [id, {
      id, title, status: 'queued', assignee, attempt: 1, motion: 'idle', activity: '演示：等待派发',
      verdict: null, verification: null, evidence: [], simulated: true,
    }];
  }));
  let state = {
    id: definition.id, epoch, tasks, seq: 0, latestEvent: null, events: [],
    dispatching: false, pmMotion: 'idle', pmActivity: '',
    recording: false, scribeMotion: 'idle', scribeActivity: '',
    verifierTaskId: null, verifierMotion: 'idle', verifierActivity: '', verificationQueue: [],
    reviewQueue: [], reports: [], needsAttention: false, awaitingUser: false, pendingQuestion: null,
  };
  if (definition.initialEvent) {
    const human = definition.initialEvent === 'human-needed';
    state = reduceEvent(state, makeEvent(state, 1, createdAt, definition.initialEvent, definition.tasks[0]?.key, 'pm',
      human ? '演示：等待信息架构选择，问题持续保留' : definition.tasks.length ? '演示：模拟交付回报已就绪' : '演示：新增空闲项目，等待派发'));
  }
  return state;
}

function deriveActors(state) {
  const tasks = Object.values(state.tasks), reviewing = state.reviewQueue[0] || null;
  const pmActive = state.awaitingUser || state.dispatching || Boolean(reviewing);
  const pm = {
    id: 'pm', role: 'pm', name: '产品经理', active: pmActive,
    taskId: state.awaitingUser ? tasks[0]?.id || null : reviewing,
    motion: state.awaitingUser ? 'waiting' : reviewing ? 'working' : state.dispatching ? state.pmMotion : 'idle',
    activity: state.awaitingUser ? '演示：等待你的信息架构选择'
      : reviewing ? '演示：查看验收回报，安排后续' : state.dispatching ? state.pmActivity : '演示：等待任务回调',
    papers: state.awaitingUser ? 1 : state.dispatching ? tasks.length : state.reviewQueue.length,
  };
  const engineers = ['eng-a', 'eng-b'].map((id, index) => {
    const task = tasks.find(item => item.assignee === id), active = task?.status === 'implementing';
    return {
      id, role: 'engineer', name: `工程师 ${index ? 'B' : 'A'}`, active,
      taskId: task?.id || null, motion: active ? task.motion : 'idle',
      activity: task?.activity || '演示：等待派发', papers: Number(active),
    };
  });
  const verifier = {
    id: 'verifier', role: 'verifier', name: '验收员', active: Boolean(state.verifierTaskId),
    taskId: state.verifierTaskId, motion: state.verifierTaskId ? state.verifierMotion : 'idle',
    activity: state.verifierTaskId ? state.verifierActivity
      : state.verificationQueue.length ? '演示：准备接手验收队列' : '演示：等待工程师交付',
    papers: Number(Boolean(state.verifierTaskId)) + state.verificationQueue.length,
  };
  return [pm, ...engineers, verifier];
}

function projectSnapshot(definition, state, elapsed) {
  const tasks = Object.values(state.tasks).map(task => ({ ...task, evidence: [...task.evidence] }));
  // testing is an overlapping implementation subset, not another task status.
  const counts = { implementing: 0, testing: 0, rework: 0, verifying: 0, reviewing: 0, done: 0, queued: 0 };
  tasks.forEach(task => { counts[task.status]++; if (task.status === 'implementing' && task.motion === 'testing') counts.testing++; });
  const actors = deriveActors(state);
  const status = state.needsAttention ? 'needs-human'
    : counts.implementing ? 'implementing' : counts.rework ? 'rework' : counts.verifying ? 'verifying'
      : counts.reviewing ? 'reviewing' : state.dispatching ? 'dispatching' : tasks.length ? 'done' : 'idle';
  const activityParts = [
    counts.implementing ? `${counts.implementing} 项实现${counts.testing ? `（${counts.testing} 项测试）` : ''}` : '',
    counts.rework ? `${counts.rework} 项待返工` : '',
    state.verifierTaskId ? state.verifierMotion === 'rejected' ? '验收失败，退回修复' : '1 项独立验收' : '',
    state.verificationQueue.length ? `${state.verificationQueue.length} 项等待验收` : '',
    state.reviewQueue.length ? `PM 复核 ${state.reviewQueue.length} 份回报` : '',
  ].filter(Boolean);
  const activity = state.awaitingUser ? '演示：等待信息架构选择'
    : activityParts.length ? `演示：${activityParts.join(' · ')}` : state.dispatching ? state.pmActivity
      : !tasks.length ? '演示：空闲，等待派发' : definition.id === 'shipboss' ? '演示：两项完成，等待下一轮' : '演示：交付回报已就绪';
  return {
    id: definition.id, name: definition.name, source: definition.source, skillsUsed: definition.skillsUsed ?? 0, status, activity,
    needsAttention: state.needsAttention, awaitingUser: state.awaitingUser,
    recording: Boolean(state.recording), scribeActivity: state.scribeActivity || '',
    pendingQuestion: state.pendingQuestion ? { ...state.pendingQuestion } : null,
    unreadReports: state.reports.length,
    engineerCount: actors.filter(actor => actor.role === 'engineer' && actor.active).length,
    verifierCount: Number(Boolean(state.verifierTaskId)),
    tasks, actors, reports: state.reports.map(report => ({ ...report })), counts,
    queuedReports: state.reviewQueue.length, verificationQueue: [...state.verificationQueue],
    latestEvent: state.latestEvent ? { ...state.latestEvent } : null, events: state.events.map(event => ({ ...event })),
    epoch: state.epoch,
    time: seconds(definition.id === 'shipboss' ? Math.max(0, elapsed - (state.epoch - 1) * PROJECT_CYCLE_SECONDS) : elapsed + definition.offset),
    elapsed: seconds(elapsed), simulated: true,
  };
}

/**
 * tick(dt) advances every project's clock, without selection or real sessions.
 * Getters return detached snapshots. SHIPBOSS repeats its event sequence at 90s.
 * addProject only registers a local, idle demonstration; it dispatches no work.
 */
export function createProjectModel() {
  let elapsed = 0;
  const definitions = new Map(PROJECTS.map(definition => [definition.id, definition]));
  const states = new Map(PROJECTS.map(definition => [definition.id, makeState(definition)]));
  function tick(dt) {
    if (typeof dt !== 'number' || !Number.isFinite(dt) || dt < 0) throw new RangeError('tick(dt) requires finite, non-negative seconds');
    const nextElapsed = elapsed + dt;
    if (!Number.isFinite(nextElapsed)) throw new RangeError('Model time must remain finite');
    elapsed = nextElapsed;
    const epoch = Math.floor((elapsed + EPSILON) / PROJECT_CYCLE_SECONDS) + 1;
    let state = states.get('shipboss');
    if (state.epoch !== epoch) state = makeState(PROJECTS[0], epoch);
    const time = Math.max(0, elapsed - (epoch - 1) * PROJECT_CYCLE_SECONDS);
    while (state.seq < EVENTS.length && EVENTS[state.seq][0] <= time + EPSILON) {
      const event = makeEvent(state, state.seq + 1, ...EVENTS[state.seq]);
      const next = reduceEvent(state, event);
      if (next === state) throw new Error(`Invalid demonstration event: ${event.id}`);
      state = next;
    }
    states.set('shipboss', state);
  }
  function getProject(id) {
    const definition = definitions.get(id);
    return definition ? projectSnapshot(definition, states.get(id), elapsed) : undefined;
  }
  function getProjects() {
    return [...definitions.keys()].map(id => {
      const { name, source, skillsUsed, status, activity, needsAttention, awaitingUser, pendingQuestion, unreadReports, engineerCount, verifierCount, counts } = getProject(id);
      return { id, name, source, skillsUsed, status, activity, needsAttention, awaitingUser, pendingQuestion, unreadReports, engineerCount, verifierCount, counts, simulated: true };
    });
  }
  function addProject({ id, name, source = 'Codex · 演示', skillsUsed = 3 } = {}) {
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/i.test(id) || typeof name !== 'string' || !name.trim() || typeof source !== 'string' || !source.trim()) {
      throw new TypeError('A simulated project requires a stable id, name, and source label');
    }
    if (definitions.has(id)) throw new RangeError(`Project already exists: ${id}`);
    if (!Number.isInteger(skillsUsed) || skillsUsed < 0) throw new TypeError('skillsUsed must be a non-negative integer');
    const definition = { id, name: name.trim(), source: source.includes('演示') ? source : `${source} · 演示`, offset: 0, skillsUsed, tasks: [], initialEvent: 'project-added' };
    const state = makeState(definition, 1, seconds(elapsed));
    definitions.set(id, definition); states.set(id, state);
    return getProject(id);
  }
  tick(0);
  return { tick, getProjects, getProject, addProject, snapshot: () => [...definitions.keys()].map(getProject) };
}
