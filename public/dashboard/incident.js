const root = document.querySelector('#incident-detail');
const incidentId = location.pathname.split('/').filter(Boolean).at(-1) || '';
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Time unavailable';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: true, timeZoneName: 'short'
  }).format(date);
}

function formatClock() {
  const now = new Date();
  const clock = document.querySelector('#clock');
  const date = document.querySelector('#date-label');
  if (clock) clock.textContent = `${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(now)} ET`;
  if (date) date.textContent = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: '2-digit' }).format(now).toUpperCase();
}

async function initializeHeader(incident) {
  formatClock();
  setInterval(formatClock, 30_000);
  const ticker = document.querySelector('#incident-ticker-text');
  const label = document.querySelector('#incident-ticker-label');
  if (ticker) ticker.textContent = `${incident.summary || incident.title} | ${incident.borough}`;
  if (label) label.textContent = Number(incident.newsworthinessScore) >= 5 ? 'BREAKING NEWS:' : Number(incident.newsworthinessScore) >= 4 ? 'DEVELOPING:' : 'INCIDENT:';
  const tickerRoot = document.querySelector('#incident-ticker');
  tickerRoot?.classList.add(Number(incident.newsworthinessScore) >= 5 ? 'breaking' : 'newsworthy');
  try {
    const response = await fetch('/api/public-config', { cache: 'no-store' });
    if (!response.ok) return;
    const config = await response.json();
    initializeOptionalAnalytics(config.analytics || {});
  } catch { /* The incident report remains useful if public configuration is unavailable. */ }
}

function initializeOptionalAnalytics(settings) {
  const consentKey = 'nycalert-analytics-consent';
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
  const consent = localStorage.getItem(consentKey);
  if (consent === 'accepted') { activate(); return; }
  if (consent === 'declined') return;
  const banner = document.querySelector('#analytics-consent');
  if (!banner) return;
  banner.hidden = false;
  document.querySelector('#analytics-accept').addEventListener('click', () => {
    localStorage.setItem(consentKey, 'accepted');
    banner.hidden = true;
    activate();
  }, { once: true });
  document.querySelector('#analytics-decline').addEventListener('click', () => {
    localStorage.setItem(consentKey, 'declined');
    banner.hidden = true;
  }, { once: true });
}

function renderUnits(units) {
  return units.length
    ? `<div class="incident-units-list">${units.map((unit) => `<span class="incident-unit-chip">${escapeHtml(unit)}</span>`).join('')}</div>`
    : 'Not identified in radio traffic';
}

function renderCommunityNotes(notes) {
  const items = Array.isArray(notes) ? notes : [];
  if (!items.length) return;
  const section = document.createElement('section');
  section.className = 'incident-community-notes';
  section.setAttribute('aria-label', 'Unverified community notes');
  section.innerHTML = `<h2>Community notes <span>UNVERIFIED</span></h2><ol>${items.map((note) => `<li><div><time>${escapeHtml(formatTime(note.createdAt))}</time><strong>@${escapeHtml(note.username)}</strong></div><p>${escapeHtml(note.message)}</p><span class="community-note-role ${note.audience === 'buff' ? 'buff' : 'news'}">${note.audience === 'buff' ? 'BUFF' : 'NEWS MEDIA'}</span></li>`).join('')}</ol>`;
  root.append(section);
}

function renderMap(incident) {
  if (typeof incident.latitude !== 'number' || typeof incident.longitude !== 'number' || !window.L) {
    return '<div class="incident-map-unavailable">A verified map location is not available for this incident. No location is being inferred.</div>';
  }
  const validTypes = new Set(['medical', 'vehicle', 'fire', 'police', 'other']);
  const type = validTypes.has(incident.incidentType) ? incident.incidentType : 'other';
  const symbols = { medical: '✚', vehicle: '🚗', fire: '♨', police: '★', other: '•' };
  const label = { medical: 'Medical', vehicle: 'Vehicle incident', fire: 'Fire response', police: 'Police incident', other: 'Incident' };
  const map = L.map('incident-detail-map', { scrollWheelZoom: false, dragging: true }).setView([incident.latitude, incident.longitude], 15);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri, HERE, Garmin, (c) OpenStreetMap contributors, and the GIS community'
  }).addTo(map);
  const icon = L.divIcon({
    className: 'incident-map-div-icon',
    html: `<div class="incident-map-marker ${type}" role="img" aria-label="${label[type]}"><span>${symbols[type]}</span></div>`,
    iconSize: [38, 42],
    iconAnchor: [19, 39]
  });
  L.marker([incident.latitude, incident.longitude], { icon }).addTo(map).bindPopup(`<strong>${escapeHtml(incident.title)}</strong><br>${escapeHtml(incident.location || '')}`).openPopup();
  setTimeout(() => map.invalidateSize(), 0);
}

function render(incident) {
  const updates = Array.isArray(incident.updates) ? incident.updates : [];
  const units = Array.isArray(incident.unitIds) ? incident.unitIds : [];
  const unitAssignments = Array.isArray(incident.unitAssignments) ? incident.unitAssignments : [];
  const boxes = Array.isArray(incident.boxNumbers) ? incident.boxNumbers : [];
  const news = Number(incident.newsworthinessScore) || 1;
  const callType = ['fire', 'ems', 'pd'].includes(incident.callType) ? incident.callType
    : incident.incidentType === 'fire' ? 'fire' : incident.incidentType === 'medical' ? 'ems'
      : incident.incidentType === 'police' ? 'pd' : incident.incidentType === 'vehicle' ? (incident.agency === 'FDNY' ? 'fire' : 'pd') : '';
  const callTypeName = callType === 'fire' ? 'FIRE' : callType === 'ems' ? 'EMS' : callType === 'pd' ? 'PD' : '';
  const headline = String(incident.title || 'Incident').split(' | ')[0];
  const canonicalUrl = `${location.origin}/incident/${encodeURIComponent(incident.id)}`;
  root.innerHTML = `
    <article class="incident-detail-card">
      <header class="incident-detail-heading">
        <div class="incident-detail-meta"><span class="incident-severity ${news === 5 ? 'breaking' : news >= 4 ? 'developing' : ''}">${news === 5 ? 'BREAKING NEWS' : news >= 4 ? 'DEVELOPING' : 'INCIDENT'}</span>${callTypeName ? `<span class="call-type-badge call-type-${callType}">${callTypeName}</span>` : ''}<span>${escapeHtml(incident.agency)} · ${escapeHtml(incident.borough)}</span><time>${escapeHtml(formatTime(incident.updatedAt || incident.occurredAt))}</time></div>
        <h1 class="incident-headline">${escapeHtml(headline)}</h1>
        <p class="incident-detail-deck">${escapeHtml(incident.summary)}</p>
      </header>
      <section class="incident-detail-map-section" aria-label="Incident map"><span class="incident-detail-section-label">INCIDENT LOCATION</span><div id="incident-detail-map" class="incident-detail-map">${typeof incident.latitude === 'number' && typeof incident.longitude === 'number' ? '' : '<div class="incident-map-unavailable">A verified map location is not available for this incident. No location is being inferred.</div>'}</div></section>
      <dl class="incident-detail-facts">
        <div class="incident-fact incident-fact-wide"><dt>Address · ${escapeHtml(String(incident.locationPrecision || 'unresolved').replaceAll('_', ' '))}</dt><dd>${escapeHtml(incident.location || 'Not stated clearly in the transmission')}</dd></div>
        <div class="incident-fact ${boxes.length ? '' : 'incident-fact-wide'}"><dt>Units</dt><dd>${renderUnits(units)}${unitAssignments.length ? `<div class="incident-assignment-note">${unitAssignments.filter((assignment) => assignment.actingAsUnitId).map((assignment) => `${escapeHtml(assignment.unitId)} acting as ${escapeHtml(assignment.actingAsUnitId)}`).join(' · ')}</div>` : ''}</dd></div>
        ${boxes.length ? `<div class="incident-fact"><dt>FDNY Box</dt><dd><div class="incident-units-list">${boxes.map((box) => `<span class="incident-unit-chip incident-box-chip">${escapeHtml(box)}</span>`).join('')}</div></dd></div>` : ''}
      </dl>
      <section class="incident-detail-updates" aria-labelledby="updates-heading">
        <h2 id="updates-heading">All incident updates <span>${updates.length}</span></h2>
        ${updates.length ? `<ol class="incident-update-list">${updates.map((update) => `<li class="incident-update"><time>${escapeHtml(formatTime(update.occurredAt))}</time><div class="incident-update-title-row">${update.headline ? `<strong class="incident-update-headline">${escapeHtml(update.headline)}</strong>` : '<strong class="incident-update-headline">Radio update</strong>'}<span class="incident-update-agency" aria-label="Source agency: ${escapeHtml(update.agency || incident.agency)}">${escapeHtml(update.agency || incident.agency)}</span></div><p>${escapeHtml(update.summary)}</p>${update.unitIds?.length || update.boxNumbers?.length ? `<small>${update.unitIds?.length ? `Units: ${escapeHtml(update.unitIds.join(', '))}` : ''}${update.unitIds?.length && update.boxNumbers?.length ? ' · ' : ''}${update.boxNumbers?.length ? `Box: ${escapeHtml(update.boxNumbers.join(', '))}` : ''}</small>` : ''}</li>`).join('')}</ol>` : '<p class="incident-no-updates">No follow-up updates have been recorded yet.</p>'}
      </section>
      <section class="incident-audio-section" aria-label="Incident audio"><span class="incident-detail-section-label">RADIO AUDIO</span>${incident.hasAudio ? `<audio class="incident-audio-player" controls preload="none" src="/api/incidents/${encodeURIComponent(incident.id)}/audio">Audio playback is not supported.</audio>` : '<div class="incident-audio-unavailable">Audio playback is not available for this incident.</div>'}</section>
      <div class="incident-detail-share" aria-label="Share incident"><span class="incident-detail-section-label">SHARE</span><button class="incident-share-button" type="button" data-share-service="facebook" aria-label="Share incident on Facebook" title="Facebook">f</button><button class="incident-share-button" type="button" data-share-service="x" aria-label="Share incident on X" title="X">𝕏</button><button class="incident-share-button" type="button" id="copy-incident-link" aria-label="Copy incident URL" title="Copy URL"><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6.5" y="6.5" width="9" height="11" rx="1.5"></rect><path d="M13.5 6V4.5A1.5 1.5 0 0 0 12 3H5.5A1.5 1.5 0 0 0 4 4.5v9A1.5 1.5 0 0 0 5.5 15H6"></path></svg></button><span class="incident-copy-feedback" id="copy-feedback" role="status" aria-live="polite"></span></div>
    </article>`;
  renderCommunityNotes(incident.communityNotes);
  document.title = `${headline} — NYC Alert`;
  document.querySelector('meta[name="description"]')?.setAttribute('content', `${incident.summary} ${headline}`.slice(0, 250));
  document.querySelector('meta[property="og:title"]')?.setAttribute('content', headline);
  document.querySelector('meta[property="og:description"]')?.setAttribute('content', incident.summary);
  document.querySelector('meta[property="og:url"]')?.setAttribute('content', canonicalUrl);
  document.querySelector('link[rel="canonical"]')?.setAttribute('href', canonicalUrl);
  renderMap(incident);
  void initializeHeader(incident);
  document.querySelectorAll('[data-share-service]').forEach((button) => button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const service = button.dataset.shareService;
    const shareUrl = service === 'facebook'
      ? `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(canonicalUrl)}`
      : `https://twitter.com/intent/tweet?url=${encodeURIComponent(canonicalUrl)}&text=${encodeURIComponent(headline)}`;
    window.open(shareUrl, '_blank', 'noopener,noreferrer');
  }));
  document.querySelector('#copy-incident-link').addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const feedback = document.querySelector('#copy-feedback');
    try {
      await navigator.clipboard.writeText(canonicalUrl);
      feedback.textContent = 'Link copied';
    } catch {
      feedback.textContent = canonicalUrl;
    }
  });
}

async function loadIncident() {
  formatClock();
  if (!/^[0-9a-f-]{36}$/i.test(incidentId)) {
    root.innerHTML = '<div class="incident-not-found">This incident link is invalid.</div>';
    return;
  }
  try {
    const response = await fetch(`/api/incidents/${encodeURIComponent(incidentId)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Incident not found');
    const data = await response.json();
    if (!data.incident) throw new Error('Incident not found');
    render(data.incident);
  } catch {
    root.innerHTML = '<div class="incident-not-found"><h1>Incident unavailable</h1><p>This incident may have expired or the alert service may have restarted. Return to the public desk for current incidents.</p></div>';
  }
}

void loadIncident();
