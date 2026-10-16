const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const state = { section: 'users', session: null, isAdmin: false, users: [], incidents: [], pending: [], webhooks: [], learningEvents: [], learningStatus: null, deploymentUpdateStatus: null };
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
  $('#copy-sitemap-url')?.addEventListener('click', copySitemapUrl);
  for (const name of ['openGraphTitle', 'openGraphDescription', 'openGraphImage']) {
    const field = $('#analytics-form').elements.namedItem(name);
    field?.addEventListener('input', renderOpenGraphPreview);
  }
  $('#refresh-learning').addEventListener('click', loadLearningLog);
  $('#download-learning').addEventListener('click', exportLearningLog);
  $('#clear-learning').addEventListener('click', clearLearningLog);
  $('#learning-search').addEventListener('input', renderLearningEvents);
  $('#update-website').addEventListener('click', triggerWebsiteUpdate);
  $('#refresh-update-status').addEventListener('click', () => loadDeploymentUpdateStatus(true));
  $('#test-x-integration').addEventListener('click', testXIntegration);
  $('#create-incident').addEventListener('click', () => openIncidentEditor());
  $('#incident-form').addEventListener('submit', saveIncident);
  $('#incident-form').addEventListener('click', (event) => {
    if (event.target.closest('button')?.value === 'cancel') {
      event.preventDefault();
      $('#incident-editor').close();
    }
  });
  const sessionResponse = await api('/api/auth/session').catch(() => ({ session: null }));
  state.session = sessionResponse.session;
  if (state.session?.kind !== 'admin') {
    window.location.replace('/?auth=login');
    return;
  }
  state.isAdmin = ['owner', 'admin'].includes(state.session.role || state.session.account?.adminRole);
  $('#create-incident').hidden = !canEditIncidents();
  document.querySelectorAll('[data-admin-only]').forEach((element) => { element.hidden = !state.isAdmin; });
  $('#admin-session-label').textContent = state.session.account?.email || 'Administrator session';
  activateSection('users');
  const tasks = [loadOverview(), loadUsers(), loadIncidents()];
  if (state.isAdmin) tasks.push(loadAdministrators(), loadWebhooks(), loadAnalytics(), loadLearningLog(), loadDeploymentUpdateStatus());
  await Promise.all(tasks);
  window.setInterval(() => {
    if (state.isAdmin && state.section === 'settings') void loadDeploymentUpdateStatus();
  }, 5000);
}

function wireNavigation() {
  $$('.admin-nav-item').forEach((button) => button.addEventListener('click', () => activateSection(button.dataset.section)));
  $$('[data-open-section]').forEach((button) => button.addEventListener('click', () => activateSection(button.dataset.openSection)));
}

function activateSection(name) {
  const targetSection = $(`#section-${name}`);
  if (targetSection?.hasAttribute('data-admin-only') && !state.isAdmin) name = 'users';
  state.section = name;
  $$('.admin-nav-item').forEach((button) => button.classList.toggle('active', button.dataset.section === name));
  $$('.admin-section').forEach((section) => {
    const active = section.id === `section-${name}`;
    section.classList.toggle('active', active);
    section.hidden = !active;
  });
  const labels = {
    users: ['ACCOUNT MANAGEMENT', 'Users', 'Search registrations, review requested access, and manage privileged accounts.'],
    incidents: ['EDITORIAL CONTROL', 'Incidents', 'Manage current incident cards and privately held location-correction reports.'],
    webhooks: ['INTEGRATIONS', 'Webhooks', 'Review assigned destinations. Stored webhook targets are not dispatched yet.'],
    analytics: ['SITE CONFIGURATION', 'Analytics', 'Configure consent-gated analytics IDs and search-engine verification tags.'],
    settings: ['SYSTEM SETTINGS', 'Settings', 'Manage staff roles, transcript learning data, and protected website updates.']
  };
  const [eyebrow, title, description] = labels[name] || labels.users;
  $('#section-eyebrow').textContent = eyebrow;
  $('#section-title').textContent = title;
  $('#section-description').textContent = description;
  $('#refresh-current').hidden = false;
}

async function refreshCurrent() {
  if (state.section === 'users') return Promise.all([loadOverview(), loadUsers(), ...(state.isAdmin ? [loadAdministrators()] : [])]);
  if (state.section === 'incidents') return loadIncidents();
  if (state.section === 'webhooks') return loadWebhooks();
  if (state.section === 'analytics') return loadAnalytics();
  return Promise.all([loadAdministrators(), loadLearningLog(), loadDeploymentUpdateStatus()]);
}

async function loadOverview() {
  try {
    const data = await api('/api/admin/overview');
    $('#overview-users').textContent = data.users ?? '—';
    $('#overview-pending-users').textContent = data.pendingUsers ?? '—';
  } catch (error) {
    showMessage(error.message, true);
  }
}

async function loadDeploymentUpdateStatus(showChecking = false) {
  const refreshButton = $('#refresh-update-status');
  if (showChecking) {
    refreshButton.disabled = true;
    refreshButton.textContent = 'Checking…';
    $('#deployment-update-status').textContent = 'Refreshing protected updater status…';
  }
  try {
    const data = await api('/api/admin/deployment-update');
    const status = data.status;
    state.deploymentUpdateStatus = status;
    const badge = $('#deployment-update-badge');
    const button = $('#update-website');
    const message = $('#deployment-update-status');
    const result = $('#deployment-update-result');
    badge.textContent = status.state.replaceAll('-', ' ').toUpperCase();
    badge.classList.toggle('approved', status.state === 'succeeded');
    badge.classList.toggle('pending-approval', status.state === 'queued' || status.state === 'updating');
    badge.classList.toggle('suspended', status.state === 'failed' || status.state === 'not-configured');
    message.textContent = status.message || 'Update service status unavailable.';
    if (status.commit) message.textContent += ` Current deployed commit: ${status.commit}.`;
    button.disabled = !['idle', 'succeeded', 'failed'].includes(status.state);
    button.textContent = status.state === 'queued' || status.state === 'updating' ? 'Update in progress…' : 'Update to new version';
    result.textContent = status.finishedAt ? `${status.state === 'succeeded' ? 'Last update completed' : 'Last update failed'} ${formatTime(status.finishedAt)}${status.commit ? ` · ${status.commit}` : ''}` : '';
  } catch (error) {
    const lastStatus = state.deploymentUpdateStatus;
    if (lastStatus?.state === 'queued' || lastStatus?.state === 'updating') {
      $('#deployment-update-badge').textContent = lastStatus.state.toUpperCase();
      $('#deployment-update-status').textContent = `Dashboard reconnecting during update. Last reported stage: ${lastStatus.message}`;
      $('#update-website').disabled = true;
      $('#update-website').textContent = 'Update in progress…';
      return;
    }
    $('#deployment-update-badge').textContent = 'STATUS UNAVAILABLE';
    $('#deployment-update-status').textContent = error.message;
    $('#update-website').disabled = true;
  } finally {
    if (showChecking) {
      refreshButton.disabled = false;
      refreshButton.textContent = 'Refresh status';
    }
  }
}

async function triggerWebsiteUpdate() {
  if (!confirm('Update the website from the private GitHub main branch now? The service may briefly restart. Persistent DATA_DIR and environment settings are preserved; application files are rolled back if the health check fails.')) return;
  const button = $('#update-website');
  button.disabled = true;
  $('#deployment-update-result').textContent = 'Requesting protected GitHub update…';
  try {
    const result = await api('/api/admin/deployment-update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    state.deploymentUpdateStatus = result.status;
    $('#deployment-update-status').textContent = result.status.message;
    showMessage('GitHub update queued. This page will show its progress.');
    await loadDeploymentUpdateStatus();
  } catch (error) {
    showMessage(error.message, true);
    await loadDeploymentUpdateStatus();
  }
}

async function testXIntegration() {
  if (!confirm('Publish one clearly labeled public test post to the connected X account now?')) return;
  const button = $('#test-x-integration');
  const status = $('#x-test-status');
  button.disabled = true;
  button.textContent = 'Posting test…';
  status.classList.remove('error');
  status.textContent = 'Sending test post to X…';
  try {
    const result = await api('/api/admin/x-test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    status.textContent = `${result.message} Post: ${result.url}`;
    showMessage('X integration test post published.');
  } catch (error) {
    status.classList.add('error');
    status.textContent = `X test failed: ${error.message}`;
    showMessage('X integration test failed; see its diagnostic line in Settings.', true);
  } finally {
    button.disabled = false;
    button.textContent = 'Post test message to X';
  }
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
    const triage = [...records].reverse().find((record) => record.stage === 'triage') || latest;
    const xEvent = [...records].reverse().find((record) => record.stage === 'x-publishing');
    const path = latest.workflowPath || records.map((record) => record.stage);
    const facts = [
      ['Traffic type', latest.trafficType === 'routine' ? 'Routine traffic · non-incident' : latest.trafficType === 'incident' ? 'Incident-classified call' : 'Awaiting triage classification'],
      ['Source', `${event.agency || '—'} · ${event.sourceGroup || 'Radio'} · ${event.feedBorough || '—'}`],
      ['Triage', `${latest.headline || event.headline || '—'} · ${latest.category || event.category || '—'}`],
      ['Triage confidence', typeof triage.confidence === 'number' ? `${Math.round(triage.confidence * 100)}% · ${triage.confidenceKind === 'triage-evidence-fit' ? 'transcript evidence fit, not transcription quality or incident verification' : 'legacy value; meaning was not explicitly labeled'}` : '—'],
      ['FDNY radio parser', triage.fdnyRadioAnalysis ? `${triage.fdnyRadioAnalysis.grammarVersion} · Signals: ${triage.fdnyRadioAnalysis.signals.map((signal) => signal.name).join(', ') || 'none'} · Building mentions: ${triage.fdnyRadioAnalysis.buildingMentions.map((mention) => `${mention.kind}: ${mention.value}`).join('; ') || 'none'} · Queens candidates: ${triage.fdnyRadioAnalysis.queensAddressCandidates.map((candidate) => candidate.normalized).join(', ') || 'none'} (unverified)` : 'Not recorded'],
      ['Scores', triage.scores ? `Public ${triage.scores.public}/5 · Buff ${triage.scores.buff}/5 · News ${triage.scores.newsMedia}/5` : '—'],
      ['Thresholds', triage.thresholds ? `Triage fit ${triage.thresholds.triageConfidence ?? triage.thresholds.confidence ?? '—'} · Public ${triage.thresholds.public} · Buff ${triage.thresholds.buff} · News ${triage.thresholds.newsMedia}` : '—'],
      ['Location', latest.location || event.location || 'Not stated'],
      ['Geocoding', latest.geocode ? `${latest.geocode.matched ? 'Matched' : latest.geocode.attempted ? 'No match' : 'Not attempted'}${latest.geocode.borough ? ` · ${latest.geocode.borough}` : ''}${latest.geocode.latitude ? ` · ${latest.geocode.latitude}, ${latest.geocode.longitude}` : ''}` : '—'],
      ['Correlation', latest.correlation ? `${latest.disposition || 'Decision'} · ${latest.correlation.candidateCount} candidates${latest.correlation.incidentId ? ` · ${latest.correlation.incidentId}` : ''}` : latest.disposition || '—'],
      ['Discord', latest.routing ? `${latest.routing.discordMessagesSent || 0}/${latest.routing.destinationCount ?? 0} destinations sent · ${latest.routing.eligibleSubscriptions} eligible subscriptions · ${latest.routing.sendFailures ?? 0} send failures · ${latest.routing.channelFetchFailures ?? 0} channel lookup failures` : '—'],
      ['X', xEvent ? `${xEvent.disposition || '—'}${xEvent.socialPost?.url ? ` · ${xEvent.socialPost.url}` : ''}` : 'Not attempted']
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
    if (state.isAdmin) await Promise.all([loadAdministrators(), populateWebhookAccounts()]);
    $('#pending-user-count').textContent = state.users.filter((user) => user.status === 'pending-approval' || user.status === 'pending-verification').length;
  } catch (error) { $('#users-table').innerHTML = `<tr><td colspan="6">${escapeHtml(error.message)}</td></tr>`; }
}

function renderUsers() {
  const query = $('#user-search').value.trim().toLowerCase();
  const status = $('#user-status').value;
  const users = state.users.filter((user) => (!query || `${user.username} ${user.firstName} ${user.lastName} ${user.email} ${user.accountType} ${user.newsOutlet || ''}`.toLowerCase().includes(query)) && (status === 'all' || user.status === status));
  const table = $('#users-table');
  if (!users.length) { table.innerHTML = '<tr><td colspan="6">No users match these filters.</td></tr>'; return; }
  table.innerHTML = users.map((user) => `<tr data-user-id="${escapeHtml(user.id)}"><td><div class="admin-user-cell"><strong>@${escapeHtml(user.username)}</strong><small>Private account name: ${escapeHtml(user.firstName)} ${escapeHtml(user.lastName)}</small><small>${escapeHtml(user.email)}</small><small>${escapeHtml(user.phone || '')}</small></div></td><td><span class="admin-badge">${escapeHtml(user.accountType)}</span><small>${user.usageCase ? `<br>${escapeHtml(user.usageCase)}` : ''}</small></td><td><span class="admin-badge ${escapeHtml(user.status)}">${escapeHtml(user.status)}</span>${user.webhookAccessSuspended ? '<small><br>Webhook access suspended</small>' : ''}${user.communityUpdatesSuspended ? '<small><br>Community updates suspended</small>' : ''}</td><td>${user.emailVerified ? 'Verified' : 'No'}</td><td>${escapeHtml(formatTime(user.createdAt))}</td><td><div class="admin-row-actions">${user.emailVerified && user.status !== 'approved' ? '<button class="approve" data-user-action="approved">Approve</button>' : ''}${user.status !== 'suspended' ? '<button data-user-action="suspended">Suspend</button>' : '<button data-user-action="pending-approval">Restore</button>'}<button data-webhook-access="${user.webhookAccessSuspended ? 'false' : 'true'}">${user.webhookAccessSuspended ? 'Restore hooks' : 'Suspend hooks'}</button><button data-community-updates="${user.communityUpdatesSuspended ? 'false' : 'true'}">${user.communityUpdatesSuspended ? 'Restore comments' : 'Suspend comments'}</button><button class="danger" data-user-delete="true">Delete</button></div></td></tr>`).join('');
  for (const user of users.filter((item) => item.accountType === 'news')) {
    const row = $$('[data-user-id]', table).find((item) => item.dataset.userId === user.id);
    row?.querySelector('td:nth-child(2)')?.insertAdjacentHTML('beforeend', `<small><br>News Outlet / Publication: ${escapeHtml(user.newsOutlet || 'Not provided')}</small>`);
  }
  if (state.isAdmin || state.session?.role === 'moderator') {
    for (const row of $$('[data-user-id]', table)) {
      row.querySelector('.admin-row-actions')?.insertAdjacentHTML('afterbegin', `<a class="admin-icon-button" href="/admin/user?id=${encodeURIComponent(row.dataset.userId)}" target="_blank" rel="noopener noreferrer">View User</a>`);
    }
  }
  if (state.isAdmin) {
    for (const user of users.filter((item) => !item.emailVerified && item.status === 'pending-verification')) {
      const row = $$('[data-user-id]', table).find((item) => item.dataset.userId === user.id);
      row?.querySelector('.admin-row-actions')?.insertAdjacentHTML('afterbegin', '<button type="button" data-resend-verification>Resend verification email</button>');
    }
  }
  $$('[data-resend-verification]', table).forEach((button) => button.addEventListener('click', () => resendUserVerification(button)));
  $$('[data-user-action]', table).forEach((button) => button.addEventListener('click', () => updateUser(button.closest('[data-user-id]').dataset.userId, button.dataset.userAction)));
  $$('[data-webhook-access]', table).forEach((button) => button.addEventListener('click', () => updateWebhookAccess(button.closest('[data-user-id]').dataset.userId, button.dataset.webhookAccess === 'true')));
  $$('[data-community-updates]', table).forEach((button) => button.addEventListener('click', () => updateCommunityUpdates(button.closest('[data-user-id]').dataset.userId, button.dataset.communityUpdates === 'true')));
  $$('[data-user-delete]', table).forEach((button) => button.addEventListener('click', () => deleteUser(button.closest('[data-user-id]').dataset.userId)));
}

async function updateUser(id, status) {
  try {
    const result = await api(`/api/admin/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
    showMessage(result.message || `User status set to ${status}.`, result.approvalEmail === 'failed' || result.approvalEmail === 'not-configured');
    await loadUsers();
  } catch (error) { showMessage(error.message, true); }
}

async function resendUserVerification(button) {
  if (!state.isAdmin || button.disabled) return;
  const id = button.closest('[data-user-id]').dataset.userId;
  button.disabled = true;
  button.textContent = 'Sending…';
  try {
    const result = await api(`/api/admin/accounts/${encodeURIComponent(id)}/resend-verification`, { method: 'POST' });
    showMessage(result.message);
  } catch (error) { showMessage(error.message, true); }
  finally {
    button.disabled = false;
    button.textContent = 'Resend verification email';
  }
}

async function updateWebhookAccess(id, suspended) {
  const verb = suspended ? 'suspend' : 'restore';
  if (!confirm(`${verb[0].toUpperCase()}${verb.slice(1)} all webhook access for this account?`)) return;
  try {
    await api(`/api/admin/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ webhookAccessSuspended: suspended }) });
    showMessage(`Webhook access ${suspended ? 'suspended' : 'restored'}.`);
    await loadUsers();
    await loadWebhooks();
  } catch (error) { showMessage(error.message, true); }
}

async function updateCommunityUpdates(id, suspended) {
  const verb = suspended ? 'suspend' : 'restore';
  if (!confirm(`${verb[0].toUpperCase()}${verb.slice(1)} this account's ability to add community updates?`)) return;
  try {
    await api(`/api/admin/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ communityUpdatesSuspended: suspended }) });
    showMessage(`Community updates ${suspended ? 'suspended' : 'restored'}.`);
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
    list.innerHTML = data.administrators.map((admin) => `<article class="admin-card"><div class="admin-card-meta"><span class="admin-badge ${escapeHtml(admin.status)}">${escapeHtml(admin.status)}</span><span>${admin.emailVerified ? 'Verified' : 'Unverified'}</span><span>${escapeHtml(admin.adminRole || 'admin')}</span></div><h3>@${escapeHtml(admin.username)}</h3><p>Private account name: ${escapeHtml(admin.firstName)} ${escapeHtml(admin.lastName)}</p><p>${escapeHtml(admin.email)}</p><div class="admin-card-actions"><button class="admin-icon-button danger" data-admin-revoke="${escapeHtml(admin.id)}" ${admin.id === state.session?.account?.id ? 'disabled' : ''}>Revoke access</button></div></article>`).join('');
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
  } catch (error) { showMessage(error.message, true); }
}

function canEditIncidents() {
  return state.isAdmin || state.session?.role === 'moderator';
}

function renderIncidents() {
  const query = $('#incident-search').value.trim().toLowerCase();
  const incidents = state.incidents.filter((incident) => !query || `${incident.title} ${incident.summary} ${incident.location || ''} ${incident.agency} ${incident.borough}`.toLowerCase().includes(query));
  $('#incidents-list').innerHTML = incidents.length ? incidents.map((incident) => `<article class="admin-incident-card" data-incident-id="${escapeHtml(incident.id)}"><div><div class="admin-card-meta"><span class="admin-badge">${escapeHtml(incident.agency)} · ${escapeHtml(incident.borough)}</span><span>${escapeHtml(formatTime(incident.updatedAt || incident.occurredAt))}</span><span>${escapeHtml(incident.updateCount)} updates</span></div><h3>${escapeHtml(incident.title)}</h3><p>${escapeHtml(incident.summary)}</p><p>${escapeHtml(incident.location || 'Location unconfirmed')}</p></div><div class="admin-card-actions"><a class="admin-icon-button" href="/incident/${encodeURIComponent(incident.id)}" target="_blank" rel="noopener">View</a><button class="admin-icon-button" data-edit-incident="${escapeHtml(incident.id)}">Edit</button><button class="admin-icon-button danger" data-delete-incident="${escapeHtml(incident.id)}">Delete</button></div></article>`).join('') : '<p class="admin-muted">No incidents match this search.</p>';
  $$('[data-edit-incident]').forEach((button) => button.addEventListener('click', () => openIncidentEditor(state.incidents.find((item) => item.id === button.dataset.editIncident))));
  $$('[data-delete-incident]').forEach((button) => button.addEventListener('click', () => deleteIncident(button.dataset.deleteIncident)));
  $('#pending-incident-count').textContent = state.pending.length;
  const pendingList = $('#pending-incidents-list');
  pendingList.innerHTML = state.pending.length ? state.pending.map((pending) => `<article class="admin-card"><div class="admin-card-meta"><span class="admin-badge pending-approval">PRIVATE · PENDING</span><span>${escapeHtml(pending.agency)} · ${escapeHtml(pending.borough)}</span><span>Expires ${escapeHtml(formatTime(pending.expiresAt))}</span></div><h3>${escapeHtml(pending.eventType || 'Unlocated report')}</h3><p>${escapeHtml(pending.summary)}</p>${pending.location ? `<p>Unverified location: ${escapeHtml(pending.location)}</p>` : '<p>No confidently geocoded address. Not shown publicly.</p>'}<div class="admin-card-actions"><button class="admin-icon-button approve" data-allow-pending="${escapeHtml(pending.id)}">Allow Pending</button><button class="admin-icon-button danger" data-discard-pending="${escapeHtml(pending.id)}">Discard pending</button></div></article>`).join('') : '<p class="admin-muted">No pending reports. Provisional reports persist across service restarts and remain available for two-hour reconciliation windows, extended when updated.</p>';
  $$('[data-allow-pending]').forEach((button) => button.addEventListener('click', () => allowPending(button.dataset.allowPending)));
  $$('[data-discard-pending]').forEach((button) => button.addEventListener('click', () => discardPending(button.dataset.discardPending)));
  if (!canEditIncidents()) {
    $$('[data-edit-incident], [data-delete-incident], [data-allow-pending], [data-discard-pending]').forEach((button) => { button.hidden = true; });
  }
}

function openIncidentEditor(incident) {
  if (!canEditIncidents()) return;
  const form = $('#incident-form');
  form.reset();
  form.elements.id.value = incident?.id || '';
  form.elements.headline.value = incident ? incident.title.split(' | ')[0] : '';
  form.elements.summary.value = incident?.summary || '';
  form.elements.location.value = incident?.location || '';
  form.elements.agency.value = incident?.agency || 'FDNY';
  form.elements.borough.value = incident?.borough || 'Manhattan';
  form.elements.callType.value = incident?.callType || '';
  form.elements.incidentType.value = incident?.incidentType || 'other';
  form.elements.category.value = incident?.category || 'newsworthy';
  form.elements.newsworthinessScore.value = incident?.newsworthinessScore ?? 3;
  form.elements.buffInterestScore.value = incident?.buffInterestScore ?? 3;
  form.elements.assignmentDeskScore.value = incident?.assignmentDeskScore ?? 3;
  $('#incident-editor-title').textContent = incident ? 'Edit incident' : 'Add incident';
  $('#incident-editor').showModal();
}

async function saveIncident(event) {
  event.preventDefault();
  if (!canEditIncidents()) return;
  const form = event.currentTarget;
  const submit = $('#save-incident');
  if (submit.disabled) return;
  submit.disabled = true;
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
  finally { submit.disabled = false; }
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

async function allowPending(id) {
  if (!confirm('Allow this report onto the public board without a verified location? It will not receive a map pin until a location is confirmed.')) return;
  try {
    const result = await api(`/api/admin/incidents/pending/${encodeURIComponent(id)}/allow`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    showMessage(`Pending report published as ${result.incidentId}; location remains unverified.`);
    await loadIncidents();
  } catch (error) { showMessage(error.message, true); }
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
    list.innerHTML = state.webhooks.length ? state.webhooks.map((hook) => `<article class="admin-card"><div class="admin-card-meta"><span class="admin-badge">${escapeHtml(hook.accountType)}</span><span>${escapeHtml(hook.accountEmail)}</span><span>${escapeHtml((hook.platform || 'unsupported').toUpperCase())}</span><span>${escapeHtml(hook.boroughs === 'all' ? 'All boroughs' : hook.boroughs.join(', '))}</span><span class="admin-badge ${hook.suspendedAt ? 'suspended' : ''}">${hook.suspendedAt ? 'Suspended' : 'Active'}</span></div><h3>${escapeHtml(hook.name)}</h3><p class="webhook-url">Incoming webhook URL hidden for security.</p><div class="admin-card-actions"><button data-toggle-webhook="${escapeHtml(hook.accountId)}:${escapeHtml(hook.id)}:${hook.suspendedAt ? 'false' : 'true'}">${hook.suspendedAt ? 'Resume delivery' : 'Suspend delivery'}</button><button class="admin-icon-button danger" data-delete-webhook="${escapeHtml(hook.accountId)}:${escapeHtml(hook.id)}">Delete assignment</button></div></article>`).join('') : '<p class="admin-muted">No webhook targets are assigned.</p>';
    $$('[data-delete-webhook]').forEach((button) => button.addEventListener('click', () => deleteWebhook(button.dataset.deleteWebhook)));
    $$('[data-toggle-webhook]').forEach((button) => button.addEventListener('click', () => toggleWebhook(button.dataset.toggleWebhook)));
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
    showMessage('Webhook destination saved. Qualified incident alerts are active.');
    await loadWebhooks();
  } catch (error) { showMessage(error.message, true); }
}

async function toggleWebhook(composite) {
  const [accountId, webhookId, value] = composite.split(':');
  const suspended = value === 'true';
  if (!confirm(`${suspended ? 'Suspend' : 'Resume'} delivery to this webhook?`)) return;
  try {
    await api(`/api/admin/webhooks/${encodeURIComponent(accountId)}/${encodeURIComponent(webhookId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ suspended }) });
    showMessage(`Webhook delivery ${suspended ? 'suspended' : 'resumed'}.`);
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
    renderOpenGraphPreview();
    $('#sitemap-url-value').textContent = new URL('/sitemap.xml', location.origin).href;
    $('#analytics-state').textContent = data.configured ? 'Saved in persistent server storage' : 'Settings store is unavailable';
  } catch (error) { showMessage(error.message, true); }
}

async function copySitemapUrl() {
  const sitemapUrl = new URL('/sitemap.xml', location.origin).href;
  try {
    await navigator.clipboard.writeText(sitemapUrl);
    showMessage('Sitemap URL copied.');
  } catch {
    $('#sitemap-url-value').textContent = sitemapUrl;
    showMessage('Select and copy the sitemap URL shown beside the button.');
  }
}

async function saveAnalytics(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  try {
    const data = await api('/api/admin/analytics', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
    for (const [name, value] of Object.entries(data.settings || {})) {
      const field = form.elements.namedItem(name);
      if (field && 'value' in field) field.value = value;
    }
    renderOpenGraphPreview();
    $('#analytics-state').textContent = 'Saved. Search verification meta tags are now in the page head; analytics require visitor consent.';
    showMessage('Analytics settings saved.');
  } catch (error) { showMessage(error.message, true); }
}

function renderOpenGraphPreview() {
  const form = $('#analytics-form');
  if (!form) return;
  const title = form.elements.namedItem('openGraphTitle')?.value?.trim() || 'NYC Alert — Public Safety Desk';
  const description = form.elements.namedItem('openGraphDescription')?.value?.trim()
    || 'The city never sleeps. Follow the calls, units, and action in real-time.';
  const imageValue = form.elements.namedItem('openGraphImage')?.value?.trim() || '/og-image.png';
  const image = $('#og-preview-image');
  const previewTitle = $('#og-preview-title');
  const previewDescription = $('#og-preview-description');
  if (previewTitle) previewTitle.textContent = title;
  if (previewDescription) previewDescription.textContent = description;
  if (!image) return;
  image.classList.remove('loaded');
  image.removeAttribute('src');
  if (!imageValue) return;
  try {
    const imageUrl = new URL(imageValue, location.origin);
    if (imageUrl.origin !== location.origin && imageUrl.protocol !== 'https:') return;
    image.onload = () => image.classList.add('loaded');
    image.onerror = () => image.classList.remove('loaded');
    image.src = imageUrl.href;
  } catch { /* Invalid URLs remain represented by the preview placeholder. */ }
}

async function clearAnalytics() {
  if (!confirm('Clear all saved site settings, including analytics IDs, verification tokens, Open Graph metadata, sitemap image configuration, and Above Header Code?')) return;
  try {
    await api('/api/admin/analytics', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    $('#analytics-form').reset();
    renderOpenGraphPreview();
    $('#analytics-state').textContent = 'Site settings cleared';
    $('#sitemap-url-value').textContent = new URL('/sitemap.xml', location.origin).href;
    showMessage('Site settings cleared.');
  } catch (error) { showMessage(error.message, true); }
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); }
  finally { window.location.replace('/'); }
}

void init().catch((error) => showMessage(error.message, true));
