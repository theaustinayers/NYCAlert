import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Borough } from '../domain/subscriptions.js';

export type AudienceAccountType = 'buff' | 'news';
export type AdminRole = 'owner' | 'admin' | 'moderator' | 'reviewer';
export type AccountStatus = 'pending-verification' | 'pending-approval' | 'approved' | 'suspended';
export interface AccountWebhook { id: string; name: string; url: string; boroughs: Borough[] | 'all'; }
export interface AccountRecord {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  usageCase: string;
  accountType: AudienceAccountType | 'reviewer';
  isAdmin?: boolean;
  adminRole?: Exclude<AdminRole, 'owner'>;
  status: AccountStatus;
  emailVerifiedAt?: string;
  createdAt: string;
  passwordSalt: string;
  passwordHash: string;
  verificationTokenHash?: string;
  verificationExpiresAt?: number;
  webhooks: AccountWebhook[];
}
export interface PublicAccount { id: string; firstName: string; lastName: string; email: string; accountType: AccountRecord['accountType']; isAdmin: boolean; adminRole?: Exclude<AdminRole, 'owner'>; status: AccountStatus; emailVerified: boolean; createdAt: string; webhooks: AccountWebhook[]; }
export interface AdminAccount extends PublicAccount { phone: string; usageCase: string; }

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

  constructor(dataDirectory: string) { this.filePath = join(dataDirectory, 'accounts.json'); }

  async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (!Array.isArray(parsed)) throw new Error('Account store must contain a JSON array');
      this.accounts = parsed as AccountRecord[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.initialized = true;
  }

  async register(input: { firstName: string; lastName: string; email: string; phone: string; usageCase: string; accountType: AudienceAccountType; password: string }): Promise<{ account: PublicAccount; verificationToken: string }> {
    const email = input.email.trim().toLowerCase();
    if (this.accounts.some((account) => account.email === email)) throw new Error('An account already exists for this email. Try logging in or contact support.');
    const salt = randomBytes(16).toString('hex');
    const token = randomBytes(32).toString('base64url');
    const account: AccountRecord = {
      id: randomBytes(16).toString('hex'),
      firstName: input.firstName.trim().slice(0, 80), lastName: input.lastName.trim().slice(0, 80), email,
      phone: input.phone.trim().slice(0, 40), usageCase: input.usageCase.trim().slice(0, 1000),
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
    const account = this.accounts.find((item) => !item.isAdmin && item.verificationTokenHash === tokenHash && (item.verificationExpiresAt ?? 0) > Date.now());
    if (!account) throw new Error('This verification link is invalid or expired. Please register again or request a new link.');
    account.emailVerifiedAt = new Date().toISOString();
    delete account.verificationTokenHash;
    delete account.verificationExpiresAt;
    account.status = 'pending-approval';
    await this.persist();
    return this.publicView(account);
  }

  async login(emailInput: string, password: string): Promise<{ token: string; account: PublicAccount }> {
    const account = this.accounts.find((item) => item.email === emailInput.trim().toLowerCase());
    if (!account) {
      hashPassword(password, 'nycalert-dummy-salt');
      throw new Error('Email or password is incorrect.');
    }
    if (!safeEqual(hashPassword(password, account.passwordSalt), account.passwordHash)) throw new Error('Email or password is incorrect.');
    if (!account.emailVerifiedAt) throw new Error('Verify your email first. Check your inbox and spam folder.');
    if (account.status === 'suspended') throw new Error('This account is suspended.');
    if (account.status !== 'approved') throw new Error('Your account is awaiting administrator approval.');
    return this.createSession(account);
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
      ...this.publicView(account), phone: account.phone, usageCase: account.usageCase
    }));
  }
  listAdministrators(): PublicAccount[] {
    return this.accounts.filter((account) => account.isAdmin).map((account) => this.publicView(account));
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

  async inviteAdministrator(input: { firstName: string; lastName: string; email: string; role?: Exclude<AdminRole, 'owner'> }): Promise<{ account: PublicAccount; invitationToken: string }> {
    const email = input.email.trim().toLowerCase();
    if (!email.includes('@') || !input.firstName.trim() || !input.lastName.trim()) throw new Error('Enter the administrator name and a valid email address.');
    if (this.accounts.some((account) => account.email === email)) throw new Error('An account already exists for this email.');
    const passwordSalt = randomBytes(16).toString('hex');
    const token = randomBytes(32).toString('base64url');
    const account: AccountRecord = {
      id: randomBytes(16).toString('hex'), firstName: input.firstName.trim().slice(0, 80), lastName: input.lastName.trim().slice(0, 80),
      email, phone: '', usageCase: `${input.role ?? 'admin'} invitation`, accountType: 'reviewer', isAdmin: true, adminRole: input.role ?? 'admin',
      status: 'pending-verification', createdAt: new Date().toISOString(), passwordSalt,
      passwordHash: hashPassword(randomBytes(32).toString('hex'), passwordSalt),
      verificationTokenHash: hashToken(token), verificationExpiresAt: Date.now() + verifyLifetimeMs, webhooks: []
    };
    this.accounts.push(account);
    await this.persist();
    return { account: this.publicView(account), invitationToken: token };
  }

  async completeAdminInvitation(token: string, password: string): Promise<{ token: string; account: PublicAccount }> {
    if (password.length < 16 || password.length > 128) throw new Error('Administrator password must be between 16 and 128 characters.');
    const tokenHash = hashToken(token);
    const account = this.accounts.find((item) => item.isAdmin && item.verificationTokenHash === tokenHash && (item.verificationExpiresAt ?? 0) > Date.now());
    if (!account) throw new Error('Administrator invitation is invalid or expired.');
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

  async addAccountWebhook(accountId: string, webhook: AccountWebhook): Promise<AccountWebhook[]> {
    const account = this.accounts.find((item) => item.id === accountId && !item.isAdmin && item.status === 'approved' && item.emailVerifiedAt);
    if (!account) throw new Error('An approved audience account is required to assign a webhook.');
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

  listWebhookTargets(borough: Borough | 'Citywide', audience: AudienceAccountType): AccountWebhook[] {
    return this.accounts.filter((account) => account.status === 'approved' && account.emailVerifiedAt && account.accountType === audience)
      .flatMap((account) => account.webhooks.filter((hook) => hook.boroughs === 'all' || (borough !== 'Citywide' && hook.boroughs.includes(borough))));
  }

  private revokeAccountSessions(id: string): void {
    for (const [token, session] of this.sessions) if (session.accountId === id) this.sessions.delete(token);
  }

  private publicView(account: AccountRecord): PublicAccount {
    const { id, firstName, lastName, email, accountType, isAdmin, adminRole, status, emailVerifiedAt, createdAt, webhooks } = account;
    return { id, firstName, lastName, email, accountType, isAdmin: Boolean(isAdmin), ...(isAdmin ? { adminRole: adminRole ?? 'admin' } : {}), status, emailVerified: Boolean(emailVerifiedAt), createdAt, webhooks };
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

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
