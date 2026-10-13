const $ = (selector) => document.querySelector(selector);
const state = {
  sessions: [],
  selected: null,
  filter: '',
  query: '',
  detailRequest: 0,
  loading: false,
};

async function getJson(path, options = {}) {
  const headers = { Accept: 'application/json' };
  try {
    const token = sessionStorage.getItem('controlTowerToken');
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch {
    // Private browsing may deny storage; the server will return an auth error.
  }
  const response = await fetch(path, { headers, signal: options.signal });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error('Authentication required. Set a valid session token to view this projection.');
    throw new Error(`Request failed (${response.status})`);
  }
  return response.json();
}

function safe(value) {
  return String(value ?? '—').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(value ?? 0);
}

function formatDate(value, options = {}) {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', ...options }).format(new Date(value));
}

function formatTime(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}

function showToast(message, kind = 'error') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = `toast visible ${kind}`;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => { toast.className = 'toast'; }, 4200);
}

function hasSessionToken() {
  try {
    return Boolean(sessionStorage.getItem('controlTowerToken'));
  } catch {
    return false;
  }
}

function updateConnectionControl() {
  const connectButton = $('#connect-button');
  const authPanel = $('#auth-panel');
  const disconnectButton = $('#disconnect-button');
  if (!connectButton || !authPanel || !disconnectButton) return;
  const connected = hasSessionToken();
  connectButton.textContent = connected ? 'Connected' : 'Connect';
  connectButton.title = connected ? 'Dashboard viewer session active' : 'Set a viewer session token';
  authPanel.hidden = connected;
  disconnectButton.hidden = !connected;
}

function showAuthPanel() {
  const panel = $('#auth-panel');
  if (panel) panel.hidden = false;
  $('#session-token')?.focus();
}

async function connectDashboard(event) {
  event?.preventDefault();
  const field = $('#session-token');
  const token = field?.value.trim();
  if (!token) {
    showToast('A viewer session token is required.');
    field?.focus();
    return;
  }
  const button = $('#auth-form button[type="submit"]');
  if (button) button.disabled = true;
  try {
    const response = await fetch('/api/v1/dashboards/default/summary', {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(response.status === 401 || response.status === 403 ? 'That viewer session token was rejected.' : `Connection failed (${response.status})`);
    }
    try {
      sessionStorage.setItem('controlTowerToken', token);
    } catch {
      throw new Error('This browser does not allow session storage.');
    }
    field.value = '';
    updateConnectionControl();
    await load({ preserveSelection: false });
  } catch (error) {
    showAuthPanel();
    showToast(error.message);
  } finally {
    if (button) button.disabled = false;
  }
}

function disconnectDashboard() {
  try {
    sessionStorage.removeItem('controlTowerToken');
  } catch {
    // Private browsing may deny storage; the next request will show the auth state.
  }
  state.sessions = [];
  state.selected = null;
  updateConnectionControl();
  renderSessions();
  renderSummary({ totalSessions: 0, successRate: null, failedSessions: 0, totalInputTokens: 0, totalOutputTokens: 0, totalToolCalls: 0, guardrailHits: 0 });
  renderTrend([]);
  renderEmptyDetail('Connect with a viewer session token to inspect the projection.');
  $('#freshness').textContent = 'Authentication required. Set a valid session token to view this projection.';
  $('#last-refresh').textContent = '';
  $('#mode-badge').textContent = 'OFFLINE';
  $('#mode-badge').classList.remove('mock');
}

function toggleConnection() {
  if (hasSessionToken()) disconnectDashboard();
  else showAuthPanel();
}

function renderSummary(summary) {
  const cards = [
    ['Sessions', formatNumber(summary.totalSessions), 'Total observed', 'sessions', 'blue'],
    ['Success rate', summary.successRate == null ? '—' : `${summary.successRate}%`, `${summary.failedSessions} failed`, 'success', summary.successRate >= 90 ? 'green' : 'amber'],
    ['Tokens', formatNumber((summary.totalInputTokens ?? 0) + (summary.totalOutputTokens ?? 0)), 'Input + output', 'tokens', 'purple'],
    ['Tool calls', formatNumber(summary.totalToolCalls), `${summary.guardrailHits} guardrail hits`, 'tool calls', 'rose'],
  ];
  $('#summary').innerHTML = cards.map(([label, value, detail, icon, tone]) => `<article class="metric-card ${tone}"><div class="metric-top"><span>${label}</span><span class="metric-icon" aria-hidden="true">${icon === 'sessions' ? '◌' : icon === 'success' ? '↗' : icon === 'tokens' ? '◈' : '⌁'}</span></div><strong>${value}</strong><small>${detail}</small><div class="metric-rule" aria-hidden="true"></div></article>`).join('');
}

function renderTrend(points) {
  if (!points.length) {
    $('#trend').innerHTML = '<p class="empty">No activity in the local projection yet.</p>';
    return;
  }
  const max = Math.max(...points.map((point) => point.invocations), 1);
  $('#trend').innerHTML = points.map((point) => {
    const height = Math.max(10, point.invocations / max * 100);
    return `<div class="bar-group" tabindex="0" aria-label="${safe(point.date)}: ${point.invocations} invocations, ${point.failures} failures, ${formatNumber(point.tokens)} tokens"><div class="bar-value">${formatNumber(point.invocations)}</div><div class="bar" style="--bar-height:${height}%"></div><span>${safe(point.date.slice(5))}</span></div>`;
  }).join('');
}

function visibleSessions() {
  const query = state.query.trim().toLowerCase();
  return state.sessions.filter((session) => (!state.filter || session.status === state.filter)).filter((session) => {
    if (!query) return true;
    return [session.sessionId, session.agentId, session.agentAliasId, session.status, session.errorClass].some((value) => String(value ?? '').toLowerCase().includes(query));
  });
}

function renderSessions() {
  const sessions = visibleSessions();
  $('#session-count').textContent = `${sessions.length} ${sessions.length === 1 ? 'run' : 'runs'} shown${state.query || state.filter ? ' · filters active' : ''}`;
  if (!sessions.length) {
    $('#sessions').innerHTML = '<div class="empty-state"><span class="empty-icon">⌕</span><strong>No matching runs</strong><p>Try clearing the search or status filter.</p></div>';
    return;
  }
  $('#sessions').innerHTML = sessions.map((session) => {
    const totalTokens = (session.inputTokenCount ?? 0) + (session.outputTokenCount ?? 0);
    const selected = session.sessionId === state.selected;
    return `<button class="session-row ${selected ? 'selected' : ''}" data-session="${safe(session.sessionId)}" aria-current="${selected ? 'true' : 'false'}"><span class="status-dot ${safe(session.status)}"></span><span class="session-main"><strong>${safe(session.agentId)}</strong><small>${safe(formatDate(session.startedAt))} · ${safe(session.agentAliasId)}</small></span><span class="session-stats"><b class="status-text ${safe(session.status)}">${safe(session.status)}</b><small>${safe(session.durationMs)} ms · ${formatNumber(totalTokens)} tokens</small></span><span class="row-arrow" aria-hidden="true">›</span></button>`;
  }).join('');
  document.querySelectorAll('[data-session]').forEach((button) => button.addEventListener('click', () => selectSession(button.dataset.session)));
}

function renderEmptyDetail(message = 'Choose a run to inspect its redacted event timeline.') {
  $('#timeline-title').textContent = 'Select a session';
  $('#timeline-subtitle').textContent = 'Choose a run to inspect its redacted timeline';
  $('#detail-status').textContent = '—';
  $('#detail-status').className = 'status-pill';
  $('#session-facts').hidden = true;
  $('#timeline').className = 'timeline empty';
  $('#timeline').textContent = message;
}

function renderDetail(session, events) {
  const status = session.status ?? 'unknown';
  $('#timeline-title').textContent = `${session.agentId} · ${session.sessionId}`;
  $('#timeline-subtitle').textContent = `${session.agentAliasId ?? 'Unassigned alias'} · ${events.items.length} timeline events`;
  $('#detail-status').textContent = status;
  $('#detail-status').className = `status-pill ${safe(status)}`;
  const totalTokens = (session.inputTokenCount ?? 0) + (session.outputTokenCount ?? 0);
  $('#session-facts').hidden = false;
  $('#session-facts').innerHTML = `<div><span>Started</span><strong>${safe(formatDate(session.startedAt))}</strong></div><div><span>Duration</span><strong>${safe(session.durationMs)} ms</strong></div><div><span>Tokens</span><strong>${formatNumber(totalTokens)}</strong></div><div><span>Tools</span><strong>${formatNumber(session.toolCallCount)}</strong></div>`;
  $('#timeline').className = 'timeline';
  $('#timeline').innerHTML = events.items.map((event) => `<article class="event ${safe(event.status)}"><span class="event-line"></span><div><div class="event-meta"><strong>${safe(event.eventType)}</strong><time datetime="${safe(event.timestamp)}">${safe(formatTime(event.timestamp))}</time></div><p>${safe(event.redactedSummary)}</p><small>${safe(event.status)}${event.toolName ? ` · ${safe(event.toolName)}` : ''}</small></div></article>`).join('');
}

async function selectSession(sessionId) {
  const requestId = ++state.detailRequest;
  state.selected = sessionId;
  renderSessions();
  $('#timeline').className = 'timeline loading-state';
  $('#timeline').innerHTML = '<span class="spinner"></span>Loading redacted timeline…';
  try {
    const [session, events] = await Promise.all([
      getJson(`/api/v1/sessions/${encodeURIComponent(sessionId)}`),
      getJson(`/api/v1/sessions/${encodeURIComponent(sessionId)}/events`),
    ]);
    if (requestId !== state.detailRequest) return;
    renderDetail(session, events);
  } catch (error) {
    if (requestId !== state.detailRequest) return;
    renderEmptyDetail(error.message);
    showToast(error.message);
  }
}

async function load({ preserveSelection = true } = {}) {
  if (state.loading) return;
  state.loading = true;
  $('#refresh-button').disabled = true;
  $('#refresh-button').classList.add('spinning');
  try {
    const [summary, trend, sessions] = await Promise.all([
      getJson('/api/v1/dashboards/default/summary'),
      getJson('/api/v1/dashboards/default/timeseries'),
      getJson('/api/v1/sessions?limit=50'),
    ]);
    state.sessions = sessions.items;
    renderSummary(summary);
    renderTrend(trend.items);
    renderSessions();
    const source = summary.source === 'mock-projection' ? 'synthetic mock data' : 'local redacted projection';
    $('#freshness').textContent = `Serving ${source}`;
    $('#last-refresh').textContent = `Updated ${new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date())}`;
    $('#mode-badge').textContent = summary.source === 'mock-projection' ? 'MOCK DATA' : 'LOCAL PROJECTION';
    $('#mode-badge').classList.toggle('mock', summary.source === 'mock-projection');
    const selectedStillVisible = state.sessions.some((session) => session.sessionId === state.selected);
    if (!preserveSelection || !selectedStillVisible) {
      state.selected = null;
      renderSessions();
      if (state.sessions[0]) await selectSession(state.sessions[0].sessionId);
      else renderEmptyDetail();
    } else {
      renderSessions();
    }
  } catch (error) {
    $('#freshness').textContent = error.message;
    $('#mode-badge').textContent = 'OFFLINE';
    $('#mode-badge').classList.remove('mock');
    updateConnectionControl();
    if (error.message.startsWith('Authentication required')) showAuthPanel();
    showToast(error.message);
  } finally {
    state.loading = false;
    $('#refresh-button').disabled = false;
    $('#refresh-button').classList.remove('spinning');
  }
}

$('#auth-form').addEventListener('submit', connectDashboard);
$('#connect-button').addEventListener('click', toggleConnection);
$('#disconnect-button').addEventListener('click', disconnectDashboard);
$('#refresh-button').addEventListener('click', () => load({ preserveSelection: true }));
updateConnectionControl();
$('#status-filter').addEventListener('change', (event) => {
  state.filter = event.target.value;
  renderSessions();
  const visible = visibleSessions();
  if (!visible.some((session) => session.sessionId === state.selected)) {
    state.selected = null;
    renderSessions();
    visible[0] ? selectSession(visible[0].sessionId) : renderEmptyDetail('No session matches the current filter.');
  }
});
$('#session-search').addEventListener('input', (event) => {
  state.query = event.target.value;
  renderSessions();
  const visible = visibleSessions();
  if (!visible.some((session) => session.sessionId === state.selected)) {
    state.selected = null;
    renderSessions();
    visible[0] ? selectSession(visible[0].sessionId) : renderEmptyDetail('No session matches the current search.');
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === '/' && document.activeElement?.tagName !== 'INPUT') {
    event.preventDefault();
    $('#session-search').focus();
  }
  if (event.key === 'Escape' && document.activeElement === $('#session-search')) {
    $('#session-search').value = '';
    state.query = '';
    renderSessions();
  }
});

load({ preserveSelection: false });
