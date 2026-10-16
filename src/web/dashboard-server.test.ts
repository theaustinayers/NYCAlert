import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { DashboardStore } from '../services/dashboard-store.js';
import { AccountStore } from '../storage/account-store.js';
import { LearningLog } from '../services/learning-log.js';
import { SiteSettingsStore } from '../storage/site-settings-store.js';
import { IncidentVoteStore } from '../services/incident-vote-store.js';
import { DashboardServer } from './dashboard-server.js';

const testDirectory = await mkdtemp(join(tmpdir(), 'nyc-dashboard-server-'));
after(async () => rm(testDirectory, { recursive: true, force: true }));

async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a test port.');
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

describe('DashboardServer account routes', () => {
  it('serves a versioned paginated incident API for alternate dashboard templates', async () => {
    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    const store = new DashboardStore(false);
    const fire = await store.publish({
      title: 'Reported Fire', headline: 'Reported Fire', summary: 'Fire units responding.', occurredAt: new Date(),
      agency: 'FDNY', borough: 'Queens', category: 'newsworthy', callType: 'fire', incidentType: 'fire', confidence: 0.9, newsworthinessScore: 4
    });
    await store.publish({
      title: 'Medical Response', headline: 'Medical Response', summary: 'EMS units responding.', occurredAt: new Date(),
      agency: 'FDNY', borough: 'Brooklyn', category: 'newsworthy', callType: 'ems', incidentType: 'medical', confidence: 0.9, newsworthinessScore: 4
    });
    const server = new DashboardServer(store, port, '127.0.0.1', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, ['https://mdt.example.test']);
    await server.start();
    try {
      const page = await fetch(`${origin}/api/v1/incidents?callType=fire&borough=Queens&limit=1&offset=0`);
      assert.equal(page.status, 200);
      const result = await page.json() as { data: Array<{ id: string; callType: string }>; page: { total: number; hasMore: boolean } };
      assert.equal(result.data.length, 1);
      assert.equal(result.data[0]?.id, fire.id);
      assert.equal(result.data[0]?.callType, 'fire');
      assert.deepEqual(result.page, { limit: 1, offset: 0, total: 1, hasMore: false });
      const detail = await fetch(`${origin}/api/v1/incidents/${fire.id}`);
      assert.equal((await detail.json() as { data: { id: string } }).data.id, fire.id);
      const external = await fetch(`${origin}/api/v1/incidents?limit=1`, { headers: { Origin: 'https://mdt.example.test' } });
      assert.equal(external.headers.get('access-control-allow-origin'), 'https://mdt.example.test');
      assert.equal(external.headers.get('access-control-allow-credentials'), null);
      const preflight = await fetch(`${origin}/api/v1/incidents`, { method: 'OPTIONS', headers: { Origin: 'https://mdt.example.test' } });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
      const deniedPreflight = await fetch(`${origin}/api/v1/incidents`, { method: 'OPTIONS', headers: { Origin: 'https://unlisted.example.test' } });
      assert.equal(deniedPreflight.status, 403);
      const invalidType = await fetch(`${origin}/api/v1/incidents?callType=medical`);
      assert.equal(invalidType.status, 400);
    } finally { await server.stop(); }
  });

  it('serves the dedicated MDT incident stream template and assets', async () => {
    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    const server = new DashboardServer(new DashboardStore(false), port, '127.0.0.1');
    await server.start();
    try {
      const response = await fetch(`${origin}/mdt`);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, /DISPATCH<br>INFO/);
      assert.match(html, /PREMISE<br>INFO/);
      assert.match(html, /data-view="premise"/);
      assert.match(html, /COMMAND<br>HISTORY/);
      assert.match(html, /id="incident-stream"/);
      assert.match(html, /Copyright \(c\) 1989 - 2007/);
      assert.match(html, /Licensed to: City of New York Fire Department EMSCAD/);
      assert.match(html, /id="mdt-last-incident-age"/);
      assert.doesNotMatch(html, /data-call-type=/);
      assert.match(html, /data-view="dispatch"/);
      assert.match(html, /id="mdt-hold"/);
      assert.match(html, /id="mdt-logon"/);
      assert.match(html, /id="mdt-sound-toggle"/);
      assert.match(html, /id="mdt-incident-alert"/);
      assert.match(html, /src="\/fdny_mdt_run\.mp3"/);
      assert.match(html, /id="mdt-xmit-form"/);
      assert.match(html, /administrator, moderator, or reviewer account, to XMIT a community note/);
      assert.match(html, /id="mdt-refresh"[^>]*>XMIT/);
      assert.match(html, /administrator, moderator, or reviewer account, to XMIT a community note/);
      assert.match(html, /id="mdt-xmit"[^>]*>XMIT<\/button><time id="mdt-clock"/);
      assert.doesNotMatch(html, /id="mdt-last-sync"/);
      assert.doesNotMatch(html, /id="mdt-last-sync"/);
      assert.match(html, /id="mdt-logon-modal"/);
      assert.match(html, /value="Manhattan"/);
      assert.match(html, /value="FDNY"/);
      assert.match(html, /id="message-list-config"/);
      assert.match(html, /parser-assigned agency/);
      assert.match(html, /not an official FDNY system/);
      assert.match(html, /does not display Live Radio traffic, raw transcripts/);
      const stylesheet = await fetch(`${origin}/mdt.css`);
      assert.equal(stylesheet.status, 200);
      assert.match(await stylesheet.text(), /\.incident-stream/);
      const emscadStyles = await fetch(`${origin}/mdt-emscad.css`);
      assert.equal(emscadStyles.status, 200);
      const emscadStylesText = await emscadStyles.text();
      assert.match(emscadStylesText, /grid-template-columns:1\.3fr/);
      assert.match(emscadStylesText, /\.status-xmit/);
      assert.match(emscadStylesText, /\.mdt-status\.composer-visible>span:first-child\{display:none\}/);
      assert.match(emscadStylesText, /\.mdt-status\.composer-visible>span:first-child\{display:none\}/);
      assert.match(emscadStylesText, /\.mdt-status\{grid-column:1\/-1;grid-row:2;display:flex/);
      assert.match(emscadStylesText, /\.status-xmit\{order:2/);
      assert.match(emscadStylesText, /\.mdt-status time\{order:3/);
      assert.match(emscadStylesText, /\.mdt-status \.mdt-xmit-form\{order:1\}/);
      assert.match(emscadStylesText, /\.community-note-role\.buff/);
      const alertAudio = await fetch(`${origin}/fdny_mdt_run.mp3`);
      assert.equal(alertAudio.status, 200);
      assert.match(alertAudio.headers.get('content-type') ?? '', /audio\/mpeg/);
      assert.ok((await alertAudio.arrayBuffer()).byteLength > 0);
      const script = await fetch(`${origin}/mdt.js?v=mdt-emscad-20261015-15`);
      assert.equal(script.status, 200);
      const source = await script.text();
      const topLevelPrelude = source.split('function updateClock()')[0] ?? '';
      assert.doesNotMatch(topLevelPrelude, /\bvisible\s*=\s*entries\./);
      assert.doesNotMatch(source, /messageInput\.placeholder/);
      assert.match(source, /incidents-updated/);
      assert.match(source, /\/api\/v1\/incidents/);
      assert.match(source, /updateLastIncidentAge/);
      assert.match(source, /refreshLatestIncident/);
      assert.match(source, /Math\.random\(\) \* 2001/);
      assert.match(source, /if \(!state\.started \|\| state\.hold\) return/);
      assert.doesNotMatch(source, /OFFLINE|LIVE CONNECTION/);
      assert.doesNotMatch(source, /data-call-type/);
      assert.match(source, /if \(!state\.started \|\| state\.hold\) return/);
      assert.match(source, /state\.selectedBoroughs/);
      assert.match(source, /state\.selectedAgencies/);
      assert.match(source, /NEXT NEW CALL OR MATCHED UPDATE REPLACES THIS DISPLAY/);
      assert.match(source, /const incomingUpdates = incidents\.filter/);
      assert.match(source, /state\.dispatchIncidentId = latestChangedIncident\.id/);
      assert.match(source, /const incomingUpdates = incidents\.filter/);
      assert.match(source, /const canSubmit = state\.authSession\?\.kind === 'admin'/);
      assert.match(source, /state\.xmitPrompted/);
      assert.match(source, /nyc-alert-mdt-history-cleared-at/);
      assert.match(source, /COMMAND HISTORY CLEARED/);
      assert.match(source, /const canSubmit = state\.authSession\?\.kind === 'admin'/);
      assert.match(source, /matchesDispatchFilters\(incident\)/);
      assert.match(source, /function loadPremiseHistory/);
      assert.match(source, /normalizePremiseLocation\(incident\.location\)/);
      assert.match(source, /between\\b\.\*\$\/i/);
      assert.match(source, /Premise Info/);
      assert.match(source, /selectedBoroughs\.filter/);
      assert.match(source, /state\.hold = !state\.hold/);
      assert.match(source, /communityNotes/);
      assert.match(source, /\/api\/account\/incidents\//);
      assert.match(source, /box\.replace\(\/\^BOX/);
      assert.match(source, /play < 4/);
      assert.match(source, /function handleNewIncidents\(count\)/);
      assert.match(source, /function retryQueuedAudioAfterGesture\(\)/);
      assert.doesNotMatch(source, /toggleIncidentSound|ARM SOUND/);
      assert.match(source, /state\.hasLoadedSnapshot/);
      assert.match(source, /loadOlderIncidents/);
      assert.doesNotMatch(source, /\/api\/live-calls/);
    } finally { await server.stop(); }
  });

  it('serves versioned admin scripts without cache so deployed HTML and JavaScript stay in sync', async () => {
    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    const server = new DashboardServer(new DashboardStore(false), port, '127.0.0.1');
    await server.start();
    try {
      const home = await fetch(`${origin}/`);
      assert.equal(home.status, 200);
      const homeHtml = await home.text();
      assert.match(homeHtml, /href="https:\/\/discord\.gg\/gcfCBkMG8C"[^>]*>Join Our Discord<\/a>/);
      assert.match(homeHtml, /<span class="stat-label">REAL-TIME USERS<\/span>/);
      assert.match(homeHtml, /id="presence-total"/);
      assert.match(homeHtml, /id="presence-buff"/);
      assert.match(homeHtml, /id="presence-news"/);
      assert.match(homeHtml, /id="incident-popup-enabled"/);
      assert.match(homeHtml, /id="incident-arrival-ack"/);
      assert.match(homeHtml, /id="incident-arrival-scrim"/);
      assert.doesNotMatch(homeHtml, /id="call-type-filters"|data-call-type=/);
      assert.doesNotMatch(homeHtml, /MONITORING · AI-SELECTED SUMMARIES ONLY/);
      assert.match(homeHtml, /href="https:\/\/buymeacoffee\.com\/nycalert"[^>]*aria-label="Donate to NYC Alert on Buy Me a Coffee"/);
      assert.match(homeHtml, /SUPPORT NYC ALERT<\/span><strong>Donate<\/strong><span class="stat-caption">BUY ME A COFFEE/);
      assert.doesNotMatch(homeHtml, /ACTIVE AGENCIES/);
      assert.match(homeHtml, /DISCORD COMMUNITY<\/span><strong>1,800\+<\/strong>/);
      assert.doesNotMatch(homeHtml, /class="listen-link"|LISTEN ↗/);
      const dashboardScript = await fetch(`${origin}/app.js?v=dashboard-no-call-type-filters`);
      assert.equal(dashboardScript.status, 200);
      const dashboardSource = await dashboardScript.text();
      assert.doesNotMatch(dashboardSource, /callTypeFilter|initializeCallTypeFilters/);
      const page = await fetch(`${origin}/admin`);
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /\/admin\.js\?v=admin-call-types-private-usernames-20261015-2/);
      assert.match(html, /id="update-website"/);
      const wordmark = await fetch(`${origin}/nyc-alert-wordmark.svg`);
      assert.equal(wordmark.status, 200);
      assert.match(wordmark.headers.get('content-type') ?? '', /image\/svg\+xml/);
      assert.match(await wordmark.text(), /NYC Alert/);
      const script = await fetch(`${origin}/admin.js?v=admin-call-types-private-usernames-20261015-2`);
      assert.equal(script.status, 200);
      assert.equal(script.headers.get('cache-control'), 'no-store');
      const adminScript = await script.text();
      assert.match(adminScript, /async function loadOverview\(\)/);
      assert.match(adminScript, /Dashboard reconnecting during update/);
      const popupStyles = await fetch(`${origin}/incident-popup.css`);
      assert.equal(popupStyles.status, 200);
      assert.match(await popupStyles.text(), /incident-arrival-popup/);
      const callTypeStyles = await fetch(`${origin}/call-types.css`);
      assert.equal(callTypeStyles.status, 200);
      assert.match(await callTypeStyles.text(), /call-type-filter/);
      const webhookStyles = await fetch(`${origin}/webhooks.css`);
      assert.equal(webhookStyles.status, 200);
      const webhookStylesText = await webhookStyles.text();
      assert.match(webhookStylesText, /\.webhook-manager/);
      assert.match(webhookStylesText, /\.webhook-manager\[hidden\]\{display:none!important\}/);
      const communityStyles = await fetch(`${origin}/community-notes.css`);
      assert.equal(communityStyles.status, 200);
      assert.match(await communityStyles.text(), /\.community-note-role\.buff/);
    } finally { await server.stop(); }
  });

  it('requires administrator sign-in to list accounts and sets an HttpOnly session cookie', async () => {
    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    const accounts = new AccountStore(join(testDirectory, 'auth'));
    const server = new DashboardServer(new DashboardStore(false), port, '127.0.0.1', undefined, accounts, {
      publicUrl: origin,
      trustProxy: true,
      adminEmail: 'admin@example.test',
      adminPassword: 'test-admin-password-long'
    });
    await server.start();
    try {
      const denied = await fetch(`${origin}/api/admin/accounts`);
      assert.equal(denied.status, 401);
      assert.equal((await fetch(`${origin}/api/admin/overview`)).status, 401);
      assert.equal((await fetch(`${origin}/api/admin/analytics`)).status, 401);
      assert.equal((await fetch(`${origin}/api/admin/deployment-update`)).status, 401);
      const deniedInvite = await fetch(`${origin}/api/admin/administrators/invite`, {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName: 'New', lastName: 'Admin', email: 'new-admin@example.test' })
      });
      assert.equal(deniedInvite.status, 401);

      for (let attempt = 0; attempt < 6; attempt += 1) {
        const failedLogin = await fetch(`${origin}/api/auth/login`, {
          method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Forwarded-For': `198.51.100.${attempt}` },
          body: JSON.stringify({ email: 'unknown@example.test', password: 'wrong-password' })
        });
        assert.equal(failedLogin.status, 401);
      }
      const lockedLogin = await fetch(`${origin}/api/auth/login`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.77' },
        body: JSON.stringify({ email: 'unknown@example.test', password: 'wrong-password' })
      });
      assert.equal(lockedLogin.status, 429);

      const login = await fetch(`${origin}/api/auth/login`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@example.test', password: 'test-admin-password-long' })
      });
      assert.equal(login.status, 200);
      assert.equal((await login.json() as { session: { kind: string } }).session.kind, 'admin');
      const cookieHeader = login.headers.get('set-cookie');
      assert.match(cookieHeader ?? '', /HttpOnly/);
      assert.match(cookieHeader ?? '', /SameSite=Strict/);
      const cookie = cookieHeader?.split(';')[0];
      assert.ok(cookie);

      const listed = await fetch(`${origin}/api/admin/accounts`, { headers: { Cookie: cookie } });
      assert.equal(listed.status, 200);
      assert.deepEqual((await listed.json() as { accounts: unknown[] }).accounts, []);
      const updateNotInstalled = await fetch(`${origin}/api/admin/deployment-update`, { headers: { Cookie: cookie } });
      assert.equal(updateNotInstalled.status, 503);
      const mailRequired = await fetch(`${origin}/api/admin/administrators/invite`, {
        method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName: 'New', lastName: 'Admin', email: 'new-admin@example.test' })
      });
      assert.equal(mailRequired.status, 503);

      const deniedInternalHook = await fetch(`${origin}/api/admin/webhooks`, {
        method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: 'a'.repeat(32), name: 'Internal target', url: 'https://127.0.0.1/admin', boroughs: 'all' })
      });
      assert.equal(deniedInternalHook.status, 400);
    } finally {
      await server.stop();
    }
  });

  it('saves dashboard preferences only for the authenticated account and same origin', async () => {
    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    const accounts = new AccountStore(join(testDirectory, 'saved-dashboard-preferences'));
    await accounts.init();
    const registered = await accounts.register({
      username: 'preference_user',
      firstName: 'Preference', lastName: 'Tester', email: 'saved-preferences@example.test', phone: '2125550100',
      usageCase: 'Testing persistent dashboard selections.', accountType: 'news', password: 'Strong-test-password-123'
    });
    const verified = await accounts.verifyEmail(registered.verificationToken);
    await accounts.updateAccount(verified.id, { status: 'approved' });
    const server = new DashboardServer(new DashboardStore(false), port, '127.0.0.1', undefined, accounts, {
      publicUrl: origin, trustProxy: true
    });
    await server.start();
    try {
      const anonymous = await fetch(`${origin}/api/account/preferences`, {
        method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ preferences: {} })
      });
      assert.equal(anonymous.status, 401);

      const login = await fetch(`${origin}/api/auth/login`, {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: verified.email, password: 'Strong-test-password-123' })
      });
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie')?.split(';')[0];
      assert.ok(cookie);

      const crossOrigin = await fetch(`${origin}/api/account/preferences`, {
        method: 'PUT', headers: { Cookie: cookie, Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences: { audience: 'public' } })
      });
      assert.equal(crossOrigin.status, 403);

      const expected = {
        boroughs: ['Brooklyn', 'Queens'], audience: 'news', agency: 'FDNY', sortMode: 'priority', view: 'live',
        liveCategories: ['newsworthy', 'weird_unique']
      };
      const saved = await fetch(`${origin}/api/account/preferences`, {
        method: 'PUT', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences: expected })
      });
      assert.equal(saved.status, 200);
      assert.deepEqual((await saved.json() as { preferences: unknown }).preferences, expected);
      const loaded = await fetch(`${origin}/api/account/preferences`, { headers: { Cookie: cookie } });
      assert.deepEqual((await loaded.json() as { preferences: unknown }).preferences, expected);
    } finally { await server.stop(); }
  });

  it('keeps first and last names out of public sessions and allows same-origin username changes', async () => {
    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    const accounts = new AccountStore(join(testDirectory, 'private-account-profile'));
    await accounts.init();
    const registered = await accounts.register({ username: 'public_initial', firstName: 'Private', lastName: 'Example', email: 'private-profile@example.test', phone: '2125550100', usageCase: 'Testing username profile privacy.', accountType: 'buff', password: 'Strong-test-password-123' });
    const verified = await accounts.verifyEmail(registered.verificationToken);
    await accounts.updateAccount(verified.id, { status: 'approved' });
    const server = new DashboardServer(new DashboardStore(false), port, '127.0.0.1', undefined, accounts, {
      publicUrl: origin, trustProxy: true
    });
    await server.start();
    try {
      const unauthorized = await fetch(`${origin}/api/account/profile`);
      assert.equal(unauthorized.status, 401);
      const login = await fetch(`${origin}/api/auth/login`, {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: verified.email, password: 'Strong-test-password-123' })
      });
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie')?.split(';')[0];
      assert.ok(cookie);
      const session = await fetch(`${origin}/api/auth/session`, { headers: { Cookie: cookie } });
      const sessionBody = await session.text();
      assert.match(sessionBody, /public_initial/);
      assert.doesNotMatch(sessionBody, /firstName|lastName|Private|Example/);
      assert.deepEqual(await (await fetch(`${origin}/api/account/profile`, { headers: { Cookie: cookie } })).json(), { username: 'public_initial' });

      const crossOrigin = await fetch(`${origin}/api/account/profile`, {
        method: 'PUT', headers: { Cookie: cookie, Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'new_handle' })
      });
      assert.equal(crossOrigin.status, 403);
      const updated = await fetch(`${origin}/api/account/profile`, {
        method: 'PUT', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'New_Handle' })
      });
      assert.equal(updated.status, 200);
      assert.deepEqual(await updated.json(), { username: 'New_Handle' });
      assert.equal((await fetch(`${origin}/api/auth/session`, { headers: { Cookie: cookie } }).then((response) => response.text())).includes('Private'), false);
      assert.equal(accounts.listAdminAccounts().find((account) => account.id === verified.id)?.firstName, 'Private');
    } finally { await server.stop(); }
  });

  it('accepts attributed XMIT community notes only from approved Buff or News Media accounts', async () => {
    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    const accounts = new AccountStore(join(testDirectory, 'community-note-auth'));
    await accounts.init();
    const registered = await accounts.register({
      username: 'trusted_buff', firstName: 'Private', lastName: 'Name', email: 'community-note@example.test',
      phone: '2125550100', usageCase: 'Testing authenticated incident community notes.', accountType: 'buff', password: 'Strong-test-password-123'
    });
    const verified = await accounts.verifyEmail(registered.verificationToken);
    await accounts.updateAccount(verified.id, { status: 'approved' });
    const store = new DashboardStore(false);
    const incident = await store.publish({
      title: 'Working Fire', headline: 'Working Fire', summary: 'Published incident summary.', occurredAt: new Date(),
      agency: 'FDNY', borough: 'Brooklyn', category: 'newsworthy', confidence: 0.9, newsworthinessScore: 4
    });
    const initialUpdatedAt = incident.updatedAt;
    const server = new DashboardServer(store, port, '127.0.0.1', undefined, accounts, {
      publicUrl: origin, trustProxy: true, adminEmail: 'community-admin@example.test', adminPassword: 'community-admin-password-long',
    });
    await server.start();
    try {
      const endpoint = `${origin}/api/account/incidents/${incident.id}/community-notes`;
      const anonymous = await fetch(endpoint, {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Anonymous note' })
      });
      assert.equal(anonymous.status, 401);

      const login = await fetch(`${origin}/api/auth/login`, {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: verified.email, password: 'Strong-test-password-123' })
      });
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie')?.split(';')[0];
      assert.ok(cookie);

      const crossOrigin = await fetch(endpoint, {
        method: 'POST', headers: { Origin: 'https://attacker.example', Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Cross-origin note' })
      });
      assert.equal(crossOrigin.status, 403);
      const response = await fetch(endpoint, {
        method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'spoofed_name', audience: 'news', message: 'I observed a community detail.' })
      });
      assert.equal(response.status, 201);
      const { note } = await response.json() as { note: { id: string; username: string; audience: string; message: string; createdAt: string } };
      assert.equal(note.username, 'trusted_buff');
      assert.equal(note.audience, 'buff');
      assert.equal(note.message, 'I observed a community detail.');
      assert.ok(Number.isFinite(Date.parse(note.createdAt)));
      const publicIncident = await fetch(`${origin}/api/v1/incidents/${incident.id}`);
      const data = await publicIncident.json() as { data: { updateCount: number; updatedAt: string; communityNotes: unknown[] } };
      assert.equal(data.data.communityNotes.length, 1);
      assert.equal(data.data.updateCount, 0);
      assert.equal(data.data.updatedAt, initialUpdatedAt);

      const adminLogin = await fetch(`${origin}/api/auth/login`, {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'community-admin@example.test', password: 'community-admin-password-long' })
      });
      assert.equal(adminLogin.status, 200);
      const adminCookie = adminLogin.headers.get('set-cookie')?.split(';')[0];
      assert.ok(adminCookie);
      const adminNoteResponse = await fetch(endpoint, {
        method: 'POST', headers: { Origin: origin, Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Staff follow-up from admin.' })
      });
      assert.equal(adminNoteResponse.status, 201);
      const adminNote = (await adminNoteResponse.json() as { note: { username: string; role: string } }).note;
      assert.equal(adminNote.username, 'owner');
      assert.equal(adminNote.role, 'owner');
      const afterAdminNote = await fetch(`${origin}/api/v1/incidents/${incident.id}`);
      const afterAdminData = await afterAdminNote.json() as { data: { updateCount: number; communityNotes: unknown[] } };
      assert.equal(afterAdminData.data.communityNotes.length, 2);
      assert.equal(afterAdminData.data.updateCount, 0);
    } finally { await server.stop(); }
  });

  it('allows approved accounts to manage secret Discord and Slack endpoints and lets admins suspend delivery', async () => {
    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    const accounts = new AccountStore(join(testDirectory, 'account-webhook-routes'));
    await accounts.init();
    const registered = await accounts.register({
      username: 'webhook_user',
      firstName: 'Webhook', lastName: 'Account', email: 'webhook-routes@example.test', phone: '2125550100',
      usageCase: 'Testing webhook management routes.', accountType: 'news', password: 'Strong-test-password-123'
    });
    const verified = await accounts.verifyEmail(registered.verificationToken);
    await accounts.updateAccount(verified.id, { status: 'approved' });
    const server = new DashboardServer(new DashboardStore(false), port, '127.0.0.1', undefined, accounts, {
      publicUrl: origin, trustProxy: true, adminEmail: 'admin-webhooks@example.test', adminPassword: 'test-admin-password-long'
    });
    await server.start();
    try {
      const login = await fetch(`${origin}/api/auth/login`, {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: verified.email, password: 'Strong-test-password-123' })
      });
      assert.equal(login.status, 200);
      const userCookie = login.headers.get('set-cookie')?.split(';')[0];
      assert.ok(userCookie);

      const missingOrigin = await fetch(`${origin}/api/account/webhooks`, {
        method: 'POST', headers: { Cookie: userCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'No origin', platform: 'discord', url: 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwx', boroughs: 'all' })
      });
      assert.equal(missingOrigin.status, 403);
      const invalidHost = await fetch(`${origin}/api/account/webhooks`, {
        method: 'POST', headers: { Origin: origin, Cookie: userCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Wrong host', platform: 'discord', url: 'https://discord.com.evil.example/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwx', boroughs: 'all' })
      });
      assert.equal(invalidHost.status, 400);

      const secret = 'abcdefghijklmnopqrstuvwx';
      const created = await fetch(`${origin}/api/account/webhooks`, {
        method: 'POST', headers: { Origin: origin, Cookie: userCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Queens Discord', platform: 'discord', url: `https://discord.com/api/webhooks/123456789012345678/${secret}`, boroughs: ['Queens'] })
      });
      assert.equal(created.status, 201);
      const webhookId = (await created.json() as { webhook: { id: string } }).webhook.id;
      const session = await fetch(`${origin}/api/auth/session`, { headers: { Cookie: userCookie } });
      assert.equal((await session.text()).includes(secret), false);
      assert.equal(accounts.listWebhookTargets('Queens', 'news').length, 1);

      const adminLogin = await fetch(`${origin}/api/auth/login`, {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin-webhooks@example.test', password: 'test-admin-password-long' })
      });
      assert.equal(adminLogin.status, 200);
      const adminCookie = adminLogin.headers.get('set-cookie')?.split(';')[0];
      assert.ok(adminCookie);
      const adminList = await fetch(`${origin}/api/admin/webhooks`, { headers: { Cookie: adminCookie } });
      assert.equal((await adminList.text()).includes(secret), false);
      const suspended = await fetch(`${origin}/api/admin/webhooks/${verified.id}/${webhookId}`, {
        method: 'PATCH', headers: { Origin: origin, Cookie: adminCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ suspended: true })
      });
      assert.equal(suspended.status, 200);
      assert.equal(accounts.listWebhookTargets('Queens', 'news').length, 0);
      const accessSuspended = await fetch(`${origin}/api/admin/accounts/${verified.id}`, {
        method: 'PATCH', headers: { Origin: origin, Cookie: adminCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ webhookAccessSuspended: true })
      });
      assert.equal(accessSuspended.status, 200);
      const blockedCreate = await fetch(`${origin}/api/account/webhooks`, {
        method: 'POST', headers: { Origin: origin, Cookie: userCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Blocked', platform: 'slack', url: 'https://hooks.slack.com/services/T12345678/B12345678/abcdefghijklmnopqrstuvwxyz', boroughs: 'all' })
      });
      assert.equal(blockedCreate.status, 400);
      const removed = await fetch(`${origin}/api/account/webhooks/${webhookId}`, { method: 'DELETE', headers: { Origin: origin, Cookie: userCookie } });
      assert.equal(removed.status, 200);
    } finally { await server.stop(); }
  });

  it('reports aggregate active users and derives audience counts from authenticated sessions', async () => {
    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    const accounts = new AccountStore(join(testDirectory, 'active-presence'));
    await accounts.init();
    for (const accountType of ['buff', 'news'] as const) {
      const registered = await accounts.register({
        username: `presence_${accountType}`,
        firstName: 'Presence', lastName: accountType, email: `presence-${accountType}@example.test`, phone: '2125550100',
        usageCase: 'Testing real-time active audience counts.', accountType, password: 'Strong-test-password-123'
      });
      const verified = await accounts.verifyEmail(registered.verificationToken);
      await accounts.updateAccount(verified.id, { status: 'approved' });
    }
    const server = new DashboardServer(new DashboardStore(false), port, '127.0.0.1', undefined, accounts, {
      publicUrl: origin, trustProxy: true
    });
    await server.start();
    try {
      const cookies: Record<'buff' | 'news', string> = { buff: '', news: '' };
      for (const accountType of ['buff', 'news'] as const) {
        const login = await fetch(`${origin}/api/auth/login`, {
          method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: `presence-${accountType}@example.test`, password: 'Strong-test-password-123' })
        });
        assert.equal(login.status, 200);
        cookies[accountType] = login.headers.get('set-cookie')?.split(';')[0] ?? '';
      }
      const heartbeat = async (browserToken: string, cookie?: string, spoofAudience?: string) => fetch(`${origin}/api/presence`, {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: JSON.stringify({ browserToken, audience: spoofAudience })
      });
      assert.equal((await heartbeat('00000000-0000-4000-8000-000000000101')).status, 200);
      assert.equal((await heartbeat('00000000-0000-4000-8000-000000000102', cookies.buff, 'news')).status, 200);
      const newsPresence = await heartbeat('00000000-0000-4000-8000-000000000103', cookies.news, 'buff');
      assert.deepEqual((await newsPresence.json() as { counts: unknown }).counts, { total: 3, buff: 1, newsMedia: 1 });

      const crossOrigin = await fetch(`${origin}/api/presence`, {
        method: 'POST', headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
        body: JSON.stringify({ browserToken: '00000000-0000-4000-8000-000000000104' })
      });
      assert.equal(crossOrigin.status, 403);
      assert.equal((await fetch(`${origin}/api/presence`)).status, 405);
    } finally { await server.stop(); }
  });

  it('allows only same-origin administrators to publish an X test post and returns a diagnostic on failure', async () => {
    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    const accounts = new AccountStore(join(testDirectory, 'x-test-admin'));
    let failTestPost = false;
    let postCount = 0;
    const xTester = {
      async publishTestPost() {
        postCount += 1;
        if (failTestPost) throw new Error('X create-post request failed (HTTP 403): write permission denied.');
        return { postId: '123456789', text: 'NYC Alert X integration test.', url: 'https://x.com/i/web/status/123456789' };
      }
    };
    const server = new DashboardServer(new DashboardStore(false), port, '127.0.0.1', undefined, accounts, {
      publicUrl: origin,
      trustProxy: false,
      adminEmail: 'x-admin@example.test',
      adminPassword: 'test-x-admin-password'
    }, undefined, undefined, undefined, xTester);
    await server.start();
    try {
      const denied = await fetch(`${origin}/api/admin/x-test`, { method: 'POST', headers: { Origin: origin } });
      assert.equal(denied.status, 401);
      assert.equal(postCount, 0);

      const login = await fetch(`${origin}/api/auth/login`, {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'x-admin@example.test', password: 'test-x-admin-password' })
      });
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie')?.split(';')[0];
      assert.ok(cookie);

      const crossOrigin = await fetch(`${origin}/api/admin/x-test`, {
        method: 'POST', headers: { Origin: 'https://evil.example', Cookie: cookie }
      });
      assert.equal(crossOrigin.status, 403);
      assert.equal(postCount, 0);

      const succeeded = await fetch(`${origin}/api/admin/x-test`, {
        method: 'POST', headers: { Origin: origin, Cookie: cookie }
      });
      assert.equal(succeeded.status, 200);
      assert.equal((await succeeded.json() as { url: string }).url, 'https://x.com/i/web/status/123456789');
      assert.equal(postCount, 1);

      failTestPost = true;
      const failed = await fetch(`${origin}/api/admin/x-test`, {
        method: 'POST', headers: { Origin: origin, Cookie: cookie }
      });
      assert.equal(failed.status, 502);
      assert.match((await failed.json() as { error: string }).error, /write permission denied/);
      assert.equal(postCount, 2);
    } finally { await server.stop(); }
  });

  it('sends the branded verification email through the configured PHP mail provider', async () => {
    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    const accounts = new AccountStore(join(testDirectory, 'php-mail-auth'));
    const sentEmails: Array<{ to: string; from: string; subject: string; text: string; html: string }> = [];
    const server = new DashboardServer(new DashboardStore(false), port, '127.0.0.1', undefined, accounts, {
      publicUrl: origin,
      trustProxy: false,
      sendEmail: async (message) => { sentEmails.push(message); }
    });
    await server.start();
    try {
      const response = await fetch(`${origin}/api/auth/register`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'taylor_public', firstName: 'Taylor', lastName: 'Example', email: 'taylor@example.test', phone: '2125550100',
          usageCase: 'Testing account verification email delivery.', accountType: 'buff', password: 'strong-password-123'
        })
      });
      assert.equal(response.status, 201);
      assert.equal(sentEmails.length, 1);
      assert.equal(sentEmails[0]?.to, 'taylor@example.test');
      assert.equal(sentEmails[0]?.from, 'NYC Alert <noreply@nycalert.ai>');
      assert.equal(sentEmails[0]?.subject, 'Verify your NYC Alert account');
      assert.match(sentEmails[0]?.text ?? '', /NYC ALERT \| VERIFY YOUR EMAIL/);
      assert.match(sentEmails[0]?.text ?? '', /expires in 24 hours/);
      assert.match(sentEmails[0]?.html ?? '', /Confirm your email/);
      assert.match(sentEmails[0]?.html ?? '', /Hello taylor_public/);
    } finally {
      await server.stop();
    }
  });

  it('broadcasts incident changes over SSE so open dashboards can update map pins in place', async () => {
    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    const dashboardStore = new DashboardStore(false);
    const server = new DashboardServer(dashboardStore, port, '127.0.0.1');
    await server.start();
    try {
      const response = await fetch(`${origin}/api/events`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
      const reader = response.body!.getReader();
      await dashboardStore.recordLiveCall({
        sourceId: 'sse-test-call', occurredAt: new Date(), agency: 'FDNY', borough: 'Manhattan',
        transcript: 'Engine 1 responding.', category: 'routine', summary: 'Routine unit response.',
        confidence: 0.8, newsworthinessScore: 1
      });
      dashboardStore.recordFeedCallActivity('FDNY', 'Manhattan');
      dashboardStore.setFeedCallAlert('FDNY', 'Manhattan', 'newsworthy');
      await dashboardStore.publish({
        title: 'Test Fire', summary: 'A test event.', occurredAt: new Date(), agency: 'FDNY', borough: 'Manhattan',
        category: 'newsworthy', location: '123 Main Street', latitude: 40.75, longitude: -73.98,
        confidence: 0.9, newsworthinessScore: 4
      });
      let received = '';
      for (let attempt = 0; attempt < 5 && (!received.includes('event: live-calls-updated') || !received.includes('event: feeds-updated') || !received.includes('event: incidents-updated')); attempt += 1) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += new TextDecoder().decode(chunk.value);
      }
      assert.match(received, /event: live-calls-updated/);
      assert.match(received, /event: feeds-updated/);
      assert.match(received, /event: incidents-updated/);
      await reader.cancel();
    } finally {
      await server.stop();
    }
  });

  it('exports and clears transcript learning data only for a same-origin administrator session', async () => {
    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    const accountStore = new AccountStore(join(testDirectory, 'learning-admin'));
    const learningLog = new LearningLog(join(testDirectory, 'learning-data'), true, 30, 100);
    await learningLog.init();
    learningLog.record({
      eventId: 'evt-learning-test', callId: 'call-learning-test', occurredAt: new Date().toISOString(), loggedAt: new Date().toISOString(),
      stage: 'transcription', workflowPath: ['received', 'transcription'], agency: 'FDNY', feedBorough: 'Manhattan',
      transcript: 'Test transcript for admin export.', transcriptCharacters: 33, transcriptSource: 'local-whisper'
    });
    const server = new DashboardServer(new DashboardStore(false), port, '127.0.0.1', undefined, accountStore, {
      publicUrl: origin, trustProxy: false, adminEmail: 'learning-admin@example.test', adminPassword: 'test-learning-admin-password'
    }, undefined, learningLog);
    await server.start();
    try {
      const denied = await fetch(`${origin}/api/admin/learning-log/export`);
      assert.equal(denied.status, 401);
      const login = await fetch(`${origin}/api/auth/login`, {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'learning-admin@example.test', password: 'test-learning-admin-password' })
      });
      const cookie = login.headers.get('set-cookie')?.split(';')[0];
      assert.ok(cookie);
      const exported = await fetch(`${origin}/api/admin/learning-log/export`, { headers: { Cookie: cookie } });
      assert.equal(exported.status, 200);
      assert.match(exported.headers.get('content-type') ?? '', /application\/x-ndjson/);
      assert.match(await exported.text(), /Test transcript for admin export/);
      const crossOriginClear = await fetch(`${origin}/api/admin/learning-log`, {
        method: 'DELETE', headers: { Cookie: cookie, Origin: 'https://evil.example' }
      });
      assert.equal(crossOriginClear.status, 403);
      const cleared = await fetch(`${origin}/api/admin/learning-log`, {
        method: 'DELETE', headers: { Cookie: cookie, Origin: origin }
      });
      assert.equal(cleared.status, 200);
      assert.equal((await learningLog.exportJsonl()), '');
    } finally { await server.stop(); }
  });

  it('inserts saved Above Header Code with a matching CSP nonce and escapes provider verification tokens', async () => {
    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    const accountStore = new AccountStore(join(testDirectory, 'header-code-admin'));
    const settings = new SiteSettingsStore(join(testDirectory, 'header-code-settings'));
    await settings.init();
    await settings.update({
      googleSiteVerification: 'google_Token-1234',
      aboveHeaderCode: '<script>window.adConfig={enabled:true};</script><meta name="provider-test" content="verified">'
    });
    const server = new DashboardServer(new DashboardStore(false), port, '127.0.0.1', undefined, accountStore, {
      publicUrl: origin, trustProxy: false
    }, settings);
    await server.start();
    try {
      const response = await fetch(`${origin}/`);
      assert.equal(response.status, 200);
      const html = await response.text();
      const csp = response.headers.get('content-security-policy') ?? '';
      const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
      assert.ok(nonce);
      assert.match(html, new RegExp(`<script nonce="${nonce}"[^>]*>window\\.adConfig`));
      assert.match(html, /google-site-verification/);
      assert.match(html, /provider-test/);
      assert.ok(csp.includes(`'nonce-${nonce}'`));
    } finally { await server.stop(); }
  });

  it('renders incident-specific Open Graph and Twitter metadata before client JavaScript runs', async () => {
    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    const dashboardStore = new DashboardStore(false);
    const incident = await dashboardStore.publish({
      title: 'Alarm', headline: 'Reported Airport Valve Alarm', summary: 'Automatic valve alarm reported; no fire reported.',
      occurredAt: new Date(), agency: 'FDNY', borough: 'Queens', category: 'newsworthy',
      location: '407 John F. Kennedy Airport', confidence: 0.9, newsworthinessScore: 2
    });
    const server = new DashboardServer(dashboardStore, port, '127.0.0.1', undefined, undefined, {
      publicUrl: 'https://nycalert.ai', trustProxy: false
    });
    await server.start();
    try {
      const response = await fetch(`${origin}/incident/${incident.id}`);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, /<title>Reported Airport Valve Alarm — NYC Alert<\/title>/);
      assert.match(html, /property="og:title" content="Reported Airport Valve Alarm"/);
      assert.match(html, /property="og:description" content="Automatic valve alarm reported; no fire reported\. \| 407 John F\. Kennedy Airport \| FDNY · Queens"/);
      assert.match(html, new RegExp(`property="og:url" content="https://nycalert\\.ai/incident/${incident.id}"`));
      assert.match(html, /property="og:image" content="https:\/\/nycalert\.ai\/og-image\.png"/);
      assert.match(html, /name="twitter:card" content="summary_large_image"/);
      assert.match(html, /rel="canonical" href="https:\/\/nycalert\.ai\/incident\//);
      assert.match(html, /href="https:\/\/discord\.gg\/gcfCBkMG8C"[^>]*>Join Our Discord<\/a>/);
    } finally { await server.stop(); }
  });

  it('renders editable homepage Open Graph metadata and serves a rich public XML sitemap', async () => {
    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    const dashboardStore = new DashboardStore(false);
    const incident = await dashboardStore.publish({
      title: 'Reported Fire', headline: 'Reported Fire', summary: 'Fire reported.',
      occurredAt: new Date('2026-10-14T12:00:00.000Z'), agency: 'FDNY', borough: 'Queens', category: 'newsworthy',
      location: '123 Main Street', locationPrecision: 'street_address', confidence: 0.9, newsworthinessScore: 4
    });
    const settings = new SiteSettingsStore(join(testDirectory, 'open-graph-sitemap'));
    await settings.init();
    await settings.update({
      openGraphTitle: 'NYC Alert — Metro Desk',
      openGraphDescription: 'Accurate NYC incident updates & verified locations.',
      openGraphImage: '/social-card.jpg'
    });
    const server = new DashboardServer(dashboardStore, port, '127.0.0.1', undefined, undefined, {
      publicUrl: 'https://nycalert.ai', trustProxy: false
    }, settings);
    await server.start();
    try {
      const homepageResponse = await fetch(`${origin}/`);
      const homepage = await homepageResponse.text();
      assert.match(homepage, /<title>NYC Alert — Metro Desk<\/title>/);
      assert.match(homepage, /property="og:description" content="Accurate NYC incident updates &amp; verified locations\."/);
      assert.match(homepage, /property="og:image" content="https:\/\/nycalert\.ai\/social-card\.jpg"/);
      assert.match(homepage, /name="twitter:card" content="summary_large_image"/);

      const incidentResponse = await fetch(`${origin}/incident/${incident.id}`);
      assert.match(await incidentResponse.text(), /property="og:image" content="https:\/\/nycalert\.ai\/social-card\.jpg"/);

      const sitemapResponse = await fetch(`${origin}/sitemap.xml`);
      const sitemap = await sitemapResponse.text();
      assert.equal(sitemapResponse.headers.get('content-type'), 'application/xml; charset=utf-8');
      assert.match(sitemap, /<urlset[^>]+xmlns:image="http:\/\/www\.google\.com\/schemas\/sitemap-image\/1\.1"/);
      assert.match(sitemap, /<loc>https:\/\/nycalert\.ai\/<\/loc>/);
      assert.match(sitemap, new RegExp(`<loc>https://nycalert\\.ai/incident/${incident.id}<\\/loc>`));
      assert.match(sitemap, /<lastmod>2026-10-14T12:00:00\.000Z<\/lastmod>/);
      assert.match(sitemap, /<image:loc>https:\/\/nycalert\.ai\/social-card\.jpg<\/image:loc>/);
      assert.doesNotMatch(sitemap, /\/admin|\/api\//);

      const robotsResponse = await fetch(`${origin}/robots.txt`);
      assert.match(await robotsResponse.text(), /Sitemap: https:\/\/nycalert\.ai\/sitemap\.xml/);
    } finally { await server.stop(); }
  });

  it('records one vote per device and logs accepted incident feedback without device identifiers', async () => {
    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    const dashboardStore = new DashboardStore(false);
    const incident = await dashboardStore.publish({
      title: 'Reported Fire', headline: 'Reported Fire', summary: 'Fire reported.', occurredAt: new Date(),
      agency: 'FDNY', borough: 'Queens', category: 'newsworthy', incidentType: 'fire',
      confidence: 0.9, newsworthinessScore: 4, buffInterestScore: 5, assignmentDeskScore: 4
    });
    const routineIncident = await dashboardStore.publish({
      title: 'Routine Status', headline: 'Routine Status', summary: 'Routine radio status.', occurredAt: new Date(),
      agency: 'FDNY', borough: 'Queens', category: 'routine' as never,
      confidence: 0.95, newsworthinessScore: 1
    });
    const voteStore = new IncidentVoteStore(join(testDirectory, 'incident-votes-server'));
    await voteStore.init();
    const learningLog = new LearningLog(join(testDirectory, 'incident-vote-learning'), true, 30, 100);
    await learningLog.init();
    const server = new DashboardServer(dashboardStore, port, '127.0.0.1', undefined, undefined, undefined, undefined, learningLog, undefined, undefined, voteStore);
    const deviceId = 'd03d9d92-17bb-4eb8-9f20-09a6b4a12d6f';
    let eventReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    await server.start();
    try {
      const eventResponse = await fetch(`${origin}/api/events`);
      assert.equal(eventResponse.status, 200);
      eventReader = eventResponse.body!.getReader();
      await eventReader.read(); // Initial SSE retry directive.
      const denied = await fetch(`${origin}/api/incidents/${incident.id}/vote`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, vote: 'up' })
      });
      assert.equal(denied.status, 403);

      const vote = async (choice: 'up' | 'down') => fetch(`${origin}/api/incidents/${incident.id}/vote`, {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, vote: choice })
      });
      const accepted = await vote('up');
      assert.equal(accepted.status, 200);
      assert.deepEqual(await accepted.json(), { up: 1, down: 0, myVote: 'up', accepted: true, message: 'Vote recorded.' });
      const eventChunk = await eventReader.read();
      const eventText = new TextDecoder().decode(eventChunk.value);
      assert.match(eventText, /event: community-upvote/);
      assert.match(eventText, new RegExp(`\\"id\\":\\"${incident.id}\\"`));
      assert.match(eventText, /Reported Fire/);
      assert.doesNotMatch(eventText, new RegExp(deviceId));
      assert.doesNotMatch(eventText, /transcript|deviceId/i);
      const duplicate = await vote('down');
      assert.equal(duplicate.status, 200);
      assert.deepEqual(await duplicate.json(), { up: 1, down: 0, myVote: 'up', accepted: false, message: 'This device has already voted on this incident.' });

      const routineVote = await fetch(`${origin}/api/incidents/${routineIncident.id}/vote`, {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, vote: 'up' })
      });
      assert.equal(routineVote.status, 400);
      assert.match((await routineVote.json()).error, /Routine radio traffic is not eligible/);

      const incidents = await fetch(`${origin}/api/incidents?deviceId=${encodeURIComponent(deviceId)}`).then((response) => response.json());
      assert.deepEqual(incidents.incidents.find((item: { id: string }) => item.id === incident.id)?.votes, { up: 1, down: 0, myVote: 'up' });
      await learningLog.flush();
      const feedback = (await learningLog.readRecent(20)).find((event) => event.stage === 'incident-feedback');
      assert.equal(feedback?.feedbackVote, 'up');
      assert.equal(feedback?.incidentId, incident.id);
      assert.equal(JSON.stringify(feedback).includes(deviceId), false);
    } finally {
      await eventReader?.cancel();
      await server.stop();
      voteStore.close();
    }
  });

  it('rejects routine Live Radio votes and promotes only a strongly supported non-routine report', async () => {
    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    const dashboardStore = new DashboardStore(false);
    const occurredAt = new Date();
    const eligibleCall = await dashboardStore.recordLiveCall({
      sourceId: 'supported-newsworthy-source', occurredAt, agency: 'FDNY', borough: 'Queens',
      transcript: 'Reported gas odor.', category: 'newsworthy', incidentType: 'other', summary: 'Reported gas odor.',
      confidence: 0.9, newsworthinessScore: 3
    });
    const routineCall = await dashboardStore.recordLiveCall({
      sourceId: 'routine-source', occurredAt, agency: 'NYPD', borough: 'Citywide',
      transcript: 'Routine status.', category: 'routine', summary: 'Routine status.', confidence: 0.99, newsworthinessScore: 1
    });
    const voteStore = new IncidentVoteStore(join(testDirectory, 'live-call-vote-api'));
    await voteStore.init();
    const server = new DashboardServer(dashboardStore, port, '127.0.0.1', undefined, undefined, undefined, undefined, undefined, undefined, undefined, voteStore);
    await server.start();
    try {
      const vote = (callId: string, deviceId: string) => fetch(`${origin}/api/live-calls/${callId}/vote`, {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, vote: 'up' })
      });
      const routineResponse = await vote(routineCall.id, '00000000-0000-4000-8000-000000000001');
      assert.equal(routineResponse.status, 400);
      assert.deepEqual(voteStore.getLiveCallSummary(routineCall.id), { up: 0, down: 0, myVote: null });

      let finalVote: Response | undefined;
      for (let index = 1; index <= 10; index += 1) {
        finalVote = await vote(eligibleCall.id, `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
        assert.equal(finalVote.status, 200);
      }
      const result = await finalVote!.json() as { up: number; down: number; promoted: boolean; promotedIncidentId?: string };
      assert.equal(result.up, 10);
      assert.equal(result.down, 0);
      assert.equal(result.promoted, true);
      assert.ok(result.promotedIncidentId);
      const incident = dashboardStore.getIncident(result.promotedIncidentId!);
      assert.equal(incident?.communitySelected, true);
      assert.match(incident?.summary ?? '', /not incident verification/);
    } finally {
      await server.stop();
      voteStore.close();
    }
  });
});