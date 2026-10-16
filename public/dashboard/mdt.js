const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = {
  incidents: [],
  latestIncidentAt: null,
  started: false,
  hold: false,
  hasLoadedSnapshot: false,
  view: 'dispatch',
  selectedBoroughs: null,
  selectedAgencies: null,
  authSession: null,
  authRevision: 0,
  soundEnabled: false,
  queuedAlertSequences: 0,
  audioPlaying: false,
  currentIncidentId: null,
  dispatchIncident: null,
  dispatchIncidentId: null,
  premiseResults: [],
  premiseLoadedKey: '',
  premiseLoadingKey: '',
  premiseErrorKey: '',
  xmitPrompted: false,
  xmitBusy: false,
  feedbackTimer: null,
  lastSignature: '',
  nextOffset: 0,
  total: 0,
  hasMore: false,
  changeCount: 0,
  eventSource: null,
  refreshTimer: null,
  searchTimer: null,
  following: true
};
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function updateClock() {
  $('#mdt-clock').textContent = `${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date())} ET`;
}

function formatStamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'TIME UNAVAILABLE';
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date);
}

function updateLastIncidentAge() {
  const display = $('#mdt-last-incident-age');
  if (!state.latestIncidentAt) {
    display.textContent = '—';
    display.removeAttribute('datetime');
    display.setAttribute('aria-label', 'No published incidents');
    return;
  }
  const elapsedMinutes = Math.floor(Math.max(0, Date.now() - Date.parse(state.latestIncidentAt)) / 60_000);
  display.textContent = `${elapsedMinutes} min`;
  display.dateTime = state.latestIncidentAt;
  display.setAttribute('aria-label', `${elapsedMinutes} minutes since last published incident`);
}

async function refreshLatestIncident(incidents) {
  try {
    let latestIncidents = incidents;
    if (!latestIncidents) {
      const response = await fetch('/api/v1/incidents?limit=100&offset=0', { cache: 'no-store' });
      if (!response.ok) return;
      const result = await response.json();
      latestIncidents = Array.isArray(result.data) ? result.data : [];
    }
    const timestamps = latestIncidents.map((incident) => Date.parse(incident.occurredAt)).filter(Number.isFinite);
    state.latestIncidentAt = timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null;
    updateLastIncidentAge();
  } catch {
    // Keep the last known incident time if the feed is temporarily unavailable.
  }
}

function incidentSignature(incidents) {
  return incidents.map((incident) => `${incident.id}:${incident.updatedAt}:${incident.updateCount}`).join('|');
}

async function loadIncidents({ announce = false, append = false } = {}) {
  if (!state.started || state.hold) return;
  const offset = append ? state.nextOffset : 0;
  const params = new URLSearchParams({ limit: '100', offset: String(offset) });
  if (state.selectedBoroughs !== null) {
    const boroughs = state.selectedBoroughs.filter((borough) => borough !== 'Citywide');
    if (boroughs.length) boroughs.forEach((borough) => params.append('borough', borough));
    else if (!state.selectedBoroughs.includes('Citywide')) params.set('borough', 'none');
  }
  const scroll = $('#incident-stream');
  const wasAtBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 60;
  const controller = new AbortController();
  const requestTimeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`/api/v1/incidents?${params}`, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`Incident API returned ${response.status}`);
    const result = await response.json();
    if (state.hold) return;
    const incidents = Array.isArray(result.data) ? result.data : [];
    setConnection(true);
    if (!append) void refreshLatestIncident(state.selectedBoroughs === null ? incidents : undefined);
    const signature = incidentSignature(incidents);
    if (!append && state.hasLoadedSnapshot) {
      const existingIds = new Set(state.incidents.map((incident) => incident.id));
      const newlyArrived = incidents.filter((incident) => !existingIds.has(incident.id)
        && matchesDispatchFilters(incident));
      if (newlyArrived.length) {
        if (!state.hold && state.view === 'dispatch') state.dispatchIncidentId = newlyArrived[0].id;
        handleNewIncidents(newlyArrived.length);
      }
    }
    if (announce && !append && state.lastSignature && signature !== state.lastSignature) state.changeCount += 1;
    if (append) {
      const merged = new Map(state.incidents.map((incident) => [incident.id, incident]));
      for (const incident of incidents) merged.set(incident.id, incident);
      state.incidents = [...merged.values()];
    } else {
      const currentPage = new Map(incidents.map((incident) => [incident.id, incident]));
      for (const incident of state.incidents) if (!currentPage.has(incident.id)) currentPage.set(incident.id, incident);
      state.incidents = [...currentPage.values()];
      state.lastSignature = signature;
      state.hasLoadedSnapshot = true;
      if (!state.dispatchIncidentId) state.dispatchIncidentId = incidents.find(matchesDispatchFilters)?.id ?? null;
    }
    state.nextOffset = offset + incidents.length;
    state.total = Number(result.page?.total) || incidents.length;
    state.hasMore = Boolean(result.page?.hasMore);
    render();
    $('#mdt-total').textContent = String(Number(result.page?.total) || incidents.length);
    if (wasAtBottom || state.following) scroll.scrollTop = scroll.scrollHeight;
  } catch {
    setConnection(false);
    if (!state.incidents.length) {
      $('#console-output').innerHTML = '<div class="stream-placeholder">Published incident records are temporarily unavailable. Retrying…</div>';
    }
  } finally {
    clearTimeout(requestTimeout);
  }
}

function setConnection(online) {
  $('#mdt-connection').textContent = online ? 'INCIDENT FEED READY · PUBLIC DATA' : 'FEED UNAVAILABLE · RETRYING';
  $('#mdt-connection').classList.toggle('reconnecting', !online);
}

function matchesDispatchFilters(incident) {
  const boroughMatches = !state.selectedBoroughs || state.selectedBoroughs.includes(incident.borough)
    || (incident.borough === 'Citywide' && state.selectedBoroughs.length > 0);
  const agencyMatches = !state.selectedAgencies || state.selectedAgencies.includes(incident.agency);
  return boroughMatches && agencyMatches;
}

function handleNewIncidents(count) {
  if (!state.soundEnabled) {
    showMdtFeedback(`${count} NEW INCIDENT${count === 1 ? '' : 'S'} · ARM SOUND TO HEAR ALERT`, true);
    return;
  }
  state.queuedAlertSequences = Math.min(20, state.queuedAlertSequences + count);
  void playQueuedIncidentAlerts();
}

async function playQueuedIncidentAlerts() {
  if (state.audioPlaying || !state.soundEnabled) return;
  state.audioPlaying = true;
  const audio = $('#mdt-incident-alert');
  try {
    while (state.soundEnabled && state.queuedAlertSequences > 0) {
      state.queuedAlertSequences -= 1;
      for (let play = 0; play < 4 && state.soundEnabled; play += 1) {
        audio.currentTime = 0;
        await new Promise((resolve, reject) => {
          const ended = () => { cleanup(); resolve(); };
          const paused = () => { cleanup(); resolve(); };
          const failed = () => { cleanup(); reject(new Error('The MDT incident alert audio could not be played.')); };
          const cleanup = () => {
            audio.removeEventListener('ended', ended);
            audio.removeEventListener('pause', paused);
            audio.removeEventListener('error', failed);
          };
          audio.addEventListener('ended', ended, { once: true });
          audio.addEventListener('pause', paused, { once: true });
          audio.addEventListener('error', failed, { once: true });
          audio.play().catch((error) => { cleanup(); reject(error); });
        });
      }
    }
  } catch {
    state.soundEnabled = false;
    state.queuedAlertSequences = 0;
    updateSoundControl();
    showMdtFeedback('INCIDENT ALERT AUDIO UNAVAILABLE · CHECK SOUND SETTINGS', true);
  } finally {
    state.audioPlaying = false;
    if (state.soundEnabled && state.queuedAlertSequences) void playQueuedIncidentAlerts();
  }
}

function updateSoundControl() {
  const button = $('#mdt-sound-toggle');
  button.textContent = 'IR';
  button.classList.toggle('sound-enabled', state.soundEnabled);
  button.setAttribute('aria-pressed', String(state.soundEnabled));
  button.title = state.soundEnabled ? 'IR alert sound enabled · click to disable' : 'IR alert sound disabled · click to enable';
}

async function toggleIncidentSound() {
  if (state.soundEnabled) {
    state.soundEnabled = false;
    state.queuedAlertSequences = 0;
    $('#mdt-incident-alert').pause();
    updateSoundControl();
    showMdtFeedback('INCIDENT ALERT SOUND OFF');
    return;
  }
  const audio = $('#mdt-incident-alert');
  const originalVolume = audio.volume;
  try {
    // A user gesture primes playback without an audible test tone.
    audio.volume = 0;
    await audio.play();
    audio.pause();
    audio.currentTime = 0;
    audio.volume = originalVolume;
    state.soundEnabled = true;
    updateSoundControl();
    showMdtFeedback('INCIDENT ALERT SOUND ARMED · FOUR PLAYS PER NEW INCIDENT');
  } catch {
    audio.volume = originalVolume;
    showMdtFeedback('ALERT SOUND COULD NOT BE ENABLED · CHECK AUDIO SETTINGS', true);
  }
}

function buildEntries() {
  const entries = [];
  for (const incident of state.incidents) {
    entries.push({
      id: `${incident.id}:new`, incidentId: incident.id, kind: 'new', at: incident.occurredAt,
      incident, agency: incident.agency, borough: incident.borough,
      title: String(incident.title || 'Published incident').split(' | ')[0], summary: incident.summary,
      location: incident.location, units: incident.unitIds || [], boxes: incident.boxNumbers || []
    });
    for (const [index, update] of (incident.updates || []).entries()) {
      entries.push({
        id: `${incident.id}:update:${index}`, incidentId: incident.id, kind: 'update', at: update.occurredAt,
        incident, agency: update.agency || incident.agency, borough: incident.borough,
        title: update.headline || 'Incident update', summary: update.summary,
        location: update.location, previousLocation: update.previousLocation,
        units: update.unitIds || [], boxes: update.boxNumbers || []
      });
    }
    for (const note of incident.communityNotes || []) {
      entries.push({
        id: `${incident.id}:community:${note.id}`, incidentId: incident.id, kind: 'community', at: note.createdAt,
        incident, agency: incident.agency, borough: incident.borough, author: note.username,
        audience: note.audience, title: 'COMMUNITY NOTE · UNVERIFIED', summary: note.message,
        location: '', units: [], boxes: []
      });
    }
  }
  return entries.sort((left, right) => Date.parse(left.at) - Date.parse(right.at) || left.id.localeCompare(right.id));
}

function render() {
  const stream = $('#incident-stream');
  const output = $('#console-output');
  const filterPanel = $('#message-list-config');
  const isMessageList = state.view === 'message-list';
  stream.hidden = isMessageList;
  filterPanel.hidden = !isMessageList;
  if (isMessageList) {
    state.currentIncidentId = null;
    $('#mdt-load-older').hidden = true;
    $('#stream-title').textContent = 'Message List Filters';
    updateXmitControls();
    return;
  }
  if (state.view === 'premise') {
    state.currentIncidentId = null;
    filterPanel.hidden = true;
    $('#mdt-load-older').hidden = true;
    $('#stream-title').textContent = 'Premise Info';
    renderPremiseHistory(output);
    updateXmitControls();
    return;
  }
  if (state.view === 'dispatch' && state.dispatchIncidentId) {
    const active = state.incidents.find((incident) => incident.id === state.dispatchIncidentId && matchesDispatchFilters(incident));
    if (!active) state.dispatchIncidentId = state.incidents.find(matchesDispatchFilters)?.id ?? null;
  }
  const entries = buildEntries().filter((entry) => {
    return matchesDispatchFilters(entry.incident);
  });
  let visible = entries.filter((entry) => state.view === 'history'
    || (state.view === 'incidents' && entry.kind === 'new')
    || (state.view === 'updates' && entry.kind === 'update'));
  if (state.view === 'dispatch' && state.dispatchIncidentId) {
    visible = entries.filter((entry) => entry.incidentId === state.dispatchIncidentId);
    state.dispatchIncident = state.incidents.find((incident) => incident.id === state.dispatchIncidentId) ?? null;
    state.currentIncidentId = state.dispatchIncident?.id ?? null;
  } else {
    state.currentIncidentId = null;
    if (state.view === 'dispatch') {
      state.dispatchIncident = null;
      if (!state.dispatchIncidentId) {
        const first = state.incidents.find(matchesDispatchFilters);
        if (first) {
          state.dispatchIncidentId = first.id;
          state.dispatchIncident = first;
          state.currentIncidentId = first.id;
          visible = entries.filter((entry) => entry.incidentId === first.id);
        }
      }
    }
  }
  if (!visible.length) {
    state.currentIncidentId = null;
    updateXmitControls();
  }
  if (state.view === 'history') visible.reverse();
  $('#stream-title').textContent = state.view === 'updates' ? 'Staging / Updates' : state.view === 'incidents' ? 'Premise Info' : state.view === 'history' ? 'Command History' : 'Dispatch Info';
  $('#stream-count').textContent = `${visible.length} DISPLAYED · ${state.incidents.length} RECORDS`;
  $('#mdt-load-older').hidden = !state.hasMore || state.view === 'dispatch';
  $('#mdt-history-position').textContent = state.incidents.length ? `SHOWING ${state.incidents.length} OF ${state.total} INCIDENT RECORDS` : '';
  $('#mdt-changes').textContent = String(state.changeCount);
  if (!visible.length) {
    output.innerHTML = '<div class="stream-empty">NO MATCHING PUBLISHED INCIDENTS</div>';
    updateXmitControls();
    return;
  }
  let currentDay = '';
  const markup = [];
  if (state.view === 'dispatch') {
    markup.push(`<div class="dispatch-mode-notice ${state.hold ? 'hold-active' : ''}">${state.hold ? 'HOLD ACTIVE · CURRENT CALL FROZEN · NEW CALLS QUEUED' : 'HOLD OFF · NEXT NEW CALL REPLACES THIS DISPLAY'}</div>`);
  }
  for (const entry of visible) {
    const day = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'long', day: '2-digit', year: 'numeric' }).format(new Date(entry.at));
    if (day !== currentDay) {
      currentDay = day;
      markup.push(`<div class="stream-date-divider">${escapeHtml(day.toUpperCase())}</div>`);
    }
    const meta = [
      entry.location ? `<span class="entry-location"><strong>LOCATION</strong> ${escapeHtml(entry.location)}</span>` : '',
      entry.units.length ? `<span><strong>UNITS</strong> ${escapeHtml(entry.units.join(', '))}</span>` : '',
      entry.boxes.length ? `<span><strong>BOX</strong> ${escapeHtml(entry.boxes.map((box) => box.replace(/^BOX(?:\s*(?:#|NO\.?)?)?\s*/i, '')).join(', '))}</span>` : '',
      entry.previousLocation ? `<span><strong>PREVIOUS LOCATION</strong> ${escapeHtml(entry.previousLocation)}</span>` : ''
    ].filter(Boolean).join('');
    if (entry.kind === 'community') {
      const audienceLabel = entry.audience === 'buff' ? 'BUFF' : 'NEWS MEDIA';
      markup.push(`<article class="incident-entry entry-community-note" data-entry-id="${escapeHtml(entry.id)}">
        <div class="entry-topline"><time class="entry-time">${escapeHtml(formatStamp(entry.at))}</time><strong class="community-note-author">@${escapeHtml(entry.author)}</strong><span class="community-note-warning">COMMUNITY · UNVERIFIED</span></div>
        <p class="entry-summary">${escapeHtml(entry.summary)} <span class="community-note-role ${entry.audience === 'buff' ? 'buff' : 'news'}">${audienceLabel}</span></p></article>`);
      continue;
    }
    markup.push(`<article class="incident-entry ${entry.kind === 'update' ? 'entry-update' : ''}" data-entry-id="${escapeHtml(entry.id)}">
      <div class="entry-topline"><time class="entry-time">${escapeHtml(formatStamp(entry.at))}</time><span class="entry-kind">${entry.kind === 'new' ? 'INCIDENT' : 'UPDATE'}</span><span class="entry-source">${escapeHtml(entry.agency)} · ${escapeHtml(entry.borough)}</span><a class="entry-open" href="/incident/${encodeURIComponent(entry.incidentId)}">OPEN RECORD ↗</a></div>
      <h2 class="entry-title">${escapeHtml(entry.title)}</h2><p class="entry-summary">${escapeHtml(entry.summary)}</p>
      ${meta ? `<div class="entry-details">${meta}</div>` : ''}</article>`);
  }
  output.innerHTML = markup.join('');
  updateXmitControls();
}

function normalizePremiseLocation(value) {
  return String(value ?? '').replace(/\s*,?\s+between\b.*$/i, '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function premiseLookupKey(incident) {
  return incident?.id && incident.location ? `${incident.id}|${normalizePremiseLocation(incident.location)}` : '';
}

function renderPremiseHistory(output) {
  const current = state.dispatchIncident;
  if (!current) {
    output.innerHTML = '<div class="stream-empty">OPEN DISPATCH INFO AND SELECT A CALL FIRST</div>';
    return;
  }
  const key = premiseLookupKey(current);
  if (!key) {
    output.innerHTML = '<div class="stream-empty">NO ADDRESS IN CURRENT CALL · PREMISE HISTORY UNAVAILABLE</div>';
    return;
  }
  if (state.premiseLoadingKey !== key && state.premiseLoadedKey !== key) void loadPremiseHistory(current, key);
  if (state.premiseLoadingKey === key) {
    output.innerHTML = `<div class="stream-empty">SEARCHING PUBLIC INCIDENT RECORDS · ${escapeHtml(current.location)}</div>`;
    return;
  }
  if (state.premiseLoadedKey !== key) return;
  const matches = state.premiseResults;
  const header = `<div class="premise-heading"><span>PUBLIC INCIDENT HISTORY · ADDRESS MATCH</span><strong>${escapeHtml(current.location)}</strong><small>Current call: ${escapeHtml(current.agency)} · ${escapeHtml(current.borough)} · ${escapeHtml(formatStamp(current.occurredAt))}</small></div>`;
  if (state.premiseErrorKey === key) {
    output.innerHTML = `${header}<div class="stream-empty">PUBLIC INCIDENT HISTORY UNAVAILABLE</div>`;
    return;
  }
  if (!matches.length) {
    output.innerHTML = `${header}<div class="stream-empty">NO EARLIER PUBLISHED INCIDENTS FOUND AT THIS EXACT LOCATION</div>`;
    return;
  }
  output.innerHTML = `${header}${matches.map((incident) => `<article class="incident-entry premise-entry" data-premise-id="${escapeHtml(incident.id)}">
    <div class="entry-topline"><time class="entry-time">${escapeHtml(formatStamp(incident.occurredAt))}</time><span class="entry-kind">PRIOR INCIDENT</span><span class="entry-source">${escapeHtml(incident.agency)} · ${escapeHtml(incident.borough)}</span><a class="entry-open" href="/incident/${encodeURIComponent(incident.id)}">OPEN RECORD ↗</a></div>
    <h2 class="entry-title">${escapeHtml(String(incident.title || 'Published incident').split(' | ')[0])}</h2><p class="entry-summary">${escapeHtml(incident.summary)}</p>
    ${incident.updates?.length ? `<details class="premise-updates"><summary>${incident.updates.length} recorded update${incident.updates.length === 1 ? '' : 's'}</summary>${incident.updates.map((update) => `<p><time>${escapeHtml(formatStamp(update.occurredAt))}</time> · ${escapeHtml(update.agency || incident.agency)} · ${escapeHtml(update.summary)}</p>`).join('')}</details>` : ''}
  </article>`).join('')}`;
}

async function loadPremiseHistory(current, key) {
  state.premiseLoadingKey = key;
  state.premiseErrorKey = '';
  state.premiseResults = [];
  renderPremiseHistory($('#console-output'));
  const addressQuery = current.location.split(/\s*,?\s+between\b/i, 1)[0].trim();
  const params = new URLSearchParams({ q: addressQuery, limit: '100', offset: '0' });
  if (current.borough !== 'Citywide') params.append('borough', current.borough);
  try {
    const response = await fetch(`/api/v1/incidents?${params}`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Incident API returned ${response.status}`);
    const result = await response.json();
    if (premiseLookupKey(state.dispatchIncident) !== key) return;
    const currentTime = Date.parse(current.occurredAt);
    state.premiseResults = (Array.isArray(result.data) ? result.data : [])
      .filter((incident) => incident.id !== current.id
        && normalizePremiseLocation(incident.location) === normalizePremiseLocation(current.location)
        && Date.parse(incident.occurredAt) < currentTime
        && (!state.selectedAgencies || state.selectedAgencies.includes(incident.agency)))
      .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt));
    state.premiseLoadedKey = key;
  } catch {
    if (premiseLookupKey(state.dispatchIncident) !== key) return;
    state.premiseResults = [];
    state.premiseLoadedKey = key;
    state.premiseErrorKey = key;
  } finally {
    if (state.premiseLoadingKey === key) state.premiseLoadingKey = '';
    if (state.view === 'premise' && premiseLookupKey(state.dispatchIncident) === key) renderPremiseHistory($('#console-output'));
  }
}

async function loadOlderIncidents(event) {
  event.currentTarget.disabled = true;
  event.currentTarget.textContent = 'LOADING…';
  await loadIncidents({ append: true });
  event.currentTarget.textContent = 'LOAD OLDER INCIDENTS';
  event.currentTarget.disabled = false;
}

function connectEvents() {
  if (!('EventSource' in window)) return;
  const events = new EventSource('/api/events');
  state.eventSource = events;
  // EventSource can reconnect independently; the incident API response determines feed status.
  events.addEventListener('incidents-updated', () => { void loadIncidents({ announce: true }); });
}

function wireControls() {
  $('#mdt-load-older').addEventListener('click', loadOlderIncidents);
  $('#mdt-zoom').addEventListener('click', () => $('#mdt-workspace').classList.toggle('zoomed'));
  $('#mdt-prev-entry').addEventListener('click', () => $('#incident-stream').scrollBy({ top: -$('#incident-stream').clientHeight, behavior: 'smooth' }));
  $('#mdt-clear-screen').addEventListener('click', () => {
    $('#console-output').replaceChildren();
    $('#mdt-load-older').hidden = true;
  });
  $('#mdt-hold').addEventListener('click', () => {
    state.hold = !state.hold;
    const button = $('#mdt-hold');
    button.classList.toggle('active', state.hold);
    button.setAttribute('aria-pressed', String(state.hold));
    button.setAttribute('aria-label', state.hold ? 'Hold active: pause new incident updates' : 'Hold inactive: receive incident updates');
    render();
    if (!state.hold) void loadIncidents({ announce: true });
  });
  $('#mdt-sound-toggle').addEventListener('click', () => { void toggleIncidentSound(); });
  $('#mdt-logon').addEventListener('click', openLogonModal);
  $('#mdt-logon-close').addEventListener('click', closeLogonModal);
  $('#mdt-logon-modal').addEventListener('click', (event) => {
    if (event.target === $('#mdt-logon-modal')) closeLogonModal();
  });
  $('#mdt-login-form').addEventListener('submit', submitMdtLogin);
  $('#mdt-xmit-form').addEventListener('submit', submitCommunityNote);
  $$('[data-view]').forEach((button) => button.addEventListener('click', () => {
    state.view = button.dataset.view;
    $$('[data-view]').forEach((item) => {
      const selected = item === button;
      item.classList.toggle('active', selected);
      item.setAttribute('aria-pressed', String(selected));
    });
    if (state.view === 'message-list') syncMessageFilterForm();
    render();
  }));
  $('#mdt-message-filter-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const boroughs = [...form.querySelectorAll('input[name="borough"]:checked')].map((input) => input.value);
    const agencies = [...form.querySelectorAll('input[name="agency"]:checked')].map((input) => input.value);
    state.selectedBoroughs = boroughs.length === 6 ? null : boroughs;
    state.selectedAgencies = agencies.length === 2 ? null : agencies;
    state.hasLoadedSnapshot = false;
    try {
      localStorage.setItem('nyc-alert-mdt-message-filters', JSON.stringify({ boroughs: state.selectedBoroughs, agencies: state.selectedAgencies }));
    } catch { /* Retain filters for this page session if storage is unavailable. */ }
    state.view = 'dispatch';
    if (!state.hold && state.started) {
      state.incidents = [];
      state.nextOffset = 0;
      state.total = 0;
      state.hasMore = false;
      state.lastSignature = '';
      state.hasLoadedSnapshot = false;
      state.dispatchIncidentId = null;
      state.dispatchIncident = null;
    }
    $$('[data-view]').forEach((item) => {
      const selected = item.dataset.view === 'dispatch';
      item.classList.toggle('active', selected);
      item.setAttribute('aria-pressed', String(selected));
    });
    render();
    if (!state.hold && state.started) void loadIncidents();
  });
  $('#mdt-all-boroughs').addEventListener('change', (event) => {
    $('#mdt-message-filter-form').querySelectorAll('input[name="borough"]').forEach((input) => { input.checked = event.currentTarget.checked; });
  });
  $('#mdt-all-agencies').addEventListener('change', (event) => {
    $('#mdt-message-filter-form').querySelectorAll('input[name="agency"]').forEach((input) => { input.checked = event.currentTarget.checked; });
  });
  $('#mdt-message-filter-form').querySelectorAll('input[name="borough"],input[name="agency"]').forEach((input) => input.addEventListener('change', updateAllFilterCheckboxes));
  $('#mdt-refresh').addEventListener('click', () => $('#mdt-xmit-form').requestSubmit());
  $('#incident-stream').addEventListener('scroll', (event) => {
    const element = event.currentTarget;
    state.following = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
  });
}

function syncMessageFilterForm() {
  const form = $('#mdt-message-filter-form');
  const allBoroughs = state.selectedBoroughs === null;
  const allAgencies = state.selectedAgencies === null;
  form.querySelectorAll('input[name="borough"]').forEach((input) => {
    input.checked = allBoroughs || state.selectedBoroughs.includes(input.value);
  });
  form.querySelectorAll('input[name="agency"]').forEach((input) => {
    input.checked = allAgencies || state.selectedAgencies.includes(input.value);
  });
  $('#mdt-all-boroughs').checked = allBoroughs;
  $('#mdt-all-agencies').checked = allAgencies;
}

function updateAllFilterCheckboxes() {
  const form = $('#mdt-message-filter-form');
  $('#mdt-all-boroughs').checked = [...form.querySelectorAll('input[name="borough"]')].every((input) => input.checked);
  $('#mdt-all-agencies').checked = [...form.querySelectorAll('input[name="agency"]')].every((input) => input.checked);
}

async function loadMdtSession() {
  const revision = state.authRevision;
  try {
    const response = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) return;
    const result = await response.json();
    if (revision !== state.authRevision) return;
    state.authSession = result.session;
  } catch {
    if (revision !== state.authRevision) return;
    state.authSession = null;
  }
  updateXmitControls();
}

function updateXmitControls() {
  const account = state.authSession?.account;
  const canSubmit = state.authSession?.kind === 'user' && ['buff', 'news'].includes(account?.accountType);
  const enabled = Boolean(canSubmit && state.currentIncidentId && state.view === 'dispatch' && !state.xmitBusy);
  const messageInput = $('#mdt-community-message');
  const showComposer = canSubmit
    ? Boolean(state.currentIncidentId && state.view === 'dispatch')
    : state.xmitPrompted;
  messageInput.hidden = !showComposer;
  messageInput.disabled = !enabled;
  $('.mdt-status').classList.toggle('composer-visible', showComposer);
  messageInput.placeholder = canSubmit ? 'TYPE COMMUNITY NOTE…' : 'LOGON TO XMIT A COMMUNITY NOTE';
  $('#mdt-xmit').disabled = state.xmitBusy;
  $('#mdt-logon').textContent = 'LOGON';
  $('#mdt-logon').title = state.authSession?.account?.username ? `Signed in as @${state.authSession.account.username}` : 'Log in';
}

function showMdtFeedback(message, isError = false) {
  const feedback = $('#mdt-xmit-feedback');
  feedback.textContent = message;
  feedback.classList.toggle('error', isError);
  if (state.feedbackTimer) clearTimeout(state.feedbackTimer);
  if (message) state.feedbackTimer = setTimeout(() => { feedback.textContent = ''; }, 7000);
}

function openLogonModal() {
  $('#mdt-logon-modal').hidden = false;
  $('#mdt-login-feedback').textContent = '';
  $('#mdt-login-form').elements.namedItem('email').focus();
}

function closeLogonModal() {
  $('#mdt-logon-modal').hidden = true;
}

async function submitMdtLogin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');
  const feedback = $('#mdt-login-feedback');
  submit.disabled = true;
  feedback.textContent = 'Signing in…';
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(new FormData(form)))
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Could not log in.');
    state.authRevision += 1;
    state.authSession = result.session;
    state.xmitPrompted = false;
    closeLogonModal();
    updateXmitControls();
    const account = state.authSession?.account;
    if (state.authSession?.kind !== 'user' || !['buff', 'news'].includes(account?.accountType)) {
      showMdtFeedback('LOGGED IN · XMIT REQUIRES BUFF OR NEWS MEDIA ACCESS', true);
    } else {
      showMdtFeedback(`LOGGED ON · @${account.username} · ${account.accountType === 'buff' ? 'BUFF' : 'NEWS MEDIA'}`);
    }
    if (state.started) render();
  } catch (error) {
    feedback.textContent = error instanceof Error ? error.message : 'Could not log in.';
  } finally {
    submit.disabled = false;
  }
}

async function logoutFromMdt() {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  } catch {
    // Clear local XMIT access even if the session has already expired.
  } finally {
    state.authRevision += 1;
    state.authSession = null;
    state.xmitPrompted = false;
    updateXmitControls();
    showMdtFeedback('LOGGED OFF');
  }
}

async function submitCommunityNote(event) {
  event.preventDefault();
  const messageField = $('#mdt-community-message');
  const message = messageField.value.trim();
  if (!state.authSession) {
    state.xmitPrompted = true;
    updateXmitControls();
    showMdtFeedback('LOGON REQUIRED · USE THE LOGON KEY');
    return;
  }
  if (state.authSession.kind !== 'user' || !['buff', 'news'].includes(state.authSession.account?.accountType)) {
    showMdtFeedback('BUFF OR NEWS MEDIA ACCESS REQUIRED TO XMIT', true);
    return;
  }
  if (!state.currentIncidentId || state.view !== 'dispatch') {
    showMdtFeedback('OPEN DISPATCH INFO AND SELECT AN INCIDENT BEFORE XMIT', true);
    return;
  }
  if (!message) {
    state.xmitPrompted = true;
    updateXmitControls();
    showMdtFeedback('TYPE A COMMUNITY NOTE, THEN PRESS XMIT');
    if (!messageField.disabled) messageField.focus();
    return;
  }
  const incidentId = state.currentIncidentId;
  state.xmitBusy = true;
  updateXmitControls();
  try {
    const response = await fetch(`/api/account/incidents/${encodeURIComponent(incidentId)}/community-notes`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Could not XMIT community note.');
    const incident = state.incidents.find((item) => item.id === incidentId);
    if (incident) {
      const notes = incident.communityNotes || [];
      if (!notes.some((note) => note.id === result.note.id)) incident.communityNotes = [...notes, result.note];
      render();
    }
    messageField.value = '';
    showMdtFeedback('NOTE SAVED · PUBLIC COMMUNITY CONTRIBUTION · UNVERIFIED · NOT SENT TO AGENCY');
  } catch (error) {
    showMdtFeedback(error instanceof Error ? error.message : 'Could not XMIT community note.', true);
  } finally {
    state.xmitBusy = false;
    updateXmitControls();
  }
}

try {
  const savedFilters = JSON.parse(localStorage.getItem('nyc-alert-mdt-message-filters') || 'null');
  if (savedFilters && (Array.isArray(savedFilters.boroughs) || savedFilters.boroughs === null)
    && (Array.isArray(savedFilters.agencies) || savedFilters.agencies === null)) {
    state.selectedBoroughs = savedFilters.boroughs;
    state.selectedAgencies = savedFilters.agencies;
  }
} catch { /* Use all boroughs and agencies when saved settings cannot be read. */ }

wireControls();
void loadMdtSession();
updateClock();
setInterval(updateClock, 1000);
updateLastIncidentAge();
setInterval(updateLastIncidentAge, 1000);
const startupDelayMs = 3000 + Math.floor(Math.random() * 2001);
setTimeout(() => {
  state.started = true;
  $('#mdt-connection').textContent = 'CONNECTING TO INCIDENT FEED…';
  connectEvents();
  void loadIncidents();
  state.refreshTimer = setInterval(() => { if (!state.hold && document.visibilityState === 'visible') void loadIncidents({ announce: true }); }, 30_000);
}, startupDelayMs);
document.addEventListener('visibilitychange', () => {
  if (state.started && !state.hold && document.visibilityState === 'visible') void loadIncidents();
});
