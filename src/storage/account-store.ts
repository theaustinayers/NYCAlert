import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isIP } from 'node:net';
import type { Borough } from '../domain/subscriptions.js';
import { alertCategories, type AlertCategory } from '../domain/triage.js';
import { inferWebhookPlatform, type WebhookAudience, type WebhookPlatform, type WebhookTarget } from '../providers/webhook-delivery.js';

export type AudienceAccountType = 'buff' | 'news';
export type DashboardAudience = 'public' | 'buff' | 'news';
export type DashboardAgencyFilter = 'all' | 'FDNY' | 'NYPD';
export type DashboardSortMode = 'smart' | 'newest' | 'priority';
export type DashboardView = 'incidents' | 'live';
export type LiveCallCategory = AlertCategory | 'routine';
export interface DashboardPreferences {
  boroughs: Borough[];
  audience: DashboardAudience;
  agency: DashboardAgencyFilter;
  sortMode: DashboardSortMode;
  view: DashboardView;
  liveCategories: LiveCallCategory[];
}
export type AdminRole = 'owner' | 'admin' | 'moderator' | 'reviewer';
export type AccountStatus = 'pending-verification' | 'pending-approval' | 'approved' | 'suspended';
export type AccountRoleName = Exclude<AdminRole, 'owner'>;
export interface AccountWebhook { id: string; name: string; url: string; platform?: WebhookPlatform; boroughs: Borough[] | 'all'; suspendedAt?: string; }
export interface AccountWebhookSummary { id: string; name: string; platform?: WebhookPlatform; boroughs: Borough[] | 'all'; suspendedAt?: string; }
export interface AccountRecord {
  id: string;
  username: string;
  usernameLocked?: boolean;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  usageCase: string;
  newsOutlet?: string;
  recentLogins?: Array<{ at: string; ip: string }>;
  communityHistory?: AccountCommunityActivity[];
  accountType: AudienceAccountType | 'reviewer';
  isAdmin?: boolean;
  adminRole?: Exclude<AdminRole, 'owner'>;
  status: AccountStatus;
  emailVerifiedAt?: string;
  webhookAccessSuspended?: boolean;
  communityUpdatesSuspended?: boolean;
  createdAt: string;
  passwordSalt: string;
  passwordHash: string;
  verificationTokenHash?: string;
  verificationExpiresAt?: number;
  verificationResentAt?: number;
  webhooks: AccountWebhook[];
  dashboardPreferences?: DashboardPreferences;
}
export interface PublicAccount { id: string; username: string; email: string; accountType: AccountRecord['accountType']; isAdmin: boolean; adminRole?: AccountRoleName; status: AccountStatus; emailVerified: boolean; createdAt: string; webhooks: AccountWebhookSummary[]; webhookAccessSuspended: boolean; communityUpdatesSuspended: boolean; dashboardPreferences?: DashboardPreferences; }
export interface AdminAccount extends PublicAccount { firstName: string; lastName: string; phone: string; usageCase: string; newsOutlet?: string; }

export interface AccountCommunityActivity {
  kind: 'note' | 'up' | 'down';
  targetKind: 'incident' | 'live-call';
  targetId: string;
  title: string;
  at: string;
  message?: string;
  noteId?: string;
}

export class EmailVerificationRequiredError extends Error {
  constructor(readonly account: PublicAccount) {
    super('Verify your email first. Check your inbox and spam folder.');
  }
}

const passwordBytes = 64;
const sessionLifetimeMs = 12 * 60 * 60 * 1000;
const maxSessionsPerAccount = 5;
const maxSessionsTotal = 10_000;
const verifyLifetimeMs = 24 * 60 * 60 * 1000;
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
const hashPassword = (password: string, salt: string): string => scryptSync(password, salt, passwordBytes).toString('hex');

export class AccountStore {
  private accounts: AccountRecord[] = [];
  private sessions = new Map<string, { accountId: string; expiresAt: number }>();
  private persistQueue: Promise<void> = Promise.resolve();
  private readonly filePath: string;
  private initialized = false;
  private readonly verificationResends = new Set<string>();

  constructor(dataDirectory: string) { this.filePath = join(dataDirectory, 'accounts.json'); }

  async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (!Array.isArray(parsed)) throw new Error('Account store must contain a JSON array');
      this.accounts = parsed as AccountRecord[];
      const claimed = new Set<string>();
      for (const account of this.accounts) {
        const normalized = normalizeUsername(account.username);
        if (!normalized || claimed.has(normalized.toLowerCase())) account.username = uniqueGeneratedUsername(account.id, claimed);
        else account.username = normalized;
        claimed.add(account.username.toLowerCase());
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.initialized = true;
  }

  async register(input: { username: string; firstName: string; lastName: string; email: string; phone: string; usageCase: string; newsOutlet?: string; accountType: AudienceAccountType; password: string }): Promise<{ account: PublicAccount; verificationToken: string }> {
    const email = input.email.trim().toLowerCase();
    if (this.accounts.some((account) => account.email === email)) throw new Error('An account already exists for this email. Try logging in or contact support.');
    const username = this.requireAvailableUsername(input.username);
    const salt = randomBytes(16).toString('hex');
    const token = randomBytes(32).toString('base64url');
    const account: AccountRecord = {
      id: randomBytes(16).toString('hex'),
      username,
      firstName: input.firstName.trim().slice(0, 80), lastName: input.lastName.trim().slice(0, 80), email,
      phone: input.phone.trim().slice(0, 40), usageCase: input.usageCase.trim().slice(0, 1000),
      ...(input.accountType === 'news' && input.newsOutlet?.trim() ? { newsOutlet: input.newsOutlet.trim().slice(0, 160) } : {}),
      accountType: input.accountType, status: 'pending-verification', createdAt: new Date().toISOString(),
      passwordSalt: salt, passwordHash: hashPassword(input.password, salt), verificationTokenHash: hashToken(token),
      verificationExpiresAt: Date.now() + verifyLifetimeMs, webhooks: []
    };
    this.accounts.push(account);
    await this.persist();
    return { account: this.publicView(account), verificationToken: token };
  }

  async verifyEmail(token: string): Promise<PublicAccount> {
    const tokenHash = hashToken(token);
    const account = this.accounts.find((item) => !item.isAdmin && item.status === 'pending-verification' && item.verificationTokenHash === tokenHash && (item.verificationExpiresAt ?? 0) > Date.now());
    if (!account) throw new Error('This verification link is invalid or expired. Please register again or request a new link.');
    account.emailVerifiedAt = new Date().toISOString();
    delete account.verificationTokenHash;
    delete account.verificationExpiresAt;
    account.status = 'pending-approval';
    await this.persist();
    return this.publicView(account);
  }

  findAccountByEmail(email: string): PublicAccount | undefined {
    const account = this.accounts.find((item) => item.email === email.trim().toLowerCase());
    return account ? this.publicView(account) : undefined;
  }

  async resendVerificationEmail(email: string, send: (account: PublicAccount, token: string) => Promise<void>): Promise<'sent' | 'cooldown' | 'ineligible'> {
    const account = this.accounts.find((item) => item.email === email.trim().toLowerCase());
    if (!account || account.isAdmin || account.emailVerifiedAt || account.status !== 'pending-verification') return 'ineligible';
    if (this.verificationResends.has(account.id) || Date.now() - (account.verificationResentAt ?? 0) < 60_000) return 'cooldown';
    this.verificationResends.add(account.id);
    const previous = { hash: account.verificationTokenHash, expiresAt: account.verificationExpiresAt, resentAt: account.verificationResentAt };
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    account.verificationTokenHash = tokenHash;
    account.verificationExpiresAt = Date.now() + verifyLifetimeMs;
    account.verificationResentAt = Date.now();
    try {
      await this.persist();
      await send(this.publicView(account), token);
      return 'sent';
    } catch (error) {
      // Keep the previous link usable if delivery fails; never undo a concurrent verification.
      if (account.verificationTokenHash === tokenHash) {
        if (previous.hash === undefined) delete account.verificationTokenHash;
        else account.verificationTokenHash = previous.hash;
        if (previous.expiresAt === undefined) delete account.verificationExpiresAt;
        else account.verificationExpiresAt = previous.expiresAt;
        if (previous.resentAt === undefined) delete account.verificationResentAt;
        else account.verificationResentAt = previous.resentAt;
        await this.persist();
      }
      throw error;
    } finally {
      this.verificationResends.delete(account.id);
    }
  }

  async login(emailInput: string, password: string, ip = 'unknown'): Promise<{ token: string; account: PublicAccount }> {
    const account = this.accounts.find((item) => item.email === emailInput.trim().toLowerCase());
    if (!account) {
      hashPassword(password, 'nycalert-dummy-salt');
      throw new Error('Email or password is incorrect.');
    }
    if (!safeEqual(hashPassword(password, account.passwordSalt), account.passwordHash)) throw new Error('Email or password is incorrect.');
    if (account.status === 'suspended') throw new Error('This account is suspended.');
    if (!account.emailVerifiedAt) {
      if (!account.isAdmin && account.status === 'pending-verification') throw new EmailVerificationRequiredError(this.publicView(account));
      throw new Error('Verify your email first. Check your inbox and spam folder.');
    }
    if (account.status !== 'approved') throw new Error('Your account is awaiting administrator approval.');
    const normalizedIp = ip.replace(/^::ffff:/, '');
    account.recentLogins = [{ at: new Date().toISOString(), ip: isIP(normalizedIp) ? normalizedIp : 'unknown' }, ...(account.recentLogins ?? [])].slice(0, 3);
    await this.persist();
    return this.createSession(account);
  }

  getUserDetails(id: string): (AdminAccount & { recentLogins: Array<{ at: string; ip: string }>; communityHistory: AccountCommunityActivity[] }) | undefined {
    const account = this.accounts.find((item) => item.id === id && !item.isAdmin);
    if (!account) return undefined;
    return {
      ...this.publicView(account), firstName: account.firstName, lastName: account.lastName,
      phone: account.phone, usageCase: account.usageCase,
      ...(account.newsOutlet ? { newsOutlet: account.newsOutlet } : {}),
      recentLogins: (account.recentLogins ?? []).slice(0, 3).map((item) => ({ ...item })),
      communityHistory: (account.communityHistory ?? []).slice(0, 200).map((item) => ({ ...item }))
    };
  }

  async recordCommunityActivity(accountId: string, activity: Omit<AccountCommunityActivity, 'at'>): Promise<void> {
    const account = this.accounts.find((item) => item.id === accountId && !item.isAdmin);
    if (!account) return;
    account.communityHistory = [{ ...activity, title: activity.title.slice(0, 180),
      ...(activity.message ? { message: activity.message.slice(0, 500) } : {}), at: new Date().toISOString()
    }, ...(account.communityHistory ?? [])].slice(0, 200);
    await this.persist();
  }

  createAdminSession(): string {
    return this.issueSession('__admin__');
  }

  private createSession(account: AccountRecord): { token: string; account: PublicAccount } {
    return { token: this.issueSession(account.id), account: this.publicView(account) };
  }

  private issueSession(accountId: string): string {
    const now = Date.now();
    const accountSessions: string[] = [];
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
      else if (session.accountId === accountId) accountSessions.push(token);
    }
    while (accountSessions.length >= maxSessionsPerAccount) {
      const oldest = accountSessions.shift();
      if (oldest) this.sessions.delete(oldest);
    }
    while (this.sessions.size >= maxSessionsTotal) {
      const oldest = this.sessions.keys().next().value as string | undefined;
      if (!oldest) break;
      this.sessions.delete(oldest);
    }
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, { accountId, expiresAt: now + sessionLifetimeMs });
    return token;
  }

  getSession(token?: string): { kind: 'admin'; role: AdminRole; account?: PublicAccount } | { kind: 'user'; account: PublicAccount } | undefined {
    if (!token) return undefined;
    const session = this.sessions.get(token);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) { this.sessions.delete(token); return undefined; }
    if (session.accountId === '__admin__') return { kind: 'admin', role: 'owner' };
    const account = this.accounts.find((item) => item.id === session.accountId);
    if (!account || account.status !== 'approved' || !account.emailVerifiedAt) { this.sessions.delete(token); return undefined; }
    const publicAccount = this.publicView(account);
    return account.isAdmin ? { kind: 'admin', role: account.adminRole ?? 'admin', account: publicAccount } : { kind: 'user', account: publicAccount };
  }

  revokeSession(token?: string): void { if (token) this.sessions.delete(token); }
  listAccounts(): PublicAccount[] { return this.accounts.map((account) => this.publicView(account)); }
  listAdminAccounts(): AdminAccount[] {
    return this.accounts.filter((account) => !account.isAdmin).map((account) => ({
      ...this.publicView(account), firstName: account.firstName, lastName: account.lastName, phone: account.phone, usageCase: account.usageCase,
      ...(account.newsOutlet ? { newsOutlet: account.newsOutlet } : {})
    }));
  }
  listAdministrators(): AdminAccount[] {
    return this.accounts.filter((account) => account.isAdmin).map((account) => ({
      ...this.publicView(account), firstName: account.firstName, lastName: account.lastName, phone: account.phone, usageCase: account.usageCase
    }));
  }

  isAdministrator(id: string): boolean {
    return Boolean(this.accounts.find((account) => account.id === id)?.isAdmin);
  }

  async deleteAdministrator(id: string, actorId?: string, bootstrapAdminAvailable = false): Promise<boolean> {
    const account = this.accounts.find((item) => item.id === id && item.isAdmin);
    if (!account) return false;
    if (actorId && actorId === id) throw new Error('You cannot revoke your own administrator account.');
    const activeAdmins = this.accounts.filter((item) => item.isAdmin && item.status === 'approved' && item.emailVerifiedAt);
    if (account.status === 'approved' && account.emailVerifiedAt && activeAdmins.length <= 1 && !bootstrapAdminAvailable) {
      throw new Error('The last active administrator cannot be removed.');
    }
    this.accounts = this.accounts.filter((item) => item.id !== id);
    this.revokeAccountSessions(id);
    await this.persist();
    return true;
  }

  async inviteAdministrator(input: { firstName: string; lastName: string; email: string; username?: string; role?: AccountRoleName }): Promise<{ account: PublicAccount; invitationToken: string }> {
    const email = input.email.trim().toLowerCase();
    if (!email.includes('@') || !input.firstName.trim() || !input.lastName.trim()) throw new Error('Enter the administrator name and a valid email address.');
    if (this.accounts.some((account) => account.email === email)) throw new Error('An account already exists for this email.');
    const requestedUsername = input.username?.trim() ?? '';
    const username = requestedUsername ? this.requireAvailableUsername(requestedUsername) : '';
    const passwordSalt = randomBytes(16).toString('hex');
    const token = randomBytes(32).toString('base64url');
    const account: AccountRecord = {
      id: randomBytes(16).toString('hex'), username, ...(username ? { usernameLocked: true } : {}), firstName: input.firstName.trim().slice(0, 80), lastName: input.lastName.trim().slice(0, 80),
      email, phone: '', usageCase: `${input.role ?? 'admin'} invitation`, accountType: 'reviewer', isAdmin: true, adminRole: input.role ?? 'admin',
      status: 'pending-verification', createdAt: new Date().toISOString(), passwordSalt,
      passwordHash: hashPassword(randomBytes(32).toString('hex'), passwordSalt),
      verificationTokenHash: hashToken(token), verificationExpiresAt: Date.now() + verifyLifetimeMs, webhooks: []
    };
    this.accounts.push(account);
    await this.persist();
    return { account: this.publicView(account), invitationToken: token };
  }

  async completeAdminInvitation(token: string, password: string, requestedUsername = ''): Promise<{ token: string; account: PublicAccount }> {
    if (password.length < 16 || password.length > 128) throw new Error('Administrator password must be between 16 and 128 characters.');
    const tokenHash = hashToken(token);
    const account = this.accounts.find((item) => item.isAdmin && item.verificationTokenHash === tokenHash && (item.verificationExpiresAt ?? 0) > Date.now());
    if (!account) throw new Error('Administrator invitation is invalid or expired.');
    const chosenUsername = requestedUsername.trim();
    if (account.usernameLocked) {
      if (chosenUsername && chosenUsername.toLowerCase() !== account.username.toLowerCase()) throw new Error('This invitation has a username assigned by the administrator.');
    } else if (chosenUsername) {
      account.username = this.requireAvailableUsername(chosenUsername, account.id);
    } else if (!normalizeUsername(account.username)) {
      throw new Error('Choose a public username using 3–24 letters, numbers, or underscores.');
    }
    delete account.usernameLocked;
    account.passwordSalt = randomBytes(16).toString('hex');
    account.passwordHash = hashPassword(password, account.passwordSalt);
    account.emailVerifiedAt = new Date().toISOString();
    account.status = 'approved';
    delete account.verificationTokenHash;
    delete account.verificationExpiresAt;
    await this.persist();
    const session = this.createSession(account);
    return session;
  }

  async updateUsername(accountId: string, requestedUsername: string): Promise<string> {
    const account = this.accounts.find((item) => item.id === accountId);
    if (!account) throw new Error('Account not found.');
    account.username = this.requireAvailableUsername(requestedUsername, accountId);
    await this.persist();
    return account.username;
  }

  async updateAccount(id: string, patch: { status?: AccountStatus; accountType?: AccountRecord['accountType'] }): Promise<PublicAccount | undefined> {
    const account = this.accounts.find((item) => item.id === id);
    if (!account) return undefined;
    if (patch.status === 'approved' && !account.emailVerifiedAt) throw new Error('Verify the account email before approving it.');
    if (patch.status) account.status = patch.status;
    if (patch.accountType) account.accountType = patch.accountType;
    await this.persist();
    if (account.status !== 'approved') this.revokeAccountSessions(account.id);
    return this.publicView(account);
  }

  async deleteAccount(id: string): Promise<boolean> {
    const before = this.accounts.length;
    this.accounts = this.accounts.filter((item) => item.id !== id);
    this.revokeAccountSessions(id);
    if (before === this.accounts.length) return false;
    await this.persist();
    return true;
  }

  async setWebhooks(accountId: string, webhooks: AccountWebhook[]): Promise<AccountWebhook[]> {
    const account = this.accounts.find((item) => item.id === accountId);
    if (!account) throw new Error('Account not found');
    account.webhooks = webhooks.slice(0, 10).map((item) => ({ ...item, name: item.name.slice(0, 80) }));
    await this.persist();
    return account.webhooks;
  }

  async setDashboardPreferences(accountId: string, value: unknown): Promise<DashboardPreferences> {
    const account = this.accounts.find((item) => item.id === accountId);
    if (!account) throw new Error('Account not found.');
    const preferences = normalizeDashboardPreferences(value);
    account.dashboardPreferences = preferences;
    await this.persist();
    return preferences;
  }

  async addAccountWebhook(accountId: string, webhook: AccountWebhook, allowSuspendedAccess = false): Promise<AccountWebhook[]> {
    const account = this.accounts.find((item) => item.id === accountId && !item.isAdmin && item.status === 'approved' && item.emailVerifiedAt);
    if (!account) throw new Error('An approved audience account is required to assign a webhook.');
    if (account.accountType !== 'buff' && account.accountType !== 'news') throw new Error('Only Buff and News Media accounts can use webhooks.');
    if (account.webhookAccessSuspended && !allowSuspendedAccess) throw new Error('Webhook access is suspended for this account.');
    if (account.webhooks.some((item) => item.id === webhook.id)) throw new Error('Webhook already exists.');
    if (account.webhooks.length >= 10) throw new Error('An account can have at most 10 webhooks.');
    account.webhooks.push({ ...webhook, name: webhook.name.trim().slice(0, 80) });
    await this.persist();
    return account.webhooks;
  }

  async removeAccountWebhook(accountId: string, webhookId: string): Promise<boolean> {
    const account = this.accounts.find((item) => item.id === accountId && !item.isAdmin);
    if (!account) return false;
    const previousLength = account.webhooks.length;
    account.webhooks = account.webhooks.filter((item) => item.id !== webhookId);
    if (account.webhooks.length === previousLength) return false;
    await this.persist();
    return true;
  }

  async setWebhookSuspended(accountId: string, webhookId: string, suspended: boolean): Promise<boolean> {
    const account = this.accounts.find((item) => item.id === accountId && !item.isAdmin);
    const webhook = account?.webhooks.find((item) => item.id === webhookId);
    if (!webhook) return false;
    if (suspended) webhook.suspendedAt ??= new Date().toISOString();
    else delete webhook.suspendedAt;
    await this.persist();
    return true;
  }

  async setWebhookAccessSuspended(accountId: string, suspended: boolean): Promise<PublicAccount | undefined> {
    const account = this.accounts.find((item) => item.id === accountId && !item.isAdmin);
    if (!account) return undefined;
    account.webhookAccessSuspended = suspended;
    await this.persist();
    return this.publicView(account);
  }

  async setCommunityUpdatesSuspended(accountId: string, suspended: boolean): Promise<PublicAccount | undefined> {
    const account = this.accounts.find((item) => item.id === accountId && !item.isAdmin);
    if (!account) return undefined;
    account.communityUpdatesSuspended = suspended;
    await this.persist();
    return this.publicView(account);
  }

  listWebhookTargets(borough: Borough | 'Citywide', audience: WebhookAudience): WebhookTarget[] {
    return this.accounts.filter((account) => account.status === 'approved' && account.emailVerifiedAt && !account.webhookAccessSuspended && account.accountType === audience)
      .flatMap((account) => account.webhooks
        .filter((hook) => !hook.suspendedAt && (hook.boroughs === 'all' || (borough !== 'Citywide' && hook.boroughs.includes(borough))))
        .flatMap((hook) => {
          const platform = hook.platform ?? inferWebhookPlatform(hook.url);
          return platform ? [{ id: hook.id, accountId: account.id, accountType: audience, platform, url: hook.url }] : [];
        }));
  }

  private revokeAccountSessions(id: string): void {
    for (const [token, session] of this.sessions) if (session.accountId === id) this.sessions.delete(token);
  }

  private publicView(account: AccountRecord): PublicAccount {
    const { id, username, email, accountType, isAdmin, adminRole, status, emailVerifiedAt, createdAt, webhooks } = account;
    const webhookSummaries: AccountWebhookSummary[] = webhooks.map((webhook) => {
      const platform = webhook.platform ?? inferWebhookPlatform(webhook.url);
      return { id: webhook.id, name: webhook.name, ...(platform ? { platform } : {}), boroughs: webhook.boroughs, ...(webhook.suspendedAt ? { suspendedAt: webhook.suspendedAt } : {}) };
    });
    return { id, username, email, accountType, isAdmin: Boolean(isAdmin), ...(isAdmin ? { adminRole: adminRole ?? 'admin' } : {}), status, emailVerified: Boolean(emailVerifiedAt), createdAt, webhookAccessSuspended: Boolean(account.webhookAccessSuspended), communityUpdatesSuspended: Boolean(account.communityUpdatesSuspended), webhooks: webhookSummaries, ...(account.dashboardPreferences ? { dashboardPreferences: { ...account.dashboardPreferences, boroughs: [...account.dashboardPreferences.boroughs], liveCategories: [...account.dashboardPreferences.liveCategories] } } : {}) };
  }

  private requireAvailableUsername(value: string, exceptAccountId?: string): string {
    const username = normalizeUsername(value);
    if (!username) throw new Error('Username must be 3–24 characters using letters, numbers, or underscores.');
    if (this.accounts.some((account) => account.id !== exceptAccountId && account.username?.toLowerCase() === username.toLowerCase())) {
      throw new Error('That username is already taken. Choose another.');
    }
    return username;
  }

  private async persist(): Promise<void> {
    const contents = JSON.stringify(this.accounts, null, 2);
    const next = this.persistQueue.catch(() => undefined).then(async () => {
      const temporary = `${this.filePath}.tmp`;
      await writeFile(temporary, contents, { mode: 0o600 });
      await rename(temporary, this.filePath);
    });
    this.persistQueue = next;
    await next;
  }
}

export function normalizeUsername(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const username = value.trim();
  return /^[A-Za-z0-9_]{3,24}$/.test(username) ? username : undefined;
}

function uniqueGeneratedUsername(accountId: string, claimed: Set<string>): string {
  const stem = `member_${accountId.replace(/[^a-f0-9]/gi, '').slice(0, 8).toLowerCase() || randomBytes(4).toString('hex')}`;
  let candidate = stem.slice(0, 24);
  let suffix = 2;
  while (claimed.has(candidate.toLowerCase())) {
    const ending = `_${suffix++}`;
    candidate = `${stem.slice(0, 24 - ending.length)}${ending}`;
  }
  return candidate;
}

const validBoroughs: Borough[] = ['Manhattan', 'Bronx', 'Queens', 'Brooklyn', 'Staten Island'];

export function normalizeDashboardPreferences(value: unknown): DashboardPreferences {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const boroughs = Array.isArray(input.boroughs)
    ? [...new Set(input.boroughs.filter((item): item is Borough => typeof item === 'string' && validBoroughs.includes(item as Borough)))]
    : validBoroughs;
  const categories: LiveCallCategory[] = Array.isArray(input.liveCategories)
    ? [...new Set(input.liveCategories.filter((item): item is LiveCallCategory => item === 'routine' || alertCategories.includes(item as AlertCategory)))]
    : ['routine', ...alertCategories];
  return {
    boroughs,
    audience: input.audience === 'buff' || input.audience === 'news' ? input.audience : 'public',
    agency: input.agency === 'FDNY' || input.agency === 'NYPD' ? input.agency : 'all',
    sortMode: input.sortMode === 'newest' || input.sortMode === 'priority' ? input.sortMode : 'smart',
    view: input.view === 'live' ? 'live' : 'incidents',
    liveCategories: categories
  };
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
