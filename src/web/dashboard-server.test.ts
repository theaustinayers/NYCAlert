import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createServer as createNetServer } from 'node:net';
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

async function smtpTestServer(): Promise<{ port: number; messages: string[]; close: () => Promise<void> }> {
  const messages: string[] = [];
  const server = createNetServer((socket) => {
    socket.setEncoding('utf8');
    socket.write('220 localhost ESMTP ready\r\n');
    let input = '';
    let readingData = false;
    let currentMessage = '';
    socket.on('data', (chunk) => {
      input += chunk;
      for (;;) {
        const end = input.indexOf('\r\n');
        if (end < 0) break;
        const line = input.slice(0, end);
        input = input.slice(end + 2);
        if (readingData) {
          if (line === '.') {
            messages.push(currentMessage);
            currentMessage = '';
            readingData = false;
            socket.write('250 queued\r\n');
          } else currentMessage += `${line}\n`;
          continue;
        }
        if (/^EHLO|^HELO/i.test(line)) socket.write('250-localhost\r\n250 8BITMIME\r\n');
        else if (/^MAIL FROM|^RCPT TO/i.test(line)) socket.write('250 OK\r\n');
        else if (/^DATA/i.test(line)) { readingData = true; socket.write('354 end with dot\r\n'); }
        else if (/^QUIT/i.test(line)) socket.end('221 bye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not start SMTP test server.');
  return {
    port: address.port,
    messages,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a test port.');
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

describe('DashboardServer account routes', () => {
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
      assert.match(homeHtml, /<span class="stat-label">MONITORING<\/span>/);
      assert.match(homeHtml, /<span class="stat-caption">AI-SELECTED SUMMARIES ONLY<\/span>/);
      assert.match(homeHtml, /href="https:\/\/buymeacoffee\.com\/nycalert"[^>]*aria-label="Donate to NYC Alert on Buy Me a Coffee"/);
      assert.match(homeHtml, /SUPPORT NYC ALERT<\/span><strong>Donate<\/strong><span class="stat-caption">BUY ME A COFFEE/);
      assert.doesNotMatch(homeHtml, /ACTIVE AGENCIES/);
      assert.match(homeHtml, /DISCORD COMMUNITY<\/span><strong>1,800\+<\/strong>/);
      assert.doesNotMatch(homeHtml, /class="listen-link"|LISTEN ↗/);
      const page = await fetch(`${origin}/admin`);
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /\/admin\.js\?v=admin-20261013-2/);
      assert.match(html, /id="update-website"/);
      const wordmark = await fetch(`${origin}/nyc-alert-wordmark.svg`);
      assert.equal(wordmark.status, 200);
      assert.match(wordmark.headers.get('content-type') ?? '', /image\/svg\+xml/);
      assert.match(await wordmark.text(), /NYC Alert/);
      const script = await fetch(`${origin}/admin.js?v=admin-20261013-2`);
      assert.equal(script.status, 200);
      assert.equal(script.headers.get('cache-control'), 'no-store');
      const adminScript = await script.text();
      assert.match(adminScript, /async function loadOverview\(\)/);
      assert.match(adminScript, /Dashboard reconnecting during update/);
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
      adminPassword: 'test-admin-password-long',
      smtpPort: 587,
      smtpSecure: false,
      smtpFrom: 'noreply@example.test'
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
      const smtpRequired = await fetch(`${origin}/api/admin/administrators/invite`, {
        method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName: 'New', lastName: 'Admin', email: 'new-admin@example.test' })
      });
      assert.equal(smtpRequired.status, 503);

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
      firstName: 'Preference', lastName: 'Tester', email: 'saved-preferences@example.test', phone: '2125550100',
      usageCase: 'Testing persistent dashboard selections.', accountType: 'news', password: 'Strong-test-password-123'
    });
    const verified = await accounts.verifyEmail(registered.verificationToken);
    await accounts.updateAccount(verified.id, { status: 'approved' });
    const server = new DashboardServer(new DashboardStore(false), port, '127.0.0.1', undefined, accounts, {
      publicUrl: origin, trustProxy: true, smtpPort: 587, smtpSecure: false, smtpFrom: 'noreply@example.test'
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
      adminPassword: 'test-x-admin-password',
      smtpPort: 587,
      smtpSecure: false,
      smtpFrom: 'noreply@example.test'
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

  it('sends the branded HTML verification email with NYC Alert sender identity', async () => {
    const smtp = await smtpTestServer();
    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    const accounts = new AccountStore(join(testDirectory, 'smtp-auth'));
    const server = new DashboardServer(new DashboardStore(false), port, '127.0.0.1', undefined, accounts, {
      publicUrl: origin,
      trustProxy: false,
      smtpHost: '127.0.0.1',
      smtpPort: smtp.port,
      smtpSecure: false,
      smtpFrom: 'NYC Alert <noreply@nycalert.ai>'
    });
    await server.start();
    try {
      const response = await fetch(`${origin}/api/auth/register`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName: 'Taylor', lastName: 'Example', email: 'taylor@example.test', phone: '2125550100',
          usageCase: 'Testing account verification email delivery.', accountType: 'buff', password: 'strong-password-123'
        })
      });
      assert.equal(response.status, 201);
      assert.equal(smtp.messages.length, 1);
      assert.match(smtp.messages[0]!, /From: NYC Alert <noreply@nycalert\.ai>/);
      assert.match(smtp.messages[0]!, /NYC ALERT \| VERIFY YOUR EMAIL/);
      assert.match(smtp.messages[0]!, /text\/html/);
      assert.match(smtp.messages[0]!, /Confirm your email/);
      assert.match(smtp.messages[0]!, /expires in 24 hours/);
    } finally {
      await server.stop();
      await smtp.close();
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
      await reader.read();
      const event = reader.read();
      await dashboardStore.publish({
        title: 'Test Fire', summary: 'A test event.', occurredAt: new Date(), agency: 'FDNY', borough: 'Manhattan',
        category: 'newsworthy', location: '123 Main Street', latitude: 40.75, longitude: -73.98,
        confidence: 0.9, newsworthinessScore: 4
      });
      const result = await event;
      assert.match(new TextDecoder().decode(result.value), /event: incidents-updated/);
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
      publicUrl: origin, trustProxy: false, adminEmail: 'learning-admin@example.test', adminPassword: 'test-learning-admin-password',
      smtpPort: 587, smtpSecure: false, smtpFrom: 'noreply@example.test'
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
      publicUrl: origin, trustProxy: false, smtpPort: 587, smtpSecure: false, smtpFrom: 'noreply@example.test'
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
      publicUrl: 'https://nycalert.ai', trustProxy: false, smtpPort: 587, smtpSecure: false, smtpFrom: 'noreply@nycalert.ai'
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
      publicUrl: 'https://nycalert.ai', trustProxy: false, smtpPort: 587, smtpSecure: false, smtpFrom: 'noreply@nycalert.ai'
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
    await server.start();
    try {
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