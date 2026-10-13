import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncAct, windowFromCheckpoint } from '../src/lib/act-sync.js';
import * as store from '../src/lib/store.js';

function fakeClient({ totalSessions = 0, token = null, failAt = null } = {}) {
  const calls = [];
  const maybe = (name, value) => {
    calls.push(name);
    if (failAt === name) throw new Error('upstream failure');
    return value;
  };
  return {
    calls,
    providerAccounts: async () => maybe('providerAccounts', { aiAgentProviderAccounts: { providerAccounts: [{ providerAccountName: 'demo', apiToken: token }] } }),
    aggregateMetrics: async (input) => maybe('aggregateMetrics', { aiAgentRegistryAggregateMetrics: { totalSessions, totalInvocations: 4, input } }),
    invocationMetrics: async (input) => maybe('invocationMetrics', { aiAgentRegistryInvocationsMetrics: { totalSessions, totalInvocations: 4, input } }),
    auditLogs: async (input) => maybe('auditLogs', { aiAgentRegistryAuditLogs: { numberOfResults: 0, input } }),
  };
}

test('sync stores a redacted snapshot and reconciliation', async () => {
  store.resetStore();
  store.upsertSession({ sessionId: 'local-1', agentId: 'a', agentAliasId: 'al', tenantId: 't', projectId: 'p', status: 'running', startedAt: '2026-10-08T00:00:00.000Z' });
  const result = await syncAct({
    client: fakeClient({ totalSessions: 1, token: 'Bearer xyz' }),
    store,
    now: new Date('2026-10-09T00:00:00.000Z'),
  });
  assert.equal(result.reconciliation.status, 'match');
  assert.equal(result.reconciliation.actSessions, 1);
  assert.equal(store.latestActSnapshot().providerAccounts.providerAccounts[0].apiToken, '[REDACTED]');
  assert.equal(store.getCheckpoint('act:lastSuccessAt'), result.syncedAt);
  assert.deepEqual(result.window, { from: '2026-10-02T00:00:00.000Z', to: '2026-10-09T00:00:00.000Z' });
});

test('sync resumes from the persisted high-water mark', async () => {
  store.resetStore();
  store.setCheckpoint('act:lastSyncAt', '2026-10-08T00:00:00.000Z');
  const client = fakeClient();
  await syncAct({ client, store, now: new Date('2026-10-09T00:00:00.000Z') });
  const input = client.calls;
  assert.equal(input.length, 4);
  const window = windowFromCheckpoint('2026-10-08T00:00:00.000Z', new Date('2026-10-09T00:00:00.000Z'), 7);
  assert.equal(window.from, '2026-10-08T00:00:00.000Z');
});

test('full lookback ignores the persisted high-water mark', async () => {
  store.resetStore();
  store.setCheckpoint('act:lastSyncAt', '2026-10-08T00:00:00.000Z');
  const client = fakeClient();
  const result = await syncAct({
    client,
    store,
    now: new Date('2026-10-09T00:00:00.000Z'),
    lookbackDays: 7,
    fullLookback: true,
  });
  assert.equal(result.window.from, '2026-10-02T00:00:00.000Z');
  assert.equal(result.window.to, '2026-10-09T00:00:00.000Z');
});

test('sync fails closed before persisting a partial snapshot', async () => {
  store.resetStore();
  const client = fakeClient({ failAt: 'aggregateMetrics' });
  await assert.rejects(() => syncAct({ client, store, now: new Date('2026-10-09T00:00:00.000Z') }));
  assert.equal(store.latestActSnapshot(), null);
  assert.equal(client.calls.join(','), 'providerAccounts,aggregateMetrics');
});
