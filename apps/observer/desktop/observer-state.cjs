'use strict';

// Validation and normalization for the read-only observer state file bridge.
// The file is produced by the skill; the observer never writes it back.
const OBSERVER_STATE_LIMIT = 256 * 1024;
const { normalizeToolActivity } = require('./activity-contract.cjs');
const ACTOR_IDS = ['pm', 'eng-a', 'eng-b', 'verifier'];
const ROLE_BY_ID = { pm: 'pm', 'eng-a': 'engineer', 'eng-b': 'engineer', verifier: 'verifier', recording: 'recording' };
const ACTOR_NAME = { pm: '产品经理', 'eng-a': '工程师 A', 'eng-b': '工程师 B', verifier: '验收员', recording: '记录员' };
const PROJECT_STATUSES = new Set(['needs-human', 'implementing', 'rework', 'verifying', 'reviewing', 'dispatching', 'done', 'idle']);
// needs-human is not in the v1 task enum, but the reference writer emits it for blocked rows.
const TASK_STATUSES = new Set(['queued', 'implementing', 'verifying', 'rework', 'reviewing', 'done', 'needs-human']);
const MOTIONS = new Set(['idle', 'thinking', 'working', 'testing', 'waiting', 'rejected', 'reading']);
const VERIFICATIONS = new Set(['queued', 'active', 'rejected', 'passed']);
const ASSIGNEES = new Set(ACTOR_IDS);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

const text = (value, fallback = '') => typeof value === 'string' ? value : fallback;
const integer = (value, fallback, minimum = 0) => Number.isInteger(value) && value >= minimum ? value : fallback;
const finite = (value, fallback = 0) => Number.isFinite(value) && value >= 0 ? value : fallback;
const motion = value => MOTIONS.has(value) ? value : 'idle';
const nullableText = value => typeof value === 'string' ? value : null;
const nullableEnum = (value, allowed) => typeof value === 'string' && allowed.has(value) ? value : null;

function normalizePendingQuestion(value) {
  // The reference writer currently emits a plain string for a blocked task.
  // Accept it and shape it like the contract object so the UI can show it.
  if (typeof value === 'string' && value.trim()) {
    return { id: 'pending-question', sessionId: '', question: value.trim() };
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.question === 'string' && value.question.trim()) {
    return {
      id: text(value.id, 'pending-question') || 'pending-question',
      sessionId: text(value.sessionId),
      question: value.question.trim(),
    };
  }
  return null;
}

function normalizeActor(value, projectId) {
  if (!value || typeof value !== 'object' || !Object.hasOwn(ROLE_BY_ID, value.id)) return null;
  return {
    id: value.id,
    role: ROLE_BY_ID[value.id],
    name: text(value.name, ACTOR_NAME[value.id]).trim() || ACTOR_NAME[value.id],
    active: value.active === true,
    uncertain: value.uncertain === true,
    taskId: typeof value.taskId === 'string' && value.taskId ? value.taskId : null,
    motion: motion(value.motion),
    activity: text(value.activity),
    papers: integer(value.papers, value.active === true ? 1 : 0),
    toolActivity: value.active === true && value.uncertain !== true ? normalizeToolActivity(value.toolActivity, projectId, value.id) : null,
  };
}

function normalizeTask(value) {
  if (!value || typeof value !== 'object' || !ID_PATTERN.test(text(value.id))) return null;
  const status = TASK_STATUSES.has(value.status) ? value.status : 'queued';
  const assignee = ASSIGNEES.has(value.assignee) ? value.assignee : 'pm';
  return {
    id: value.id,
    title: text(value.title, value.id) || value.id,
    status,
    assignee,
    attempt: integer(value.attempt, 1, 1),
    motion: motion(value.motion),
    activity: text(value.activity),
    verdict: nullableText(value.verdict),
    verification: nullableEnum(value.verification, VERIFICATIONS),
    evidence: Array.isArray(value.evidence) ? value.evidence.filter(item => typeof item === 'string').slice(0, 32) : [],
  };
}

function normalizeReport(value) {
  if (!value || typeof value !== 'object' || typeof value.verdict !== 'string' || !value.verdict) return null;
  return {
    id: text(value.id, 'report') || 'report',
    taskId: text(value.taskId),
    attempt: integer(value.attempt, 1, 1),
    title: text(value.title, '回报') || '回报',
    verdict: value.verdict,
    changed: text(value.changed, '无') || '无',
    verified: text(value.verified, '无') || '无',
    risk: text(value.risk, '无') || '无',
    needsYou: text(value.needsYou, '无') || '无',
  };
}

function deriveCounts(tasks) {
  const counts = { implementing: 0, testing: 0, rework: 0, verifying: 0, reviewing: 0, done: 0, queued: 0 };
  for (const task of tasks) {
    const key = task.status === 'needs-human' ? 'queued' : task.status;
    if (key in counts) counts[key] += 1;
    if (task.status === 'implementing' && task.motion === 'testing') counts.testing += 1;
  }
  return counts;
}

function deriveStatus(tasks, needsAttention) {
  if (needsAttention) return 'needs-human';
  const counts = deriveCounts(tasks);
  if (counts.implementing) return 'implementing';
  if (counts.rework) return 'rework';
  if (counts.verifying) return 'verifying';
  if (counts.reviewing) return 'reviewing';
  if (counts.queued) return 'dispatching';
  return tasks.length && tasks.every(task => task.status === 'done') ? 'done' : 'idle';
}

function normalizeProject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!ID_PATTERN.test(text(value.id))) return null;
  if (!text(value.name).trim() || typeof value.source !== 'string') return null;
  if (!Array.isArray(value.actors) || value.actors.length !== ACTOR_IDS.length) return null;
  const actors = ACTOR_IDS.map(id => normalizeActor(value.actors.find(actor => actor && actor.id === id), value.id));
  if (actors.some(actor => actor === null)) return null;
  if (!Array.isArray(value.tasks) || !Array.isArray(value.reports)) return null;

  const tasks = value.tasks.map(normalizeTask).filter(Boolean);
  const reports = value.reports.map(normalizeReport).filter(Boolean);
  const needsAttention = value.needsAttention === true, awaitingUser = value.awaitingUser === true;
  const pm = actors[0];
  // Contract constraint: a waiting PM is present and uses the waiting pose.
  if (needsAttention) { pm.active = true; pm.motion = 'waiting'; }

  const status = PROJECT_STATUSES.has(value.status) ? value.status : deriveStatus(tasks, needsAttention);
  const recording = value.recording === true;
  const recordingActor = value.recordingActor?.id === 'recording' ? normalizeActor(value.recordingActor, value.id) : null;
  if (recordingActor) {
    recordingActor.active = recording; recordingActor.uncertain = value.recordingUncertain === true;
    if (!recording || recordingActor.uncertain) recordingActor.toolActivity = null;
  }
  const confirmedPresence = actors.some(actor => actor.active && !actor.uncertain) || (recording && value.recordingUncertain !== true);
  const idleConflict = value.isIdle === true && confirmedPresence;
  return {
    id: value.id,
    name: value.name.trim(),
    source: value.source,
    skillsUsed: integer(value.skillsUsed, 0),
    skillPeriod: text(value.skillPeriod, '今天用过的其它技能'),
    skillDay: nullableText(value.skillDay),
    lastActivityAt: nullableText(value.lastActivityAt),
    idleForSeconds: typeof value.idleForSeconds === 'number' ? Math.max(0, value.idleForSeconds) : null,
    isIdle: confirmedPresence ? false : typeof value.isIdle === 'boolean' ? value.isIdle : status === 'idle',
    status,
    activity: text(value.activity) + (idleConflict ? '; normalized: confirmed presence overrides idle claim' : ''),
    observation: value.observation && typeof value.observation === 'object' ? {
      status: text(value.observation.status),
      reason: text(value.observation.reason),
      observedAt: nullableText(value.observation.observedAt),
    } : null,
    needsAttention,
    awaitingUser,
    pendingQuestion: normalizePendingQuestion(value.pendingQuestion),
    recording, recordingActor,
    recordingUncertain: value.recordingUncertain === true,
    scribeActivity: text(value.scribeActivity),
    unreadReports: integer(value.unreadReports, reports.length),
    engineerCount: actors.filter(actor => actor.role === 'engineer' && actor.active).length,
    verifierCount: Number(actors[3].active),
    tasks,
    actors,
    reports,
    counts: deriveCounts(tasks),
    queuedReports: integer(value.queuedReports, tasks.filter(task => task.status === 'reviewing').length),
    verificationQueue: tasks.filter(task => task.verification === 'queued').map(task => task.id),
    latestEvent: value.latestEvent && typeof value.latestEvent === 'object' && typeof value.latestEvent.id === 'string'
      ? { id: value.latestEvent.id, type: text(value.latestEvent.type), time: finite(value.latestEvent.time) } : null,
    // Event logs are not needed by the watcher; keep the payload small.
    events: [],
    epoch: integer(value.epoch, 1, 1),
    time: finite(value.time),
    simulated: value.simulated === true,
  };
}

function normalizePresentation(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.requests) || value.requests.length > 32) return null;
  const requests = value.requests.filter(request => request &&
    /^[a-f0-9]{64}$/.test(request.id) && ['firstload', 'show'].includes(request.action) &&
    typeof request.at === 'number' && Number.isFinite(request.at) && request.at > 0)
    .map(({ id, action, at }) => ({ id, action, at }));
  return { requests };
}

function normalizeObserverState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'not-object' };
  if (value.version !== 1) return { ok: false, error: 'unsupported-version' };
  if (!Array.isArray(value.projects)) return { ok: false, error: 'projects-not-array' };
  const projects = value.projects.map(normalizeProject).filter(Boolean);
  if (value.projects.length > 0 && projects.length === 0) return { ok: false, error: 'no-valid-projects' };
  return {
    ok: true,
    payload: {
      version: 1,
      generatedAt: nullableText(value.generatedAt),
      source: text(value.source, 'unknown') || 'unknown',
      coverage: value.coverage ? { complete: value.coverage.complete === true, excluded_count: integer(value.coverage.excluded_count, 0), warnings: Array.isArray(value.coverage.warnings) ? value.coverage.warnings.filter(v => typeof v === 'string') : [] } : null,
      projects,
      presentation: normalizePresentation(value.presentation),
    },
  };
}

module.exports = { OBSERVER_STATE_LIMIT, normalizeObserverState };
