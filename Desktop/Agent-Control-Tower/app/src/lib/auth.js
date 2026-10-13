import { createHmac, timingSafeEqual } from 'node:crypto';

const ROLES = new Set(['viewer', 'auditor', 'operator']);
const SCOPE_FIELDS = ['tenantIds', 'projectIds', 'agentIds', 'aliasIds'];

export class AuthError extends Error {
  constructor(status, message = 'authentication required') {
    super(message);
    this.status = status;
  }
}

export class ScopeError extends Error {
  constructor(message = 'resource is outside the actor scope') {
    super(message);
    this.status = 403;
  }
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function decodeJson(value) {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new AuthError(401);
  }
}

function bearer(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !/^Bearer\s+\S+$/i.test(header)) throw new AuthError(401);
  return header.replace(/^Bearer\s+/i, '');
}

function safeTokenEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function normalizeList(value) {
  if (value === '*') return ['*'];
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' && item.length <= 200);
  return [];
}

function normalizeScopes(claims) {
  const input = claims.scopes ?? claims.scope ?? {};
  if (input === '*' || input === 'read:*') return { wildcard: true };
  if (typeof input === 'string') {
    const result = {};
    for (const item of input.split(/\s+/).filter(Boolean)) {
      const [field, value] = item.split(':', 2);
      const target = { tenant: 'tenantIds', project: 'projectIds', agent: 'agentIds', alias: 'aliasIds' }[field];
      if (target && value) (result[target] ??= []).push(value);
    }
    return result;
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const scopes = {};
  for (const field of SCOPE_FIELDS) {
    const values = normalizeList(input[field]);
    if (values.length) scopes[field] = values;
  }
  if (input.timeRange && typeof input.timeRange === 'object') {
    const { from, to } = input.timeRange;
    if (from || to) scopes.timeRange = { from, to };
  }
  return scopes;
}

const SCOPE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function validateActor(claims, { demo = false } = {}) {
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw new AuthError(401);
  const role = claims.role;
  if (!ROLES.has(role) || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 200) throw new AuthError(401);
  const scopes = normalizeScopes(claims);
  if (!demo && scopes.wildcard) throw new AuthError(401);
  if (!demo && SCOPE_FIELDS.every((field) => !scopes[field])) throw new AuthError(403, 'actor has no identity scope');
  const range = scopes.timeRange;
  if (range && (!range.from || !range.to || !SCOPE_TIMESTAMP.test(range.from) || !SCOPE_TIMESTAMP.test(range.to) || Number.isNaN(Date.parse(range.from)) || Number.isNaN(Date.parse(range.to)) || range.from > range.to)) {
    throw new AuthError(401, 'invalid actor time scope');
  }
  return { user: claims.sub, role, scopes, issuer: claims.iss ?? null };
}

function validateJwt(token) {
  const secret = process.env.CONTROL_TOWER_JWT_SECRET;
  const issuer = process.env.CONTROL_TOWER_JWT_ISSUER;
  const audience = process.env.CONTROL_TOWER_JWT_AUDIENCE;
  if (!secret || !issuer || !audience) throw new AuthError(503, 'authentication is not configured');
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError(401);
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJson(encodedHeader);
  if (header.alg !== 'HS256' || header.typ !== 'JWT') throw new AuthError(401);
  const expected = createHmac('sha256', secret).update(`${encodedHeader}.${encodedPayload}`).digest('base64url');
  if (!safeTokenEqual(expected, encodedSignature)) throw new AuthError(401);
  const claims = decodeJson(encodedPayload);
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== issuer || claims.aud !== audience || !Number.isFinite(claims.exp) || claims.exp <= now || (claims.nbf != null && (!Number.isFinite(claims.nbf) || claims.nbf > now))) {
    throw new AuthError(401);
  }
  return validateActor(claims);
}

export function authenticate(req) {
  const mode = process.env.CONTROL_TOWER_AUTH_MODE ?? 'jwt';
  const token = bearer(req);
  if (mode === 'demo') {
    const demoAllowed = process.env.NODE_ENV === 'test' || process.env.CONTROL_TOWER_ALLOW_DEMO_AUTH === 'true';
    if (!demoAllowed) throw new AuthError(503, 'demo authentication is disabled');
    const expected = process.env.CONTROL_TOWER_DEMO_TOKEN;
    if (!expected || !safeTokenEqual(token, expected)) throw new AuthError(401);
    return validateActor({
      sub: process.env.CONTROL_TOWER_DEMO_USER,
      role: process.env.CONTROL_TOWER_DEMO_ROLE,
      scopes: process.env.CONTROL_TOWER_DEMO_SCOPES ?? '*',
    }, { demo: true });
  }
  if (mode !== 'jwt') throw new AuthError(503, 'authentication is not configured');
  return validateJwt(token);
}

function valueFor(record, field) {
  if (field === 'aliasIds') return record.agentAliasId ?? record.aliasId;
  if (field === 'agentIds') return record.agentId;
  if (field === 'tenantIds') return record.tenantId;
  if (field === 'projectIds') return record.projectId;
  return null;
}

export function isInScope(actor, record) {
  if (actor.scopes.wildcard) return true;
  for (const field of SCOPE_FIELDS) {
    const allowed = actor.scopes[field];
    if (!allowed) continue;
    const value = valueFor(record, field);
    if (!value || (!allowed.includes('*') && !allowed.includes(value))) return false;
  }
  const { from, to } = actor.scopes.timeRange ?? {};
  const timestamp = record.startedAt ?? record.timestamp ?? record.createdAt;
  if ((from || to) && !timestamp) return false;
  if (from && timestamp < from) return false;
  if (to && timestamp > to) return false;
  return true;
}

export function actorCan(actor, action) {
  const permissions = {
    'dashboard.view': ['viewer', 'auditor', 'operator'],
    'dashboard.timeseries.view': ['viewer', 'auditor', 'operator'],
    'session.list': ['viewer', 'auditor', 'operator'],
    'session.view': ['viewer', 'auditor', 'operator'],
    'session.events.view': ['viewer', 'auditor', 'operator'],
    'audit.list': ['auditor', 'operator'],
    'export.create': ['auditor', 'operator'],
    'export.view': ['auditor', 'operator'],
  };
  return permissions[action]?.includes(actor.role) ?? false;
}

export function requestedFilter(url) {
  const filter = {};
  const fields = { tenantId: 'tenantIds', projectId: 'projectIds', agentId: 'agentIds', aliasId: 'aliasIds' };
  for (const parameter of Object.keys(fields)) {
    const value = url.searchParams.get(parameter);
    if (value) filter[parameter] = value;
  }
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (from && !Number.isNaN(Date.parse(from))) filter.from = new Date(from).toISOString();
  else if (from) throw new AuthError(400, 'invalid from timestamp');
  if (to && !Number.isNaN(Date.parse(to))) filter.to = new Date(to).toISOString();
  else if (to) throw new AuthError(400, 'invalid to timestamp');
  if (filter.from && filter.to && filter.from > filter.to) throw new AuthError(400, 'invalid time range');
  return filter;
}

function scopeAllows(actor, value, field) {
  const allowed = actor.scopes[field];
  return actor.scopes.wildcard || !allowed || allowed.includes('*') || allowed.includes(value);
}

export function assertFilterInScope(actor, filter) {
  const fields = { tenantId: 'tenantIds', projectId: 'projectIds', agentId: 'agentIds', aliasId: 'aliasIds' };
  for (const [key, scopeField] of Object.entries(fields)) {
    if (filter[key] && !scopeAllows(actor, filter[key], scopeField)) throw new ScopeError();
  }
  const range = actor.scopes.timeRange ?? {};
  if (range.from && filter.from && filter.from < range.from) throw new ScopeError();
  if (range.to && filter.to && filter.to > range.to) throw new ScopeError();
}

export function filterForActor(actor, requested = {}) {
  assertFilterInScope(actor, requested);
  return { ...requested, actorScope: actor.scopes };
}

export function recordScope(actor) {
  if (actor.scopes.wildcard) return { wildcard: true };
  return {
    tenantId: actor.scopes.tenantIds?.length === 1 ? actor.scopes.tenantIds[0] : null,
    projectId: actor.scopes.projectIds?.length === 1 ? actor.scopes.projectIds[0] : null,
    agentId: actor.scopes.agentIds?.length === 1 ? actor.scopes.agentIds[0] : null,
    agentAliasId: actor.scopes.aliasIds?.length === 1 ? actor.scopes.aliasIds[0] : null,
  };
}

export function signHs256Token(claims, secret) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify(claims));
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}
