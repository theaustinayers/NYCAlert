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
      assert.match(html, /property="og:image" content="https:\/\/nycalert\.ai\/logo\.svg"/);
      assert.match(html, /name="twitter:card" content="summary_large_image"/);
      assert.match(html, /rel="canonical" href="https:\/\/nycalert\.ai\/incident\//);
    } finally { await server.stop(); }
  });
});