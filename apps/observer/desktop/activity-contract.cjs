'use strict';
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const TARGET = /^[\p{L}\p{N}_.()@+ -]{1,32}$/u;
const CATEGORIES = new Set(['read', 'search', 'edit', 'command', 'test', 'delegate', 'other']);
const STATES = new Set(['started', 'ended', 'error']);
const SUFFIXES = new Set(['ts','tsx','js','jsx','mjs','cjs','py','go','rs','c','cc','cpp','h','hpp','java','kt','swift','vue','svelte','css','scss','html','md','txt','json','yaml','yml','toml','ini','xml','sh','sql','r','rb','php','lock']);
const SENSITIVE = /(?:^|[._ -])env(?:[._ -]|$)|secret|credential|password|passwd|token|private|id_rsa|key|cert|keystore|wallet/i;
const displayTarget = value => TARGET.test(value) && !SENSITIVE.test(value) && (SUFFIXES.has(value.split('.').at(-1).toLowerCase()) && value.includes('.') || ['Dockerfile','Makefile'].includes(value));
const time = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 253402300799000;
function normalizeToolActivity(value, projectId, actorId) {
  if (!value || value.version !== 1 || value.projectId !== projectId || value.actorId !== actorId
    || typeof value.projectId !== 'string' || typeof value.sessionId !== 'string' || !ID.test(value.projectId) || !ID.test(value.sessionId) || !Number.isInteger(value.runningCount)
    || value.runningCount < 0 || value.runningCount > 32 || typeof value.thinking !== 'boolean'
    || (value.suppressed !== undefined && typeof value.suppressed !== 'boolean')
    || !Array.isArray(value.calls) || value.calls.length > 12) return null;
  const seen = new Set(), calls = [];
  for (const c of value.calls) {
    if (!c || typeof c.callId !== 'string' || !ID.test(c.callId) || seen.has(c.callId)
      || !Number.isSafeInteger(c.sequence) || c.sequence < 0 || !STATES.has(c.state)
      || !CATEGORIES.has(c.category) || !time(c.timestamp) || !time(c.startedAt) || c.timestamp < c.startedAt
      || typeof c.target !== 'string' || (c.target !== '' && !displayTarget(c.target))) return null;
    seen.add(c.callId);
    calls.push({ callId: c.callId, sequence: c.sequence, state: c.state, timestamp: c.timestamp,
      startedAt: c.startedAt, category: c.category, target: c.target });
  }
  if (value.suppressed === true && (value.runningCount !== 0 || value.thinking || calls.length)) return null;
  const active = calls.filter(c => c.state === 'started').length;
  if (active > 8 || calls.length - active > 4 || active !== Math.min(value.runningCount, 8)) return null;
  return { version: 1, projectId, actorId, sessionId: value.sessionId, runningCount: value.runningCount,
    thinking: value.thinking && value.runningCount === 0 && value.suppressed !== true, calls, suppressed: value.suppressed === true };
}
module.exports = { normalizeToolActivity };
