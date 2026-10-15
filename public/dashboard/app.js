const state = {
  agency: 'all', query: '', view: 'incidents', sortMode: 'smart', liveCategories: null, feeds: [], incidents: [], calls: [], pipelines: {},
  refreshPaused: false, incidentIds: new Set(), incidentUpdateCounts: new Map(), firstIncidentLoad: true, announcedIds: new Set(), freshIncidentIds: new Map(),
  pageStartedAt: Date.now(),
  tickerQueue: [], tickerActive: false, tickerIndex: 0, tickerRotationTimer: null, tickerOverrideTimer: null,
  tickerFeaturedIncident: null, tickerFeaturedUntil: 0, tickerFeaturedTimer: null,
  map: null, mapLayer: null, mapMarkers: new Map(), mapHasFitBounds: false, mapTimer: null, mapExpiryTimer: null, mapEvents: null,
  mapRefreshTimer: null, mapRefreshSequence: 0, liveUpdates: null, authSession: null, pendingAudience: null,
  preferenceSaveTimer: null, preferenceSaveQueue: Promise.resolve(), applyingPreferences: false, presenceTimer: null
};
const voteDeviceId = getVoteDeviceId();
const presenceBrowserToken = getPresenceBrowserToken();
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const boroughCode = (borough) => ({ Manhattan: 'MH', Bronx: 'BX', Queens: 'QN', Brooklyn: 'BK', 'Staten Island': 'SI', Citywide: 'CW' })[borough] || borough;
const categoryLabel = (category) => String(category ?? 'routine').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
const boroughNames = ['Manhattan', 'Queens', 'Brooklyn', 'Bronx', 'Staten Island'];
const boroughParams = new URLSearchParams(location.search);
const requestedBoroughs = boroughParams.getAll('borough');
state.audience = ['public', 'buff', 'news'].includes(new URLSearchParams(location.search).get('audience'))
  ? new URLSearchParams(location.search).get('audience')
  : 'public';
state.boroughs = !boroughParams.has('borough')
  ? new Set(boroughNames)
  : requestedBoroughs.includes('none')
    ? new Set()
    : new Set(requestedBoroughs.filter((borough) => boroughNames.includes(borough)));

function initializeBoroughPage() {
  const allBoroughsSelected = state.boroughs.size === boroughNames.length;
  document.querySelectorAll('.borough-tab').forEach((tab) => {
    const selected = state.boroughs.has(tab.dataset.borough);
    tab.classList.toggle('active', selected);
    tab.classList.toggle('inactive', !selected);
    tab.setAttribute('aria-pressed', String(selected));
  });
  const allOn = $('#borough-reset');
  allOn.classList.toggle('active', allBoroughsSelected);
  allOn.setAttribute('aria-pressed', String(allBoroughsSelected));
  const selected = [...state.boroughs];
  const label = selected.length === 0 ? 'No boroughs selected' : selected.length === boroughNames.length ? 'New York City' : selected.length === 1 ? selected[0] : `${selected.length} boroughs`;
  $('#page-eyebrow').textContent = `NYCALERT.AI · ${label.toUpperCase()}`;
  $('#page-description').textContent = selected.length === boroughNames.length
    ? 'The city never sleeps. Follow the calls, units, and action in real-time.'
    : selected.length ? `The city never sleeps. Follow the calls, units, and action in ${selected.join(', ')} in real-time.` : 'Turn on a borough to follow its calls, units, and action in real-time.';
  $('#incident-map-title').textContent = selected.length === 1 ? `${selected[0]} Incident Map` : selected.length ? 'Incident Map · Selected Boroughs' : 'Incident Map';
  $('#map-description').textContent = selected.length === 1
    ? `Incidents placed in ${selected[0]} during the last 30 minutes.`
    : 'Pins show approximate locations only when an address or cross street can be matched.';
  document.title = selected.length === 1 ? `NYC Alert — ${selected[0]}` : 'NYC Alert — Public Safety Desk';
}

function initializeAudienceView() {
  document.querySelectorAll('.audience-tab').forEach((button) => {
    const selected = button.dataset.audience === state.audience;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  document.body.dataset.audience = state.audience;
}

function setAudienceView(audience) {
  const selected = ['public', 'buff', 'news'].includes(audience) ? audience : 'public';
  if (selected !== 'public' && !canViewAudience(selected)) {
    state.pendingAudience = selected;
    state.audience = 'public';
    persistAudienceSelection();
    initializeAudienceView();
    renderIncidents();
    renderLiveCalls();
    openAuthModal('login', state.authSession ? `Your account does not have access to the ${selected === 'buff' ? 'Buff' : 'News Media'} view.` : `Log in or register for the ${selected === 'buff' ? 'Buff' : 'News Media'} view.`);
    return;
  }
  state.audience = selected;
  persistAudienceSelection();
  saveDashboardPreferences();
  initializeAudienceView();
  renderIncidents();
  renderLiveCalls();
}

function persistAudienceSelection() {
  const params = new URLSearchParams(location.search);
  if (state.audience === 'public') params.delete('audience');
  else params.set('audience', state.audience);
  const query = params.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
}

function canViewAudience(audience) {
  if (state.authSession?.kind === 'admin') return true;
  const account = state.authSession?.account;
  return Boolean(account && account.status === 'approved' && account.accountType === audience);
}

function persistBoroughSelection() {
  const params = new URLSearchParams(location.search);
  params.delete('borough');
  if (state.boroughs.size === 0) params.append('borough', 'none');
  else if (state.boroughs.size < boroughNames.length) {
    for (const borough of boroughNames) if (state.boroughs.has(borough)) params.append('borough', borough);
  }
  const query = params.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
}

function boroughQueryParams(params) {
  if (state.boroughs.size === 0) params.append('borough', 'none');
  else if (state.boroughs.size < boroughNames.length) {
    for (const borough of boroughNames) if (state.boroughs.has(borough)) params.append('borough', borough);
  }
  return params;
}

function refreshBoroughView() {
  initializeBoroughPage();
  persistBoroughSelection();
  renderIncidents();
  renderLiveCalls();
  renderFeeds();
  saveDashboardPreferences();
  void refresh();
  void refreshMap();
}

function updateClock() {
  const now = new Date();
  $('#clock').textContent = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now) + ' ET';
  $('#date-label').textContent = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: '2-digit' }).format(now).toUpperCase();
}

function renderFeeds() {
  $('#feed-list').innerHTML = state.feeds
    .filter((feed) => state.boroughs.size > 0 && (feed.borough === 'Citywide' || state.boroughs.has(feed.borough)))
    .map((feed) => {
    const isFdny = feed.agency === 'FDNY';
    const activityAt = isFdny ? feed.lastActivityAt : feed.lastStreamDataAt;
    const stateLabel = feed.state === 'online' ? 'ONLINE'
      : feed.state === 'offline' ? 'OFFLINE' : 'NOT MONITORED';
    const activityText = activityAt ? `${isFdny ? 'Call' : 'Audio'} ${escapeHtml(timeAgo(activityAt))}` : isFdny ? 'No calls yet' : 'No audio yet';
    const latestActivityAge = activityAt ? Date.now() - Date.parse(activityAt) : Number.POSITIVE_INFINITY;
    const syntheticWaveActive = feed.meterSource === 'call-activity' && latestActivityAge >= 0 && latestActivityAge < 20_000;
    const meterLevels = feed.meterSource === 'pcm'
      ? feed.audioLevels
      : syntheticWaveActive ? buildSyntheticCallWave(feed.id, Date.now()) : feed.callActivityLevels;
    const meterLabel = feed.meterSource === 'pcm'
      ? 'LIVE AUDIO LEVEL · PCM'
      : syntheticWaveActive ? 'FDNY call-activity animation; not an audio-level measurement' : 'FDNY call activity; not an audio-level measurement';
    const alertActive = feed.alertUntil && Date.parse(feed.alertUntil) > Date.now();
    const alertSeverity = alertActive ? feed.alertSeverity : undefined;
    const alertClass = alertSeverity === 'breaking' ? ' feed-alert-breaking' : alertSeverity === 'newsworthy' ? ' feed-alert-newsworthy' : '';
    const bars = (Array.isArray(meterLevels) ? meterLevels : Array.from({ length: 40 }, () => 0)).slice(-40);
    const meter = bars.map((level) => `<span class="feed-meter-bar" style="--meter-level:${Math.round(Math.max(0, Math.min(1, Number(level) || 0)) * 100)}%"></span>`).join('');
    return `
    <article class="feed-card${alertClass}"${alertSeverity ? ` data-alert-severity="${alertSeverity}"` : ''}>
      <div class="feed-top"><span class="agency-tag ${feed.agency === 'NYPD' ? 'nypd' : ''}">${escapeHtml(feed.agency)}</span><span class="feed-state ${escapeHtml(feed.state)}"><i class="health-dot ${escapeHtml(feed.state)}"></i>${stateLabel}</span></div>
      <div class="feed-name">${escapeHtml(feed.name)}</div>
      <div class="feed-location">${escapeHtml(feed.borough)}</div>
      <div class="feed-meter-wrap"><div class="feed-meter${syntheticWaveActive ? ' feed-meter-active' : ''}" role="img" aria-label="${meterLabel}">${meter}</div>${feed.meterSource === 'pcm' ? `<span class="feed-meter-label">${meterLabel}</span>` : ''}</div>
      <div class="feed-metrics"><div class="feed-metric"><span>CALLS SEEN</span><strong>${Number(feed.callsSeen) || 0}</strong></div><div class="feed-metric"><span>${isFdny ? 'LAST CALL' : 'LAST AUDIO'}</span><strong class="${activityAt && isRecent(activityAt) ? 'recent' : ''}">${activityText}</strong></div></div>
      ${feed.lastError ? `<span class="feed-error">${escapeHtml(feed.lastError)}</span>` : ''}
    </article>`;
  }).join('');
}

function buildSyntheticCallWave(seedValue, now = Date.now()) {
  const seed = [...String(seedValue)].reduce((value, character) => (value * 31 + character.charCodeAt(0)) >>> 0, 7);
  const phase = Math.floor(now / 220) * 0.73 + seed % 97;
  return Array.from({ length: 40 }, (_, index) => {
    const noise = Math.abs(Math.sin((seed % 997 + index * 73.1 + phase) * 12.9898));
    const envelope = 0.16 + 0.84 * Math.abs(Math.sin(index * 0.39 + phase));
    return 0.08 + noise * envelope * 0.72;
  });
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'TIME UNAVAILABLE';
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date) + ' ET';
}

function timeAgo(value) {
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  if (!Number.isFinite(elapsed)) return 'time unavailable';
  const minutes = Math.floor(elapsed / 60000);
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`;
}

function isRecent(value) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp <= Date.now() && Date.now() - timestamp <= 30 * 60 * 1000;
}

function renderIncidents() {
  const visible = state.incidents
    .filter((incident) => state.boroughs.has(incident.borough) || (state.boroughs.size > 0 && incident.borough === 'Citywide'))
    .filter((incident) => state.agency === 'all' || (incident.agencies?.includes(state.agency) ?? incident.agency === state.agency))
    .sort(compareIncidents);
  $('#incident-count').textContent = String(visible.length).padStart(2, '0');
  if (!visible.length) {
    $('#incident-list').innerHTML = `<div class="empty-state"><span class="empty-symbol">⌁</span><strong>${state.query ? 'No matching incidents' : 'All quiet on the board'}</strong><p>${state.query ? 'Try another search or clear the active filters.' : 'Qualified incidents will appear here when reviewed and published.'}</p><span class="empty-foot">NO ROUTINE CALLS SHOWN</span></div>`;
    return;
  }
  const unitSearch = detectUnitSearch(state.query);
  const unitHistoryBanner = unitSearch
    ? `<div class="unit-history-banner"><strong>UNIT CALL HISTORY · ${escapeHtml(unitSearch)}</strong><span>Incidents and updates where radio traffic explicitly identified this unit. Station rosters do not imply attendance.</span></div>`
    : '';
  $('#incident-list').innerHTML = unitHistoryBanner + visible.map((incident) => {
    const newsScore = Math.round(Math.max(1, Math.min(5, Number(incident.newsworthinessScore) || 1)));
    const buffScore = Math.round(Math.max(1, Math.min(5, Number(incident.buffInterestScore) || newsScore)));
    const deskScore = Math.round(Math.max(1, Math.min(5, Number(incident.assignmentDeskScore) || newsScore)));
    const audienceScore = state.audience === 'buff' ? buffScore : state.audience === 'news' ? deskScore : newsScore;
    const isBreaking = newsScore === 5;
      const presentation = newsScore >= 5 ? 'BREAKING' : newsScore >= 4 ? 'DEVELOPING' : newsScore >= 3 ? 'INCIDENT' : newsScore >= 2 ? 'ACTIVITY' : 'NONE';
    return `
    <article class="incident-card category-${isBreaking ? 'breaking' : 'newsworthy'} ${state.freshIncidentIds.has(incident.id) && state.freshIncidentIds.get(incident.id) > Date.now() ? 'is-new-incident' : ''}">
      <div class="incident-meta"><span class="category-tag ${isBreaking ? 'breaking' : newsScore >= 4 ? 'developing' : 'newsworthy'}">${presentation}</span><span class="borough-tag">${escapeHtml((incident.agencies?.length ? incident.agencies : [incident.agency]).join(' + '))} · ${escapeHtml(boroughCode(incident.borough))}</span><time class="incident-time">${escapeHtml(formatTime(incident.occurredAt))}</time></div>
      <h3>${escapeHtml(incident.title)}</h3><p>${escapeHtml(incident.summary)}</p>
      ${incident.communitySelected ? '<p class="community-selected-note">COMMUNITY SELECTED · NOT INDEPENDENTLY VERIFIED</p>' : ''}
      <p class="incident-location ${incident.location ? '' : 'missing'}"><strong>Address / cross streets:</strong> ${escapeHtml(incident.location || 'Not stated clearly in the transmission')}</p>
      ${incident.boxNumbers?.length ? `<p class="incident-units incident-box-number"><strong>FDNY Box:</strong> ${escapeHtml(incident.boxNumbers.join(', '))}</p>` : ''}
      ${incident.unitIds?.length ? `<p class="incident-units"><strong>Units:</strong> ${escapeHtml(incident.unitIds.join(', '))}</p>` : ''}
      ${incident.unitAssignments?.length ? `<p class="incident-units acting-as-units"><strong>Acting as:</strong> ${incident.unitAssignments.filter((assignment) => assignment.actingAsUnitId).map((assignment) => `${escapeHtml(assignment.unitId)} → ${escapeHtml(assignment.actingAsUnitId)}`).join(', ')}</p>` : ''}
      ${incident.updateCount ? `<details class="incident-updates"><summary>${incident.updateCount} follow-up update(s)</summary>${incident.updates.map((update) => `<p><strong>${escapeHtml(update.agency || incident.agency)} report</strong> · ${escapeHtml(formatTime(update.occurredAt))} — ${escapeHtml(update.summary)}${update.unitIds.length ? ` <strong>[${escapeHtml(update.unitIds.join(', '))}]</strong>` : ''}${update.unitAssignments?.some((assignment) => assignment.actingAsUnitId) ? ` <strong>[acting as: ${update.unitAssignments.filter((assignment) => assignment.actingAsUnitId).map((assignment) => `${escapeHtml(assignment.unitId)} → ${escapeHtml(assignment.actingAsUnitId)}`).join(', ')}]</strong>` : ''}</p>`).join('')}</details>` : ''}
      ${incident.hasAudio ? `<audio class="audio-player" controls preload="none" src="/api/incidents/${encodeURIComponent(incident.id)}/audio">Your browser does not support audio playback.</audio>` : ''}
      <div class="incident-card-foot"><span class="incident-source">AI-ASSISTED · VERIFY INDEPENDENTLY</span><span class="confidence"><strong>${state.audience === 'buff' ? 'BUFF' : state.audience === 'news' ? 'NEWS MEDIA' : 'PUBLIC'} ${audienceScore}/5</strong> · PUBLIC ${newsScore}/5 · DESK ${deskScore}/5 · BUFF ${buffScore}/5 · TRIAGE FIT ${Math.round(Math.max(0, Math.min(1, Number(incident.confidence) || 0)) * 100)}%</span></div>
      ${incident.category !== 'routine' ? `<div class="incident-vote-row" aria-label="Community feedback"><span class="incident-vote-caption">WAS THIS USEFUL? <small>Feedback helps evaluate future AI summaries; it does not verify the event.</small></span><div class="incident-vote-controls"><button class="incident-vote-button ${incident.votes?.myVote === 'up' ? 'selected' : ''}" type="button" data-incident-vote="up" data-incident-id="${encodeURIComponent(incident.id)}" aria-label="Thumbs up, ${Number(incident.votes?.up) || 0} votes" aria-pressed="${incident.votes?.myVote === 'up'}" ${incident.votes?.myVote ? 'disabled' : ''}><span aria-hidden="true">👍</span><span>${Number(incident.votes?.up) || 0}</span></button><button class="incident-vote-button ${incident.votes?.myVote === 'down' ? 'selected' : ''}" type="button" data-incident-vote="down" data-incident-id="${encodeURIComponent(incident.id)}" aria-label="Thumbs down, ${Number(incident.votes?.down) || 0} votes" aria-pressed="${incident.votes?.myVote === 'down'}" ${incident.votes?.myVote ? 'disabled' : ''}><span aria-hidden="true">👎</span><span>${Number(incident.votes?.down) || 0}</span></button></div><span class="incident-vote-feedback" role="status" aria-live="polite"></span></div>` : ''}
      <div class="incident-share-row" aria-label="Share incident"><button class="incident-share-button incident-social-share" type="button" data-share-service="facebook" data-incident-id="${encodeURIComponent(incident.id)}" aria-label="Share incident on Facebook" title="Share on Facebook">f</button><button class="incident-share-button incident-social-share" type="button" data-share-service="x" data-incident-id="${encodeURIComponent(incident.id)}" aria-label="Share incident on X" title="Share on X">𝕏</button><button class="incident-share-button copy-incident-url" type="button" data-incident-id="${encodeURIComponent(incident.id)}" aria-label="Copy incident URL" title="Copy URL"><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6.5" y="6.5" width="9" height="11" rx="1.5"></rect><path d="M13.5 6V4.5A1.5 1.5 0 0 0 12 3H5.5A1.5 1.5 0 0 0 4 4.5v9A1.5 1.5 0 0 0 5.5 15H6"></path></svg></button><span class="share-copy-feedback" role="status" aria-live="polite"></span></div>
    </article>`;
  }).join('');
}

function wireIncidentShareControls() {
  $('#incident-list').addEventListener('click', (event) => {
    const button = event.target.closest('.incident-share-button');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const incidentId = button.dataset.incidentId;
    const incidentUrl = `${location.origin}/incident/${encodeURIComponent(incidentId)}`;
    if (button.matches('.incident-social-share')) {
      const incident = state.incidents.find((item) => item.id === incidentId);
      const shareUrl = button.dataset.shareService === 'facebook'
        ? `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(incidentUrl)}`
        : `https://twitter.com/intent/tweet?url=${encodeURIComponent(incidentUrl)}&text=${encodeURIComponent(incident?.title || 'NYC Alert incident')}`;
      window.open(shareUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    const feedback = button.parentElement.querySelector('.share-copy-feedback');
    navigator.clipboard.writeText(incidentUrl).then(() => {
      feedback.textContent = 'Copied';
    }).catch(() => {
      feedback.textContent = incidentUrl;
    });
  }, true);
}

function wireIncidentVoting() {
  $('#incident-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-incident-vote]');
    if (!button || button.disabled) return;
    event.preventDefault();
    event.stopPropagation();
    const incidentId = button.dataset.incidentId;
    const vote = button.dataset.incidentVote;
    const incident = state.incidents.find((item) => item.id === incidentId);
    const feedback = button.closest('.incident-vote-row')?.querySelector('.incident-vote-feedback');
    if (!incident || !['up', 'down'].includes(vote)) return;
    button.disabled = true;
    if (feedback) feedback.textContent = 'Recording…';
    try {
      const response = await fetch(`/api/incidents/${encodeURIComponent(incidentId)}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ deviceId: voteDeviceId, vote })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Could not record feedback.');
      incident.votes = { up: result.up, down: result.down, myVote: result.myVote };
      renderIncidents();
      if (!result.accepted && feedback) feedback.textContent = 'This device already voted.';
    } catch (error) {
      button.disabled = false;
      if (feedback) feedback.textContent = error.message;
    }
  });
}

function wireLiveCallVoting() {
  $('#live-calls-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-live-vote]');
    if (!button || button.disabled) return;
    const call = state.calls.find((item) => item.id === button.dataset.liveCallId);
    if (!call || call.category === 'routine') return;
    button.disabled = true;
    call.voteMessage = 'Recording…';
    try {
      const response = await fetch(`/api/live-calls/${encodeURIComponent(call.id)}/vote`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: voteDeviceId, vote: button.dataset.liveVote })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Could not record vote.');
      call.votes = { up: result.up, down: result.down, myVote: result.myVote };
      call.voteMessage = result.message;
      renderLiveCalls();
      if (result.promoted) await refresh();
    } catch (error) {
      call.voteMessage = error.message;
      renderLiveCalls();
    }
  });
}

function getVoteDeviceId() {
  const key = 'nycalert-vote-device-id';
  try {
    const existing = localStorage.getItem(key);
    if (existing && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(existing)) return existing;
    const generated = crypto.randomUUID();
    localStorage.setItem(key, generated);
    return generated;
  } catch {
    return crypto.randomUUID();
  }
}

function detectUnitSearch(query) {
  const match = query.trim().match(/^(engine|eng|e|ladder|truck|t|rescue|r|squad|sq|battalion|bc|chief|marine|hazmat|tower|car|rmp)\s*[-#]?\s*(\d{1,3}[a-z]?)$/i);
  if (!match) return '';
  const labels = { eng: 'ENGINE', e: 'ENGINE', t: 'TRUCK', r: 'RESCUE', sq: 'SQUAD', bc: 'BATTALION', car: 'NYPD CAR', rmp: 'NYPD RMP' };
  const type = labels[match[1].toLowerCase()] || match[1].toUpperCase();
  return `${type} ${match[2].toUpperCase()}`;
}

function compareIncidents(left, right) {
  const pinnedUntil = (incident) => state.freshIncidentIds.get(incident.id) ?? 0;
  const freshDifference = pinnedUntil(right) - pinnedUntil(left);
  if (freshDifference) return freshDifference;
  const leftTime = new Date(left.updatedAt || left.occurredAt).getTime() || 0;
  const rightTime = new Date(right.updatedAt || right.occurredAt).getTime() || 0;
  const scoreForAudience = (incident) => Number(state.audience === 'buff' ? incident.buffInterestScore ?? incident.newsworthinessScore : state.audience === 'news' ? incident.assignmentDeskScore ?? incident.newsworthinessScore : incident.newsworthinessScore) || 1;
  const leftPriority = scoreForAudience(left);
  const rightPriority = scoreForAudience(right);
  if (state.sortMode === 'newest') return rightTime - leftTime;
  if (state.sortMode === 'priority') return rightPriority - leftPriority || (Number(right.confidence) || 0) - (Number(left.confidence) || 0) || rightTime - leftTime;
  const now = Date.now();
  const smartScore = (incident, timestamp, priority) => priority * 60 + (Number(incident.confidence) || 0) * 20 - Math.max(0, (now - timestamp) / 60000);
  return smartScore(right, rightTime, rightPriority) - smartScore(left, leftTime, leftPriority) || rightTime - leftTime;
}

function trackNewIncidents(incidents) {
  if (state.firstIncidentLoad) {
    state.incidentIds = new Set(incidents.map((incident) => incident.id));
    state.incidentUpdateCounts = new Map(incidents.map((incident) => [incident.id, Number(incident.updateCount) || 0]));
    state.firstIncidentLoad = false;
    const newest = [...incidents].sort((left, right) => new Date(right.occurredAt) - new Date(left.occurredAt))[0];
    const featuredUntil = newest ? new Date(newest.occurredAt).getTime() + 10 * 60_000 : 0;
    if (newest && featuredUntil > Date.now()) setFeaturedTicker(newest, featuredUntil);
    else startTickerRotation();
    return;
  }
  const now = Date.now();
  const newlySeen = incidents.filter((incident) => !state.incidentIds.has(incident.id)
    && !state.announcedIds.has(incident.id)
    && new Date(incident.occurredAt).getTime() >= state.pageStartedAt - 60_000
    && new Date(incident.occurredAt).getTime() >= now - 30 * 60 * 1000);
  for (const incident of incidents) state.incidentIds.add(incident.id);
  newlySeen.sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());
  for (const incident of newlySeen) {
    state.announcedIds.add(incident.id);
    state.freshIncidentIds.set(incident.id, now + 25_000);
    if (state.freshIncidentIds.size > 100) state.freshIncidentIds.delete(state.freshIncidentIds.keys().next().value);
    enqueueIncidentTicker(incident, 'new');
  }
  const updated = incidents.filter((incident) => state.incidentIds.has(incident.id)
    && (Number(incident.updateCount) || 0) > (state.incidentUpdateCounts.get(incident.id) || 0));
  for (const incident of incidents) state.incidentUpdateCounts.set(incident.id, Number(incident.updateCount) || 0);
  for (const incident of updated) {
    state.freshIncidentIds.set(incident.id, now + 25_000);
    const latestUpdate = incident.updates.at(-1)?.summary || incident.summary;
    enqueueIncidentTicker({ ...incident, summary: latestUpdate, isUpdate: true }, 'update');
  }
  if (newlySeen.length || updated.length) renderIncidents();
}

function enqueueIncidentTicker(incident, type) {
  const now = Date.now();
  if (type === 'new' && (!state.tickerFeaturedIncident || state.tickerFeaturedUntil <= now)) {
    setFeaturedTicker(incident, new Date(incident.occurredAt).getTime() + 10 * 60_000);
    return;
  }
  if (type === 'update' && state.tickerFeaturedIncident?.id === incident.id) {
    state.tickerFeaturedIncident = incident;
    if (!state.tickerActive) displayTickerIncident(incident);
    return;
  }
  state.tickerQueue.push({ incident, type });
  if (state.tickerQueue.length > 5) state.tickerQueue.splice(0, state.tickerQueue.length - 5);
  if (type === 'new' && (!state.tickerFeaturedIncident || state.tickerFeaturedUntil <= now)) {
    const next = state.tickerQueue.shift();
    if (next) setFeaturedTicker(next.incident, new Date(next.incident.occurredAt).getTime() + 10 * 60_000);
  } else if (!state.tickerActive) {
    showNextIncidentTicker();
  }
}

function showNextIncidentTicker() {
  const next = state.tickerQueue.shift();
  if (!next) {
    state.tickerActive = false;
    if (state.tickerFeaturedIncident && state.tickerFeaturedUntil > Date.now()) {
      displayTickerIncident(state.tickerFeaturedIncident, 'BREAKING NEWS:');
    } else {
      state.tickerFeaturedIncident = null;
      startTickerRotation();
    }
    return;
  }
  state.tickerActive = true;
  displayTickerIncident(next.incident);
  state.tickerOverrideTimer = setTimeout(showNextIncidentTicker, 12_000);
}

function setFeaturedTicker(incident, expiresAt) {
  state.tickerFeaturedIncident = incident;
  state.tickerFeaturedUntil = expiresAt;
  state.tickerQueue = [];
  state.tickerActive = false;
  if (state.tickerRotationTimer) clearInterval(state.tickerRotationTimer);
  if (state.tickerOverrideTimer) clearTimeout(state.tickerOverrideTimer);
  state.tickerRotationTimer = null;
  state.tickerOverrideTimer = null;
  displayTickerIncident(incident);
  if (state.tickerFeaturedTimer) clearTimeout(state.tickerFeaturedTimer);
  state.tickerFeaturedTimer = setTimeout(() => {
    state.tickerFeaturedIncident = null;
    state.tickerFeaturedUntil = 0;
    state.tickerFeaturedTimer = null;
    if (!state.tickerActive) showNextIncidentTicker();
  }, Math.max(0, expiresAt - Date.now()));
}

function displayTickerIncident(incident) {
  const ticker = $('#incident-ticker');
  const isBreaking = Number(incident.newsworthinessScore) === 5;
  const publicScore = Math.round(Math.max(1, Math.min(5, Number(incident.newsworthinessScore) || 1)));
  const category = isBreaking ? 'breaking' : 'newsworthy';
  ticker.classList.remove('breaking', 'newsworthy', 'routine');
  ticker.classList.add(category);
  const tickerLabel = $('#incident-ticker-label');
    tickerLabel.textContent = isBreaking ? 'BREAKING NEWS:'
      : publicScore === 4 ? 'DEVELOPING:'
        : publicScore === 3 ? (incident.isUpdate ? 'INCIDENT UPDATE:' : 'INCIDENT:')
          : publicScore === 2 ? 'ACTIVITY:' : 'INCIDENT:';
  tickerLabel.classList.toggle('ticker-breaking-label', isBreaking);
  const address = incident.location || 'Address not stated';
  const summaryText = String(incident.summary ?? '').trim();
  const alreadyIncludesAddress = incident.location
    && summaryText.toLowerCase().includes(String(incident.location).trim().toLowerCase());
  const summary = alreadyIncludesAddress ? summaryText : `${summaryText} | ${address}`;
  const timestamp = new Date(incident.updatedAt || incident.occurredAt).getTime();
  const minutes = Number.isFinite(timestamp) ? Math.max(0, Math.floor((Date.now() - timestamp) / 60_000)) : 0;
  const age = minutes < 1 ? 'just now' : `${minutes} min ago`;
  $('#incident-ticker-text').textContent = `${summary} | ${boroughCode(incident.borough)} | ${age}`;
}

function startTickerRotation() {
  if (state.tickerActive || state.tickerRotationTimer || (state.tickerFeaturedIncident && state.tickerFeaturedUntil > Date.now())) return;
  const rotate = () => {
    const recent = [...state.incidents].sort((left, right) => new Date(right.updatedAt || right.occurredAt) - new Date(left.updatedAt || left.occurredAt));
    if (!recent.length) {
      $('#incident-ticker-label').textContent = 'INCIDENT:';
      $('#incident-ticker').classList.remove('breaking', 'newsworthy');
      $('#incident-ticker').classList.add('routine');
      $('#incident-ticker-text').textContent = 'Waiting for recent incidents…';
      return;
    }
    const incident = recent[state.tickerIndex % recent.length];
    state.tickerIndex = (state.tickerIndex + 1) % recent.length;
    displayTickerIncident(incident);
  };
  rotate();
  state.tickerRotationTimer = setInterval(rotate, 8_000);
}

function incidentIcon(incident) {
  const validTypes = new Set(['medical', 'vehicle', 'fire', 'police', 'other']);
  const type = validTypes.has(incident.incidentType) ? incident.incidentType : 'other';
  const symbols = { medical: '✚', vehicle: '🚗', fire: '♨', police: '★', other: '•' };
  const label = { medical: 'Medical', vehicle: 'Vehicle incident', fire: 'Fire response', police: 'Police incident', other: 'Incident' };
  return L.divIcon({
    className: 'incident-map-div-icon',
    html: `<div class="incident-map-marker ${type}" role="img" aria-label="${label[type]}"><span>${symbols[type]}</span></div>`,
    iconSize: [38, 42],
    iconAnchor: [19, 39],
    popupAnchor: [0, -38]
  });
}

async function refreshMap() {
  if (!state.map || !state.mapLayer) return;
  const sequence = ++state.mapRefreshSequence;
  try {
    const mapUrl = new URL('/api/map-incidents', location.origin);
    boroughQueryParams(mapUrl.searchParams);
    const response = await fetch(mapUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error('Map incident API unavailable');
    const data = await response.json();
    if (sequence !== state.mapRefreshSequence) return;
    const incidents = Array.isArray(data.incidents) ? data.incidents : [];
    const currentIds = new Set(incidents.map((incident) => incident.id));
    for (const [id, marker] of state.mapMarkers) {
      if (!currentIds.has(id)) {
        state.mapLayer.removeLayer(marker);
        state.mapMarkers.delete(id);
      }
    }
    for (const incident of incidents) {
      const popup = `<strong>${escapeHtml(incident.title)}</strong><br>${escapeHtml(incident.summary)}${incident.updateCount ? `<br><strong>Updates:</strong> ${Number(incident.updateCount)}` : ''}<br>${escapeHtml(incident.location || '')}${incident.unitIds?.length ? `<br><strong>Units:</strong> ${escapeHtml(incident.unitIds.join(', '))}` : ''}<br><small>${escapeHtml(formatTime(incident.updatedAt || incident.occurredAt))}</small>`;
      const coordinates = [Number(incident.latitude), Number(incident.longitude)];
      let marker = state.mapMarkers.get(incident.id);
      if (!marker) {
        marker = L.marker(coordinates, { icon: incidentIcon(incident) }).addTo(state.mapLayer);
        state.mapMarkers.set(incident.id, marker);
      } else {
        if (marker.getLatLng().lat !== coordinates[0] || marker.getLatLng().lng !== coordinates[1]) marker.setLatLng(coordinates);
        marker.setIcon(incidentIcon(incident));
      }
      marker.bindPopup(popup);
    }
    $('#map-empty-note').hidden = incidents.length > 0;
    $('#map-refresh-label').textContent = `MAP UPDATED · ${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date())} ET · LIVE`;
    if (incidents.length && !state.mapHasFitBounds) {
      const bounds = state.mapLayer.getBounds();
      state.map.fitBounds(bounds.pad(0.15), { maxZoom: 14, animate: false });
      state.mapHasFitBounds = true;
    }
  } catch {
    if (sequence === state.mapRefreshSequence) $('#map-refresh-label').textContent = 'MAP REFRESH FAILED · RETRYING';
  }
}

function scheduleMapRefresh() {
  if (state.mapRefreshTimer) clearTimeout(state.mapRefreshTimer);
  state.mapRefreshTimer = setTimeout(() => {
    state.mapRefreshTimer = null;
    void refreshMap();
  }, 120);
}

function initializeLiveUpdates() {
  if (!('EventSource' in window) || state.liveUpdates) return;
  const events = new EventSource('/api/events');
  state.liveUpdates = events;
  events.addEventListener('incidents-updated', () => {
    void refresh();
    scheduleMapRefresh();
  });
  events.addEventListener('open', () => {
    $('#system-state').textContent = 'ONLINE';
    scheduleMapRefresh();
  });
  events.addEventListener('error', () => {
    // EventSource automatically reconnects; a short map poll below covers temporary disconnects.
    if (state.map) $('#map-refresh-label').textContent = 'LIVE MAP RECONNECTING';
  });
}

function initializeMap() {
  if (!window.L || state.map) return;
  state.map = L.map('incident-map', { scrollWheelZoom: false }).setView([40.7128, -73.95], 10);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    maxNativeZoom: 19,
    attribution: 'Tiles &copy; Esri, HERE, Garmin, (c) OpenStreetMap contributors, and the GIS user community'
  }).addTo(state.map);
  state.mapLayer = L.layerGroup().addTo(state.map);
  void refreshMap();
  state.mapTimer = setInterval(refreshMap, 30_000);
}

function renderLiveCalls() {
  const visible = state.calls.filter((call) => (state.boroughs.has(call.borough) || (state.boroughs.size > 0 && call.borough === 'Citywide'))
    && (state.agency === 'all' || call.agency === state.agency)
    && (!state.liveCategories || state.liveCategories.has(call.category)));
  renderLiveCategoryControls(visible.length);
  if (!visible.length) {
    $('#live-calls-list').innerHTML = `<div class="live-empty-state"><strong>${state.query ? 'No matching radio calls' : 'No transcribed calls yet'}</strong><p>${state.query ? 'Try a different search or clear the active filters.' : 'Calls appear here after a feed is connected and audio is transcribed. Routine calls are included in this view.'}</p></div>`;
    return;
  }
  $('#live-calls-list').innerHTML = visible.map((call) => `
    <article class="live-call-card">
      <div class="live-call-head"><span class="category-tag ${escapeHtml(call.category)}">${escapeHtml(categoryLabel(call.category))}</span><span class="borough-tag">${escapeHtml(call.agency)} · ${escapeHtml(boroughCode(call.borough))}</span><time>${escapeHtml(formatTime(call.occurredAt))}</time></div>
      <div class="live-call-title">${escapeHtml(call.groupName || `${call.agency} radio transmission`)}</div><div class="live-call-ref">${escapeHtml(call.sourceId)}</div>
      <div class="live-call-generated-title"><span>AI CALL TITLE</span><strong>${escapeHtml(call.headline || call.summary || 'Radio call')}</strong></div>
      ${call.transcript ? `<div class="live-transcript">${escapeHtml(call.transcript)}</div>` : '<div class="transcript-unavailable">Transcript is not publicly exposed. Set DASHBOARD_PUBLIC_TRANSCRIPTS=true only after reviewing privacy and retention requirements.</div>'}
      <p class="live-call-summary">${escapeHtml(call.summary)}</p>
      ${call.category !== 'routine' ? `<div class="live-call-vote-row"><span class="live-call-vote-caption">HELP SURFACE THIS REPORT <small>10 upvotes, 8 net votes, and minimum triage checks can add it to Latest Incidents. Votes are not verification.</small></span><div class="live-call-vote-controls"><button class="incident-vote-button ${call.votes?.myVote === 'up' ? 'selected' : ''}" type="button" data-live-vote="up" data-live-call-id="${encodeURIComponent(call.id)}" aria-label="Upvote radio report, ${Number(call.votes?.up) || 0} votes" aria-pressed="${call.votes?.myVote === 'up'}" ${call.votes?.myVote ? 'disabled' : ''}>👍 <span>${Number(call.votes?.up) || 0}</span></button><button class="incident-vote-button ${call.votes?.myVote === 'down' ? 'selected' : ''}" type="button" data-live-vote="down" data-live-call-id="${encodeURIComponent(call.id)}" aria-label="Downvote radio report, ${Number(call.votes?.down) || 0} votes" aria-pressed="${call.votes?.myVote === 'down'}" ${call.votes?.myVote ? 'disabled' : ''}>👎 <span>${Number(call.votes?.down) || 0}</span></button></div><span class="live-call-vote-feedback" role="status" aria-live="polite">${escapeHtml(call.voteMessage || '')}</span></div>` : ''}
      ${call.hasAudio ? `<audio class="live-call-audio" controls preload="none" src="/api/live-calls/${encodeURIComponent(call.id)}/audio">Audio playback is not supported.</audio>` : `<div class="audio-retention-note">${call.agency === 'NYPD' ? 'NYPD AUDIO IS TRANSCRIBED IN MEMORY AND NOT RETAINED' : 'AUDIO PLAYBACK NOT AVAILABLE'}</div>`}
      <div class="live-call-foot"><span>${state.audience === 'buff' ? 'BUFF' : state.audience === 'news' ? 'NEWS MEDIA' : 'PUBLIC'} ${Math.round(Math.max(1, Math.min(5, Number(state.audience === 'buff' ? call.buffInterestScore ?? call.newsworthinessScore : state.audience === 'news' ? call.assignmentDeskScore ?? call.newsworthinessScore : call.newsworthinessScore) || 1)))}/5 · PUBLIC ${Math.round(Math.max(1, Math.min(5, Number(call.newsworthinessScore) || 1)))}/5 · DESK ${Math.round(Math.max(1, Math.min(5, Number(call.assignmentDeskScore) || Number(call.newsworthinessScore) || 1)))}/5 · BUFF ${Math.round(Math.max(1, Math.min(5, Number(call.buffInterestScore) || Number(call.newsworthinessScore) || 1)))}/5</span><span>TRIAGE FIT ${Math.round(Math.max(0, Math.min(1, Number(call.confidence) || 0)) * 100)}% · VERIFY INDEPENDENTLY</span></div>
    </article>`).join('');
}

const liveCallCategories = ['routine', 'newsworthy', 'breaking', 'funny', 'weird_unique'];

function renderLiveCategoryControls(visibleCount) {
  document.querySelectorAll('[data-live-category]').forEach((button) => {
    const value = button.dataset.liveCategory;
    const selected = value === 'all' ? !state.liveCategories : state.liveCategories?.has(value);
    button.classList.toggle('active', Boolean(selected));
    button.setAttribute('aria-pressed', String(Boolean(selected)));
  });
  const count = $('#live-call-filter-count');
  if (count) count.textContent = `${visibleCount} ${visibleCount === 1 ? 'CALL' : 'CALLS'}`;
}

function toggleLiveCategory(value) {
  if (value === 'all') state.liveCategories = null;
  else {
    const selected = state.liveCategories ? new Set(state.liveCategories) : new Set(liveCallCategories);
    if (selected.has(value)) selected.delete(value);
    else selected.add(value);
    state.liveCategories = selected.size === liveCallCategories.length ? null : selected;
  }
  renderLiveCalls();
  saveDashboardPreferences();
}

function dashboardPreferencesSnapshot() {
  return {
    boroughs: [...state.boroughs], audience: state.audience, agency: state.agency,
    sortMode: state.sortMode, view: state.view,
    liveCategories: state.liveCategories ? [...state.liveCategories] : [...liveCallCategories]
  };
}

function saveDashboardPreferences() {
  if (!state.authSession?.account?.id || state.applyingPreferences) return;
  clearTimeout(state.preferenceSaveTimer);
  state.preferenceSaveTimer = setTimeout(() => {
    const preferences = dashboardPreferencesSnapshot();
    state.preferenceSaveQueue = state.preferenceSaveQueue.catch(() => undefined).then(async () => {
      await fetch('/api/account/preferences', {
        method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences })
      });
    });
  }, 300);
}

async function loadSavedDashboardPreferences() {
  if (!state.authSession?.account?.id) return;
  try {
    const response = await fetch('/api/account/preferences', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) return;
    const { preferences } = await response.json();
    if (!preferences) return;
    state.applyingPreferences = true;
    if (Array.isArray(preferences.boroughs)) state.boroughs = new Set(preferences.boroughs.filter((borough) => boroughNames.includes(borough)));
    state.agency = ['all', 'FDNY', 'NYPD'].includes(preferences.agency) ? preferences.agency : 'all';
    state.sortMode = ['smart', 'newest', 'priority'].includes(preferences.sortMode) ? preferences.sortMode : 'smart';
    state.view = preferences.view === 'live' ? 'live' : 'incidents';
    const savedAudience = ['public', 'buff', 'news'].includes(preferences.audience) ? preferences.audience : 'public';
    state.audience = canViewAudience(savedAudience) ? savedAudience : 'public';
    const categories = Array.isArray(preferences.liveCategories) ? preferences.liveCategories.filter((item) => liveCallCategories.includes(item)) : liveCallCategories;
    state.liveCategories = categories.length === liveCallCategories.length ? null : new Set(categories);
    persistBoroughSelection();
    persistAudienceSelection();
    initializeBoroughPage();
    initializeAudienceView();
    $('#incident-sort').value = state.sortMode;
    updateAgencyFilterControls();
    setView(state.view);
  } catch { /* Account preference loading is best-effort; current defaults remain usable. */ }
  finally { state.applyingPreferences = false; }
}

function updateAgencyFilterControls() {
  document.querySelectorAll('.filter-chip[data-filter]').forEach((button) => {
    const selected = button.dataset.filter === state.agency;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
}

function renderDiagnostics() {
  const entries = Object.entries(state.pipelines || {});
  const errors = entries.filter(([, pipeline]) => pipeline.state === 'error').length;
  $('#diagnostics-summary').textContent = entries.length ? `${errors ? `${errors} issue(s)` : 'No reported errors'} · ${entries.length} pipeline(s)` : 'Waiting for monitor data';
  $('#diagnostics-content').innerHTML = entries.length ? entries.map(([name, pipeline]) => `
    <article class="diagnostic-card"><div class="diagnostic-top"><strong class="diagnostic-name">${escapeHtml(name.replaceAll('-', ' ').toUpperCase())}</strong><span class="diagnostic-state ${escapeHtml(pipeline.state)}">${escapeHtml(pipeline.state.toUpperCase())}</span></div>
      <div class="diagnostic-stage">${escapeHtml(pipeline.stage)}</div><div class="diagnostic-metrics">Processed ${Number(pipeline.callsProcessed) || 0} · Retried ${Number(pipeline.callsRetried) || 0} · Failed ${Number(pipeline.callsFailed) || 0}</div>
      <div class="diagnostic-time">Last poll ${pipeline.lastPollAt ? escapeHtml(formatTime(pipeline.lastPollAt)) : '—'} · Last call ${pipeline.lastCallAt ? escapeHtml(formatTime(pipeline.lastCallAt)) : '—'}</div>
      ${pipeline.lastError ? `<div class="diagnostic-error">${escapeHtml(pipeline.lastError)}</div>` : ''}</article>`).join('') : '<div class="diagnostic-warning">No feed pipeline is active. Check the service logs and Broadcastify enablement/configuration.</div>';
}

async function refresh() {
  if (state.refreshPaused) return;
  const params = boroughQueryParams(new URLSearchParams());
  if (state.query) params.set('q', state.query);
  const incidentParams = new URLSearchParams(params);
  incidentParams.set('deviceId', voteDeviceId);
  const callParams = new URLSearchParams(params);
  callParams.set('deviceId', voteDeviceId);
  try {
    const [incidentResponse, callResponse, feedResponse, diagnosticResponse] = await Promise.all([
      fetch(`/api/incidents?${incidentParams}`, { cache: 'no-store' }),
      fetch(`/api/live-calls?${callParams}`, { cache: 'no-store' }),
      fetch(`/api/feeds${params.toString() ? `?${params}` : ''}`, { cache: 'no-store' }),
      fetch('/api/diagnostics', { cache: 'no-store' })
    ]);
    if (!incidentResponse.ok || !callResponse.ok || !feedResponse.ok || !diagnosticResponse.ok) throw new Error('Dashboard API unavailable');
    const [incidentData, callData, feedData, diagnosticData] = await Promise.all([incidentResponse.json(), callResponse.json(), feedResponse.json(), diagnosticResponse.json()]);
    if (state.refreshPaused) return;
    state.incidents = Array.isArray(incidentData.incidents) ? incidentData.incidents : [];
    trackNewIncidents(state.incidents);
    state.calls = Array.isArray(callData.calls) ? callData.calls : [];
    state.feeds = Array.isArray(feedData.feeds) ? feedData.feeds : [];
    state.pipelines = diagnosticData.pipelines || {};
    renderFeeds();
    renderIncidents();
    renderLiveCalls();
    renderDiagnostics();
    $('#system-state').textContent = 'ONLINE';
    $('#feed-status').textContent = state.feeds.some((feed) => feed.state === 'online') ? 'MONITORING' : 'NO LIVE FEEDS';
  } catch {
    $('#system-state').textContent = 'OFFLINE';
    $('#feed-status').textContent = 'RETRYING';
  }
}

async function refreshFeedTelemetry() {
  if (document.visibilityState !== 'visible') return;
  try {
    const params = boroughQueryParams(new URLSearchParams());
    const response = await fetch(`/api/feeds${params.toString() ? `?${params}` : ''}`, { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    state.feeds = Array.isArray(data.feeds) ? data.feeds : [];
    renderFeeds();
  } catch { /* Preserve the last feed display during transient network errors. */ }
}

function getPresenceBrowserToken() {
  const key = 'nycalert-presence-session';
  try {
    const existing = sessionStorage.getItem(key);
    if (existing && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(existing)) return existing;
    const generated = crypto.randomUUID();
    sessionStorage.setItem(key, generated);
    return generated;
  } catch {
    return crypto.randomUUID();
  }
}

async function heartbeatPresence() {
  try {
    const response = await fetch('/api/presence', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ browserToken: presenceBrowserToken }), cache: 'no-store'
    });
    if (!response.ok) return;
    const { counts } = await response.json();
    $('#presence-total').textContent = String(Number(counts?.total) || 0);
    $('#presence-buff').textContent = String(Number(counts?.buff) || 0);
    $('#presence-news').textContent = String(Number(counts?.newsMedia) || 0);
  } catch { /* Keep the last aggregate counts when a heartbeat temporarily fails. */ }
}

async function initialize() {
  wireAuthControls();
  wireIncidentShareControls();
  wireIncidentVoting();
  wireLiveCallVoting();
  await loadAuthSession();
  await loadSavedDashboardPreferences();
  updateClock();
  setInterval(updateClock, 1000);
  initializeBoroughPage();
  initializeAudienceView();
  if (state.audience !== 'public' && !canViewAudience(state.audience)) {
    state.pendingAudience = state.audience;
    state.audience = 'public';
    persistAudienceSelection();
    initializeAudienceView();
    openAuthModal('login', `Log in or register for the ${state.pendingAudience === 'buff' ? 'Buff' : 'News Media'} view.`);
  }
  $('#incident-sort').value = state.sortMode;
  updateAgencyFilterControls();
  setView(state.view);
  initializeMap();
  initializeLiveUpdates();
  void initializePublicConfig();
  void heartbeatPresence();
  state.presenceTimer = setInterval(heartbeatPresence, 20_000);
  void refreshFeedTelemetry();
  setInterval(refreshFeedTelemetry, 1_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void heartbeatPresence();
  });
  await refresh();
  setInterval(refresh, 15000);
}

async function loadAuthSession() {
  const params = new URLSearchParams(location.search);
  const hashParams = new URLSearchParams(location.hash.replace(/^#/, ''));
  const adminInviteToken = hashParams.get('adminInvite') || params.get('adminInvite');
  const verificationToken = hashParams.get('verify') || params.get('verify');
  const requestedAuthMode = params.get('auth');
  if (adminInviteToken || verificationToken || requestedAuthMode) {
    params.delete('adminInvite');
    params.delete('verify');
    params.delete('auth');
    hashParams.delete('adminInvite');
    hashParams.delete('verify');
    const query = params.toString();
    const hash = hashParams.toString();
    history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${hash ? `#${hash}` : ''}`);
    if (verificationToken) {
      try {
        const verified = await authRequest('/api/auth/verify', { token: verificationToken });
        state.authMessageAfterLoad = { message: verified.message, kind: 'success' };
      } catch (error) {
        state.authMessageAfterLoad = { message: error.message, kind: 'error' };
      }
    }
  }
  try {
    const response = await fetch('/api/auth/session', { cache: 'no-store' });
    if (response.ok) state.authSession = (await response.json()).session;
  } catch { state.authSession = null; }
  renderAuthHeader();
  if (adminInviteToken) openAdminInviteCompletion(adminInviteToken);
  else if (state.authMessageAfterLoad) openAuthModal('login', state.authMessageAfterLoad.message, state.authMessageAfterLoad.kind);
  else if (requestedAuthMode === 'login' || requestedAuthMode === 'register') openAuthModal(requestedAuthMode);
}

function renderAuthHeader() {
  const signedIn = Boolean(state.authSession);
  $('#auth-login').hidden = signedIn;
  $('#auth-register').hidden = signedIn;
  $('#signed-in-actions').hidden = !signedIn;
  $('#account-name').textContent = state.authSession?.kind === 'admin'
    ? 'Administrator'
    : state.authSession?.account?.firstName || '';
  $('#admin-dashboard').hidden = state.authSession?.kind !== 'admin';
}

function wireAuthControls() {
  $('#auth-login').addEventListener('click', () => openAuthModal('login'));
  $('#auth-register').addEventListener('click', () => openAuthModal('register'));
  $('#auth-close').addEventListener('click', () => { $('#auth-modal').hidden = true; });
  $('#auth-modal').addEventListener('click', (event) => {
    if (event.target === $('#auth-modal')) $('#auth-modal').hidden = true;
  });
  $('#auth-logout').addEventListener('click', async () => {
    try { await authRequest('/api/auth/logout', {}); } catch { /* Clear local state even if the session already expired. */ }
    state.authSession = null;
    state.audience = 'public';
    state.pendingAudience = null;
    persistAudienceSelection();
    initializeAudienceView();
    renderAuthHeader();
    renderIncidents();
    renderLiveCalls();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#auth-modal').hidden) $('#auth-modal').hidden = true;
  });
}

function openAuthModal(mode = 'login', message = '', messageKind = '') {
  $('#auth-form').hidden = false;
  $('#auth-modal').hidden = false;
  renderAuthMessage(message, messageKind);
  renderAuthForm(mode);
  $('#auth-title').textContent = mode === 'register' ? 'Create an account' : 'Log in';
  $('#auth-form').querySelector('input')?.focus();
}

function renderAuthMessage(message = '', kind = '') {
  const element = $('#auth-message');
  element.textContent = message;
  element.className = `auth-message${kind ? ` ${kind}` : ''}`;
}

function renderAuthForm(mode) {
  const form = $('#auth-form');
  delete form.dataset.adminInviteToken;
  if (mode === 'register') {
    const defaultAudience = state.pendingAudience === 'news' ? 'news' : 'buff';
    form.innerHTML = `
      <label class="auth-field">FIRST NAME<input name="firstName" autocomplete="given-name" maxlength="80" required></label>
      <label class="auth-field">LAST NAME<input name="lastName" autocomplete="family-name" maxlength="80" required></label>
      <label class="auth-field full">EMAIL<input name="email" type="email" autocomplete="email" maxlength="254" required></label>
      <label class="auth-field full">PHONE<input name="phone" type="tel" autocomplete="tel" maxlength="40" required></label>
      <label class="auth-field">REQUESTED VIEW<select name="accountType"><option value="buff" ${defaultAudience === 'buff' ? 'selected' : ''}>Buff</option><option value="news" ${defaultAudience === 'news' ? 'selected' : ''}>News Media</option></select></label>
      <label class="auth-field">PASSWORD (12+ CHARACTERS)<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label>
      <label class="auth-field full">HOW WILL YOU USE THIS ACCOUNT?<textarea name="usageCase" minlength="10" maxlength="1000" required></textarea></label>
      <button class="auth-form-submit" type="submit">Register for review</button>
      <p class="auth-switch">Already registered? <button type="button" data-auth-mode="login">Log in</button></p>`;
  } else {
    form.innerHTML = `
      <label class="auth-field full">EMAIL<input name="email" type="email" autocomplete="username" maxlength="254" required></label>
      <label class="auth-field full">PASSWORD<input name="password" type="password" autocomplete="current-password" maxlength="128" required></label>
      <button class="auth-form-submit" type="submit">Log in</button>
      <p class="auth-switch">Need an account? <button type="button" data-auth-mode="register">Register</button></p>`;
  }
  form.querySelector('[data-auth-mode]')?.addEventListener('click', (event) => openAuthModal(event.currentTarget.dataset.authMode));
  form.addEventListener('submit', submitAuthForm, { once: true });
}

async function submitAuthForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('.auth-form-submit');
  submit.disabled = true;
  renderAuthMessage('Please wait…');
  const values = Object.fromEntries(new FormData(form).entries());
  try {
    if (form.dataset.adminInviteToken) {
      const result = await authRequest('/api/auth/admin-invite-complete', { token: form.dataset.adminInviteToken, password: values.password });
      state.authSession = result.session;
      renderAuthHeader();
      window.location.replace('/admin');
      return;
    }
    if (form.querySelector('[name="accountType"]')) {
      const result = await authRequest('/api/auth/register', values);
      renderAuthMessage(result.message, 'success');
      form.reset();
      return;
    }
    const result = await authRequest('/api/auth/login', values);
    state.authSession = result.session;
    await loadSavedDashboardPreferences();
    renderAuthHeader();
    $('#auth-modal').hidden = true;
    if (state.pendingAudience) {
      const requested = state.pendingAudience;
      state.pendingAudience = null;
      if (canViewAudience(requested)) setAudienceView(requested);
      else openAuthModal('login', `Your account is not approved for the ${requested === 'buff' ? 'Buff' : 'News Media'} view.`, 'error');
    }
  } catch (error) {
    renderAuthMessage(error.message, 'error');
  } finally {
    submit.disabled = false;
  }
}

function openAdminInviteCompletion(token) {
  $('#auth-form').hidden = false;
  $('#auth-modal').hidden = false;
  $('#auth-title').textContent = 'Set administrator password';
  renderAuthMessage('Choose a unique password of at least 16 characters. This invitation expires after 24 hours.');
  const form = $('#auth-form');
  form.dataset.adminInviteToken = token;
  form.innerHTML = '<label class="auth-field full">NEW PASSWORD (16+ CHARACTERS)<input name="password" type="password" autocomplete="new-password" minlength="16" maxlength="128" required></label><button class="auth-form-submit" type="submit">Activate administrator account</button>';
  form.addEventListener('submit', submitAuthForm, { once: true });
  form.querySelector('input')?.focus();
}

async function authRequest(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Account request failed.');
  return result;
}

async function initializePublicConfig() {
  try {
    const response = await fetch('/api/public-config', { cache: 'no-store' });
    if (!response.ok) return;
    const config = await response.json();
    initializeOptionalAnalytics(config.analytics || {});
  } catch {
    // Keep the header clean if the public config endpoint is unavailable.
  }
}

function initializeOptionalAnalytics(settings) {
  const acceptedKey = 'nycalert-analytics-consent';
  const activate = () => {
    const googleId = /^G-[A-Z0-9]{4,20}$/i.test(settings.googleAnalyticsId || '') ? settings.googleAnalyticsId : '';
    const pixelId = /^\d{5,20}$/.test(settings.metaPixelId || '') ? settings.metaPixelId : '';
    if (googleId && !document.querySelector('[data-nyc-analytics="google"]')) {
      const script = document.createElement('script');
      script.async = true;
      script.dataset.nycAnalytics = 'google';
      script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(googleId)}`;
      document.head.append(script);
      window.dataLayer = window.dataLayer || [];
      window.gtag = function gtag() { window.dataLayer.push(arguments); };
      window.gtag('js', new Date());
      window.gtag('config', googleId);
    }
    if (pixelId && !window.nycMetaPixelInitialized) {
      window.nycMetaPixelInitialized = true;
      window.fbq = window.fbq || function fbq() { (window.fbq.callMethod ? window.fbq.callMethod : window.fbq.queue.push.bind(window.fbq.queue))(arguments); };
      window.fbq.queue = window.fbq.queue || [];
      window.fbq.loaded = true;
      window.fbq.version = '2.0';
      const script = document.createElement('script');
      script.async = true;
      script.dataset.nycAnalytics = 'meta';
      script.src = 'https://connect.facebook.net/en_US/fbevents.js';
      document.head.append(script);
      window.fbq('init', pixelId);
      window.fbq('track', 'PageView');
    }
  };
  const consent = localStorage.getItem(acceptedKey);
  if (consent === 'accepted') { activate(); return; }
  if (consent === 'declined') return;
  const banner = $('#analytics-consent');
  if (!banner) return;
  banner.hidden = false;
  $('#analytics-accept').addEventListener('click', () => {
    localStorage.setItem(acceptedKey, 'accepted');
    banner.hidden = true;
    activate();
  }, { once: true });
  $('#analytics-decline').addEventListener('click', () => {
    localStorage.setItem(acceptedKey, 'declined');
    banner.hidden = true;
  }, { once: true });
}

function setRefreshPaused(paused) {
  state.refreshPaused = paused;
  const label = $('#refresh-label');
  if (label) label.innerHTML = paused ? '<i></i> AUTO-REFRESH PAUSED · AUDIO PLAYING' : '<i></i> AUTO-REFRESH · 15 SEC';
}

document.addEventListener('play', (event) => {
  if (event.target instanceof HTMLAudioElement) setRefreshPaused(true);
}, true);

document.addEventListener('pause', (event) => {
  if (event.target instanceof HTMLAudioElement && ![...document.querySelectorAll('audio')].some((audio) => !audio.paused && !audio.ended)) {
    setRefreshPaused(false);
  }
}, true);

document.addEventListener('ended', (event) => {
  if (event.target instanceof HTMLAudioElement && ![...document.querySelectorAll('audio')].some((audio) => !audio.paused && !audio.ended)) {
    setRefreshPaused(false);
    void refresh();
  }
}, true);

$('#search').addEventListener('input', (event) => {
  state.query = event.target.value.trim();
  clearTimeout(window.searchTimer);
  window.searchTimer = setTimeout(refresh, 250);
});

document.querySelectorAll('.filter-chip[data-filter]').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('.filter-chip').forEach((item) => item.classList.remove('active'));
  button.classList.add('active');
  state.agency = button.dataset.filter;
  updateAgencyFilterControls();
  renderIncidents();
  renderLiveCalls();
  saveDashboardPreferences();
}));

document.querySelectorAll('[data-live-category]').forEach((button) => button.addEventListener('click', () => {
  toggleLiveCategory(button.dataset.liveCategory);
}));

$('#incident-sort').addEventListener('change', (event) => {
  state.sortMode = event.target.value;
  renderIncidents();
  saveDashboardPreferences();
});

$('#incidents-tab').addEventListener('click', () => setView('incidents'));
$('#live-calls-tab').addEventListener('click', () => setView('live'));

function setView(view) {
  state.view = view;
  const incidentsActive = view === 'incidents';
  $('#incidents-tab').classList.toggle('active', incidentsActive);
  $('#incidents-tab').setAttribute('aria-selected', String(incidentsActive));
  $('#live-calls-tab').classList.toggle('active', !incidentsActive);
  $('#live-calls-tab').setAttribute('aria-selected', String(!incidentsActive));
  $('#incident-list').hidden = !incidentsActive;
  $('#live-calls-list').hidden = incidentsActive;
  $('#incident-filters').hidden = false;
  $('#incident-sort-control').hidden = !incidentsActive;
  $('#live-call-filters').hidden = incidentsActive;
  $('#search').placeholder = incidentsActive ? 'Search alerts…' : 'Search radio calls…';
  saveDashboardPreferences();
}

document.querySelectorAll('.borough-tab').forEach((button) => button.addEventListener('click', () => {
  const borough = button.dataset.borough;
  if (!borough) return;
  if (state.boroughs.has(borough)) state.boroughs.delete(borough);
  else state.boroughs.add(borough);
  refreshBoroughView();
}));

$('#borough-reset').addEventListener('click', () => {
  state.boroughs = new Set(boroughNames);
  refreshBoroughView();
});

document.querySelectorAll('.audience-tab').forEach((button) => button.addEventListener('click', () => {
  setAudienceView(button.dataset.audience);
}));

document.addEventListener('keydown', (event) => {
  if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    event.preventDefault();
    $('#search').focus();
  }
  if (event.key === 'Escape' && document.activeElement === $('#search')) {
    $('#search').value = '';
    state.query = '';
    refresh();
    $('#search').blur();
  }
});

function checkForAdBlocker() {
  if (sessionStorage.getItem('nycalert-adblock-dismissed') === '1') return;
  const bait = document.createElement('div');
  bait.className = 'ad-detection-bait adsbox ad-banner ad-unit';
  bait.setAttribute('aria-hidden', 'true');
  bait.textContent = 'Advertisement';
  document.body.append(bait);
  window.setTimeout(() => {
    const style = getComputedStyle(bait);
    const blocked = bait.offsetHeight === 0 || bait.offsetWidth === 0
      || style.display === 'none' || style.visibility === 'hidden';
    bait.remove();
    if (!blocked) return;
    const modal = $('#adblock-modal');
    const dismiss = $('#adblock-dismiss');
    modal.hidden = false;
    dismiss.focus();
    dismiss.addEventListener('click', () => {
      modal.hidden = true;
      sessionStorage.setItem('nycalert-adblock-dismissed', '1');
    }, { once: true });
    modal.addEventListener('click', (event) => {
      if (event.target === modal) dismiss.click();
    }, { once: true });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !modal.hidden) dismiss.click();
    }, { once: true });
  }, 700);
}

initialize();
checkForAdBlocker();
