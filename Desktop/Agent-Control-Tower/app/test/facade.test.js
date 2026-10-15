import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createControlTowerServer } from '../src/server.js';
import * as store from '../src/lib/store.js';
import { signHs256Token } from '../src/lib/auth.js';

const INTERNAL_TOKEN = 'test-internal-token';
const DEMO_TOKEN = 'test-demo-token';
process.env.CONTROL_TOWER_INTERNAL_TOKEN = INTERNAL_TOKEN;
process.env.CONTROL_TOWER_AUTH_MODE = 'demo';
process.env.CONTROL_TOWER_ALLOW_DEMO_AUTH = 'true';
process.env.CONTROL_TOWER_DEMO_TOKEN = DEMO_TOKEN;
process.env.CONTROL_TOWER_DEMO_USER = 'viewer@example.com';
process.env.CONTROL_TOWER_DEMO_ROLE = 'viewer';
process.env.CONTROL_TOWER_DEMO_SCOPES = '*';

let server;
let base;

function listen() {
  return new Promise((resolve) => {
    server = createControlTowerServer().listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}

beforeEach(async () => {
  store.resetStore();
  await listen();
});

afterEach(() => new Promise((resolve) => server.close(resolve)));

const authHeaders = () => ({ Authorization: `Bearer ${DEMO_TOKEN}` });

function restoreEnv(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

function telemetrySession(overrides = {}) {
  return {
    sessionId: 's1',
    agentId: 'agent-a',
    agentAliasId: 'alias-a',
    tenantId: 'tenant-a',
    projectId: 'project-a',
    status: 'running',
    startedAt: '2026-10-08T00:00:00.000Z',
    ...overrides,
  };
}

async function post(path, body, headers = {}) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(path.startsWith('/api/') ? authHeaders() : {}), ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('health endpoint responds', async () => {
  const res = await fetch(base + '/health');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'ok');
});

test('browser shell and static assets are served without secrets', async () => {
  for (const [path, type] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/styles.css', 'text/css']]) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), new RegExp(type));
    const text = await res.text();
    assert.ok(!text.includes('BOOMI_API_TOKEN'));
    assert.ok(!text.includes('/graphql'));
    if (path === '/') {
      assert.match(text, /id="connect-button"/);
      assert.match(text, /id="auth-form"/);
      assert.match(text, /id="session-token"/);
    }
    if (path === '/app.js') {
      assert.match(text, /sessionStorage\.setItem\('controlTowerToken'/);
      assert.ok(!text.includes('CONTROL_TOWER_INTERNAL_TOKEN'));
      assert.ok(!text.includes('x-control-tower-token'));
    }
  }
});

test('mock seed is opt-in and deterministic', async () => {
  process.env.CONTROL_TOWER_MOCK_DATA = 'true';
  const first = await post('/internal/v1/demo/seed', {}, { 'x-control-tower-token': INTERNAL_TOKEN });
  assert.equal(first.status, 201);
  assert.deepEqual(first.body, { sessions: 3, events: 7, source: 'mock-projection' });
  const summary = await (await fetch(base + '/api/v1/dashboards/default/summary', { headers: authHeaders() })).json();
  assert.equal(summary.source, 'mock-projection');
  assert.equal(summary.totalSessions, 3);
  const second = await post('/internal/v1/demo/seed', {}, { 'x-control-tower-token': INTERNAL_TOKEN });
  assert.equal(second.status, 201);
  assert.equal((await (await fetch(base + '/api/v1/sessions', { headers: authHeaders() })).json()).items.length, 3);
  delete process.env.CONTROL_TOWER_MOCK_DATA;
});

test('telemetry ingestion rejects missing internal token', async () => {
  const { status } = await post('/internal/v1/telemetry', { session: { sessionId: 's1' } });
  assert.equal(status, 401);
});

test('telemetry ingestion rejects wrong internal token', async () => {
  const { status } = await post(
    '/internal/v1/telemetry',
    { session: { sessionId: 's1' } },
    { 'x-control-tower-token': 'wrong' },
  );
  assert.equal(status, 401);
});

test('malformed telemetry returns 400 without persistence', async () => {
  const malformed = await post('/internal/v1/telemetry', { session: { sessionId: 's1' }, events: [{ eventId: 'e1', sessionId: 'other' }] }, { 'x-control-tower-token': INTERNAL_TOKEN });
  assert.equal(malformed.status, 400);
  assert.equal(store.getSession('s1'), null);
  const invalidJson = await fetch(base + '/internal/v1/telemetry', { method: 'POST', headers: { 'x-control-tower-token': INTERNAL_TOKEN, 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(invalidJson.status, 400);
});

test('telemetry ingestion enforces the allowlist and redacts approved summaries', async () => {
  const rejected = await post(
    '/internal/v1/telemetry',
    { session: telemetrySession({ prompt: 'customer@example.com', apiToken: 'super-secret-token' }) },
    { 'x-control-tower-token': INTERNAL_TOKEN },
  );
  assert.equal(rejected.status, 400);
  assert.equal(store.getSession('s1'), null);

  const { status, body } = await post(
    '/internal/v1/telemetry',
    {
      session: telemetrySession({ status: 'succeeded', completedAt: '2026-10-08T00:00:02.000Z', inputTokenCount: 10 }),
      events: [{ eventId: 'e1', sessionId: 's1', sequence: 1, eventType: 'tool_call', redactedSummary: 'called with Bearer abc123.def456' }],
    },
    { 'x-control-tower-token': INTERNAL_TOKEN },
  );
  assert.equal(status, 202);
  assert.equal(body.newEvents, 1);

  const session = await (await fetch(base + '/api/v1/sessions/s1', { headers: authHeaders() })).json();
  assert.equal(session.redactionStatus, 'redacted-v2');
  assert.equal(session.prompt, undefined);

  const events = await (await fetch(base + '/api/v1/sessions/s1/events', { headers: authHeaders() })).json();
  assert.equal(events.items[0].redactedSummary, 'called with [REDACTED]');
});

test('date-stamped identifiers survive redaction and match events', async () => {
  const stamped = telemetrySession({ sessionId: 'dashboard-test-20261012-01', status: 'succeeded', completedAt: '2026-10-12T12:25:04Z' });
  const { status, body } = await post(
    '/internal/v1/telemetry',
    { session: stamped, events: [{ eventId: 'dashboard-test-event-20261012-01', sessionId: 'dashboard-test-20261012-01', sequence: 1, eventType: 'dashboard_test', timestamp: '2026-10-12T12:25:02Z', redactedSummary: 'dashboard telemetry smoke test' }] },
    { 'x-control-tower-token': INTERNAL_TOKEN },
  );
  assert.equal(status, 202);
  assert.equal(body.newEvents, 1);
  const stored = store.getSession('dashboard-test-20261012-01');
  assert.equal(stored.sessionId, 'dashboard-test-20261012-01');
  assert.equal(store.listEvents('dashboard-test-20261012-01')[0].eventId, 'dashboard-test-event-20261012-01');
});

test('events-only telemetry and unknown fields are rejected without persistence', async () => {
  const eventsOnly = await post('/internal/v1/telemetry', { events: [{ eventId: 'orphan', sessionId: 'missing' }] }, { 'x-control-tower-token': INTERNAL_TOKEN });
  assert.equal(eventsOnly.status, 400);
  const unknown = await post('/internal/v1/telemetry', { session: telemetrySession(), extra: true }, { 'x-control-tower-token': INTERNAL_TOKEN });
  assert.equal(unknown.status, 400);
  assert.equal(store.getSession('s1'), null);
});

test('telemetry lifecycle updates one scoped session and deduplicates retries', async () => {
  const start = { session: telemetrySession(), events: [{ eventId: 's1-start', sessionId: 's1', sequence: 1, eventType: 'session_started', timestamp: '2026-10-08T00:00:00.000Z' }] };
  const complete = { session: telemetrySession({ status: 'succeeded', completedAt: '2026-10-08T00:00:02.000Z', durationMs: 2000, inputTokenCount: 8, outputTokenCount: 5, toolCallCount: 1 }), events: [{ eventId: 's1-complete', sessionId: 's1', sequence: 2, eventType: 'session_completed', timestamp: '2026-10-08T00:00:02.000Z' }] };
  const headers = { 'x-control-tower-token': INTERNAL_TOKEN };
  const first = await post('/internal/v1/telemetry', start, headers);
  const second = await post('/internal/v1/telemetry', complete, headers);
  const retry = await post('/internal/v1/telemetry', complete, headers);
  assert.equal(first.status, 202);
  assert.equal(second.body.newEvents, 1);
  assert.equal(retry.body.newEvents, 0);
  assert.equal(store.getSession('s1').status, 'succeeded');
  assert.equal(store.listEvents('s1').length, 2);
});

test('telemetry rejects invalid lifecycle metadata without persistence', async () => {
  for (const session of [
    telemetrySession({ startedAt: 'not-a-date' }),
    telemetrySession({ status: 'paused' }),
    telemetrySession({ status: 'failed' }),
    telemetrySession({ tenantId: '' }),
  ]) {
    const response = await post('/internal/v1/telemetry', { session }, { 'x-control-tower-token': INTERNAL_TOKEN });
    assert.equal(response.status, 400);
  }
  assert.equal(store.getSession('s1'), null);
});

test('event ingestion is idempotent by eventId', async () => {
  const event = { eventId: 'e1', sessionId: 's1', sequence: 1, eventType: 'start' };
  const payload = { session: telemetrySession(), events: [event] };
  const headers = { 'x-control-tower-token': INTERNAL_TOKEN };
  await post('/internal/v1/telemetry', payload, headers);
  const second = await post('/internal/v1/telemetry', payload, headers);
  assert.equal(second.body.newEvents, 0);
  assert.equal(store.listEvents('s1').length, 1);
});

test('unknown session detail returns 404', async () => {
  const res = await fetch(base + '/api/v1/sessions/nope', { headers: authHeaders() });
  assert.equal(res.status, 404);
});

test('scoped readers see only matching telemetry identity', async () => {
  const headers = { 'x-control-tower-token': INTERNAL_TOKEN };
  await post('/internal/v1/telemetry', { session: telemetrySession({ sessionId: 'tenant-a-run' }) }, headers);
  await post('/internal/v1/telemetry', { session: telemetrySession({ sessionId: 'tenant-b-run', tenantId: 'tenant-b' }) }, headers);
  const previousMode = process.env.CONTROL_TOWER_AUTH_MODE;
  process.env.CONTROL_TOWER_AUTH_MODE = 'jwt';
  process.env.CONTROL_TOWER_JWT_SECRET = 'test-jwt-secret';
  process.env.CONTROL_TOWER_JWT_ISSUER = 'https://issuer.test';
  process.env.CONTROL_TOWER_JWT_AUDIENCE = 'control-tower';
  const token = signHs256Token({
    sub: 'tenant-a-viewer', role: 'viewer',
    scopes: { tenantIds: ['tenant-a'] },
    iss: 'https://issuer.test', aud: 'control-tower',
    exp: Math.floor(Date.now() / 1000) + 300,
  }, process.env.CONTROL_TOWER_JWT_SECRET);
  const response = await fetch(base + '/api/v1/sessions', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).items.map((session) => session.sessionId), ['tenant-a-run']);
  process.env.CONTROL_TOWER_AUTH_MODE = previousMode;
});

test('dashboard summary applies requested scope filters', async () => {
  const headers = { 'x-control-tower-token': INTERNAL_TOKEN };
  await post('/internal/v1/telemetry', { session: telemetrySession({ status: 'succeeded', completedAt: '2026-10-08T00:00:02.000Z', inputTokenCount: 10 }) }, headers);
  await post('/internal/v1/telemetry', { session: telemetrySession({ sessionId: 'other', tenantId: 'tenant-b', status: 'failed', completedAt: '2026-10-08T00:00:03.000Z', inputTokenCount: 4 }) }, headers);
  const summary = await (await fetch(base + '/api/v1/dashboards/default/summary?tenantId=tenant-a', { headers: authHeaders() })).json();
  assert.equal(summary.totalSessions, 1);
  assert.equal(summary.failedSessions, 0);
});

test('dashboard summary aggregates local projection', async () => {
  const headers = { 'x-control-tower-token': INTERNAL_TOKEN };
  await post('/internal/v1/telemetry', {
    session: telemetrySession({ status: 'succeeded', completedAt: '2026-10-08T00:00:02.000Z', inputTokenCount: 10, outputTokenCount: 5, toolCallCount: 2 }),
  }, headers);
  await post('/internal/v1/telemetry', {
    session: telemetrySession({ sessionId: 's2', status: 'failed', completedAt: '2026-10-08T00:00:03.000Z', inputTokenCount: 4, guardrailHit: true }),
  }, headers);

  const summary = await (await fetch(base + '/api/v1/dashboards/default/summary', { headers: authHeaders() })).json();
  assert.equal(summary.totalSessions, 2);
  assert.equal(summary.failedSessions, 1);
  assert.equal(summary.successRate, 50);
  assert.equal(summary.totalInputTokens, 14);
  assert.equal(summary.totalToolCalls, 2);
  assert.equal(summary.guardrailHits, 1);
});

test('scoped actors cannot see global ACT snapshot data', async () => {
  const previous = Object.fromEntries([
    'CONTROL_TOWER_AUTH_MODE', 'CONTROL_TOWER_JWT_SECRET', 'CONTROL_TOWER_JWT_ISSUER',
    'CONTROL_TOWER_JWT_AUDIENCE', 'CONTROL_TOWER_MOCK_DATA',
  ].map((key) => [key, process.env[key]]));
  try {
    process.env.CONTROL_TOWER_MOCK_DATA = 'false';
    await post('/internal/v1/telemetry', { session: telemetrySession() }, { 'x-control-tower-token': INTERNAL_TOKEN });
    await post('/internal/v1/telemetry', { session: telemetrySession({ sessionId: 'tenant-b-run', tenantId: 'tenant-b', projectId: 'project-b' }) }, { 'x-control-tower-token': INTERNAL_TOKEN });
    store.addActSnapshot({
      aggregate: { totalSessions: 901, totalInvocations: 902 },
      providerAccounts: { aiAgentProviderAccounts: [{ id: 'target-id', externalProviderAccountId: 'solutionsteam-70I6P5', providerAccountName: 'Secret Provider', providerType: 'BOOMI', numberOfAgents: 7 }] },
      invocations: [{ totalInvocations: 2, totalSessions: 1, aiAgentListing: { agentId: 'secret-agent', providerAccountGuId: 'target-id', versionName: 'Secret Agent' } }],
      reconciliation: { actSessions: 901, localSessions: 902, status: 'drift' },
    });
    process.env.CONTROL_TOWER_AUTH_MODE = 'jwt';
    process.env.CONTROL_TOWER_JWT_SECRET = 'test-jwt-secret';
    process.env.CONTROL_TOWER_JWT_ISSUER = 'https://issuer.test';
    process.env.CONTROL_TOWER_JWT_AUDIENCE = 'control-tower';
    const token = signHs256Token({
      sub: 'tenant-a-viewer', role: 'viewer', scopes: { tenantIds: ['tenant-a'] },
      iss: 'https://issuer.test', aud: 'control-tower', exp: Math.floor(Date.now() / 1000) + 300,
    }, process.env.CONTROL_TOWER_JWT_SECRET);
    const headers = { Authorization: `Bearer ${token}` };
    const summaryResponse = await fetch(base + '/api/v1/dashboards/default/summary', { headers });
    assert.equal(summaryResponse.status, 200);
    const summaryText = await summaryResponse.text();
    const summary = JSON.parse(summaryText);
    assert.equal(summary.source, 'local-projection');
    assert.equal(summary.totalSessions, 1);
    assert.equal(summary.act, undefined);
    assert.equal(summaryText.includes('901'), false);
    assert.equal(summaryText.includes('secret-agent'), false);
    assert.equal(summaryText.includes('Secret Provider'), false);

    const statusResponse = await fetch(base + '/api/v1/act/status', { headers });
    assert.equal(statusResponse.status, 200);
    const statusText = await statusResponse.text();
    assert.equal(JSON.parse(statusText).reconciliation, null);
    assert.equal(statusText.includes('901'), false);
    assert.equal(statusText.includes('902'), false);

    process.env.CONTROL_TOWER_AUTH_MODE = 'demo';
    const wildcardSummary = await (await fetch(base + '/api/v1/dashboards/default/summary', { headers: authHeaders() })).json();
    assert.equal(wildcardSummary.source, 'act+local-projection');
    assert.equal(wildcardSummary.act.aggregate.totalSessions, 901);
    assert.equal(wildcardSummary.act.inventory.agents[0].name, 'Secret Agent');
    const wildcardStatus = await (await fetch(base + '/api/v1/act/status', { headers: authHeaders() })).json();
    assert.deepEqual(wildcardStatus.reconciliation, { actSessions: 901, localSessions: 902, status: 'drift' });
  } finally {
    restoreEnv(previous);
  }
});

test('scoped auditors see only scoped audit events', async () => {
  const previousMode = process.env.CONTROL_TOWER_AUTH_MODE;
  process.env.CONTROL_TOWER_AUTH_MODE = 'jwt';
  process.env.CONTROL_TOWER_JWT_SECRET = 'test-jwt-secret';
  process.env.CONTROL_TOWER_JWT_ISSUER = 'https://issuer.test';
  process.env.CONTROL_TOWER_JWT_AUDIENCE = 'control-tower';
  const token = signHs256Token({ sub: 'tenant-a-auditor', role: 'auditor', scopes: { tenantIds: ['tenant-a'] }, iss: 'https://issuer.test', aud: 'control-tower', exp: Math.floor(Date.now() / 1000) + 300 }, process.env.CONTROL_TOWER_JWT_SECRET);
  const response = await fetch(base + '/api/v1/audit-events', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.ok((await response.json()).items.every((entry) => entry.tenantId === 'tenant-a'));
  process.env.CONTROL_TOWER_AUTH_MODE = previousMode;
});

test('viewers cannot create exports and the denial is audited', async () => {
  const { status } = await post('/api/v1/exports', { scope: {} });
  assert.equal(status, 403);
  const audits = store.listAuditEvents().items;
  assert.ok(audits.some((a) => a.action === 'export.create' && a.result === 'denied'));
});

test('facade requires explicit authentication', async () => {
  const res = await fetch(base + '/api/v1/sessions');
  assert.equal(res.status, 401);
});

test('jwt mode validates signed scoped actors', async () => {
  const previous = process.env.CONTROL_TOWER_AUTH_MODE;
  process.env.CONTROL_TOWER_AUTH_MODE = 'jwt';
  process.env.CONTROL_TOWER_JWT_SECRET = 'test-jwt-secret';
  process.env.CONTROL_TOWER_JWT_ISSUER = 'https://issuer.test';
  process.env.CONTROL_TOWER_JWT_AUDIENCE = 'control-tower';
  const token = signHs256Token({
    sub: 'auditor@example.com', role: 'auditor',
    scopes: { tenantIds: ['tenant-a'] },
    iss: 'https://issuer.test', aud: 'control-tower',
    exp: Math.floor(Date.now() / 1000) + 300,
  }, process.env.CONTROL_TOWER_JWT_SECRET);
  const res = await fetch(base + '/api/v1/sessions', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  process.env.CONTROL_TOWER_AUTH_MODE = previous;
});

test('sensitive responses never contain the internal token', async () => {
  const headers = { 'x-control-tower-token': INTERNAL_TOKEN };
  await post('/internal/v1/telemetry', { session: telemetrySession() }, headers);
  for (const path of ['/api/v1/sessions', '/api/v1/sessions/s1', '/api/v1/dashboards/default/summary', '/api/v1/audit-events']) {
    const text = await (await fetch(base + path, { headers: authHeaders() })).text();
    assert.ok(!text.includes(INTERNAL_TOKEN), `${path} leaked the internal token`);
  }
});
