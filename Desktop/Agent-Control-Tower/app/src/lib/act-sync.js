import { redact, redactionStatus } from './redaction.js';

const MIN_LOOKBACK_DAYS = 1;
const MAX_LOOKBACK_DAYS = 30;
const DEFAULT_LOOKBACK_DAYS = 7;

function iso(value) {
  return new Date(value).toISOString();
}

function boundedLookback(value) {
  const number = Number(value ?? DEFAULT_LOOKBACK_DAYS);
  if (!Number.isFinite(number)) return DEFAULT_LOOKBACK_DAYS;
  return Math.min(MAX_LOOKBACK_DAYS, Math.max(MIN_LOOKBACK_DAYS, Math.floor(number)));
}

function windowFromCheckpoint(checkpoint, now, lookbackDays) {
  const to = iso(now);
  const from = checkpoint ? iso(checkpoint) : iso(new Date(now).getTime() - boundedLookback(lookbackDays) * 86400000);
  return { from, to };
}

function inputForWindow(window) {
  return { requestTsStart: window.from, requestTsEnd: window.to };
}

function unwrap(data, field) {
  return data?.[field] ?? data ?? null;
}

function totalSessions(aggregate, invocations) {
  return aggregate?.totalSessions ?? invocations?.totalSessions ?? null;
}

function reconciliation(act, local) {
  if (!Number.isSafeInteger(act)) return { actSessions: act, localSessions: local, status: 'unknown' };
  return { actSessions: act, localSessions: local, status: act === local ? 'match' : 'drift' };
}

export async function syncAct({ client, store, now = new Date(), lookbackDays = DEFAULT_LOOKBACK_DAYS, fullLookback = false } = {}) {
  if (!client || !store) throw new Error('syncAct requires client and store');
  const syncedAt = iso(now);
  const checkpoint = fullLookback ? null : store.getCheckpoint('act:lastSyncAt');
  const window = windowFromCheckpoint(checkpoint, now, lookbackDays);
  const input = inputForWindow(window);
  const providerAccounts = unwrap(await client.providerAccounts(), 'aiAgentProviderAccounts');
  const aggregate = unwrap(await client.aggregateMetrics(input), 'aiAgentRegistryAggregateMetrics');
  const invocations = unwrap(await client.invocationMetrics(input), 'aiAgentRegistryInvocationsMetrics');
  const actAudit = unwrap(await client.auditLogs(input), 'aiAgentRegistryAuditLogs');
  const snapshot = redact({
    snapshotId: `act-${Date.parse(syncedAt)}-${Math.random().toString(36).slice(2, 10)}`,
    syncedAt,
    window,
    redactionStatus: redactionStatus(),
    providerAccounts,
    aggregate,
    invocations,
    actAudit,
    reconciliation: reconciliation(totalSessions(aggregate, invocations), store.countSessions()),
  });
  const localSessions = store.countSessions();
  snapshot.reconciliation = reconciliation(totalSessions(aggregate, invocations), localSessions);
  store.addActSnapshot(snapshot);
  store.setCheckpoint('act:lastSyncAt', syncedAt);
  store.setCheckpoint('act:lastSuccessAt', syncedAt);
  store.setCheckpoint('act:lastError', null);
  return { ...snapshot, reconciliation: snapshot.reconciliation };
}

export { boundedLookback, windowFromCheckpoint };
