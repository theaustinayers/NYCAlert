const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const state = { section: 'overview', session: null, users: [], incidents: [], pending: [], webhooks: [], learningEvents: [], learningStatus: null };
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const formatTime = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
};

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function showMessage(message, error = false) {
  const alert = $('#admin-alert');
  alert.textContent = message;
  alert.classList.toggle('error', error);
  alert.hidden = !message;
  if (message) setTimeout(() => { alert.hidden = true; }, 6000);
}

async function init() {
  wireNavigation();
  $('#admin-logout').addEventListener('click', logout);
  $('#refresh-current').addEventListener('click', refreshCurrent);
  $('#refresh-users').addEventListener('click', loadUsers);
  $('#refresh-incidents').addEventListener('click', loadIncidents);
  $('#refresh-webhooks').addEventListener('click', loadWebhooks);
  $('#user-search').addEventListener('input', renderUsers);
  $('#user-status').addEventListener('change', renderUsers);
  $('#incident-search').addEventListener('input', renderIncidents);
  $('#admin-invite-form').addEventListener('submit', inviteAdmin);
  $('#webhook-form').addEventListener('submit', createWebhook);
  $('#analytics-form').addEventListener('submit', saveAnalytics);
  $('#clear-analytics').addEventListener('click', clearAnalytics);
  $('#refresh-learning').addEventListener('click', loadLearningLog);
  $('#download-learning').addEventListener('click', exportLearningLog);
  $('#clear-learning').addEventListener('click', clearLearningLog);
  $('#learning-search').addEventListener('input', renderLearningEvents);
  $('#create-incident').addEventListener('click', () => openIncidentEditor());
  $('#incident-form').addEventListener('submit', saveIncident);
  $('#incident-form').addEventListener('click', (event) => { if (event.target.value === 'cancel') $('#incident-editor').close(); });
  const sessionResponse = await api('/api/auth/session').catch(() => ({ session: null }));
  state.session = sessionResponse.session;
  if (state.session?.kind !== 'admin') {
    window.location.replace('/?auth=login');
    return;
  }
  $('#admin-session-label').textContent = state.session.account?.email || 'Administrator session';
  await Promise.all([loadOverview(), loadUsers(), loadIncidents(), loadWebhooks(), loadAnalytics(), loadLearningLog()]);
}

function wireNavigation() {
  $$('.admin-nav-item').forEach((button) => button.addEventListener('click', () => activateSection(button.dataset.section)));
  $$('[data-open-section]').forEach((button) => button.addEventListener('click', () => activateSection(button.dataset.openSection)));
}

function activateSection(name) {
  state.section = name;
  $$('.admin-nav-item').forEach((button) => button.classList.toggle('active', button.dataset.section === name));
  $$('.admin-section').forEach((section) => {
    const active = section.id === `section-${name}`;
    section.classList.toggle('active', active);
    section.hidden = !active;
  });
  const labels = {
    overview: ['CONTROL ROOM', 'Overview', 'Current service snapshot and administrative actions.'],
    users: ['ACCOUNT MANAGEMENT', 'Users', 'Search registrations, review requested access, and manage privileged accounts.'],
    incidents: ['EDITORIAL CONTROL', 'Incidents', 'Manage current incident cards and privately held location-correction reports.'],
    discord: ['INTEGRATIONS', 'Discord & webhooks', 'Review assigned destinations. Stored webhook targets are not dispatched yet.'],
    analytics: ['SITE CONFIGURATION', 'Analytics', 'Configure consent-gated analytics IDs and search-engine verification tags.'],
    learning: ['MODEL IMPROVEMENT', 'AI Learning Debugger', 'Inspect transcript-only workflow traces and decision values.']
  };
  const [eyebrow, title, description] = labels[name] || labels.overview;
  $('#section-eyebrow').textContent = eyebrow;
  $('#section-title').textContent = title;
  $('#section-description').textContent = description;
  $('#refresh-current').hidden = name === 'analytics';
}

async function refreshCurrent() {
  if (state.section === 'overview') return loadOverview();
  if (state.section === 'users') return Promise.all([loadUsers(), loadAdministrators()]);
  if (state.section === 'incidents') return loadIncidents();
  if (state.section === 'discord') return loadWebhooks();
  if (state.section === 'analytics') return loadAnalytics();
  return loadLearningLog();
}

async function loadLearningLog() {
  try {
    const data = await api('/api/admin/learning-log?limit=200');
    state.learningStatus = data.status;
    state.learningEvents = data.events || [];
    const status = data.status;
    $('#learning-status-title').textContent = status.enabled ? 'Transcript logging is ON' : 'Transcript logging is OFF';
    $('#learning-status-detail').textContent = status.enabled
      ? `${status.currentEvents} events · max ${status.maxEvents} · ${status.retentionDays}-day retention · private DATA_DIR/${status.fileName} · no audio saved`
      : 'Set AI_LEARNING_LOG_ENABLED=true in the protected server environment and restart to enable transcript-only logging.';
    $('#download-learning').disabled = !status.enabled;
    $('#clear-learning').disabled = !status.enabled || status.currentEvents === 0;
    renderLearningEvents();
  } catch (error) { showMessage(error.message, true); }
}

function renderLearningEvents() {
  const list = $('#learning-events');
  const query = $('#learning-search').value.trim().toLowerCase();
  const events = state.learningEvents.filter((event) => !query || JSON.stringify(event).toLowerCase().includes(query));
  if (!state.learningStatus?.enabled) {
    list.innerHTML = '<p class="admin-muted">Logging is off. Enable it with AI_LEARNING_LOG_ENABLED=true. Existing records are not available unless logging was previously enabled.</p>';
    return;
  }
  if (!events.length) { list.innerHTML = '<p class="admin-muted">No matching log events. Workflow records appear as calls are processed.</p>'; return; }
  const byEvent = new Map();
  for (const event of events) {
    const previous = byEvent.get(event.eventId) || [];
    previous.push(event);
    byEvent.set(event.eventId, previous);
  }
  list.innerHTML = [...byEvent.values()].map((records) => {
    records.sort((left, right) => Date.parse(left.loggedAt) - Date.parse(right.loggedAt));
    const event = records.find((record) => record.stage === 'transcription' && record.transcript) || records[0];
    const latest = records.at(-1);
    const path = latest.workflowPath || records.map((record) => record.stage);
    const facts = [
      ['Traffic type', latest.trafficType === 'routine' ? 'Routine traffic · non-incident' : latest.trafficType === 'incident' ? 'Incident-classified call' : 'Awaiting triage classification'],
      ['Source', `${event.agency || '—'} · ${event.sourceGroup || 'Radio'} · ${event.feedBorough || '—'}`],
      ['Triage', `${latest.headline || event.headline || '—'} · ${latest.category || event.category || '—'}`],
      ['Scores', latest.scores ? `Public ${latest.scores.public}/5 · Buff ${latest.scores.buff}/5 · News ${latest.scores.newsMedia}/5` : '—'],
      ['Thresholds', latest.thresholds ? `Conf ${latest.thresholds.confidence} · Public ${latest.thresholds.public} · Buff ${latest.thresholds.buff} · News ${latest.thresholds.newsMedia}` : '—'],
      ['Location', latest.location || event.location || 'Not stated'],
      ['Geocoding', latest.geocode ? `${latest.geocode.matched ? 'Matched' : latest.geocode.attempted ? 'No match' : 'Not attempted'}${latest.geocode.borough ? ` · ${latest.geocode.borough}` : ''}${latest.geocode.latitude ? ` · ${latest.geocode.latitude}, ${latest.geocode.longitude}` : ''}` : '—'],
      ['Correlation', latest.correlation ? `${latest.disposition || 'Decision'} · ${latest.correlation.candidateCount} candidates${latest.correlation.incidentId ? ` · ${latest.correlation.incidentId}` : ''}` : latest.disposition || '—'],
      ['Discord', latest.routing ? `${latest.routing.discordMessagesSent || 0} sent · ${latest.routing.eligibleSubscriptions} eligible subscriptions` : '—']
    ];
    const transcript = event.transcript
      ? `<details><summary>Radio transcript (${Number(event.transcriptCharacters) || event.transcript.length} chars · ${escapeHtml(event.transcriptSource || 'source unknown')})</summary><pre class="learning-transcript">${escapeHtml(event.transcript)}</pre></details>`
      : '<p class="admin-muted">No transcript stored on the terminal event row; use the event ID to locate its transcription stage.</p>';
    return `<article class="learning-event"><header class="learning-event-head"><span class="learning-stage">${escapeHtml(latest.stage)}</span><strong>${escapeHtml(event.agency)} · ${escapeHtml(event.feedBorough)}</strong><time>${escapeHtml(formatTime(event.occurredAt))}</time><small>Event ${escapeHtml(event.eventId)}</small><small>Call ${escapeHtml(event.callId)}</small></header><div class="learning-path">${path.map((stage, index) => `${index ? '<b>→</b>' : ''}<span>${escapeHtml(stage)}</span>`).join('')}</div><div class="learning-event-body">${transcript}<div class="learning-facts">${facts.map(([label, value]) => `<div class="learning-fact"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('')}</div><details><summary>Raw structured record</summary><pre>${escapeHtml(JSON.stringify(latest, null, 2))}</pre></details></div></article>`;
  }).join('');
}

async function exportLearningLog() {
  try {
    const response = await fetch('/api/admin/learning-log/export', { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Could not export learning data.');
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `nycalert-learning-debug-${new Date().toISOString().replaceAll(':', '-')}.jsonl`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    showMessage('Learning log export downloaded. Treat the transcript data as sensitive.');
  } catch (error) { showMessage(error.message, true); }
}

async function clearLearningLog() {
  if (!state.learningStatus?.enabled) return;
  const count = state.learningStatus.currentEvents;
  if (!confirm(`Remove all ${count} records, including transcript text, from the active learning log? Export first if you need a copy. Backups or filesystem snapshots may retain earlier copies.`)) return;
  try {
    await api('/api/admin/learning-log', { method: 'DELETE' });
    showMessage('Learning data log cleared.');
    await loadLearningLog();
  } catch (error) { showMessage(error.message, true); }
}

async function loadOverview() {
  try {
    const data = await api('/api/admin/overview');
    $('#overview-incidents').textContent = data.incidents;
    $('#overview-users').textContent = data.users;
    $('#overview-pending-users').textContent = data.pendingUsers;
    $('#overview-pending-incidents').textContent = data.pendingIncidents;
    $('#pending-user-count').textContent = data.pendingUsers;
    $('#overview-incidents').title = data.dataWindow;
  } catch (error) { showMessage(error.message, true); }
}

async function loadUsers() {
  try {
    const params = new URLSearchParams();
    const query = $('#user-search').value.trim();
    const status = $('#user-status').value;
    if (query) params.set('q', query);
    if (status !== 'all') params.set('status', status);
    const data = await api(`/api/admin/accounts${params.size ? `?${params}` : ''}`);
    state.users = data.accounts || [];
    renderUsers();
    await Promise.all([loadAdministrators(), populateWebhookAccounts()]);
    void loadOverview();
  } catch (error) { $('#users-table').innerHTML = `<tr><td colspan="6">${escapeHtml(error.message)}</td></tr>`; }
}

function renderUsers() {
  const query = $('#user-search').value.trim().toLowerCase();
  const status = $('#user-status').value;
  const users = state.users.filter((user) => (!query || `${user.firstName} ${user.lastName} ${user.email} ${user.accountType}`.toLowerCase().includes(query)) && (status === 'all' || user.status === status));
  const table = $('#users-table');
  if (!users.length) { table.innerHTML = '<tr><td colspan="6">No users match these filters.</td></tr>'; return; }
  table.innerHTML = users.map((user) => `<tr data-user-id="${escapeHtml(user.id)}"><td><div class="admin-user-cell"><strong>${escapeHtml(user.firstName)} ${escapeHtml(user.lastName)}</strong><small>${escapeHtml(user.email)}</small><small>${escapeHtml(user.phone || '')}</small></div></td><td><span class="admin-badge">${escapeHtml(user.accountType)}</span><small>${user.usageCase ? `<br>${escapeHtml(user.usageCase)}` : ''}</small></td><td><span class="admin-badge ${escapeHtml(user.status)}">${escapeHtml(user.status)}</span></td><td>${user.emailVerified ? 'Verified' : 'No'}</td><td>${escapeHtml(formatTime(user.createdAt))}</td><td><div class="admin-row-actions">${user.emailVerified && user.status !== 'approved' ? '<button class="approve" data-user-action="approved">Approve</button>' : ''}${user.status !== 'suspended' ? '<button data-user-action="suspended">Suspend</button>' : '<button data-user-action="pending-approval">Restore</button>'}<button class="danger" data-user-delete="true">Delete</button></div></td></tr>`).join('');
  $$('[data-user-action]', table).forEach((button) => button.addEventListener('click', () => updateUser(button.closest('[data-user-id]').dataset.userId, button.dataset.userAction)));
  $$('[data-user-delete]', table).forEach((button) => button.addEventListener('click', () => deleteUser(button.closest('[data-user-id]').dataset.userId)));
}

async function updateUser(id, status) {
  try {
    await api(`/api/admin/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
    showMessage(`User status set to ${status}.`);
    await loadUsers();
  } catch (error) { showMessage(error.message, true); }
}

async function deleteUser(id) {
  if (!confirm('Delete this user account and its stored webhook assignments?')) return;
  try {
    await api(`/api/admin/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    showMessage('User account deleted.');
    await loadUsers();
  } catch (error) { showMessage(error.message, true); }
}

async function loadAdministrators() {
  try {
    const data = await api('/api/admin/administrators');
    const list = $('#administrators-list');
    if (!data.administrators.length) { list.innerHTML = '<p class="admin-muted">No additional administrator accounts.</p>'; return; }
    list.innerHTML = data.administrators.map((admin) => `<article class="admin-card"><div class="admin-card-meta"><span class="admin-badge ${escapeHtml(admin.status)}">${escapeHtml(admin.status)}</span><span>${admin.emailVerified ? 'Verified' : 'Unverified'}</span></div><h3>${escapeHtml(admin.firstName)} ${escapeHtml(admin.lastName)}</h3><p>${escapeHtml(admin.email)}</p><div class="admin-card-actions"><button class="admin-icon-button danger" data-admin-revoke="${escapeHtml(admin.id)}" ${admin.id === state.session?.account?.id ? 'disabled' : ''}>Revoke access</button></div></article>`).join('');
    $$('[data-admin-revoke]', list).forEach((button) => button.addEventListener('click', () => revokeAdmin(button.dataset.adminRevoke)));
  } catch (error) { $('#administrators-list').innerHTML = `<p class="admin-muted">${escapeHtml(error.message)}</p>`; }
}

async function inviteAdmin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await api('/api/admin/administrators/invite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    form.reset();
    showMessage(result.message);
    await loadAdministrators();
  } catch (error) { showMessage(error.message, true); }
  finally { button.disabled = false; }
}

async function revokeAdmin(id) {
  if (!confirm('Revoke this administrator?')) return;
  try { await api(`/api/admin/administrators/${encodeURIComponent(id)}`, { method: 'DELETE' }); await loadAdministrators(); showMessage('Administrator access revoked.'); }
  catch (error) { showMessage(error.message, true); }
}

async function loadIncidents() {
  try {
    const params = new URLSearchParams();
    const query = $('#incident-search').value.trim();
    if (query) params.set('q', query);
    const [incidentData, pendingData] = await Promise.all([
      api(`/api/admin/incidents${params.size ? `?${params}` : ''}`),
      api('/api/admin/incidents/pending')
    ]);
    state.incidents = incidentData.incidents || [];
    state.pending = pendingData.incidents || [];
    renderIncidents();
    void loadOverview();
  } catch (error) { showMessage(error.message, true); }
}

function renderIncidents() {
  const query = $('#incident-search').value.trim().toLowerCase();
  const incidents = state.incidents.filter((incident) => !query || `${incident.title} ${incident.summary} ${incident.location || ''} ${incident.agency} ${incident.borough}`.toLowerCase().includes(query));
  $('#incidents-list').innerHTML = incidents.length ? incidents.map((incident) => `<article class="admin-incident-card" data-incident-id="${escapeHtml(incident.id)}"><div><div class="admin-card-meta"><span class="admin-badge">${escapeHtml(incident.agency)} · ${escapeHtml(incident.borough)}</span><span>${escapeHtml(formatTime(incident.updatedAt || incident.occurredAt))}</span><span>${escapeHtml(incident.updateCount)} updates</span></div><h3>${escapeHtml(incident.title)}</h3><p>${escapeHtml(incident.summary)}</p><p>${escapeHtml(incident.location || 'Location unconfirmed')}</p></div><div class="admin-card-actions"><a class="admin-icon-button" href="/incident/${encodeURIComponent(incident.id)}" target="_blank" rel="noopener">View</a><button class="admin-icon-button" data-edit-incident="${escapeHtml(incident.id)}">Edit</button><button class="admin-icon-button danger" data-delete-incident="${escapeHtml(incident.id)}">Delete</button></div></article>`).join('') : '<p class="admin-muted">No incidents match this search.</p>';
  $$('[data-edit-incident]').forEach((button) => button.addEventListener('click', () => openIncidentEditor(state.incidents.find((item) => item.id === button.dataset.editIncident))));
  $$('[data-delete-incident]').forEach((button) => button.addEventListener('click', () => deleteIncident(button.dataset.deleteIncident)));
  $('#pending-incident-count').textContent = state.pending.length;
  const pendingList = $('#pending-incidents-list');
  pendingList.innerHTML = state.pending.length ? state.pending.map((pending) => `<article class="admin-card"><div class="admin-card-meta"><span class="admin-badge pending-approval">PRIVATE · PENDING</span><span>${escapeHtml(pending.agency)} · ${escapeHtml(pending.borough)}</span><span>Expires ${escapeHtml(formatTime(pending.expiresAt))}</span></div><h3>${escapeHtml(pending.eventType || 'Unlocated report')}</h3><p>${escapeHtml(pending.summary)}</p>${pending.location ? `<p>Unverified location: ${escapeHtml(pending.location)}</p>` : '<p>No confidently geocoded address. Not shown publicly.</p>'}<div class="admin-card-actions"><button class="admin-icon-button danger" data-discard-pending="${escapeHtml(pending.id)}">Discard pending</button></div></article>`).join('') : '<p class="admin-muted">No pending reports. Queue contents expire and are lost on service restart.</p>';
  $$('[data-discard-pending]').forEach((button) => button.addEventListener('click', () => discardPending(button.dataset.discardPending)));
}

function openIncidentEditor(incident) {
  const form = $('#incident-form');
  form.reset();
  form.elements.id.value = incident?.id || '';
  form.elements.headline.value = incident ? incident.title.split(' | ')[0] : '';
  form.elements.summary.value = incident?.summary || '';
  form.elements.location.value = incident?.location || '';
  form.elements.agency.value = incident?.agency || 'FDNY';
  form.elements.borough.value = incident?.borough || 'Manhattan';
  form.elements.incidentType.value = incident?.incidentType || 'other';
  form.elements.category.value = incident?.category || 'newsworthy';
  $('#incident-editor-title').textContent = incident ? 'Edit incident' : 'Add incident';
  $('#incident-editor').showModal();
}

async function saveIncident(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  const id = data.id;
  delete data.id;
  try {
    if (id) await api(`/api/admin/incidents/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    else await api('/api/admin/incidents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...data, confidence: 0.9, newsworthinessScore: 3, buffInterestScore: 3, assignmentDeskScore: 3 }) });
    $('#incident-editor').close();
    showMessage(id ? 'Incident updated.' : 'Incident added to the public board.');
    await loadIncidents();
  } catch (error) { showMessage(error.message, true); }
}

async function deleteIncident(id) {
  if (!confirm('Remove this incident from the public board and map? This cannot recall Discord posts already sent.')) return;
  try { await api(`/api/admin/incidents/${encodeURIComponent(id)}`, { method: 'DELETE' }); showMessage('Incident removed from the public board.'); await loadIncidents(); }
  catch (error) { showMessage(error.message, true); }
}

async function discardPending(id) {
  if (!confirm('Discard this private pending report?')) return;
  try { await api(`/api/admin/incidents/pending/${encodeURIComponent(id)}`, { method: 'DELETE' }); showMessage('Pending report discarded.'); await loadIncidents(); }
  catch (error) { showMessage(error.message, true); }
}

async function populateWebhookAccounts() {
  const select = $('#webhook-account');
  const approved = state.users.filter((user) => user.status === 'approved' && user.emailVerified && !user.isAdmin);
  const current = select.value;
  select.innerHTML = approved.map((user) => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.email)} · ${escapeHtml(user.accountType)}</option>`).join('');
  if (!approved.length) select.innerHTML = '<option value="">No approved accounts</option>';
  else if (approved.some((user) => user.id === current)) select.value = current;
}

async function loadWebhooks() {
  try {
    const data = await api('/api/admin/webhooks');
    state.webhooks = data.webhooks || [];
    const list = $('#webhooks-list');
    list.innerHTML = state.webhooks.length ? state.webhooks.map((hook) => `<article class="admin-card"><div class="admin-card-meta"><span class="admin-badge">${escapeHtml(hook.accountType)}</span><span>${escapeHtml(hook.accountEmail)}</span><span>${escapeHtml(hook.boroughs === 'all' ? 'All boroughs' : hook.boroughs.join(', '))}</span></div><h3>${escapeHtml(hook.name)}</h3><p class="webhook-url">${escapeHtml(hook.url)}</p><div class="admin-card-actions"><button class="admin-icon-button danger" data-delete-webhook="${escapeHtml(hook.accountId)}:${escapeHtml(hook.id)}">Delete assignment</button></div></article>`).join('') : '<p class="admin-muted">No webhook targets are assigned.</p>';
    $$('[data-delete-webhook]').forEach((button) => button.addEventListener('click', () => deleteWebhook(button.dataset.deleteWebhook)));
  } catch (error) { showMessage(error.message, true); }
}

async function createWebhook(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  const selected = $$('input[name="boroughs"]:checked', form).map((input) => input.value);
  values.boroughs = selected.includes('all') ? 'all' : selected;
  try {
    await api('/api/admin/webhooks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
    form.reset();
    showMessage('Webhook target stored. Outbound delivery remains disabled.');
    await loadWebhooks();
  } catch (error) { showMessage(error.message, true); }
}

async function deleteWebhook(compositeId) {
  if (!confirm('Remove this webhook assignment?')) return;
  const [accountId, webhookId] = compositeId.split(':');
  try { await api(`/api/admin/webhooks/${encodeURIComponent(accountId)}/${encodeURIComponent(webhookId)}`, { method: 'DELETE' }); showMessage('Webhook assignment removed.'); await loadWebhooks(); }
  catch (error) { showMessage(error.message, true); }
}

async function loadAnalytics() {
  try {
    const data = await api('/api/admin/analytics');
    const form = $('#analytics-form');
    for (const [name, value] of Object.entries(data.settings || {})) if (form.elements[name]) form.elements[name].value = value;
    $('#analytics-state').textContent = data.configured ? 'Saved in persistent server storage' : 'Settings store is unavailable';
  } catch (error) { showMessage(error.message, true); }
}

async function saveAnalytics(event) {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  try {
    const data = await api('/api/admin/analytics', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
    for (const [name, value] of Object.entries(data.settings || {})) if (event.currentTarget.elements[name]) event.currentTarget.elements[name].value = value;
    $('#analytics-state').textContent = 'Saved. Search verification meta tags are now in the page head; analytics require visitor consent.';
    showMessage('Analytics settings saved.');
  } catch (error) { showMessage(error.message, true); }
}

async function clearAnalytics() {
  if (!confirm('Clear all analytics IDs and verification tokens?')) return;
  try {
    await api('/api/admin/analytics', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    $('#analytics-form').reset();
    $('#analytics-state').textContent = 'Settings cleared';
    showMessage('Analytics configuration cleared.');
  } catch (error) { showMessage(error.message, true); }
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); }
  finally { window.location.replace('/'); }
}

void init().catch((error) => showMessage(error.message, true));
