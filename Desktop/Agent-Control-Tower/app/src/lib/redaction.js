const SECRET_KEY = /(?:authorization|api[-_ ]?key|api[-_ ]?token|access[-_ ]?token|refresh[-_ ]?token|password|secret|credential|cookie|set-cookie|private[-_ ]?key|client[-_ ]?secret)/i;
const SENSITIVE_TEXT = [
  /bearer\s+[a-z0-9._~+/=-]+/ig,
  /boomi_token\.[^\s:]+:[^\s]+/ig,
  /(?:sk|pk)[-_][a-z0-9_-]{12,}/ig,
  /-----begin [^-]+ key-----[\s\S]*?-----end [^-]+ key-----/ig,
  /\beyj[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/ig,
  /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/ig,
  /(?<!\w)(?:\+?\d[\d .()-]{8,}\d)(?!\w)/g,
];

function redactString(value) {
  return SENSITIVE_TEXT.reduce((result, pattern) => result.replace(pattern, '[REDACTED]'), value);
}

/**
 * Telemetry correlation identifiers (sessionId, eventId, agent/tenant/project
 * ids) must survive redaction byte-for-byte: the facade matches
 * event.sessionId against the redacted session, and the dashboard joins
 * timelines on these values. Free-text patterns (emails, phone-like digit
 * runs) legitimately appear in date-stamped ids, so identity fields are
 * exempt from text-pattern redaction. Key-name protection (SECRET_KEY)
 * still applies to every field.
 */
export const TELEMETRY_IDENTITY_FIELDS = new Set([
  'sessionId',
  'eventId',
  'agentId',
  'agentAliasId',
  'tenantId',
  'projectId',
]);

/**
 * Return a JSON-safe, redacted copy of telemetry supplied by an agent.
 * Callers must validate an explicit telemetry schema before persistence;
 * this helper protects approved text fields and nested diagnostic values.
 * Pass TELEMETRY_IDENTITY_FIELDS as preserveKeys for telemetry payloads so
 * correlation identifiers are not rewritten.
 */
export function redact(value, depth = 0, preserveKeys = undefined) {
  if (depth > 8) return '[TRUNCATED]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redact(item, depth + 1, preserveKeys));
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [
    key,
    SECRET_KEY.test(key)
      ? '[REDACTED]'
      : preserveKeys?.has(key) && typeof item === 'string'
        ? item
        : redact(item, depth + 1, preserveKeys),
  ]));
}

export function redactionStatus() {
  return 'redacted-v2';
}
