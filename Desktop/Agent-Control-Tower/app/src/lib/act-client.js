/**
 * Server-only Boomi Agent Control Tower adapter.
 *
 * Ported from boomi-act/scripts/act-registry.sh. Never import this from
 * browser code: it holds the API token and minted JWTs.
 *
 * Retry policy: only 429 and 5xx are retried, with bounded backoff.
 * 400/401/403 fail closed immediately.
 */

const RETRYABLE = (status) => status === 429 || status >= 500;

export class ActError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export class ActTimeoutError extends ActError {
  constructor(message = 'ACT request timed out') {
    super(message, 408);
    this.code = 'ACT_TIMEOUT';
  }
}

function abortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

export class ActClient {
  constructor({
    accountId = process.env.BOOMI_ACCOUNT_ID,
    username = process.env.BOOMI_USERNAME,
    apiToken = process.env.BOOMI_API_TOKEN,
    apiUrl = process.env.BOOMI_API_URL ?? 'https://api.boomi.com',
    graphqlUrl = process.env.ACT_GRAPHQL_URL ?? 'https://platform.boomi.com/graphql',
    fetchImpl = globalThis.fetch,
    maxRetries = 3,
    timeoutMs = Number(process.env.ACT_REQUEST_TIMEOUT_MS ?? 15_000),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}) {
    if (!accountId || !username || !apiToken) {
      throw new Error('ACT client requires BOOMI_ACCOUNT_ID, BOOMI_USERNAME and BOOMI_API_TOKEN');
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error('ACT client timeoutMs must be positive');
    this.accountId = accountId;
    this.basicAuth = `BOOMI_TOKEN.${username}:${apiToken}`;
    this.apiUrl = apiUrl;
    this.graphqlUrl = graphqlUrl;
    this.fetchImpl = fetchImpl;
    this.maxRetries = maxRetries;
    this.timeoutMs = timeoutMs;
    this.sleep = sleep;
    this.jwt = null;
    this.jwtExpiresAt = 0;
  }

  async request(url, options, signal) {
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(signal.reason);
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.fetchImpl(url, { ...options, signal: controller.signal });
    } catch (error) {
      if (timedOut) throw new ActTimeoutError();
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async mintJwt({ signal } = {}) {
    if (this.jwt && Date.now() < this.jwtExpiresAt) return this.jwt;
    let res;
    try {
      res = await this.request(
        `${this.apiUrl}/auth/jwt/generate/${this.accountId}`,
        {
          headers: {
            Authorization: `Basic ${Buffer.from(this.basicAuth).toString('base64')}`,
            Accept: '*/*',
          },
        },
        signal,
      );
    } catch (error) {
      if (error instanceof ActTimeoutError) throw error;
      if (abortError(error)) throw error;
      throw error;
    }
    const text = await res.text();
    if (!res.ok) throw new ActError(`JWT mint failed HTTP ${res.status}`, res.status, text);
    this.jwt = text.trim();
    this.jwtExpiresAt = Date.now() + 4 * 60 * 1000;
    return this.jwt;
  }

  async graphql(query, variables = {}, { signal } = {}) {
    let attempt = 0;
    for (;;) {
      const jwt = await this.mintJwt({ signal });
      let res;
      try {
        res = await this.request(this.graphqlUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query, variables }),
        }, signal);
      } catch (error) {
        if (error instanceof ActTimeoutError || abortError(error)) throw error;
        throw error;
      }
      if (RETRYABLE(res.status) && attempt < this.maxRetries) {
        attempt += 1;
        await this.sleep(250 * 2 ** attempt);
        continue;
      }
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { json = { raw: text }; }
      if (!res.ok) throw new ActError(`GraphQL HTTP ${res.status}`, res.status, json);
      if (json.errors?.length) throw new ActError(`GraphQL errors: ${json.errors[0].message}`, res.status, json.errors);
      return json.data;
    }
  }

  providerAccounts(options) {
    return this.graphql(
      `{ aiAgentProviderAccounts(input: { pageIndex: 0, pageSize: 100 }) {
        numberOfResults
        aiAgentProviderAccounts { id providerAccountName providerType providerSubType externalProviderAccountId numberOfAgents }
      } }`,
      {},
      options,
    );
  }

  aggregateMetrics(input, options) {
    return this.graphql(
      `query($input: AiAgentRegistryMetricsInput!) {
        aiAgentRegistryAggregateMetrics(input: $input) {
          activeAgents totalTokens avgResponseTime totalErrors totalInvocations
          totalModelInvocations avgModelLatency avgInvocationThrottles successRate
          totalToolCalls kbQueryCallCount glossaryCallCount totalSessions totalGuardrailHits
        }
      }`,
      { input },
      options,
    );
  }

  invocationMetrics(input, options) {
    return this.graphql(
      `query($input: AiAgentRegistryMetricsInput!) {
        aiAgentRegistryInvocationsMetrics(input: $input) {
          totalInputTokens totalOutputTokens totalInvocations totalSessions totalCost
          aiAgentListing {
            agentId providerType providerAccountGuId providerAccountName
            versionName aliasId aliasName agentStatus aliasStatus
          }
        }
      }`,
      { input },
      options,
    );
  }

  auditLogs(input, options) {
    return this.graphql(
      `query($input: AiAgentRegistryAuditListingInput) {
        aiAgentRegistryAuditLogs(input: $input) {
          numberOfResults pageIndex currentPageSize
          aiAgentAuditListings { timestamp entityType providerType providerSubType providerAccountName providerAccountId entityName entityVersion actionType eventTriggeredBy syncStatus syncTransactionId content }
        }
      }`,
      { input },
      options,
    );
  }
}
