const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = {
  incidents: [],
  latestIncidentAt: null,
  view: 'all',
  callType: 'all',
  borough: 'all',
  query: '',
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
const callTypeFor = (incident) => {
  if (['fire', 'ems', 'pd'].includes(incident.callType)) return incident.callType;
  if (incident.incidentType === 'fire') return 'fire';
  if (incident.incidentType === 'medical') return 'ems';
  if (incident.incidentType === 'police') return 'pd';
  if (incident.incidentType === 'vehicle') return incident.agency === 'FDNY' ? 'fire' : incident.agency === 'NYPD' ? 'pd' : undefined;
  return undefined;
};
const callTypeName = (type) => ({ fire: 'FIRE', ems: 'EMS', pd: 'PD' })[type] || 'UNCLASSIFIED';

function updateClock() {
  $('#mdt-clock').textContent = `${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date())} ET`;
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
  const offset = append ? state.nextOffset : 0;
  const params = new URLSearchParams({ limit: '100', offset: String(offset) });
  if (state.callType !== 'all') params.set('callType', state.callType);
  if (state.borough !== 'all') params.append('borough', state.borough);
  if (state.query) params.set('q', state.query);
  const scroll = $('#incident-stream');
  const wasAtBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 60;
  try {
    const response = await fetch(`/api/v1/incidents?${params}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Incident API returned ${response.status}`);
    const result = await response.json();
    const incidents = Array.isArray(result.data) ? result.data : [];
    const unfiltered = state.callType === 'all' && state.borough === 'all' && !state.query;
    void refreshLatestIncident(unfiltered ? incidents : undefined);
    const signature = incidentSignature(incidents);
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
    }
    state.nextOffset = offset + incidents.length;
    state.total = Number(result.page?.total) || incidents.length;
    state.hasMore = Boolean(result.page?.hasMore);
    render();
    $('#mdt-total').textContent = String(Number(result.page?.total) || incidents.length);
    $('#mdt-last-sync').textContent = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
    if (wasAtBottom || state.following) scroll.scrollTop = scroll.scrollHeight;
  } catch {
    setConnection(false);
    if (!state.incidents.length) {
      scroll.innerHTML = '<div class="stream-placeholder">Incident records are temporarily unavailable. Reconnecting…</div>';
    }
  }
}

function setConnection(online) {
  $('#mdt-connection').textContent = online ? 'LIVE CONNECTION' : 'RECONNECTING';
  $('#mdt-live-dot').classList.toggle('offline', !online);
}

function buildEntries() {
  const entries = [];
  for (const incident of state.incidents) {
    const type = callTypeFor(incident);
    entries.push({
      id: `${incident.id}:new`, incidentId: incident.id, kind: 'new', at: incident.occurredAt,
      incident, agency: incident.agency, borough: incident.borough, type,
      title: String(incident.title || 'Published incident').split(' | ')[0], summary: incident.summary,
      location: incident.location, units: incident.unitIds || [], boxes: incident.boxNumbers || []
    });
    for (const [index, update] of (incident.updates || []).entries()) {
      entries.push({
        id: `${incident.id}:update:${index}`, incidentId: incident.id, kind: 'update', at: update.occurredAt,
        incident, agency: update.agency || incident.agency, borough: incident.borough, type,
        title: update.headline || 'Incident update', summary: update.summary,
        location: update.location, previousLocation: update.previousLocation,
        units: update.unitIds || [], boxes: update.boxNumbers || []
      });
    }
  }
  return entries.sort((left, right) => Date.parse(left.at) - Date.parse(right.at) || left.id.localeCompare(right.id));
}

function render() {
  const stream = $('#incident-stream');
  const entries = buildEntries();
  const visible = entries.filter((entry) => state.view === 'all' || state.view === 'history'
    || (state.view === 'incidents' && entry.kind === 'new')
    || (state.view === 'updates' && entry.kind === 'update'));
  if (state.view === 'history') visible.reverse();
  $('#stream-title').textContent = state.view === 'updates' ? 'Incident Updates' : state.view === 'incidents' ? 'Published Incidents' : state.view === 'history' ? 'Incident History' : 'Live Incident Stream';
  $('#stream-count').textContent = `${visible.length} DISPLAYED · ${state.incidents.length} RECORDS`;
  $('#mdt-load-older').hidden = !state.hasMore;
  $('#mdt-history-position').textContent = state.incidents.length ? `SHOWING ${state.incidents.length} OF ${state.total} INCIDENT RECORDS` : '';
  $('#mdt-changes').textContent = String(state.changeCount);
  for (const type of ['all', 'fire', 'ems', 'pd']) {
    const count = type === 'all' ? state.incidents.length : state.incidents.filter((incident) => callTypeFor(incident) === type).length;
    $(`#count-${type}`).textContent = String(count);
  }
  if (!visible.length) {
    stream.innerHTML = `<div class="stream-empty">${state.query ? 'NO MATCHING PUBLISHED INCIDENTS' : 'NO INCIDENT ENTRIES IN THIS VIEW'}</div>`;
    return;
  }
  let currentDay = '';
  const markup = [];
  for (const entry of visible) {
    const day = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'long', day: '2-digit', year: 'numeric' }).format(new Date(entry.at));
    if (day !== currentDay) {
      currentDay = day;
      markup.push(`<div class="stream-date-divider">${escapeHtml(day.toUpperCase())}</div>`);
    }
    const typeMarkup = entry.type ? `<span class="entry-type ${escapeHtml(entry.type)}">${callTypeName(entry.type)}</span>` : '<span class="entry-type">UNCLASSIFIED</span>';
    const meta = [
      entry.location ? `<span class="entry-location"><strong>LOCATION</strong> ${escapeHtml(entry.location)}</span>` : '',
      entry.units.length ? `<span><strong>UNITS</strong> ${escapeHtml(entry.units.join(', '))}</span>` : '',
      entry.boxes.length ? `<span><strong>BOX</strong> ${escapeHtml(entry.boxes.join(', '))}</span>` : '',
      entry.previousLocation ? `<span><strong>PREVIOUS LOCATION</strong> ${escapeHtml(entry.previousLocation)}</span>` : ''
    ].filter(Boolean).join('');
    markup.push(`<article class="incident-entry ${entry.kind === 'update' ? 'entry-update' : ''}" data-entry-id="${escapeHtml(entry.id)}">
      <div class="entry-topline"><time class="entry-time">${escapeHtml(formatStamp(entry.at))}</time><span class="entry-kind">${entry.kind === 'new' ? 'INCIDENT' : 'UPDATE'}</span>${typeMarkup}<span class="entry-source">${escapeHtml(entry.agency)} · ${escapeHtml(entry.borough)}</span><a class="entry-open" href="/incident/${encodeURIComponent(entry.incidentId)}">OPEN RECORD ↗</a></div>
      <h2 class="entry-title">${escapeHtml(entry.title)}</h2><p class="entry-summary">${escapeHtml(entry.summary)}</p>
      ${meta ? `<div class="entry-details">${meta}</div>` : ''}</article>`);
  }
  stream.innerHTML = markup.join('');
}

async function loadOlderIncidents(event) {
  event.currentTarget.disabled = true;
  event.currentTarget.textContent = 'LOADING…';
  await loadIncidents({ append: true });
  event.currentTarget.textContent = 'LOAD OLDER INCIDENTS';
  event.currentTarget.disabled = false;
}

function connectEvents() {
  if (!('EventSource' in window)) {
    setConnection(false);
    return;
  }
  const events = new EventSource('/api/events');
  state.eventSource = events;
  events.addEventListener('open', () => setConnection(true));
  events.addEventListener('error', () => setConnection(false));
  events.addEventListener('incidents-updated', () => { void loadIncidents({ announce: true }); });
}

function wireControls() {
  $('#mdt-load-older').addEventListener('click', loadOlderIncidents);
  $$('[data-view]').forEach((button) => button.addEventListener('click', () => {
    state.view = button.dataset.view;
    $$('[data-view]').forEach((item) => {
      const selected = item === button;
      item.classList.toggle('active', selected);
      item.setAttribute('aria-pressed', String(selected));
    });
    render();
  }));
  $$('[data-call-type]').forEach((button) => button.addEventListener('click', () => {
    state.callType = button.dataset.callType;
    $$('[data-call-type]').forEach((item) => {
      const selected = item === button;
      item.classList.toggle('active', selected);
      item.setAttribute('aria-pressed', String(selected));
    });
    resetIncidentHistory();
  }));
  $('#mdt-borough').addEventListener('change', (event) => {
    state.borough = event.target.value;
    resetIncidentHistory();
  });
  $('#mdt-search').addEventListener('input', (event) => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => {
      state.query = event.target.value.trim();
      resetIncidentHistory();
    }, 180);
  });
  $('#mdt-refresh').addEventListener('click', () => { void loadIncidents({ announce: true }); });
  $('#incident-stream').addEventListener('scroll', (event) => {
    const element = event.currentTarget;
    state.following = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
  });
}

function resetIncidentHistory() {
  state.incidents = [];
  state.nextOffset = 0;
  state.total = 0;
  state.hasMore = false;
  state.lastSignature = '';
  void loadIncidents();
}

wireControls();
updateClock();
setInterval(updateClock, 1000);
updateLastIncidentAge();
setInterval(updateLastIncidentAge, 1000);
connectEvents();
void loadIncidents();
state.refreshTimer = setInterval(() => { if (document.visibilityState === 'visible') void loadIncidents({ announce: true }); }, 30_000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void loadIncidents(); });
