// Read-only adapter for the skill state bridge. The renderer never writes back.
// It exposes the same surface the demo model provides to widget.js.

function summary(project) {
  return {
    id: project.id,
    name: project.name,
    source: project.source,
    skillsUsed: project.skillsUsed,
    isIdle: project.isIdle, lastActivityAt: project.lastActivityAt, idleForSeconds: project.idleForSeconds,
    status: project.status,
    activity: project.activity,
    needsAttention: project.needsAttention,
    awaitingUser: project.awaitingUser,
    pendingQuestion: project.pendingQuestion,
    unreadReports: project.unreadReports,
    engineerCount: project.engineerCount,
    verifierCount: project.verifierCount,
    counts: project.counts,
    simulated: project.simulated,
  };
}

export function createBridgeModel(initial = null, { now = Date.now, staleAfterMs = 30000 } = {}) {
  let envelope = initial && Array.isArray(initial.projects) ? initial : null;
  const stale = () => {
    if (!envelope) return false;
    const generated = Date.parse(envelope.generatedAt);
    return envelope.status === 'stale' || !Number.isFinite(generated)
      || now() - generated > staleAfterMs;
  };
  const projects = () => {
    if (!envelope) return [];
    if (!stale()) return envelope.projects;
    // Keep rooms and last-known history, but stop presenting stale actors as live work.
    return envelope.projects.map(project => ({
      ...project, isIdle: true, activity: '状态未知：连接已过期，显示最后记录',
      observation: { status: 'unknown', reason: 'stale-bridge' },
      needsAttention: false, awaitingUser: false, pendingQuestion: null,
      recordingActor: project.recordingActor ? { ...project.recordingActor, uncertain: true, active: false, motion: 'idle', toolActivity: null } : null,
      recordingUncertain: true, recording: false, scribeActivity: '', engineerCount: 0, verifierCount: 0,
      actors: project.actors.map(actor => ({ ...actor, uncertain: true, active: false, motion: 'idle', activity: '状态未知' })),
    }));
  };
  return {
    kind: 'bridge',
    setState(next) {
      if (!next || !Array.isArray(next.projects)) return;
      const ids = new Set(next.projects.map(project => project.id));
      const missing = (envelope?.projects || []).filter(project => !ids.has(project.id)).map(project => ({
        ...project, isIdle: true, activity: '状态未知：项目不在最新快照中',
        observation: { status: 'unknown', reason: 'missing-project' },
        needsAttention: false, awaitingUser: false, pendingQuestion: null,
        recordingActor: project.recordingActor ? { ...project.recordingActor, uncertain: true, active: false, motion: 'idle', toolActivity: null } : null,
      recordingUncertain: true, recording: false, scribeActivity: '', engineerCount: 0, verifierCount: 0,
        actors: project.actors.map(actor => ({ ...actor, uncertain: true, active: false, motion: 'idle', activity: '状态未知' })),
      }));
      envelope = { ...next, projects: [...next.projects, ...missing] };
    },
    snapshot: projects,
    getProject(id) { return projects().find(project => project.id === id); },
    getProjects() { return projects().map(summary); },
    getStatus() { return envelope ? { status: stale() ? 'stale' : (envelope.status || 'live'), error: envelope.error || null } : { status: 'waiting', error: null }; },
    tick() {},
  };
}
