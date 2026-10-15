# Agent Control Tower Facade

Server-side, read-only observability facade over Boomi Agent Control Tower (ACT).
It gives external stakeholders, contractors, and auditors dashboard and
session-log visibility **without Boomi platform logins**.

## Security boundary

- Boomi credentials (`BOOMI_API_TOKEN`, minted JWTs) live **server-side only**
  and are never sent to browsers or written to project files.
- The browser-facing API serves a redacted local projection — it does not
  proxy Boomi GraphQL.
- Raw prompts, credentials, tokens, full tool payloads, and PII are redacted
  at ingestion, before persistence (`src/lib/redaction.js`).
- ACT metric ingestion is non-idempotent: dedupe locally (stable `eventId` /
  `sessionId`) and use persisted high-water marks, never rolling windows.

## Layout

```text
src/server.js          HTTP server: facade API + internal telemetry ingestion
src/lib/act-client.js  Server-only ACT adapter (Basic -> JWT -> GraphQL, 429/5xx-only retries)
src/lib/redaction.js   Recursive redaction of secrets before persistence
src/lib/store.js       File-backed projection (sessions, events, audit, checkpoints, exports)
data/projection.json   Local durable state (git-ignored; do not commit)
test/facade.test.js    Ingestion, redaction, idempotency, authorization, leak tests
```

## Endpoints (first vertical slice)

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | none | liveness |
| `POST /internal/v1/telemetry` | `x-control-tower-token` | agent execution layer pushes redacted sessions/events (idempotent) |
| `GET /api/v1/dashboards/default/summary` | demo user | aggregate projection summary |
| `GET /api/v1/sessions` | demo user | cursor-paginated session list |
| `GET /api/v1/sessions/:id` | demo user | redacted session detail |
| `GET /api/v1/sessions/:id/events` | demo user | ordered redacted event timeline |
| `GET /api/v1/audit-events` | demo user | external access audit trail |
| `POST /api/v1/exports` | auditor/operator only | queue an async export |
| `GET /api/v1/exports/:id` | demo user | export job status |
| `POST /internal/v1/sync/act` | `x-control-tower-token` | pull-only ACT snapshot sync (disabled by default) |
| `GET /api/v1/act/status` | wildcard-scoped viewer | ACT sync health and reconciliation |

Every facade read/write records an external audit event. Viewers are denied
exports and the denial is audited.

ACT snapshots currently contain account-wide aggregate metrics and inventory,
not tenant/project/agent-scoped records. The facade therefore exposes ACT
aggregate, inventory, and reconciliation data only to actors with an explicit
wildcard scope. Scoped external viewers receive the filtered local redacted
projection and no global ACT block or reconciliation counts until the ACT
snapshot model carries enforceable identity dimensions.

## Run locally

```bash
cp .env.example .env   # fill in values; never commit .env
CONTROL_TOWER_MOCK_DATA=true npm run dev  # http://localhost:8787
npm test               # NODE_ENV=test node --test
npm run check          # syntax checks
```

With the server running, seed the deterministic synthetic projection:

```bash
curl -X POST http://localhost:8787/internal/v1/demo/seed \
  -H "x-control-tower-token: $CONTROL_TOWER_INTERNAL_TOKEN"
```

Then open `http://localhost:8787/`. The browser dashboard calls only the local
facade routes and displays a **MOCK DATA** badge; it never receives a Boomi
credential, JWT secret, internal ingestion token, or GraphQL URL. The mock projection contains three synthetic
sessions and seven redacted timeline events. It is intentionally not a
production data model.

Authentication is explicit. The dashboard's **Connect** button accepts a
viewer session token and keeps it only in browser `sessionStorage`; **Disconnect**
removes it. The viewer token is sent only as `Authorization: Bearer ...` to the
existing read APIs. Never paste `CONTROL_TOWER_INTERNAL_TOKEN` or the
`x-control-tower-token` value into the dashboard. Local tests may set
`CONTROL_TOWER_AUTH_MODE=demo` with `CONTROL_TOWER_DEMO_TOKEN`; the default
`jwt` mode requires a signed, short-lived bearer token and validates issuer,
audience, expiry, not-before, role, and data scopes. Production must connect
this seam to OIDC/JWKS-backed sessions with invitation expiry/revocation and
key rotation. Never use the demo mode outside local development.

## Known ACT constraints (verified live 2026-10-08)

- JWT minting requires `Accept: */*`; lifetime ~5 minutes.
- `aiAgentSessionsMetrics` requires explicit `sessionIds` — ACT cannot
  enumerate session timelines, so the local projection is the source for
  session detail.
- ACT metrics `200` means accepted, not correctly routed; reconcile counts.
- Metrics cannot be deleted or retracted — use a throwaway staging account
  for smoke tests.

## Connected Agent Studio telemetry (local development)

The telemetry-only integration guide is in `../AGENT_STUDIO_CONNECTED_TELEMETRY.md`.
The Agent Studio action contract is `docs/agent-studio-telemetry-openapi.yaml`.
Create a separate connected Agent Studio draft; leave the validated static
`Control Tower Demo Analyst` unchanged.

Each connected invocation must send stable `sessionId` and `eventId` values,
`tenantId`, `projectId`, `agentId`, and `agentAliasId`, plus valid UTC
timestamps. The lifecycle is `running`, optional redacted tool events, then
`succeeded` or `failed`. Retries reuse event IDs and are idempotent. The
`x-control-tower-token` value belongs only in secure Agent Studio/Boomi action
configuration, never in prompts, datasets, browser code, or committed files.

Because Agent Studio is cloud-hosted, it cannot call this Mac's `localhost`.
Use a temporary HTTPS tunnel to port 8787 for one controlled test only; close
it and rotate the local token afterward. Telemetry delivery is best-effort and
must not turn a successful agent invocation into a failure.

## Phase 2: live ACT sync

The optional `POST /internal/v1/sync/act` route pulls provider accounts, aggregate
metrics, invocation metrics, and the first page of ACT audit logs. It stores a
redacted snapshot locally and reconciles ACT `totalSessions` with locally
ingested sessions as `match`, `drift`, or `unknown`. Sync is disabled unless
`CONTROL_TOWER_ACT_SYNC=true`; it is operator-triggered and issues read-only
GraphQL queries only. Snapshots are capped at the newest 100. Set the flag back
to `false` to roll back; the last good snapshot remains available through the
status endpoint.

**Gate:** rotate `BOOMI_API_TOKEN` before enabling live sync. Never run a smoke
test against a production account if it would create permanent metrics.

## Before production

- Replace the shared internal header token with signed service identity, mTLS, or equivalent.
- Replace demo auth with real external identity (OIDC or equivalent).
- Move the projection to a relational database with migrations.
- Add rate limits, request timeouts, retention, and delivery monitoring.
- Add tenant/project/agent/alias/time-range scope enforcement at the production boundary, including identity-dimensioned ACT snapshots before re-enabling scoped ACT metrics.
- Secret scanning + client-bundle checks (no tokens in browser code).
