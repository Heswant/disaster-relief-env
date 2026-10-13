import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActClient, ActTimeoutError } from '../src/lib/act-client.js';

function client(fetchImpl, options = {}) {
  return new ActClient({ accountId: 'account', username: 'user', apiToken: 'token', fetchImpl, timeoutMs: 50, sleep: async () => {}, ...options });
}

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, text: async () => body };
}

test('ACT request passes AbortSignal and times out', async () => {
  let receivedSignal;
  const act = client(async (_url, options) => {
    receivedSignal = options.signal;
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  }, { timeoutMs: 10 });
  await assert.rejects(() => act.mintJwt(), (error) => error instanceof ActTimeoutError);
  assert.equal(receivedSignal.aborted, true);
});

test('ACT retries retryable GraphQL responses but not client errors', async () => {
  let calls = 0;
  const act = client(async (url) => {
    calls += 1;
    if (url.includes('/auth/')) return response(200, 'jwt');
    return calls < 3 ? response(503, 'busy') : response(200, '{"data":{"ok":true}}');
  }, { maxRetries: 3 });
  assert.deepEqual(await act.graphql('{ ok }'), { ok: true });
  assert.equal(calls, 3);

  calls = 0;
  const failing = client(async (url) => {
    calls += 1;
    return url.includes('/auth/') ? response(200, 'jwt') : response(401, 'no');
  });
  await assert.rejects(() => failing.graphql('{ ok }'), /GraphQL HTTP 401/);
  assert.equal(calls, 2);
});
