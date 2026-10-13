import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { redact, redactionStatus, TELEMETRY_IDENTITY_FIELDS } from './lib/redaction.js';
import { actorCan, authenticate, AuthError, ScopeError, filterForActor, isInScope, requestedFilter, recordScope } from './lib/auth.js';
import * as store from './lib/store.js';
import { ActClient, ActError } from './lib/act-client.js';
import { syncAct } from './lib/act-sync.js';
import { actInventory } from './lib/act-inventory.js';

const PORT = Number(process.env.PORT ?? 8787);
// Read lazily so tests and runtime configuration can set env after import.
const internalToken = () => process.env.CONTROL_TOWER_INTERNAL_TOKEN ?? '';
const mockMode = () => process.env.CONTROL_TOWER_MOCK_DATA === 'true';
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(json);
}

async function sendStatic(res, path) {
  const name = path === '/' ? 'index.html' : path.slice(1);
  if (!['index.html', 'app.js', 'styles.css'].includes(name)) return false;
  try {
    const body = await readFile(join(PUBLIC_DIR, name));
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(name)], 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
  return true;
}

async function readBody(req) {
  let data = '';
  for await (const chunk of req) data += chunk;
  if (data.length > 1_000_000) throw new Error('body too large');
  if (!data) return {};
  try {
    return JSON.parse(data);
  } catch {
    throw new Error('invalid json');
  }
}

function actor(req) {
  if (!req._actor) req._actor = authenticate(req);
  return req._actor;
}

function audit(req, action, resource, result = 'ok', currentActor = actor(req)) {
  store.addAuditEvent({ actor: currentActor.user, role: currentActor.role, ...recordScope(currentActor), action, resource, result });
}

function scoped(actorValue) {
  return (record) => isInScope(actorValue, record);
}

function authorize(req, action, resource) {
  const currentActor = actor(req);
  if (!actorCan(currentActor, action)) {
    audit(req, action, resource, 'denied', currentActor);
    throw new AuthError(403, 'forbidden');
  }
  return currentActor;
}

const SESSION_STATUSES = new Set(['running', 'succeeded', 'failed']);
const SESSION_FIELDS = new Set(['sessionId', 'agentId', 'agentAliasId', 'tenantId', 'projectId', 'status', 'startedAt', 'completedAt', 'durationMs', 'inputTokenCount', 'outputTokenCount', 'toolCallCount', 'guardrailHit', 'errorClass']);
const EVENT_FIELDS = new Set(['eventId', 'sessionId', 'sequence', 'eventType', 'actorType', 'timestamp', 'status', 'toolName', 'durationMs', 'redactedSummary']);
const SESSION_IDENTITY_FIELDS = ['sessionId', 'agentId', 'agentAliasId', 'tenantId', 'projectId'];
const COUNTER_FIELDS = ['inputTokenCount', 'outputTokenCount', 'toolCallCount', 'durationMs'];
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function isNonEmptyString(value, max = 200) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function hasOnlyFields(value, fields, label) {
  return Object.keys(value).every((field) => fields.has(field)) ? null : `${label} contains an unknown field`;
}

function isValidTimestamp(value) {
  return typeof value === 'string' && ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

function validateTelemetrySession(session) {
  if (!session || typeof session !== 'object' || Array.isArray(session) || !isNonEmptyString(session.sessionId)) {
    return 'session.sessionId is required';
  }
  const unknown = hasOnlyFields(session, SESSION_FIELDS, 'session');
  if (unknown) return unknown;
  for (const field of SESSION_IDENTITY_FIELDS.slice(1)) {
    if (!isNonEmptyString(session[field])) return `session.${field} is required`;
  }
  if (!SESSION_STATUSES.has(session.status)) return 'session.status must be running, succeeded, or failed';
  if (!isValidTimestamp(session.startedAt)) return 'session.startedAt must be an ISO-8601 UTC timestamp';
  if (session.status !== 'running' && !isValidTimestamp(session.completedAt)) {
    return 'terminal sessions require session.completedAt as an ISO-8601 UTC timestamp';
  }
  for (const field of COUNTER_FIELDS) {
    if (session[field] != null && (!Number.isSafeInteger(session[field]) || session[field] < 0 || session[field] > 1_000_000_000)) {
      return `session.${field} must be a non-negative integer`;
    }
  }
  if (session.guardrailHit != null && typeof session.guardrailHit !== 'boolean') return 'session.guardrailHit must be boolean';
  if (session.errorClass != null && !isNonEmptyString(session.errorClass)) return 'session.errorClass must be a string';
  return null;
}

function validateTelemetryEvents(events) {
  if (events == null) return null;
  if (!Array.isArray(events) || events.length > 100 || events.some((event) => !event || typeof event !== 'object' || Array.isArray(event))) {
    return 'events must be an array of at most 100 objects';
  }
  for (const event of events) {
    const unknown = hasOnlyFields(event, EVENT_FIELDS, 'event');
    if (unknown) return unknown;
    if (!isNonEmptyString(event.eventId) || !isNonEmptyString(event.sessionId)) return 'each event requires eventId and sessionId';
    if (event.sequence != null && (!Number.isSafeInteger(event.sequence) || event.sequence < 0)) return 'event.sequence must be a non-negative integer';
    if (event.timestamp != null && !isValidTimestamp(event.timestamp)) return 'event.timestamp must be an ISO-8601 UTC timestamp';
    if (event.eventType != null && !isNonEmptyString(event.eventType, 100)) return 'event.eventType is invalid';
    if (event.actorType != null && !isNonEmptyString(event.actorType, 50)) return 'event.actorType is invalid';
    if (event.status != null && !isNonEmptyString(event.status, 50)) return 'event.status is invalid';
    if (event.toolName != null && !isNonEmptyString(event.toolName)) return 'event.toolName is invalid';
    if (event.durationMs != null && (!Number.isSafeInteger(event.durationMs) || event.durationMs < 0 || event.durationMs > 1_000_000_000)) return 'event.durationMs is invalid';
    if (event.redactedSummary != null && !isNonEmptyString(event.redactedSummary, 2000)) return 'event.redactedSummary is invalid';
  }
  return null;
}

export function createControlTowerServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    try {
      if (await sendStatic(res, path)) return;

      if (path === '/health') {
        return send(res, 200, { status: 'ok' });
      }

      // --- Internal telemetry ingestion (agent execution layer)
      if (path === '/internal/v1/telemetry' && req.method === 'POST') {
        const token = req.headers['x-control-tower-token'];
        if (!internalToken() || !safeEqual(token ?? '', internalToken())) {
          return send(res, 401, { error: 'invalid internal token' });
        }
        const body = await readBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body) || body.session == null || (body.events != null && !Array.isArray(body.events)) || Object.keys(body).some((key) => !['session', 'events'].includes(key))) {
          return send(res, 400, { error: 'telemetry requires a session and optional events array' });
        }
        const sessionError = validateTelemetrySession(body.session);
        if (sessionError) return send(res, 400, { error: sessionError });
        const eventError = validateTelemetryEvents(body.events);
        if (eventError) return send(res, 400, { error: eventError });
        const session = body.session ? redact(body.session, 0, TELEMETRY_IDENTITY_FIELDS) : null;
        for (const event of body.events ?? []) {
          if (session?.sessionId && event.sessionId !== session.sessionId) return send(res, 400, { error: 'event sessionId does not match session' });
        }
        let stored = 0;
        try {
          const result = store.ingestTelemetry({ ...session, redactionStatus: redactionStatus() }, (body.events ?? []).map((event) => redact(event, 0, TELEMETRY_IDENTITY_FIELDS)));
          stored = result.newEvents;
        } catch (error) {
          return send(res, error.message.includes('conflict') ? 409 : 400, { error: error.message });
        }
        return send(res, 202, { accepted: true, sessions: 1, newEvents: stored });
      }

      if (path === '/internal/v1/demo/seed' && req.method === 'POST') {
        const token = req.headers['x-control-tower-token'];
        if (!mockMode() || !internalToken() || !safeEqual(token ?? '', internalToken())) return send(res, 401, { error: 'demo seed unavailable' });
        return send(res, 201, { ...store.seedDemoData(), source: 'mock-projection' });
      }

      // --- Internal ACT synchronization (pull-only)
      if (path === '/internal/v1/sync/act' && req.method === 'POST') {
        const token = req.headers['x-control-tower-token'];
        if (!internalToken() || !safeEqual(token ?? '', internalToken())) return send(res, 401, { error: 'invalid internal token' });
        if (process.env.CONTROL_TOWER_ACT_SYNC !== 'true') return send(res, 403, { error: 'sync disabled' });
        if (!process.env.BOOMI_ACCOUNT_ID || !process.env.BOOMI_USERNAME || !process.env.BOOMI_API_TOKEN) return send(res, 500, { error: 'sync not configured' });
        const body = await readBody(req);
        const lookbackDays = body.lookbackDays == null ? 7 : Number(body.lookbackDays);
        const fullLookback = body.fullLookback ?? false;
        if (!Number.isFinite(lookbackDays) || lookbackDays < 1 || lookbackDays > 30) return send(res, 400, { error: 'lookbackDays must be between 1 and 30' });
        if (typeof fullLookback !== 'boolean') return send(res, 400, { error: 'fullLookback must be boolean' });
        try {
          const result = await syncAct({ client: new ActClient(), store, lookbackDays, fullLookback });
          store.addAuditEvent({ actor: 'internal', role: 'operator', action: 'act.sync', resource: 'act', result: 'ok' });
          return send(res, 202, { accepted: true, syncedAt: result.syncedAt, snapshotId: result.snapshotId, reconciliation: result.reconciliation });
        } catch (error) {
          store.recordActSyncError(error instanceof ActError ? `ACT request failed (${error.status})` : 'ACT sync failed');
          store.addAuditEvent({ actor: 'internal', role: 'operator', action: 'act.sync', resource: 'act', result: 'error' });
          return send(res, 502, { error: 'act sync failed', ...(error instanceof ActError ? { status: error.status } : {}) });
        }
      }

      if (path === '/api/v1/act/status' && req.method === 'GET') {
        const currentActor = authorize(req, 'dashboard.view', 'act/status');
        const snapshot = store.latestActSnapshot();
        audit(req, 'act.status.view', 'act/status', 'ok', currentActor);
        return send(res, 200, {
          enabled: process.env.CONTROL_TOWER_ACT_SYNC === 'true',
          lastSyncAt: store.getCheckpoint('act:lastSyncAt'),
          lastSuccessAt: store.getCheckpoint('act:lastSuccessAt'),
          lastError: store.getCheckpoint('act:lastError'),
          reconciliation: snapshot?.reconciliation ?? null,
        });
      }

      // --- Read-only facade API ---
      if (path === '/api/v1/dashboards/default/summary' && req.method === 'GET') {
        const currentActor = authorize(req, 'dashboard.view', 'dashboards/default');
        const filter = requestedFilter(url);
        const scopedFilter = filterForActor(currentActor, filter);
        audit(req, 'dashboard.view', 'dashboards/default', 'ok', currentActor);
        const summary = store.dashboardSummary({ inScope: scoped(currentActor), ...scopedFilter });
        const act = store.latestActSnapshot();
        return send(res, 200, { dashboardId: 'default', source: act ? 'act+local-projection' : (mockMode() ? 'mock-projection' : 'local-projection'), ...summary, ...(act ? { act: { aggregate: act.aggregate, inventory: actInventory(act), reconciliation: act.reconciliation } } : {}) });
      }

      if (path === '/api/v1/dashboards/default/timeseries' && req.method === 'GET') {
        const currentActor = authorize(req, 'dashboard.timeseries.view', 'dashboards/default');
        const filter = requestedFilter(url);
        const scopedFilter = filterForActor(currentActor, filter);
        audit(req, 'dashboard.timeseries.view', 'dashboards/default', 'ok', currentActor);
        return send(res, 200, { source: mockMode() ? 'mock-projection' : 'local-projection', items: store.dashboardTimeseries({ inScope: scoped(currentActor), ...scopedFilter }) });
      }

      if (path === '/api/v1/sessions' && req.method === 'GET') {
        const currentActor = authorize(req, 'session.list', 'sessions');
        const filter = requestedFilter(url);
        const scopedFilter = filterForActor(currentActor, filter);
        const requestedLimit = Number(url.searchParams.get('limit') ?? 50);
        if (!Number.isInteger(requestedLimit) || requestedLimit < 1) throw new AuthError(400, 'invalid limit');
        const result = store.listSessions({
          limit: Math.min(requestedLimit, 200),
          cursor: url.searchParams.get('cursor'),
          status: url.searchParams.get('status'),
          agentId: filter.agentId,
          tenantId: filter.tenantId,
          projectId: filter.projectId,
          aliasId: filter.aliasId,
          from: filter.from,
          to: filter.to,
          inScope: scoped(currentActor),
        });
        audit(req, 'session.list', 'sessions', 'ok', currentActor);
        return send(res, 200, result);
      }

      const sessionMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)$/);
      if (sessionMatch && req.method === 'GET') {
        const currentActor = authorize(req, 'session.view', `sessions/${sessionMatch[1]}`);
        let sessionId;
        try { sessionId = decodeURIComponent(sessionMatch[1]); } catch { throw new AuthError(400, 'invalid session id'); }
        const session = store.getSession(sessionId, scoped(currentActor));
        if (!session) return send(res, 404, { error: 'session not found' });
        audit(req, 'session.view', `sessions/${session.sessionId}`, 'ok', currentActor);
        return send(res, 200, session);
      }

      const eventsMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/events$/);
      if (eventsMatch && req.method === 'GET') {
        const currentActor = authorize(req, 'session.events.view', `sessions/${eventsMatch[1]}/events`);
        let sessionId;
        try { sessionId = decodeURIComponent(eventsMatch[1]); } catch { throw new AuthError(400, 'invalid session id'); }
        if (!store.getSession(sessionId, scoped(currentActor))) return send(res, 404, { error: 'session not found' });
        audit(req, 'session.events.view', `sessions/${sessionId}/events`, 'ok', currentActor);
        return send(res, 200, { sessionId, items: store.listEvents(sessionId, scoped(currentActor)) });
      }

      if (path === '/api/v1/audit-events' && req.method === 'GET') {
        const currentActor = authorize(req, 'audit.list', 'audit-events');
        const requestedLimit = Number(url.searchParams.get('limit') ?? 100);
        if (!Number.isInteger(requestedLimit) || requestedLimit < 1) throw new AuthError(400, 'invalid limit');
        const result = store.listAuditEvents({
          limit: Math.min(requestedLimit, 500),
          cursor: url.searchParams.get('cursor'),
          inScope: (entry) => currentActor.scopes.wildcard ? true : Boolean(entry.tenantId && isInScope(currentActor, entry)),
        });
        audit(req, 'audit.list', 'audit-events', 'ok', currentActor);
        return send(res, 200, result);
      }

      if (path === '/api/v1/exports' && req.method === 'POST') {
        const currentActor = authorize(req, 'export.create', 'exports');
        const body = await readBody(req);
        const requestedScope = body.scope && typeof body.scope === 'object' ? body.scope : {};
        const scope = filterForActor(currentActor, redact(requestedScope));
        const job = store.createExport({
          exportId: randomUUID(),
          requestedBy: currentActor.user,
          status: 'queued',
          scope,
          createdAt: new Date().toISOString(),
        });
        audit(req, 'export.create', `exports/${job.exportId}`, 'ok', currentActor);
        return send(res, 202, job);
      }

      const exportMatch = path.match(/^\/api\/v1\/exports\/([^/]+)$/);
      if (exportMatch && req.method === 'GET') {
        const currentActor = authorize(req, 'export.view', `exports/${exportMatch[1]}`);
        let exportId;
        try { exportId = decodeURIComponent(exportMatch[1]); } catch { throw new AuthError(400, 'invalid export id'); }
        const job = store.getExport(exportId);
        if (!job || (job.requestedBy !== currentActor.user && currentActor.role !== 'operator')) return send(res, 404, { error: 'export not found' });
        audit(req, 'export.view', `exports/${job.exportId}`, 'ok', currentActor);
        return send(res, 200, job);
      }

      return send(res, 404, { error: 'not found' });
    } catch (err) {
      if (err instanceof AuthError || err instanceof ScopeError) return send(res, err.status, { error: err.message });
      if (err.message === 'body too large') return send(res, 413, { error: 'body too large' });
      if (err.message === 'invalid json') return send(res, 400, { error: 'invalid JSON body' });
      if (err.message === 'invalid cursor') return send(res, 400, { error: 'invalid cursor' });
      return send(res, 500, { error: 'internal error' });
    }
  });
}

if (process.env.NODE_ENV !== 'test' && import.meta.url === `file://${process.argv[1]}`) {
  createControlTowerServer().listen(PORT, () => {
    console.log(`control tower facade listening on http://localhost:${PORT}`);
  });
}
