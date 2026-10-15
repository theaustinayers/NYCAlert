import { createReadStream } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { createTransport } from 'nodemailer';
import { isAgency, isBorough, type Agency, type Borough } from '../domain/subscriptions.js';
import { dashboardFeedLinks } from '../providers/broadcastify-catalog.js';
import type { DashboardStore } from '../services/dashboard-store.js';
import type { AccountStore, AccountStatus, AccountWebhook, AudienceAccountType } from '../storage/account-store.js';
import type { SiteSettings, SiteSettingsStore } from '../storage/site-settings-store.js';
import type { LearningLog } from '../services/learning-log.js';
import type { DeploymentUpdater } from '../services/deployment-updater.js';
import type { XIntegrationTester } from '../providers/x-post.js';
import { isIncidentVote, type IncidentVoteStore } from '../services/incident-vote-store.js';
import { communityPromotionThreshold, qualifiesForCommunityPromotion } from '../services/community-promotion.js';
import { ActivePresence } from '../services/active-presence.js';
import { logger } from '../logger.js';

export interface DashboardAuthConfig {
  publicUrl: string;
  trustProxy: boolean;
  adminEmail?: string;
  adminPassword?: string;
  smtpHost?: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUsername?: string;
  smtpPassword?: string;
  smtpFrom: string;
}

const sessionCookie = 'nycalert_session';
const sessionMaxAgeSeconds = 12 * 60 * 60;

const staticFiles = new Map<string, [string, string]>([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/live.css', ['live.css', 'text/css; charset=utf-8']],
  ['/live-overflow.css', ['live-overflow.css', 'text/css; charset=utf-8']],
  ['/map.css', ['map.css', 'text/css; charset=utf-8']],
  ['/activity.css', ['activity.css', 'text/css; charset=utf-8']],
  ['/mobile.css', ['mobile.css', 'text/css; charset=utf-8']],
  ['/incident.css', ['incident.css', 'text/css; charset=utf-8']],
  ['/incident.js', ['incident.js', 'text/javascript; charset=utf-8']],
  ['/admin.css', ['admin.css', 'text/css; charset=utf-8']],
  ['/admin-learning.css', ['admin-learning.css', 'text/css; charset=utf-8']],
  ['/admin.js', ['admin.js', 'text/javascript; charset=utf-8']],
  ['/admin', ['admin.html', 'text/html; charset=utf-8']],
  ['/leaflet.css', ['../../node_modules/leaflet/dist/leaflet.css', 'text/css; charset=utf-8']],
  ['/leaflet.js', ['../../node_modules/leaflet/dist/leaflet.js', 'text/javascript; charset=utf-8']],
  ['/nyc-alert-wordmark.svg', ['nyc-alert-wordmark.svg', 'image/svg+xml']],
  ['/og-image.png', ['og-image.png', 'image/png']],
  ['/logo.svg', ['../../nycalert.svg', 'image/svg+xml']]
]);

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(body));
}

function setSecurityHeaders(response: ServerResponse, nonce: string): void {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Content-Security-Policy', `default-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self' 'nonce-${nonce}' https://www.googletagmanager.com https://connect.facebook.net https://pagead2.googlesyndication.com https://www.google.com; img-src 'self' data: https://*.tile.openstreetmap.org https://*.basemaps.cartocdn.com https://server.arcgisonline.com https://www.facebook.com https://*.google.com https://*.googleusercontent.com; media-src 'self'; connect-src 'self' https://www.google-analytics.com https://region1.google-analytics.com https://www.facebook.com https://pagead2.googlesyndication.com https://*.google.com; frame-src https://googleads.g.doubleclick.net https://tpc.googlesyndication.com https://www.google.com; base-uri 'self'; frame-ancestors 'none'`);
}

function selectedBoroughs(searchParams: URLSearchParams): Borough[] | undefined {
  if (!searchParams.has('borough')) return undefined;
  const values = searchParams.getAll('borough');
  if (values.includes('none')) return [];
  return values.filter(isBorough);
}

function boroughMatches(value: Borough | 'Citywide', selected?: Borough[]): boolean {
  if (selected === undefined) return true;
  if (selected.length === 0) return false;
  return value === 'Citywide' || selected.includes(value);
}

function validVoteDeviceId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : undefined;
}

export class DashboardServer {
  private server?: ReturnType<typeof createServer>;
  private readonly eventClients = new Set<ServerResponse>();
  private unsubscribeIncidentChanges?: () => void;
  private unsubscribeLiveCallChanges?: () => void;
  private readonly authRateLimits = new Map<string, { count: number; resetsAt: number }>();
  private readonly activePresence = new ActivePresence();
  private pendingIncidentProvider?: () => Array<Record<string, unknown>>;
  private pendingIncidentDiscarder?: (id: string) => boolean;
  private pendingIncidentAllower?: (id: string) => Promise<{ incidentId: string } | undefined>;

  constructor(
    private readonly store: DashboardStore,
    private readonly port: number,
    private readonly host: string,
    private readonly discordApplicationId?: string,
    private readonly accounts?: AccountStore,
    private readonly authConfig?: DashboardAuthConfig,
    private readonly siteSettings?: SiteSettingsStore,
    private readonly learningLog?: LearningLog,
    private readonly deploymentUpdater?: DeploymentUpdater,
    private readonly xIntegrationTester?: XIntegrationTester,
    private readonly incidentVotes?: IncidentVoteStore
  ) {}

  setPendingIncidentAdminHandlers(
    provider: () => Array<Record<string, unknown>>,
    discard: (id: string) => boolean,
    allow?: (id: string) => Promise<{ incidentId: string } | undefined>
  ): void {
    this.pendingIncidentProvider = provider;
    this.pendingIncidentDiscarder = discard;
    this.pendingIncidentAllower = allow;
  }

  async start(): Promise<void> {
    if (this.server) return;
    await this.accounts?.init();
    await this.siteSettings?.init();
    const root = join(process.cwd(), 'public', 'dashboard');
    this.unsubscribeIncidentChanges = this.store.onIncidentChange(() => {
      for (const client of this.eventClients) client.write('event: incidents-updated\ndata: {}\n\n');
    });
    this.unsubscribeLiveCallChanges = this.store.onLiveCallChange(() => {
      for (const client of this.eventClients) client.write('event: live-calls-updated\ndata: {}\n\n');
    });
    this.server = createServer(async (request, response) => {
      const cspNonce = randomUUID().replaceAll('-', '');
      setSecurityHeaders(response, cspNonce);
      try {
        const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
        if (await this.handleAccountRoutes(request, response, url)) return;
        if (url.pathname === '/api/presence') {
          if (request.method !== 'POST') {
            json(response, 405, { error: 'Method not allowed.' });
            return;
          }
          await this.handlePresenceHeartbeat(request, response);
          return;
        }
        const voteRoute = /^\/api\/incidents\/([0-9a-f-]{36})\/vote$/i.exec(url.pathname);
        if (voteRoute && request.method === 'POST') {
          await this.handleIncidentVote(request, response, voteRoute[1]!);
          return;
        }
        const liveCallVoteRoute = /^\/api\/live-calls\/([0-9a-f-]{36})\/vote$/i.exec(url.pathname);
        if (liveCallVoteRoute && request.method === 'POST') {
          await this.handleLiveCallVote(request, response, liveCallVoteRoute[1]!);
          return;
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          json(response, 405, { error: 'Method not allowed' });
          return;
        }

        if (url.pathname === '/api/health') {
          json(response, 200, { status: 'ok' });
          return;
        }
        if (url.pathname === '/sitemap.xml') {
          const publicUrl = this.authConfig?.publicUrl ?? url.origin;
          const settings = this.siteSettings?.get() ?? {};
          response.writeHead(200, {
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': 'public, max-age=300',
            'X-Content-Type-Options': 'nosniff'
          });
          if (request.method === 'HEAD') response.end();
          else response.end(renderSitemapXml(this.store, publicUrl, settings));
          return;
        }
        if (url.pathname === '/robots.txt') {
          const publicUrl = this.authConfig?.publicUrl ?? url.origin;
          response.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'public, max-age=3600',
            'X-Content-Type-Options': 'nosniff'
          });
          response.end(`User-agent: *\nAllow: /\nDisallow: /admin\nSitemap: ${new URL('/sitemap.xml', publicUrl).toString()}\n`);
          return;
        }
        if (url.pathname === '/api/public-config') {
          json(response, 200, { discordApplicationId: this.discordApplicationId ?? null, analytics: this.siteSettings?.get() ?? {} });
          return;
        }
        if (url.pathname === '/api/events') {
          response.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no'
          });
          response.write('retry: 5000\n\n');
          this.eventClients.add(response);
          response.on('close', () => this.eventClients.delete(response));
          return;
        }
        if (url.pathname === '/api/feeds') {
          const boroughs = selectedBoroughs(url.searchParams);
          const statuses = this.store.getFeedStatuses();
          const feeds: Array<Record<string, unknown>> = dashboardFeedLinks.map((feed) => {
            const status = statuses.find((item) => item.agency === feed.agency && item.borough === feed.borough);
            return {
              ...feed,
              state: status?.state ?? 'unknown',
              lastAttemptAt: status?.lastAttemptAt,
              lastSuccessAt: status?.lastSuccessAt,
              lastActivityAt: status?.lastActivityAt,
              lastStreamDataAt: status?.lastStreamDataAt,
              callsSeen: status?.callsSeen ?? 0,
              ...(status?.audioLevels ? { audioLevels: status.audioLevels } : {}),
              ...(status?.audioMeterAt ? { audioMeterAt: status.audioMeterAt } : {}),
              ...(status?.callActivityLevels ? { callActivityLevels: status.callActivityLevels } : {}),
              ...(status?.meterSource ? { meterSource: status.meterSource } : {}),
              ...(status?.alertSeverity ? { alertSeverity: status.alertSeverity, alertUntil: status.alertUntil } : {}),
              lastError: status?.lastError
            };
          }).filter((feed) => boroughMatches(feed.borough as Borough | 'Citywide', boroughs));
          const known = new Set(feeds.map((feed) => `${feed.agency}:${feed.borough}`));
          for (const status of statuses) {
            if (known.has(`${status.agency}:${status.borough}`)) continue;
            if (!boroughMatches(status.borough, boroughs)) continue;
            feeds.push({
              id: status.id, name: status.name, agency: status.agency, borough: status.borough,
              url: '', state: status.state, lastAttemptAt: status.lastAttemptAt, lastSuccessAt: status.lastSuccessAt,
              lastActivityAt: status.lastActivityAt, lastStreamDataAt: status.lastStreamDataAt, callsSeen: status.callsSeen,
              ...(status.audioLevels ? { audioLevels: status.audioLevels } : {}),
              ...(status.audioMeterAt ? { audioMeterAt: status.audioMeterAt } : {}),
              ...(status.callActivityLevels ? { callActivityLevels: status.callActivityLevels } : {}),
              ...(status.meterSource ? { meterSource: status.meterSource } : {}),
              ...(status.alertSeverity ? { alertSeverity: status.alertSeverity, alertUntil: status.alertUntil } : {}),
              lastError: status.lastError
            });
          }
          json(response, 200, { feeds });
          return;
        }
        if (url.pathname === '/api/diagnostics') {
          json(response, 200, { pipelines: this.store.getPipelineDiagnostics(), feeds: this.store.getFeedStatuses() });
          return;
        }
        if (url.pathname === '/api/incidents') {
          const deviceId = validVoteDeviceId(url.searchParams.get('deviceId'));
          const incidents = this.store.search(url.searchParams.get('q') ?? '', selectedBoroughs(url.searchParams)).slice(0, 100)
            .map((incident) => ({ ...incident, votes: this.incidentVotes?.getSummary(incident.id, deviceId) ?? { up: 0, down: 0, myVote: null } }));
          json(response, 200, { incidents });
          return;
        }
        const incidentApiMatch = /^\/api\/incidents\/([0-9a-f-]{36})$/i.exec(url.pathname);
        if (incidentApiMatch) {
          const incident = this.store.getIncident(incidentApiMatch[1]!);
          const enriched = incident ? {
            ...incident,
            votes: this.incidentVotes?.getSummary(incident.id, validVoteDeviceId(url.searchParams.get('deviceId')))
              ?? { up: 0, down: 0, myVote: null }
          } : undefined;
          json(response, incident ? 200 : 404, incident ? { incident: enriched } : { error: 'Incident not found' });
          return;
        }
        if (url.pathname === '/api/map-incidents') {
          json(response, 200, { incidents: this.store.listMapIncidents(Date.now(), 30 * 60 * 1000, selectedBoroughs(url.searchParams)) });
          return;
        }
        if (url.pathname === '/api/live-calls') {
          const deviceId = validVoteDeviceId(url.searchParams.get('deviceId'));
          const calls = this.store.listLiveCalls(url.searchParams.get('q') ?? '', selectedBoroughs(url.searchParams)).slice(0, 100)
            .map((call) => ({ ...call, votes: this.incidentVotes?.getLiveCallSummary(call.id, deviceId) ?? { up: 0, down: 0, myVote: null } }));
          json(response, 200, { calls });
          return;
        }
        const audioMatch = /^\/api\/incidents\/([0-9a-f-]{36})\/audio$/i.exec(url.pathname);
        if (audioMatch) {
          await this.serveAudio(audioMatch[1]!, request, response);
          return;
        }
        const liveAudioMatch = /^\/api\/live-calls\/([0-9a-f-]{36})\/audio$/i.exec(url.pathname);
        if (liveAudioMatch) {
          await this.serveAudio(liveAudioMatch[1]!, request, response, true);
          return;
        }

        const incidentPageMatch = /^\/incident\/([0-9a-f-]{36})$/i.exec(url.pathname);
        if (incidentPageMatch) {
          const incident = this.store.getIncident(incidentPageMatch[1]!);
          response.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
          });
          if (request.method === 'HEAD') response.end();
          else {
            const html = await readFile(join(root, 'incident.html'), 'utf8');
            const publicUrl = this.authConfig?.publicUrl ?? url.origin;
            response.end(renderIncidentShareHtml(html, incident, incidentPageMatch[1]!, publicUrl, cspNonce, this.siteSettings?.get() ?? {}));
          }
          return;
        }

        const file = staticFiles.get(url.pathname);
        if (!file) {
          response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          response.end('Not found');
          return;
        }
        const [name, contentType] = file;
        response.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': name.endsWith('.html') || name.endsWith('.css') || name.endsWith('.js') ? 'no-store' : 'public, max-age=300',
          'X-Content-Type-Options': 'nosniff'
        });
        if (request.method === 'HEAD') response.end();
        else if (name.endsWith('.html')) {
          const html = await readFile(join(root, name), 'utf8');
          const settings = this.siteSettings?.get() ?? {};
          const publicUrl = this.authConfig?.publicUrl ?? url.origin;
          const page = url.pathname === '/' ? renderHomepageShareHtml(html, publicUrl, settings) : html;
          response.end(injectVerificationTags(page, settings, cspNonce));
        } else createReadStream(join(root, name)).pipe(response);
      } catch (error) {
        logger.error({ error }, 'Dashboard request failed');
        if (!response.headersSent) json(response, 500, { error: 'Internal server error' });
        else response.destroy();
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, this.host, () => resolve());
    });
    logger.info({ host: this.host, port: this.port }, 'Public alert dashboard listening');
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.unsubscribeIncidentChanges?.();
    this.unsubscribeIncidentChanges = undefined;
    this.unsubscribeLiveCallChanges?.();
    this.unsubscribeLiveCallChanges = undefined;
    for (const client of this.eventClients) client.end();
    this.eventClients.clear();
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  private async handleAccountRoutes(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname === '/api/account/preferences') {
      if (!this.accounts || !this.authConfig) {
        json(response, 503, { error: 'Account services are not configured on this server.' });
        return true;
      }
      const session = this.accounts.getSession(this.readSessionToken(request));
      if (!session?.account) {
        json(response, 401, { error: 'Sign in with an account to save dashboard preferences.' });
        return true;
      }
      if (request.method === 'GET') {
        json(response, 200, { preferences: session.account.dashboardPreferences ?? null });
        return true;
      }
      if (request.method !== 'PUT') {
        json(response, 405, { error: 'Method not allowed.' });
        return true;
      }
      if (!this.hasSameOrigin(request)) {
        json(response, 403, { error: 'Request origin was not accepted.' });
        return true;
      }
      try {
        const body = await readJsonBody(request);
        const preferences = await this.accounts.setDashboardPreferences(session.account.id, body.preferences);
        json(response, 200, { preferences });
      } catch (error) {
        json(response, 400, { error: error instanceof Error ? error.message : 'Could not save dashboard preferences.' });
      }
      return true;
    }
    if (url.pathname.startsWith('/api/auth/')) {
      if (!this.accounts || !this.authConfig) {
        json(response, 503, { error: 'Account services are not configured on this server.' });
        return true;
      }
      if (request.method === 'GET' && url.pathname === '/api/auth/session') {
        const session = this.accounts.getSession(this.readSessionToken(request));
        json(response, 200, { session: session ?? null });
        return true;
      }
      if (request.method !== 'POST') {
        json(response, 405, { error: 'Method not allowed' });
        return true;
      }
      if (!this.hasSameOrigin(request)) {
        json(response, 403, { error: 'Request origin was not accepted.' });
        return true;
      }
      const action = url.pathname.slice('/api/auth/'.length);
      const limit = action === 'register' ? { count: 5, windowMs: 60 * 60_000 }
        : action === 'verify' ? { count: 10, windowMs: 10 * 60_000 }
          : { count: 10, windowMs: 15 * 60_000 };
      if (!this.takeRateLimit(request, `auth:${action}`, limit.count, limit.windowMs)) {
        json(response, 429, { error: 'Too many attempts. Please wait and try again.' });
        return true;
      }
      let body: Record<string, unknown>;
      try { body = await readJsonBody(request); }
      catch (error) {
        json(response, 400, { error: error instanceof Error ? error.message : 'Invalid request body.' });
        return true;
      }
      try {
        if (action === 'admin-invite-complete') {
          const token = typeof body.token === 'string' ? body.token : '';
          const password = typeof body.password === 'string' ? body.password : '';
          const completed = await this.accounts.completeAdminInvitation(token, password);
          this.setSessionCookie(response, completed.token);
          json(response, 200, { session: { kind: 'admin', account: completed.account }, message: 'Administrator account activated.' });
          return true;
        }
        if (action === 'register') {
          if (!this.authConfig.smtpHost) {
            json(response, 503, { error: 'Registration is temporarily unavailable because email verification is not configured.' });
            return true;
          }
          const input = validateRegistration(body);
          if (input.email === this.authConfig.adminEmail?.toLowerCase()) throw new Error('That email is reserved for the bootstrap administrator.');
          const registered = await this.accounts.register(input);
          try {
            const verifyUrl = new URL('/', this.authConfig.publicUrl);
            verifyUrl.hash = new URLSearchParams({ verify: registered.verificationToken }).toString();
            const transport = createTransport({
              host: this.authConfig.smtpHost,
              port: this.authConfig.smtpPort,
              secure: this.authConfig.smtpSecure,
              ...(this.authConfig.smtpUsername && this.authConfig.smtpPassword
                ? { auth: { user: this.authConfig.smtpUsername, pass: this.authConfig.smtpPassword } }
                : {})
            });
            await transport.sendMail({
              from: this.authConfig.smtpFrom,
              to: registered.account.email,
              subject: 'Verify your NYC Alert account',
              text: verificationEmailText(registered.account.firstName, registered.account.accountType, verifyUrl.toString()),
              html: verificationEmailHtml(registered.account.firstName, registered.account.accountType, verifyUrl.toString())
            });
          } catch (error) {
            await this.accounts.deleteAccount(registered.account.id);
            logger.error({ error }, 'Could not send account verification email');
            json(response, 503, { error: 'Verification email could not be sent. Check your details or try again later.' });
            return true;
          }
          json(response, 201, { message: 'Check your email for a verification link. After verifying, an administrator must approve the account.' });
          return true;
        }
        if (action === 'verify') {
          const token = typeof body.token === 'string' ? body.token : '';
          if (token.length < 20 || token.length > 200) throw new Error('Verification link is invalid or expired.');
          const account = await this.accounts.verifyEmail(token);
          json(response, 200, { message: `Email verified. Your ${account.accountType === 'buff' ? 'Buff' : 'News Media'} account is awaiting administrator approval.` });
          return true;
        }
        if (action === 'login') {
          const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
          const password = typeof body.password === 'string' ? body.password : '';
          if (!email || !password) throw new Error('Enter your email and password.');
          const emailKey = createHash('sha256').update(email).digest('hex');
          if (!this.takeRateLimit(request, `login-email:${emailKey}`, 6, 15 * 60_000, 'global')) {
            json(response, 429, { error: 'Too many attempts for this account. Please wait 15 minutes and try again.' });
            return true;
          }
          if (this.authConfig.adminEmail && this.authConfig.adminPassword && email === this.authConfig.adminEmail.toLowerCase()) {
            if (!safeSecretEqual(password, this.authConfig.adminPassword)) throw new Error('Email or password is incorrect.');
            const token = this.accounts.createAdminSession();
            this.setSessionCookie(response, token);
            json(response, 200, { session: { kind: 'admin' } });
            return true;
          }
          try {
            const loggedIn = await this.accounts.login(email, password);
            this.setSessionCookie(response, loggedIn.token);
            json(response, 200, { session: loggedIn.account.isAdmin
              ? { kind: 'admin', account: loggedIn.account }
              : { kind: 'user', account: loggedIn.account } });
            return true;
          } catch {
            json(response, 401, { error: 'Sign-in failed. Check your credentials; a verified, approved account is required.' });
            return true;
          }
        }
        if (action === 'logout') {
          this.accounts.revokeSession(this.readSessionToken(request));
          this.clearSessionCookie(response);
          json(response, 200, { ok: true });
          return true;
        }
      } catch (error) {
        if (action === 'login') {
          json(response, 401, { error: 'Sign-in failed. Check your credentials; a verified, approved account is required.' });
          return true;
        }
        json(response, 400, { error: error instanceof Error ? error.message : 'Account request failed.' });
        return true;
      }
      json(response, 404, { error: 'Not found' });
      return true;
    }

    if (url.pathname.startsWith('/api/admin/')) {
      if (!this.accounts || !this.authConfig) {
        json(response, 503, { error: 'Account services are not configured on this server.' });
        return true;
      }
      const adminSession = this.accounts.getSession(this.readSessionToken(request));
      if (adminSession?.kind !== 'admin') {
        json(response, 401, { error: 'Administrator sign-in required.' });
        return true;
      }
      const role = adminSession.role;
      const isAdmin = role === 'owner' || role === 'admin';
      const canModerate = isAdmin || role === 'moderator';
      const mutating = request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH' || request.method === 'DELETE';
      if (mutating && url.pathname.startsWith('/api/admin/administrators') && !isAdmin) {
        json(response, 403, { error: 'Only administrators can manage staff accounts.' });
        return true;
      }
      if (mutating && url.pathname.startsWith('/api/admin/webhooks') && !isAdmin) {
        json(response, 403, { error: 'Only administrators can manage webhook assignments.' });
        return true;
      }
      if (mutating && (url.pathname === '/api/admin/analytics' || url.pathname === '/api/admin/learning-log') && !isAdmin) {
        json(response, 403, { error: 'Only administrators can change settings or clear learning data.' });
        return true;
      }
      if (url.pathname.startsWith('/api/admin/deployment-update') && !isAdmin) {
        json(response, 403, { error: 'Only administrators can run website updates.' });
        return true;
      }
      if (url.pathname.startsWith('/api/admin/x-test') && !isAdmin) {
        json(response, 403, { error: 'Only administrators can test X integration.' });
        return true;
      }
      if (mutating && (url.pathname.startsWith('/api/admin/incidents') || url.pathname.startsWith('/api/admin/accounts')) && !canModerate) {
        json(response, 403, { error: 'Reviewer accounts have read-only access.' });
        return true;
      }
      if (request.method === 'GET' && url.pathname === '/api/admin/overview') {
        const incidents = this.store.search();
        const accounts = this.accounts.listAdminAccounts();
        const pendingIncidents = this.pendingIncidentProvider?.() ?? [];
        json(response, 200, {
          incidents: incidents.length,
          users: accounts.length,
          pendingUsers: accounts.filter((account) => account.status === 'pending-approval' || account.status === 'pending-verification').length,
          pendingIncidents: pendingIncidents.length,
          dataWindow: 'current process only; resets when service restarts'
        });
        return true;
      }
      if (url.pathname === '/api/admin/deployment-update') {
        if (!this.deploymentUpdater) {
          json(response, 503, { error: 'GitHub updater is not configured.' });
          return true;
        }
        if (request.method === 'GET') {
          json(response, 200, { status: await this.deploymentUpdater.getStatus() });
          return true;
        }
        if (request.method !== 'POST') { json(response, 405, { error: 'Method not allowed.' }); return true; }
        if (!this.hasSameOrigin(request)) { json(response, 403, { error: 'Request origin was not accepted.' }); return true; }
        try {
          const status = await this.deploymentUpdater.trigger();
          logger.warn({ action: 'github-update-requested', actorId: adminSession.account?.id ?? 'bootstrap-admin' }, 'Admin requested GitHub update');
          json(response, 202, { status });
        } catch (error) { json(response, 409, { error: error instanceof Error ? error.message : 'Could not queue update.' }); }
        return true;
      }
      if (url.pathname === '/api/admin/x-test') {
        if (request.method !== 'POST') { json(response, 405, { error: 'Method not allowed.' }); return true; }
        if (!this.hasSameOrigin(request)) { json(response, 403, { error: 'Request origin was not accepted.' }); return true; }
        if (!this.xIntegrationTester) { json(response, 503, { error: 'X user-post credentials are not configured in the running service.' }); return true; }
        if (!this.takeRateLimit(request, 'admin-x-test', 3, 10 * 60_000)) {
          json(response, 429, { error: 'X test posting is rate-limited. Try again in 10 minutes.' });
          return true;
        }
        try {
          const result = await this.xIntegrationTester.publishTestPost();
          logger.info({ action: 'admin-x-test-post-created', actorId: adminSession.account?.id ?? 'bootstrap-admin', postId: result.postId }, 'Administrator verified X posting integration');
          json(response, 200, { ok: true, postId: result.postId, url: result.url, message: 'Test post published successfully.' });
        } catch (error) {
          const message = error instanceof Error ? error.message.slice(0, 300) : 'X test post failed.';
          logger.warn({ action: 'admin-x-test-post-failed', actorId: adminSession.account?.id ?? 'bootstrap-admin', error: message }, 'Administrator X integration test failed');
          json(response, 502, { error: message });
        }
        return true;
      }
      if (request.method === 'GET' && url.pathname === '/api/admin/learning-log') {
        const status = this.learningLog?.getStatus() ?? { enabled: false, fileName: 'learning-debug.jsonl', retentionDays: 0, maxEvents: 0, currentEvents: 0 };
        const limit = Number(url.searchParams.get('limit'));
        const events = this.learningLog?.isEnabled ? await this.learningLog.readRecent(Number.isInteger(limit) && limit > 0 ? limit : 100) : [];
        json(response, 200, { status, events, workflowStages: ['received', 'transcription', 'triage', 'geocoding', 'correlation', 'pending-queue', 'incident-published/updated/suppressed', 'discord-routing', 'x-publishing (optional)'] });
        return true;
      }
      if (url.pathname === '/api/admin/learning-log/export') {
        if (request.method !== 'GET') { json(response, 405, { error: 'Method not allowed' }); return true; }
        if (!this.learningLog?.isEnabled) { json(response, 409, { error: 'Learning log is disabled.' }); return true; }
        try {
          const contents = await this.learningLog.exportJsonl();
          response.writeHead(200, {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Content-Disposition': 'attachment; filename="nycalert-learning-debug.jsonl"',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
          });
          response.end(contents);
        } catch (error) { json(response, 413, { error: error instanceof Error ? error.message : 'Could not export learning data.' }); }
        return true;
      }
      if (url.pathname === '/api/admin/learning-log' && request.method === 'DELETE') {
        if (!this.hasSameOrigin(request)) { json(response, 403, { error: 'Request origin was not accepted.' }); return true; }
        if (!this.learningLog?.isEnabled) { json(response, 409, { error: 'Learning log is disabled.' }); return true; }
        await this.learningLog.clear();
        logger.warn({ action: 'learning-log-cleared', actorId: adminSession.account?.id ?? 'bootstrap-admin' }, 'Administrator cleared transcript learning log');
        json(response, 200, { ok: true, status: this.learningLog.getStatus() });
        return true;
      }
      if (url.pathname === '/api/admin/analytics') {
        if (request.method === 'GET') {
          json(response, 200, { settings: this.siteSettings?.get() ?? {}, configured: Boolean(this.siteSettings) });
          return true;
        }
        if (request.method !== 'PUT') { json(response, 405, { error: 'Method not allowed' }); return true; }
        if (!this.hasSameOrigin(request)) { json(response, 403, { error: 'Request origin was not accepted.' }); return true; }
        if (!this.siteSettings) { json(response, 503, { error: 'Persistent site settings are unavailable.' }); return true; }
        try {
          const settings = await this.siteSettings.update(await readJsonBody(request));
          logger.info({ action: 'admin-analytics-settings-updated', actorId: adminSession.account?.id ?? 'bootstrap-admin' }, 'Analytics configuration changed');
          json(response, 200, { settings });
        } catch (error) { json(response, 400, { error: error instanceof Error ? error.message : 'Invalid analytics settings.' }); }
        return true;
      }
      if (request.method === 'GET' && url.pathname === '/api/admin/incidents') {
        const query = url.searchParams.get('q') ?? '';
        json(response, 200, { incidents: this.store.search(query).slice(0, 300), ephemeral: true });
        return true;
      }
      if (request.method === 'GET' && url.pathname === '/api/admin/incidents/pending') {
        json(response, 200, { incidents: this.pendingIncidentProvider?.() ?? [], available: Boolean(this.pendingIncidentProvider), ephemeral: true });
        return true;
      }
      if (request.method === 'GET' && url.pathname === '/api/admin/webhooks') {
        const webhooks = this.accounts.listAdminAccounts().flatMap((account) => account.webhooks.map((webhook) => ({ ...webhook, accountId: account.id, accountEmail: account.email, accountType: account.accountType })));
        json(response, 200, { webhooks, deliveryEnabled: false });
        return true;
      }
      if (request.method === 'GET' && url.pathname === '/api/admin/accounts') {
        const query = (url.searchParams.get('q') ?? '').trim().toLowerCase();
        const status = url.searchParams.get('status');
        const accounts = this.accounts.listAdminAccounts().filter((account) => {
          const matchesQuery = !query || `${account.firstName} ${account.lastName} ${account.email} ${account.accountType}`.toLowerCase().includes(query);
          return matchesQuery && (!status || account.status === status);
        });
        json(response, 200, { accounts });
        return true;
      }
      if (request.method === 'GET' && url.pathname === '/api/admin/administrators') {
        json(response, 200, { administrators: this.accounts.listAdministrators() });
        return true;
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/incidents') {
        if (!this.hasSameOrigin(request)) { json(response, 403, { error: 'Request origin was not accepted.' }); return true; }
        try {
          const body = await readJsonBody(request);
          const agency = body.agency;
          const borough = body.borough;
          const category = body.category;
          const headline = typeof body.headline === 'string' ? body.headline.trim().slice(0, 120) : '';
          const summary = typeof body.summary === 'string' ? body.summary.trim().slice(0, 700) : '';
          const location = typeof body.location === 'string' ? body.location.trim().slice(0, 180) : '';
          if (typeof agency !== 'string' || !isAgency(agency) || typeof borough !== 'string' || !(isBorough(borough) || borough === 'Citywide')) {
            json(response, 400, { error: 'Choose a valid agency and borough.' }); return true;
          }
          if (!headline || !summary) { json(response, 400, { error: 'Headline and summary are required.' }); return true; }
          if (!['breaking', 'newsworthy', 'funny', 'weird_unique'].includes(String(category))) {
            json(response, 400, { error: 'Choose a valid incident category.' }); return true;
          }
          const incidentType = body.incidentType;
          if (incidentType !== undefined && !['medical', 'vehicle', 'fire', 'police', 'other'].includes(String(incidentType))) {
            json(response, 400, { error: 'Choose a valid incident type.' }); return true;
          }
          const score = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.min(5, Math.round(value))) : 3;
          const confidence = typeof body.confidence === 'number' && Number.isFinite(body.confidence) ? Math.max(0, Math.min(1, body.confidence)) : 0.9;
          const incident = await this.store.publish({
            title: headline, headline, summary, occurredAt: new Date(), agency, borough,
            category: category as 'breaking' | 'newsworthy' | 'funny' | 'weird_unique',
            ...(location ? { location } : {}),
            ...(typeof incidentType === 'string' ? { incidentType: incidentType as 'medical' | 'vehicle' | 'fire' | 'police' | 'other' } : {}),
            confidence,
            newsworthinessScore: score(body.newsworthinessScore),
            buffInterestScore: score(body.buffInterestScore),
            assignmentDeskScore: score(body.assignmentDeskScore)
          });
          logger.info({ action: 'admin-incident-created', actorId: adminSession.account?.id ?? 'bootstrap-admin', incidentId: incident.id }, 'Admin incident created');
          json(response, 201, { incident });
        } catch (error) { json(response, 400, { error: error instanceof Error ? error.message : 'Could not create incident.' }); }
        return true;
      }
      if (request.method === 'PATCH' || request.method === 'DELETE') {
        const incidentMatch = /^\/api\/admin\/incidents\/([0-9a-f-]{36})$/i.exec(url.pathname);
        if (incidentMatch) {
          if (!this.hasSameOrigin(request)) { json(response, 403, { error: 'Request origin was not accepted.' }); return true; }
          if (request.method === 'DELETE') {
            const deleted = await this.store.deleteIncident(incidentMatch[1]!);
            if (deleted) logger.info({ action: 'admin-incident-deleted', actorId: adminSession.account?.id ?? 'bootstrap-admin', incidentId: incidentMatch[1] }, 'Admin incident deleted from dashboard');
            json(response, deleted ? 200 : 404, deleted ? { ok: true, note: 'Previously sent Discord messages are not recalled.' } : { error: 'Incident not found.' });
            return true;
          }
          try {
            const body = await readJsonBody(request);
            const headline = typeof body.headline === 'string' ? body.headline.trim() : '';
            const summary = typeof body.summary === 'string' ? body.summary.trim() : '';
            const location = typeof body.location === 'string' ? body.location.trim() : '';
            const incident = await this.store.adminEditIncident(incidentMatch[1]!, { headline, summary, location });
            if (incident) logger.info({ action: 'admin-incident-edited', actorId: adminSession.account?.id ?? 'bootstrap-admin', incidentId: incident.id }, 'Admin incident edited');
            json(response, incident ? 200 : 404, incident ? { incident } : { error: 'Incident not found.' });
          } catch (error) { json(response, 400, { error: error instanceof Error ? error.message : 'Could not edit incident.' }); }
          return true;
        }
      }
      const pendingMatch = /^\/api\/admin\/incidents\/pending\/([0-9a-f-]{36})$/i.exec(url.pathname);
      const allowPendingMatch = /^\/api\/admin\/incidents\/pending\/([0-9a-f-]{36})\/allow$/i.exec(url.pathname);
      if (allowPendingMatch && request.method === 'POST') {
        if (!this.hasSameOrigin(request)) { json(response, 403, { error: 'Request origin was not accepted.' }); return true; }
        const allowed = await this.pendingIncidentAllower?.(allowPendingMatch[1]!);
        if (allowed) {
          logger.warn({ action: 'admin-pending-incident-allowed', actorId: adminSession.account?.id ?? 'bootstrap-admin', pendingId: allowPendingMatch[1], incidentId: allowed.incidentId }, 'Admin published a pending incident with unverified location');
          json(response, 200, { ok: true, incidentId: allowed.incidentId, warning: 'Published without verified coordinates; no map pin was added.' });
        } else json(response, 404, { error: 'Pending incident not found.' });
        return true;
      }
      if (pendingMatch && request.method === 'DELETE') {
        if (!this.hasSameOrigin(request)) { json(response, 403, { error: 'Request origin was not accepted.' }); return true; }
        const discarded = this.pendingIncidentDiscarder?.(pendingMatch[1]!) ?? false;
        if (discarded) logger.info({ action: 'admin-pending-incident-discarded', actorId: adminSession.account?.id ?? 'bootstrap-admin', pendingId: pendingMatch[1] }, 'Pending incident discarded');
        json(response, discarded ? 200 : 404, discarded ? { ok: true } : { error: 'Pending incident not found.' });
        return true;
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/webhooks') {
        if (!this.hasSameOrigin(request)) { json(response, 403, { error: 'Request origin was not accepted.' }); return true; }
        try {
          const body = await readJsonBody(request);
          const accountId = typeof body.accountId === 'string' ? body.accountId : '';
          const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
          const endpoint = typeof body.url === 'string' ? validateWebhookUrl(body.url) : undefined;
          const boroughs: AccountWebhook['boroughs'] | undefined = body.boroughs === 'all' ? 'all'
            : Array.isArray(body.boroughs) && body.boroughs.length > 0 && body.boroughs.length <= 5 && body.boroughs.every((value) => typeof value === 'string' && isBorough(value))
              ? [...new Set(body.boroughs as Borough[])] : undefined;
          if (!name || !endpoint || !boroughs) { json(response, 400, { error: 'Enter a name, public HTTPS endpoint, and valid borough selection.' }); return true; }
          const webhook = { id: randomBytes(16).toString('hex'), name, url: endpoint, boroughs };
          const webhooks = await this.accounts.addAccountWebhook(accountId, webhook);
          logger.info({ action: 'admin-webhook-created', actorId: adminSession.account?.id ?? 'bootstrap-admin', accountId, webhookId: webhook.id }, 'Webhook target created');
          json(response, 201, { webhook: webhooks.find((item) => item.id === webhook.id), deliveryEnabled: false });
        } catch (error) { json(response, 400, { error: error instanceof Error ? error.message : 'Could not create webhook.' }); }
        return true;
      }
      const webhookMatch = /^\/api\/admin\/webhooks\/([a-f0-9]{32})\/([a-f0-9]{32})$/i.exec(url.pathname);
      if (webhookMatch && request.method === 'DELETE') {
        if (!this.hasSameOrigin(request)) { json(response, 403, { error: 'Request origin was not accepted.' }); return true; }
        const removed = await this.accounts.removeAccountWebhook(webhookMatch[1]!, webhookMatch[2]!);
        if (removed) logger.info({ action: 'admin-webhook-deleted', actorId: adminSession.account?.id ?? 'bootstrap-admin', accountId: webhookMatch[1], webhookId: webhookMatch[2] }, 'Webhook target deleted');
        json(response, removed ? 200 : 404, removed ? { ok: true } : { error: 'Webhook not found.' });
        return true;
      }
      if (url.pathname === '/api/admin/administrators/invite' && request.method === 'POST') {
        if (!this.hasSameOrigin(request)) {
          json(response, 403, { error: 'Request origin was not accepted.' });
          return true;
        }
        if (!this.takeRateLimit(request, 'admin-invite-ip', 5, 60 * 60_000)) {
          json(response, 429, { error: 'Administrator invitations are temporarily rate-limited.' });
          return true;
        }
        if (!this.authConfig.smtpHost) {
          json(response, 503, { error: 'Administrator invitations require configured email delivery.' });
          return true;
        }
        try {
          const body = await readJsonBody(request);
          const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
          const emailKey = createHash('sha256').update(email).digest('hex');
          if (!this.takeRateLimit(request, `admin-invite-email:${emailKey}`, 1, 24 * 60 * 60_000, 'global')) {
            json(response, 429, { error: 'An invitation was already sent to that address today.' });
            return true;
          }
          const firstName = typeof body.firstName === 'string' ? body.firstName.trim().slice(0, 80) : '';
          const lastName = typeof body.lastName === 'string' ? body.lastName.trim().slice(0, 80) : '';
          const role = body.role === 'moderator' || body.role === 'reviewer' ? body.role : 'admin';
          if (!firstName || !lastName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            json(response, 400, { error: 'Enter the administrator name and a valid email address.' });
            return true;
          }
          if (email === this.authConfig.adminEmail?.toLowerCase()) {
            json(response, 400, { error: 'That email is reserved for the bootstrap administrator.' });
            return true;
          }
          const invitation = await this.accounts.inviteAdministrator({ firstName, lastName, email, role });
          try {
            const inviteUrl = new URL('/', this.authConfig.publicUrl);
            inviteUrl.hash = new URLSearchParams({ adminInvite: invitation.invitationToken }).toString();
            const transport = createTransport({
              host: this.authConfig.smtpHost,
              port: this.authConfig.smtpPort,
              secure: this.authConfig.smtpSecure,
              ...(this.authConfig.smtpUsername && this.authConfig.smtpPassword
                ? { auth: { user: this.authConfig.smtpUsername, pass: this.authConfig.smtpPassword } }
                : {})
            });
            await transport.sendMail({
              from: this.authConfig.smtpFrom,
              to: invitation.account.email,
              subject: 'NYC Alert staff invitation',
              text: `Hello ${invitation.account.firstName},\n\nYou have been invited to NYC Alert as a ${role}. Use this one-time link within 24 hours to set your password:\n${inviteUrl}\n\nNever share this link.`,
              html: `<p>Hello ${escapeMailText(invitation.account.firstName)},</p><p>You have been invited to NYC Alert as a <strong>${role}</strong>. Use this one-time link within 24 hours to set your password:</p><p><a href="${escapeMailText(inviteUrl.toString())}">Accept staff invitation</a></p><p>Never share this link.</p>`
            });
          } catch (error) {
            await this.accounts.deleteAdministrator(invitation.account.id);
            logger.error({ error }, 'Could not send administrator invitation email');
            json(response, 503, { error: 'Invitation email could not be sent. Check SMTP settings and try again.' });
            return true;
          }
          logger.info({ action: 'admin-invited', actorId: adminSession.account?.id ?? 'bootstrap-admin', targetId: invitation.account.id }, 'Administrator invitation sent');
          json(response, 201, { message: 'Administrator invitation sent.' });
        } catch (error) {
          json(response, 400, { error: error instanceof Error ? error.message : 'Could not invite administrator.' });
        }
        return true;
      }
      const adminDeleteMatch = /^\/api\/admin\/administrators\/([a-f0-9]{32})$/i.exec(url.pathname);
      if (adminDeleteMatch) {
        if (request.method !== 'DELETE') {
          json(response, 405, { error: 'Method not allowed' });
          return true;
        }
        if (!this.hasSameOrigin(request)) {
          json(response, 403, { error: 'Request origin was not accepted.' });
          return true;
        }
        try {
          const bootstrapAvailable = Boolean(this.authConfig.adminEmail && this.authConfig.adminPassword);
          const deleted = await this.accounts.deleteAdministrator(adminDeleteMatch[1]!, adminSession.account?.id, bootstrapAvailable);
          if (deleted) logger.info({ action: 'admin-revoked', actorId: adminSession.account?.id ?? 'bootstrap-admin', targetId: adminDeleteMatch[1] }, 'Administrator access revoked');
          json(response, deleted ? 200 : 404, deleted ? { ok: true } : { error: 'Administrator not found.' });
        } catch (error) {
          json(response, 400, { error: error instanceof Error ? error.message : 'Could not revoke administrator.' });
        }
        return true;
      }
      if (request.method !== 'PATCH' && request.method !== 'DELETE') {
        json(response, 405, { error: 'Method not allowed' });
        return true;
      }
      if (!this.hasSameOrigin(request)) {
        json(response, 403, { error: 'Request origin was not accepted.' });
        return true;
      }
      const match = /^\/api\/admin\/accounts\/([a-f0-9]{32})$/i.exec(url.pathname);
      if (!match) {
        json(response, 404, { error: 'Account not found.' });
        return true;
      }
      if (this.accounts.isAdministrator(match[1]!)) {
        json(response, 403, { error: 'Manage administrator accounts in the administrator section.' });
        return true;
      }
      if (request.method === 'DELETE') {
        const deleted = await this.accounts.deleteAccount(match[1]!);
        if (deleted) logger.info({ action: 'audience-account-deleted', actorId: adminSession.account?.id ?? 'bootstrap-admin', targetId: match[1] }, 'Audience account deleted');
        json(response, deleted ? 200 : 404, deleted ? { ok: true } : { error: 'Account not found.' });
        return true;
      }
      try {
        const body = await readJsonBody(request);
        const status = body.status;
        if (status !== 'approved' && status !== 'pending-approval' && status !== 'suspended') {
          json(response, 400, { error: 'Choose approved, pending-approval, or suspended.' });
          return true;
        }
        const account = await this.accounts.updateAccount(match[1]!, { status: status as AccountStatus });
        if (account) logger.info({ action: 'audience-account-status-updated', actorId: adminSession.account?.id ?? 'bootstrap-admin', targetId: account.id, status }, 'Audience account status updated');
        json(response, account ? 200 : 404, account ? { account } : { error: 'Account not found.' });
      } catch (error) {
        json(response, 400, { error: error instanceof Error ? error.message : 'Invalid request body.' });
      }
      return true;
    }

    return false;
  }

  private readSessionToken(request: IncomingMessage): string | undefined {
    return request.headers.cookie?.split(';').map((part) => part.trim())
      .find((part) => part.startsWith(`${sessionCookie}=`))?.slice(sessionCookie.length + 1);
  }

  private setSessionCookie(response: ServerResponse, token: string): void {
    const secure = this.authConfig?.publicUrl.startsWith('https://') ? '; Secure' : '';
    response.setHeader('Set-Cookie', `${sessionCookie}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionMaxAgeSeconds}${secure}`);
  }

  private clearSessionCookie(response: ServerResponse): void {
    const secure = this.authConfig?.publicUrl.startsWith('https://') ? '; Secure' : '';
    response.setHeader('Set-Cookie', `${sessionCookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
  }

  private async handleIncidentVote(request: IncomingMessage, response: ServerResponse, incidentId: string): Promise<void> {
    if (!this.hasSameOrigin(request)) {
      json(response, 403, { error: 'Request origin was not accepted.' });
      return;
    }
    if (!this.incidentVotes) {
      json(response, 503, { error: 'Incident voting is not configured.' });
      return;
    }
    if (!this.takeRateLimit(request, 'incident-vote', 20, 60_000)) {
      json(response, 429, { error: 'Voting is temporarily rate-limited. Try again shortly.' });
      return;
    }
    try {
      const body = await readJsonBody(request);
      const deviceId = validVoteDeviceId(body.deviceId);
      if (!deviceId || !isIncidentVote(body.vote)) {
        json(response, 400, { error: 'A valid device ID and up/down vote are required.' });
        return;
      }
      const incident = this.store.getIncident(incidentId);
      if (!incident) {
        json(response, 404, { error: 'Incident not found.' });
        return;
      }
      if ((incident.category as string) === 'routine') {
        json(response, 400, { error: 'Routine radio traffic is not eligible for votes.' });
        return;
      }
      const result = this.incidentVotes.castVote(incident, deviceId, body.vote);
      if (result.accepted) {
        this.learningLog?.recordIncidentFeedback({
          incidentId: incident.id,
          vote: body.vote,
          agency: incident.agency,
          borough: incident.borough,
          incidentType: incident.incidentType,
          category: incident.category,
          publicScore: incident.newsworthinessScore,
          buffScore: incident.buffInterestScore,
          newsMediaScore: incident.assignmentDeskScore
        });
      }
      json(response, 200, { ...result, message: result.accepted ? 'Vote recorded.' : 'This device has already voted on this incident.' });
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : 'Could not record vote.' });
    }
  }

  private async handlePresenceHeartbeat(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.hasSameOrigin(request)) {
      json(response, 403, { error: 'Request origin was not accepted.' });
      return;
    }
    if (!this.takeRateLimit(request, 'presence-heartbeat', 120, 60_000)) {
      json(response, 429, { error: 'Presence heartbeat is temporarily rate-limited.' });
      return;
    }
    try {
      const body = await readJsonBody(request);
      if (typeof body.browserToken !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.browserToken)) {
        json(response, 400, { error: 'A valid temporary browser session token is required.' });
        return;
      }
      const session = this.accounts?.getSession(this.readSessionToken(request));
      const audience = session?.kind === 'user' && session.account.accountType === 'buff' ? 'buff'
        : session?.kind === 'user' && session.account.accountType === 'news' ? 'news'
          : undefined;
      json(response, 200, { counts: this.activePresence.heartbeat(body.browserToken, audience) });
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : 'Could not update active presence.' });
    }
  }

  private async handleLiveCallVote(request: IncomingMessage, response: ServerResponse, liveCallId: string): Promise<void> {
    if (!this.hasSameOrigin(request)) {
      json(response, 403, { error: 'Request origin was not accepted.' });
      return;
    }
    if (!this.incidentVotes) {
      json(response, 503, { error: 'Live Radio voting is not configured.' });
      return;
    }
    if (!this.takeRateLimit(request, 'live-call-vote', 20, 60_000)) {
      json(response, 429, { error: 'Voting is temporarily rate-limited. Try again shortly.' });
      return;
    }
    try {
      const body = await readJsonBody(request);
      const deviceId = validVoteDeviceId(body.deviceId);
      if (!deviceId || !isIncidentVote(body.vote)) {
        json(response, 400, { error: 'A valid device ID and up/down vote are required.' });
        return;
      }
      const call = this.store.getLiveCall(liveCallId);
      if (!call) {
        json(response, 404, { error: 'Live Radio call not found.' });
        return;
      }
      if (call.category === 'routine') {
        json(response, 400, { error: 'Routine radio traffic is not eligible for votes.' });
        return;
      }
      const result = this.incidentVotes.castLiveCallVote(call, deviceId, body.vote);
      const shouldPromote = qualifiesForCommunityPromotion(call, result);
      const promotedIncident = shouldPromote
        ? await this.store.promoteLiveCallFromCommunity(call.id, result)
        : undefined;
      json(response, 200, {
        ...result,
        promoted: Boolean(promotedIncident),
        ...(promotedIncident ? { promotedIncidentId: promotedIncident.id } : {}),
        promotionProgress: {
          upvotesNeeded: Math.max(0, communityPromotionThreshold.upvotes - result.up),
          netVotesNeeded: Math.max(0, communityPromotionThreshold.netVotes - (result.up - result.down))
        },
        message: result.accepted
          ? promotedIncident ? 'Strong community support surfaced this radio report on Latest Incidents.' : 'Vote recorded.'
          : 'This device has already voted on this radio call.'
      });
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : 'Could not record vote.' });
    }
  }

  private hasSameOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    const host = request.headers.host;
    if (!origin || !host) return false;
    try {
      const originUrl = new URL(origin);
      const forwardedProto = this.authConfig?.trustProxy
        ? headerValue(request.headers['x-forwarded-proto']).split(',')[0]?.trim()
        : undefined;
      const expectedProto = forwardedProto === 'https' ? 'https:' : forwardedProto === 'http' ? 'http:'
        : this.authConfig?.publicUrl.startsWith('https://') ? 'https:' : 'http:';
      return originUrl.host.toLowerCase() === host.toLowerCase() && originUrl.protocol === expectedProto;
    } catch { return false; }
  }

  private takeRateLimit(request: IncomingMessage, action: string, maximum: number, windowMs: number, scope: 'ip' | 'global' = 'ip'): boolean {
    const now = Date.now();
    const forwardedFor = this.authConfig?.trustProxy
      ? headerValue(request.headers['x-forwarded-for']).split(',').at(-1)?.trim()
      : undefined;
    const ip = forwardedFor || request.socket.remoteAddress || 'unknown';
    const key = scope === 'global' ? action : `${action}:${ip}`;
    const current = this.authRateLimits.get(key);
    if (!current || current.resetsAt <= now) {
      this.authRateLimits.set(key, { count: 1, resetsAt: now + windowMs });
      if (this.authRateLimits.size > 5000) {
        for (const [entry, limit] of this.authRateLimits) if (limit.resetsAt <= now) this.authRateLimits.delete(entry);
        while (this.authRateLimits.size > 5000) {
          const oldest = this.authRateLimits.keys().next().value as string | undefined;
          if (!oldest) break;
          this.authRateLimits.delete(oldest);
        }
      }
      return true;
    }
    current.count += 1;
    return current.count <= maximum;
  }

  private async serveAudio(id: string, request: IncomingMessage, response: ServerResponse, liveCall = false): Promise<void> {
    const audio = liveCall ? this.store.getLiveCallAudio(id) : this.store.getAudio(id);
    if (!audio) {
      json(response, 404, { error: 'Audio unavailable' });
      return;
    }
    const { path, contentType } = audio;
    const info = await stat(path);
    if (!info.isFile()) {
      json(response, 404, { error: 'Audio unavailable' });
      return;
    }

    const range = request.headers.range;
    const matched = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
    if (range && !matched) {
      response.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
      response.end();
      return;
    }
    const start = matched?.[1] ? Number(matched[1]) : 0;
    const end = matched?.[2] ? Math.min(Number(matched[2]), info.size - 1) : info.size - 1;
    if (start > end || start >= info.size) {
      response.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
      response.end();
      return;
    }
    response.writeHead(matched ? 206 : 200, {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      ...(matched ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}),
      'Cache-Control': 'private, no-store'
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(path, { start, end }).pipe(response);
  }
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    throw new Error('Send account forms as JSON.');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 12_000) throw new Error('Request is too large.');
    chunks.push(buffer);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Request body must be valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request body must be a JSON object.');
  return value as Record<string, unknown>;
}

function validateRegistration(body: Record<string, unknown>): {
  firstName: string; lastName: string; email: string; phone: string; usageCase: string; accountType: AudienceAccountType; password: string;
} {
  const text = (key: string, max: number): string => typeof body[key] === 'string' ? body[key].trim().slice(0, max) : '';
  const firstName = text('firstName', 80);
  const lastName = text('lastName', 80);
  const email = text('email', 254).toLowerCase();
  const phone = text('phone', 40);
  const usageCase = text('usageCase', 1000);
  const password = typeof body.password === 'string' ? body.password : '';
  const accountType = body.accountType;
  if (!firstName || !lastName) throw new Error('Enter your first and last name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
  if (phone.length < 7) throw new Error('Enter a contact phone number.');
  if (usageCase.length < 10) throw new Error('Please describe how you will use the account (at least 10 characters).');
  if (password.length < 12 || password.length > 128) throw new Error('Password must be between 12 and 128 characters.');
  if (accountType !== 'buff' && accountType !== 'news') throw new Error('Choose Buff or News Media account access.');
  return { firstName, lastName, email, phone, usageCase, accountType, password };
}

function safeSecretEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function escapeMailText(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

function injectVerificationTags(html: string, settings: SiteSettings, nonce: string): string {
  const tags = [
    settings.googleSiteVerification ? `<meta name="google-site-verification" content="${escapeMailText(settings.googleSiteVerification)}">` : '',
    settings.bingSiteVerification ? `<meta name="msvalidate.01" content="${escapeMailText(settings.bingSiteVerification)}">` : '',
    settings.aboveHeaderCode ? applyScriptNonce(settings.aboveHeaderCode, nonce) : ''
  ].filter(Boolean).join('\n  ');
  return tags ? html.replace('</head>', `  ${tags}\n</head>`) : html;
}

function renderSitemapXml(store: DashboardStore, publicUrl: string, settings: SiteSettings): string {
  const escapeXml = (value: string): string => value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
  })[character]!);
  const imageUrl = resolveOpenGraphImage(settings.openGraphImage, publicUrl);
  const homepage = new URL('/', publicUrl).toString();
  const urls = [
    `<url><loc>${escapeXml(homepage)}</loc><changefreq>hourly</changefreq><priority>1.0</priority><image:image><image:loc>${escapeXml(imageUrl)}</image:loc><image:title>${escapeXml(settings.openGraphTitle || 'NYC Alert — Public Safety Desk')}</image:title></image:image></url>`
  ];
  for (const incident of store.search()) {
    const loc = new URL(`/incident/${encodeURIComponent(incident.id)}`, publicUrl).toString();
    const lastmodDate = new Date(incident.updatedAt || incident.occurredAt);
    const lastmod = Number.isNaN(lastmodDate.getTime()) ? '' : `<lastmod>${lastmodDate.toISOString()}</lastmod>`;
    const title = incident.title.split(' | ')[0] || 'NYC Alert Incident';
    urls.push(`<url><loc>${escapeXml(loc)}</loc>${lastmod}<changefreq>daily</changefreq><priority>0.7</priority><image:image><image:loc>${escapeXml(imageUrl)}</image:loc><image:title>${escapeXml(title)}</image:title></image:image></url>`);
  }
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n'
    + `${urls.map((entry) => `  ${entry}`).join('\n')}\n</urlset>\n`;
}

function resolveOpenGraphImage(image: string | undefined, publicUrl: string): string {
  const configured = image?.trim() || '/og-image.png';
  try {
    return new URL(configured, publicUrl).toString();
  } catch {
    return new URL('/og-image.png', publicUrl).toString();
  }
}

function renderHomepageShareHtml(html: string, publicUrl: string, settings: SiteSettings): string {
  const title = settings.openGraphTitle || 'NYC Alert — Public Safety Desk';
  const description = settings.openGraphDescription
    || 'The city never sleeps. Follow the calls, units, and action in real-time.';
  const canonicalUrl = new URL('/', publicUrl).toString();
  const imageUrl = resolveOpenGraphImage(settings.openGraphImage, publicUrl);
  const escapeAttribute = (value: string): string => value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]!);
  const page = html
    .replace(/<title>[\s\S]*?<\/title>/i, '')
    .replace(/<meta\b[^>]*(?:property|name)=["'](?:og:(?:title|description|type|url|image|image:alt|image:type)|twitter:(?:card|title|description|image)|description)["'][^>]*>\s*/gi, '')
    .replace(/<link\b[^>]*rel=["']canonical["'][^>]*>\s*/gi, '');
  const metadata = [
    `<title>${escapeAttribute(title)}</title>`,
    `<meta name="description" content="${escapeAttribute(description)}">`,
    '<meta property="og:type" content="website">',
    `<meta property="og:title" content="${escapeAttribute(title)}">`,
    `<meta property="og:description" content="${escapeAttribute(description)}">`,
    `<meta property="og:url" content="${escapeAttribute(canonicalUrl)}">`,
    `<meta property="og:image" content="${escapeAttribute(imageUrl)}">`,
    `<meta property="og:image:alt" content="${escapeAttribute(title)}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${escapeAttribute(title)}">`,
    `<meta name="twitter:description" content="${escapeAttribute(description)}">`,
    `<meta name="twitter:image" content="${escapeAttribute(imageUrl)}">`,
    `<link rel="canonical" href="${escapeAttribute(canonicalUrl)}">`
  ].join('\n  ');
  return page.replace('</head>', `  ${metadata}\n</head>`);
}

function verificationEmailText(firstName: string, accountType: AudienceAccountType | 'reviewer', verifyUrl: string): string {
  const audience = accountType === 'buff' ? 'Buff' : accountType === 'news' ? 'News Media' : 'Administrator';
  return `NYC ALERT | VERIFY YOUR EMAIL\n\nHello ${firstName},\n\nConfirm this address to submit your ${audience} account for administrator review.\n\nVerify email: ${verifyUrl}\n\nThis secure link expires in 24 hours. If you did not request an account, you can ignore this message.\n\nNYC Alert\nAI-assisted public safety updates. Verify independently.`;
}

function verificationEmailHtml(firstName: string, accountType: AudienceAccountType | 'reviewer', verifyUrl: string): string {
  const audience = accountType === 'buff' ? 'Buff' : accountType === 'news' ? 'News Media' : 'Administrator';
  const safeName = escapeMailText(firstName);
  const safeUrl = escapeMailText(verifyUrl);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#080d13;font-family:Arial,Helvetica,sans-serif;color:#e7eef6"><div style="display:none;max-height:0;overflow:hidden;opacity:0">Verify your email to continue your NYC Alert ${audience} account request.</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#080d13;padding:34px 12px"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;border:1px solid #29394a;border-radius:16px;overflow:hidden;background:#101923"><tr><td style="padding:27px 32px;background:linear-gradient(120deg,#14283a,#10251f);border-bottom:1px solid #304153"><div style="font-size:11px;font-weight:700;letter-spacing:3px;color:#91e8ce">NYC ALERT <span style="color:#708399">/ ACCOUNT SECURITY</span></div><h1 style="margin:17px 0 0;font-size:28px;line-height:1.2;color:#f2f7fb">Confirm your email</h1></td></tr><tr><td style="padding:30px 32px"><p style="margin:0 0 14px;font-size:16px;line-height:1.6">Hello ${safeName},</p><p style="margin:0 0 22px;color:#bdc9d5;font-size:14px;line-height:1.7">Confirm this address to submit your <strong style="color:#eaf7f2">${audience}</strong> account for administrator review. Access is enabled only after the account is approved.</p><table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 23px"><tr><td align="center" style="border-radius:8px;background:#36c790"><a href="${safeUrl}" style="display:inline-block;padding:14px 22px;color:#07150f;text-decoration:none;font-size:14px;font-weight:700">Verify email address&nbsp; →</a></td></tr></table><div style="padding:14px 16px;border:1px solid #344453;border-radius:9px;background:#0b1219"><p style="margin:0;color:#b4c1cd;font-size:12px;line-height:1.6"><strong style="color:#e7eef6">Security note</strong><br>This single-use link expires in 24 hours. If you did not request this account, ignore this email.</p></div><p style="margin:24px 0 0;color:#8293a4;font-size:11px;line-height:1.6">Button not working? Copy this address into your browser:<br><a href="${safeUrl}" style="color:#8bd8f4;overflow-wrap:anywhere">${safeUrl}</a></p></td></tr><tr><td style="padding:17px 32px;border-top:1px solid #29394a;color:#8293a4;font-size:10px;line-height:1.6">NYC Alert · AI-assisted public safety updates<br>Verify independently. This service is not an emergency dispatch system.</td></tr></table></td></tr></table></body></html>`;
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(',') : value ?? '';
}

function validateWebhookUrl(value: string): string | undefined {
  if (value.length > 2_000) return undefined;
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || isIP(host)) return undefined;
    if (url.port && url.port !== '443') return undefined;
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return undefined;
    if (!host.includes('.') || host.split('.').some((label) => !label || label.startsWith('-') || label.endsWith('-'))) return undefined;
    return url.toString();
  } catch { return undefined; }
}

function renderIncidentShareHtml(
  html: string,
  incident: ReturnType<DashboardStore['getIncident']>,
  incidentId: string,
  publicUrl: string,
  nonce: string,
  settings: SiteSettings
): string {
  const canonicalUrl = new URL(`/incident/${encodeURIComponent(incidentId)}`, publicUrl).toString();
  const headline = incident?.title.split(' | ')[0] || 'NYC Alert Incident Report';
  const description = incident
    ? [incident.summary, incident.location, `${incident.agency} · ${incident.borough}`].filter(Boolean).join(' | ').slice(0, 280)
    : 'AI-assisted radio-reported incident details and updates. Verify independently.';
  const imageUrl = resolveOpenGraphImage(settings.openGraphImage, publicUrl);
  const escapeAttribute = (value: string): string => value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]!);
  let page = html
    .replace(/<title>[\s\S]*?<\/title>/i, '')
    .replace(/<meta\b[^>]*(?:property|name)=["'](?:og:(?:title|description|type|url|image|image:alt|image:type)|twitter:(?:card|title|description|image)|description)["'][^>]*>\s*/gi, '')
    .replace(/<link\b[^>]*rel=["']canonical["'][^>]*>\s*/gi, '');
  const metadata = [
    `<title>${escapeAttribute(headline)} — NYC Alert</title>`,
    `<meta name="description" content="${escapeAttribute(description)}">`,
    '<meta property="og:type" content="article">',
    `<meta property="og:title" content="${escapeAttribute(headline)}">`,
    `<meta property="og:description" content="${escapeAttribute(description)}">`,
    `<meta property="og:url" content="${escapeAttribute(canonicalUrl)}">`,
    `<meta property="og:image" content="${escapeAttribute(imageUrl)}">`,
    `<meta property="og:image:alt" content="NYC Alert — ${escapeAttribute(headline)}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${escapeAttribute(headline)}">`,
    `<meta name="twitter:description" content="${escapeAttribute(description)}">`,
    `<meta name="twitter:image" content="${escapeAttribute(imageUrl)}">`,
    `<link rel="canonical" href="${escapeAttribute(canonicalUrl)}">`
  ].join('\n  ');
  page = page.replace('</head>', `  ${metadata}\n</head>`);
  return injectVerificationTags(page, settings, nonce);
}

function applyScriptNonce(code: string, nonce: string): string {
  return code.replace(/<script\b(?![^>]*\bnonce\s*=)/gi, `<script nonce="${nonce}"`);
}