const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const formatTime = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unavailable' : new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short'
  }).format(date);
};
let history = [];

function renderHistory() {
  const filter = $('#history-filter').value;
  const items = history.filter((item) => filter === 'all' || item.kind === filter);
  $('#user-history').innerHTML = items.length ? items.map((item) => {
    const link = item.targetKind === 'incident' && /^[0-9a-f-]{36}$/i.test(item.targetId)
      ? `<a href="/incident/${encodeURIComponent(item.targetId)}" target="_blank" rel="noopener noreferrer">Open incident ↗</a>`
      : '<span>Live Radio report (may no longer be available)</span>';
    const label = item.kind === 'note' ? 'COMMUNITY NOTE · UNVERIFIED' : item.kind === 'up' ? 'UPVOTE' : 'DOWNVOTE';
    return `<article class="user-activity"><header><strong>${label}</strong><time>${escapeHtml(formatTime(item.at))}</time></header><h3>${escapeHtml(item.title)}</h3>${item.kind === 'note' ? `<p>${escapeHtml(item.message)}</p>` : ''}${link}</article>`;
  }).join('') : '<p class="admin-muted">No recorded activity for this filter.</p>';
}

async function loadUser() {
  const id = new URLSearchParams(location.search).get('id') || '';
  if (!/^[a-f0-9]{32}$/i.test(id)) throw new Error('Invalid user ID. Open this page from the Users list.');
  const response = await fetch(`/api/admin/accounts/${encodeURIComponent(id)}/details`, { credentials: 'same-origin', cache: 'no-store' });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Could not load user details.');
  const account = result.account;
  $('#user-title').textContent = `@${account.username}`;
  const facts = [
    ['Username', account.username], ['Name', `${account.firstName} ${account.lastName}`],
    ['Email', account.email], ['Phone', account.phone], ['Account type', account.accountType],
    ['Outlet / Publication', account.newsOutlet || 'Not provided'], ['Intended use', account.usageCase],
    ['Status', account.status], ['Email verified', account.emailVerified ? 'Yes' : 'No'],
    ['Registered', formatTime(account.createdAt)],
    ['Community notes', account.communityUpdatesSuspended ? 'Suspended' : 'Enabled'],
    ['Webhook access', account.webhookAccessSuspended ? 'Suspended' : 'Enabled']
  ];
  $('#user-facts').innerHTML = facts.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value || 'Not provided')}</dd></div>`).join('');
  $('#user-logins').innerHTML = account.recentLogins.length ? account.recentLogins.map((login) => `<tr><td>${escapeHtml(formatTime(login.at))}</td><td>${escapeHtml(login.ip)}</td></tr>`).join('') : '<tr><td colspan="2">No successful logins recorded yet.</td></tr>';
  history = account.communityHistory || [];
  $('#history-notice').textContent = `${result.historyNotice} Showing the latest ${result.historyLimit} recorded actions at most.`;
  renderHistory();
  $('#user-content').hidden = false;
}

$('#history-filter').addEventListener('change', renderHistory);
void loadUser().catch((error) => {
  $('#user-content').hidden = true;
  $('#user-error').textContent = error.message;
  $('#user-error').hidden = false;
});