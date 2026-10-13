import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../data');
const FILE = join(DATA_DIR, 'projection.json');

const EMPTY = {
  sessions: {},
  events: {},
  eventIds: [],
  auditEvents: [],
  checkpoints: {},
  actSnapshots: [],
  exports: [],
};

function load() {
  if (!existsSync(FILE)) return structuredClone(EMPTY);
  try {
    return { ...structuredClone(EMPTY), ...JSON.parse(readFileSync(FILE, 'utf8')) };
  } catch {
    return structuredClone(EMPTY);
  }
}

function save(state) {
  mkdirSync(DATA_DIR, { recursive: true });
  const temporary = `${FILE}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(temporary, FILE);
}

let state = load();

/** Reset persisted state. Intended for tests. */
export function resetStore() {
  state = structuredClone(EMPTY);
  save(state);
}

export function getCheckpoint(key) {
  return state.checkpoints[key] ?? null;
}

export function setCheckpoint(key, value) {
  state.checkpoints[key] = value;
  save(state);
}

export function addActSnapshot(snapshot) {
  state.actSnapshots.push(snapshot);
  if (state.actSnapshots.length > 100) state.actSnapshots = state.actSnapshots.slice(-100);
  save(state);
  return snapshot;
}

export function latestActSnapshot() {
  return state.actSnapshots.at(-1) ?? null;
}

export function countSessions() {
  return Object.keys(state.sessions).length;
}

export function recordActSyncError(message) {
  state.checkpoints['act:lastError'] = message == null ? null : String(message).slice(0, 500);
  save(state);
}

/**
 * Idempotent session upsert keyed by sessionId. Returns the stored session.
 */
function mergeSession(next, session) {
  const existing = next.sessions[session.sessionId] ?? {};
  const identityFields = ['agentId', 'agentAliasId', 'tenantId', 'projectId'];
  for (const field of identityFields) {
    if (existing[field] && existing[field] !== session[field]) throw new Error(`session identity conflict: ${field}`);
  }
  if (existing.status && existing.status !== 'running' && existing.status !== session.status) throw new Error('session lifecycle conflict');
  next.sessions[session.sessionId] = { ...existing, ...session };
  return next.sessions[session.sessionId];
}

export function upsertSession(session) {
  mergeSession(state, session);
  save(state);
  return state.sessions[session.sessionId];
}

export function ingestTelemetry(session, events = []) {
  const next = structuredClone(state);
  mergeSession(next, session);
  let newEvents = 0;
  for (const event of events) {
    const existingSession = next.sessions[event.sessionId];
    if (!existingSession) throw new Error('event session not found');
    const existingEvent = Object.values(next.events).flat().find((item) => item.eventId === event.eventId);
    if (existingEvent) {
      if (JSON.stringify(existingEvent) !== JSON.stringify(event)) throw new Error('event identity conflict');
      continue;
    }
    next.eventIds.push(event.eventId);
    (next.events[event.sessionId] ??= []).push(event);
    next.events[event.sessionId].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
    newEvents += 1;
  }
  state = next;
  save(state);
  return { session: state.sessions[session.sessionId], newEvents };
}

export function getSession(sessionId, inScope = () => true) {
  const session = state.sessions[sessionId] ?? null;
  return session && inScope(session) ? session : null;
}

export function listSessions({ limit = 50, cursor = null, status = null, agentId = null, tenantId = null, projectId = null, aliasId = null, from = null, to = null, inScope = () => true } = {}) {
  const all = Object.values(state.sessions)
    .filter(inScope)
    .filter((session) => !status || session.status === status)
    .filter((session) => !agentId || session.agentId === agentId)
    .filter((session) => !tenantId || session.tenantId === tenantId)
    .filter((session) => !projectId || session.projectId === projectId)
    .filter((session) => !aliasId || session.agentAliasId === aliasId)
    .filter((session) => !from || String(session.startedAt ?? '') >= from)
    .filter((session) => !to || String(session.startedAt ?? '') <= to)
    .sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')));
  const cursorIndex = cursor ? all.findIndex((s) => s.sessionId === cursor) : -1;
  const start = cursorIndex >= 0 ? cursorIndex + 1 : 0;
  const page = all.slice(start, start + limit);
  return {
    items: page,
    nextCursor: page.length === limit ? page[page.length - 1].sessionId : null,
  };
}

export function dashboardTimeseries({ inScope = () => true, ...filters } = {}) {
  const buckets = new Map();
  for (const session of Object.values(state.sessions).filter(inScope)) {
    if (filters.tenantId && session.tenantId !== filters.tenantId) continue;
    if (filters.projectId && session.projectId !== filters.projectId) continue;
    if (filters.agentId && session.agentId !== filters.agentId) continue;
    if (filters.aliasId && session.agentAliasId !== filters.aliasId) continue;
    if (filters.from && String(session.startedAt ?? '') < filters.from) continue;
    if (filters.to && String(session.startedAt ?? '') > filters.to) continue;
    const day = String(session.startedAt ?? '').slice(0, 10) || 'unknown';
    const bucket = buckets.get(day) ?? { date: day, invocations: 0, failures: 0, tokens: 0, toolCalls: 0 };
    bucket.invocations += 1;
    bucket.failures += session.status === 'failed' ? 1 : 0;
    bucket.tokens += (session.inputTokenCount ?? 0) + (session.outputTokenCount ?? 0);
    bucket.toolCalls += session.toolCallCount ?? 0;
    buckets.set(day, bucket);
  }
  return [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function seedDemoData() {
  const sessions = [
    {
      sessionId: 'demo-session-001', agentId: 'claims-triage', agentAliasId: 'claims-prod',
      startedAt: '2026-10-06T09:12:00.000Z', completedAt: '2026-10-06T09:12:04.200Z',
      status: 'succeeded', durationMs: 4200, inputTokenCount: 820, outputTokenCount: 240,
      toolCallCount: 3, guardrailHit: false, errorClass: null,
    },
    {
      sessionId: 'demo-session-002', agentId: 'claims-triage', agentAliasId: 'claims-prod',
      startedAt: '2026-10-07T14:35:00.000Z', completedAt: '2026-10-07T14:35:07.800Z',
      status: 'failed', durationMs: 7800, inputTokenCount: 610, outputTokenCount: 96,
      toolCallCount: 2, guardrailHit: true, errorClass: 'UPSTREAM_TIMEOUT',
    },
    {
      sessionId: 'demo-session-003', agentId: 'knowledge-helper', agentAliasId: 'knowledge-prod',
      startedAt: '2026-10-08T08:04:00.000Z', completedAt: '2026-10-08T08:04:02.100Z',
      status: 'succeeded', durationMs: 2100, inputTokenCount: 430, outputTokenCount: 180,
      toolCallCount: 1, guardrailHit: false, errorClass: null,
    },
  ];
  const events = [
    { eventId: 'demo-event-001', sessionId: 'demo-session-001', sequence: 1, timestamp: '2026-10-06T09:12:00.100Z', eventType: 'session_started', actorType: 'agent', status: 'ok', redactedSummary: 'Invocation accepted.' },
    { eventId: 'demo-event-002', sessionId: 'demo-session-001', sequence: 2, timestamp: '2026-10-06T09:12:01.400Z', eventType: 'tool_call', actorType: 'agent', toolName: 'claims.lookup', status: 'ok', durationMs: 920, redactedSummary: 'Lookup completed; payload redacted.' },
    { eventId: 'demo-event-003', sessionId: 'demo-session-001', sequence: 3, timestamp: '2026-10-06T09:12:04.200Z', eventType: 'session_completed', actorType: 'agent', status: 'ok', durationMs: 4200, redactedSummary: 'Invocation completed successfully.' },
    { eventId: 'demo-event-004', sessionId: 'demo-session-002', sequence: 1, timestamp: '2026-10-07T14:35:00.100Z', eventType: 'session_started', actorType: 'agent', status: 'ok', redactedSummary: 'Invocation accepted.' },
    { eventId: 'demo-event-005', sessionId: 'demo-session-002', sequence: 2, timestamp: '2026-10-07T14:35:07.800Z', eventType: 'session_failed', actorType: 'agent', status: 'error', durationMs: 7800, redactedSummary: 'Upstream timeout; response content redacted.' },
    { eventId: 'demo-event-006', sessionId: 'demo-session-003', sequence: 1, timestamp: '2026-10-08T08:04:00.100Z', eventType: 'session_started', actorType: 'agent', status: 'ok', redactedSummary: 'Invocation accepted.' },
    { eventId: 'demo-event-007', sessionId: 'demo-session-003', sequence: 2, timestamp: '2026-10-08T08:04:02.100Z', eventType: 'session_completed', actorType: 'agent', status: 'ok', durationMs: 2100, redactedSummary: 'Invocation completed successfully.' },
  ];
  resetStore();
  for (const session of sessions) upsertSession(session);
  for (const event of events) addEvent(event);
  return { sessions: sessions.length, events: events.length };
}

/**
 * Idempotent event insert keyed by eventId. Returns true if newly stored.
 */
export function addEvent(event) {
  if (!event.eventId || !event.sessionId) return false;
  const existingSession = state.sessions[event.sessionId];
  if (!existingSession) throw new Error('event session not found');
  const existingEvent = Object.values(state.events).flat().find((item) => item.eventId === event.eventId);
  if (existingEvent) {
    if (JSON.stringify(existingEvent) !== JSON.stringify(event)) throw new Error('event identity conflict');
    return false;
  }
  state.eventIds.push(event.eventId);
  (state.events[event.sessionId] ??= []).push(event);
  state.events[event.sessionId].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  save(state);
  return true;
}

export function listEvents(sessionId, inScope = () => true) {
  return inScope(state.sessions[sessionId] ?? {}) ? (state.events[sessionId] ?? []) : [];
}

export function addAuditEvent(entry) {
  state.auditEvents.push({ at: new Date().toISOString(), ...entry });
  if (state.auditEvents.length > 10_000) state.auditEvents = state.auditEvents.slice(-10_000);
  save(state);
}

export function listAuditEvents({ limit = 100, cursor = null, inScope = () => true } = {}) {
  const all = [...state.auditEvents].reverse().filter(inScope);
  const start = cursor == null ? 0 : Number(cursor);
  if (!Number.isInteger(start) || start < 0) throw new Error('invalid cursor');
  const page = all.slice(start, start + limit);
  return {
    items: page,
    nextCursor: page.length === limit ? String(start + limit) : null,
  };
}

export function createExport(job) {
  state.exports.push(job);
  save(state);
  return job;
}

export function getExport(exportId) {
  return state.exports.find((job) => job.exportId === exportId) ?? null;
}

export function dashboardSummary({ inScope = () => true, ...filters } = {}) {
  const sessions = Object.values(state.sessions).filter(inScope).filter((session) => {
    if (filters.tenantId && session.tenantId !== filters.tenantId) return false;
    if (filters.projectId && session.projectId !== filters.projectId) return false;
    if (filters.agentId && session.agentId !== filters.agentId) return false;
    if (filters.aliasId && session.agentAliasId !== filters.aliasId) return false;
    if (filters.from && String(session.startedAt ?? '') < filters.from) return false;
    if (filters.to && String(session.startedAt ?? '') > filters.to) return false;
    return true;
  });
  const total = sessions.length;
  const failed = sessions.filter((s) => s.status === 'failed').length;
  return {
    totalSessions: total,
    failedSessions: failed,
    successRate: total ? Math.round(((total - failed) / total) * 10000) / 100 : null,
    totalInputTokens: sessions.reduce((n, s) => n + (s.inputTokenCount ?? 0), 0),
    totalOutputTokens: sessions.reduce((n, s) => n + (s.outputTokenCount ?? 0), 0),
    totalToolCalls: sessions.reduce((n, s) => n + (s.toolCallCount ?? 0), 0),
    guardrailHits: sessions.reduce((n, s) => n + (s.guardrailHit ? 1 : 0), 0),
  };
}
